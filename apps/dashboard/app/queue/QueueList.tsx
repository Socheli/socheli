"use client";
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { StatusBadge, fmtCost, channelName, moodName, CHANNELS, MOODS } from "../ui";
import { Select } from "../Select";
import { Thumb } from "./Thumb";
import { confirmDialog } from "../confirm";
import { parseProgress } from "../../lib/progress";
import { InkTileFrame } from "../../components/sketch";
import type { CSSProperties } from "react";

export type QueueItem = {
  id: string;
  channel: string;
  title: string;
  status: string;
  mood?: string;
  kind?: string;
  scenes?: number;
  qa?: number;
  cost: number;
  hasVideo: boolean;
  generating: boolean;
  stalled: boolean;
  seedIdea: string;
  createdBy?: string; // Clerk user id of the author
  assignee?: string; // Clerk user id this job is handed to
};

export type QueueMember = { userId: string; name: string; imageUrl?: string };

export type InflightJob = { id: string; type: string; channel: string; status: string; phase: string; updatedAt: string; itemId?: string; message?: string; device?: string; pct: number | null; indeterminate: boolean };

const KINDS = [
  { id: "short", name: "Short (9:16)" },
  { id: "longform", name: "Long-form (16:9)" },
];

export function QueueList({
  items, inflight = [], members = [], meId = null, canCancel = true, canReassign = false,
}: {
  items: QueueItem[];
  inflight?: InflightJob[];
  members?: QueueMember[];
  meId?: string | null;
  canCancel?: boolean;
  canReassign?: boolean;
}) {
  const router = useRouter();

  // Live in-flight jobs: poll the fleet every 5s + tick every second so the phase
  // and "updated Ns ago" move on their own — an active render never looks frozen.
  const [live, setLive] = useState<InflightJob[]>(inflight);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const known = new Set(items.map((i) => i.id));
    let alive = true;
    const pull = () =>
      fetch("/api/jobs")
        .then((r) => (r.ok ? r.json() : null))
        .then((f) => {
          if (!alive || !f?.jobs) return;
          const recent = (ts?: string) => !!ts && Date.now() - new Date(ts).getTime() < 15 * 60 * 1000;
          setLive(
            (f.jobs as { id: string; type: string; channel: string; status: string; updatedAt: string; itemId?: string; message?: string; device?: string; progress?: { line: string }[] }[])
              .filter((j) => j.status === "dispatched" || j.status === "running" || (recent(j.updatedAt) && !(j.itemId && known.has(j.itemId))))
              .map((j) => {
                const p = parseProgress(j.progress, j.status);
                return { id: j.id, type: j.type, channel: j.channel, status: j.status, phase: p.label, updatedAt: j.updatedAt, itemId: j.itemId, message: j.message, device: j.device, pct: p.pct, indeterminate: p.indeterminate };
              }),
          );
        })
        .catch(() => {});
    const poll = setInterval(pull, 5000);
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => { alive = false; clearInterval(poll); clearInterval(tick); };
  }, [items]);

  const [q, setQ] = useState("");
  const [channel, setChannel] = useState("all");
  const [status, setStatus] = useState("all");
  const [mood, setMood] = useState("all");
  const [kind, setKind] = useState("all");
  const [member, setMember] = useState("all"); // "all" | "me" | "unassigned" | <userId>
  const [busy, setBusy] = useState("");

  const memberById = useMemo(() => {
    const m = new Map<string, QueueMember>();
    for (const x of members) m.set(x.userId, x);
    return m;
  }, [members]);
  const nameOf = (id?: string) => (id ? memberById.get(id)?.name ?? id : undefined);

  // Keep the queue live: new runs (e.g. just fired from the concept board) and
  // stalled-state changes show up without a manual reload. Pause when hidden.
  useEffect(() => {
    const tick = () => {
      if (document.visibilityState === "visible") router.refresh();
    };
    const t = window.setInterval(tick, 4000);
    return () => window.clearInterval(t);
  }, [router]);

  // Distinct statuses actually present, so the filter never offers dead options.
  const statuses = useMemo(() => Array.from(new Set(items.map((i) => i.status))).sort(), [items]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return items.filter((it) => {
      if (channel !== "all" && it.channel !== channel) return false;
      if (status !== "all" && it.status !== status) return false;
      if (mood !== "all" && (it.mood ?? "") !== mood) return false;
      if (kind !== "all" && (it.kind === "longform" ? "longform" : "short") !== kind) return false;
      if (member !== "all") {
        if (member === "unassigned") {
          if (it.assignee) return false;
        } else {
          const who = member === "me" ? meId : member;
          if (!who || (it.assignee !== who && it.createdBy !== who)) return false;
        }
      }
      if (needle && !`${it.title} ${it.seedIdea} ${it.channel}`.toLowerCase().includes(needle)) return false;
      return true;
    });
  }, [items, q, channel, status, mood, kind, member, meId]);

  const active = q || channel !== "all" || status !== "all" || mood !== "all" || kind !== "all" || member !== "all";
  const reset = () => {
    setQ("");
    setChannel("all");
    setStatus("all");
    setMood("all");
    setKind("all");
    setMember("all");
  };

  // Hand a job to a teammate (admin-only). Persists via the queue assign route.
  const reassign = async (it: QueueItem, assignee: string) => {
    setBusy(it.id);
    await fetch(`/api/queue/assign/${it.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ assignee }),
    }).catch(() => null);
    setBusy("");
    router.refresh();
  };

  const dismiss = async (it: QueueItem) => {
    if (!(await confirmDialog({ title: `Dismiss "${it.title}"?`, message: "This removes the run from the queue.", confirmText: "Dismiss", danger: true }))) return;
    setBusy(it.id);
    await fetch(`/api/item/${it.id}`, { method: "DELETE" }).catch(() => null);
    setBusy("");
    router.refresh();
  };
  const retry = async (it: QueueItem) => {
    setBusy(it.id);
    await fetch("/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ seed: it.seedIdea, channel: it.channel, mood: it.mood, voice: true }),
    }).catch(() => null);
    // drop the stalled run so we don't accumulate duplicates
    await fetch(`/api/item/${it.id}`, { method: "DELETE" }).catch(() => null);
    setBusy("");
    router.refresh();
  };

  const ago = (ts: string) => {
    const s = Math.max(0, Math.round((now - new Date(ts).getTime()) / 1000));
    return s < 60 ? `${s}s ago` : `${Math.floor(s / 60)}m ${s % 60}s ago`;
  };
  const liveActive = live.filter((j) => j.status === "dispatched" || j.status === "running");

  return (
    <>
      {live.length > 0 && (
        <div className="q-live">
          <InkTileFrame className="q-live-frame" />
          <div className="q-live-head">
            <span className="q-live-dot" />
            {liveActive.length > 0 ? `${liveActive.length} generating live` : "recently finished"}
          </div>
          {live.map((j) => {
            const done = j.status === "done", error = j.status === "error";
            return (
              <div key={j.id} className={`q-live-row${error ? " err" : done ? " done" : ""}`}>
                <span className={`q-live-state${!done && !error ? " spin" : ""}`}>{error ? "✕" : done ? "✓" : "⟳"}</span>
                <div className="q-live-main">
                  <div className="q-live-title">
                    {channelName(j.channel)} · {j.type}
                    {j.device ? <span className="q-live-dev"> @{j.device}</span> : null}
                    {j.itemId ? <Link href={`/post/${j.itemId}`} className="q-live-link"> → {j.itemId}</Link> : null}
                  </div>
                  <div className="q-live-phase">{j.message || j.phase}</div>
                  {!done && !error && (
                    <div className="q-live-bar"><div className={`q-live-bar-fill${j.indeterminate ? " indeterminate" : ""}`} style={{ width: j.pct != null ? `${j.pct}%` : "100%" }} /></div>
                  )}
                </div>
                <span className="q-live-ago">{!done && !error && j.pct != null ? `${j.pct}%` : j.status === "dispatched" ? "queued" : ago(j.updatedAt)}</span>
              </div>
            );
          })}
        </div>
      )}
      <div className="q-filters">
        <input className="input q-search" placeholder="Search title or idea…" value={q} onChange={(e) => setQ(e.target.value)} />
        <Select value={channel} onChange={setChannel} width={150} ariaLabel="Channel"
          options={[{ value: "all", label: "All channels" }, ...CHANNELS.map((c) => ({ value: c.id, label: c.name }))]} />
        <Select value={status} onChange={setStatus} width={150} ariaLabel="Status"
          options={[{ value: "all", label: "All statuses" }, ...statuses.map((s) => ({ value: s, label: s.replace(/_/g, " ") }))]} />
        <Select value={mood} onChange={setMood} width={140} ariaLabel="Mood"
          options={[{ value: "all", label: "All moods" }, ...MOODS.map((m) => ({ value: m.id, label: m.name }))]} />
        <Select value={kind} onChange={setKind} width={150} ariaLabel="Format"
          options={[{ value: "all", label: "All formats" }, ...KINDS.map((k) => ({ value: k.id, label: k.name }))]} />
        {members.length > 1 && (
          <Select value={member} onChange={setMember} width={160} ariaLabel="Member"
            options={[
              { value: "all", label: "Everyone" },
              ...(meId ? [{ value: "me", label: "Mine" }] : []),
              { value: "unassigned", label: "Unassigned" },
              ...members.map((m) => ({ value: m.userId, label: m.userId === meId ? `${m.name} (you)` : m.name })),
            ]} />
        )}
        {active && <button className="btn q-reset" onClick={reset}>Clear</button>}
        <span className="q-count">{filtered.length} of {items.length}</span>
      </div>

      {filtered.length === 0 ? (
        <div className="empty">{items.length === 0 ? "Queue is empty." : "No items match these filters."}</div>
      ) : (
        <div className="grid" style={{ gap: 10 }}>
          {filtered.map((it, i) => (
            <div key={it.id} className={`row row-thumb blk-in${it.stalled ? " row-stalled" : ""}`} style={{ "--i": i + 1 } as CSSProperties}>
              <Link href={`/post/${it.id}`} className={`thumb${it.kind === "longform" ? " thumb-wide" : ""}`}>
                <Thumb id={it.id} hasVideo={it.hasVideo} channel={it.channel} generating={it.generating} />
              </Link>
              <Link href={`/post/${it.id}`} style={{ flex: 1, minWidth: 0, textDecoration: "none", color: "inherit" }}>
                <div className="row-title" style={{ marginBottom: 5 }}>{it.title}</div>
                <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                  <StatusBadge status={it.status} />
                  {it.stalled && <span className="badge b-err"><span className="d" />stalled</span>}
                  <span className="row-id" style={{ width: "auto" }}>{channelName(it.channel)}</span>
                  {it.mood && <span className="row-cost">◐ {moodName(it.mood)}</span>}
                  {it.scenes ? <span className="row-cost">{it.scenes} scenes</span> : null}
                  {it.assignee
                    ? <span className="row-cost" title="Assigned to">→ {nameOf(it.assignee)}{it.assignee === meId ? " (you)" : ""}</span>
                    : it.createdBy
                    ? <span className="row-cost" title="Created by">by {nameOf(it.createdBy)}{it.createdBy === meId ? " (you)" : ""}</span>
                    : null}
                </div>
              </Link>
              {it.qa ? <div className="qa-pill">{it.qa.toFixed(1)}</div> : null}
              <div className="row-cost">{fmtCost(it.cost)}</div>
              <div className="q-actions">
                {canReassign && members.length > 0 && (
                  <Select
                    value={it.assignee ?? ""}
                    onChange={(v) => reassign(it, v)}
                    width={140}
                    ariaLabel="Assign job"
                    options={[{ value: "", label: "Unassigned" }, ...members.map((m) => ({ value: m.userId, label: m.userId === meId ? `${m.name} (you)` : m.name }))]}
                  />
                )}
                {canCancel && (it.stalled || !it.hasVideo) && (
                  <button className="btn q-act" disabled={busy === it.id} onClick={() => retry(it)} title="Re-run from the original idea">↻</button>
                )}
                {canCancel && (
                  <button className="btn q-act q-act-danger" disabled={busy === it.id} onClick={() => dismiss(it)} title="Dismiss / remove from queue">✕</button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
