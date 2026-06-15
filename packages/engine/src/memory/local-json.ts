/**
 * local-json.ts — the DEFAULT, zero-dependency memory provider.
 *
 * Stores memories as flat JSON under data/memory/, partitioned by scope, exactly
 * matching Socheli's "persistence is flat JSON under data/, atomic writes, no
 * database" convention. Recall is a dependency-free lexical rank (token overlap
 * + recency tie-break) — no embeddings, no server, no API key. This is what
 * makes the OSS repo render → remember → recall out of the box with nothing to
 * configure, which is the load-bearing requirement for the npx-zero-creds
 * launch. Swap MEMORY_PROVIDER to cogx/mem0/obsidian when you want semantic
 * recall or a shared brain.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { MemoryRecord, MemoryScope } from "@os/schemas";
import type { MemoryProvider, RecallOpts, RememberInput } from "./types.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const MEM_DIR = join(ROOT, "data", "memory");

/** A stable, filesystem-safe partition key for a scope. */
function scopeKey(scope?: MemoryScope): string {
  const parts = [scope?.workspaceId, scope?.channelId, scope?.userId].map((p) =>
    (p || "_").replace(/[^a-zA-Z0-9_-]/g, "-"),
  );
  return parts.every((p) => p === "_") ? "global" : parts.join("~");
}

function fileFor(scope?: MemoryScope): string {
  return join(MEM_DIR, `${scopeKey(scope)}.json`);
}

function loadFile(path: string): MemoryRecord[] {
  try {
    if (!existsSync(path)) return [];
    const raw = JSON.parse(readFileSync(path, "utf8"));
    return Array.isArray(raw) ? (raw as MemoryRecord[]) : [];
  } catch {
    return []; // a corrupt shard never takes the whole store down
  }
}

/** Atomic write: tmp file + rename (the repo's persistence contract). */
function saveFile(path: string, records: MemoryRecord[]): void {
  mkdirSync(MEM_DIR, { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(records, null, 2));
  renameSync(tmp, path);
}

/** Every shard (used when recall has no scope, i.e. a cross-brand sweep). */
function allFiles(): string[] {
  try {
    return readdirSync(MEM_DIR)
      .filter((f) => f.endsWith(".json"))
      .map((f) => join(MEM_DIR, f));
  } catch {
    return [];
  }
}

const STOP = new Set(["the", "a", "an", "of", "to", "and", "or", "in", "on", "for", "is", "it", "this", "that", "with"]);
function tokens(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 2 && !STOP.has(t));
}

/** Lexical relevance: fraction of distinct query tokens present in the content. */
function score(query: string[], content: string): number {
  if (!query.length) return 0;
  const hay = new Set(tokens(content));
  let hits = 0;
  for (const q of new Set(query)) if (hay.has(q)) hits++;
  return hits / new Set(query).size;
}

function newId(): string {
  return `mem_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export const localJsonProvider: MemoryProvider = {
  name: "local-json",
  available: () => true,

  async remember(input: RememberInput): Promise<MemoryRecord> {
    const path = fileFor(input.scope);
    const records = loadFile(path);
    const rec: MemoryRecord = {
      id: newId(),
      content: input.content,
      ...(input.kind ? { kind: input.kind } : {}),
      ...(input.scope ? { scope: input.scope } : {}),
      ...(input.metadata ? { metadata: input.metadata } : {}),
      createdAt: new Date().toISOString(),
    };
    records.push(rec);
    saveFile(path, records);
    return rec;
  },

  async recall(query: string, opts: RecallOpts = {}): Promise<MemoryRecord[]> {
    const limit = Math.max(1, Math.min(50, opts.limit ?? 6));
    // Scope given → read that one shard; no scope → sweep every shard.
    const paths = opts.scope ? [fileFor(opts.scope)] : allFiles();
    const q = tokens(query);
    const scored = paths
      .flatMap(loadFile)
      .filter((r) => !opts.kind || r.kind === opts.kind)
      .map((r) => ({ r, s: score(q, r.content) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s || (b.r.createdAt ?? "").localeCompare(a.r.createdAt ?? ""))
      .slice(0, limit);
    return scored.map((x) => ({ ...x.r, score: Number(x.s.toFixed(3)) }));
  },

  async update(id: string, content: string): Promise<MemoryRecord> {
    for (const path of allFiles()) {
      const records = loadFile(path);
      const idx = records.findIndex((r) => r.id === id);
      if (idx >= 0) {
        records[idx] = { ...records[idx], content };
        saveFile(path, records);
        return records[idx];
      }
    }
    throw new Error(`memory ${id} not found`);
  },

  async forget(id: string): Promise<void> {
    for (const path of allFiles()) {
      const records = loadFile(path);
      const next = records.filter((r) => r.id !== id);
      if (next.length !== records.length) {
        saveFile(path, next);
        return;
      }
    }
    // idempotent: forgetting an absent id is not an error
  },
};
