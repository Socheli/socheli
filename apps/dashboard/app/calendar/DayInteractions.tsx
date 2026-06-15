"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { TimePicker } from "../TimePicker";

/* The interactive layer for the content calendar: a right-click day menu, a
   Notion/Google-style day drawer (items + notes + reminders + AI prompt), and a
   Connect modal (Google via .ics subscribe + Notion sync). Pure client UI; all
   persistence goes through /api/calendar/meta, /api/calendar/prompt, and
   /api/calendar/notion. */

export type CalendarItem = {
  id: string; date: string; time: string; title: string; channel: string;
  platforms: string[]; kind: "published" | "scheduled" | "cadence" | "planned";
  itemId?: string; algoLever?: string; overall?: number; planStatus?: string;
  // team visibility — who a planned post is assigned to / authored by (Clerk ids)
  assignee?: string; createdBy?: string;
};
export type MetaEntry = {
  id: string; date: string; kind: "note" | "reminder"; text: string;
  channel?: string; remindAt?: string; done?: boolean; createdAt: string;
  assignee?: string; createdBy?: string;
};
type BrainstormIdea = { title: string; angle: string; why: string };

const CHANNEL_NAMES: Record<string, string> = {
  labrinox: "Labrinox", claude_code_lab: "Code Labrinox", agentic_builder: "Agentic Builder", moltjobs: "MoltJobs", cognitivx: "iCog",
};
const chName = (id: string) => CHANNEL_NAMES[id] ?? (id ? id.replace(/_/g, " ") : "");
const PLATFORM_COLOR: Record<string, string> = { youtube: "#ff4e45", instagram: "#e1306c", tiktok: "#25f4ee", x: "#e7e9ea", linkedin: "#0a66c2", telegram: "#29a9eb" };
const WEEKDAYS_FULL = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function prettyDate(ds: string): string {
  const [y, m, d] = ds.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  return `${WEEKDAYS_FULL[dt.getDay()]}, ${MONTHS[m - 1]} ${d}, ${y}`;
}

/* ── Right-click day menu ────────────────────────────────────────────────── */
export function DayContextMenu({
  date, x, y, onClose, onOpen, onAddNote, onAddReminder, onPrompt,
}: {
  date: string; x: number; y: number; onClose: () => void;
  onOpen: () => void; onAddNote: () => void; onAddReminder: () => void; onPrompt: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDoc = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) onClose(); };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDoc); document.removeEventListener("keydown", onKey); };
  }, [onClose]);

  // Keep the menu on-screen.
  const left = Math.min(x, (typeof window !== "undefined" ? window.innerWidth : 9999) - 230);
  const top = Math.min(y, (typeof window !== "undefined" ? window.innerHeight : 9999) - 320);

  const act = (fn: () => void) => () => { fn(); onClose(); };
  return (
    <div ref={ref} className="ctx-menu" style={{ left, top }} role="menu">
      <div style={{ padding: "5px 10px 7px", fontFamily: "var(--font-mono)", fontSize: 10.5, color: "var(--text-muted)", letterSpacing: "0.04em" }}>{prettyDate(date)}</div>
      <div className="ctx-sep" />
      <button className="ctx-item" onClick={act(onOpen)}><span className="ctx-ico">▤</span>Open day<span className="ctx-k">↵</span></button>
      <button className="ctx-item" onClick={act(onAddNote)}><span className="ctx-ico">✎</span>Add note</button>
      <button className="ctx-item" onClick={act(onAddReminder)}><span className="ctx-ico">⏰</span>Set reminder</button>
      <button className="ctx-item" onClick={act(onPrompt)}><span className="ctx-ico" style={{ color: "var(--accent)" }}>✦</span>Prompt AI for this day</button>
      <div className="ctx-sep" />
      <Link className="ctx-item" href="/plan" onClick={onClose}><span className="ctx-ico">◆</span>Plan a brand…</Link>
      <Link className="ctx-item" href="/new" onClick={onClose}><span className="ctx-ico">＋</span>New post</Link>
      <button className="ctx-item" onClick={act(() => navigator.clipboard?.writeText(date))}><span className="ctx-ico">⧉</span>Copy date</button>
    </div>
  );
}

/* ── Day drawer ──────────────────────────────────────────────────────────── */
export function DayDrawer({
  date, items, entries, channels, defaultChannel, focus, onClose, onMetaChange,
}: {
  date: string;
  items: CalendarItem[];
  entries: MetaEntry[];
  channels: { id: string; name: string }[];
  defaultChannel: string;
  focus?: "note" | "reminder" | "prompt" | null;
  onClose: () => void;
  onMetaChange: () => void;
}) {
  const notes = entries.filter((e) => e.kind === "note");
  const reminders = entries.filter((e) => e.kind === "reminder");
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
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    const t = setTimeout(() => {
      if (focus === "note") noteRef.current?.focus();
      else if (focus === "reminder") remRef.current?.focus();
      else if (focus === "prompt") promptRef.current?.focus();
    }, 220);
    return () => { document.removeEventListener("keydown", onKey); clearTimeout(t); };
  }, [focus, onClose]);

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
    <>
      <div className="day-drawer-backdrop" onClick={onClose} />
      <aside className="day-drawer" role="dialog" aria-label={`Day ${date}`}>
        <div className="day-drawer-head">
          <div>
            <div className="eyebrow" style={{ marginBottom: 4 }}>// day</div>
            <div style={{ fontSize: 17, fontWeight: 650, letterSpacing: "-0.015em" }}>{prettyDate(date)}</div>
            <div className="sub" style={{ marginTop: 2 }}>{items.length} scheduled · {notes.length} notes · {reminders.length} reminders</div>
          </div>
          <button className="modal-x" onClick={onClose} aria-label="Close">✕</button>
        </div>

        <div className="day-drawer-body">
          {/* brand selector for new notes/reminders/prompts */}
          {brandOptions.length > 0 && (
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <span className="dd-section-label" style={{ margin: 0 }}>Brand</span>
              {brandOptions.map((c) => (
                <button key={c.id} onClick={() => setChannel(c.id)} className={`chan-tab${channel === c.id ? " on" : ""}`} style={{ fontSize: 11 }}>{c.name}</button>
              ))}
            </div>
          )}

          {/* scheduled / planned / published items */}
          <div>
            <div className="dd-section-label">On this day</div>
            {items.length === 0 ? (
              <div className="sub" style={{ fontSize: 12 }}>Nothing scheduled. Use the prompt below or plan a brand.</div>
            ) : (
              <div style={{ display: "grid", gap: 6 }}>
                {items.map((it) => {
                  const dot = it.platforms[0] ? PLATFORM_COLOR[it.platforms[0]] : undefined;
                  const inner = (
                    <div className="dd-row">
                      {dot ? <span style={{ width: 7, height: 7, borderRadius: 2, background: dot, flexShrink: 0 }} /> : <span style={{ width: 7 }} />}
                      <span style={{ fontFamily: "var(--font-mono)", fontSize: 10.5, color: "var(--text-muted)", flexShrink: 0 }}>{it.time || "--:--"}</span>
                      <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{it.title}</span>
                      <span className="tag" style={{ flexShrink: 0 }}>{it.kind}</span>
                    </div>
                  );
                  return it.itemId && (it.kind === "published" || it.kind === "scheduled")
                    ? <Link key={it.id} href={`/post/${it.itemId}`} style={{ textDecoration: "none" }}>{inner}</Link>
                    : <div key={it.id}>{inner}</div>;
                })}
              </div>
            )}
          </div>

          {/* notes */}
          <div>
            <div className="dd-section-label">Notes</div>
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
          <div>
            <div className="dd-section-label">Reminders</div>
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
          <div>
            <div className="dd-section-label">✦ Prompt this day</div>
            <textarea ref={promptRef} className="input" placeholder={`What should ${chName(channel)} post on this day? Break it down…`} value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={2} style={{ width: "100%", padding: "10px 12px", fontSize: 13, resize: "vertical" }} />
            <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 8 }}>
              <button className="btn btn-primary" onClick={runPrompt} disabled={thinking || !prompt.trim()} style={{ padding: "9px 16px", fontSize: 12 }}>{thinking ? "Thinking…" : "✦ Brainstorm ideas"}</button>
            </div>
            {promptErr && <div className="sub" style={{ color: "var(--error)", marginTop: 8, fontSize: 12 }}>{promptErr}</div>}
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
      </aside>
    </>
  );
}

/* ── Connect modal (Google OAuth auto-connect + Apple .ics + Notion) ─────── */
type NotionStatus = { connected: boolean; hasToken: boolean; hasDatabase: boolean; databaseTitle?: string; error?: string };
type GoogleStatus = { connected: boolean; configured: boolean; calendarName?: string };
export function ConnectModal({ onClose, icsWorkspace }: { onClose: () => void; icsWorkspace?: string }) {
  const [origin, setOrigin] = useState("");
  const [copied, setCopied] = useState(false);
  const [notion, setNotion] = useState<NotionStatus | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);

  const [google, setGoogle] = useState<GoogleStatus | null>(null);
  const [gSyncing, setGSyncing] = useState(false);
  const [gMsg, setGMsg] = useState<string | null>(null);

  const loadGoogle = () => fetch("/api/calendar/google").then((r) => (r.ok ? r.json() : null)).then(setGoogle).catch(() => setGoogle(null));

  useEffect(() => {
    setOrigin(window.location.origin);
    fetch("/api/calendar/notion").then((r) => r.json()).then(setNotion).catch(() => setNotion(null));
    loadGoogle();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Embed the workspace token so the public feed serves THIS workspace's events.
  const wsQuery = icsWorkspace && icsWorkspace !== "ws_default" ? `?ws=${encodeURIComponent(icsWorkspace)}` : "";
  const icsUrl = (origin ? `${origin}/api/calendar/ics` : "/api/calendar/ics") + wsQuery;
  const copy = () => { navigator.clipboard?.writeText(icsUrl); setCopied(true); setTimeout(() => setCopied(false), 1500); };
  const syncNotion = async () => {
    setSyncing(true); setSyncMsg(null);
    try {
      const r = await fetch("/api/calendar/notion", { method: "POST" });
      const j = await r.json();
      setSyncMsg(r.ok ? `Synced ${j.created} pages${j.skipped ? `, ${j.skipped} skipped` : ""}.` : (j.error ?? "sync failed"));
    } catch {
      setSyncMsg("sync failed");
    } finally {
      setSyncing(false);
    }
  };
  const syncGoogle = async () => {
    setGSyncing(true); setGMsg(null);
    try {
      const r = await fetch("/api/calendar/google", { method: "POST" });
      const j = await r.json();
      if (r.ok) {
        const parts = [j.created && `${j.created} added`, j.updated && `${j.updated} updated`, j.removed && `${j.removed} removed`].filter(Boolean);
        setGMsg(parts.length ? `Synced — ${parts.join(", ")}.` : "Already up to date.");
      } else setGMsg(j.error ?? "sync failed");
    } catch {
      setGMsg("sync failed");
    } finally {
      setGSyncing(false);
    }
  };
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card" style={{ width: 560 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div>
            <div className="eyebrow" style={{ marginBottom: 4 }}>// connect</div>
            <div className="modal-title">Sync this calendar</div>
          </div>
          <button className="modal-x" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body" style={{ display: "flex", flexDirection: "column", gap: 22 }}>
          {/* Google Calendar — OAuth auto-connect (writes events via the API) */}
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
              <span style={{ width: 9, height: 9, borderRadius: 2, background: "#4285f4", boxShadow: "0 0 8px #4285f4" }} />
              <span style={{ fontSize: 14, fontWeight: 620 }}>Google Calendar</span>
              {google?.connected ? (
                <span className="badge b-ok" style={{ marginLeft: "auto" }}><span className="d" />connected</span>
              ) : (
                <span className="badge b-neutral" style={{ marginLeft: "auto" }}><span className="d" />not connected</span>
              )}
            </div>
            {google?.connected ? (
              <>
                <div className="sub" style={{ fontSize: 12.5, marginBottom: 8 }}>
                  Writing into a dedicated <b>{google.calendarName || "Socheli Content"}</b> calendar via the Calendar API. Each sync adds new posts, updates changed ones, and removes anything dropped.
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <button className="btn btn-primary" onClick={syncGoogle} disabled={gSyncing} style={{ padding: "9px 16px", fontSize: 12 }}>{gSyncing ? "Syncing…" : "Sync now"}</button>
                  {gMsg && <span className="sub" style={{ fontSize: 12, color: gMsg.includes("failed") || gMsg.includes("connect") ? "var(--error)" : undefined }}>{gMsg}</span>}
                </div>
              </>
            ) : (
              <div className="sub" style={{ fontSize: 12.5, lineHeight: 1.7 }}>
                One-time connect (writes the plan straight into Google, no app verification):
                <div style={{ marginTop: 6 }}>
                  1. Create an OAuth <b>Desktop</b> client in Google Cloud (project <span style={{ fontFamily: "var(--font-mono)" }}>your-gcp-project</span>, Calendar API enabled).
                </div>
                <div>
                  2. Put <span style={{ fontFamily: "var(--font-mono)" }}>GOOGLE_CAL_CLIENT_ID</span> + <span style={{ fontFamily: "var(--font-mono)" }}>GOOGLE_CAL_CLIENT_SECRET</span> in <span style={{ fontFamily: "var(--font-mono)" }}>.env</span>.
                </div>
                <div>
                  3. Run <span style={{ fontFamily: "var(--font-mono)", color: "var(--accent)" }}>node scripts/mint-google-cal-token.mjs</span> — consent once, done.
                </div>
              </div>
            )}
          </div>

          <div style={{ height: 1, background: "var(--border-subtle)" }} />

          {/* Apple Calendar & other apps — via ICS subscribe */}
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
              <span style={{ width: 9, height: 9, borderRadius: 2, background: "#fff", boxShadow: "0 0 8px rgba(255,255,255,0.5)" }} />
              <span style={{ fontSize: 14, fontWeight: 620 }}>Apple Calendar &amp; other apps</span>
            </div>
            <div className="sub" style={{ fontSize: 12.5, marginBottom: 8 }}>
              Subscribe to this live feed URL — the same events appear in Apple Calendar (File → New Calendar Subscription) or any app
              that reads an .ics URL, and auto-refresh.
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <input className="input" readOnly value={icsUrl} onFocus={(e) => e.currentTarget.select()} style={{ flex: 1, padding: "9px 12px", fontSize: 12, fontFamily: "var(--font-mono)" }} />
              <button className="btn" onClick={copy} style={{ padding: "9px 14px", fontSize: 12 }}>{copied ? "Copied ✓" : "Copy"}</button>
              <a className="btn" href={icsUrl} download="socheli-content.ics" style={{ padding: "9px 14px", fontSize: 12 }}>Download .ics</a>
            </div>
          </div>

          <div style={{ height: 1, background: "var(--border-subtle)" }} />

          {/* Notion */}
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
              <span style={{ width: 9, height: 9, borderRadius: 2, background: "#fff", boxShadow: "0 0 8px rgba(255,255,255,0.5)" }} />
              <span style={{ fontSize: 14, fontWeight: 620 }}>Notion</span>
              {notion?.connected ? (
                <span className="badge b-ok" style={{ marginLeft: "auto" }}><span className="d" />connected</span>
              ) : (
                <span className="badge b-neutral" style={{ marginLeft: "auto" }}><span className="d" />not connected</span>
              )}
            </div>
            {notion?.connected ? (
              <>
                <div className="sub" style={{ fontSize: 12.5, marginBottom: 8 }}>Pushing into <b>{notion.databaseTitle}</b>. Each planned post becomes a Notion page (title, date, angle, algo lever).</div>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <button className="btn btn-primary" onClick={syncNotion} disabled={syncing} style={{ padding: "9px 16px", fontSize: 12 }}>{syncing ? "Syncing…" : "Sync plan → Notion"}</button>
                  {syncMsg && <span className="sub" style={{ fontSize: 12 }}>{syncMsg}</span>}
                </div>
              </>
            ) : (
              <div className="sub" style={{ fontSize: 12.5 }}>
                Create an internal integration at <span style={{ fontFamily: "var(--font-mono)", color: "var(--accent)" }}>notion.so/my-integrations</span>, share your target database with it,
                then set <span style={{ fontFamily: "var(--font-mono)" }}>NOTION_TOKEN</span> and <span style={{ fontFamily: "var(--font-mono)" }}>NOTION_DATABASE_ID</span> in <span style={{ fontFamily: "var(--font-mono)" }}>.env</span>.
                {notion?.error && <div style={{ color: "var(--error)", marginTop: 6 }}>{notion.error}</div>}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
