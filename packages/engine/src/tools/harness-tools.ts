import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

import { ROOT, DATA_DIR, ok, fail, tool, type PipelineTool } from "./helpers.ts";
import { agentTaskLogPath, newAgentTaskId } from "../harness/run.ts";

/* Harness tools (docs/AGENT-HARNESS.md §3 "Tool & CLI").

   agent_run_task is how the dashboard copilot (Soli), MCP clients, and the
   missions orchestrator delegate deep multi-turn work to a premium harness
   runtime. It follows the registry's long-running contract exactly: the
   handler spawns a DETACHED engine process (harness/run.ts, the same
   `node --import tsx` pattern as spawnEngine in registry.ts) and returns a
   started/job descriptor immediately — the caller tails the JSONL event log
   for progress instead of blocking.

   Shaped as PipelineTool[] so the integrator can spread it straight into
   registry.ts's pipelineTools list. ok/fail/tool come from registry.ts so the
   shape stays byte-identical; the detached spawn is kept inline here because it
   carries a bespoke result shape (taskId + eventsPath) that spawnEngine does
   not produce. */

const AGENT_DIR = join(DATA_DIR, "agent");
const RUN_SCRIPT = join(ROOT, "packages", "engine", "src", "harness", "run.ts");

const AGENT_ROLES =["researcher", "strategist", "creative", "editor", "publisher", "analyst", "channel_manager"] as const;

export const harnessTools: PipelineTool[] = [
  tool({
    name: "agent_run_task",
    description:
      "Delegate a goal to a multi-turn, tool-using agent (harness runtime: Claude Agent SDK / headless Claude Code / Codex / OpenRouter — router picks the first available per tier). The agent works the goal with the role's registry-tool allowlist. Long-running: starts a detached background task and returns its id + JSONL event-log path immediately.",
    kind: "long",
    schema: z
      .object({
        role: z.enum(AGENT_ROLES).describe("worker persona; sets the system prompt + tool allowlist + default tier"),
        goal: z.string().min(1).describe("the instruction for the agent"),
        context: z.string().optional().describe("injected context (genome block, plan excerpt, item id…)"),
        tier: z.enum(["cheap", "smart", "best"]).optional().describe("override the role's default brain tier"),
        maxSteps: z.number().default(16).describe("max agent turns / tool-loop steps"),
        budgetUsd: z.number().optional().describe("hard USD stop for the task"),
        tools: z.array(z.string()).optional().describe("override the role's registry-tool allowlist (names or prefix_* patterns)"),
        runtime: z.enum(["claude-sdk", "claude-code", "codex", "openrouter"]).optional().describe("force a specific runtime instead of the router's pick"),
      })
      .strict(),
    run: ({ role, goal, context, tier, maxSteps, budgetUsd, tools, runtime }) => {
      mkdirSync(AGENT_DIR, { recursive: true });
      const id = newAgentTaskId();

      const args = [RUN_SCRIPT, "--id", id, "--role", role];
      if (tier) args.push("--tier", tier);
      if (context) args.push("--context", context);
      if (maxSteps) args.push("--max-steps", String(maxSteps));
      if (budgetUsd) args.push("--budget", String(budgetUsd));
      if (tools?.length) args.push("--tools", tools.join(","));
      if (runtime) args.push("--runtime", runtime);
      args.push(goal);

      // Detached spawn, stdout/stderr → a human-readable log next to the JSONL
      // event stream (registry.ts spawnEngine pattern).
      const logPath = join(AGENT_DIR, `${id}.log`);
      const out = openSync(logPath, "a");
      const child = spawn("node", ["--import", "tsx", ...args], {
        cwd: ROOT,
        detached: true,
        stdio: ["ignore", out, out],
        env: process.env,
      });
      child.unref();

      return ok(
        { status: "started", taskId: id, pid: child.pid, role, logPath, eventsPath: agentTaskLogPath(id) },
        `agent task ${id} started (${role})`,
      );
    },
  }),

  tool({
    name: "agent_task_events",
    description:
      "Read the event log of a running/finished agent task started by agent_run_task. Returns the last N JSONL events (token/tool_call/tool_result/step/done/error) so callers can poll progress and fetch the final summary + usd.",
    kind: "read",
    schema: z
      .object({
        taskId: z.string().min(1),
        tail: z.number().default(50).describe("how many trailing events to return"),
      })
      .strict(),
    run: ({ taskId, tail }) => {
      const path = agentTaskLogPath(taskId);
      if (!existsSync(path)) return fail(`no event log for agent task: ${taskId}`);
      const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
      const events = lines.slice(-Math.max(1, tail)).map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return { type: "raw", line: l };
        }
      });
      const last = events[events.length - 1] as any;
      const finished = events.some((e: any) => e.type === "result");
      return ok({ taskId, events, finished, totalEvents: lines.length, last });
    },
  }),
];
