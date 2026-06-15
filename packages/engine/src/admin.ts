/* ════════════════════════════════════════════════════════════════════════
   ADMIN — the cross-brand SMM-admin control + aggregation layer.

   This module is the engine side of the Social-Media-Manager Admin cockpit. It
   does TWO things:

   1. A small per-workspace CONTROL STORE (data/admin/<workspaceId>.json): a
      workspace-wide kill-switch that HARD-halts every autonomous send/post path,
      plus per-brand admin pause flags + advisory budget caps. The hot resolver
      `isSendingHalted(channel)` is imported by the 4 autonomous send/post paths
      (comments.sendReply / dms.sendMessage / publisher.publishItem /
      autopilot.autopilot) and MUST stay cheap (one file read, no network, no
      await) and NEVER throw — a corrupt store can never block a send.

   2. Pure-synchronous AGGREGATION over the EXISTING subsystem readers (missions,
      schedule, responder, connections, comments, dms, dna). It never duplicates
      a subsystem's logic — it composes their public readers. NO LLM / Graph /
      async here, so the admin read tools stay synchronous.

   Cycle-safe: imports ONLY from leaf/subsystem modules, NEVER from registry.ts
   (mirrors the missions.ts discipline). Persistence is atomic tmp+rename under
   data/admin/ (add data/admin/ to .gitignore — operational state, no secrets).
   NEVER reads a connection token field; surfaces only the redacted ConnectionView.
   ════════════════════════════════════════════════════════════════════════ */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  AdminControl,
  type AdminControl as AdminControlT,
  type AdminBrandControl,
  DEFAULT_WORKSPACE,
} from "@os/schemas";

import { DATA_DIR, RENDERS_DIR, nowIso, listItemsFor } from "./store.ts";
import { readBrandRegistry } from "./brands-store.ts";
import { effectiveChannels, channelName } from "./channels.ts";
import { listMissions, spentTodayUsd } from "./missions.ts";
import { loadSchedule, nextDue } from "./schedule.ts";
import { loadResponderConfig } from "./responder.ts";
import { connectionStatusFor } from "./connections.ts";
import { listStoredComments, loadDrafts } from "./comments.ts";
import { findThread, listOpenThreads, loadDmDrafts, windowOpen } from "./dms.ts";
import { getGenome } from "./dna.ts";

// ───────────────────────────────────────────────────────────────────────────
// Control store — data/admin/<workspaceId>.json (flat JSON, atomic tmp+rename)
// ───────────────────────────────────────────────────────────────────────────

const ADMIN_DIR = join(DATA_DIR, "admin");
// EXACT regex copied from connections.ts/responder.ts/comments.ts sanitize.
const sanitize = (ws: string) => (ws || "global").replace(/[^a-zA-Z0-9_-]/g, "-");
const filePath = (ws: string) => join(ADMIN_DIR, `${sanitize(ws)}.json`);

function seed(ws: string): AdminControlT {
  return { workspaceId: ws, killSwitch: false, brands: {}, updatedAt: "" };
}

/** Read-or-seed the workspace control store. Never throws, never writes on read.
    Absent/corrupt → seed; partial → seed merged over the partial (mirrors
    loadResponderConfig's seed-merge). */
export function loadAdminControl(ws: string): AdminControlT {
  const s = seed(ws);
  const p = filePath(ws);
  if (!existsSync(p)) return s;
  try {
    const raw = JSON.parse(readFileSync(p, "utf8")) as Partial<AdminControlT>;
    const parsed = AdminControl.safeParse({ ...raw, workspaceId: ws });
    if (parsed.success) return parsed.data;
    // partial / older file — merge over the seed so every field resolves
    return { ...s, ...raw, workspaceId: ws, brands: raw.brands ?? {} };
  } catch {
    return s;
  }
}

/** Persist the workspace control store (stamps updatedAt, atomic). */
export function saveAdminControl(ctrl: AdminControlT): AdminControlT {
  mkdirSync(ADMIN_DIR, { recursive: true });
  const parsed = AdminControl.parse({ ...ctrl, updatedAt: nowIso() });
  const dest = filePath(parsed.workspaceId);
  const tmp = `${dest}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(parsed, null, 2));
  renameSync(tmp, dest);
  return parsed;
}

export function setKillSwitch(ws: string, on: boolean, reason?: string, by?: string): AdminControlT {
  const ctrl = loadAdminControl(ws);
  ctrl.killSwitch = on;
  if (on) {
    ctrl.killSwitchReason = reason;
    ctrl.killSwitchAt = nowIso();
    ctrl.killSwitchBy = by;
  } else {
    delete ctrl.killSwitchReason;
    delete ctrl.killSwitchAt;
    delete ctrl.killSwitchBy;
  }
  return saveAdminControl(ctrl);
}

export function setBrandPaused(ws: string, channel: string, paused: boolean): AdminControlT {
  const ctrl = loadAdminControl(ws);
  ctrl.brands[channel] = { ...ctrl.brands[channel], paused, updatedAt: nowIso() };
  return saveAdminControl(ctrl);
}

export function setBrandBudgetCap(
  ws: string,
  channel: string,
  cap: AdminBrandControl["budgetCap"],
): AdminControlT {
  const ctrl = loadAdminControl(ws);
  ctrl.brands[channel] = {
    ...(ctrl.brands[channel] ?? { paused: false }),
    budgetCap: cap,
    updatedAt: nowIso(),
  };
  return saveAdminControl(ctrl);
}

/** Which workspace owns this channel? Drives the hot-path resolver: a send for a
    channel is halted by that channel's OWNING workspace control store. Built-in
    brands (no registry) live in DEFAULT_WORKSPACE. */
export function resolveWorkspaceOfChannel(channel: string): string {
  try {
    const reg = readBrandRegistry();
    const b = reg?.brands?.[channel];
    return (b?.workspaceId as string | undefined) ?? DEFAULT_WORKSPACE;
  } catch {
    return DEFAULT_WORKSPACE;
  }
}

/* ════════════════════════════════════════════════════════════════════════
   THE HOT-PATH RESOLVER — imported by the 4 autonomous send/post paths.
   Cheap (one file read), no network, no await. Wrapped so a corrupt store
   never blocks a send (fail-open: {halted:false}).
   ════════════════════════════════════════════════════════════════════════ */
export function isSendingHalted(channel: string): { halted: boolean; reason?: string } {
  try {
    const ws = resolveWorkspaceOfChannel(channel);
    const ctrl = loadAdminControl(ws);
    if (ctrl.killSwitch) {
      return {
        halted: true,
        reason:
          ctrl.killSwitchReason ??
          "workspace kill-switch engaged — autonomous sending/posting halted",
      };
    }
    if (ctrl.brands[channel]?.paused) {
      return { halted: true, reason: `brand ${channel} paused by admin` };
    }
    return { halted: false };
  } catch {
    return { halted: false };
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Aggregation — pure synchronous composition of existing subsystem readers
// ───────────────────────────────────────────────────────────────────────────

type BrandRef = { channel: string; brandName: string; accent?: string };

/** The workspace's brands. Prefer the persisted registry; if a workspace has no
    registered brands, fall back to the built-in CHANNELS (which live in
    DEFAULT_WORKSPACE) so a built-in-only workspace still aggregates. */
function brandsOf(ws: string): BrandRef[] {
  const reg = readBrandRegistry(ws)?.brands ?? {};
  const refs = Object.values(reg).map((b) => ({
    channel: b.id,
    brandName: b.name,
    accent: b.accent,
  }));
  if (refs.length) return refs;
  if (ws !== DEFAULT_WORKSPACE) return [];
  return Object.values(effectiveChannels()).map((c) => ({
    channel: c.id,
    brandName: c.name ?? channelName(c.id),
    accent: c.accent,
  }));
}

/** Is this channel's autopilot cadence enabled in the schedule? (channel entry
    enabled AND at least one slot). The schedule is a single global store. */
function autopilotEnabled(channel: string): boolean {
  try {
    const s = loadSchedule();
    const c = s.channels.find((x) => x.channel === channel);
    return !!c && c.enabled !== false && (c.slots?.length ?? 0) > 0;
  } catch {
    return false;
  }
}

function nextDueAtFor(channel: string): string | undefined {
  try {
    const s = loadSchedule();
    // nextDue returns the soonest slot across all channels; only surface it for
    // this channel when it is the next-due one (cheap + correct, no recompute).
    const nd = nextDue(s);
    return nd && nd.slot.channel === channel ? nd.at : undefined;
  } catch {
    return undefined;
  }
}

export type BrandRollup = {
  channel: string;
  brandName: string;
  accent?: string;
  mission: {
    id: string;
    status: string;
    spentTodayUsd: number;
    usdPerDay?: number;
    postsPerDay?: number;
    updatedAt?: string;
  } | null;
  autopilot: { enabled: boolean; nextDueAt?: string };
  responder: { enabled: boolean; defaultAction: string };
  connection: {
    status: string;
    tokenPreview?: string;
    expiresInDays?: number;
    needsRefresh?: boolean;
    subscribed?: boolean;
  } | null;
  inbox: {
    unansweredComments: number;
    unansweredDms: number;
    pendingCommentDrafts: number;
    pendingDmDrafts: number;
  };
  adminPaused: boolean;
  budgetCap?: AdminBrandControl["budgetCap"];
  lastActivityAt?: string;
};

/** First active mission for a channel (active before paused before done). */
function missionFor(ws: string, channel: string) {
  const all = listMissions({ workspaceId: ws }).filter((m) => m.channel === channel);
  if (!all.length) return null;
  const rank = (s: string) => (s === "active" ? 0 : s === "paused" ? 1 : 2);
  all.sort((a, b) => rank(a.status) - rank(b.status));
  return all[0];
}

export function adminOverview(ws: string): BrandRollup[] {
  const ctrl = loadAdminControl(ws);
  const rollups: BrandRollup[] = [];
  for (const b of brandsOf(ws)) {
    const ch = b.channel;
    const m = missionFor(ws, ch);
    const responder = loadResponderConfig(ch);
    const conn = connectionStatusFor(ch); // token-FREE ConnectionView | null
    const comments = listStoredComments(ch, { unansweredOnly: true });
    const dmDrafts = loadDmDrafts(ch);
    const commentDrafts = loadDrafts(ch);
    const openThreads = listOpenThreads(ch);

    const lastActivity = [m?.updatedAt, conn?.connectedAt]
      .filter((x): x is string => !!x)
      .sort()
      .pop();

    rollups.push({
      channel: ch,
      brandName: b.brandName,
      accent: b.accent,
      mission: m
        ? {
            id: m.id,
            status: m.status,
            spentTodayUsd: spentTodayUsd(m),
            usdPerDay: m.budget?.usdPerDay,
            postsPerDay: m.budget?.postsPerDay,
            updatedAt: m.updatedAt,
          }
        : null,
      autopilot: { enabled: autopilotEnabled(ch), nextDueAt: nextDueAtFor(ch) },
      responder: { enabled: responder.enabled, defaultAction: responder.defaultAction },
      connection: conn
        ? {
            status: conn.status,
            tokenPreview: conn.tokenPreview,
            expiresInDays: conn.expiresInDays,
            needsRefresh: conn.needsRefresh,
            subscribed: conn.subscribed,
          }
        : null,
      inbox: {
        unansweredComments: comments.length,
        unansweredDms: openThreads.length,
        pendingCommentDrafts: commentDrafts.filter((d) => d.status === "pending").length,
        pendingDmDrafts: dmDrafts.filter((d) => d.status === "pending").length,
      },
      adminPaused: ctrl.brands[ch]?.paused ?? false,
      budgetCap: ctrl.brands[ch]?.budgetCap,
      lastActivityAt: lastActivity,
    });
  }
  return rollups;
}

// ─── Approvals hub — every human-gated queue across the workspace ────────────

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

export type GatedPublish = {
  id: string;
  title: string;
  channel: string;
  createdAt: string;
  waiting: { platform: string; status: string }[];
};

export type CommentDraftApproval = {
  channel: string;
  brandName: string;
  commentId: string;
  username?: string;
  inReplyTo: string;
  reply: string;
  draftedAt: string;
};

export type DmDraftApproval = {
  channel: string;
  brandName: string;
  conversationId: string;
  inReplyTo: string;
  reply: string;
  draftedAt: string;
  windowOpen: boolean;
};

export type ResponderGoingLive = {
  channel: string;
  brandName: string;
  defaultAction: string;
  autoSendRules: number;
};

export type AdminApprovals = {
  dnaMutations: DnaApproval[];
  gatedPublishes: GatedPublish[];
  commentDrafts: CommentDraftApproval[];
  dmDrafts: DmDraftApproval[];
  responderGoingLive: ResponderGoingLive[];
};

const GATE_WAITING = new Set(["ready", "draft", "private"]);

/** Engine-side mirror of dashboard isVerified: a render file must exist. Kept in
    sync with store.ts RENDERS_DIR + ContentItem.videoPath. */
function isVerifiedItem(it: { id: string; videoPath?: string }): boolean {
  if (it.videoPath && existsSync(it.videoPath)) return true;
  for (const c of [
    join(RENDERS_DIR, `${it.id}.mp4`),
    join(RENDERS_DIR, "Beta", `${it.id}.mp4`),
  ]) {
    if (existsSync(c)) return true;
  }
  return false;
}

export function adminApprovals(ws: string, limit = 12): AdminApprovals {
  const brands = brandsOf(ws);
  const byChannel = new Map(brands.map((b) => [b.channel, b]));

  // 1. DNA mutations — read the genome store per brand, newest-first.
  const dnaMutations: DnaApproval[] = [];
  for (const b of brands) {
    let g;
    try {
      g = getGenome(b.channel);
    } catch {
      continue;
    }
    for (const p of g.pending ?? []) {
      dnaMutations.push({
        id: p.id,
        proposedAt: p.proposedAt,
        path: p.path,
        mutation: p.mutation,
        rationale: p.rationale,
        confidence: p.confidence,
        channel: b.channel,
        brandName: b.brandName,
        accent: b.accent,
      });
    }
  }
  dnaMutations.sort((a, b) => b.proposedAt.localeCompare(a.proposedAt));

  // 2. Gated publishes — cheap publish-ledger gate FIRST, then the disk stat.
  const gatedPublishes: GatedPublish[] = [];
  for (const it of listItemsFor(ws)) {
    const eff = new Map<string, string>();
    for (const e of it.publish ?? []) eff.set(e.platform, e.status);
    if (!eff.size) continue;
    if ([...eff.values()].some((s) => s === "published")) continue;
    const waiting = [...eff.entries()]
      .filter(([, s]) => GATE_WAITING.has(s))
      .map(([platform, status]) => ({ platform, status }));
    if (!waiting.length) continue;
    if (!isVerifiedItem(it)) continue;
    gatedPublishes.push({
      id: it.id,
      title: it.pkg?.title ?? it.idea?.topic ?? it.storyboard?.topic ?? it.seedIdea,
      channel: it.channel,
      createdAt: it.createdAt,
      waiting,
    });
    if (gatedPublishes.length >= limit) break;
  }

  // 3. Pending comment/DM reply drafts awaiting a human send.
  const commentDrafts: CommentDraftApproval[] = [];
  const dmDrafts: DmDraftApproval[] = [];
  const responderGoingLive: ResponderGoingLive[] = [];
  for (const b of brands) {
    for (const d of loadDrafts(b.channel)) {
      if (d.status !== "pending") continue;
      commentDrafts.push({
        channel: b.channel,
        brandName: b.brandName,
        commentId: d.commentId,
        username: d.username,
        inReplyTo: d.inReplyTo,
        reply: d.reply,
        draftedAt: d.draftedAt,
      });
    }
    for (const d of loadDmDrafts(b.channel)) {
      if (d.status !== "pending") continue;
      let open = true;
      try {
        open = windowOpen(findThread(b.channel, d.conversationId)).open;
      } catch {
        /* fail-open on the advisory window flag */
      }
      dmDrafts.push({
        channel: b.channel,
        brandName: b.brandName,
        conversationId: d.conversationId,
        inReplyTo: d.inReplyTo,
        reply: d.reply,
        draftedAt: d.draftedAt,
        windowOpen: open,
      });
    }
    // 4. Responder "going live" — enabled + auto_send default + ≥1 enabled
    //    auto_send rule (i.e. this brand will send replies without a human).
    const cfg = loadResponderConfig(b.channel);
    const autoSendRules = cfg.rules.filter((r) => r.enabled && r.action === "auto_send").length;
    if (cfg.enabled && cfg.defaultAction === "auto_send" && autoSendRules >= 1) {
      responderGoingLive.push({
        channel: b.channel,
        brandName: b.brandName,
        defaultAction: cfg.defaultAction,
        autoSendRules,
      });
    }
  }
  commentDrafts.sort((a, b) => b.draftedAt.localeCompare(a.draftedAt));
  dmDrafts.sort((a, b) => b.draftedAt.localeCompare(a.draftedAt));
  void byChannel;

  return { dnaMutations, gatedPublishes, commentDrafts, dmDrafts, responderGoingLive };
}

// ─── Health / alerts ─────────────────────────────────────────────────────────

export type HealthAlert = {
  severity: "info" | "warn" | "error";
  kind: string;
  channel: string;
  brandName: string;
  message: string;
  detail?: string;
};

export function adminHealth(ws: string): HealthAlert[] {
  const alerts: HealthAlert[] = [];
  for (const b of brandsOf(ws)) {
    const ch = b.channel;
    const m = missionFor(ws, ch);
    const conn = connectionStatusFor(ch);

    // Token expiring soon / connection unhealthy.
    if (conn) {
      if (conn.needsRefresh || (typeof conn.expiresInDays === "number" && conn.expiresInDays < 7)) {
        alerts.push({
          severity: "warn",
          kind: "token_expiring",
          channel: ch,
          brandName: b.brandName,
          message: `Instagram token for ${b.brandName} expires soon`,
          detail:
            typeof conn.expiresInDays === "number"
              ? `~${conn.expiresInDays}d left — reconnect to refresh`
              : "needs refresh",
        });
      }
      if (conn.status !== "connected" && m && m.status === "active") {
        alerts.push({
          severity: "error",
          kind: "disconnected",
          channel: ch,
          brandName: b.brandName,
          message: `${b.brandName} account is ${conn.status} but an autonomous mission is active`,
        });
      }
    } else if (m && m.status === "active") {
      alerts.push({
        severity: "error",
        kind: "disconnected",
        channel: ch,
        brandName: b.brandName,
        message: `${b.brandName} has an active mission but no connected account`,
      });
    }

    // DM 24h window closed with a pending reply queued (can't be sent).
    try {
      const dmDrafts = loadDmDrafts(ch).filter((d) => d.status === "pending");
      for (const d of dmDrafts) {
        // A pending draft drops the thread from listOpenThreads, so resolve it
        // directly by conversation id and derive the 24h window from it.
        const thread = findThread(ch, d.conversationId);
        const w = windowOpen(thread);
        if (thread && !w.open) {
          alerts.push({
            severity: "warn",
            kind: "dm_window_closed",
            channel: ch,
            brandName: b.brandName,
            message: `A drafted DM reply for ${b.brandName} can't be sent — 24h window closed`,
            detail: w.hours ? `last inbound ~${w.hours}h ago` : undefined,
          });
        }
      }
    } catch {
      /* ignore inbox read errors in health */
    }

    // Mission over budget / last task failed.
    if (m) {
      const cap = m.budget?.usdPerDay;
      if (typeof cap === "number" && cap > 0 && spentTodayUsd(m) >= cap) {
        alerts.push({
          severity: "warn",
          kind: "over_budget",
          channel: ch,
          brandName: b.brandName,
          message: `${b.brandName} mission hit its daily budget cap`,
          detail: `$${spentTodayUsd(m).toFixed(2)} / $${cap.toFixed(2)}`,
        });
      }
      const lastTask = m.queue?.[m.queue.length - 1];
      if (lastTask?.status === "failed") {
        alerts.push({
          severity: "error",
          kind: "mission_failed",
          channel: ch,
          brandName: b.brandName,
          message: `${b.brandName} mission's last task failed`,
          detail: lastTask.resultSummary,
        });
      }
    }
  }
  return alerts;
}

/* listChannelsForWorkspace — handy for callers that need to fan a control op
   across every brand in a workspace (admin_pause/resume with no channel). */
export function channelsForWorkspace(ws: string): string[] {
  return brandsOf(ws).map((b) => b.channel);
}
