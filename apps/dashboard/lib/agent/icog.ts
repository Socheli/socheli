import type { OpenAITool } from "./tools";

/* iCog (CognitiveX) bridge — gives Soli a persistent, cross-session memory and a
   cognitive peer to consult.

   iCog is an external HTTP service (the same backend the `icog` MCP server
   proxies to). We reach it directly over its REST API rather than bundling any
   SDK, mirroring how the orchestration tools stay in-process. These are LOCAL
   tools: they run here in the Next server, NOT via the engine runner.

   Config (server env):
     ICOG_API_URL   default https://api.cognitivx.io
     ICOG_API_KEY   personal access token, "icog_…" (sent as X-API-Key)
     ICOG_AGENT_SLUG default "socheli-soli" — scopes memories to this agent so
                     recall surfaces Soli's own context first.

   When ICOG_API_KEY is unset the tool SPECS are withheld (see ICOG_TOOLS) so the
   model never advertises a capability it cannot use; the handlers still return a
   clear, actionable error if somehow invoked. */

const DEFAULT_BASE = "https://api.cognitivx.io";
const DEFAULT_SLUG = "socheli-soli";
const TIMEOUT_MS = 30_000;

function baseUrl(): string {
  return (process.env.ICOG_API_URL || DEFAULT_BASE).replace(/\/+$/, "");
}
function apiKey(): string | undefined {
  return process.env.ICOG_API_KEY || undefined;
}
function agentSlug(): string {
  return process.env.ICOG_AGENT_SLUG || DEFAULT_SLUG;
}

export function isIcogConfigured(): boolean {
  return !!apiKey();
}

/* One JSON call to the iCog API. Returns parsed body on 2xx; throws a concise
   Error otherwise so the graph folds it into a ToolMessage the model can read. */
async function icogFetch(
  path: string,
  init: { method: "GET" | "POST"; body?: unknown },
  signal?: AbortSignal,
): Promise<unknown> {
  const key = apiKey();
  if (!key) {
    throw new Error(
      "iCog is not configured. Set ICOG_API_KEY (an icog_… personal access token) on the dashboard server to enable memory.",
    );
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  const onAbort = () => ctrl.abort();
  if (signal) {
    if (signal.aborted) ctrl.abort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  try {
    const res = await fetch(`${baseUrl()}${path}`, {
      method: init.method,
      headers: {
        "X-API-Key": key,
        ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: ctrl.signal,
    });
    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      /* leave as raw text */
    }
    if (!res.ok) {
      const detail =
        parsed && typeof parsed === "object" && "detail" in parsed
          ? String((parsed as { detail: unknown }).detail)
          : typeof parsed === "string"
            ? parsed.slice(0, 500)
            : `HTTP ${res.status}`;
      throw new Error(`iCog ${path} failed (${res.status}): ${detail}`);
    }
    return parsed;
  } catch (e) {
    if (e instanceof Error && e.name === "AbortError") {
      throw new Error(`iCog ${path} timed out after ${TIMEOUT_MS}ms`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", onAbort);
  }
}

export const ICOG_TOOLS: OpenAITool[] = [
  {
    type: "function",
    function: {
      name: "memory_recall",
      description:
        "Search Soli's persistent long-term memory (iCog) for relevant past context — prior decisions, user preferences, brand notes, what was done in earlier sessions. Use this BEFORE asking the user something they may have told you before, or when a request references past work. Returns the most semantically relevant memories.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "What to look for, in natural language (e.g. 'the user's preferred video mood', 'past launch promos')." },
          limit: { type: "number", description: "Max memories to return (default 6)." },
          memory_type: {
            type: "string",
            enum: ["semantic", "episodic", "procedural", "foundational"],
            description: "Optional filter: semantic=facts, episodic=events/sessions, procedural=how-tos, foundational=identity/values.",
          },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "memory_remember",
      description:
        "Persist a durable fact to Soli's long-term memory (iCog) so it survives across sessions — a user preference, a decision made, an outcome, or a reusable how-to. Only store things worth recalling later; do NOT store transient chatter. Confirm the takeaway with the user first when in doubt.",
      parameters: {
        type: "object",
        properties: {
          content: { type: "string", description: "The single fact to remember, written so it's self-contained when recalled out of context." },
          memory_type: {
            type: "string",
            enum: ["semantic", "episodic", "procedural", "foundational"],
            description: "semantic=fact/preference (default), episodic=an event that happened, procedural=a how-to/pattern, foundational=core identity/value.",
          },
        },
        required: ["content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "icog_talk",
      description:
        "Consult iCog — Soli's cognitive peer with the long view across all sessions — for perspective, judgment, or advice on a decision. Unlike memory_recall (raw search), this returns a reasoned response grounded in iCog's accumulated memory. Use sparingly for genuine judgement calls (e.g. 'is this style consistent with what the user liked before?').",
      parameters: {
        type: "object",
        properties: {
          message: { type: "string", description: "What you want iCog's perspective on." },
          current_task: { type: "string", description: "What Soli is currently working on, so iCog scopes its recall correctly. Strongly recommended." },
        },
        required: ["message"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "icog_reflect",
      description:
        "Read iCog's current self-state — consciousness level, total memory count, and a short narrative. Use only when the user explicitly asks about Soli's memory/state; not part of normal task flow.",
      parameters: { type: "object", properties: {} },
    },
  },
];

type IcogToolHandler = (args: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>;

export const icogToolHandlers: Record<string, IcogToolHandler> = {
  memory_recall: async (args, signal) => {
    const query = String(args.query ?? "").trim();
    if (!query) return { ok: false, error: "memory_recall requires a query" };
    const limit = Number.isFinite(Number(args.limit)) ? Math.max(1, Math.min(20, Number(args.limit))) : 6;
    // Send agent_slug so iCog includes the PRIVATE visibility arm and surfaces
    // the memories Soli wrote under this slug. (Requires the iCog server change
    // threading agent_slug through /api/recall; older servers ignore the field.)
    const body: Record<string, unknown> = { query, limit, agent_slug: agentSlug() };
    if (typeof args.memory_type === "string" && args.memory_type) body.memory_type = args.memory_type;
    const res = (await icogFetch("/api/recall", { method: "POST", body }, signal)) as {
      memories?: Array<{ id: string; text: string; memory_type?: string; age_days?: number; similarity?: number }>;
      count?: number;
    };
    const memories = (res.memories ?? []).map((m) => ({
      id: m.id,
      text: m.text,
      type: m.memory_type ?? null,
      age_days: m.age_days ?? null,
      similarity: typeof m.similarity === "number" ? Number(m.similarity.toFixed(3)) : null,
    }));
    return { ok: true, count: res.count ?? memories.length, memories };
  },

  memory_remember: async (args, signal) => {
    const content = String(args.content ?? "").trim();
    if (!content) return { ok: false, error: "memory_remember requires content" };
    // Write under Soli's agent_slug so the memory is attributed to (and claimed
    // by) socheli-soli. iCog stamps it agent-PRIVATE; memory_recall reads it
    // back by sending the SAME slug (see the recall handler above). Both sides
    // must carry the slug for the round-trip to work.
    const body: Record<string, unknown> = { content, agent_slug: agentSlug() };
    if (typeof args.memory_type === "string" && args.memory_type) body.memory_type = args.memory_type;
    const res = (await icogFetch("/api/remember", { method: "POST", body }, signal)) as { memory_id?: string };
    return { ok: true, memory_id: res.memory_id ?? null };
  },

  icog_talk: async (args, signal) => {
    const message = String(args.message ?? "").trim();
    if (!message) return { ok: false, error: "icog_talk requires a message" };
    const body: Record<string, unknown> = {
      message,
      agent_slug: agentSlug(),
      current_task: typeof args.current_task === "string" && args.current_task ? args.current_task : "Assisting in the Socheli video studio",
      scope_mode: "tiered",
    };
    const res = (await icogFetch("/api/talk", { method: "POST", body }, signal)) as {
      response?: string;
      context_used?: number;
    };
    return { ok: true, response: res.response ?? "", context_used: res.context_used ?? 0 };
  },

  icog_reflect: async (_args, signal) => {
    const res = (await icogFetch("/api/reflect", { method: "GET" }, signal)) as Record<string, unknown>;
    return {
      ok: true,
      consciousness_level: res.consciousness_level ?? null,
      memory_count: res.memory_count ?? null,
      narrative: res.narrative ?? null,
    };
  },
};

export function isIcogTool(name: string): boolean {
  return name in icogToolHandlers;
}
