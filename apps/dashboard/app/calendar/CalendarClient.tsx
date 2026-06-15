"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import type { Role } from "@os/schemas";
import { DayContextMenu, ConnectModal, type MetaEntry } from "./DayInteractions";
import { DayDialog } from "./DayDialog";
import { PageHead } from "../PageHead";

/* A teammate in the workspace (resolved server-side from Clerk). */
export type WorkspaceMember = { userId: string; name: string; email?: string; imageUrl?: string; role: Role };
export type CalendarProps = {
  members: WorkspaceMember[];
  meId: string | null;
  role: Role;
  icsWorkspace: string;
  canEdit: boolean; // calendar.edit
  canPlan: boolean; // plan.run
};

/* P5 — Content calendar. Renders a month (or week) grid with scheduled +
   published posts placed by date, read from /api/calendar (which merges
   data/runs publish[] + data/schedule.json oneOff/cadence). Dark styling to
   match the rest of the dashboard.

   Drag-to-reschedule is wired end-to-end: scheduled one-offs and autopilot
   cadence slots can be dropped onto another day. The drop calls
   PATCH /api/schedule/reschedule (which updates data/schedule.json that the
   scheduler reads) and optimistically moves the chip in local state. Already
   published posts are not reschedulable (they're history). */

type CalendarItem = {
  id: string;
  date: string;
  time: string;
  title: string;
  channel: string;
  platforms: string[];
  kind: "published" | "scheduled" | "cadence" | "planned";
  itemId?: string;
  public?: boolean;
  planStatus?: "idea" | "approved" | "scheduled" | "generated" | "dropped";
  algoLever?: string;
  overall?: number;
  mood?: string;
  assignee?: string; // Clerk user id this post is handed to
  createdBy?: string; // Clerk user id of the author
};
type CalendarData = { hasData: boolean; timezone: string; scheduleEnabled: boolean; items: CalendarItem[] };

const CHANNEL_NAMES: Record<string, string> = {
  labrinox: "Labrinox",
  claude_code_lab: "Code Labrinox",
  agentic_builder: "Agentic Builder",
  moltjobs: "MoltJobs",
  cognitivx: "iCog",
};
const chName = (id: string) => CHANNEL_NAMES[id] ?? (id ? id.replace(/_/g, " ") : "");

// Platform → accent dot (mirrors the Algo Lab / engine platform palette).
const PLATFORM_COLOR: Record<string, string> = {
  youtube: "#ff4e45",
  instagram: "#e1306c",
  tiktok: "#25f4ee",
  x: "#e7e9ea",
  linkedin: "#0a66c2",
  telegram: "#29a9eb",
};
const platformLabel: Record<string, string> = {
  youtube: "YouTube", instagram: "Instagram", tiktok: "TikTok", x: "X", linkedin: "LinkedIn", telegram: "Telegram",
};

/* Stable per-subject color (brand / mood / any tag) — Trello-style labels. Same
   string → same hue every time, tuned for a dark background. */
function tagColor(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return `hsl(${h % 360} 70% 66%)`;
}
/* crisp colored chip: defined fill + bright text + visible colored border */
function tagStyle(c: string): CSSProperties {
  return { background: `color-mix(in srgb, ${c} 24%, transparent)`, color: c, borderColor: `color-mix(in srgb, ${c} 55%, transparent)` };
}


const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

function fmtDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function todayStr(): string {
  return fmtDate(new Date());
}

/* Build a 6-row month grid starting on Monday. */
function monthGrid(year: number, month: number): Date[] {
  const first = new Date(year, month, 1);
  const offset = (first.getDay() + 6) % 7; // Mon=0
  const start = new Date(year, month, 1 - offset);
  return Array.from({ length: 42 }, (_, i) => new Date(start.getFullYear(), start.getMonth(), start.getDate() + i));
}
/* Build a single Mon-Sun week containing `ref`. */
function weekGrid(ref: Date): Date[] {
  const offset = (ref.getDay() + 6) % 7;
  const start = new Date(ref.getFullYear(), ref.getMonth(), ref.getDate() - offset);
  return Array.from({ length: 7 }, (_, i) => new Date(start.getFullYear(), start.getMonth(), start.getDate() + i));
}

/* Tiny media-query hook — SSR-safe (false until mounted), used to switch the
   month grid for a single-column agenda list on phones (≤560px). */
function useMediaQuery(query: string): boolean {
  const [match, setMatch] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const on = () => setMatch(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [query]);
  return match;
}

/* Initials for an avatar fallback. */
function initials(name: string): string {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]?.toUpperCase()).join("") || "?";
}

function ItemChip({ it, dragging, onDragState, onOpen, canEdit, memberOf }: { it: CalendarItem; dragging: boolean; onDragState: (id: string | null) => void; onOpen: (it: CalendarItem) => void; canEdit: boolean; memberOf: (id?: string) => WorkspaceMember | undefined }) {
  // Published posts are immutable history; scheduled one-offs, cadence slots, and
  // planned (algo-lab) ideas can all be moved to another day — but only if the
  // viewer has calendar.edit. A click opens the day dialog straight to this
  // event's detail (where it can be edited/moved).
  const reschedulable = canEdit && (it.kind === "scheduled" || it.kind === "cadence" || it.kind === "planned");
  const assigned = memberOf(it.assignee);
  const planned = it.kind === "planned";
  const platform = it.platforms[0];
  const platColor = platform ? PLATFORM_COLOR[platform] : undefined;
  // card tint + labels key off the platform if there is one, else the brand
  const accent = platColor || (it.channel ? tagColor(it.channel) : "var(--border-interactive)");
  return (
    <div
      role="button"
      tabIndex={0}
      draggable={reschedulable}
      onClick={() => onOpen(it)}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen(it); } }}
      onDragStart={(e) => {
        if (!reschedulable) {
          e.preventDefault();
          return;
        }
        // carry everything the reschedule route needs to identify the item.
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("application/json", JSON.stringify(it));
        e.dataTransfer.setData("text/plain", it.id);
        onDragState(it.id);
      }}
      onDragEnd={() => onDragState(null)}
      title={`${it.time} ${it.title}${it.channel ? " - " + chName(it.channel) : ""}${platform ? " · " + (platformLabel[platform] ?? platform) : ""}${it.algoLever ? "\n algo lever: " + it.algoLever : ""}\n click to open${reschedulable ? " · drag to another day to reschedule" : ""}`}
      className={`cal-chip${planned ? " planned" : ""}${it.kind === "published" ? " done" : ""}${reschedulable ? "" : " static"}${dragging ? " dragging" : ""}`}
      style={{ ["--chip-accent" as any]: accent }}
    >
      <div className="cal-chip-labels">
        {it.channel && <span className="cal-tag" style={tagStyle(tagColor(it.channel))}>{chName(it.channel)}</span>}
        {platform ? (
          <span className="cal-tag" style={tagStyle(platColor || tagColor(platform))}>{platformLabel[platform] ?? platform}</span>
        ) : it.mood ? (
          <span className="cal-tag" style={tagStyle(tagColor(it.mood))}>{it.mood}</span>
        ) : null}
      </div>
      <div className="cal-chip-top">
        <span className="cal-chip-title">{it.title}</span>
        {planned && typeof it.overall === "number" && (
          <span className="cal-chip-score" data-good={it.overall >= 8}>{it.overall.toFixed(1)}</span>
        )}
        {it.kind === "published" && <span className="cal-chip-pub" title="Published">✓</span>}
      </div>
      <div className="cal-chip-meta">
        <span className="cal-chip-time">{it.time || "--:--"}</span>
        <span style={{ flex: 1 }} />
        {assigned && (
          <span
            title={`Assigned to ${assigned.name}`}
            className="cal-chip-assignee"
            style={{
              width: 16, height: 16, borderRadius: "50%", flexShrink: 0,
              display: "inline-flex", alignItems: "center", justifyContent: "center",
              fontSize: 8, fontWeight: 700, lineHeight: 1,
              background: assigned.imageUrl ? "transparent" : tagColor(assigned.userId),
              color: "#0b0b0d", overflow: "hidden", border: "1px solid var(--border-subtle)",
            }}
          >
            {assigned.imageUrl ? <img src={assigned.imageUrl} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} /> : initials(assigned.name)}
          </span>
        )}
      </div>
    </div>
  );
}

export function CalendarClient({ members, meId, role, icsWorkspace, canEdit, canPlan }: CalendarProps) {
  const [data, setData] = useState<CalendarData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<"month" | "week">("month");
  const [filterCh, setFilterCh] = useState("all");
  const [filterMember, setFilterMember] = useState("all"); // "all" | "me" | "unassigned" | <userId>
  const isPhone = useMediaQuery("(max-width: 560px)"); // ≤560px → agenda list instead of grid

  // Quick lookup from a Clerk user id → member record (for avatars / names).
  const memberById = useMemo(() => {
    const m = new Map<string, WorkspaceMember>();
    for (const x of members) m.set(x.userId, x);
    return m;
  }, [members]);
  const memberOf = useCallback((id?: string) => (id ? memberById.get(id) : undefined), [memberById]);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropDate, setDropDate] = useState<string | null>(null);
  const [reschedErr, setReschedErr] = useState<string | null>(null);
  const [meta, setMeta] = useState<MetaEntry[]>([]);
  const [ctxMenu, setCtxMenu] = useState<{ date: string; x: number; y: number } | null>(null);
  const [dialog, setDialog] = useState<{ date: string; focus: "note" | "reminder" | "prompt" | null; itemId?: string | null } | null>(null);
  const [connectOpen, setConnectOpen] = useState(false);
  const [cursor, setCursor] = useState(() => {
    const n = new Date();
    return { year: n.getFullYear(), month: n.getMonth(), ref: n };
  });

  useEffect(() => {
    let alive = true;
    fetch("/api/calendar")
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((d: CalendarData) => {
        if (alive) setData(d);
      })
      .catch((e: unknown) => {
        if (alive) setError(e instanceof Error ? e.message : "failed to load");
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  const refetchCalendar = useCallback(() => {
    fetch("/api/calendar")
      .then((r) => (r.ok ? r.json() : null))
      .then((d: CalendarData | null) => { if (d) setData(d); })
      .catch(() => {});
  }, []);

  const refetchMeta = useCallback(() => {
    fetch("/api/calendar/meta")
      .then((r) => (r.ok ? r.json() : { entries: [] }))
      .then((d: { entries: MetaEntry[] }) => setMeta(d.entries ?? []))
      .catch(() => {});
  }, []);
  useEffect(() => refetchMeta(), [refetchMeta]);

  // Channels actually present in the data, for the brand filter row.
  const channelsPresent = useMemo(() => {
    const s = new Set<string>();
    for (const it of data?.items ?? []) if (it.channel) s.add(it.channel);
    return [...s];
  }, [data]);

  // Does an item pass the active member filter? "me" = assigned to or created by
  // me; "unassigned" = a planned post with no assignee; a userId = theirs.
  const matchesMember = useCallback(
    (it: CalendarItem): boolean => {
      if (filterMember === "all") return true;
      if (filterMember === "unassigned") return it.kind === "planned" && !it.assignee;
      const who = filterMember === "me" ? meId : filterMember;
      if (!who) return false;
      return it.assignee === who || it.createdBy === who;
    },
    [filterMember, meId],
  );

  const byDate = useMemo(() => {
    const m = new Map<string, CalendarItem[]>();
    for (const it of data?.items ?? []) {
      if (filterCh !== "all" && it.channel !== filterCh) continue;
      if (!matchesMember(it)) continue;
      const arr = m.get(it.date) ?? [];
      arr.push(it);
      m.set(it.date, arr);
    }
    return m;
  }, [data, filterCh, matchesMember]);

  const metaByDate = useMemo(() => {
    const m = new Map<string, MetaEntry[]>();
    for (const e of meta) {
      const arr = m.get(e.date) ?? [];
      arr.push(e);
      m.set(e.date, arr);
    }
    return m;
  }, [meta]);

  // Brands offered in the drawer's selector (present in data, else all known).
  const drawerChannels = useMemo(() => {
    const ids = channelsPresent.length ? channelsPresent : Object.keys(CHANNEL_NAMES);
    return ids.map((id) => ({ id, name: chName(id) }));
  }, [channelsPresent]);

  const days = useMemo(
    () => (view === "month" ? monthGrid(cursor.year, cursor.month) : weekGrid(cursor.ref)),
    [view, cursor],
  );

  const heading =
    view === "month"
      ? `${MONTHS[cursor.month]} ${cursor.year}`
      : (() => {
          const w = weekGrid(cursor.ref);
          return `${MONTHS[w[0].getMonth()]} ${w[0].getDate()} - ${w[6].getDate()}`;
        })();

  const step = (dir: number) => {
    setCursor((c) => {
      if (view === "month") {
        const d = new Date(c.year, c.month + dir, 1);
        return { year: d.getFullYear(), month: d.getMonth(), ref: d };
      }
      const r = new Date(c.ref.getFullYear(), c.ref.getMonth(), c.ref.getDate() + dir * 7);
      return { year: r.getFullYear(), month: r.getMonth(), ref: r };
    });
  };
  const goToday = () => {
    const n = new Date();
    setCursor({ year: n.getFullYear(), month: n.getMonth(), ref: n });
  };

  const today = todayStr();

  /* Move a dropped chip onto `targetDate`, keeping its time-of-day, then persist
     through the reschedule route and optimistically update local state. */
  const rescheduleItem = async (it: CalendarItem, targetDate: string) => {
    if (it.date === targetDate) return; // no-op: same day
    if (!canEdit) {
      setReschedErr("You don't have permission to reschedule posts.");
      return;
    }
    setReschedErr(null);
    const time = /^\d{2}:\d{2}$/.test(it.time) ? it.time : "09:00";

    if (it.kind === "scheduled" && it.itemId) {
      const newAt = `${targetDate}T${time}:00`;
      // optimistic move
      setData((d) =>
        d ? { ...d, items: d.items.map((x) => (x.id === it.id ? { ...x, date: targetDate } : x)) } : d,
      );
      try {
        const r = await fetch("/api/schedule/reschedule", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ itemId: it.itemId, newAt }),
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
      } catch (e) {
        setReschedErr(e instanceof Error ? e.message : "reschedule failed");
        // roll back on failure
        setData((d) =>
          d ? { ...d, items: d.items.map((x) => (x.id === it.id ? { ...x, date: it.date } : x)) } : d,
        );
      }
      return;
    }

    if (it.kind === "planned" && it.itemId) {
      // Algo-lab planned ideas persist in data/content-plan.json via /api/plan.
      setData((d) =>
        d ? { ...d, items: d.items.map((x) => (x.id === it.id ? { ...x, date: targetDate } : x)) } : d,
      );
      try {
        const r = await fetch("/api/plan", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: it.itemId, date: targetDate, time }),
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
      } catch (e) {
        setReschedErr(e instanceof Error ? e.message : "reschedule failed");
        setData((d) =>
          d ? { ...d, items: d.items.map((x) => (x.id === it.id ? { ...x, date: it.date } : x)) } : d,
        );
      }
      return;
    }

    if (it.kind === "cadence") {
      // Cadence slots recur every day, so a drop retimes (not moves) them — we
      // don't have a date-specific cadence override, so this is a no-op for the
      // calendar projection. Surface that to the user rather than silently drop.
      setReschedErr("Autopilot cadence slots recur daily — edit slot times in the scheduler.");
      return;
    }
  };

  return (
    <>
      <PageHead
        section="publish"
        title="Content Calendar"
        sub={<>Scheduled and published posts across every channel{data ? ` (${data.timezone})` : ""}. Click a day to open it, right-click for quick actions, or Connect to sync with Google & Notion.</>}
      />

      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 18, flexWrap: "wrap" }}>
        <button className="btn" onClick={() => step(-1)}>
          ‹ Prev
        </button>
        <button className="btn" onClick={goToday}>
          Today
        </button>
        <button className="btn" onClick={() => step(1)}>
          Next ›
        </button>
        <div style={{ fontSize: 16, fontWeight: 600, letterSpacing: "-0.02em", margin: "0 8px" }}>{heading}</div>
        <div style={{ flex: 1 }} />
        <button className={`btn${view === "month" ? " btn-active" : ""}`} onClick={() => setView("month")}>
          Month
        </button>
        <button className={`btn${view === "week" ? " btn-active" : ""}`} onClick={() => setView("week")}>
          Week
        </button>
        <button className="btn" onClick={() => setConnectOpen(true)} style={{ padding: "8px 14px", fontSize: 12 }}>
          ⇄ Connect
        </button>
        {canPlan && (
          <Link href="/plan" className="btn btn-primary" style={{ padding: "8px 14px", fontSize: 12 }}>
            ✦ Plan content →
          </Link>
        )}
      </div>

      {/* Brand filter — track what each channel is posting where. */}
      {channelsPresent.length > 1 && (
        <div className="chan-filter" style={{ marginBottom: 14 }}>
          {[{ id: "all", name: "All brands" }, ...channelsPresent.map((id) => ({ id, name: chName(id) }))].map((c) => (
            <button key={c.id} onClick={() => setFilterCh(c.id)} className={`chan-tab${filterCh === c.id ? " on" : ""}`}>
              {c.name}
            </button>
          ))}
        </div>
      )}

      {/* Member filter — see only what's assigned to / created by a teammate.
          Shown whenever the workspace has more than one member (an org). */}
      {members.length > 1 && (
        <div className="chan-filter" style={{ marginBottom: 14 }}>
          {[
            { id: "all", name: "Everyone" },
            ...(meId ? [{ id: "me", name: "Mine" }] : []),
            { id: "unassigned", name: "Unassigned" },
            ...members.map((m) => ({ id: m.userId, name: m.userId === meId ? `${m.name} (you)` : m.name })),
          ].map((m) => (
            <button key={m.id} onClick={() => setFilterMember(m.id)} className={`chan-tab${filterMember === m.id ? " on" : ""}`}>
              {m.name}
            </button>
          ))}
        </div>
      )}

      <div style={{ display: "flex", gap: 14, marginBottom: 14, flexWrap: "wrap", alignItems: "center" }}>
        <Legend cls="b-ok" label="Published" />
        <Legend cls="b-accent" label="Scheduled" />
        <Legend cls="b-neutral" label="Autopilot cadence" />
        <span className="badge b-neutral" style={{ borderStyle: "dashed" }}><span className="d" />Planned (algo lab)</span>
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: 11, color: "var(--text-muted)" }}>Drag a scheduled or planned chip to reschedule.</span>
      </div>

      {reschedErr && (
        <div className="card" style={{ marginBottom: 14, borderColor: "var(--err, #e35)" }}>
          <div className="sub" style={{ color: "var(--err, #e35)" }}>{reschedErr}</div>
        </div>
      )}

      {loading ? (
        <div className="empty">Loading calendar...</div>
      ) : error ? (
        <div className="empty">Could not load calendar ({error}).</div>
      ) : (
        <>
          {data && !data.hasData && (
            <div className="card" style={{ marginBottom: 16, borderColor: "var(--border-interactive)" }}>
              <div className="stat-label">// empty</div>
              <div className="sub" style={{ marginTop: 8 }}>
                Nothing scheduled or published yet. Set up cadences in the scheduler or publish a post to see it land on a day.
              </div>
            </div>
          )}
          {isPhone ? (
            /* Phone agenda list (≤560px): each day in range that has events or
               notes, as a stacked row → its chips. Cleaner than a ~50px/col grid. */
            <div className="cal-agenda">
              {(() => {
                const rows = days
                  .filter((d) => view === "week" || d.getMonth() === cursor.month)
                  .map((d) => ({ d, ds: fmtDate(d) }))
                  .filter(({ ds }) => (byDate.get(ds)?.length ?? 0) > 0 || (metaByDate.get(ds)?.length ?? 0) > 0);
                if (rows.length === 0) {
                  return <div className="empty">Nothing scheduled this {view}.</div>;
                }
                return rows.map(({ d, ds }) => {
                  const items = byDate.get(ds) ?? [];
                  const dayMeta = metaByDate.get(ds) ?? [];
                  const noteCount = dayMeta.filter((e) => e.kind === "note").length;
                  const reminderCount = dayMeta.filter((e) => e.kind === "reminder" && !e.done).length;
                  const isToday = ds === today;
                  return (
                    <div key={ds} className={`cal-agenda-day${isToday ? " is-today" : ""}`}>
                      <button className="cal-agenda-date" onClick={() => setDialog({ date: ds, focus: null })}>
                        <span className="cal-agenda-dow">{WEEKDAYS[(d.getDay() + 6) % 7]}</span>
                        <span className="cal-agenda-num">{d.getDate()}</span>
                        <span className="cal-agenda-mon">{MONTHS[d.getMonth()].slice(0, 3)}</span>
                        <span style={{ flex: 1 }} />
                        {noteCount > 0 && <span style={{ fontSize: 10, color: "var(--text-muted)" }}>✎{noteCount}</span>}
                        {reminderCount > 0 && <span style={{ fontSize: 10, color: "var(--accent)" }}>⏰{reminderCount}</span>}
                      </button>
                      <div className="cal-agenda-items">
                        {items.map((it) => (
                          <ItemChip key={it.id} it={it} dragging={dragId === it.id} onDragState={setDragId} onOpen={(ev) => setDialog({ date: ds, focus: null, itemId: ev.id })} canEdit={canEdit} memberOf={memberOf} />
                        ))}
                      </div>
                    </div>
                  );
                });
              })()}
            </div>
          ) : (
          <div
            className="cal-grid"
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(7, minmax(0, 1fr))",
              gap: 1,
              background: "var(--border-subtle)",
              border: "1px solid var(--border-subtle)",
              borderRadius: "var(--radius)",
              overflow: "hidden",
            }}
          >
            {WEEKDAYS.map((w) => (
              <div
                key={w}
                className="cal-weekday"
                style={{
                  background: "var(--bg-card)",
                  padding: "8px 12px",
                  fontFamily: "var(--font-mono)",
                  fontSize: 10,
                  letterSpacing: "0.08em",
                  textTransform: "uppercase",
                  color: "var(--text-muted)",
                }}
              >
                {w}
              </div>
            ))}
            {days.map((d) => {
              const ds = fmtDate(d);
              const items = byDate.get(ds) ?? [];
              const dayMeta = metaByDate.get(ds) ?? [];
              const noteCount = dayMeta.filter((e) => e.kind === "note").length;
              const reminderCount = dayMeta.filter((e) => e.kind === "reminder" && !e.done).length;
              const inMonth = view === "week" || d.getMonth() === cursor.month;
              const isToday = ds === today;
              return (
                <div
                  key={ds}
                  className="cal-cell"
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setCtxMenu({ date: ds, x: e.clientX, y: e.clientY });
                  }}
                  onDragOver={(e) => {
                    if (!dragId) return;
                    e.preventDefault();
                    e.dataTransfer.dropEffect = "move";
                    if (dropDate !== ds) setDropDate(ds);
                  }}
                  onDragLeave={() => setDropDate((cur) => (cur === ds ? null : cur))}
                  onDrop={(e) => {
                    e.preventDefault();
                    setDropDate(null);
                    setDragId(null);
                    const raw = e.dataTransfer.getData("application/json");
                    if (!raw) return;
                    try {
                      const it = JSON.parse(raw) as CalendarItem;
                      void rescheduleItem(it, ds);
                    } catch {
                      /* ignore malformed payload */
                    }
                  }}
                  style={{
                    background: dropDate === ds ? "var(--bg-elevated)" : "var(--bg-card)",
                    minHeight: view === "month" ? 116 : 320,
                    padding: 8,
                    opacity: inMonth ? 1 : 0.4,
                    outline: dropDate === ds
                      ? "1px dashed var(--accent)"
                      : isToday
                      ? "1px solid var(--accent-muted)"
                      : "none",
                    outlineOffset: -1,
                    transition: "background 120ms",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}>
                    <button
                      onClick={() => setDialog({ date: ds, focus: null })}
                      title="Open day"
                      style={{
                        fontSize: 12,
                        fontFamily: "var(--font-mono)",
                        color: isToday ? "var(--accent)" : "var(--text-muted)",
                        fontWeight: isToday ? 600 : 400,
                        background: "none",
                        border: "none",
                        cursor: "pointer",
                        padding: "1px 4px",
                        borderRadius: 5,
                        lineHeight: 1.2,
                      }}
                      className="cal-daynum"
                    >
                      {d.getDate()}
                    </button>
                    <span style={{ flex: 1 }} />
                    {noteCount > 0 && (
                      <span title={`${noteCount} note(s)`} style={{ fontSize: 9, color: "var(--text-muted)", display: "inline-flex", alignItems: "center", gap: 2 }}>✎{noteCount}</span>
                    )}
                    {reminderCount > 0 && (
                      <span title={`${reminderCount} reminder(s)`} style={{ fontSize: 9, color: "var(--accent)", display: "inline-flex", alignItems: "center", gap: 2 }}>⏰{reminderCount}</span>
                    )}
                  </div>
                  <div style={{ display: "grid", gap: 4 }}>
                    {items.slice(0, view === "month" ? 3 : 20).map((it) => (
                      <ItemChip key={it.id} it={it} dragging={dragId === it.id} onDragState={setDragId} onOpen={(ev) => setDialog({ date: ds, focus: null, itemId: ev.id })} canEdit={canEdit} memberOf={memberOf} />
                    ))}
                    {view === "month" && items.length > 3 && (
                      <button
                        onClick={() => setDialog({ date: ds, focus: null })}
                        style={{ fontSize: 10, color: "var(--text-muted)", paddingLeft: 4, background: "none", border: "none", cursor: "pointer", textAlign: "left" }}
                      >
                        +{items.length - 3} more
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
          )}
        </>
      )}

      {ctxMenu && (
        <DayContextMenu
          date={ctxMenu.date}
          x={ctxMenu.x}
          y={ctxMenu.y}
          onClose={() => setCtxMenu(null)}
          onOpen={() => setDialog({ date: ctxMenu.date, focus: null })}
          onAddNote={() => setDialog({ date: ctxMenu.date, focus: "note" })}
          onAddReminder={() => setDialog({ date: ctxMenu.date, focus: "reminder" })}
          onPrompt={() => setDialog({ date: ctxMenu.date, focus: "prompt" })}
        />
      )}

      {dialog && (
        <DayDialog
          date={dialog.date}
          focus={dialog.focus}
          focusItemId={dialog.itemId}
          items={byDate.get(dialog.date) ?? []}
          entries={metaByDate.get(dialog.date) ?? []}
          channels={drawerChannels}
          defaultChannel={filterCh}
          members={members}
          meId={meId}
          canEdit={canEdit}
          onClose={() => setDialog(null)}
          onMetaChange={refetchMeta}
          onPlanChange={refetchCalendar}
        />
      )}

      {connectOpen && <ConnectModal onClose={() => setConnectOpen(false)} icsWorkspace={icsWorkspace} />}
    </>
  );
}

function Legend({ cls, label }: { cls: string; label: string }) {
  return (
    <span className={`badge ${cls}`}>
      <span className="d" />
      {label}
    </span>
  );
}
