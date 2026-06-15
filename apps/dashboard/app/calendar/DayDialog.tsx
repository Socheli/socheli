"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { TimePicker } from "../TimePicker";
import { DatePicker } from "../DatePicker";
import { Select } from "../Select";
import { AiThinking } from "../AiThinking";
import { confirmDialog } from "../confirm";
import type { CalendarItem, MetaEntry } from "./DayInteractions";

/* The comprehensive day dialog — a big high-width / high-height modal opened by
   clicking a calendar day (or a single event on it). It's a master-detail view:

     ┌ left rail ────────────┬ right pane ──────────────────────────────┐
     │ all events on the day │ • overview (notes / reminders / AI), or  │
     │ grouped by kind       │ • the selected event opened up, with     │
     │ + notes/reminder count│   inline edit / delete / archive / move  │
     └───────────────────────┴──────────────────────────────────────────┘

   Planned (algo-lab) posts are fully editable here — every field, plus delete,
   archive and move-to-another-date — through /api/plan (the same canonical CRUD
   the plan_* engine tools expose). Scheduled / published runs get a read-only
   detail + a link to their run and a reschedule control. Notes, reminders and
   the per-day AI brainstorm carry over from the old drawer into the overview. */

const CHANNEL_NAMES: Record<string, string> = {
  labrinox: "Labrinox", claude_code_lab: "Code Labrinox", agentic_builder: "Agentic Builder", moltjobs: "MoltJobs", cognitivx: "iCog",
};
const chName = (id: string) => CHANNEL_NAMES[id] ?? (id ? id.replace(/_/g, " ") : "");
const PLATFORM_COLOR: Record<string, string> = { youtube: "#ff4e45", instagram: "#e1306c", tiktok: "#25f4ee", x: "#e7e9ea", linkedin: "#0a66c2", telegram: "#29a9eb" };
const PLATFORM_LABEL: Record<string, string> = { youtube: "YouTube", instagram: "Instagram", tiktok: "TikTok", x: "X", linkedin: "LinkedIn", telegram: "Telegram" };
const PLATFORMS = ["youtube", "instagram", "tiktok", "x", "linkedin", "telegram"];
const PLAN_STATUSES = ["idea", "approved", "scheduled", "generated", "dropped", "archived"];
const WEEKDAYS_FULL = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function prettyDate(ds: string): string {
  const [y, m, d] = ds.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  return `${WEEKDAYS_FULL[dt.getDay()]}, ${MONTHS[m - 1]} ${d}, ${y}`;
}

const KIND_LABEL: Record<CalendarItem["kind"], string> = {
  planned: "Planned", scheduled: "Scheduled", published: "Published", cadence: "Autopilot cadence",
};
const KIND_ORDER: CalendarItem["kind"][] = ["planned", "scheduled", "published", "cadence"];

/* Full planned-post record (superset of CalendarItem), fetched lazily on select. */
type PlannedPost = {
  id: string; date: string; time: string; channel: string; platform: string;
  topic: string; angle: string; format: string; mood?: string; hook?: string;
  rationale: string; algoLever?: string; scores?: Record<string, number>;
  overall?: number; status: string; planRunId: string; createdAt: string; updatedAt?: string;
  assignee?: string; createdBy?: string;
};
type BrainstormIdea = { title: string; angle: string; why: string };

/* A teammate in the workspace (resolved server-side, passed down for assignment). */
export type DialogMember = { userId: string; name: string; imageUrl?: string };

export function DayDialog({
  date, items, entries, channels, defaultChannel, focusItemId, focus,
  onClose, onMetaChange, onPlanChange, members = [], meId = null, canEdit = true,
}: {
  date: string;
  items: CalendarItem[];
  entries: MetaEntry[];
  channels: { id: string; name: string }[];
  defaultChannel: string;
  focusItemId?: string | null;
  focus?: "note" | "reminder" | "prompt" | null;
  onClose: () => void;
  onMetaChange: () => void;
  onPlanChange: () => void;
  members?: DialogMember[];
  meId?: string | null;
  canEdit?: boolean;
}) {
  // null selection → overview; otherwise the CalendarItem.id of the open event.
  const [selId, setSelId] = useState<string | null>(focusItemId ?? null);
  const selected = items.find((i) => i.id === selId) ?? null;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // Escape backs out of an open event first, then closes the dialog.
      if (selId) setSelId(null);
      else onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [selId, onClose]);

  const notes = entries.filter((e) => e.kind === "note");
  const reminders = entries.filter((e) => e.kind === "reminder");
  const grouped = KIND_ORDER.map((k) => ({ kind: k, list: items.filter((i) => i.kind === k) })).filter((g) => g.list.length);

  return (
    <div className="cd-backdrop" onClick={onClose}>
      <div className="cd" role="dialog" aria-label={`Day ${date}`} onClick={(e) => e.stopPropagation()}>
        {/* ── Left rail: every event on the day ─────────────────────────── */}
        <aside className="cd-rail">
          <div className="cd-rail-head">
            <div className="eyebrow" style={{ marginBottom: 4 }}>// day</div>
            <div className="cd-date">{prettyDate(date)}</div>
            <div className="sub" style={{ marginTop: 3, fontSize: 12 }}>
              {items.length} event{items.length === 1 ? "" : "s"} · {notes.length} note{notes.length === 1 ? "" : "s"} · {reminders.length} reminder{reminders.length === 1 ? "" : "s"}
            </div>
          </div>
          <div className="cd-rail-body">
            <button className={`cd-overview-btn${selId === null ? " on" : ""}`} onClick={() => setSelId(null)}>
              <span className="cd-ico">▤</span> Day overview
            </button>
            {grouped.length === 0 ? (
              <div className="sub" style={{ fontSize: 12, padding: "10px 4px" }}>Nothing planned or scheduled yet. Use the overview to brainstorm or plan a brand.</div>
            ) : (
              grouped.map((g) => (
                <div key={g.kind} className="cd-group">
                  <div className="cd-group-label">{KIND_LABEL[g.kind]} · {g.list.length}</div>
                  {g.list.map((it) => {
                    const dot = it.platforms[0] ? PLATFORM_COLOR[it.platforms[0]] : undefined;
                    return (
                      <button key={it.id} className={`cd-event${selId === it.id ? " on" : ""}`} onClick={() => setSelId(it.id)}>
                        {dot ? <span className="cd-dot" style={{ background: dot, boxShadow: `0 0 7px ${dot}` }} /> : <span className="cd-dot" style={{ background: "var(--text-muted)" }} />}
                        <span className="cd-event-time">{it.time || "--:--"}</span>
                        <span className="cd-event-title">{it.title}</span>
                        {typeof it.overall === "number" && (
                          <span className="cd-event-score" style={{ color: it.overall >= 8 ? "var(--success)" : "var(--text-muted)" }}>{it.overall.toFixed(1)}</span>
                        )}
                      </button>
                    );
                  })}
                </div>
              ))
            )}
          </div>
        </aside>

        {/* ── Right pane: overview or the opened event ──────────────────── */}
        <section className="cd-main">
          <button className="cd-x" onClick={onClose} aria-label="Close">✕</button>
          {selected ? (
            <EventDetail
              key={selected.id}
              item={selected}
              channels={channels}
              members={members}
              meId={meId}
              canEdit={canEdit}
              onBack={() => setSelId(null)}
              onChanged={onPlanChange}
              onClosed={(deleted) => { if (deleted) setSelId(null); onPlanChange(); }}
            />
          ) : (
            <Overview
              date={date}
              notes={notes}
              reminders={reminders}
              channels={channels}
              defaultChannel={defaultChannel}
              focus={focus}
              onMetaChange={onMetaChange}
            />
          )}
        </section>
      </div>
    </div>
  );
}

/* ── The opened event: full detail + inline edit / delete / archive / move ── */
function EventDetail({
  item, channels, members, meId, canEdit, onBack, onChanged, onClosed,
}: {
  item: CalendarItem;
  channels: { id: string; name: string }[];
  members: DialogMember[];
  meId: string | null;
  canEdit: boolean;
  onBack: () => void;
  onChanged: () => void;
  onClosed: (deleted: boolean) => void;
}) {
  const isPlanned = item.kind === "planned";
  const planId = item.itemId; // for planned: the PlannedPost id; for scheduled/published: the run id
  const [post, setPost] = useState<PlannedPost | null>(null);
  const [loading, setLoading] = useState(isPlanned);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Partial<PlannedPost>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [moveDate, setMoveDate] = useState(item.date);
  const [moveTime, setMoveTime] = useState(/^\d{2}:\d{2}$/.test(item.time) ? item.time : "09:00");

  // Load the full planned record so the detail shows every field.
  useEffect(() => {
    if (!isPlanned || !planId) return;
    let alive = true;
    setLoading(true);
    fetch(`/api/plan?id=${encodeURIComponent(planId)}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((j: { post: PlannedPost }) => { if (alive) { setPost(j.post); setMoveDate(j.post.date); if (/^\d{2}:\d{2}$/.test(j.post.time)) setMoveTime(j.post.time); } })
      .catch((e) => { if (alive) setErr(e instanceof Error ? e.message : "load failed"); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [isPlanned, planId]);

  const patch = useCallback(async (body: Record<string, unknown>, label: string) => {
    if (!planId) return;
    setBusy(label); setErr(null);
    try {
      const r = await fetch("/api/plan", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: planId, ...body }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
      setPost(j.post);
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "update failed");
    } finally {
      setBusy(null);
    }
  }, [planId, onChanged]);

  const startEdit = () => { if (post) { setDraft({ ...post }); setEditing(true); } };
  const saveEdit = async () => {
    const allowed = ["topic", "angle", "format", "mood", "hook", "rationale", "algoLever", "platform", "status"] as const;
    const body: Record<string, unknown> = {};
    for (const k of allowed) if (draft[k] !== undefined) body[k] = draft[k];
    await patch(body, "save");
    setEditing(false);
  };
  const doArchive = async () => {
    if (!(await confirmDialog({ title: "Archive this post?", message: "It leaves the active plan but stays recoverable (you can set its status back later).", confirmText: "Archive" }))) return;
    await patch({ status: "archived" }, "archive");
  };
  const doUnarchive = () => patch({ status: "idea" }, "unarchive");
  const doDelete = async () => {
    if (!planId) return;
    if (!(await confirmDialog({ title: "Delete this post?", message: "This permanently removes it from the plan. Archive instead if you might want it back.", confirmText: "Delete", danger: true }))) return;
    setBusy("delete"); setErr(null);
    try {
      const r = await fetch(`/api/plan?id=${encodeURIComponent(planId)}`, { method: "DELETE" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      onClosed(true);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "delete failed");
      setBusy(null);
    }
  };
  const doMove = async () => {
    if (moveDate === item.date && moveTime === item.time) { setErr("Pick a different date or time to move."); return; }
    if (isPlanned) {
      await patch({ date: moveDate, time: moveTime }, "move");
    } else if (item.kind === "scheduled" && planId) {
      setBusy("move"); setErr(null);
      try {
        const r = await fetch("/api/schedule/reschedule", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ itemId: planId, newAt: `${moveDate}T${moveTime}:00` }) });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        onChanged();
      } catch (e) {
        setErr(e instanceof Error ? e.message : "reschedule failed");
      } finally {
        setBusy(null);
      }
    }
  };

  const platform = item.platforms[0];
  const dot = platform ? PLATFORM_COLOR[platform] : undefined;

  return (
    <div className="cd-detail">
      <button className="cd-back" onClick={onBack}>‹ All events</button>

      <div className="cd-detail-head">
        {dot && <span className="cd-dot lg" style={{ background: dot, boxShadow: `0 0 10px ${dot}` }} />}
        <div style={{ minWidth: 0 }}>
          <div className="eyebrow" style={{ marginBottom: 4 }}>// {KIND_LABEL[item.kind].toLowerCase()}{platform ? ` · ${PLATFORM_LABEL[platform] ?? platform}` : ""}</div>
          <div className="cd-detail-title">{(post?.topic) ?? item.title}</div>
          <div className="sub" style={{ marginTop: 4, fontSize: 12.5 }}>
            {chName(item.channel)} · {item.time || "--:--"}
            {(post?.status ?? item.planStatus) && <> · <span className="tag">{post?.status ?? item.planStatus}</span></>}
            {typeof (post?.overall ?? item.overall) === "number" && <> · score <b style={{ color: "var(--text-light)" }}>{(post?.overall ?? item.overall)!.toFixed(1)}</b></>}
          </div>
        </div>
      </div>

      {err && <div className="cd-err">{err}</div>}

      <div className="cd-detail-body">
        {/* Non-planned events are runs: read-only detail + a link to open them. */}
        {!isPlanned && (
          <div className="cd-field-block">
            <div className="cd-field-label">This is a {item.kind === "cadence" ? "recurring autopilot slot" : "real run"}</div>
            {item.kind === "cadence" ? (
              <div className="sub" style={{ fontSize: 12.5 }}>Autopilot posts this cadence automatically. Edit the slot time in the scheduler; cadence slots can't be moved per-day from the calendar.</div>
            ) : (
              <>
                <div className="sub" style={{ fontSize: 12.5, marginBottom: 10 }}>Open the run to edit its script, storyboard, render and publishing.</div>
                {planId && <Link href={`/post/${planId}`} className="btn btn-primary" style={{ padding: "8px 15px", fontSize: 12 }}>Open run →</Link>}
              </>
            )}
          </div>
        )}

        {/* Planned posts: full fields, editable inline. */}
        {isPlanned && loading && <div className="sub" style={{ fontSize: 12.5 }}>Loading post…</div>}
        {isPlanned && post && !editing && (
          <>
            <Field label="Angle" value={post.angle} />
            <Field label="Hook" value={post.hook} mono />
            <Field label="Format" value={post.format} />
            <Field label="Algo lever" value={post.algoLever} accent />
            <Field label="Mood" value={post.mood} />
            <Field label="Rationale" value={post.rationale} />
            {post.scores && Object.keys(post.scores).length > 0 && (
              <div className="cd-field-block">
                <div className="cd-field-label">Scores</div>
                <div className="cd-scores">
                  {Object.entries(post.scores).map(([k, v]) => (
                    <div key={k} className="cd-score"><span>{k}</span><b>{typeof v === "number" ? v.toFixed(1) : String(v)}</b></div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}

        {/* Inline edit form. */}
        {isPlanned && post && editing && (
          <div className="cd-edit">
            <EditField label="Topic" value={draft.topic ?? ""} onChange={(v) => setDraft((d) => ({ ...d, topic: v }))} />
            <EditField label="Angle" value={draft.angle ?? ""} onChange={(v) => setDraft((d) => ({ ...d, angle: v }))} />
            <EditField label="Hook" value={draft.hook ?? ""} onChange={(v) => setDraft((d) => ({ ...d, hook: v }))} />
            <div className="cd-edit-row">
              <SelectField label="Platform" value={draft.platform ?? ""} options={PLATFORMS} render={(p) => PLATFORM_LABEL[p] ?? p} onChange={(v) => setDraft((d) => ({ ...d, platform: v }))} />
              <SelectField label="Status" value={draft.status ?? ""} options={PLAN_STATUSES} onChange={(v) => setDraft((d) => ({ ...d, status: v }))} />
            </div>
            <div className="cd-edit-row">
              <EditField label="Format" value={draft.format ?? ""} onChange={(v) => setDraft((d) => ({ ...d, format: v }))} />
              <EditField label="Mood" value={draft.mood ?? ""} onChange={(v) => setDraft((d) => ({ ...d, mood: v }))} />
            </div>
            <EditField label="Algo lever" value={draft.algoLever ?? ""} onChange={(v) => setDraft((d) => ({ ...d, algoLever: v }))} />
            <EditField label="Rationale" value={draft.rationale ?? ""} onChange={(v) => setDraft((d) => ({ ...d, rationale: v }))} textarea />
          </div>
        )}

        {/* Assignee — hand a planned post to a teammate. Visible to everyone (so
            you can see who owns it); editable only with calendar.edit. */}
        {isPlanned && post && members.length > 0 && (
          <div className="cd-field-block">
            <div className="cd-field-label">Assigned to</div>
            <div className="cd-move">
              <SelectField
                label=""
                value={post.assignee ?? ""}
                options={["", ...members.map((m) => m.userId)]}
                render={(uid) => (uid ? (members.find((m) => m.userId === uid)?.name ?? uid) + (uid === meId ? " (you)" : "") : "Unassigned")}
                onChange={(v) => { if (canEdit) void patch({ assignee: v }, "assign"); }}
              />
              {busy === "assign" && <span className="sub" style={{ fontSize: 11 }}>Saving…</span>}
            </div>
            {post.createdBy && (
              <div className="sub" style={{ fontSize: 11, marginTop: 6 }}>
                Created by {members.find((m) => m.userId === post.createdBy)?.name ?? post.createdBy}{post.createdBy === meId ? " (you)" : ""}
              </div>
            )}
            {!canEdit && <div className="sub" style={{ fontSize: 11, marginTop: 6 }}>You don't have permission to reassign.</div>}
          </div>
        )}

        {/* Move-to-another-date — works for planned and scheduled runs. */}
        {canEdit && (isPlanned || item.kind === "scheduled") && (
          <div className="cd-field-block">
            <div className="cd-field-label">Move</div>
            <div className="cd-move">
              <DatePicker value={moveDate} onChange={setMoveDate} ariaLabel="Move date" />
              <TimePicker value={moveTime} onChange={setMoveTime} ariaLabel="Move time" />
              <button className="btn" onClick={doMove} disabled={busy === "move"} style={{ padding: "8px 14px", fontSize: 12 }}>{busy === "move" ? "Moving…" : "Move"}</button>
            </div>
            <div className="sub" style={{ fontSize: 11, marginTop: 6 }}>Tip: you can also drag the chip to another day right on the calendar.</div>
          </div>
        )}
      </div>

      {/* Action bar — planned posts only (runs are edited on their own page).
          Edit/archive/delete require calendar.edit; a viewer sees read-only detail. */}
      {isPlanned && post && canEdit && (
        <div className="cd-actions">
          {editing ? (
            <>
              <button className="btn btn-primary" onClick={saveEdit} disabled={busy === "save"} style={{ padding: "9px 16px", fontSize: 12 }}>{busy === "save" ? "Saving…" : "Save changes"}</button>
              <button className="btn" onClick={() => setEditing(false)} style={{ padding: "9px 14px", fontSize: 12 }}>Cancel</button>
            </>
          ) : (
            <>
              <button className="btn btn-primary" onClick={startEdit} style={{ padding: "9px 16px", fontSize: 12 }}>Edit</button>
              {post.status === "archived" ? (
                <button className="btn" onClick={doUnarchive} disabled={busy === "unarchive"} style={{ padding: "9px 14px", fontSize: 12 }}>{busy === "unarchive" ? "…" : "Unarchive"}</button>
              ) : (
                <button className="btn" onClick={doArchive} disabled={busy === "archive"} style={{ padding: "9px 14px", fontSize: 12 }}>{busy === "archive" ? "…" : "Archive"}</button>
              )}
              <span style={{ flex: 1 }} />
              <button className="bw-btn danger sm" onClick={doDelete} disabled={busy === "delete"}>{busy === "delete" ? "…" : "Delete"}</button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function Field({ label, value, mono, accent }: { label: string; value?: string; mono?: boolean; accent?: boolean }) {
  if (!value) return null;
  return (
    <div className="cd-field-block">
      <div className="cd-field-label">{label}</div>
      <div className="cd-field-value" style={{ fontFamily: mono ? "var(--font-mono)" : undefined, color: accent ? "var(--accent)" : undefined, fontSize: mono ? 12.5 : 13.5 }}>{value}</div>
    </div>
  );
}
function EditField({ label, value, onChange, textarea }: { label: string; value: string; onChange: (v: string) => void; textarea?: boolean }) {
  return (
    <label className="cd-edit-field">
      <span className="cd-field-label">{label}</span>
      {textarea ? (
        <textarea className="input" value={value} onChange={(e) => onChange(e.target.value)} rows={2} style={{ width: "100%", padding: "8px 11px", fontSize: 13, resize: "vertical" }} />
      ) : (
        <input className="input" value={value} onChange={(e) => onChange(e.target.value)} style={{ width: "100%", padding: "8px 11px", fontSize: 13 }} />
      )}
    </label>
  );
}
function SelectField({ label, value, options, onChange, render }: { label: string; value: string; options: string[]; onChange: (v: string) => void; render?: (v: string) => string }) {
  return (
    <label className="cd-edit-field">
      {label && <span className="cd-field-label">{label}</span>}
      <Select
        value={value}
        onChange={onChange}
        options={options.map((o) => ({ value: o, label: render ? render(o) : o }))}
        width="100%"
        ariaLabel={label || undefined}
      />
    </label>
  );
}

/* ── Day overview: notes + reminders + per-day AI brainstorm (from the drawer) ── */
function Overview({
  date, notes, reminders, channels, defaultChannel, focus, onMetaChange,
}: {
  date: string;
  notes: MetaEntry[];
  reminders: MetaEntry[];
  channels: { id: string; name: string }[];
  defaultChannel: string;
  focus?: "note" | "reminder" | "prompt" | null;
  onMetaChange: () => void;
}) {
  const brandOptions = channels.length ? channels : [];
  const [channel, setChannel] = useState(defaultChannel !== "all" ? defaultChannel : brandOptions[0]?.id ?? "labrinox");
  const [noteText, setNoteText] = useState("");
  const [remText, setRemText] = useState("");
  const [remTime, setRemTime] = useState("09:00");
  const [prompt, setPrompt] = useState("");
  const [ideas, setIdeas] = useState<BrainstormIdea[]>([]);
  const [thinking, setThinking] = useState(false);
  const [promptErr, setPromptErr] = useState<string | null>(null);
  const noteRef = useRef<HTMLInputElement>(null);
  const remRef = useRef<HTMLInputElement>(null);
  const promptRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const t = setTimeout(() => {
      if (focus === "note") noteRef.current?.focus();
      else if (focus === "reminder") remRef.current?.focus();
      else if (focus === "prompt") promptRef.current?.focus();
    }, 200);
    return () => clearTimeout(t);
  }, [focus]);

  const post = async (body: object) => {
    await fetch("/api/calendar/meta", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    onMetaChange();
  };
  const addNote = async () => { if (!noteText.trim()) return; await post({ date, kind: "note", text: noteText.trim(), channel }); setNoteText(""); };
  const addReminder = async () => { if (!remText.trim()) return; await post({ date, kind: "reminder", text: remText.trim(), remindAt: remTime, channel }); setRemText(""); };
  const toggleDone = async (e: MetaEntry) => {
    await fetch("/api/calendar/meta", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: e.id, done: !e.done }) });
    onMetaChange();
  };
  const del = async (id: string) => { await fetch(`/api/calendar/meta?id=${encodeURIComponent(id)}`, { method: "DELETE" }); onMetaChange(); };
  const runPrompt = async () => {
    if (!prompt.trim()) return;
    setThinking(true); setPromptErr(null); setIdeas([]);
    try {
      const r = await fetch("/api/calendar/prompt", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt: prompt.trim(), channel, date }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
      setIdeas(Array.isArray(j.ideas) ? j.ideas : []);
    } catch (e) {
      setPromptErr(e instanceof Error ? e.message : "brainstorm failed");
    } finally {
      setThinking(false);
    }
  };
  const ideaToNote = async (i: BrainstormIdea) => { await post({ date, kind: "note", text: i.title, channel }); };

  return (
    <div className="cd-overview">
      <div className="cd-detail-head" style={{ marginBottom: 4 }}>
        <div>
          <div className="eyebrow" style={{ marginBottom: 4 }}>// overview</div>
          <div className="cd-detail-title">{prettyDate(date)}</div>
        </div>
      </div>

      {brandOptions.length > 0 && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 4 }}>
          <span className="cd-field-label" style={{ margin: 0 }}>Brand</span>
          {brandOptions.map((c) => (
            <button key={c.id} onClick={() => setChannel(c.id)} className={`chan-tab${channel === c.id ? " on" : ""}`} style={{ fontSize: 11 }}>{c.name}</button>
          ))}
        </div>
      )}

      {/* notes */}
      <div className="cd-field-block">
        <div className="cd-field-label">Notes</div>
        <div style={{ display: "grid", gap: 6 }}>
          {notes.map((n) => (
            <div key={n.id} className="dd-row">
              <span style={{ color: "var(--text-muted)", flexShrink: 0 }}>✎</span>
              <span style={{ flex: 1 }}>{n.text}</span>
              {n.channel && <span className="tag" style={{ flexShrink: 0 }}>{chName(n.channel)}</span>}
              <button className="dd-del" onClick={() => del(n.id)} title="Delete">✕</button>
            </div>
          ))}
        </div>
        <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
          <input ref={noteRef} className="input" placeholder="Write a note for this day…" value={noteText} onChange={(e) => setNoteText(e.target.value)} onKeyDown={(e) => e.key === "Enter" && addNote()} style={{ flex: 1, padding: "9px 12px", fontSize: 13 }} />
          <button className="btn" onClick={addNote} disabled={!noteText.trim()} style={{ padding: "9px 14px", fontSize: 12 }}>Add</button>
        </div>
      </div>

      {/* reminders */}
      <div className="cd-field-block">
        <div className="cd-field-label">Reminders</div>
        <div style={{ display: "grid", gap: 6 }}>
          {reminders.map((r) => (
            <div key={r.id} className="dd-row" style={{ opacity: r.done ? 0.5 : 1 }}>
              <button onClick={() => toggleDone(r)} title={r.done ? "Mark undone" : "Mark done"} style={{ background: "none", border: "none", cursor: "pointer", color: r.done ? "var(--success)" : "var(--text-muted)", flexShrink: 0, fontSize: 13 }}>{r.done ? "☑" : "☐"}</button>
              <span style={{ fontFamily: "var(--font-mono)", fontSize: 10.5, color: "var(--accent)", flexShrink: 0 }}>{r.remindAt || "--:--"}</span>
              <span style={{ flex: 1, textDecoration: r.done ? "line-through" : "none" }}>{r.text}</span>
              <button className="dd-del" onClick={() => del(r.id)} title="Delete">✕</button>
            </div>
          ))}
        </div>
        <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
          <input ref={remRef} className="input" placeholder="Remind me to…" value={remText} onChange={(e) => setRemText(e.target.value)} onKeyDown={(e) => e.key === "Enter" && addReminder()} style={{ flex: 1, padding: "9px 12px", fontSize: 13 }} />
          <TimePicker value={remTime} onChange={setRemTime} ariaLabel="Reminder time" />
          <button className="btn" onClick={addReminder} disabled={!remText.trim()} style={{ padding: "9px 14px", fontSize: 12 }}>Add</button>
        </div>
      </div>

      {/* AI prompt */}
      <div className="cd-field-block">
        <div className="cd-field-label">✦ Prompt this day</div>
        <textarea ref={promptRef} className="input" placeholder={`What should ${chName(channel)} post on this day? Break it down…`} value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={2} style={{ width: "100%", padding: "10px 12px", fontSize: 13, resize: "vertical" }} />
        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 8 }}>
          <button className="btn btn-primary" onClick={runPrompt} disabled={thinking || !prompt.trim()} style={{ padding: "9px 16px", fontSize: 12 }}>{thinking ? "Thinking…" : "✦ Brainstorm ideas"}</button>
        </div>
        {promptErr && <div className="sub" style={{ color: "var(--error)", marginTop: 8, fontSize: 12 }}>{promptErr}</div>}
        {thinking && ideas.length === 0 && (
          <AiThinking phases={["Reading the brief + brand…", "Researching angles…", "Shaping ideas for the day…"]} lines={3} />
        )}
        {ideas.length > 0 && (
          <div style={{ display: "grid", gap: 8, marginTop: 12 }}>
            {ideas.map((i, k) => (
              <div key={k} className="dd-idea">
                <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-light)" }}>{i.title}</div>
                    <div className="sub" style={{ fontSize: 12, marginTop: 2 }}>{i.angle}</div>
                    {i.why && <div style={{ fontSize: 11.5, color: "var(--text-muted)", marginTop: 4 }}>{i.why}</div>}
                  </div>
                  <button className="btn" onClick={() => ideaToNote(i)} style={{ padding: "5px 10px", fontSize: 11, flexShrink: 0 }}>+ note</button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
