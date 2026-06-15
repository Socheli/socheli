import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { ROLE_PRESETS } from "./roles.ts";
import { composePrompt } from "./claude-sdk.ts";
import { type AgentEvent, type AgentTask, type HarnessRuntime } from "./types.ts";

/* codex runtime — OpenAI Codex CLI (docs/AGENT-HARNESS.md §3).

   Spawns `codex exec --json <prompt>` and maps its JSONL event stream onto
   AgentEvents. Codex rides the user's ChatGPT/Codex subscription (usd 0),
   which makes it a useful free fallback worker — but it cannot mount our
   registry tools, so per spec it DEGRADES GRACEFULLY to a one-shot run: the
   role's system prompt + injected task context ride inside the prompt, and
   the task instruction asks for a self-contained answer instead of tool use.

   Event mapping is deliberately tolerant: the Codex CLI has shipped two JSONL
   dialects (legacy `{"msg":{"type":...}}` envelopes and the newer
   `{"type":"item.completed","item":{...}}` thread events). We parse both and
   ignore anything unrecognized rather than failing the run. */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

function resolveCodexBin(): string | null {
  const explicit = process.env.CODEX_BIN;
  if (explicit && existsSync(explicit)) return explicit;
  const w = spawnSync("which", ["codex"], { encoding: "utf8" });
  const p = (w.stdout || "").trim();
  return p && existsSync(p) ? p : null;
}

/* Codex has no system-prompt flag in exec mode — fold role + context into the
   prompt body, and tell it plainly that it has no Socheli tools this run. */
function codexPrompt(task: AgentTask): string {
  return [
    ROLE_PRESETS[task.role].systemPrompt,
    "",
    "NOTE: In this session you do NOT have access to the Socheli tool registry.",
    "Work from the context provided below and your own reasoning. Where an action",
    "would normally need a tool (publishing, rendering, ingesting analytics),",
    "instead specify EXACTLY what should be done (tool name + arguments if you",
    "know them) so an operator or a tool-capable agent can execute it.",
    "",
    composePrompt(task),
  ].join("\n");
}

export const codexRuntime: HarnessRuntime = {
  id: "codex",

  available(): boolean {
    return resolveCodexBin() !== null;
  },

  async *run(task: AgentTask): AsyncGenerator<AgentEvent> {
    const bin = resolveCodexBin();
    if (!bin) {
      yield { type: "error", message: "codex runtime unavailable: codex CLI not found (install it or set CODEX_BIN)" };
      return;
    }

    // SOCHELI_AGENT=1 marks tools this autonomous worker invokes as agent-originated;
    // the dna-tools.ts gate reads it to clamp dna_evolve to 'gate'. Codex can't mount
    // the registry this run, but we set it for parity + defense in depth.
    const child = spawn(bin, ["exec", "--json", "--skip-git-repo-check", codexPrompt(task)], {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, SOCHELI_AGENT: "1" },
    });

    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d));

    yield { type: "step", label: "codex · one-shot (no registry tools) · subscription" };

    // Collect agent text so the final done.summary is the full answer even if
    // the stream never emits an explicit completion event.
    const textParts: string[] = [];
    let finished = false;

    try {
      for await (const line of createInterface({ input: child.stdout })) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let evt: any;
        try {
          evt = JSON.parse(trimmed);
        } catch {
          continue;
        }

        // Legacy dialect: {"id": "...", "msg": {"type": "...", ...}}
        const msg = evt?.msg;
        if (msg?.type) {
          if (msg.type === "agent_message" && typeof msg.message === "string") {
            textParts.push(msg.message);
            yield { type: "token", text: msg.message };
          } else if (msg.type === "agent_reasoning" || msg.type === "task_started") {
            yield { type: "step", label: msg.type === "task_started" ? "codex task started" : "reasoning…" };
          } else if (msg.type === "exec_command_begin") {
            yield { type: "step", label: `codex exec: ${Array.isArray(msg.command) ? msg.command.join(" ") : msg.command}` };
          } else if (msg.type === "task_complete") {
            finished = true;
            const last = typeof msg.last_agent_message === "string" ? msg.last_agent_message : textParts.join("\n");
            yield { type: "done", summary: last, usd: 0 }; // subscription → no per-call cost
          } else if (msg.type === "error") {
            yield { type: "error", message: String(msg.message ?? "codex error") };
          }
          continue;
        }

        // Newer dialect: {"type": "item.completed", "item": {...}} thread events.
        if (typeof evt?.type === "string") {
          if (evt.type === "item.completed" && evt.item) {
            const item = evt.item;
            if ((item.type === "agent_message" || item.item_type === "assistant_message") && typeof item.text === "string") {
              textParts.push(item.text);
              yield { type: "token", text: item.text };
            } else if (item.type === "command_execution") {
              yield { type: "step", label: `codex exec: ${item.command ?? ""}` };
            } else if (item.type === "reasoning") {
              yield { type: "step", label: "reasoning…" };
            }
          } else if (evt.type === "turn.completed") {
            finished = true;
            yield { type: "done", summary: textParts.join("\n"), usd: 0 };
          } else if (evt.type === "turn.failed" || evt.type === "error") {
            yield { type: "error", message: String(evt.error?.message ?? evt.message ?? "codex turn failed") };
          }
        }
      }

      const code: number = await new Promise((resolve) => child.on("close", resolve));
      if (!finished) {
        if (code === 0 && textParts.length) {
          // Stream ended cleanly without an explicit completion event — treat
          // the accumulated agent text as the answer.
          yield { type: "done", summary: textParts.join("\n"), usd: 0 };
        } else {
          yield { type: "error", message: `codex exited ${code}: ${stderr.slice(0, 500)}` };
        }
      }
    } catch (e) {
      yield { type: "error", message: `codex runtime failed: ${e instanceof Error ? e.message : String(e)}` };
    } finally {
      // Kill the spawned child in FINALLY — not just catch — so that when run.ts
      // aborts the tool-loop and disposes this generator via .return() (e.g. on
      // a maxSteps overrun), the still-running `codex` process is torn down
      // instead of orphaned. Safe to call even after a clean close. Codex rides
      // the subscription ($0) so this is about not leaking a process, not spend.
      if (!child.killed) { try { child.kill(); } catch { /* already gone */ } }
    }
  },
};
