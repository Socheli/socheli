import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createInterface } from "node:readline";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveClaudeBin } from "../brain.ts";
import { CLAUDE_MODELS, composePrompt } from "./claude-sdk.ts";
import { ROLE_PRESETS, tierForTask, toolsForTask } from "./roles.ts";
import { DEFAULT_MAX_STEPS, type AgentEvent, type AgentTask, type HarnessRuntime } from "./types.ts";

/* claude-code runtime — headless Claude Code (docs/AGENT-HARNESS.md §3).

   Spawns `claude -p <goal> --output-format stream-json --verbose --max-turns N`
   with a GENERATED temp --mcp-config pointing at the full socheli MCP server
   (socheli-mcp.ts — the same stdio server `pnpm mcp:socheli` runs) and an
   --allowedTools list of mcp__socheli__* names from the role preset, so the
   agent gets exactly the role's registry tools auto-approved and nothing else.

   Why this exists next to claude-sdk: zero extra dependencies — it needs only
   the Claude Code CLI (subscription auth, no key), which is the same binary
   brain.ts already rides. resolveClaudeBin() is reused so the "spawn claude
   ENOENT" PATH pitfall stays fixed in exactly one place. */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const ENGINE_SRC = join(ROOT, "packages", "engine", "src");

/* The MCP server entry. We launch it the way the whole codebase launches tsx
   entrypoints (`node --import tsx <abs path>`, cwd ROOT — see registry.ts
   spawnEngine) rather than relying on a `tsx` binary being on claude's PATH.
   NOTE: this points at harness/mcp-stdio.ts (newline-delimited JSON-RPC over
   the SAME registry) — socheli-mcp.ts uses Content-Length framing, which the
   Claude Code MCP client cannot speak (verified: it hangs "still connecting"). */
function writeMcpConfig(dir: string, allowed: string[]): string {
  const cfg = {
    mcpServers: {
      socheli: {
        command: "node",
        args: ["--import", "tsx", join(ENGINE_SRC, "harness", "mcp-stdio.ts")],
        // Advertise ONLY the role's tools: a small toolset is loaded directly
        // into context instead of being deferred behind ToolSearch (where
        // small models reliably fail to invoke the resolved tool).
        env: { SOCHELI_MCP_TOOLS: allowed.join(",") },
      },
    },
  };
  const path = join(dir, "mcp-socheli.json");
  writeFileSync(path, JSON.stringify(cfg, null, 2));
  return path;
}

export const claudeCodeRuntime: HarnessRuntime = {
  id: "claude-code",

  available(): boolean {
    return resolveClaudeBin() !== null;
  },

  async *run(task: AgentTask): AsyncGenerator<AgentEvent> {
    const bin = resolveClaudeBin();
    if (!bin) {
      yield { type: "error", message: "claude-code runtime unavailable: Claude Code CLI not found (install it or set CLAUDE_BIN)" };
      return;
    }
    const allowed = toolsForTask(task);
    if (!allowed.length) {
      yield { type: "error", message: `no registry tools resolved for role "${task.role}"` };
      return;
    }

    const maxSteps = task.maxSteps ?? DEFAULT_MAX_STEPS;
    const model = CLAUDE_MODELS[tierForTask(task)];
    const tmp = mkdtempSync(join(tmpdir(), "socheli-harness-"));
    const mcpConfig = writeMcpConfig(tmp, allowed);

    const args = [
      "-p", composePrompt(task),
      "--output-format", "stream-json",
      "--verbose",
      "--max-turns", String(maxSteps),
      "--model", model,
      "--mcp-config", mcpConfig,
      "--strict-mcp-config", // only OUR server; don't pick up user/project MCP config
      "--allowedTools", allowed.map((n) => `mcp__socheli__${n}`).join(","),
      // Keep the worker on the registry surface: without this, models route
      // around the MCP tools via Bash/file tools and break role isolation.
      "--disallowedTools", "Bash,Edit,Write,NotebookEdit,WebSearch,WebFetch,Task",
      "--append-system-prompt", ROLE_PRESETS[task.role].systemPrompt,
    ];

    // claude may shell out to node — make sure its bin dir is on PATH (brain.ts pattern).
    // SOCHELI_AGENT=1 marks every tool this autonomous worker invokes as
    // agent-originated; the server-side gate in dna-tools.ts reads it to clamp
    // dna_evolve's policy to 'gate' so the agent can't self-approve genome mutations.
    const env = { ...process.env, SOCHELI_AGENT: "1", PATH: `${dirname(bin)}:${process.env.PATH ?? ""}` };
    const child = spawn(bin, args, { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], env });

    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d));

    const callNames = new Map<string, string>();
    const stripMcp = (n: string) => n.replace(/^mcp__socheli__/, "");
    let sawResult = false;

    yield { type: "step", label: `claude-code · ${model} · ${allowed.length} tools · ≤${maxSteps} turns` };

    try {
      // stream-json prints one JSON envelope per line; the shapes mirror the
      // Agent SDK's SDKMessage union (system/assistant/user/result).
      for await (const line of createInterface({ input: child.stdout })) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let msg: any;
        try {
          msg = JSON.parse(trimmed);
        } catch {
          continue; // tolerate stray non-JSON noise on stdout
        }

        if (msg.type === "system" && msg.subtype === "init") {
          yield { type: "step", label: `session ${msg.session_id ?? ""} started` };
        } else if (msg.type === "assistant" && Array.isArray(msg.message?.content)) {
          for (const block of msg.message.content) {
            if (block?.type === "text" && block.text) {
              yield { type: "token", text: block.text };
            } else if (block?.type === "tool_use") {
              callNames.set(block.id, stripMcp(block.name));
              yield { type: "tool_call", id: block.id, name: stripMcp(block.name), args: block.input };
            }
          }
        } else if (msg.type === "user" && Array.isArray(msg.message?.content)) {
          for (const block of msg.message.content) {
            if (block?.type === "tool_result") {
              yield {
                type: "tool_result",
                id: block.tool_use_id,
                name: callNames.get(block.tool_use_id) ?? "unknown",
                ok: !block.is_error,
                result: block.content,
              };
            }
          }
        } else if (msg.type === "result") {
          sawResult = true;
          const usd = Number(msg.total_cost_usd ?? 0);
          // Emit cumulative cost so run.ts can enforce budgetUsd. claude-code
          // reports cost on the final result envelope, so for the single-turn
          // case this is effectively post-hoc; emitting it before `done` lets
          // run.ts still record the breach uniformly with the other runtimes.
          if (usd > 0) yield { type: "cost", usd };
          if (msg.subtype === "success") {
            yield { type: "done", summary: String(msg.result ?? ""), usd };
          } else {
            yield { type: "error", message: `claude-code ended: ${msg.subtype}` };
            yield { type: "done", summary: `task ended without success (${msg.subtype})`, usd };
          }
        }
      }

      const code: number = await new Promise((resolve) => child.on("close", resolve));
      if (!sawResult) {
        yield { type: "error", message: `claude exited ${code} without a result: ${stderr.slice(0, 500)}` };
      }
    } catch (e) {
      yield { type: "error", message: `claude-code runtime failed: ${e instanceof Error ? e.message : String(e)}` };
    } finally {
      // Kill the spawned child in FINALLY — not just catch — so that when run.ts
      // aborts the tool-loop and disposes this generator via .return() (e.g. on
      // a maxSteps overrun or a live budget cap), the still-running `claude`
      // process is torn down instead of orphaned and left spending. Safe to call
      // even after a clean close. The generator's finally always runs on .return().
      if (!child.killed) { try { child.kill(); } catch { /* already gone */ } }
      rmSync(tmp, { recursive: true, force: true });
    }
  },
};
