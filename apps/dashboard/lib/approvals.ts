import "server-only";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { BrandGenome } from "@os/schemas";
import type { BrandGenome as Genome } from "@os/schemas";
import { REPO_ROOT, RUNS_DIR, listItemsFor, isVerified, type Item } from "./data";
import { listBrands } from "./brands";

/* The approvals inbox feed (/missions): everything across the workspace that
   waits on a human decision.

   1. Pending DNA mutations — read straight from the genome store
      (data/dna/<channel>.json, owned by packages/engine/src/dna.ts). An absent
      file means "nothing learned / nothing pending yet" (the engine seeds on
      first getGenome), so listing never needs an engine spawn — important
      because the missions board refreshes every few seconds. Approve/reject
      goes through the engine via /api/dna/mutations.

   2. Gated publishes — items whose render is verified and whose publish ledger
      holds prepared-but-not-live entries (ready bundle / platform draft /
      private upload), i.e. the autopilot/mission publish gate is waiting on a
      human "approve → publish". Approval calls the existing /api/publish. */

const DNA_DIR = join(REPO_ROOT, "data", "dna");

function readGenome(channel: string): Genome | null {
  const p = join(DNA_DIR, `${channel.replace(/[^a-zA-Z0-9_-]/g, "_")}.json`);
  if (!existsSync(p)) return null;
  try {
    const parsed = BrandGenome.safeParse(JSON.parse(readFileSync(p, "utf8")));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/* The /missions board polls the approvals feed every ~5s. Both feeds below scan
   many on-disk files (every brand's genome; every run + its render-file stat),
   which is pure waste when nothing changed between polls. A tiny module-level
   cache, keyed on a cheap fingerprint of the dna/runs directory mtimes, lets an
   idle tab return the previous result without re-parsing anything. The mtime of
   the *directory* changes whenever a child file is added/removed/replaced (the
   engine writes atomically via rename), and we also fold in each dir's own
   mtime — enough to invalidate on every mutation the board cares about. */
function dirStamp(dir: string): number {
  try {
    return statSync(dir).mtimeMs;
  } catch {
    return 0; // absent dir → stable 0, so an empty workspace still caches
  }
}
function feedStamp(): string {
  return `${dirStamp(DNA_DIR)}:${dirStamp(RUNS_DIR)}`;
}

type FeedCache<T> = { stamp: string; byWorkspace: Map<string, T> };
const mutationsCache: FeedCache<DnaApproval[]> = { stamp: "", byWorkspace: new Map() };
const gatedCache: FeedCache<GatedPublish[]> = { stamp: "", byWorkspace: new Map() };

/* Return the cached value for (workspace, current stamp) or compute+store it.
   A stamp change drops the whole table — directory contents moved on. */
function cached<T>(cache: FeedCache<T>, workspaceId: string, compute: () => T): T {
  const stamp = feedStamp();
  if (cache.stamp !== stamp) {
    cache.stamp = stamp;
    cache.byWorkspace.clear();
  }
  const hit = cache.byWorkspace.get(workspaceId);
  if (hit !== undefined) return hit;
  const val = compute();
  cache.byWorkspace.set(workspaceId, val);
  return val;
}

/* Explicit shape (not a Pick off the zod infer — the dashboard compiles with
   strict:false, which collapses zod's optionality detection). */
export type DnaApproval = {
  id: string;
  proposedAt: string;
  path: string;
  mutation: string;
  rationale: string;
  confidence: number;
  channel: string;
  brandName: string;
  accent?: string;
};

/* All pending mutations across the workspace's brands, newest first. Scoping
   rides on the brand registry: a workspace only ever sees genomes for brands
   it owns (lib/brands.ts listBrands is workspace-scoped). */
export function pendingMutationsFor(workspaceId: string): DnaApproval[] {
  return cached(mutationsCache, workspaceId, () => {
    const rows: DnaApproval[] = [];
    for (const b of listBrands(workspaceId)) {
      const g = readGenome(b.id);
      if (!g?.pending?.length) continue;
      for (const p of g.pending) {
        rows.push({
          id: p.id,
          proposedAt: p.proposedAt,
          path: p.path,
          mutation: p.mutation,
          rationale: p.rationale,
          confidence: p.confidence,
          channel: b.id,
          brandName: b.name,
          accent: b.accent,
        });
      }
    }
    return rows.sort((a, b) => b.proposedAt.localeCompare(a.proposedAt));
  });
}

export type GatedPublish = {
  id: string;
  title: string;
  channel: string;
  createdAt: string;
  /* the platforms still waiting, with their prepared state */
  waiting: { platform: string; status: string }[];
};

/* Publish-ledger statuses that mean "prepared, waiting on the human gate".
   (Vocabulary from engine publisher.ts: "ready" = paste-ready bundle,
   "draft" = saved platform draft, "private" = uploaded unlisted/private.) */
const GATE_WAITING = new Set(["ready", "draft", "private"]);

export function gatedPublishesFor(workspaceId: string, limit = 12): GatedPublish[] {
  // Cache key folds in the limit since different callers may ask for different
  // page sizes against the same on-disk state.
  return cached(gatedCache, `${workspaceId}#${limit}`, () => {
    const out: GatedPublish[] = [];
    for (const it of listItemsFor(workspaceId)) {
      // Cheap publish-ledger gate FIRST — most items carry no ready/draft/private
      // entry, so we filter them out before ever stat-ing render files (isVerified
      // does existsSync probes that dominate this loop for an unverified backlog).
      const eff = new Map<string, string>();
      for (const e of it.publish ?? []) eff.set(e.platform, e.status);
      if (!eff.size) continue;
      if ([...eff.values()].some((s) => s === "published")) continue; // already live somewhere
      const waiting = [...eff.entries()]
        .filter(([, s]) => GATE_WAITING.has(s))
        .map(([platform, status]) => ({ platform, status }));
      if (!waiting.length) continue;
      // Only now pay for the disk stat: a render must actually exist to approve.
      if (!isVerified(it)) continue;
      out.push({
        id: it.id,
        title: titleOf(it),
        channel: it.channel,
        createdAt: it.createdAt,
        waiting,
      });
      if (out.length >= limit) break; // listItemsFor is newest-first already
    }
    return out;
  });
}

function titleOf(it: Item): string {
  return it.pkg?.title ?? it.idea?.topic ?? it.storyboard?.topic ?? it.seedIdea;
}
