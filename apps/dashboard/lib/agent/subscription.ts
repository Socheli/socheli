import { spawn } from "node:child_process";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { REPO_ROOT } from "../data";
import { isUiTool, validateBlocks } from "./ui-spec";
import { isGuideTool, validateGuide } from "./guide-spec";
import { getClaudeOAuthToken } from "./claude-auth";
import type { StreamAgentEvent, AgentMessageInput, AgentContextInput } from "./graph";

/* Subscription path for Soli: when the copilot model is "claude-code", we run the
   turn through the engine's claude-code harness (the user's Claude Code Max/Pro
   subscription — no API key) and bridge its NDJSON events to the SAME
   StreamAgentEvent shape the OpenRouter path emits, so the chat UI is identical.
   The harness runs locally on this server (auth via the stored OAuth token), so
   there's no M4 round-trip. ui_render / ui_guide results are surfaced as the
   `ui` / `guide` events exactly as graph.ts does. */
const CLI = join(REPO_ROOT, "packages", "engine", "src", "cli.ts");

export async function* streamAgentViaSubscription(input: {
  messages: AgentMessageInput[];
  context?: AgentContextInput;
  signal?: AbortSignal;
}): AsyncGenerator<StreamAgentEvent> {
  const msgs = input.messages ?? [];
  const lastUser = [...msgs].reverse().find((m) => m.role === "user");
  const goal = (lastUser?.content ?? "").trim();
  if (!goal) {
    yield { type: "done" };
    return;
  }
  const history = msgs
    .slice(-10)
    .filter((m) => m.role !== "system")
    .map((m) => `${m.role === "user" ? "User" : "Soli"}: ${m.content}`)
    .join("\n");
  const context = [
    "You are Soli, Socheli's in-app assistant. Be concise; never use em-dashes in prose. Read state and act with the registry tools, and render data with ui_render blocks rather than markdown tables.",
    input.context?.page ? `The user is on the ${input.context.page} page.` : "",
    history ? `Recent conversation:\n${history}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  const token = getClaudeOAuthToken();
  const child = spawn("node", ["--import", "tsx", CLI, "soli-turn", "--context", context, goal], {
    cwd: REPO_ROOT,
    env: { ...process.env, ...(token ? { CLAUDE_CODE_OAUTH_TOKEN: token } : {}) },
  });
  const onAbort = () => { try { child.kill("SIGTERM"); } catch { /* gone */ } };
  input.signal?.addEventListener("abort", onAbort);

  const queue: StreamAgentEvent[] = [];
  let notify: (() => void) | null = null;
  let ended = false;
  const push = (e: StreamAgentEvent | null) => { if (e) { queue.push(e); notify?.(); notify = null; } };
  const bare = (n: unknown) => String(n ?? "").replace(/^mcp__socheli__/, "");

  const rl = createInterface({ input: child.stdout });
  rl.on("line", (line) => {
    const s = line.trim();
    if (!s || s[0] !== "{") return; // ignore any non-NDJSON noise
    let ev: { type?: string; text?: string; label?: string; id?: string; name?: string; args?: unknown; ok?: boolean; result?: unknown; message?: string };
    try { ev = JSON.parse(s); } catch { return; }
    switch (ev.type) {
      case "token":
        if (ev.text) push({ type: "token", text: String(ev.text) });
        break;
      case "step":
        if (ev.label) push({ type: "reasoning", text: String(ev.label) });
        break;
      case "tool_call":
        // ui/guide are surfaced from the RESULT (mirrors graph.ts); skip the raw call.
        if (!isUiTool(bare(ev.name)) && !isGuideTool(bare(ev.name))) {
          push({ type: "tool_call", id: String(ev.id ?? bare(ev.name)), name: bare(ev.name), args: ev.args ?? {} });
        }
        break;
      case "tool_result": {
        const name = bare(ev.name);
        const result = ev.result;
        if (isUiTool(name)) {
          const blocks =
            result && typeof result === "object" && Array.isArray((result as { blocks?: unknown }).blocks)
              ? validateBlocks((result as { blocks: unknown }).blocks)
              : [];
          if (blocks.length) push({ type: "ui", blocks });
          break;
        }
        if (isGuideTool(name)) {
          const raw = result && typeof result === "object" ? (result as { guide?: unknown }).guide : undefined;
          if (raw && typeof raw === "object") {
            const v = validateGuide(raw as Record<string, unknown>);
            if (v.ok) push({ type: "guide", guide: v.guide });
          }
          break;
        }
        push({ type: "tool_result", id: String(ev.id ?? name), name, ok: ev.ok !== false, result });
        break;
      }
      case "error":
        push({ type: "error", message: String(ev.message ?? "claude-code error") });
        break;
      default:
        break; // meta / cost / done / final → settled at close
    }
  });
  rl.on("close", () => { ended = true; notify?.(); notify = null; });
  child.on("error", (e) => { push({ type: "error", message: e.message }); ended = true; notify?.(); notify = null; });

  try {
    while (true) {
      if (queue.length) { yield queue.shift()!; continue; }
      if (ended) break;
      await new Promise<void>((res) => { notify = res; });
    }
  } finally {
    input.signal?.removeEventListener("abort", onAbort);
    try { child.kill("SIGTERM"); } catch { /* gone */ }
  }
  yield { type: "done" };
}
