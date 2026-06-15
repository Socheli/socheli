import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { recordInWorkspace } from "@os/schemas";

export const REPO_ROOT = join(process.cwd(), "..", "..");
export const RUNS_DIR = join(REPO_ROOT, "data", "runs");
// Render outputs live on an external volume when mounted (see packages/engine/src/store.ts).
// Must stay in sync with the engine so the dashboard streams from the same place.
export const RENDERS_DIR =
  process.env.SOCHELI_RENDERS_DIR ||
  (process.env.SOCHELI_EXT_VOLUME && existsSync(process.env.SOCHELI_EXT_VOLUME)
    ? join(process.env.SOCHELI_EXT_VOLUME, "Socheli", "renders")
    : join(REPO_ROOT, "data", "renders"));

export type Item = {
  workspaceId?: string; // owning org/person (absent on legacy → DEFAULT_WORKSPACE)
  createdBy?: string; // Clerk user id of the author
  id: string;
  channel: string;
  createdAt: string;
  updatedAt: string;
  status: string;
  mood?: string; // content cluster (explainer/business/tech/…)
  kind?: string; // "longform" | "short" | "static_image" | "carousel"
  formatKind?: "short" | "static_image" | "carousel"; // explicit format chosen in /new
  layoutVariant?: string; // for static_image: highlight_bar | text_only | text_over_image | split | stat_card
  slideCount?: number; // for carousel: 3 | 5 | 6 | 8
  carouselSlides?: string[]; // rendered slide image paths
  staticImagePath?: string; // rendered static image path
  seedIdea: string;
  idea?: { topic: string; angle: string; format: string; rationale: string };
  script?: { hook: string; beats: string[]; cta: string; narration: string[] };
  storyboard?: { scenes: { id: string; type: string; durationSec: number }[]; topic: string; format: string };
  qa?: { scores: Record<string, number>; overall: number; verdict: string; notes: string[] };
  pkg?: { title: string; caption: string; hashtags: string[]; altText: string; platforms?: { platform: string; title?: string; caption: string; hashtags: string[]; keywords?: string[] }[] };
  videoPath?: string;
  thumbPath?: string; // designed cover / AI thumbnail (<id>_thumb.jpg)
  publish?: { platform: string; id?: string; url?: string; at: string; status: string }[];
  ledger: { entries: { stage: string; usd: number; at: string }[]; totalUsd: number };
  log: { at: string; msg: string }[];
};

export function listItems(): Item[] {
  if (!existsSync(RUNS_DIR)) return [];
  return readdirSync(RUNS_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      try {
        return JSON.parse(readFileSync(join(RUNS_DIR, f), "utf8")) as Item;
      } catch {
        return null;
      }
    })
    .filter((x): x is Item => !!x)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/* Resolve the actual rendered file; videoPath can be stale (renders moved to Beta/). */
export function videoFile(it: Item | null): string | null {
  if (!it) return null;
  if (it.videoPath && existsSync(it.videoPath)) return it.videoPath;
  for (const c of [join(RENDERS_DIR, `${it.id}.mp4`), join(RENDERS_DIR, "Beta", `${it.id}.mp4`)]) {
    if (existsSync(c)) return c;
  }
  return null;
}

/* Resolve the DESIGNED cover / AI thumbnail (`<id>_thumb.jpg`) if it exists.
   id-based (thumbPath can be a stale render-box path). Null → caller falls back
   to a video frame-grab. */
export function coverFile(it: Item | null): string | null {
  if (!it) return null;
  if (it.thumbPath && existsSync(it.thumbPath)) return it.thumbPath;
  for (const c of [join(RENDERS_DIR, `${it.id}_thumb.jpg`), join(RENDERS_DIR, "Beta", `${it.id}_thumb.jpg`)]) {
    if (existsSync(c)) return c;
  }
  return null;
}

/* A post is VERIFIED when its rendered video actually exists on disk. */
export function isVerified(it: Item | null): boolean {
  return !!videoFile(it);
}

export function getItem(id: string): Item | null {
  const p = join(RUNS_DIR, `${id}.json`);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as Item;
  } catch {
    return null;
  }
}

/* ── Workspace-scoped reads ────────────────────────────────────────────────
   The variants pages/routes should use: they return only items belonging to the
   caller's workspace (legacy unstamped items resolve to DEFAULT_WORKSPACE). The
   bare listItems()/getItem() stay for system/cross-workspace tooling. */
export function listItemsFor(workspaceId: string): Item[] {
  return listItems().filter((it) => recordInWorkspace(it, workspaceId));
}

export function getItemFor(id: string, workspaceId: string): Item | null {
  const it = getItem(id);
  return it && recordInWorkspace(it, workspaceId) ? it : null;
}

export function isToday(iso: string): boolean {
  return iso.slice(0, 10) === new Date().toISOString().slice(0, 10);
}

const TERMINAL = new Set(["packaged", "rendered"]);
export function warRoom(workspaceId?: string) {
  const items = workspaceId ? listItemsFor(workspaceId) : listItems();
  const today = items.filter((i) => isToday(i.createdAt));
  const done = items.filter((i) => i.status === "packaged" || i.status === "rendered");
  const passed = items.filter((i) => i.qa?.verdict === "pass").length;
  const qad = items.filter((i) => i.qa).length;
  const best = [...items].filter((i) => i.qa).sort((a, b) => (b.qa!.overall - a.qa!.overall))[0];
  const totalCost = items.reduce((a, i) => a + i.ledger.totalUsd, 0);
  const todayCost = today.reduce((a, i) => a + i.ledger.totalUsd, 0);
  const approvedCost = done.length ? totalCost / done.length : 0;
  return {
    total: items.length,
    todayCount: today.length,
    done: done.length,
    passRate: qad ? Math.round((passed / qad) * 100) : 0,
    totalCost,
    todayCost,
    approvedCost,
    best,
    recent: items.slice(0, 8),
    channels: new Set(items.map((i) => i.channel)).size,
  };
}
