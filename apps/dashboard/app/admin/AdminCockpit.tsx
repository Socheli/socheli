"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  AlertTriangle, Check, Dna, Inbox, MessageSquare, Pause, Play, Power, Send,
  ShieldAlert, ShieldCheck, Users, X, Zap,
} from "lucide-react";
import { channelName } from "../ui";
import { confirmDialog } from "../confirm";

/* The SMM Admin cockpit. Five tabs over one workspace:
     STATE  — one row per brand: mission / autopilot / responder / connection
              status badges, spend-vs-budget, inbox backlog, alerts, per-row
              admin pause + responder-off controls.
     APPROVALS — the unified human-gate hub: DNA mutations, gated publishes,
              comment/DM reply drafts, "responder going live". Each row's
              approve/reject hits the EXISTING route for that feed (NOT /api/admin).
     TEAM   — which member owns each brand (read-only rollup here).
     HEALTH — flat alerts list (token expiry, closed DM windows, over-budget,
              disconnected accounts, kill-switch).
     AUDIT  — the workspace audit feed.

   Global controls bar: kill-switch (hard-halt all autonomous sending/posting)
   and pause-all. Server data stays live via router.refresh polling (~10s, the
   MissionsBoard/InboxBoard convention) — paused while the tab is hidden. Every
   destructive action goes through confirmDialog; schedule.manage controls are
   hidden/disabled when !canManage (the API re-checks regardless). */

type BrandAlert = { level: "warn" | "error"; kind: string; text: string };

export type BrandRollupView = {
  channel: string;
  name: string;
  accent?: string;
  logo?: string;
  adminPaused: boolean;
  budgetCap?: { usdPerDay?: number; postsPerDay?: number };
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
  responder: { enabled: boolean; defaultAction: string; rules: number; respectDmWindow: boolean };
  inbox: { commentsTriage: number; commentsPending: number; dmsTriage: number; dmsPending: number; dmsWindowClosing: number };
  autopilot: { enabled: boolean; slots: number };
  alerts: BrandAlert[];
};

export type UnifiedApprovalView = {
  kind: "dna" | "publish" | "comment" | "dm" | "responder";
  id: string;
  channel: string;
  brandName: string;
  title: string;
  detail: string;
  at: string;
  confidence?: number;
  waiting?: { platform: string; status: string }[];
  username?: string;
  permalink?: string;
  windowOpen?: boolean;
  accent?: string;
};

type WorkspaceAlertView = BrandAlert & { channel?: string; brandName?: string };
type TeamView = { channel: string; name: string; accent?: string; owners: { userId: string; name: string }[] };
type MemberView = { userId: string; name: string; role: string };
type AuditView = { at: string; action: string; target?: string; userId: string | null };

const fmtUsd = (n: number) => `$${n.toFixed(n < 10 ? 3 : 2)}`;
const ago = (ts?: string) => {
  if (!ts) return "—";
  const s = Math.max(0, Math.round((Date.now() - new Date(ts).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
};
const logoSrc = (logo?: string) =>
  !logo ? undefined : /^(https?:)?\/\//.test(logo) || logo.startsWith("/") ? logo : `/rem/${logo}`;

type Tab = "state" | "approvals" | "team" | "health" | "audit";

export function AdminCockpit({
  rollups, approvals, adminState, alerts, team, members, audit,
  canManage, canApproveDna, canPublish, canSend, canReassign, canViewAudit,
}: {
  rollups: BrandRollupView[];
  approvals: UnifiedApprovalView[];
  adminState: { killSwitch: boolean; killSwitchReason?: string };
  alerts: WorkspaceAlertView[];
  team: TeamView[];
  members: MemberView[];
  audit: AuditView[];
  canManage: boolean;
  canApproveDna: boolean;
  canPublish: boolean;
  canSend: boolean;
  canReassign: boolean;
  canViewAudit: boolean;
}) {
  const router = useRouter();
  const [tab, setTab] = useState<Tab>("state");
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  // Live polling, paused while hidden — ~10s (the comment/dm/responder reads
  // behind the approvals hub are not dir-mtime cached, so don't poll faster).
  useEffect(() => {
    const t = window.setInterval(() => {
      if (document.visibilityState === "visible") router.refresh();
    }, 10_000);
    return () => window.clearInterval(t);
  }, [router]);

  const flash = (kind: "ok" | "error", text: string) => {
    setNotice({ kind, text });
    window.setTimeout(() => setNotice((n) => (n?.text === text ? null : n)), 6000);
  };

  const act = async (key: string, run: () => Promise<Response>, okMsg: string) => {
    setBusy(key);
    try {
      const res = await run();
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
      flash("ok", okMsg);
      router.refresh();
    } catch (e) {
      flash("error", e instanceof Error ? e.message : "action failed");
    } finally {
      setBusy("");
    }
  };

  const postAdmin = (body: Record<string, unknown>) =>
    fetch("/api/admin", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

  /* ── global controls ── */
  const toggleKill = async () => {
    const turningOn = !adminState.killSwitch;
    if (turningOn) {
      const ok = await confirmDialog({
        title: "Engage workspace kill-switch?",
        message: "HARD-HALTS all autonomous sending and posting across every brand — missions, autopilot, the responder, and any comment/DM send. Prepared work waits; nothing goes live until you disengage.",
        confirmText: "Engage kill-switch",
        danger: true,
      });
      if (!ok) return;
    }
    act("kill", () => postAdmin({ action: "killswitch", on: turningOn }),
      turningOn ? "Kill-switch ENGAGED — autonomous sending halted." : "Kill-switch released.");
  };

  const pauseAll = async () => {
    const ok = await confirmDialog({
      title: "Pause all brands?",
      message: "Admin-pauses every brand — halts missions, autopilot, responder and sends workspace-wide. Reversible.",
      confirmText: "Pause all",
      danger: true,
    });
    if (!ok) return;
    act("pauseall", () => postAdmin({ action: "pause_all" }), "All brands paused.");
  };
  const resumeAll = () =>
    act("resumeall", () => postAdmin({ action: "resume_all" }), "All brands resumed.");

  /* ── per-brand controls ── */
  const pauseBrand = (r: BrandRollupView) =>
    act(`pause:${r.channel}`, () => postAdmin({ action: r.adminPaused ? "resume" : "pause", channel: r.channel }),
      r.adminPaused ? `${r.name} resumed.` : `${r.name} paused.`);

  const responderOff = async (r: BrandRollupView) => {
    const ok = await confirmDialog({
      title: `Disable ${r.name}'s auto-responder?`,
      message: "Stops the brand from auto-sending replies. Drafts can still be prepared and sent by hand.",
      confirmText: "Disable responder",
      danger: true,
    });
    if (!ok) return;
    act(`resp:${r.channel}`, () => postAdmin({ action: "responder_off", channel: r.channel }),
      `${r.name}'s responder disabled.`);
  };

  /* ── unified approvals — each feed hits its OWN existing route ── */
  const approveDna = (a: UnifiedApprovalView) =>
    act(`a:${a.id}`, () =>
      fetch("/api/dna/mutations", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channel: a.channel, id: a.id, action: "approve" }),
      }), `Mutation applied to ${a.brandName}.`);
  const rejectDna = async (a: UnifiedApprovalView) => {
    if (!(await confirmDialog({ title: "Reject this mutation?", message: a.title, confirmText: "Reject", danger: true }))) return;
    act(`a:${a.id}`, () =>
      fetch("/api/dna/mutations", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channel: a.channel, id: a.id, action: "reject" }),
      }), "Mutation rejected.");
  };
  const approvePublish = async (a: UnifiedApprovalView) => {
    if (!(await confirmDialog({
      title: `Publish "${a.title}"?`,
      message: "Goes live (public) on every configured platform.",
      confirmText: "Approve & publish",
    }))) return;
    act(`a:${a.id}`, () =>
      fetch("/api/publish", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: a.id, public: true }),
      }), "Publish started.");
  };
  const sendComment = async (a: UnifiedApprovalView) => {
    if (!(await confirmDialog({ title: "Send this reply?", message: a.detail, confirmText: "Send reply" }))) return;
    act(`a:${a.id}`, () =>
      fetch("/api/inbox", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "comment_send", channel: a.channel, commentId: a.id }),
      }), "Reply sent.");
  };
  const sendDm = async (a: UnifiedApprovalView) => {
    if (!(await confirmDialog({ title: "Send this DM?", message: a.detail, confirmText: "Send DM" }))) return;
    act(`a:${a.id}`, () =>
      fetch("/api/inbox", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "dm_send", channel: a.channel, conversationId: a.id }),
      }), "DM sent.");
  };

  const counts = useMemo(() => {
    const c: Record<string, number> = { dna: 0, publish: 0, comment: 0, dm: 0, responder: 0 };
    for (const a of approvals) c[a.kind] = (c[a.kind] ?? 0) + 1;
    return c;
  }, [approvals]);

  const errCount = alerts.filter((a) => a.level === "error").length;
  const warnCount = alerts.filter((a) => a.level === "warn").length;

  const TABS: { id: Tab; label: string; badge?: number; badgeErr?: boolean }[] = [
    { id: "state", label: "State grid" },
    { id: "approvals", label: "Approvals", badge: approvals.length },
    { id: "team", label: "Team" },
    { id: "health", label: "Health", badge: errCount + warnCount, badgeErr: errCount > 0 },
    ...(canViewAudit ? [{ id: "audit" as Tab, label: "Audit" }] : []),
  ];

  return (
    <>
      {notice && (
        <div className="card" style={{ marginBottom: 14, padding: "10px 16px", borderColor: notice.kind === "ok" ? "var(--success, #5fd97a)" : "var(--error, #ef5350)" }}>
          <span style={{ fontSize: 12.5, color: notice.kind === "ok" ? "var(--success, #5fd97a)" : "var(--error, #ef5350)" }}>{notice.text}</span>
        </div>
      )}

      {/* GLOBAL CONTROLS BAR */}
      <div className="card" style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", marginBottom: 16, borderColor: adminState.killSwitch ? "var(--error, #ef5350)" : undefined }}>
        {adminState.killSwitch ? <ShieldAlert size={18} style={{ color: "var(--error, #ef5350)" }} /> : <ShieldCheck size={18} style={{ color: "var(--accent)" }} />}
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 13.5, fontWeight: 600, color: "var(--text-light)" }}>
            {adminState.killSwitch ? "Kill-switch ENGAGED" : "Autonomous ops live"}
          </div>
          <div className="sub" style={{ fontSize: 11.5 }}>
            {adminState.killSwitch
              ? (adminState.killSwitchReason || "All autonomous sending & posting halted across the workspace.")
              : `${rollups.length} brand${rollups.length === 1 ? "" : "s"} · ${rollups.filter((r) => r.adminPaused).length} paused`}
          </div>
        </div>
        <span style={{ flex: 1 }} />
        {canManage && (
          <>
            <button
              className="btn"
              disabled={busy === "pauseall"}
              style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "7px 12px" }}
              onClick={pauseAll}
            >
              <Pause size={13} /> Pause all
            </button>
            <button
              className="btn"
              disabled={busy === "resumeall"}
              style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "7px 12px" }}
              onClick={resumeAll}
            >
              <Play size={13} /> Resume all
            </button>
            <button
              className={adminState.killSwitch ? "btn btn-primary" : "btn danger"}
              disabled={busy === "kill"}
              style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "7px 13px" }}
              onClick={toggleKill}
            >
              <Power size={13} /> {adminState.killSwitch ? "Release kill-switch" : "Kill-switch"}
            </button>
          </>
        )}
        {!canManage && <span className="sub" style={{ fontSize: 11.5 }}>Read-only — controls need admin (schedule.manage).</span>}
      </div>

      {/* TABS */}
      <div style={{ display: "flex", gap: 6, marginBottom: 16, flexWrap: "wrap" }}>
        {TABS.map((t) => (
          <button
            key={t.id}
            className={tab === t.id ? "btn btn-active" : "btn"}
            style={{ display: "inline-flex", alignItems: "center", gap: 7, padding: "7px 13px" }}
            onClick={() => setTab(t.id)}
          >
            {t.label}
            {t.badge ? (
              <span className="badge" style={t.badgeErr
                ? { background: "var(--error, #ef5350)", color: "#0a0a0c", border: "none", fontWeight: 700 }
                : { background: "var(--accent)", color: "#0a0a0c", border: "none", fontWeight: 700 }}>
                {t.badge}
              </span>
            ) : null}
          </button>
        ))}
      </div>

      {tab === "state" && (
        <StateGrid rollups={rollups} canManage={canManage} busy={busy} onPause={pauseBrand} onResponderOff={responderOff} />
      )}
      {tab === "approvals" && (
        <ApprovalsHub
          approvals={approvals}
          counts={counts}
          busy={busy}
          canApproveDna={canApproveDna}
          canPublish={canPublish}
          canSend={canSend}
          onApproveDna={approveDna}
          onRejectDna={rejectDna}
          onApprovePublish={approvePublish}
          onSendComment={sendComment}
          onSendDm={sendDm}
        />
      )}
      {tab === "team" && <TeamRollup team={team} members={members} canReassign={canReassign} />}
      {tab === "health" && <HealthPanel alerts={alerts} />}
      {tab === "audit" && canViewAudit && <AuditFeed audit={audit} />}
    </>
  );
}

/* ── STATE GRID ──────────────────────────────────────────────────────────── */

function statusBadge(label: string, on: boolean | "warn", text: string) {
  const cls = on === "warn" ? "b-warn" : on ? "b-ok" : "b-neutral";
  return (
    <span className={`badge ${cls}`} title={label}><span className="d" />{text}</span>
  );
}

function StateGrid({ rollups, canManage, busy, onPause, onResponderOff }: {
  rollups: BrandRollupView[];
  canManage: boolean;
  busy: string;
  onPause: (r: BrandRollupView) => void;
  onResponderOff: (r: BrandRollupView) => void;
}) {
  if (rollups.length === 0) {
    return <div className="empty">No brands in this workspace yet. Create one on /channels to see its ops rollup here.</div>;
  }
  return (
    <div style={{ display: "grid", gap: 10 }}>
      {rollups.map((r) => {
        const m = r.mission;
        const cap = r.budgetCap?.usdPerDay ?? m.usdPerDay;
        const burnPct = cap ? Math.min(100, (m.spentToday / cap) * 100) : 0;
        const burnColor = burnPct >= 100 ? "var(--error, #ef5350)" : burnPct >= 80 ? "var(--warning, #f5a623)" : "var(--accent)";
        const accent = r.accent ?? "#888";
        const backlog = r.inbox.commentsPending + r.inbox.dmsPending;
        const triage = r.inbox.commentsTriage + r.inbox.dmsTriage;
        return (
          <div key={r.channel} className="card" style={{ display: "flex", flexDirection: "column", gap: 11, opacity: r.adminPaused ? 0.72 : 1 }}>
            {/* head */}
            <div style={{ display: "flex", alignItems: "center", gap: 9, flexWrap: "wrap" }}>
              {r.logo ? (
                <img src={logoSrc(r.logo)} alt="" style={{ width: 18, height: 18, borderRadius: 4, objectFit: "contain" }} onError={(e) => ((e.target as HTMLImageElement).style.display = "none")} />
              ) : (
                <span style={{ width: 9, height: 9, borderRadius: 2, background: accent, boxShadow: `0 0 10px ${accent}`, flexShrink: 0 }} />
              )}
              <span style={{ fontSize: 14, fontWeight: 600, color: "var(--text-light)" }}>{r.name}</span>
              {r.adminPaused && <span className="badge b-warn"><span className="d" />admin paused</span>}
              <span style={{ flex: 1 }} />
              {canManage && (
                <>
                  <button
                    className="btn"
                    disabled={busy === `pause:${r.channel}`}
                    title={r.adminPaused ? "Resume this brand" : "Admin-pause this brand"}
                    style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "5px 10px", fontSize: 12 }}
                    onClick={() => onPause(r)}
                  >
                    {r.adminPaused ? <><Play size={12} /> Resume</> : <><Pause size={12} /> Pause</>}
                  </button>
                  {r.responder.enabled && (
                    <button
                      className="btn"
                      disabled={busy === `resp:${r.channel}`}
                      title="Disable this brand's auto-responder"
                      style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "5px 10px", fontSize: 12, color: "var(--error, #ef5350)" }}
                      onClick={() => onResponderOff(r)}
                    >
                      <X size={12} /> Responder off
                    </button>
                  )}
                </>
              )}
            </div>

            {/* status badges */}
            <div style={{ display: "flex", gap: 7, flexWrap: "wrap", alignItems: "center" }}>
              {statusBadge("Missions", m.activeCount > 0 ? true : m.count > 0 ? "warn" : false,
                m.count === 0 ? "no mission" : m.activeCount > 0 ? `${m.activeCount} active` : (m.status ?? "paused"))}
              {statusBadge("Autopilot", r.autopilot.enabled, r.autopilot.enabled ? `autopilot · ${r.autopilot.slots} slot${r.autopilot.slots === 1 ? "" : "s"}` : "autopilot off")}
              {statusBadge("Responder", r.responder.enabled ? (r.responder.defaultAction === "auto_send" ? "warn" : true) : false,
                r.responder.enabled ? `responder · ${r.responder.defaultAction}` : "responder off")}
              {statusBadge("Connection", r.connection.connected ? (r.connection.needsReauth ? "warn" : true) : false,
                r.connection.connected ? (r.connection.username ? `@${r.connection.username}` : "connected") : "disconnected")}
              {typeof r.connection.expiresInDays === "number" && r.connection.expiresInDays <= 14 && (
                <span className={`badge ${r.connection.expiresInDays < 0 ? "b-err" : "b-warn"}`}>
                  <span className="d" />{r.connection.expiresInDays < 0 ? "token expired" : `token ${r.connection.expiresInDays}d`}
                </span>
              )}
            </div>

            {/* spend vs budget + inbox backlog */}
            <div style={{ display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap", fontSize: 12 }}>
              <span style={{ display: "inline-flex", alignItems: "baseline", gap: 6 }}>
                <span className="stat-label" style={{ margin: 0 }}>Burn</span>
                <span style={{ fontFamily: "var(--font-mono)", color: cap && burnPct >= 100 ? burnColor : "var(--text-light)" }}>
                  {fmtUsd(m.spentToday)}{cap ? ` / ${fmtUsd(cap)}` : " · no cap"}
                </span>
                {r.budgetCap?.postsPerDay ? <span className="sub" style={{ fontSize: 11 }}>· cap {r.budgetCap.postsPerDay}/day</span> : null}
              </span>
              {(m.running > 0 || m.queued > 0) && (
                <span className="sub" style={{ fontSize: 11.5 }}>
                  {m.running > 0 ? `${m.running} running · ` : ""}{m.queued} queued
                </span>
              )}
              <span style={{ flex: 1 }} />
              <span style={{ display: "inline-flex", alignItems: "center", gap: 6, color: "var(--text-secondary)" }}>
                <Inbox size={12} /> {backlog} pending · {triage} to triage
              </span>
            </div>
            {cap ? (
              <div className="qa-track"><div className="qa-fill" style={{ width: `${burnPct}%`, background: burnColor }} /></div>
            ) : null}

            {/* alerts */}
            {r.alerts.length > 0 && (
              <div style={{ display: "flex", gap: 7, flexWrap: "wrap" }}>
                {r.alerts.map((a, i) => (
                  <span key={i} style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 11, color: a.level === "error" ? "var(--error, #ef5350)" : "var(--warning, #f5a623)" }}>
                    <AlertTriangle size={11} /> {a.text}
                  </span>
                ))}
              </div>
            )}

            <div style={{ display: "flex", gap: 12, fontSize: 11 }}>
              <Link href="/missions" className="sub" style={{ textDecoration: "none" }}>Missions →</Link>
              <Link href="/inbox" className="sub" style={{ textDecoration: "none" }}>Inbox →</Link>
              <Link href="/connections" className="sub" style={{ textDecoration: "none" }}>Connection →</Link>
              <span style={{ flex: 1 }} />
              <span className="sub" style={{ fontSize: 10.5 }}>updated {ago(m.updatedAt)}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ── APPROVALS HUB ───────────────────────────────────────────────────────── */

function ApprovalsHub({
  approvals, counts, busy, canApproveDna, canPublish, canSend,
  onApproveDna, onRejectDna, onApprovePublish, onSendComment, onSendDm,
}: {
  approvals: UnifiedApprovalView[];
  counts: Record<string, number>;
  busy: string;
  canApproveDna: boolean;
  canPublish: boolean;
  canSend: boolean;
  onApproveDna: (a: UnifiedApprovalView) => void;
  onRejectDna: (a: UnifiedApprovalView) => void;
  onApprovePublish: (a: UnifiedApprovalView) => void;
  onSendComment: (a: UnifiedApprovalView) => void;
  onSendDm: (a: UnifiedApprovalView) => void;
}) {
  if (approvals.length === 0) {
    return <div className="empty">Nothing waiting on a human. Every gate — DNA mutations, gated publishes, reply drafts, responder go-live — is clear.</div>;
  }
  const icon = (k: string) =>
    k === "dna" ? <Dna size={13} /> : k === "publish" ? <Send size={13} /> :
    k === "comment" ? <MessageSquare size={13} /> : k === "dm" ? <MessageSquare size={13} /> : <Zap size={13} />;
  const label = (k: string) =>
    ({ dna: "DNA mutation", publish: "Gated publish", comment: "Comment reply", dm: "DM reply", responder: "Responder live" } as Record<string, string>)[k] ?? k;

  return (
    <div style={{ display: "grid", gap: 9 }}>
      <div className="sub" style={{ fontSize: 11.5, display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 2 }}>
        {(["dna", "publish", "comment", "dm", "responder"] as const).filter((k) => counts[k]).map((k) => (
          <span key={k} style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>{icon(k)} {label(k)} · {counts[k]}</span>
        ))}
      </div>
      {approvals.map((a) => (
        <div key={`${a.kind}:${a.channel}:${a.id}`} className="card" style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
          <span style={{ width: 8, height: 8, borderRadius: 2, marginTop: 5, flexShrink: 0, background: a.accent ?? "#888", boxShadow: `0 0 8px ${a.accent ?? "#888"}` }} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <span style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 11, color: "var(--accent)", fontFamily: "var(--font-mono)" }}>{icon(a.kind)} {label(a.kind)}</span>
              <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text-light)" }}>{a.brandName}</span>
              {a.username && <span className="tag" style={{ fontSize: 10.5 }}>@{a.username}</span>}
              {a.kind === "dm" && a.windowOpen === false && <span className="badge b-err"><span className="d" />24h window closed</span>}
              {a.at && <span className="sub" style={{ fontSize: 11 }}>{ago(a.at)}</span>}
            </div>
            <div style={{ fontSize: 12.5, color: "var(--text-light)", marginTop: 4 }}>{a.title}</div>
            {a.detail && <div className="sub" style={{ fontSize: 11.5, marginTop: 2 }}>{a.kind === "comment" || a.kind === "dm" ? <>↳ {a.detail}</> : a.detail}</div>}
            {typeof a.confidence === "number" && (
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 5, maxWidth: 260 }}>
                <div className="qa-track" style={{ flex: 1 }}>
                  <div className="qa-fill" style={{ width: `${Math.round(Math.max(0, Math.min(1, a.confidence)) * 100)}%`, background: "var(--accent)" }} />
                </div>
                <span style={{ fontFamily: "var(--font-mono)", fontSize: 10.5, color: "var(--text-muted)" }}>{Math.round(a.confidence * 100)}% conf</span>
              </div>
            )}
          </div>
          <ApprovalActions
            a={a} busy={busy} canApproveDna={canApproveDna} canPublish={canPublish} canSend={canSend}
            onApproveDna={onApproveDna} onRejectDna={onRejectDna} onApprovePublish={onApprovePublish}
            onSendComment={onSendComment} onSendDm={onSendDm}
          />
        </div>
      ))}
    </div>
  );
}

function ApprovalActions({
  a, busy, canApproveDna, canPublish, canSend,
  onApproveDna, onRejectDna, onApprovePublish, onSendComment, onSendDm,
}: {
  a: UnifiedApprovalView;
  busy: string;
  canApproveDna: boolean;
  canPublish: boolean;
  canSend: boolean;
  onApproveDna: (a: UnifiedApprovalView) => void;
  onRejectDna: (a: UnifiedApprovalView) => void;
  onApprovePublish: (a: UnifiedApprovalView) => void;
  onSendComment: (a: UnifiedApprovalView) => void;
  onSendDm: (a: UnifiedApprovalView) => void;
}) {
  const key = `a:${a.id}`;
  const isBusy = busy === key;
  const wrap: React.CSSProperties = { display: "flex", gap: 6, flexShrink: 0, flexWrap: "wrap", justifyContent: "flex-end", maxWidth: 220 };
  if (a.kind === "dna") {
    return (
      <div style={wrap}>
        <button className="btn" disabled={!canApproveDna || isBusy} title={canApproveDna ? "Apply to genome" : "Needs brand.manage"} style={{ padding: "6px 11px", fontSize: 12, color: "var(--success, #5fd97a)" }} onClick={() => onApproveDna(a)}><Check size={13} /> Approve</button>
        <button className="btn" disabled={!canApproveDna || isBusy} style={{ padding: "6px 11px", fontSize: 12, color: "var(--error, #ef5350)" }} onClick={() => onRejectDna(a)}><X size={13} /> Reject</button>
      </div>
    );
  }
  if (a.kind === "publish") {
    return (
      <div style={wrap}>
        <Link href={`/post/${a.id}`} className="btn" style={{ padding: "6px 11px", fontSize: 12 }}>Review</Link>
        <button className="btn btn-primary" disabled={!canPublish || isBusy} title={canPublish ? "Publish publicly" : "Needs content.publish"} style={{ padding: "6px 12px", fontSize: 12 }} onClick={() => onApprovePublish(a)}><Send size={12} /> {isBusy ? "Starting…" : "Publish"}</button>
      </div>
    );
  }
  if (a.kind === "comment") {
    return (
      <div style={wrap}>
        {a.permalink && <a href={a.permalink} target="_blank" rel="noreferrer" className="btn" style={{ padding: "6px 11px", fontSize: 12 }}>Open</a>}
        <button className="btn btn-primary" disabled={!canSend || isBusy} title={canSend ? "Send the drafted reply" : "Needs content.publish"} style={{ padding: "6px 12px", fontSize: 12 }} onClick={() => onSendComment(a)}><Send size={12} /> {isBusy ? "Sending…" : "Send"}</button>
      </div>
    );
  }
  if (a.kind === "dm") {
    return (
      <div style={wrap}>
        <button className="btn btn-primary" disabled={!canSend || isBusy || a.windowOpen === false} title={a.windowOpen === false ? "24h window closed — cannot send" : canSend ? "Send the drafted DM" : "Needs content.publish"} style={{ padding: "6px 12px", fontSize: 12 }} onClick={() => onSendDm(a)}><Send size={12} /> {isBusy ? "Sending…" : "Send"}</button>
      </div>
    );
  }
  // responder "going live" — informational; manage on the connections page.
  return (
    <div style={wrap}>
      <Link href="/connections" className="btn" style={{ padding: "6px 11px", fontSize: 12 }}>Review responder</Link>
    </div>
  );
}

/* ── TEAM ────────────────────────────────────────────────────────────────── */

function TeamRollup({ team, members, canReassign }: { team: TeamView[]; members: MemberView[]; canReassign: boolean }) {
  return (
    <div style={{ display: "grid", gap: 12 }}>
      <div className="card">
        <div className="stat-label" style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 10 }}><Users size={13} /> Workspace · {members.length} member{members.length === 1 ? "" : "s"}</div>
        <div style={{ display: "grid", gap: 7 }}>
          {members.map((m) => (
            <div key={m.userId} className="row" style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span className="row-title">{m.name}</span>
              <span style={{ flex: 1 }} />
              <span className="badge b-neutral"><span className="d" />{m.role}</span>
            </div>
          ))}
          {members.length === 0 && <span className="sub" style={{ fontSize: 12 }}>No teammates resolved.</span>}
        </div>
      </div>
      <div className="card">
        <div className="stat-label" style={{ marginBottom: 10 }}>Brand ownership</div>
        <div style={{ display: "grid", gap: 8 }}>
          {team.map((t) => (
            <div key={t.channel} style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
              <span style={{ width: 9, height: 9, borderRadius: 2, background: t.accent ?? "#888", boxShadow: `0 0 8px ${t.accent ?? "#888"}`, flexShrink: 0 }} />
              <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text-light)" }}>{t.name}</span>
              <span style={{ flex: 1 }} />
              {t.owners.length ? t.owners.map((o) => <span key={o.userId} className="tag" style={{ fontSize: 10.5 }}>{o.name}</span>) : <span className="sub" style={{ fontSize: 11.5 }}>unassigned</span>}
            </div>
          ))}
          {team.length === 0 && <span className="sub" style={{ fontSize: 12 }}>No brands.</span>}
        </div>
        <div className="sub" style={{ fontSize: 11, marginTop: 10 }}>
          {canReassign
            ? "Reassign planned posts on /calendar-admin (assignee picker per post)."
            : "Reassignment needs calendar.edit."}
        </div>
      </div>
    </div>
  );
}

/* ── HEALTH ──────────────────────────────────────────────────────────────── */

function HealthPanel({ alerts }: { alerts: WorkspaceAlertView[] }) {
  if (alerts.length === 0) {
    return <div className="empty">All clear — no tokens expiring, no closed DM windows, no over-budget missions, every account connected.</div>;
  }
  return (
    <div style={{ display: "grid", gap: 8 }}>
      {alerts.map((a, i) => (
        <div key={i} className="card" style={{ display: "flex", alignItems: "center", gap: 10, borderColor: a.level === "error" ? "var(--error, #ef5350)" : "var(--warning, #f5a623)" }}>
          <AlertTriangle size={15} style={{ color: a.level === "error" ? "var(--error, #ef5350)" : "var(--warning, #f5a623)", flexShrink: 0 }} />
          <span style={{ fontSize: 13, color: "var(--text-light)" }}>{a.text}</span>
          <span style={{ flex: 1 }} />
          {a.brandName && <span className="tag" style={{ fontSize: 10.5 }}>{a.brandName}</span>}
          <span className="badge b-neutral" style={{ fontSize: 10.5 }}>{a.kind}</span>
        </div>
      ))}
    </div>
  );
}

/* ── AUDIT ───────────────────────────────────────────────────────────────── */

function AuditFeed({ audit }: { audit: AuditView[] }) {
  if (audit.length === 0) return <div className="empty">No audit entries yet.</div>;
  return (
    <div className="card" style={{ display: "grid", gap: 5 }}>
      {audit.map((e, i) => (
        <div key={i} style={{ display: "flex", alignItems: "center", gap: 10, fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-muted)" }}>
          <span style={{ opacity: 0.6, flexShrink: 0 }}>{e.at.slice(5, 16).replace("T", " ")}</span>
          <span style={{ color: "var(--text-secondary)", flexShrink: 0 }}>{e.action}</span>
          {e.target && <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{e.target}</span>}
        </div>
      ))}
    </div>
  );
}
