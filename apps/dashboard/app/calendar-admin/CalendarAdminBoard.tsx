"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  AlertTriangle, CalendarDays, CalendarRange, Check, ChevronLeft, ChevronRight,
  Inbox, ShieldCheck, SlidersHorizontal, UserPlus, X,
} from "lucide-react";
import { confirmDialog, promptDialog } from "../confirm";
import { PostingPolicyEditor } from "./PostingPolicyEditor";
import { ConflictsPanel } from "./ConflictsPanel";
import type { AdminBrand, AdminPost, Conflict, PostingPolicy } from "../../lib/calendar-admin";

/* The Calendar Admin board: a cross-brand calendar over every brand's planned +
   scheduled posts, an admin approval queue (the gate that lets a planned post
   enter the autopilot queue), per-brand posting policy, and conflict detection.
   Server data is kept live via router.refresh polling while the tab is visible.
   All mutations POST to /api/calendar-admin and are disabled unless canManage
   (reassignment needs canAssign). Gates are sacred — approve/reject are the
   only path to the autopilot queue and they're admin-gated server-side too. */

type Member = { userId: string; name: string; imageUrl?: string };
type Tab = "calendar" | "approvals" | "policy" | "conflicts";

const APPROVAL_BADGE: Record<string, string> = { approved: "b-ok", pending: "b-warn", rejected: "b-err", none: "b-neutral" };
const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

export function CalendarAdminBoard({
  brands,
  posts,
  approvalQueue,
  policies,
  conflicts,
  members,
  meId,
  canManage,
  canAssign,
}: {
  brands: AdminBrand[];
  posts: AdminPost[];
  approvalQueue: AdminPost[];
  policies: PostingPolicy[];
  conflicts: Conflict[];
  members: Member[];
  meId: string | null;
  canManage: boolean;
  canAssign: boolean;
}) {
  const router = useRouter();
  const [tab, setTab] = useState<Tab>("calendar");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Live refresh while visible (the QueueList/MissionsBoard pattern).
  useEffect(() => {
    const t = setInterval(() => {
      if (document.visibilityState === "visible") router.refresh();
    }, 15_000);
    return () => clearInterval(t);
  }, [router]);

  // Brand filter chips + multi-select.
  const [brandFilter, setBrandFilter] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [lastClicked, setLastClicked] = useState<string | null>(null);
  const [month, setMonth] = useState(() => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1); });

  const accentOf = useMemo(() => {
    const m = new Map<string, string>();
    for (const b of brands) m.set(b.id, b.accent);
    return m;
  }, [brands]);

  const visiblePosts = useMemo(
    () => (brandFilter.size ? posts.filter((p) => brandFilter.has(p.channel)) : posts),
    [posts, brandFilter],
  );

  const blackoutDates = useMemo(() => {
    // Per-channel set of YYYY-MM-DD inside any blackout window (full-day flag).
    const set = new Set<string>();
    for (const pol of policies) {
      for (const b of pol.blackouts ?? []) {
        if (!b.from || !b.to) continue;
        const start = new Date(b.from + "T00:00:00");
        const end = new Date(b.to + "T00:00:00");
        for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
          set.add(`${pol.channel}|${ymd(d)}`);
        }
      }
    }
    return set;
  }, [policies]);

  function toggleBrand(id: string) {
    setBrandFilter((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  /* Multi-select with shift-range over the flat date-sorted visible list. */
  function clickSelect(id: string, ev: { shiftKey: boolean }) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (ev.shiftKey && lastClicked) {
        const ids = visiblePosts.map((p) => p.id);
        const a = ids.indexOf(lastClicked);
        const b = ids.indexOf(id);
        if (a !== -1 && b !== -1) {
          const [lo, hi] = a < b ? [a, b] : [b, a];
          for (let i = lo; i <= hi; i++) next.add(ids[i]);
        }
      } else {
        next.has(id) ? next.delete(id) : next.add(id);
      }
      return next;
    });
    setLastClicked(id);
  }
  const clearSel = () => { setSelected(new Set()); setLastClicked(null); };

  async function post(body: Record<string, unknown>): Promise<boolean> {
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch("/api/calendar-admin", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        setErr(j?.error ?? `request failed (${res.status})`);
        return false;
      }
      router.refresh();
      return true;
    } catch (e) {
      setErr(String(e));
      return false;
    } finally {
      setBusy(false);
    }
  }

  /* ── Bulk + per-row actions ─────────────────────────────────────────── */
  async function bulkReschedule(ids: string[]) {
    if (!ids.length) return;
    const date = await promptDialog({ title: "Reschedule to date", placeholder: "YYYY-MM-DD" });
    if (!date) return;
    const time = await promptDialog({ title: "Time (optional)", placeholder: "HH:MM" });
    const ok = await confirmDialog({
      title: `Reschedule ${ids.length} post${ids.length === 1 ? "" : "s"}?`,
      message: `Move to ${date}${time ? ` ${time}` : ""}.`,
    });
    if (!ok) return;
    if (await post({ action: "reschedule", ids, date, ...(time ? { time } : {}) })) clearSel();
  }

  async function bulkAssign(ids: string[]) {
    if (!ids.length || !members.length) return;
    const opts = members.map((m) => `${m.name} (${m.userId})`).join("\n");
    const pick = await promptDialog({
      title: "Assign to teammate",
      message: opts,
      placeholder: "paste the user id",
    });
    if (!pick) return;
    const assignee = pick.includes("(") ? pick.split("(").pop()!.replace(")", "").trim() : pick.trim();
    if (await post({ action: "assign", ids, assignee })) clearSel();
  }

  async function bulkApprove(ids: string[]) {
    if (!ids.length) return;
    const ok = await confirmDialog({
      title: `Approve ${ids.length} post${ids.length === 1 ? "" : "s"}?`,
      message: "Approved posts may enter the autopilot queue.",
    });
    if (!ok) return;
    if (await post({ action: "approve", ids })) clearSel();
  }

  async function bulkReject(ids: string[]) {
    if (!ids.length) return;
    const ok = await confirmDialog({
      title: `Reject ${ids.length} post${ids.length === 1 ? "" : "s"}?`,
      danger: true,
    });
    if (!ok) return;
    if (await post({ action: "reject", ids })) clearSel();
  }

  async function savePolicy(channel: string, policy: PostingPolicy): Promise<boolean> {
    return post({ action: "policy_set", channel, policy });
  }

  const selectedIds = [...selected];

  return (
    <div style={{ display: "grid", gap: "1rem" }}>
      {/* Tabs */}
      <div style={{ display: "flex", gap: ".4rem", flexWrap: "wrap" }}>
        <TabBtn active={tab === "calendar"} onClick={() => setTab("calendar")} icon={CalendarDays} label="Calendar" />
        <TabBtn active={tab === "approvals"} onClick={() => setTab("approvals")} icon={Inbox} label={`Approvals${approvalQueue.length ? ` (${approvalQueue.length})` : ""}`} />
        <TabBtn active={tab === "policy"} onClick={() => setTab("policy")} icon={SlidersHorizontal} label="Policy" />
        <TabBtn active={tab === "conflicts"} onClick={() => setTab("conflicts")} icon={AlertTriangle} label={`Conflicts${conflicts.length ? ` (${conflicts.length})` : ""}`} />
      </div>

      {err && (
        <div className="card" style={{ borderColor: "var(--error)", color: "var(--error)", fontSize: ".85rem" }}>
          {err}
        </div>
      )}

      {/* ── Calendar tab ──────────────────────────────────────────────── */}
      {tab === "calendar" && (
        <>
          {/* Brand filter chips */}
          {brands.length > 1 && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: ".4rem" }}>
              {brands.map((b) => {
                const on = brandFilter.has(b.id);
                return (
                  <button
                    key={b.id}
                    className={`btn ${on ? "btn-active" : ""}`}
                    onClick={() => toggleBrand(b.id)}
                    style={{ padding: ".25rem .6rem", fontSize: ".8rem" }}
                  >
                    <span style={{ width: 8, height: 8, borderRadius: "50%", background: b.accent, display: "inline-block", marginRight: 6 }} />
                    {b.name}
                  </button>
                );
              })}
              {brandFilter.size > 0 && (
                <button className="btn" onClick={() => setBrandFilter(new Set())} style={{ padding: ".25rem .6rem", fontSize: ".8rem" }}>
                  <X size={13} /> Clear
                </button>
              )}
            </div>
          )}

          {/* Bulk bar */}
          {canManage && selected.size > 0 && (
            <div className="card" style={{ display: "flex", alignItems: "center", gap: ".5rem", flexWrap: "wrap", borderColor: "var(--accent)" }}>
              <strong style={{ fontSize: ".85rem" }}>{selected.size} selected</strong>
              <button className="btn" disabled={busy} onClick={() => bulkReschedule(selectedIds)}><CalendarRange size={14} /> Reschedule</button>
              {canAssign && <button className="btn" disabled={busy} onClick={() => bulkAssign(selectedIds)}><UserPlus size={14} /> Assign</button>}
              <button className="btn btn-primary" disabled={busy} onClick={() => bulkApprove(selectedIds)}><Check size={14} /> Approve</button>
              <button className="btn danger" disabled={busy} onClick={() => bulkReject(selectedIds)}><X size={14} /> Reject</button>
              <button className="btn" onClick={clearSel} style={{ marginLeft: "auto" }}>Clear</button>
            </div>
          )}

          <MonthGrid
            month={month}
            setMonth={setMonth}
            posts={visiblePosts}
            selected={selected}
            onSelect={clickSelect}
            accentOf={accentOf}
            blackoutDates={blackoutDates}
          />
        </>
      )}

      {/* ── Approvals tab ─────────────────────────────────────────────── */}
      {tab === "approvals" && (
        <div className="card">
          <div className="row-title" style={{ display: "flex", alignItems: "center", gap: ".5rem", marginBottom: ".75rem" }}>
            <ShieldCheck size={16} /> Approval queue
            <span className="badge b-neutral"><span className="d" />{approvalQueue.length}</span>
          </div>
          {approvalQueue.length === 0 ? (
            <div style={{ color: "var(--text-secondary)", fontSize: ".85rem" }}>Nothing awaiting sign-off.</div>
          ) : (
            <div style={{ display: "grid", gap: ".5rem" }}>
              {approvalQueue.map((p) => {
                const inBlackout = blackoutDates.has(`${p.channel}|${p.date}`);
                return (
                  <div className="row" key={p.id} style={{ alignItems: "center" }}>
                    <span style={{ width: 8, height: 8, borderRadius: "50%", background: p.accent, display: "inline-block", marginRight: 8, flexShrink: 0 }} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div className="row-title" style={{ fontSize: ".85rem" }}>{p.topic || p.angle || p.id}</div>
                      <div className="row-id">
                        {p.brandName} · {p.platform} · {p.date} {p.time}
                        {inBlackout && (
                          <span className="badge b-err" style={{ marginLeft: 6 }}><span className="d" />blackout</span>
                        )}
                      </div>
                    </div>
                    <span className={`badge ${APPROVAL_BADGE[p.approvalStatus]}`}><span className="d" />{p.approvalStatus}</span>
                    {canManage && (
                      <>
                        <button className="btn btn-primary" disabled={busy} onClick={() => bulkApprove([p.id])}><Check size={13} /></button>
                        <button className="btn danger" disabled={busy} onClick={() => bulkReject([p.id])}><X size={13} /></button>
                      </>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* ── Policy tab ────────────────────────────────────────────────── */}
      {tab === "policy" && (
        <div className="grid cols-2" style={{ gap: "1rem", alignItems: "start" }}>
          {brands.map((b) => {
            const pol = policies.find((p) => p.channel === b.id) ?? { channel: b.id };
            return (
              <PostingPolicyEditor key={b.id} brand={b} policy={pol} canManage={canManage} onSave={savePolicy} />
            );
          })}
          {brands.length === 0 && (
            <div className="card" style={{ color: "var(--text-secondary)" }}>No brands in this workspace yet.</div>
          )}
        </div>
      )}

      {/* ── Conflicts tab ─────────────────────────────────────────────── */}
      {tab === "conflicts" && (
        <ConflictsPanel conflicts={conflicts} canManage={canManage} onReschedule={(ids) => bulkReschedule(ids)} />
      )}
    </div>
  );
}

function TabBtn({ active, onClick, icon: Icon, label }: { active: boolean; onClick: () => void; icon: typeof CalendarDays; label: string }) {
  return (
    <button className={`btn ${active ? "btn-active" : ""}`} onClick={onClick} style={{ display: "inline-flex", alignItems: "center", gap: ".4rem" }}>
      <Icon size={15} /> {label}
    </button>
  );
}

/* A month grid of all brands' posts. Each cell shows brand-accent chips; a chip
   is a selectable post (checkbox semantics via click, shift-range supported).
   Blackout days carry a subtle marker so an admin sees them at a glance. */
function MonthGrid({
  month,
  setMonth,
  posts,
  selected,
  onSelect,
  accentOf,
  blackoutDates,
}: {
  month: Date;
  setMonth: (d: Date) => void;
  posts: AdminPost[];
  selected: Set<string>;
  onSelect: (id: string, ev: { shiftKey: boolean }) => void;
  accentOf: Map<string, string>;
  blackoutDates: Set<string>;
}) {
  const byDate = useMemo(() => {
    const m = new Map<string, AdminPost[]>();
    for (const p of posts) {
      const arr = m.get(p.date) ?? [];
      arr.push(p);
      m.set(p.date, arr);
    }
    return m;
  }, [posts]);

  const year = month.getFullYear();
  const mon = month.getMonth();
  const first = new Date(year, mon, 1);
  const startPad = first.getDay(); // 0=Sun
  const daysInMonth = new Date(year, mon + 1, 0).getDate();
  const today = ymd(new Date());

  const cells: (string | null)[] = [];
  for (let i = 0; i < startPad; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(ymd(new Date(year, mon, d)));
  while (cells.length % 7 !== 0) cells.push(null);

  const label = first.toLocaleDateString(undefined, { month: "long", year: "numeric" });

  return (
    <div className="card">
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: ".75rem" }}>
        <button className="btn" onClick={() => setMonth(new Date(year, mon - 1, 1))}><ChevronLeft size={15} /></button>
        <strong style={{ fontSize: ".95rem" }}>{label}</strong>
        <button className="btn" onClick={() => setMonth(new Date(year, mon + 1, 1))}><ChevronRight size={15} /></button>
      </div>
      <div className="cal-admin-grid" style={{ display: "grid", gridTemplateColumns: "repeat(7, minmax(0, 1fr))", gap: 4 }}>
        {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d) => (
          <div key={d} className="stat-label" style={{ textAlign: "center", paddingBottom: 4 }}>{d}</div>
        ))}
        {cells.map((date, i) => {
          if (!date) return <div key={`pad-${i}`} />;
          const dayPosts = byDate.get(date) ?? [];
          const isBlackout = [...blackoutDates].some((k) => k.endsWith(`|${date}`));
          const isToday = date === today;
          return (
            <div
              key={date}
              style={{
                minHeight: 84,
                padding: 4,
                borderRadius: 8,
                border: `1px solid ${isToday ? "var(--accent)" : "var(--border-subtle)"}`,
                background: isBlackout ? "color-mix(in srgb, var(--error) 8%, transparent)" : "var(--bg-surface)",
                display: "flex",
                flexDirection: "column",
                gap: 3,
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: ".7rem", color: "var(--text-secondary)" }}>
                <span>{Number(date.slice(8, 10))}</span>
                {isBlackout && <span title="blackout" style={{ color: "var(--error)" }}>●</span>}
              </div>
              {dayPosts.slice(0, 4).map((p) => {
                const sel = selected.has(p.id);
                return (
                  <button
                    key={p.id}
                    onClick={(e) => onSelect(p.id, { shiftKey: e.shiftKey })}
                    title={`${p.brandName} · ${p.platform} · ${p.time}\n${p.topic}`}
                    style={{
                      textAlign: "left",
                      fontSize: ".68rem",
                      lineHeight: 1.2,
                      padding: "2px 4px",
                      borderRadius: 5,
                      cursor: "pointer",
                      border: `1px solid ${p.accent}`,
                      borderLeft: `3px solid ${p.accent}`,
                      background: sel ? "color-mix(in srgb, var(--accent) 22%, transparent)" : "transparent",
                      outline: sel ? "1px solid var(--accent)" : "none",
                      color: "var(--text-primary, inherit)",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {p.time} {p.topic || p.platform}
                  </button>
                );
              })}
              {dayPosts.length > 4 && (
                <span style={{ fontSize: ".65rem", color: "var(--text-secondary)" }}>+{dayPosts.length - 4} more</span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
