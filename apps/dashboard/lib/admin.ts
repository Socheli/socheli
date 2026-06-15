import "server-only";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { AdminControl } from "@os/schemas";
import type { AdminControl as AdminControlT } from "@os/schemas";
import { REPO_ROOT } from "./data";
import { listBrands } from "./brands";
import { listMissionsFor, spentTodayUsd } from "./missions";
import { connectionFor } from "./connections";
import { responderConfigFor } from "./responder";
import { commentsFor, dmsFor } from "./inbox";
import { pendingMutationsFor, gatedPublishesFor } from "./approvals";
import { loadSchedule } from "./schedule";

/* The dashboard's READ + control layer for the cross-brand SMM Admin cockpit
   (/admin). This lib AGGREGATES the existing per-feature dashboard libs into the
   admin rollup shapes — it never re-implements their logic and never spawns the
   engine for a read. Every MUTATION (kill-switch, pause, budget cap) goes through
   the engine via the canonical tool runner (runAdminTool), exactly like
   lib/missions.ts runMissionTool, so the engine keeps every invariant + the hard
   send-halt enforcement lives in one place.

   SECURITY: this lib NEVER reads, returns, or logs a connection token. The only
   connection data it touches is the already-redacted ConnectionStatus from
   lib/connections.ts (status / tokenPreview-equivalent / expiry / needsReauth). */

/* ── Admin control store mirror-read ────────────────────────────────────────
   data/admin/<workspaceId>.json is owned solely by the engine (admin.ts). The
   dashboard reads it directly (validated against the shared AdminControl schema,
   the lib/missions.ts pattern) for the cockpit's kill-switch + per-brand pause +
   budget-cap state. Absent file → safe default (nothing halted). Carries no
   secrets. */

const ADMIN_DIR = join(REPO_ROOT, "data", "admin");
const safeWs = (workspaceId: string) => workspaceId.replace(/[^a-zA-Z0-9_-]/g, "_");
const adminFile = (workspaceId: string) => join(ADMIN_DIR, `${safeWs(workspaceId)}.json`);

export type AdminState = AdminControlT;

export function adminStateFor(workspaceId: string): AdminState {
  const file = adminFile(workspaceId);
  if (!existsSync(file)) {
    return { workspaceId, killSwitch: false, brands: {}, updatedAt: "" };
  }
  try {
    const parsed = AdminControl.safeParse(JSON.parse(readFileSync(file, "utf8")));
    if (parsed.success) return parsed.data;
  } catch {
    /* fall through to default */
  }
  return { workspaceId, killSwitch: false, brands: {}, updatedAt: "" };
}

/* ── Per-brand state rollup ──────────────────────────────────────────────────
   One BrandRollup per workspace brand: the cross-cutting snapshot an admin needs
   to triage a fleet at a glance. Pure reads — composes the existing libs. */

export type BrandAlert = { level: "warn" | "error"; kind: string; text: string };

export type BrandRollup = {
  channel: string;
  name: string;
  accent?: string;
  logo?: string;
  /* admin control state for this brand (from the admin store) */
  adminPaused: boolean;
  budgetCap?: { usdPerDay?: number; postsPerDay?: number };
  /* mission rollup */
  mission: {
    id?: string;
    status?: "active" | "paused" | "done";
    count: number;
    activeCount: number;
    spentToday: number;
    usdPerDay?: number;
    postsPerDay?: number;
    queued: number;
    running: number;
    updatedAt?: string;
  };
  /* connection (token-free) */
  connection: {
    connected: boolean;
    status?: string;
    username?: string;
    webhookSubscribed: boolean;
    tokenExpiresAt?: string;
    expiresInDays?: number;
    needsReauth: boolean;
    lastError?: string;
  };
  /* responder config */
  responder: {
    enabled: boolean;
    defaultAction: string;
    rules: number;
    respectDmWindow: boolean;
  };
  /* inbox backlog */
  inbox: {
    commentsTriage: number;
    commentsPending: number;
    dmsTriage: number;
    dmsPending: number;
    dmsWindowClosing: number; // open DMs whose 24h window is nearly/fully past
  };
  /* autopilot for this brand (from the workspace schedule) */
  autopilot: {
    enabled: boolean; // schedule enabled AND this channel's cadence enabled
    slots: number;
  };
  alerts: BrandAlert[];
};

/* Whole-number days until a token expires, from an ISO timestamp. */
function daysUntil(iso?: string): number | undefined {
  if (!iso) return undefined;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return undefined;
  return Math.floor((t - Date.now()) / 86_400_000);
}

export function buildBrandRollups(workspaceId: string): BrandRollup[] {
  const admin = adminStateFor(workspaceId);
  const schedule = loadSchedule(workspaceId);
  const missions = listMissionsFor(workspaceId);
  const out: BrandRollup[] = [];

  for (const b of listBrands(workspaceId)) {
    const ctrl = admin.brands?.[b.id];
    const brandMissions = missions.filter((m) => m.channel === b.id);
    const primary =
      brandMissions.find((m) => m.status === "active") ?? brandMissions[0];

    const spentToday = brandMissions.reduce((s, m) => s + spentTodayUsd(m), 0);
    const queued = brandMissions.reduce(
      (s, m) => s + m.queue.filter((t) => t.status === "queued").length,
      0,
    );
    const running = brandMissions.reduce(
      (s, m) => s + m.queue.filter((t) => t.status === "running").length,
      0,
    );

    const conn = connectionFor(b.id);
    const resp = responderConfigFor(b.id);
    const comments = commentsFor(b.id);
    const dms = dmsFor(b.id);
    const dmsWindowClosing = dms.triage.filter(
      (d) => !d.windowOpen || (d.hoursSinceInbound ?? 0) >= 20,
    ).length;

    const cadence = schedule.channels.find((c) => c.channel === b.id);
    const autopilotEnabled = !!schedule.enabled && !!cadence?.enabled;
    const slots = cadence?.slots.length ?? 0;

    const expiresInDays = daysUntil(conn.tokenExpiresAt);

    const alerts: BrandAlert[] = [];
    if (conn.connected && conn.needsReauth)
      alerts.push({ level: "error", kind: "connection", text: "Account needs reauth" });
    if (!conn.connected && (resp.enabled || autopilotEnabled))
      alerts.push({ level: "error", kind: "connection", text: "Disconnected while autonomous" });
    if (typeof expiresInDays === "number" && expiresInDays <= 7 && expiresInDays >= 0)
      alerts.push({ level: "warn", kind: "token", text: `Token expires in ${expiresInDays}d` });
    if (typeof expiresInDays === "number" && expiresInDays < 0)
      alerts.push({ level: "error", kind: "token", text: "Token expired" });
    if (dmsWindowClosing > 0)
      alerts.push({ level: "warn", kind: "dm_window", text: `${dmsWindowClosing} DM window(s) closing` });
    if (conn.lastError)
      alerts.push({ level: "warn", kind: "connection", text: conn.lastError });
    const cap = ctrl?.budgetCap;
    if (cap?.usdPerDay && spentToday > cap.usdPerDay)
      alerts.push({ level: "error", kind: "budget", text: "Over budget cap today" });
    for (const m of brandMissions) {
      if (m.budget?.usdPerDay && spentTodayUsd(m) > m.budget.usdPerDay)
        alerts.push({ level: "error", kind: "budget", text: "Mission over its USD/day budget" });
    }

    out.push({
      channel: b.id,
      name: b.name,
      accent: b.accent,
      logo: b.logo,
      adminPaused: !!ctrl?.paused,
      budgetCap: ctrl?.budgetCap,
      mission: {
        id: primary?.id,
        status: primary?.status,
        count: brandMissions.length,
        activeCount: brandMissions.filter((m) => m.status === "active").length,
        spentToday,
        usdPerDay: primary?.budget?.usdPerDay,
        postsPerDay: primary?.budget?.postsPerDay,
        queued,
        running,
        updatedAt: primary?.updatedAt,
      },
      connection: {
        connected: conn.connected,
        status: conn.status,
        username: conn.username,
        webhookSubscribed: conn.webhookSubscribed,
        tokenExpiresAt: conn.tokenExpiresAt,
        expiresInDays,
        needsReauth: conn.needsReauth,
        lastError: conn.lastError,
      },
      responder: {
        enabled: resp.enabled,
        defaultAction: resp.defaultAction,
        rules: resp.rules.length,
        respectDmWindow: resp.respectDmWindow,
      },
      inbox: {
        commentsTriage: comments.triage.length,
        commentsPending: comments.pending.length,
        dmsTriage: dms.triage.length,
        dmsPending: dms.pending.length,
        dmsWindowClosing,
      },
      autopilot: { enabled: autopilotEnabled, slots },
      alerts,
    });
  }

  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/* ── Unified approvals hub ───────────────────────────────────────────────────
   The single "everything awaiting a human" feed: the existing approvals.ts feeds
   (DNA mutations + gated publishes — already dir-mtime cached + workspace scoped)
   FOLDED TOGETHER with the per-brand inbox pending drafts (comment/DM replies
   awaiting send) and "responder going live" candidates (enabled + auto_send).

   PERF NOTE: the comment / DM / responder reads are NOT dir-mtime cached the way
   approvals.ts is, so this scans every brand's stores per call. Keep the admin
   board poll at ~10s (AdminCockpit) — the heavier-but-still-cheap-enough cadence
   the orchestrator brief specifies. (A future optimisation could mirror the
   approvals.ts dirStamp cache over data/comments, data/dms, data/responder.) */

export type UnifiedApproval =
  | {
      kind: "dna";
      id: string;
      channel: string;
      brandName: string;
      title: string;
      detail: string;
      at: string;
      confidence?: number;
      accent?: string;
    }
  | {
      kind: "publish";
      id: string;
      channel: string;
      brandName: string;
      title: string;
      detail: string;
      at: string;
      waiting: { platform: string; status: string }[];
      accent?: string;
    }
  | {
      kind: "comment";
      id: string; // comment id
      channel: string;
      brandName: string;
      title: string; // the original comment text (clipped)
      detail: string; // the drafted reply
      at: string;
      username?: string;
      permalink?: string;
      accent?: string;
    }
  | {
      kind: "dm";
      id: string; // conversationId
      channel: string;
      brandName: string;
      title: string; // last inbound message (clipped)
      detail: string; // the drafted reply
      at: string;
      username?: string;
      windowOpen?: boolean;
      accent?: string;
    }
  | {
      kind: "responder";
      id: string; // channel (the config "going live" is per-brand)
      channel: string;
      brandName: string;
      title: string;
      detail: string;
      at: string;
      accent?: string;
    };

const clip = (s: string, n = 160) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export function unifiedApprovalsFor(workspaceId: string): UnifiedApproval[] {
  const brands = listBrands(workspaceId);
  const accentOf = new Map(brands.map((b) => [b.id, b.accent]));
  const nameOf = new Map(brands.map((b) => [b.id, b.name]));
  const rows: UnifiedApproval[] = [];

  // 1 + 2: DNA mutations + gated publishes (already cached + scoped).
  for (const p of pendingMutationsFor(workspaceId)) {
    rows.push({
      kind: "dna",
      id: p.id,
      channel: p.channel,
      brandName: p.brandName,
      title: p.mutation,
      detail: p.rationale,
      at: p.proposedAt,
      confidence: p.confidence,
      accent: p.accent,
    });
  }
  for (const g of gatedPublishesFor(workspaceId)) {
    rows.push({
      kind: "publish",
      id: g.id,
      channel: g.channel,
      brandName: nameOf.get(g.channel) ?? g.channel,
      title: g.title,
      detail: g.waiting.map((w) => `${w.platform}·${w.status}`).join(", "),
      at: g.createdAt,
      waiting: g.waiting,
      accent: accentOf.get(g.channel),
    });
  }

  // 3: per-brand inbox pending drafts (comment + DM replies awaiting send) and
  // 4: responder "going live" candidates.
  for (const b of brands) {
    const comments = commentsFor(b.id);
    for (const c of comments.pending) {
      rows.push({
        kind: "comment",
        id: c.id,
        channel: b.id,
        brandName: b.name,
        title: clip(c.text),
        detail: clip(c.draft ?? ""),
        at: "",
        username: c.username,
        permalink: c.permalink,
        accent: b.accent,
      });
    }
    const dms = dmsFor(b.id);
    for (const d of dms.pending) {
      rows.push({
        kind: "dm",
        id: d.conversationId,
        channel: b.id,
        brandName: b.name,
        title: clip(d.lastMessage),
        detail: clip(d.draft ?? ""),
        at: "",
        username: d.username,
        windowOpen: d.windowOpen,
        accent: b.accent,
      });
    }
    const resp = responderConfigFor(b.id);
    if (resp.enabled && resp.defaultAction === "auto_send") {
      rows.push({
        kind: "responder",
        id: b.id,
        channel: b.id,
        brandName: b.name,
        title: "Auto-responder is live",
        detail: `Replies auto-send (${resp.rules.length} rule${resp.rules.length === 1 ? "" : "s"}). Confirm this is intended.`,
        at: "",
        accent: b.accent,
      });
    }
  }

  // Newest-first where we have a timestamp; un-timestamped (inbox/responder) sink
  // to the bottom but stay grouped.
  return rows.sort((a, b) => (b.at || "").localeCompare(a.at || ""));
}

/* ── Workspace-level health / alerts roll-up (derived, no engine spawn) ──────
   A flat list the cockpit's HEALTH tab renders. Mirrors the per-brand alerts plus
   the workspace kill-switch state. The engine's admin_health tool exists for the
   CLI/copilot; the page can use either — this lib-side derivation keeps the page
   spawn-free for the common read. */

export type WorkspaceAlert = BrandAlert & { channel?: string; brandName?: string };

export function healthAlertsFor(workspaceId: string, rollups?: BrandRollup[]): WorkspaceAlert[] {
  const rows = rollups ?? buildBrandRollups(workspaceId);
  const admin = adminStateFor(workspaceId);
  const out: WorkspaceAlert[] = [];
  if (admin.killSwitch)
    out.push({ level: "error", kind: "killswitch", text: "Kill-switch ENGAGED — all autonomous sending/posting halted" });
  for (const r of rows) {
    for (const a of r.alerts) out.push({ ...a, channel: r.channel, brandName: r.name });
  }
  const order = { error: 0, warn: 1 } as const;
  return out.sort((a, b) => order[a.level] - order[b.level]);
}

/* ── Engine bridge for admin control mutations ──────────────────────────────
   Spawn the canonical tool runner — EXACTLY mirrors lib/missions.ts
   runMissionTool. The engine's admin tools are the sole writers of the admin
   store and the only place the hard send-halt is enforced; the dashboard never
   bundles the engine. */

export type ToolResult = { ok: boolean; data?: Record<string, unknown>; message?: string };

const ADMIN_TOOLS = new Set([
  "admin_overview",
  "admin_approvals",
  "admin_health",
  "admin_pause",
  "admin_resume",
  "admin_kill_switch",
  "admin_set_budget_cap",
]);

export function runAdminTool(name: string, input: Record<string, unknown>): Promise<ToolResult> {
  if (!ADMIN_TOOLS.has(name)) {
    return Promise.resolve({ ok: false, message: `not an admin tool: ${name}` });
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
