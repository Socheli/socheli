import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_WORKSPACE, recordInWorkspace, type TenantContext } from "@os/schemas";
import { REPO_ROOT } from "./data";

/* Dashboard-side store for the algo-hacking content plan (data/content-plan.json).
   Self-contained mirror of the engine's content-plan.ts so the dashboard doesn't
   import the engine package — same pattern as lib/schedule.ts / lib/concepts.ts.

   Workspace-aware: every read/CRUD op takes a workspaceId (default
   DEFAULT_WORKSPACE so legacy callers keep working) and only ever touches posts
   in that workspace. Unstamped legacy posts resolve to DEFAULT_WORKSPACE via
   recordInWorkspace, so existing single-tenant data stays visible. */

const FILE = join(REPO_ROOT, "data", "content-plan.json");

export type PlatformKey = "youtube" | "instagram" | "tiktok" | "x" | "linkedin" | "telegram";
export type PlannedPost = {
  id: string;
  date: string; // YYYY-MM-DD
  time: string; // HH:MM
  channel: string;
  platform: PlatformKey;
  topic: string;
  angle: string;
  format: string;
  mood?: string;
  hook?: string;
  rationale: string;
  algoLever?: string;
  scores?: Record<string, number>;
  overall?: number;
  status: "idea" | "approved" | "scheduled" | "generated" | "dropped" | "archived";
  planRunId: string;
  createdAt: string;
  updatedAt?: string;
  /** Tenancy: which workspace owns this post and which user authored it. */
  workspaceId?: string;
  createdBy?: string;
  /** Clerk user id of the teammate this post is assigned to (optional). */
  assignee?: string;
  /** Calendar-admin sign-off gate (read-only here; set only by the engine
      caladmin_approve/reject writer — never via the generic update patch). */
  approval?: { status: "pending" | "approved" | "rejected"; by: string; at: string };
};

/* The whole on-disk list, unscoped. Internal — callers go through loadPlanFor. */
export function loadPlan(): PlannedPost[] {
  if (!existsSync(FILE)) return [];
  try {
    return JSON.parse(readFileSync(FILE, "utf8")) as PlannedPost[];
  } catch {
    return [];
  }
}

/* The plan scoped to one workspace — the canonical read path. */
export function loadPlanFor(workspaceId = DEFAULT_WORKSPACE): PlannedPost[] {
  return loadPlan().filter((p) => recordInWorkspace(p, workspaceId));
}

export function savePlan(list: PlannedPost[]) {
  writeFileSync(FILE, JSON.stringify(list, null, 2));
}

export function getPost(id: string, workspaceId = DEFAULT_WORKSPACE): PlannedPost | undefined {
  return loadPlan().find((x) => x.id === id && recordInWorkspace(x, workspaceId));
}

export function postsForDate(date: string, workspaceId = DEFAULT_WORKSPACE): PlannedPost[] {
  return loadPlanFor(workspaceId)
    .filter((x) => x.date === date)
    .sort((a, b) => (a.time || "").localeCompare(b.time || ""));
}

export function updatePost(id: string, patch: Partial<PlannedPost>, workspaceId = DEFAULT_WORKSPACE): PlannedPost | undefined {
  const list = loadPlan();
  const p = list.find((x) => x.id === id && recordInWorkspace(x, workspaceId));
  if (!p) return undefined;
  // Only allow patching the fields a human/agent is meant to touch from the calendar.
  // `assignee` lets a post be handed to a teammate.
  const allowed: (keyof PlannedPost)[] = [
    "date", "time", "status", "platform", "mood", "topic", "angle",
    "format", "hook", "rationale", "algoLever", "assignee",
  ];
  for (const k of allowed) {
    if (k in patch && patch[k] !== undefined) (p as Record<string, unknown>)[k] = patch[k];
  }
  p.updatedAt = new Date().toISOString();
  savePlan(list);
  return p;
}

/* Move a post to another date (and optionally a new time) — the drag-and-drop reschedule. */
export function movePost(id: string, date: string, time?: string, workspaceId = DEFAULT_WORKSPACE): PlannedPost | undefined {
  return updatePost(id, time ? { date, time } : { date }, workspaceId);
}

/* Archive = soft-hide from the active plan without losing the record. */
export function archivePost(id: string, workspaceId = DEFAULT_WORKSPACE): PlannedPost | undefined {
  return updatePost(id, { status: "archived" }, workspaceId);
}

export function removePost(id: string, workspaceId = DEFAULT_WORKSPACE): boolean {
  const list = loadPlan();
  const next = list.filter((x) => !(x.id === id && recordInWorkspace(x, workspaceId)));
  if (next.length === list.length) return false;
  savePlan(next);
  return true;
}

/* Stamp a post created from the dashboard with its workspace + author. Used when
   a plan run's posts are persisted, or a single post is hand-added. */
export function stampPlanPost(post: PlannedPost, ctx: Pick<TenantContext, "workspaceId" | "userId">): PlannedPost {
  if (!post.workspaceId) post.workspaceId = ctx.workspaceId;
  if (!post.createdBy && ctx.userId) post.createdBy = ctx.userId;
  return post;
}
