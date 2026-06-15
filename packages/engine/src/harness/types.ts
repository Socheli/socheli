import type { TenantContext } from "@os/schemas";

/* Harness runtimes — the "cord" (docs/AGENT-HARNESS.md §3).

   Where brain.ts is the ONE-SHOT JSON brain, this layer is the MULTI-TURN,
   tool-using agent runtime. A runtime takes an AgentTask (role + goal +
   injected context + a registry-tool allowlist) and streams AgentEvents while
   the underlying agent (Claude Agent SDK, headless Claude Code, Codex CLI, or
   a plain OpenRouter tool loop) works the goal with real Socheli tools.

   All four runtimes implement the same interface so the router (router.ts)
   can pick whichever is available/affordable per tier, and runAgentTask
   (run.ts) can log + budget them uniformly. */

export type AgentRole =
  | "researcher"
  | "strategist"
  | "creative"
  | "editor"
  | "publisher"
  | "analyst"
  | "channel_manager"
  | "community_manager";

export type AgentTask = {
  id: string;
  role: AgentRole;
  goal: string;                 // the instruction
  context?: string;             // injected context (genome, plan, item…)
  tools?: string[];             // registry-tool allowlist (default: role preset)
  tier?: "cheap" | "smart" | "best";
  maxSteps?: number;            // default 16
  budgetUsd?: number;           // hard stop
  tenant?: TenantContext;
};

export type AgentEvent =
  | { type: "token"; text: string }
  | { type: "tool_call"; id: string; name: string; args: unknown }
  | { type: "tool_result"; id: string; name: string; ok: boolean; result: unknown }
  | { type: "step"; label: string }
  // Mid-run cost signal. Runtimes that learn their cumulative spend before the
  // final `done` (e.g. claude-code's stream-json total_cost_usd) emit this so
  // run.ts can enforce budgetUsd LIVE — tearing the child down — instead of only
  // logging the breach post-hoc. `usd` is the cumulative cost so far this run.
  | { type: "cost"; usd: number }
  | { type: "done"; summary: string; usd: number }
  | { type: "error"; message: string };

export interface HarnessRuntime {
  id: string;                   // "claude-sdk" | "claude-code" | "codex" | "openrouter"
  available(): boolean | Promise<boolean>;
  run(task: AgentTask): AsyncGenerator<AgentEvent>;
}

/** Spec default when a task doesn't set maxSteps. */
export const DEFAULT_MAX_STEPS = 16;
