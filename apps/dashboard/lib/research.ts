import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ResearchRun, recordInWorkspace } from "@os/schemas";
import type { ResearchRun as ResearchRunT, ResearchSource, ResearchClaim } from "@os/schemas";
import { REPO_ROOT } from "./data";

/* The dashboard's view of the research harness cache (data/research/). Same
   files the engine's research/store.ts writes — index.json for fast list scans
   plus one <id>.json per run — read directly here, exactly like lib/brands.ts
   reads data/brands.json. All COMPUTE stays in the engine: starting a run means
   spawning packages/engine/src/research/run-cli.ts detached (see
   app/api/research/route.ts), never re-running the loop in-process.

   The run shape is owned by the shared schema (@os/schemas ResearchRun); we
   validate against it with a tolerant safeParse (the lib/missions.ts pattern)
   rather than hand-rolling parallel types that can drift from the engine.

   Runs are workspace-scoped like every other record: the orchestrator stamps
   workspaceId/createdBy onto each run; unstamped legacy runs resolve to the
   default workspace via the shared recordInWorkspace() rule. */

export const RESEARCH_DIR = join(REPO_ROOT, "data", "research");

/* Re-export the schema's literal unions/types so existing dashboard imports keep
   working while the source of truth stays in @os/schemas. */
export const RESEARCH_KINDS = ["trend", "algo", "topic", "competitor", "deep"] as const;
export const RESEARCH_DEPTHS = ["quick", "standard", "deep"] as const;
export type ResearchKind = ResearchRunT["kind"];
export type ResearchDepth = ResearchRunT["depth"];
export type ResearchStatus = ResearchRunT["status"];
export type ClaimStatus = ResearchClaim["status"];
export type { ResearchSource, ResearchClaim };
export type ResearchStep = ResearchRunT["steps"][number];

/* The run shape IS the schema's ResearchRun (kept as a named export for the
   dashboard's callers). Any dashboard-only enrichment lives on ResearchListRow
   below, never on the persisted run. */
export type ResearchRunData = ResearchRunT;

/* One list row: the index entry enriched with depth/usd/counts from the run
   file (the index alone doesn't carry cost or source/claim counts). */
export type ResearchListRow = {
  id: string;
  kind: ResearchKind;
  query: string;
  channel?: string;
  depth?: ResearchDepth;
  status: ResearchStatus;
  createdAt: string;
  ttlHours: number;
  usd: number;
  sourceCount: number;
  claimCount: number;
  ageHours: number;
  fresh: boolean;
};

type IndexEntry = {
  id: string;
  kind: ResearchKind;
  query: string;
  channel?: string;
  workspaceId?: string;
  createdAt: string;
  ttlHours: number;
  status: ResearchStatus;
};

function readJson<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null; // mid-write / corrupt file degrades to "missing", never throws
  }
}

/* A run file, validated against the shared schema (tolerant: a malformed/half-
   written run degrades to null rather than throwing). */
function readRun(id: string): ResearchRunData | null {
  if (!existsSync(join(RESEARCH_DIR, `${id}.json`))) return null;
  try {
    const parsed = ResearchRun.safeParse(JSON.parse(readFileSync(join(RESEARCH_DIR, `${id}.json`), "utf8")));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

const ageHours = (iso: string): number => Math.max(0, (Date.now() - new Date(iso).getTime()) / 36e5);

/* Load one run, scoped to the caller's workspace. The id is also the filename,
   so reject anything that isn't a plain token before touching the filesystem. */
export function loadResearchRun(id: string, workspaceId: string): ResearchRunData | null {
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id)) return null;
  const run = readRun(id);
  if (!run || !recordInWorkspace(run, workspaceId)) return null;
  return run;
}

/* List the workspace's runs (newest first), optionally filtered by kind /
   channel. Each index row is enriched from its run file — local JSON reads
   over at most `limit` files, cheap enough for the dashboard list. */
export function listResearch(
  workspaceId: string,
  opts: { kind?: string; channel?: string; limit?: number } = {},
): ResearchListRow[] {
  const index = readJson<IndexEntry[]>(join(RESEARCH_DIR, "index.json")) ?? [];
  const rows = (Array.isArray(index) ? index : [])
    .filter((e) => e && e.id && recordInWorkspace(e, workspaceId))
    .filter((e) => (opts.kind ? e.kind === opts.kind : true))
    .filter((e) => (opts.channel ? e.channel === opts.channel : true))
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    .slice(0, Math.max(1, opts.limit ?? 100));

  return rows.map((e) => {
    const run = readRun(e.id);
    const age = ageHours(e.createdAt);
    const status = run?.status ?? e.status; // the run file is the live truth
    return {
      id: e.id,
      kind: e.kind,
      query: e.query,
      channel: e.channel,
      depth: run?.depth,
      status,
      createdAt: e.createdAt,
      ttlHours: e.ttlHours,
      usd: run?.usd ?? 0,
      sourceCount: run?.sources?.length ?? 0,
      claimCount: run?.claims?.length ?? 0,
      ageHours: age,
      fresh: status === "done" && age <= e.ttlHours,
    };
  });
}
