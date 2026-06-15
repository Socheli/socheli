import { openrouterModel as brainOpenrouterModel } from "../brain.ts";
import { toolsManifest } from "../tools/registry.ts";
import { dispatchRegistryTool, composePrompt } from "./claude-sdk.ts";
import { ROLE_PRESETS, tierForTask, toolsForTask } from "./roles.ts";
import { DEFAULT_MAX_STEPS, type AgentEvent, type AgentTask, type HarnessRuntime } from "./types.ts";

/* openrouter runtime — engine-side minimal tool loop (docs/AGENT-HARNESS.md §3).

   A plain-fetch OpenAI-compatible /chat/completions loop: we send the role's
   registry tools as `tools` (their JSON Schemas come straight off the
   manifest), execute every tool_call through the canonical callTool dispatch,
   feed results back as `role:"tool"` messages, and repeat ≤ maxSteps.

   NO LangChain in the engine — that stack stays in the dashboard copilot.
   This runtime is the cheap-tier default (HARNESS_DEFAULT): any OpenRouter
   key + any tool-calling model works, and per-call cost is read from the
   usage block so budgets are enforced LIVE between steps (the only runtime
   that can do so without provider support). */

const API = "https://openrouter.ai/api/v1/chat/completions";

/* Per-tier model resolution. A thin wrapper over the brain's openrouterModel()
   with one addition: HARNESS_OPENROUTER_MODEL[_TIER] wins over the brain's
   OPENROUTER_MODEL[_TIER]. Rationale: the brain's model is tuned for cheap
   one-shot JSON and may not support TOOL CALLING at all (e.g. mistral-small has
   no tool-capable OpenRouter endpoints → HTTP 404 "No endpoints found that
   support tool use"); the harness loop is useless without tools, so it needs
   its own knob. When neither harness override is set we fall back to the shared
   brain resolver (OPENROUTER_MODEL[_TIER] → tool-capable defaults). */
const openrouterModel = (tier: "cheap" | "smart" | "best"): string =>
  process.env[`HARNESS_OPENROUTER_MODEL_${tier.toUpperCase()}`] ||
  process.env.HARNESS_OPENROUTER_MODEL ||
  brainOpenrouterModel(tier);

type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: any[] }
  | { role: "tool"; tool_call_id: string; content: string };

export const openrouterRuntime: HarnessRuntime = {
  id: "openrouter",

  available(): boolean {
    return Boolean(process.env.OPENROUTER_API_KEY);
  },

  async *run(task: AgentTask): AsyncGenerator<AgentEvent> {
    const key = process.env.OPENROUTER_API_KEY;
    if (!key) {
      yield { type: "error", message: "openrouter runtime unavailable: OPENROUTER_API_KEY is not set" };
      return;
    }
    const allowed = new Set(toolsForTask(task));
    const model = openrouterModel(tierForTask(task));
    const maxSteps = task.maxSteps ?? DEFAULT_MAX_STEPS;

    // Registry manifest → OpenAI function-tool format, restricted to the role.
    const tools = toolsManifest()
      .filter((t) => allowed.has(t.name))
      .map((t) => ({
        type: "function" as const,
        function: { name: t.name, description: t.description, parameters: t.inputSchema },
      }));

    const messages: ChatMessage[] = [
      { role: "system", content: ROLE_PRESETS[task.role].systemPrompt },
      { role: "user", content: composePrompt(task) },
    ];

    yield { type: "step", label: `openrouter · ${model} · ${tools.length} tools · ≤${maxSteps} steps` };

    let usd = 0;
    let lastText = "";

    try {
      for (let step = 0; step < maxSteps; step++) {
        // Force a final plain answer on the last allowed step so the run
        // always ends with a usable summary instead of a dangling tool call.
        const lastStep = step === maxSteps - 1;
        const res = await fetch(API, {
          method: "POST",
          headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", "X-Title": "Labrinox" },
          body: JSON.stringify({
            model,
            messages,
            ...(tools.length && !lastStep ? { tools } : {}),
            temperature: 0.7,
            // Cap output so OpenRouter reserves only a little credit (brain.ts rationale).
            max_tokens: Number(process.env.OPENROUTER_MAX_TOKENS || 16000),
            usage: { include: true },
          }),
        });
        if (!res.ok) {
          yield { type: "error", message: `openrouter HTTP ${res.status}: ${(await res.text()).slice(0, 300)}` };
          return;
        }
        const j: any = await res.json();
        if (j.error) {
          yield { type: "error", message: `openrouter: ${j.error.message}` };
          return;
        }
        usd += Number(j.usage?.cost ?? 0);

        const msg = j.choices?.[0]?.message ?? {};
        if (msg.content) {
          lastText = String(msg.content);
          yield { type: "token", text: lastText };
        }

        const toolCalls: any[] = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
        if (!toolCalls.length) {
          yield { type: "done", summary: lastText, usd };
          return;
        }

        // Echo the assistant turn (with its tool_calls) before appending results.
        messages.push({ role: "assistant", content: msg.content ?? null, tool_calls: toolCalls });

        for (const call of toolCalls) {
          const name = call.function?.name ?? "unknown";
          let args: unknown = {};
          try {
            args = call.function?.arguments ? JSON.parse(call.function.arguments) : {};
          } catch {
            /* leave args = {} — callTool's zod validation reports the real problem */
          }
          yield { type: "tool_call", id: call.id, name, args };

          // Allowlist is enforced server-side too — a hallucinated tool name
          // gets a clean error result instead of touching the registry.
          const { ok, payload } = allowed.has(name)
            ? await dispatchRegistryTool(task, name, args)
            : { ok: false, payload: { ok: false, message: `tool not allowed for role ${task.role}: ${name}` } };

          yield { type: "tool_result", id: call.id, name, ok, result: payload };
          messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(payload) });
        }

        // LIVE budget enforcement between steps — the hard stop the spec asks for.
        if (task.budgetUsd && usd >= task.budgetUsd) {
          yield { type: "error", message: `budget exhausted: $${usd.toFixed(4)} ≥ $${task.budgetUsd}` };
          yield { type: "done", summary: lastText || "stopped: budget exhausted before a final answer", usd };
          return;
        }
      }

      // maxSteps exhausted without a final no-tool answer.
      yield { type: "done", summary: lastText || `stopped after ${maxSteps} steps without a final answer`, usd };
    } catch (e) {
      yield { type: "error", message: `openrouter runtime failed: ${e instanceof Error ? e.message : String(e)}` };
    }
  },
};
