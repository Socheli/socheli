import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "./store.ts";
import { DEFAULT_WORKSPACE, recordInWorkspace } from "@os/schemas";
import type { PlannedPost, ChannelBrief, SubjectPlaybook, ClusterCadence } from "./algo-research.ts";

/* The content plan: dated, brand/platform-aware posts produced by the algo-hacking
   planner (algo-research.ts), reviewed on the calendar, then promoted to a real
   run. Persisted as a flat list in data/content-plan.json. Newest plan-run first.

   Workspace-aware: every read takes a workspaceId (default DEFAULT_WORKSPACE so
   legacy/zero-arg callers keep working) and only ever touches posts in that
   workspace — unstamped legacy posts resolve to DEFAULT_WORKSPACE via
   recordInWorkspace, so single-tenant data stays visible. */

export const PLAN_FILE = join(DATA_DIR, "content-plan.json");

/* The whole on-disk list, unscoped. Internal — callers go through loadPlanFor. */
export function loadPlan(): PlannedPost[] {
  if (!existsSync(PLAN_FILE)) return [];
  try {
    return JSON.parse(readFileSync(PLAN_FILE, "utf8")) as PlannedPost[];
  } catch {
    return [];
  }
}

/* The plan scoped to one workspace — the canonical read path. */
export function loadPlanFor(workspaceId = DEFAULT_WORKSPACE): PlannedPost[] {
  return loadPlan().filter((p) => recordInWorkspace(p, workspaceId));
}

export function savePlan(list: PlannedPost[]) {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(PLAN_FILE, JSON.stringify(list, null, 2));
}

/* Prepend a fresh plan run's posts (keeps the newest plan on top). Posts arrive
   already stamped with their workspace from the planner (runAlgoPlan opts). */
export function appendPlan(posts: PlannedPost[]): PlannedPost[] {
  const list = [...posts, ...loadPlan()];
  savePlan(list);
  return list;
}

/* ── Single-post CRUD ──────────────────────────────────────────────────────
   The canonical edit/delete/archive/move surface the plan_* registry tools
   call, so MCP/SDK/CLI/HTTP all share one implementation. The dashboard mirrors
   this in apps/dashboard/lib/content-plan.ts (it can't import the engine pkg).
   Every op is scoped to a workspaceId so a teammate can never reach across the
   tenant boundary; the workspace defaults so existing single-tenant calls work. */

export function getPost(id: string, workspaceId = DEFAULT_WORKSPACE): PlannedPost | undefined {
  return loadPlan().find((x) => x.id === id && recordInWorkspace(x, workspaceId));
}

export function postsForDate(date: string, workspaceId = DEFAULT_WORKSPACE): PlannedPost[] {
  return loadPlanFor(workspaceId)
    .filter((x) => x.date === date)
    .sort((a, b) => (a.time || "").localeCompare(b.time || ""));
}

/* Fields a human/agent may patch from the calendar. Keep in sync with the mirror.
   `assignee` lets a post be handed to a teammate.
   NOTE: never add 'approval' here — it is admin-gated and written only via setApprovalField. */
const EDITABLE: (keyof PlannedPost)[] = [
  "date", "time", "status", "platform", "mood", "topic", "angle",
  "format", "hook", "rationale", "algoLever", "assignee",
];

export function updatePost(id: string, patch: Partial<PlannedPost>, workspaceId = DEFAULT_WORKSPACE): PlannedPost | undefined {
  const list = loadPlan();
  const p = list.find((x) => x.id === id && recordInWorkspace(x, workspaceId));
  if (!p) return undefined;
  for (const k of EDITABLE) {
    if (k in patch && (patch as Record<string, unknown>)[k] !== undefined) {
      (p as Record<string, unknown>)[k] = (patch as Record<string, unknown>)[k];
    }
  }
  (p as Record<string, unknown>).updatedAt = new Date().toISOString();
  savePlan(list);
  return p;
}

/* The ONLY writer of the admin-sign-off `approval` gate. Kept here (not in
   calendar-admin.ts) so all content-plan file IO stays in one module. Excluded
   from EDITABLE on purpose — gates are sacred, plan_update can never set it. */
export function setApprovalField(id: string, approval: { status: "pending" | "approved" | "rejected"; by: string; at: string }, workspaceId = DEFAULT_WORKSPACE): PlannedPost | undefined {
  const list = loadPlan();
  const p = list.find((x) => x.id === id && recordInWorkspace(x, workspaceId));
  if (!p) return undefined;
  (p as Record<string, unknown>).approval = approval;
  (p as Record<string, unknown>).updatedAt = new Date().toISOString();
  savePlan(list);
  return p;
}

/* Move a post to another date (and optionally a new time) — drag-and-drop reschedule. */
export function movePost(id: string, date: string, time?: string, workspaceId = DEFAULT_WORKSPACE): PlannedPost | undefined {
  return updatePost(id, time ? { date, time } : ({ date } as Partial<PlannedPost>), workspaceId);
}

/* Archive = soft-hide from the active plan without losing the record. */
export function archivePost(id: string, workspaceId = DEFAULT_WORKSPACE): PlannedPost | undefined {
  return updatePost(id, { status: "archived" } as Partial<PlannedPost>, workspaceId);
}

export function removePost(id: string, workspaceId = DEFAULT_WORKSPACE): boolean {
  const list = loadPlan();
  const next = list.filter((x) => !(x.id === id && recordInWorkspace(x, workspaceId)));
  if (next.length === list.length) return false;
  savePlan(next);
  return true;
}

/* ── Strategy brief store ──────────────────────────────────────────────────
   The deep research a plan run produces (channel brief + subject playbook +
   per-cluster cadence). Kept per-channel (latest wins) so the dashboard can show
   the current strategy without re-running research. */
export const STRATEGY_FILE = join(DATA_DIR, "content-strategy.json");
export type ChannelStrategy = {
  channel: string;
  channelName?: string;
  planRunId: string;
  at: string;
  brief?: ChannelBrief;
  subject?: SubjectPlaybook;
  cadence?: ClusterCadence;
};

export function loadStrategies(): Record<string, ChannelStrategy> {
  if (!existsSync(STRATEGY_FILE)) return {};
  try {
    return JSON.parse(readFileSync(STRATEGY_FILE, "utf8")) as Record<string, ChannelStrategy>;
  } catch {
    return {};
  }
}

export function loadStrategy(channel: string): ChannelStrategy | null {
  return loadStrategies()[channel] ?? null;
}

export function saveStrategy(s: ChannelStrategy): void {
  const all = loadStrategies();
  all[s.channel] = s;
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(STRATEGY_FILE, JSON.stringify(all, null, 2));
}
