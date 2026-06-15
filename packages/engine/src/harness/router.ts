import { claudeCodeRuntime } from "./claude-code.ts";
import { claudeSdkRuntime } from "./claude-sdk.ts";
import { codexRuntime } from "./codex.ts";
import { openrouterRuntime } from "./openrouter.ts";
import { tierForTask } from "./roles.ts";
import type { AgentTask, HarnessRuntime } from "./types.ts";

/* Runtime router (docs/AGENT-HARNESS.md §3 + §7).

   Preference lists come from env so deployments tune them without code:
     HARNESS_PREMIUM  — used for tier smart/best (default: claude-sdk,claude-code,openrouter)
     HARNESS_DEFAULT  — used for tier cheap      (default: openrouter,claude-code)
   First AVAILABLE runtime in the list wins. Availability is probed per pick
   (cheap checks: env keys, binary presence, dynamic-import success), so a
   missing SDK or unset key degrades to the next entry instead of failing.

   Per-task override: pass an explicit runtime id as the second argument
   (the agent_run_task tool surfaces this) — it is tried first, then the
   tier list as fallback. */

export const RUNTIMES: Record<string, HarnessRuntime> = {
  [claudeSdkRuntime.id]: claudeSdkRuntime,
  [claudeCodeRuntime.id]: claudeCodeRuntime,
  [codexRuntime.id]: codexRuntime,
  [openrouterRuntime.id]: openrouterRuntime,
};

const DEFAULT_PREMIUM = "claude-sdk,claude-code,openrouter";
const DEFAULT_CHEAP = "openrouter,claude-code";

function preferenceList(task: AgentTask): string[] {
  const tier = tierForTask(task);
  const raw = tier === "cheap"
    ? process.env.HARNESS_DEFAULT || DEFAULT_CHEAP
    : process.env.HARNESS_PREMIUM || DEFAULT_PREMIUM;
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

/* Every AVAILABLE runtime from the preference list, in order. run.ts walks
   this chain to fall back to the next runtime when the picked one dies before
   making progress (quota/auth/unavailable — see harness/errors.ts). */
export async function runtimeChain(task: AgentTask, preferred?: string): Promise<HarnessRuntime[]> {
  const order = [...(preferred ? [preferred] : []), ...preferenceList(task)];
  const chain: HarnessRuntime[] = [];
  for (const id of order) {
    const rt = RUNTIMES[id];
    if (!rt || chain.includes(rt)) continue;
    if (await rt.available()) chain.push(rt);
  }
  return chain;
}

export async function pickRuntime(task: AgentTask, preferred?: string): Promise<HarnessRuntime> {
  const chain = await runtimeChain(task, preferred);
  if (chain.length) return chain[0];
  const order = [...(preferred ? [preferred] : []), ...preferenceList(task)];
  throw new Error(
    `no harness runtime available (tried: ${order.join(", ") || "none"}). ` +
      `Fix one of: install @anthropic-ai/claude-agent-sdk + Claude auth, install the Claude Code CLI (CLAUDE_BIN), ` +
      `set OPENROUTER_API_KEY, or install the codex CLI (CODEX_BIN) and list it in HARNESS_PREMIUM/HARNESS_DEFAULT.`,
  );
}
