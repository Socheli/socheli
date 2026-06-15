/**
 * calendar-admin.ts — pure cross-brand calendar-oversight logic (Calendar Admin
 * cockpit engine layer). AGGREGATES the existing stores; it never duplicates
 * their IO:
 *   - planned posts: content-plan.ts (loadPlanFor/getPost/updatePost/movePost/
 *     setApprovalField — the sole writer of the admin `approval` gate)
 *   - brands/channels: channels.ts (effectiveChannels/channelName) +
 *     brands-store.ts (readBrandRegistry, for names/accents beyond built-ins)
 *   - posting cadence/best-times: posting-times.ts (recommendedWeek/bestTimes)
 *
 * The per-channel posting POLICY (cadence caps + best-times + blackout windows)
 * is an engine-local config — it lives in this module, like responder/connection
 * configs, NOT in @os/schemas. Persisted at data/calendar-policy/<sanitize>.json
 * with the EXACT atomic tmp+rename + sanitize convention used by
 * responder.ts/comments.ts. Carries no secrets.
 *
 * Every read takes an optional workspaceId (default DEFAULT_WORKSPACE so legacy
 * single-tenant data stays visible); cross-tenant ids are skipped, never thrown.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

import { DEFAULT_WORKSPACE, recordInWorkspace, type TenantContext } from "@os/schemas";
import { DATA_DIR, nowIso } from "./store.ts";
import { loadPlanFor, getPost, updatePost, movePost, setApprovalField } from "./content-plan.ts";
import type { PlannedPost } from "./algo-research.ts";
import { effectiveChannels, channelName } from "./channels.ts";
import { readBrandRegistry } from "./brands-store.ts";

// ───────────────────────────────────────────────────────────────────────────
// Policy schema (engine-local, per-channel)
// ───────────────────────────────────────────────────────────────────────────

export const CalendarPolicy = z.object({
  channel: z.string(),
  cadence: z.object({
    perWeek: z.record(z.string(), z.number()).optional(), // per-platform posts/week target
    perDayMax: z.number().int().min(0).optional(),        // hard cap on posts/day for the channel
  }).default({}),
  bestTimes: z.object({
    enabled: z.boolean().default(true),
    perPlatform: z.record(
      z.string(),
      z.array(z.object({
        time: z.string().regex(/^\d{2}:\d{2}$/),
        days: z.array(z.number().int().min(0).max(6)).default([]),
      })),
    ).default({}),
  }).default({ enabled: true, perPlatform: {} }),
  blackout: z.array(z.object({
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    startTime: z.string().regex(/^\d{2}:\d{2}$/).optional(),
    endTime: z.string().regex(/^\d{2}:\d{2}$/).optional(),
    reason: z.string().optional(),
  })).default([]),
  updatedAt: z.string().default(""),
  workspaceId: z.string().optional(),
}).strict();
export type CalendarPolicy = z.infer<typeof CalendarPolicy>;

// ───────────────────────────────────────────────────────────────────────────
// Policy persistence (atomic tmp+rename, sanitize per connections/responder)
// ───────────────────────────────────────────────────────────────────────────

export const POLICY_DIR = join(DATA_DIR, "calendar-policy");
const sanitize = (c: string) => (c || "global").replace(/[^a-zA-Z0-9_-]/g, "-");
const policyFile = (channel: string) => join(POLICY_DIR, `${sanitize(channel)}.json`);

/** A safe disabled-empty policy for a channel that has no stored config yet. */
export function DEFAULT_POLICY(channel: string): CalendarPolicy {
  return {
    channel,
    cadence: {},
    bestTimes: { enabled: true, perPlatform: {} },
    blackout: [],
    updatedAt: "",
  };
}

/** Read a channel's policy. NEVER throws — missing/corrupt → DEFAULT_POLICY. */
export function loadPolicy(channel: string, ws?: string): CalendarPolicy {
  const seeded = DEFAULT_POLICY(channel);
  if (ws) seeded.workspaceId = ws;
  if (!existsSync(policyFile(channel))) return seeded;
  try {
    const parsed = CalendarPolicy.safeParse(JSON.parse(readFileSync(policyFile(channel), "utf8")));
    if (!parsed.success) return seeded;
    return { ...seeded, ...parsed.data, channel };
  } catch {
    return seeded;
  }
}

/** Persist a channel's policy (stamps updatedAt + workspaceId; validated, atomic). */
export function savePolicy(policy: CalendarPolicy, ctx?: TenantContext | string): CalendarPolicy {
  const ws = typeof ctx === "string" ? ctx : ctx?.workspaceId;
  const next = CalendarPolicy.parse({
    ...policy,
    updatedAt: nowIso(),
    ...(ws ? { workspaceId: ws } : policy.workspaceId ? { workspaceId: policy.workspaceId } : {}),
  });
  mkdirSync(POLICY_DIR, { recursive: true });
  const path = policyFile(next.channel);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(next, null, 2));
  renameSync(tmp, path);
  return next;
}

// ───────────────────────────────────────────────────────────────────────────
// Blackout check
// ───────────────────────────────────────────────────────────────────────────

/** Is `date` (and optionally `time`) blocked by any blackout window? */
export function isBlackout(policy: CalendarPolicy, date: string, time?: string): { blocked: boolean; reason?: string } {
  for (const b of policy.blackout) {
    const to = b.to || b.from;
    if (date < b.from || date > to) continue;
    // whole-day blackout when no time window is set
    if (!b.startTime && !b.endTime) return { blocked: true, reason: b.reason };
    // windowed blackout: a post with no time can't be proven inside — treat as clear
    if (!time) continue;
    const start = b.startTime || "00:00";
    const end = b.endTime || "23:59";
    if (time >= start && time <= end) return { blocked: true, reason: b.reason };
  }
  return { blocked: false };
}

// ───────────────────────────────────────────────────────────────────────────
// Cross-brand enumeration
// ───────────────────────────────────────────────────────────────────────────

type BrandMeta = { channel: string; brandName: string; accent?: string };

/** Every channel an admin oversees: built-in/effective channels ∪ registry brands. */
function allBrands(workspaceId: string): BrandMeta[] {
  const map = new Map<string, BrandMeta>();
  for (const [id, c] of Object.entries(effectiveChannels())) {
    map.set(id, { channel: id, brandName: c?.name ?? channelName(id), accent: c?.accent });
  }
  const reg = readBrandRegistry(workspaceId);
  if (reg) {
    for (const b of Object.values(reg.brands)) {
      map.set(b.id, { channel: b.id, brandName: b.name ?? channelName(b.id), accent: b.accent });
    }
  }
  return [...map.values()];
}

const approvalStatusOf = (p: PlannedPost): "pending" | "approved" | "rejected" | "none" =>
  p.approval?.status ?? "none";

const inWindow = (date: string, from?: string, to?: string) =>
  (!from || date >= from) && (!to || date <= to);

// ───────────────────────────────────────────────────────────────────────────
// Overview (cross-brand timeline + per-brand rollup)
// ───────────────────────────────────────────────────────────────────────────

export type AdminPost = PlannedPost & {
  brandName: string;
  approvalStatus: "pending" | "approved" | "rejected" | "none";
  blackout?: string;
};

export type BrandRollup = {
  channel: string;
  brandName: string;
  accent?: string;
  planned: number;
  pendingApproval: number;
  scheduled: number;
  blackoutHits: number;
  nextDate?: string;
};

export type CalendarOverview = { brands: BrandRollup[]; timeline: AdminPost[] };

export function overview(opts: { workspaceId?: string; from?: string; to?: string; includeArchived?: boolean } = {}): CalendarOverview {
  const ws = opts.workspaceId ?? DEFAULT_WORKSPACE;
  const includeArchived = opts.includeArchived ?? false;
  const brands = allBrands(ws);
  const byChannel = new Map(brands.map((b) => [b.channel, b] as const));
  const policies = new Map(brands.map((b) => [b.channel, loadPolicy(b.channel, ws)] as const));

  const posts = loadPlanFor(ws).filter((p) => {
    if (!includeArchived && p.status === "archived") return false;
    return inWindow(p.date, opts.from, opts.to);
  });

  const timeline: AdminPost[] = posts.map((p) => {
    const meta = byChannel.get(p.channel);
    const policy = policies.get(p.channel) ?? DEFAULT_POLICY(p.channel);
    const bo = isBlackout(policy, p.date, p.time);
    return {
      ...p,
      brandName: meta?.brandName ?? channelName(p.channel),
      approvalStatus: approvalStatusOf(p),
      ...(bo.blocked ? { blackout: bo.reason || "blackout" } : {}),
    };
  }).sort((a, b) => (a.date + (a.time || "")).localeCompare(b.date + (b.time || "")));

  const rollup: BrandRollup[] = brands.map((b) => {
    const mine = timeline.filter((p) => p.channel === b.channel);
    return {
      channel: b.channel,
      brandName: b.brandName,
      accent: b.accent,
      planned: mine.length,
      pendingApproval: mine.filter((p) => p.approvalStatus === "pending").length,
      scheduled: mine.filter((p) => p.status === "scheduled").length,
      blackoutHits: mine.filter((p) => p.blackout).length,
      nextDate: mine[0]?.date,
    };
  });

  return { brands: rollup, timeline };
}

// ───────────────────────────────────────────────────────────────────────────
// Conflict / slot detection (pure read)
// ───────────────────────────────────────────────────────────────────────────

export type Conflict = {
  kind: "overlap" | "overCapacity" | "collision" | "blackoutViolation";
  date: string;
  time?: string;
  channel?: string;
  postIds: string[];
  detail: string;
};

export type ConflictReport = {
  overlaps: Conflict[];
  overCapacity: Conflict[];
  collisions: Conflict[];
  blackoutViolations: Conflict[];
};

export function conflicts(opts: { workspaceId?: string; from?: string; to?: string } = {}): ConflictReport {
  const ws = opts.workspaceId ?? DEFAULT_WORKSPACE;
  const posts = loadPlanFor(ws).filter((p) => p.status !== "archived" && inWindow(p.date, opts.from, opts.to));

  const overlaps: Conflict[] = [];
  const overCapacity: Conflict[] = [];
  const collisions: Conflict[] = [];
  const blackoutViolations: Conflict[] = [];

  // overlaps: same channel+platform+date+time, >1 post
  const overlapKey = (p: PlannedPost) => `${p.channel}|${p.platform}|${p.date}|${p.time}`;
  const byOverlap = new Map<string, PlannedPost[]>();
  for (const p of posts) {
    const k = overlapKey(p);
    (byOverlap.get(k) ?? byOverlap.set(k, []).get(k)!).push(p);
  }
  for (const [, group] of byOverlap) {
    if (group.length > 1) {
      const p = group[0];
      overlaps.push({
        kind: "overlap", date: p.date, time: p.time, channel: p.channel,
        postIds: group.map((g) => g.id),
        detail: `${group.length} ${p.platform} posts on ${p.channel} at ${p.date} ${p.time}`,
      });
    }
  }

  // over-capacity: posts/day for a channel exceed policy.cadence.perDayMax
  const policies = new Map<string, CalendarPolicy>();
  const dayKey = (p: PlannedPost) => `${p.channel}|${p.date}`;
  const byDay = new Map<string, PlannedPost[]>();
  for (const p of posts) {
    const k = dayKey(p);
    (byDay.get(k) ?? byDay.set(k, []).get(k)!).push(p);
  }
  for (const [, group] of byDay) {
    const ch = group[0].channel;
    if (!policies.has(ch)) policies.set(ch, loadPolicy(ch, ws));
    const cap = policies.get(ch)!.cadence.perDayMax;
    if (cap !== undefined && group.length > cap) {
      const p = group[0];
      overCapacity.push({
        kind: "overCapacity", date: p.date, channel: ch,
        postIds: group.map((g) => g.id),
        detail: `${group.length} posts on ${ch} on ${p.date} exceeds cap of ${cap}`,
      });
    }
  }

  // collisions: same platform+date+time across DIFFERENT brands
  const collisionKey = (p: PlannedPost) => `${p.platform}|${p.date}|${p.time}`;
  const byCollision = new Map<string, PlannedPost[]>();
  for (const p of posts) {
    const k = collisionKey(p);
    (byCollision.get(k) ?? byCollision.set(k, []).get(k)!).push(p);
  }
  for (const [, group] of byCollision) {
    const channels = new Set(group.map((g) => g.channel));
    if (channels.size > 1) {
      const p = group[0];
      collisions.push({
        kind: "collision", date: p.date, time: p.time,
        postIds: group.map((g) => g.id),
        detail: `${channels.size} brands posting ${p.platform} at ${p.date} ${p.time}: ${[...channels].join(", ")}`,
      });
    }
  }

  // blackout violations: any non-archived post landing in its channel's blackout
  for (const p of posts) {
    if (!policies.has(p.channel)) policies.set(p.channel, loadPolicy(p.channel, ws));
    const bo = isBlackout(policies.get(p.channel)!, p.date, p.time);
    if (bo.blocked) {
      blackoutViolations.push({
        kind: "blackoutViolation", date: p.date, time: p.time, channel: p.channel,
        postIds: [p.id],
        detail: `${p.channel} post in blackout${bo.reason ? ` (${bo.reason})` : ""} on ${p.date}${p.time ? ` ${p.time}` : ""}`,
      });
    }
  }

  return { overlaps, overCapacity, collisions, blackoutViolations };
}

// ───────────────────────────────────────────────────────────────────────────
// Approval gate (admin sign-off) + bulk ops
// ───────────────────────────────────────────────────────────────────────────

/**
 * Admin sign-off. On approve, ALSO flip an 'idea'/'approved' status to
 * 'approved' so the post is cleared for scheduling — but NOT to 'scheduled':
 * promotion to the autopilot queue stays a separate explicit step so the gate is
 * auditable. On reject, leave status untouched. Returns the post or undefined.
 */
export function setApproval(id: string, status: "approved" | "rejected", by: string, ws = DEFAULT_WORKSPACE): PlannedPost | undefined {
  const updated = setApprovalField(id, { status, by, at: nowIso() }, ws);
  if (!updated) return undefined;
  if (status === "approved" && (updated.status === "idea" || updated.status === "approved")) {
    return updatePost(id, { status: "approved" } as Partial<PlannedPost>, ws) ?? updated;
  }
  return updated;
}

export type BulkOp = {
  ids: string[];
  op: "reschedule" | "assign" | "approve" | "reject";
  date?: string;
  time?: string;
  assignee?: string;
  by?: string;
};

export type BulkResult = { updated: string[]; skipped: { id: string; reason: string }[] };

export function bulkOp(input: BulkOp, ws = DEFAULT_WORKSPACE): BulkResult {
  const updated: string[] = [];
  const skipped: { id: string; reason: string }[] = [];
  for (const id of input.ids) {
    // cross-tenant / unknown ids skip rather than throw
    if (!getPost(id, ws)) {
      skipped.push({ id, reason: "not found in workspace" });
      continue;
    }
    let res: PlannedPost | undefined;
    switch (input.op) {
      case "reschedule":
        if (!input.date) { skipped.push({ id, reason: "reschedule needs date" }); continue; }
        res = movePost(id, input.date, input.time, ws);
        break;
      case "assign":
        if (!input.assignee) { skipped.push({ id, reason: "assign needs assignee" }); continue; }
        res = updatePost(id, { assignee: input.assignee } as Partial<PlannedPost>, ws);
        break;
      case "approve":
        res = setApproval(id, "approved", input.by || "admin", ws);
        break;
      case "reject":
        res = setApproval(id, "rejected", input.by || "admin", ws);
        break;
    }
    if (res) updated.push(id);
    else skipped.push({ id, reason: "update failed" });
  }
  return { updated, skipped };
}
