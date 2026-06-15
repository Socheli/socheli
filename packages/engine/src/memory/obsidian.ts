/**
 * obsidian.ts — Obsidian vault as memory, via the Local REST API plugin.
 *
 * For users who want their agent's memory to be human-readable, git-versioned
 * markdown they fully own. Each scope is a note; a memory is a bullet line with
 * a hidden marker comment (`<!--mem:ID-->`) so update/forget can target it. Recall
 * uses the plugin's search to find candidate notes, then lexically ranks bullets.
 *
 * Requires the "Local REST API" community plugin (coddingtonbear). Config:
 *   OBSIDIAN_API_URL   default http://127.0.0.1:27123 (the plugin's non-TLS port;
 *                      use the :27124 HTTPS port only if you handle its self-signed cert)
 *   OBSIDIAN_API_KEY   the plugin's API key (sent as `Authorization: Bearer <key>`)
 *   OBSIDIAN_MEMORY_DIR  vault folder for memory notes (default "socheli-memory")
 */

import type { MemoryRecord, MemoryScope } from "@os/schemas";
import type { MemoryProvider, RecallOpts, RememberInput } from "./types.ts";

const TIMEOUT_MS = 30_000;
const baseUrl = () => (process.env.OBSIDIAN_API_URL || "http://127.0.0.1:27123").replace(/\/+$/, "");
const apiKey = () => process.env.OBSIDIAN_API_KEY || undefined;
const memDir = () => (process.env.OBSIDIAN_MEMORY_DIR || "socheli-memory").replace(/^\/+|\/+$/g, "");

function scopeKey(scope?: MemoryScope): string {
  const parts = [scope?.workspaceId, scope?.channelId, scope?.userId].map((p) => (p || "_").replace(/[^a-zA-Z0-9_-]/g, "-"));
  return parts.every((p) => p === "_") ? "global" : parts.join("~");
}
const notePath = (scope?: MemoryScope) => `${memDir()}/${scopeKey(scope)}.md`;
const recordId = (path: string, marker: string) => `${path}::${marker}`;
const splitId = (id: string): { path: string; marker: string } => {
  const i = id.lastIndexOf("::");
  return i < 0 ? { path: id, marker: "" } : { path: id.slice(0, i), marker: id.slice(i + 2) };
};

async function obs(path: string, method: string, opts: { body?: string; contentType?: string } = {}): Promise<{ status: number; text: string }> {
  const key = apiKey();
  if (!key) throw new Error("Obsidian not configured: set OBSIDIAN_API_KEY to use MEMORY_PROVIDER=obsidian.");
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const headers: Record<string, string> = { Authorization: `Bearer ${key}` };
    if (opts.contentType) headers["Content-Type"] = opts.contentType;
    const res = await fetch(`${baseUrl()}${path}`, { method, headers, body: opts.body, signal: ctrl.signal });
    const text = await res.text();
    if (!res.ok && res.status !== 404) throw new Error(`Obsidian ${method} ${path} failed (${res.status}): ${text.slice(0, 200)}`);
    return { status: res.status, text };
  } catch (e) {
    if (e instanceof Error && e.name === "AbortError") throw new Error(`Obsidian ${path} timed out after ${TIMEOUT_MS}ms`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

const enc = (p: string) => p.split("/").map(encodeURIComponent).join("/");
async function readNote(path: string): Promise<string> {
  const { status, text } = await obs(`/vault/${enc(path)}`, "GET");
  return status === 404 ? "" : text;
}
async function writeNote(path: string, content: string): Promise<void> {
  await obs(`/vault/${enc(path)}`, "PUT", { body: content, contentType: "text/markdown" });
}

const LINE_RE = /^- (.*?)\s*<!--mem:([a-zA-Z0-9_]+)-->\s*$/;
const STOP = new Set(["the", "a", "an", "of", "to", "and", "or", "in", "on", "for", "is", "it", "this", "that", "with"]);
const tokens = (s: string) => s.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 2 && !STOP.has(t));
function lexScore(q: string[], content: string): number {
  if (!q.length) return 0;
  const hay = new Set(tokens(content));
  let hits = 0;
  for (const t of new Set(q)) if (hay.has(t)) hits++;
  return hits / new Set(q).size;
}

function parseBullets(path: string, content: string): MemoryRecord[] {
  return content
    .split("\n")
    .map((line) => LINE_RE.exec(line))
    .filter((m): m is RegExpExecArray => !!m)
    .map((m) => ({ id: recordId(path, m[2]), content: m[1] }));
}

export const obsidianProvider: MemoryProvider = {
  name: "obsidian",
  available: () => !!apiKey(),

  async remember(input: RememberInput): Promise<MemoryRecord> {
    const path = notePath(input.scope);
    const marker = `m${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const tag = input.kind ? `[${input.kind}] ` : "";
    const line = `- ${tag}${input.content.replace(/\n+/g, " ")} <!--mem:${marker}-->`;
    const existing = await readNote(path);
    const next = existing ? `${existing.replace(/\s*$/, "")}\n${line}\n` : `# ${scopeKey(input.scope)} memory\n\n${line}\n`;
    await writeNote(path, next);
    return { id: recordId(path, marker), content: input.content, ...(input.kind ? { kind: input.kind } : {}), ...(input.scope ? { scope: input.scope } : {}) };
  },

  async recall(query: string, opts: RecallOpts = {}): Promise<MemoryRecord[]> {
    const limit = Math.max(1, Math.min(50, opts.limit ?? 6));
    const q = tokens(query);
    // Scope given → read that note; else search the vault for candidate notes.
    let candidates: string[];
    if (opts.scope) {
      candidates = [notePath(opts.scope)];
    } else {
      const { text } = await obs(`/search/simple/?query=${encodeURIComponent(query)}&contextLength=0`, "POST");
      let hits: any[] = [];
      try {
        hits = JSON.parse(text);
      } catch {
        /* ignore */
      }
      candidates = Array.isArray(hits)
        ? hits.map((h) => String(h.filename ?? h.path ?? "")).filter((p) => p.startsWith(`${memDir()}/`))
        : [notePath()];
    }
    const bullets = (await Promise.all(candidates.map(async (p) => parseBullets(p, await readNote(p))))).flat();
    return bullets
      .map((r) => ({ r, s: lexScore(q, r.content) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, limit)
      .map((x) => ({ ...x.r, score: Number(x.s.toFixed(3)) }));
  },

  async update(id: string, content: string): Promise<MemoryRecord> {
    const { path, marker } = splitId(id);
    const note = await readNote(path);
    let found = false;
    const next = note
      .split("\n")
      .map((line) => {
        const m = LINE_RE.exec(line);
        if (m && m[2] === marker) {
          found = true;
          return `- ${content.replace(/\n+/g, " ")} <!--mem:${marker}-->`;
        }
        return line;
      })
      .join("\n");
    if (!found) throw new Error(`memory ${id} not found`);
    await writeNote(path, next);
    return { id, content };
  },

  async forget(id: string): Promise<void> {
    const { path, marker } = splitId(id);
    const note = await readNote(path);
    if (!note) return;
    const next = note
      .split("\n")
      .filter((line) => {
        const m = LINE_RE.exec(line);
        return !(m && m[2] === marker);
      })
      .join("\n");
    await writeNote(path, next);
  },
};
