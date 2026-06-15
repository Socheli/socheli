import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { ResearchRun } from "@os/schemas";
import { DATA_DIR, ensureDir, nowIso } from "../store.ts";

/* ════════════════════════════════════════════════════════════════════════
   Research store — the TTL cache behind the research harness.

   Layout (mirrors the rest of data/):
     data/research/index.json   — light index rows, one per run (fast scans,
                                  freshness checks, dashboard lists)
     data/research/<id>.json    — the full ResearchRun (sources, claims, report)

   The index exists so consumers (scanTrends, the algo planner, longform
   chapter research, dna evolve) can answer "do we already have fresh research
   for this exact question?" WITHOUT reading every run file. Freshness is keyed
   on a STABLE hash of (kind, channel, normalized query) — the same question
   asked twice within the TTL window reuses the cached run instead of burning
   another multi-step research pass.
   ════════════════════════════════════════════════════════════════════════ */

export const RESEARCH_DIR = join(DATA_DIR, "research");
const INDEX_FILE = join(RESEARCH_DIR, "index.json");

export type ResearchIndexEntry = {
  id: string;
  kind: ResearchRun["kind"];
  query: string;
  /** Stable hash of (kind, channel, normalized query) — the cache key. */
  hash: string;
  channel?: string;
  workspaceId?: string;
  createdAt: string;
  ttlHours: number;
  status: ResearchRun["status"];
};

/* Stable cache key. Normalization (lowercase + collapsed whitespace) means
   "TikTok Algorithm 2026" and "tiktok  algorithm 2026" hit the same cache
   entry — query strings are assembled by several different call sites and
   must not fragment the cache over formatting. */
export function queryHash(kind: string, query: string, channel?: string): string {
  const norm = query.toLowerCase().replace(/\s+/g, " ").trim();
  return createHash("sha1").update(`${kind}|${channel ?? ""}|${norm}`).digest("hex").slice(0, 16);
}

export function newResearchId(kind: string): string {
  const stamp = nowIso().replace(/[-:TZ.]/g, "").slice(0, 14);
  // 4 random chars so two runs started in the same second never collide
  // (the tool layer pre-allocates ids before spawning the detached worker).
  return `res_${kind}_${stamp}_${Math.random().toString(36).slice(2, 6)}`;
}

export function runPath(id: string): string {
  return join(RESEARCH_DIR, `${id}.json`);
}

/* Atomic write: write a sibling tmp file then rename over the target. rename(2)
   is atomic on the same filesystem, so a dashboard reading index.json mid-save
   never sees a half-written file (the orchestrator saves the run several times
   while it is still running). */
function writeAtomic(path: string, data: unknown) {
  ensureDir(RESEARCH_DIR);
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  renameSync(tmp, path);
}

function loadIndex(): ResearchIndexEntry[] {
  if (!existsSync(INDEX_FILE)) return [];
  try {
    const arr = JSON.parse(readFileSync(INDEX_FILE, "utf8"));
    return Array.isArray(arr) ? (arr as ResearchIndexEntry[]) : [];
  } catch {
    return []; // corrupt index degrades to "no cache" — runs themselves survive
  }
}

/* Persist a run: full file + index upsert. Called by the orchestrator at every
   milestone (created → after sweep → done/failed), so research_get always
   reflects live progress. */
export function saveRun(run: ResearchRun) {
  writeAtomic(runPath(run.id), run);
  const entry: ResearchIndexEntry = {
    id: run.id,
    kind: run.kind,
    query: run.query,
    hash: queryHash(run.kind, run.query, run.channel),
    channel: run.channel,
    workspaceId: run.workspaceId,
    createdAt: run.createdAt,
    ttlHours: run.ttlHours,
    status: run.status,
  };
  // RE-READ the index immediately before writing and upsert THIS run's entry by
  // id onto the fresh snapshot. The orchestrator saves a run several times as it
  // progresses, and concurrent workers (or a finished run + a still-running one)
  // race on index.json; merging by id — rather than rewriting the whole array
  // from a snapshot loaded earlier — stops a stale writer from regressing
  // another run's status (e.g. a 'done' row reverting to 'running'), which would
  // defeat findFresh. rename(2) keeps each individual write atomic; merge-by-id
  // keeps it correct under concurrency without a lockfile.
  const index = loadIndex();
  const i = index.findIndex((e) => e.id === run.id);
  if (i >= 0) index[i] = entry;
  else index.unshift(entry);
  writeAtomic(INDEX_FILE, index);
}

export function loadRun(id: string): ResearchRun | null {
  const p = runPath(id);
  if (!existsSync(p)) return null;
  try {
    return ResearchRun.parse(JSON.parse(readFileSync(p, "utf8")));
  } catch {
    return null; // schema drift / corruption → treat as missing, never throw
  }
}

export function listRuns(
  opts: { kind?: ResearchRun["kind"]; channel?: string; workspaceId?: string; limit?: number } = {},
): ResearchIndexEntry[] {
  let rows = loadIndex();
  if (opts.kind) rows = rows.filter((r) => r.kind === opts.kind);
  if (opts.channel) rows = rows.filter((r) => r.channel === opts.channel);
  if (opts.workspaceId) rows = rows.filter((r) => (r.workspaceId ?? "ws_default") === opts.workspaceId);
  rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return rows.slice(0, Math.max(1, opts.limit ?? 50));
}

const ageHours = (iso: string): number => (Date.now() - new Date(iso).getTime()) / 36e5;

/* The cache lookup every consumer calls before paying for a new run:
   `findFresh(kind, query, maxAgeH, channel) ?? runResearch(...)`. Only DONE
   runs count (a running run isn't usable yet; a failed one must not poison
   the cache). The caller's maxAgeH wins over the run's own ttlHours — the
   caller knows how stale its use case tolerates (trends 24h, algo 72h). */
export function findFresh(
  kind: ResearchRun["kind"],
  query: string,
  maxAgeH: number,
  channel?: string,
): ResearchRun | null {
  const hash = queryHash(kind, query, channel);
  const fresh = loadIndex()
    .filter((e) => e.hash === hash && e.status === "done" && ageHours(e.createdAt) <= maxAgeH)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  for (const e of fresh) {
    const run = loadRun(e.id);
    if (run) return run;
  }
  return null;
}
