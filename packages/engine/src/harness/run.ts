#!/usr/bin/env -S node --import tsx
import "../env.ts"; // .env → process.env, same as tool.ts/cli.ts (idempotent)
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { classifyProviderError, shouldRotate } from "./errors.ts";
import { pickRuntime, runtimeChain } from "./router.ts";
import { tierForTask } from "./roles.ts";
import {
  DEFAULT_MAX_STEPS,
  type AgentEvent,
  type AgentRole,
  type AgentTask,
} from "./types.ts";

/* runAgentTask — the one front door to the harness (docs/AGENT-HARNESS.md §3).

   Picks a runtime via the router, streams every AgentEvent to an append-only
   JSONL log under data/agent/<task.id>.jsonl (one timestamped event per line —
   the dashboard job feed and `tail -f` both read it naturally), enforces the
   task's maxSteps/budgetUsd as a belt-and-braces layer ON TOP of the runtimes'
   own enforcement, and returns {summary, usd}.

   This file is also directly executable (same `node --import tsx` pattern as
   tool.ts/cli.ts) so the registry's long-running agent_run_task tool can spawn
   it detached:  run.ts --role researcher [--tier smart] [...] "<goal>"        */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const AGENT_DIR = join(ROOT, "data", "agent");

export function agentTaskLogPath(id: string): string {
  return join(AGENT_DIR, `${id}.jsonl`);
}

export function newAgentTaskId(): string {
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
  return `agent_${stamp}_${Math.random().toString(36).slice(2, 6)}`;
}

export type AgentTaskResult = { summary: string; usd: number };

export async function runAgentTask(
  task: AgentTask,
  opts?: { runtime?: string; onEvent?: (e: AgentEvent) => void },
): Promise<AgentTaskResult> {
  mkdirSync(AGENT_DIR, { recursive: true });
  const logPath = agentTaskLogPath(task.id);
  const log = (e: AgentEvent | Record<string, unknown>) =>
    appendFileSync(logPath, JSON.stringify({ at: new Date().toISOString(), ...e }) + "\n");

  const maxSteps = task.maxSteps ?? DEFAULT_MAX_STEPS;
  const chain = await runtimeChain(task, opts?.runtime);
  if (!chain.length) {
    await pickRuntime(task, opts?.runtime); // throws the descriptive "no harness runtime" error
    throw new Error("no harness runtime available");
  }

  log({ type: "task", id: task.id, role: task.role, tier: tierForTask(task), runtime: chain[0].id, goal: task.goal, maxSteps, budgetUsd: task.budgetUsd ?? null, workspaceId: task.tenant?.workspaceId ?? null });

  // Runtime-level fallback: if the picked runtime dies on a FATAL error before
  // doing any meaningful work (no tool_call / non-blank token — i.e. the model
  // never got going: quota/auth/binary-gone, see harness/errors.ts), restart
  // the run on the next available runtime from the same preference list,
  // carrying accumulated spend into the budget checks. Max 2 fallbacks.
  // A run that made progress keeps today's behavior (fail, no restart).
  const MAX_FALLBACKS = 2;
  let summary = "";
  let usd = 0; // cumulative across runtime attempts
  let toolCalls = 0; // cumulative too — a flailing first runtime still counts
  let errored: string | null = null;

  for (let ri = 0; ri < chain.length && ri <= MAX_FALLBACKS; ri++) {
    const runtime = chain[ri];
    const baseUsd = usd; // spend already burned by previous failed attempts
    let progressed = false;
    let internalAbort = false; // our own budget/step aborts never trigger fallback
    errored = null;

    const stream = runtime.run(task);
    try {
      for await (const event of stream) {
        log(event);
        opts?.onEvent?.(event);

        if (event.type === "tool_call") {
          progressed = true;
          toolCalls++;
          // Runtimes enforce their own turn limits; this guards a runtime that
          // doesn't (or a model stuck in a tool loop) from burning unbounded spend.
          if (toolCalls > maxSteps * 2) {
            internalAbort = true;
            errored = `aborted: exceeded ${maxSteps * 2} tool calls (maxSteps=${maxSteps})`;
            log({ type: "error", message: errored });
            break;
          }
        } else if (event.type === "token") {
          if (event.text.trim()) progressed = true;
        } else if (event.type === "cost") {
          // Live best-effort budget cap for runtimes that report cumulative cost
          // mid-run (claude-code emits this from stream-json's total_cost_usd).
          // openrouter still enforces internally; codex is free ($0). When the cap
          // trips we break, and the `finally` below disposes the generator, whose
          // own `finally` kills the spawned child — stopping further spend.
          usd = baseUsd + event.usd;
          if (task.budgetUsd && usd >= task.budgetUsd) {
            internalAbort = true;
            errored = `aborted: budget exhausted ($${usd.toFixed(4)} ≥ $${task.budgetUsd})`;
            log({ type: "error", message: errored });
            break;
          }
        } else if (event.type === "done") {
          summary = event.summary;
          usd = baseUsd + event.usd;
          if (task.budgetUsd && usd > task.budgetUsd) {
            // Too late to stop spend, but record the breach loudly for missions'
            // per-day budget accounting.
            log({ type: "step", label: `budget exceeded: $${usd.toFixed(4)} > $${task.budgetUsd}` });
          }
        } else if (event.type === "error" && !errored) {
          errored = event.message;
        }
      }
    } finally {
      // Dispose the generator so spawned children/tmp files get cleaned up even
      // when we break out early.
      await stream.return?.(undefined as never);
    }

    if (summary || !errored || internalAbort) break;

    const cls = classifyProviderError(errored);
    const next = chain[ri + 1];
    if (!progressed && next && ri < MAX_FALLBACKS && shouldRotate(cls, errored)) {
      log({ type: "step", label: `fallback: ${runtime.id} ${cls}: ${errored.slice(0, 80)} → ${next.id}` });
      continue;
    }
    break;
  }

  if (!summary && errored) summary = errored;
  if (!summary) summary = "task produced no summary";
  log({ type: "result", summary, usd, toolCalls, ok: !errored });
  return { summary, usd };
}

/* ── direct execution (spawned detached by tools/harness-tools.ts) ───────── */

const ROLES: AgentRole[] = ["researcher", "strategist", "creative", "editor", "publisher", "analyst", "channel_manager"];

function parseArgs(argv: string[]): { task: AgentTask; runtime?: string } {
  const flags = new Map<string, string>();
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) flags.set(a.slice(2), argv[++i] ?? "");
    else positional.push(a);
  }
  const role = (flags.get("role") ?? "") as AgentRole;
  const goal = positional.join(" ").trim();
  if (!ROLES.includes(role)) throw new Error(`--role must be one of: ${ROLES.join(", ")}`);
  if (!goal) throw new Error("a goal is required: run.ts --role <role> \"<goal>\"");
  const tier = flags.get("tier") as AgentTask["tier"] | undefined;
  if (tier && !["cheap", "smart", "best"].includes(tier)) throw new Error("--tier must be cheap|smart|best");
  return {
    task: {
      id: flags.get("id") || newAgentTaskId(),
      role,
      goal,
      context: flags.get("context") || undefined,
      tier,
      maxSteps: flags.get("max-steps") ? Number(flags.get("max-steps")) : undefined,
      budgetUsd: flags.get("budget") ? Number(flags.get("budget")) : undefined,
      tools: flags.get("tools") ? flags.get("tools")!.split(",").map((s) => s.trim()).filter(Boolean) : undefined,
    },
    runtime: flags.get("runtime") || undefined,
  };
}

const isMain = (() => {
  try {
    return process.argv[1] ? resolve(process.argv[1]) === fileURLToPath(import.meta.url) : false;
  } catch {
    return false;
  }
})();

if (isMain) {
  (async () => {
    const { task, runtime } = parseArgs(process.argv.slice(2));
    process.stderr.write(`agent task ${task.id} (${task.role}) → ${agentTaskLogPath(task.id)}\n`);
    const result = await runAgentTask(task, {
      runtime,
      // Mirror events to stdout so the detached spawn's log file shows live progress.
      onEvent: (e) => {
        if (e.type === "token") process.stdout.write(e.text);
        else if (e.type === "step") process.stdout.write(`\n· ${e.label}\n`);
        else if (e.type === "tool_call") process.stdout.write(`\n→ ${e.name}\n`);
        else if (e.type === "error") process.stdout.write(`\n✗ ${e.message}\n`);
      },
    });
    process.stdout.write(`\n${JSON.stringify({ id: task.id, ...result })}\n`);
  })().catch((e) => {
    process.stderr.write(`✗ ${e?.message ?? e}\n`);
    process.exitCode = 1;
  });
}
