"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  AlertTriangle, Check, ChevronDown, ChevronUp, Dna, Inbox, Pause, Play, Plus,
  Send, Target, Terminal, X, Zap,
} from "lucide-react";
import { channelName } from "../ui";
import { confirmDialog } from "../confirm";
import { MissionComposer } from "./MissionComposer";

/* The missions board: approvals inbox on top (pending DNA mutations + gated
   publishes), then one card per mission — goal, brand, cadence, budget burn,
   recent events — expanding into the task queue and a live agent-event feed.
   Server data stays fresh via router.refresh polling (the QueueList pattern);
   an open task feed polls its own tail every ~3.5s while the task runs. */

export type BrandLite = { id: string; name: string; accent?: string; logo?: string };

export type MissionTaskView = {
  id: string;
  role: string;
  goal: string;
  status: "queued" | "running" | "done" | "failed" | "skipped";
  dueAt?: string;
  startedAt?: string;
  finishedAt?: string;
  resultSummary?: string;
  usd: number;
};

export type MissionView = {
  id: string;
  channel: string;
  goal: string;
  status: "active" | "paused" | "done";
  cadence: Partial<Record<"research" | "plan" | "generate" | "analyze" | "evolve", string>>;
  approvalPolicy: { publish: "auto" | "gate"; dnaMutations: "auto" | "gate" };
  budget: { usdPerDay?: number; postsPerDay?: number };
  queue: MissionTaskView[];
  log: { at: string; event: string }[];
  spentToday: number;
  updatedAt: string;
  createdAt: string;
};

export type DnaApprovalView = {
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

export type GatedPublishView = {
  id: string;
  title: string;
  channel: string;
  createdAt: string;
  waiting: { platform: string; status: string }[];
};

const MISSION_BADGE: Record<MissionView["status"], string> = { active: "b-ok", paused: "b-warn", done: "b-neutral" };
const TASK_COLOR: Record<MissionTaskView["status"], string> = {
  queued: "var(--text-muted)",
  running: "var(--accent)",
  done: "var(--success, #5fd97a)",
  failed: "var(--error, #ef5350)",
  skipped: "var(--text-muted)",
};

const fmtUsd = (n: number) => `$${n.toFixed(n < 10 ? 3 : 2)}`;
const ago = (ts?: string) => {
  if (!ts) return "—";
  const s = Math.max(0, Math.round((Date.now() - new Date(ts).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
};

/* Brand logos are stored relative to the Remotion public/ dir (the render
   engine's view); the dashboard serves that dir under /rem (BrandManager rule). */
const logoSrc = (logo?: string) =>
  !logo ? undefined : /^(https?:)?\/\//.test(logo) || logo.startsWith("/") ? logo : `/rem/${logo}`;

export function MissionsBoard({
  missions, brands, dnaPending, gatedPublishes, canManage, canApproveDna, canPublish,
}: {
  missions: MissionView[];
  brands: BrandLite[];
  dnaPending: DnaApprovalView[];
  gatedPublishes: GatedPublishView[];
  canManage: boolean;
  canApproveDna: boolean;
  canPublish: boolean;
}) {
  const router = useRouter();
  const [composer, setComposer] = useState(false);
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  const brandById = useMemo(() => new Map(brands.map((b) => [b.id, b])), [brands]);
  const nameOf = (id: string) => brandById.get(id)?.name ?? channelName(id);

  // Keep server data live (missions advance on the scheduler's tick, approvals
  // appear from evolve runs). Pause when the tab is hidden — QueueList pattern.
  useEffect(() => {
    const t = window.setInterval(() => {
      if (document.visibilityState === "visible") router.refresh();
    }, 5000);
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

  const pauseResume = (m: MissionView) =>
    act(`pr:${m.id}`, () =>
      fetch(`/api/missions/${m.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: m.status === "active" ? "pause" : "resume" }),
      }),
    m.status === "active" ? "Mission paused." : "Mission resumed.");

  const tickNow = (m: MissionView) =>
    act(`tick:${m.id}`, () => fetch(`/api/missions/${m.id}/tick`, { method: "POST" }),
      "Tick started — due tasks enqueue and the next one runs now.");

  const approveDna = (p: DnaApprovalView) =>
    act(`dna:${p.id}`, () =>
      fetch("/api/dna/mutations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channel: p.channel, id: p.id, action: "approve" }),
      }), `Mutation applied to ${p.brandName}'s genome.`);

  const rejectDna = async (p: DnaApprovalView) => {
    if (!(await confirmDialog({ title: "Reject this mutation?", message: p.mutation, confirmText: "Reject", danger: true }))) return;
    act(`dna:${p.id}`, () =>
      fetch("/api/dna/mutations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channel: p.channel, id: p.id, action: "reject" }),
      }), "Mutation rejected — genome untouched.");
  };

  const approvePublish = async (g: GatedPublishView) => {
    if (!(await confirmDialog({
      title: `Publish "${g.title}"?`,
      message: "Goes live (public) on every configured platform. IG/TikTok transcoding can take minutes.",
      confirmText: "Approve & publish",
    }))) return;
    act(`pub:${g.id}`, () =>
      fetch("/api/publish", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: g.id, public: true }),
      }), "Publish started — track it on the post page.");
  };

  return (
    <>
      {notice && (
        <div className="card" style={{ marginBottom: 14, padding: "10px 16px", borderColor: notice.kind === "ok" ? "var(--success, #5fd97a)" : "var(--error, #ef5350)" }}>
          <span style={{ fontSize: 12.5, color: notice.kind === "ok" ? "var(--success, #5fd97a)" : "var(--error, #ef5350)" }}>{notice.text}</span>
        </div>
      )}

      <ApprovalsInbox
        dna={dnaPending}
        publishes={gatedPublishes}
        canApproveDna={canApproveDna}
        canPublish={canPublish}
        busy={busy}
        nameOf={nameOf}
        onApproveDna={approveDna}
        onRejectDna={rejectDna}
        onApprovePublish={approvePublish}
      />

      <div style={{ display: "flex", alignItems: "center", gap: 12, margin: "26px 0 12px" }}>
        <div className="stat-label" style={{ display: "flex", alignItems: "center", gap: 7 }}>
          <Target size={13} /> {missions.length} mission{missions.length === 1 ? "" : "s"}
        </div>
        <span style={{ flex: 1 }} />
        {canManage && (
          <button className="btn btn-primary" style={{ display: "inline-flex", alignItems: "center", gap: 7, padding: "8px 15px" }} onClick={() => setComposer(true)}>
            <Plus size={14} /> New mission
          </button>
        )}
      </div>

      {missions.length === 0 ? (
        <div className="empty">
          No missions yet. A mission is a standing goal — &ldquo;grow IG to 10k with daily premium reels&rdquo; — that the
          system advances on a cadence: research, plan, generate, analyze, evolve.
          {canManage ? " Create the first one." : " Ask an admin to create one."}
        </div>
      ) : (
        <div className="grid cols-2" style={{ alignItems: "start" }}>
          {missions.map((m) => (
            <MissionCard
              key={m.id}
              m={m}
              brand={brandById.get(m.channel)}
              nameOf={nameOf}
              canManage={canManage}
              busy={busy}
              onPauseResume={() => pauseResume(m)}
              onTick={() => tickNow(m)}
            />
          ))}
        </div>
      )}

      {composer && (
        <MissionComposer
          brands={brands}
          onClose={() => setComposer(false)}
          onCreated={() => {
            setComposer(false);
            flash("ok", "Mission created — it starts on the next scheduler tick.");
            router.refresh();
          }}
        />
      )}
    </>
  );
}

/* ── Approvals inbox ─────────────────────────────────────────────────────── */

function ApprovalsInbox({
  dna, publishes, canApproveDna, canPublish, busy, nameOf, onApproveDna, onRejectDna, onApprovePublish,
}: {
  dna: DnaApprovalView[];
  publishes: GatedPublishView[];
  canApproveDna: boolean;
  canPublish: boolean;
  busy: string;
  nameOf: (id: string) => string;
  onApproveDna: (p: DnaApprovalView) => void;
  onRejectDna: (p: DnaApprovalView) => void;
  onApprovePublish: (g: GatedPublishView) => void;
}) {
  const count = dna.length + publishes.length;
  return (
    <div className="card" style={{ padding: 0, overflow: "hidden" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 9, padding: "13px 18px", borderBottom: count ? "1px solid var(--border-subtle)" : "none" }}>
        <Inbox size={14} style={{ color: "var(--accent)" }} />
        <span className="stat-label" style={{ margin: 0 }}>Approvals inbox</span>
        <span
          className="badge"
          style={count
            ? { background: "var(--accent)", color: "#0a0a0c", border: "none", fontWeight: 700 }
            : { color: "var(--text-muted)" }}
        >
          {count}
        </span>
        <span style={{ flex: 1 }} />
        {count === 0 && <span className="sub" style={{ fontSize: 11.5 }}>Nothing waiting on you.</span>}
      </div>

      {dna.length > 0 && (
        <div style={{ padding: "12px 18px", borderBottom: publishes.length ? "1px solid var(--border-subtle)" : "none" }}>
          <div className="stat-label" style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 10 }}>
            <Dna size={12} /> DNA mutations · {dna.length}
          </div>
          <div style={{ display: "grid", gap: 10 }}>
            {dna.map((p) => {
              const pct = Math.round(Math.max(0, Math.min(1, p.confidence)) * 100);
              return (
                <div key={`${p.channel}:${p.id}`} style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
                  <span style={{ width: 8, height: 8, borderRadius: 2, marginTop: 5, flexShrink: 0, background: p.accent ?? "#888", boxShadow: `0 0 8px ${p.accent ?? "#888"}` }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                      <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text-light)" }}>{p.brandName}</span>
                      <span className="tag" style={{ fontFamily: "var(--font-mono)", fontSize: 10.5 }}>{p.path}</span>
                      <span className="sub" style={{ fontSize: 11 }}>{ago(p.proposedAt)}</span>
                    </div>
                    <div style={{ fontSize: 12.5, color: "var(--text-light)", marginTop: 3 }}>{p.mutation}</div>
                    <div className="sub" style={{ fontSize: 11.5, marginTop: 2 }}>{p.rationale}</div>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 5, maxWidth: 280 }}>
                      <div className="qa-track" style={{ flex: 1 }}>
                        <div className="qa-fill" style={{ width: `${pct}%`, background: pct >= 80 ? "var(--success, #5fd97a)" : "var(--accent)" }} />
                      </div>
                      <span style={{ fontFamily: "var(--font-mono)", fontSize: 10.5, color: "var(--text-muted)" }}>{pct}% conf</span>
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
                    <button
                      className="btn"
                      disabled={!canApproveDna || busy === `dna:${p.id}`}
                      title={canApproveDna ? "Apply to the genome" : "Needs brand.manage (admin)"}
                      style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "6px 11px", fontSize: 12, color: "var(--success, #5fd97a)" }}
                      onClick={() => onApproveDna(p)}
                    >
                      <Check size={13} /> Approve
                    </button>
                    <button
                      className="btn"
                      disabled={!canApproveDna || busy === `dna:${p.id}`}
                      title={canApproveDna ? "Discard — genome untouched" : "Needs brand.manage (admin)"}
                      style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "6px 11px", fontSize: 12, color: "var(--error, #ef5350)" }}
                      onClick={() => onRejectDna(p)}
                    >
                      <X size={13} /> Reject
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {publishes.length > 0 && (
        <div style={{ padding: "12px 18px" }}>
          <div className="stat-label" style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 10 }}>
            <Send size={12} /> Gated publishes · {publishes.length}
          </div>
          <div style={{ display: "grid", gap: 8 }}>
            {publishes.map((g) => (
              <div key={g.id} style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                <div style={{ flex: 1, minWidth: 180 }}>
                  <Link href={`/post/${g.id}`} style={{ fontSize: 12.5, fontWeight: 600, color: "var(--text-light)", textDecoration: "none" }}>{g.title}</Link>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 3, flexWrap: "wrap" }}>
                    <span className="sub" style={{ fontSize: 11 }}>{nameOf(g.channel)} · {ago(g.createdAt)}</span>
                    {g.waiting.map((w) => (
                      <span key={w.platform} className="tag" style={{ fontSize: 10.5 }}>{w.platform} · {w.status}</span>
                    ))}
                  </div>
                </div>
                <Link href={`/post/${g.id}`} className="btn" style={{ padding: "6px 11px", fontSize: 12 }}>Review</Link>
                <button
                  className="btn btn-primary"
                  disabled={!canPublish || busy === `pub:${g.id}`}
                  title={canPublish ? "Publish publicly on every configured platform" : "Needs content.publish"}
                  style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "6px 12px", fontSize: 12 }}
                  onClick={() => onApprovePublish(g)}
                >
                  <Send size={12} /> {busy === `pub:${g.id}` ? "Starting…" : "Approve & publish"}
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/* ── Mission card ────────────────────────────────────────────────────────── */

function MissionCard({
  m, brand, nameOf, canManage, busy, onPauseResume, onTick,
}: {
  m: MissionView;
  brand?: BrandLite;
  nameOf: (id: string) => string;
  canManage: boolean;
  busy: string;
  onPauseResume: () => void;
  onTick: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [taskId, setTaskId] = useState<string | null>(null);

  const queued = m.queue.filter((t) => t.status === "queued").length;
  const running = m.queue.filter((t) => t.status === "running").length;
  const cadences = Object.entries(m.cadence).filter(([, v]) => v) as [string, string][];
  const cap = m.budget.usdPerDay;
  const burnPct = cap ? Math.min(100, (m.spentToday / cap) * 100) : 0;
  const burnColor = burnPct >= 100 ? "var(--error, #ef5350)" : burnPct >= 80 ? "var(--warning, #f5a623)" : "var(--accent)";
  const accent = brand?.accent ?? "#888";
  // newest task first in the detail view (the engine appends to the queue)
  const tasks = useMemo(() => [...m.queue].reverse().slice(0, 8), [m.queue]);
  const selected = taskId ? m.queue.find((t) => t.id === taskId) ?? null : null;

  return (
    <div className="card" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {/* head: brand + status + actions */}
      <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
        {brand?.logo ? (
          <img src={logoSrc(brand.logo)} alt="" style={{ width: 18, height: 18, borderRadius: 4, objectFit: "contain" }} onError={(e) => ((e.target as HTMLImageElement).style.display = "none")} />
        ) : (
          <span style={{ width: 9, height: 9, borderRadius: 2, background: accent, boxShadow: `0 0 10px ${accent}`, flexShrink: 0 }} />
        )}
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, letterSpacing: "0.04em", color: "var(--text-secondary)", textTransform: "uppercase" }}>{nameOf(m.channel)}</span>
        <span className={`badge ${MISSION_BADGE[m.status]}`}><span className="d" />{m.status}</span>
        <span style={{ flex: 1 }} />
        {canManage && m.status !== "done" && (
          <>
            <button
              className="btn"
              disabled={busy === `tick:${m.id}` || m.status !== "active"}
              title="Run one orchestrator pass now"
              style={{ padding: "5px 9px" }}
              onClick={onTick}
            >
              <Zap size={13} />
            </button>
            <button
              className="btn"
              disabled={busy === `pr:${m.id}`}
              title={m.status === "active" ? "Pause mission" : "Resume mission"}
              style={{ padding: "5px 9px" }}
              onClick={onPauseResume}
            >
              {m.status === "active" ? <Pause size={13} /> : <Play size={13} />}
            </button>
          </>
        )}
        <button className="btn" style={{ padding: "5px 9px" }} title={open ? "Collapse" : "Task queue + live feed"} onClick={() => setOpen((o) => !o)}>
          {open ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
        </button>
      </div>

      {/* the standing goal */}
      <div style={{ fontSize: 15, fontWeight: 600, color: "var(--text-light)", lineHeight: 1.4 }}>{m.goal}</div>

      {/* cadence + policy chips */}
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {cadences.map(([loop, c]) => (
          <span key={loop} className="tag" style={{ fontFamily: "var(--font-mono)", fontSize: 10.5 }}>{loop} · {c}</span>
        ))}
        <span className="tag" style={{ fontSize: 10.5, opacity: 0.75 }}>publish {m.approvalPolicy.publish === "gate" ? "gated" : "auto"}</span>
        <span className="tag" style={{ fontSize: 10.5, opacity: 0.75 }}>dna {m.approvalPolicy.dnaMutations === "gate" ? "gated" : "auto"}</span>
      </div>

      {/* budget burn */}
      <div>
        <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
          <span className="stat-label" style={{ margin: 0 }}>Today&rsquo;s burn</span>
          <span style={{ flex: 1 }} />
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: cap && burnPct >= 100 ? burnColor : "var(--text-light)" }}>
            {fmtUsd(m.spentToday)}{cap ? ` / ${fmtUsd(cap)}` : " · no cap"}
          </span>
          {m.budget.postsPerDay ? <span className="sub" style={{ fontSize: 11 }}>· {m.budget.postsPerDay}/day posts</span> : null}
        </div>
        {cap ? (
          <div className="qa-track" style={{ marginTop: 5 }}>
            <div className="qa-fill" style={{ width: `${burnPct}%`, background: burnColor }} />
          </div>
        ) : null}
      </div>

      {/* queue counts + last events */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 11.5, color: "var(--text-muted)" }}>
        {running > 0 && (
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6, color: "var(--accent)" }}>
            <span className="pulse-dot" style={{ width: 7, height: 7, borderRadius: "50%", background: "var(--accent)", boxShadow: "0 0 8px var(--accent)" }} />
            {running} running
          </span>
        )}
        <span>{queued} queued</span>
        <span style={{ flex: 1 }} />
        <span>updated {ago(m.updatedAt)}</span>
      </div>
      {m.log.length > 0 && (
        <div style={{ display: "grid", gap: 3 }}>
          {m.log.slice(0, open ? 6 : 2).map((l, i) => (
            <div key={i} style={{ fontFamily: "var(--font-mono)", fontSize: 10.5, color: "var(--text-muted)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
              <span style={{ opacity: 0.6 }}>{l.at.slice(5, 16).replace("T", " ")}</span> {l.event}
            </div>
          ))}
        </div>
      )}

      {/* expanded: task queue + live feed */}
      {open && (
        <div style={{ borderTop: "1px solid var(--border-subtle)", paddingTop: 12, display: "grid", gap: 8 }}>
          <div className="stat-label" style={{ margin: 0 }}>Task queue</div>
          {tasks.length === 0 ? (
            <div className="sub" style={{ fontSize: 12 }}>No tasks yet — they enqueue when a cadence loop comes due.</div>
          ) : (
            tasks.map((t) => (
              <button
                key={t.id}
                onClick={() => setTaskId(taskId === t.id ? null : t.id)}
                style={{
                  display: "flex", alignItems: "center", gap: 9, textAlign: "left", width: "100%",
                  padding: "7px 10px", borderRadius: 6, cursor: "pointer", font: "inherit",
                  background: taskId === t.id ? "var(--bg-elevated)" : "transparent",
                  border: `1px solid ${taskId === t.id ? "var(--border-subtle)" : "transparent"}`, color: "inherit",
                }}
              >
                <span style={{ width: 7, height: 7, borderRadius: "50%", flexShrink: 0, background: TASK_COLOR[t.status], boxShadow: t.status === "running" ? "0 0 8px var(--accent)" : "none" }} />
                <span className="tag" style={{ fontFamily: "var(--font-mono)", fontSize: 10, flexShrink: 0 }}>{t.id.split("_")[0]}</span>
                <span style={{ fontSize: 11.5, color: "var(--text-secondary)", flex: 1, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                  {t.resultSummary || t.goal}
                </span>
                <span style={{ fontFamily: "var(--font-mono)", fontSize: 10.5, color: TASK_COLOR[t.status], flexShrink: 0 }}>{t.status}</span>
                <span style={{ fontFamily: "var(--font-mono)", fontSize: 10.5, color: "var(--text-muted)", flexShrink: 0 }}>
                  {t.usd ? fmtUsd(t.usd) : ago(t.finishedAt ?? t.startedAt ?? t.dueAt)}
                </span>
              </button>
            ))
          )}
          {selected && <TaskFeed missionId={m.id} task={selected} />}
        </div>
      )}
    </div>
  );
}

/* ── Live task feed — tails data/agent/<taskId>.jsonl via the task route ──── */

type FeedEvent = {
  at?: string;
  type?: string;
  label?: string;
  name?: string;
  ok?: boolean;
  message?: string;
  summary?: string;
  usd?: number;
  goal?: string;
  role?: string;
  args?: unknown;
  line?: string;
};

function TaskFeed({ missionId, task }: { missionId: string; task: MissionTaskView }) {
  const [events, setEvents] = useState<FeedEvent[] | null>(null);
  const [status, setStatus] = useState(task.status);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    let timer: number | undefined;
    setEvents(null);
    setErr(null);
    setStatus(task.status);

    const pull = async () => {
      try {
        const r = await fetch(`/api/missions/${missionId}/tasks/${task.id}?tail=150`);
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
        if (!alive) return;
        setErr(null);
        setEvents(j.events ?? []);
        const s = j.task?.status ?? "done";
        setStatus(s);
        // poll every ~3.5s only while the agent is actually working
        if (s === "running" || s === "queued") timer = window.setTimeout(pull, 3500);
      } catch (e) {
        if (!alive) return;
        setErr(e instanceof Error ? e.message : "feed unavailable");
        timer = window.setTimeout(pull, 7000); // keep retrying, slower
      }
    };
    pull();
    return () => {
      alive = false;
      if (timer) window.clearTimeout(timer);
    };
  }, [missionId, task.id]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div style={{ border: "1px solid var(--border-subtle)", borderRadius: 6, background: "var(--bg-elevated)", padding: "10px 12px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
        <span className="stat-label" style={{ margin: 0 }}>Live feed</span>
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 10.5, color: TASK_COLOR[status] ?? "var(--text-muted)" }}>{status}</span>
        {(status === "running" || status === "queued") && (
          <span className="pulse-dot" style={{ width: 7, height: 7, borderRadius: "50%", background: "var(--accent)", boxShadow: "0 0 8px var(--accent)" }} />
        )}
        <span style={{ flex: 1 }} />
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--text-muted)" }}>{task.id}</span>
      </div>

      {err ? (
        <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11.5, color: "var(--error, #ef5350)" }}>
          <AlertTriangle size={12} /> {err}
        </div>
      ) : events === null ? (
        <div className="sub" style={{ fontSize: 11.5 }}>Loading events…</div>
      ) : events.length === 0 ? (
        <div className="sub" style={{ fontSize: 11.5 }}>
          {status === "queued" ? "Waiting for the scheduler to pick this task up…" : "No events recorded for this task."}
        </div>
      ) : (
        <div style={{ display: "grid", gap: 4, maxHeight: 260, overflowY: "auto" }}>
          {events.map((e, i) => <FeedRow key={i} e={e} />)}
        </div>
      )}
    </div>
  );
}

function FeedRow({ e }: { e: FeedEvent }) {
  const mono: React.CSSProperties = { fontFamily: "var(--font-mono)", fontSize: 11, lineHeight: 1.5, display: "flex", gap: 7, alignItems: "flex-start", minWidth: 0 };
  const clip: React.CSSProperties = { minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };
  const t = (s?: string) => (s ? s.slice(11, 19) : "");

  switch (e.type) {
    case "task":
      return (
        <div style={{ ...mono, color: "var(--text-secondary)" }}>
          <Target size={11} style={{ marginTop: 2, flexShrink: 0 }} />
          <span style={clip}>{t(e.at)} {e.role} · {e.goal}</span>
        </div>
      );
    case "step":
      return (
        <div style={{ ...mono, color: "var(--text-light)" }}>
          <span style={{ color: "var(--text-muted)", flexShrink: 0 }}>{t(e.at)}</span>
          <span style={clip}>{e.label}</span>
        </div>
      );
    case "tool_call":
      return (
        <div style={{ ...mono, color: "var(--accent)" }}>
          <Terminal size={11} style={{ marginTop: 2, flexShrink: 0 }} />
          <span style={clip}>{e.name}{e.args !== undefined ? ` ${JSON.stringify(e.args).slice(0, 140)}` : ""}</span>
        </div>
      );
    case "tool_result":
      return (
        <div style={{ ...mono, color: e.ok === false ? "var(--error, #ef5350)" : "var(--text-muted)" }}>
          {e.ok === false ? <X size={11} style={{ marginTop: 2, flexShrink: 0 }} /> : <Check size={11} style={{ marginTop: 2, flexShrink: 0 }} />}
          <span style={clip}>{e.name} {e.ok === false ? "failed" : "ok"}</span>
        </div>
      );
    case "done":
      return (
        <div style={{ ...mono, color: "var(--success, #5fd97a)", whiteSpace: "normal" }}>
          <Check size={11} style={{ marginTop: 2, flexShrink: 0 }} />
          <span>{e.summary}{typeof e.usd === "number" ? ` · ${fmtUsd(e.usd)}` : ""}</span>
        </div>
      );
    case "error":
      return (
        <div style={{ ...mono, color: "var(--error, #ef5350)", whiteSpace: "normal" }}>
          <AlertTriangle size={11} style={{ marginTop: 2, flexShrink: 0 }} />
          <span>{e.message}</span>
        </div>
      );
    default:
      return (
        <div style={{ ...mono, color: "var(--text-muted)" }}>
          <span style={clip}>{e.line ?? JSON.stringify(e).slice(0, 140)}</span>
        </div>
      );
  }
}
