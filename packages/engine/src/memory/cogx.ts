/**
 * cogx.ts — CognitiveX (iCog) memory provider.
 *
 * Wraps the iCog REST API (the same backend the `icog` MCP server proxies and
 * the dashboard's lib/agent/icog.ts already calls) behind the unified
 * MemoryProvider contract. Because iCog's own vocabulary is remember / recall /
 * update / forget / learn / reflect, this is a near-zero-impedance adapter — it
 * also implements the OPTIONAL cognitive verbs, so selecting MEMORY_PROVIDER=cogx
 * lights up semantic recall + Bayesian confidence + dream consolidation that the
 * local-json default can't offer.
 *
 * Config (server env):
 *   ICOG_API_URL    default https://api.cognitivx.io
 *   ICOG_API_KEY    personal access token "icog_…" (sent as X-API-Key — matches
 *                   the working dashboard client; see the SDK handoff Step 0 if
 *                   migrating to Bearer)
 *   ICOG_AGENT_SLUG default "socheli-soli" — scopes recall to Socheli's context
 */

import type { MemoryKind, MemoryRecord, MemoryScope } from "@os/schemas";
import type { MemoryProvider, RecallOpts, ReflectResult, RememberInput } from "./types.ts";

const DEFAULT_BASE = "https://api.cognitivx.io";
const DEFAULT_SLUG = "socheli-soli";
const TIMEOUT_MS = 30_000;

const baseUrl = () => (process.env.ICOG_API_URL || DEFAULT_BASE).replace(/\/+$/, "");
const apiKey = () => process.env.ICOG_API_KEY || undefined;
const agentSlug = () => process.env.ICOG_AGENT_SLUG || DEFAULT_SLUG;

/* Socheli's MemoryKind → iCog's memory_type taxonomy. */
const KIND_TO_TYPE: Record<MemoryKind, string> = {
  fact: "semantic",
  event: "episodic",
  howto: "procedural",
  identity: "foundational",
  trait: "semantic",
};

async function icog(path: string, method: "GET" | "POST", body?: unknown): Promise<any> {
  const key = apiKey();
  if (!key) throw new Error("iCog not configured: set ICOG_API_KEY (an icog_… token) to use MEMORY_PROVIDER=cogx.");
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${baseUrl()}${path}`, {
      method,
      headers: {
        "X-API-Key": key,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    const text = await res.text();
    let parsed: any = text;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      /* leave raw */
    }
    if (!res.ok) {
      const detail =
        parsed && typeof parsed === "object" && "detail" in parsed ? String(parsed.detail) : `HTTP ${res.status}`;
      throw new Error(`iCog ${path} failed (${res.status}): ${detail}`);
    }
    return parsed;
  } catch (e) {
    if (e instanceof Error && e.name === "AbortError") throw new Error(`iCog ${path} timed out after ${TIMEOUT_MS}ms`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/* iCog scoping rides on agent_slug; channel goes into the content tag + metadata
   so cross-channel recall stays attributable. */
function scopedSlug(_scope?: MemoryScope): string {
  return agentSlug();
}

export const cogxProvider: MemoryProvider = {
  name: "cogx",
  available: () => !!apiKey(),

  async remember(input: RememberInput): Promise<MemoryRecord> {
    const body: Record<string, unknown> = { content: input.content, agent_slug: scopedSlug(input.scope) };
    if (input.kind) body.memory_type = KIND_TO_TYPE[input.kind];
    const res = await icog("/api/remember", "POST", body);
    return {
      id: String(res?.memory_id ?? ""),
      content: input.content,
      ...(input.kind ? { kind: input.kind } : {}),
      ...(input.scope ? { scope: input.scope } : {}),
    };
  },

  async recall(query: string, opts: RecallOpts = {}): Promise<MemoryRecord[]> {
    const body: Record<string, unknown> = {
      query,
      limit: Math.max(1, Math.min(50, opts.limit ?? 6)),
      agent_slug: scopedSlug(opts.scope),
    };
    if (opts.kind) body.memory_type = KIND_TO_TYPE[opts.kind];
    const res = await icog("/api/recall", "POST", body);
    const memories: any[] = Array.isArray(res?.memories) ? res.memories : [];
    return memories.map((m) => ({
      id: String(m.id),
      content: String(m.text ?? m.content ?? ""),
      ...(opts.scope ? { scope: opts.scope } : {}),
      ...(typeof m.similarity === "number" ? { score: Number(m.similarity.toFixed(3)) } : {}),
    }));
  },

  async update(id: string, content: string): Promise<MemoryRecord> {
    await icog("/api/update", "POST", { memory_id: id, content });
    return { id, content };
  },

  async forget(id: string): Promise<void> {
    await icog("/api/forget", "POST", { memory_id: id });
  },

  async learn(signal: { outcome: string; scope?: MemoryScope }): Promise<void> {
    await icog("/api/learn", "POST", { outcome: signal.outcome, agent_slug: scopedSlug(signal.scope) });
  },

  async reflect(): Promise<ReflectResult> {
    const res = await icog("/api/reflect", "GET");
    return {
      summary: String(res?.narrative ?? ""),
      consciousness_level: res?.consciousness_level ?? null,
      memory_count: res?.memory_count ?? null,
    };
  },
};
