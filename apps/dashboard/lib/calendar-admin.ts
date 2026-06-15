import "server-only";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { listBrands } from "./brands";
import { loadPlanFor } from "./content-plan";
import { REPO_ROOT } from "./data";

/* The dashboard's READ + MUTATE bridge for the Calendar Admin cockpit.

   Cross-brand calendar oversight sits ABOVE the per-brand /calendar and /plan
   surfaces: it AGGREGATES the same stores (data/content-plan.json planned posts,
   data/schedule(s) cadence, data/calendar-policy/<channel>.json posting policy)
   and routes every mutation through the canonical engine tools (caladmin_*).

   To keep ONE shape, conflicts + posting policy come from the engine tools
   (caladmin_conflicts / caladmin_policy_get) rather than being recomputed here.
   The cheap calendar grid (posts + brand coloring) is composed locally from
   lib/content-plan + lib/brands so the month grid renders without spawning a
   tool per request; the heavier rollup (conflicts/policy) is pulled from the
   engine via the spawn-runner — the same boundary lib/missions.ts uses.

   The dashboard NEVER bundles the engine: mutations spawn
     node --import tsx packages/engine/src/tool.ts caladmin_<x> '{…}'
   so the engine keeps every invariant (atomic writes, gates, approval state). */

/* ── Mirrored read types (kept in lockstep with the engine tool outputs) ─── */

export type ApprovalState = "pending" | "approved" | "rejected";

/* A planned post as the cockpit sees it. The canonical approval field
   (post.approval) is added to the lib/content-plan.ts PlannedPost mirror by the
   orchestrator; we read it tolerantly so this file compiles before that lands. */
export type AdminPost = {
  id: string;
  date: string; // YYYY-MM-DD
  time: string; // HH:MM
  channel: string;
  brandName: string;
  accent: string;
  platform: string;
  topic: string;
  angle?: string;
  format?: string;
  mood?: string;
  status: string; // PlannedPost.status
  overall?: number;
  algoLever?: string;
  assignee?: string;
  approvalStatus: ApprovalState | "none";
  updatedAt?: string;
};

/* A scheduling problem the engine detected. `postIds` are the colliding posts. */
export type Conflict = {
  kind: "overlap" | "overCapacity" | "collision" | "blackoutViolation";
  date: string;
  channel?: string;
  message: string;
  postIds: string[];
};

export type Blackout = {
  from: string; // YYYY-MM-DD
  to: string; // YYYY-MM-DD
  startTime?: string; // HH:MM (optional intra-day window start)
  endTime?: string; // HH:MM
  reason?: string;
};

/* Per-brand posting policy mirror (engine: CalendarPolicy, stored per channel
   in data/calendar-policy/<channel>.json — NOT in @os/schemas, like the
   responder/connection per-brand configs). */
export type PostingPolicy = {
  channel: string;
  cadence?: {
    perWeek?: Partial<Record<string, number>>; // platform → posts/week
    perDayMax?: number;
  };
  bestTimes?: { day?: string; time: string; platform?: string }[];
  blackouts?: Blackout[];
  updatedAt?: string;
};

export type AdminBrand = { id: string; name: string; accent: string };

export type AdminCalendar = {
  brands: AdminBrand[];
  posts: AdminPost[];
  approvalQueue: AdminPost[];
  policies: PostingPolicy[];
  conflicts: Conflict[];
  bestTimes: Record<string, { day?: string; time: string; platform?: string }[]>;
};

export type ToolResult = { ok: boolean; data?: Record<string, unknown>; message?: string };

/* A deterministic accent palette so brands without a configured accent still
   get a stable, distinct calendar color (hash brand id → palette index). */
const PALETTE = ["#7c5cff", "#34d399", "#f59e0b", "#ef4444", "#38bdf8", "#ec4899", "#a3e635", "#fb7185"];
function accentFor(id: string, configured?: string): string {
  if (configured && configured.trim()) return configured;
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

/* ── Engine mutation bridge ───────────────────────────────────────────────
   Mirrors lib/missions.ts runMissionTool EXACTLY (allowlist + spawn + tolerant
   stdout JSON parse). The engine trusts the caller, so the route passes the
   workspaceId / by (ctx.userId) explicitly. */

const CAL_ADMIN_TOOLS = new Set([
  "caladmin_overview",
  "caladmin_conflicts",
  "caladmin_policy_get",
  "caladmin_policy_set",
  "caladmin_bulk",
  "caladmin_approve",
  "caladmin_reject",
]);

export function runCalendarAdminTool(name: string, input: Record<string, unknown>): Promise<ToolResult> {
  if (!CAL_ADMIN_TOOLS.has(name)) {
    return Promise.resolve({ ok: false, message: `not a calendar-admin tool: ${name}` });
  }
  const runner = join(REPO_ROOT, "packages", "engine", "src", "tool.ts");
  return new Promise((resolve) => {
    const child = spawn("node", ["--import", "tsx", runner, name, JSON.stringify(input)], {
      cwd: REPO_ROOT,
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", (e) => resolve({ ok: false, message: String(e) }));
    child.on("close", () => {
      try {
        resolve(JSON.parse(stdout.trim()) as ToolResult);
      } catch {
        resolve({ ok: false, message: (stderr || stdout).trim().slice(0, 2000) || "engine produced no output" });
      }
    });
  });
}

/* ── Bulk helpers (prefer the single engine caladmin_bulk call) ──────────── */

export function bulkMove(ids: string[], date: string, time: string | undefined, workspaceId: string): Promise<ToolResult> {
  return runCalendarAdminTool("caladmin_bulk", { workspaceId, op: "reschedule", ids, date, ...(time ? { time } : {}) });
}

export function bulkAssign(ids: string[], assignee: string, workspaceId: string): Promise<ToolResult> {
  return runCalendarAdminTool("caladmin_bulk", { workspaceId, op: "assign", ids, assignee });
}

export function bulkApprove(ids: string[], by: string, workspaceId: string): Promise<ToolResult> {
  return runCalendarAdminTool("caladmin_bulk", { workspaceId, op: "approve", ids, by });
}

export function bulkReject(ids: string[], by: string, workspaceId: string): Promise<ToolResult> {
  return runCalendarAdminTool("caladmin_bulk", { workspaceId, op: "reject", ids, by });
}

/* ── Aggregated read ──────────────────────────────────────────────────────
   The cheap grid (posts + brand accents) is composed from the local mirrors;
   conflicts + per-brand policy come from the engine so there's ONE shape and
   no duplicated detection logic. Engine failures degrade gracefully to empty
   so the calendar grid always renders. */

type RawPost = Record<string, unknown> & {
  approval?: { status?: ApprovalState; by?: string; at?: string };
};

function toAdminPost(p: RawPost, accents: Map<string, { name: string; accent: string }>): AdminPost {
  const channel = String(p.channel ?? "");
  const brand = accents.get(channel);
  const approvalStatus: AdminPost["approvalStatus"] = p.approval?.status ?? "none";
  return {
    id: String(p.id ?? ""),
    date: String(p.date ?? ""),
    time: String(p.time ?? ""),
    channel,
    brandName: brand?.name ?? channel,
    accent: brand?.accent ?? accentFor(channel),
    platform: String(p.platform ?? ""),
    topic: String(p.topic ?? ""),
    angle: p.angle ? String(p.angle) : undefined,
    format: p.format ? String(p.format) : undefined,
    mood: p.mood ? String(p.mood) : undefined,
    status: String(p.status ?? "idea"),
    overall: typeof p.overall === "number" ? p.overall : undefined,
    algoLever: p.algoLever ? String(p.algoLever) : undefined,
    assignee: p.assignee ? String(p.assignee) : undefined,
    approvalStatus,
    updatedAt: p.updatedAt ? String(p.updatedAt) : undefined,
  };
}

export async function adminCalendarFor(workspaceId: string): Promise<AdminCalendar> {
  const brandList = listBrands(workspaceId);
  const accents = new Map<string, { name: string; accent: string }>();
  const brands: AdminBrand[] = brandList.map((b) => {
    const accent = accentFor(b.id, b.accent);
    accents.set(b.id, { name: b.name, accent });
    return { id: b.id, name: b.name, accent };
  });

  // Cheap local grid — every planned post in the workspace (excludes archived).
  const planned = loadPlanFor(workspaceId) as unknown as RawPost[];
  const posts: AdminPost[] = planned
    .filter((p) => String(p.status ?? "") !== "archived")
    .map((p) => toAdminPost(p, accents))
    .sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));

  // Approval queue: anything not yet admin-approved that's still actionable.
  const ACTIONABLE = new Set(["idea", "approved", "scheduled"]);
  const approvalQueue = posts.filter(
    (p) => p.approvalStatus !== "approved" && ACTIONABLE.has(p.status) && p.status !== "archived",
  );

  // Heavier rollup from the engine (ONE shape, no duplicated detection).
  const conflicts = await fetchConflicts(workspaceId);
  const policies = await fetchPolicies(workspaceId, brands);

  const bestTimes: AdminCalendar["bestTimes"] = {};
  for (const pol of policies) bestTimes[pol.channel] = pol.bestTimes ?? [];

  return { brands, posts, approvalQueue, policies, conflicts, bestTimes };
}

async function fetchConflicts(workspaceId: string): Promise<Conflict[]> {
  const res = await runCalendarAdminTool("caladmin_conflicts", { workspaceId });
  if (!res.ok || !res.data) return [];
  const raw = res.data;
  // The engine returns {overlaps,overCapacity,collisions,blackoutViolations} or a
  // flat {conflicts:[]}; normalise either into the flat Conflict[] the panel wants.
  if (Array.isArray((raw as { conflicts?: unknown[] }).conflicts)) {
    return ((raw as { conflicts: unknown[] }).conflicts as Conflict[]) ?? [];
  }
  const buckets: [Conflict["kind"], unknown][] = [
    ["overlap", (raw as Record<string, unknown>).overlaps],
    ["overCapacity", (raw as Record<string, unknown>).overCapacity],
    ["collision", (raw as Record<string, unknown>).collisions],
    ["blackoutViolation", (raw as Record<string, unknown>).blackoutViolations],
  ];
  const out: Conflict[] = [];
  for (const [kind, arr] of buckets) {
    if (!Array.isArray(arr)) continue;
    for (const c of arr as Record<string, unknown>[]) {
      out.push({
        kind,
        date: String(c.date ?? ""),
        channel: c.channel ? String(c.channel) : undefined,
        message: String(c.message ?? c.reason ?? ""),
        postIds: Array.isArray(c.postIds) ? (c.postIds as string[]) : [],
      });
    }
  }
  return out;
}

async function fetchPolicies(workspaceId: string, brands: AdminBrand[]): Promise<PostingPolicy[]> {
  const out: PostingPolicy[] = [];
  for (const b of brands) {
    const res = await runCalendarAdminTool("caladmin_policy_get", { workspaceId, channel: b.id });
    if (res.ok && res.data) {
      // Engine caladmin_policy_get returns the stored CalendarPolicy with the
      // field `blackout` (singular); the dashboard PostingPolicy uses `blackouts`.
      const d = res.data as Partial<PostingPolicy> & { blackout?: PostingPolicy["blackouts"] };
      out.push({
        channel: b.id,
        cadence: d.cadence ?? {},
        bestTimes: d.bestTimes ?? [],
        blackouts: d.blackout ?? d.blackouts ?? [],
        updatedAt: d.updatedAt,
      });
    } else {
      out.push({ channel: b.id, cadence: {}, bestTimes: [], blackouts: [] });
    }
  }
  return out;
}
