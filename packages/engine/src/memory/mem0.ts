/**
 * mem0.ts — mem0 memory provider (managed api.mem0.ai OR a self-hosted server).
 *
 * mem0 is the most popular drop-in "memory layer" for agents; this adapter lets a
 * Socheli operator point at their own mem0 (self-host, full data ownership) or the
 * managed cloud, with no other code change. mem0 has no native learn/reflect, so
 * those optional verbs are simply absent (capability-detected at the call site).
 *
 * Config (server env):
 *   MEM0_API_KEY   managed-cloud token (sent as `Authorization: Token <key>`)
 *   MEM0_BASE_URL  override for a self-hosted mem0 server (default https://api.mem0.ai)
 *   MEM0_ORG_ID / MEM0_PROJECT_ID  optional managed-cloud scoping
 */

import type { MemoryRecord, MemoryScope } from "@os/schemas";
import type { MemoryProvider, RecallOpts, RememberInput } from "./types.ts";

const TIMEOUT_MS = 30_000;
const baseUrl = () => (process.env.MEM0_BASE_URL || "https://api.mem0.ai").replace(/\/+$/, "");
const apiKey = () => process.env.MEM0_API_KEY || undefined;

/* mem0 partitions by user_id; we map our scope onto it (channel first, then
   workspace, then user) so recall stays brand-scoped. */
function userId(scope?: MemoryScope): string {
  return scope?.channelId || scope?.workspaceId || scope?.userId || "socheli";
}

async function mem0(path: string, method: "GET" | "POST" | "PUT" | "DELETE", body?: unknown): Promise<any> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const headers: Record<string, string> = {};
    const key = apiKey();
    if (key) headers.Authorization = `Token ${key}`;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const res = await fetch(`${baseUrl()}${path}`, {
      method,
      headers,
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
    if (!res.ok) throw new Error(`mem0 ${path} failed (${res.status}): ${typeof parsed === "string" ? parsed.slice(0, 300) : JSON.stringify(parsed).slice(0, 300)}`);
    return parsed;
  } catch (e) {
    if (e instanceof Error && e.name === "AbortError") throw new Error(`mem0 ${path} timed out after ${TIMEOUT_MS}ms`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/* mem0 returns either {results:[...]} or a bare array depending on version. */
function rowsOf(res: any): any[] {
  if (Array.isArray(res)) return res;
  if (Array.isArray(res?.results)) return res.results;
  if (Array.isArray(res?.memories)) return res.memories;
  return [];
}

function toRecord(row: any, scope?: MemoryScope): MemoryRecord {
  return {
    id: String(row.id ?? row.memory_id ?? ""),
    content: String(row.memory ?? row.text ?? row.content ?? ""),
    ...(scope ? { scope } : {}),
    ...(typeof row.score === "number" ? { score: Number(row.score.toFixed(3)) } : {}),
  };
}

export const mem0Provider: MemoryProvider = {
  name: "mem0",
  available: () => !!(process.env.MEM0_API_KEY || process.env.MEM0_BASE_URL),

  async remember(input: RememberInput): Promise<MemoryRecord> {
    const res = await mem0("/v1/memories/", "POST", {
      messages: [{ role: "user", content: input.content }],
      user_id: userId(input.scope),
      metadata: { ...(input.kind ? { kind: input.kind } : {}), ...(input.metadata ?? {}) },
      ...(process.env.MEM0_ORG_ID ? { org_id: process.env.MEM0_ORG_ID } : {}),
      ...(process.env.MEM0_PROJECT_ID ? { project_id: process.env.MEM0_PROJECT_ID } : {}),
    });
    const row = rowsOf(res)[0] ?? res;
    return { ...toRecord(row, input.scope), content: input.content, ...(input.kind ? { kind: input.kind } : {}) };
  },

  async recall(query: string, opts: RecallOpts = {}): Promise<MemoryRecord[]> {
    const res = await mem0("/v1/memories/search/", "POST", {
      query,
      user_id: userId(opts.scope),
      top_k: Math.max(1, Math.min(50, opts.limit ?? 6)),
    });
    return rowsOf(res).map((r) => toRecord(r, opts.scope));
  },

  async update(id: string, content: string): Promise<MemoryRecord> {
    await mem0(`/v1/memories/${encodeURIComponent(id)}/`, "PUT", { text: content });
    return { id, content };
  },

  async forget(id: string): Promise<void> {
    await mem0(`/v1/memories/${encodeURIComponent(id)}/`, "DELETE");
  },
};
