"use client";
import { useState, type CSSProperties } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Wrench, Terminal, ArrowLeftRight, AlertTriangle, type LucideIcon } from "lucide-react";
import { can, roleAtLeast, type Role } from "@os/schemas";
import { Select } from "../Select";
import { alertDialog } from "../confirm";
import { InkIcon } from "../../components/sketch";

/* The four content formats, each with a friendly label + mark (mirrors the
   /new builder's format cards) so the board reads as a designed surface, not a
   raw enum dump. */
const FORMAT_META: Record<string, { label: string; icon: LucideIcon }> = {
  mistake_fix: { label: "Mistake → Fix", icon: Wrench },
  terminal_tip: { label: "Terminal Tip", icon: Terminal },
  before_after: { label: "Before / After", icon: ArrowLeftRight },
  architecture_warning: { label: "Architecture Warning", icon: AlertTriangle },
};
function FormatChip({ format }: { format: string }) {
  const meta = FORMAT_META[format] ?? { label: format.replace(/_/g, " "), icon: ArrowLeftRight };
  const Icon = meta.icon;
  return (
    <span className="cb-fmt" title={`Format: ${meta.label}`}>
      <Icon size={12} strokeWidth={1.9} />
      <span>{meta.label}</span>
    </span>
  );
}

type Comment = { at: string; text: string };
type Concept = {
  id: string;
  channel: string;
  topic: string;
  angle: string;
  format: string;
  rationale: string;
  scores: Record<string, number>;
  overall: number;
  pick: boolean;
  mood?: string;
  status: string;
  comments: Comment[];
  createdAt: string;
  createdBy?: string;
  author?: string; // "you" or the author id, resolved server-side for display
  run?: { id: string; hasVideo: boolean; status: string };
};

const CHANNELS = [
  { id: "labrinox", name: "Labrinox" },
  { id: "claude_code_lab", name: "Code Labrinox" },
  { id: "agentic_builder", name: "Agentic Builder" },
  { id: "moltjobs", name: "MoltJobs" },
  { id: "cognitivx", name: "iCog by CognitivX" },
];
const MOODS = [
  { id: "explainer", name: "Explainer" },
  { id: "motivational", name: "Motivational" },
  { id: "business", name: "Business & Finance" },
  { id: "tech", name: "Tech & AI" },
  { id: "mindfulness", name: "Mindfulness" },
];
// Content clusters each channel offers (mirror of channels.ts — first is the default).
const CHANNEL_MOODS: Record<string, string[]> = {
  labrinox: ["explainer", "mindfulness", "motivational", "business", "tech"],
  claude_code_lab: ["tech", "explainer"],
  agentic_builder: ["tech", "business"],
  moltjobs: ["tech", "business", "explainer", "motivational"],
  cognitivx: ["tech", "explainer", "mindfulness", "business"],
};
const moodName = (id?: string) => MOODS.find((m) => m.id === id)?.name ?? "Explainer";
const moodsForChannel = (ch: string) => {
  const ids = CHANNEL_MOODS[ch] ?? MOODS.map((m) => m.id);
  return MOODS.filter((m) => ids.includes(m.id)).sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
};
const STATUS_CLASS: Record<string, string> = { new: "b-neutral", approved: "b-ok", rejected: "b-err", generated: "b-accent" };
const scoreColor = (n: number) => (n >= 8 ? "var(--success)" : n >= 6 ? "var(--warning)" : "var(--error)");

function Card({ c, role, userId, i = 0 }: { c: Concept; role: Role; userId: string | null; i?: number }) {
  const router = useRouter();
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState("");
  const channelMoods = moodsForChannel(c.channel);
  const [mood, setMood] = useState(c.mood && channelMoods.some((m) => m.id === c.mood) ? c.mood : channelMoods[0].id);

  // Role gating (mirrors the route handlers). Comments are open to any member;
  // status/generate need edit rights, scoped to ownership for non-admins.
  const isOwner = !!userId && c.createdBy === userId;
  const canComment = roleAtLeast(role, "member");
  const canEdit = can(role, "content.edit.own", { isOwnerOfRecord: isOwner });
  const canCreate = can(role, "content.create");

  const post = async (url: string, body: object, tag: string) => {
    setBusy(tag);
    await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    setBusy("");
    router.refresh();
  };
  const addComment = async () => {
    if (!comment.trim()) return;
    await post("/api/concepts/comment", { id: c.id, text: comment.trim() }, "comment");
    setComment("");
  };
  const generate = async () => {
    setBusy("generate");
    const r = await fetch("/api/generate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ seed: c.topic, channel: c.channel, voice: true, mood }) }).catch(() => null);
    const data = await r?.json().catch(() => ({}));
    if (!r || !r.ok) {
      setBusy("");
      await alertDialog({ title: "Couldn't start generation", message: `${data?.error ?? "The engine didn't accept the job."} Nothing was queued.`, danger: true });
      return;
    }
    await fetch("/api/concepts/status", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: c.id, status: "generated" }) });
    setBusy("");
    router.push("/queue");
  };

  return (
    <div
      className={`card cb-card blk-in${c.pick ? " cb-pick" : ""}${c.status === "rejected" ? " cb-rejected" : ""}`}
      style={{ "--i": i + 1 } as CSSProperties}
    >
      <div className="cb-head">
        <div className="cb-score" title={`Overall ${c.overall.toFixed(1)} / 10`}>
          {c.pick && <InkIcon name="glyph" size={13} className="cb-pick-star" title="Top pick" />}
          <span className="cb-score-n" style={{ color: scoreColor(c.overall) }}>{c.overall.toFixed(1)}</span>
          <span className="cb-score-d">/10</span>
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="cb-chips">
            {c.pick && <span className="badge b-accent"><span className="d" />top pick</span>}
            <span className={`badge ${STATUS_CLASS[c.status] ?? "b-neutral"}`}><span className="d" />{c.status}</span>
            <FormatChip format={c.format} />
            <span className="tag" title="suggested mood">◐ {moodName(mood)}</span>
            <span className="row-id" style={{ width: "auto" }}>{CHANNELS.find((x) => x.id === c.channel)?.name ?? c.channel}</span>
            {c.author && <span className="row-id" style={{ width: "auto" }} title="proposed by">by {c.author === "you" ? "you" : c.author.slice(0, 12)}</span>}
          </div>
          <div className="cb-topic">{c.topic}</div>
          <div className="sub cb-angle">{c.angle}</div>
        </div>
      </div>

      {/* score bars */}
      <div className="cb-score-grid" style={{ marginTop: 14, display: "grid", gridTemplateColumns: "1fr 1fr", gap: "6px 24px" }}>
        {Object.entries(c.scores).map(([k, v]) => (
          <div key={k} style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontFamily: "var(--font-mono)", fontSize: 10.5, color: "var(--text-muted)", width: 96 }}>{k.replace(/_/g, " ")}</span>
            <div className="qa-track" style={{ flex: 1 }}><div className="qa-fill" style={{ width: `${v * 10}%`, background: scoreColor(v) }} /></div>
            <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-light)", width: 18, textAlign: "right" }}>{v}</span>
          </div>
        ))}
      </div>

      <div style={{ marginTop: 12, fontSize: 13, color: "var(--text-secondary)", lineHeight: 1.5 }}>{c.rationale}</div>

      {/* comments */}
      {c.comments.length > 0 && (
        <div style={{ marginTop: 14, borderTop: "1px solid var(--border-subtle)", paddingTop: 12 }}>
          {c.comments.map((cm, i) => (
            <div key={i} style={{ fontSize: 13, color: "var(--text-light)", marginBottom: 6 }}>
              <span style={{ fontFamily: "var(--font-mono)", fontSize: 10.5, color: "var(--text-muted)", marginRight: 8 }}>{cm.at.slice(5, 16).replace("T", " ")}</span>
              {cm.text}
            </div>
          ))}
        </div>
      )}

      {/* actions */}
      {c.status === "generated" ? (
        // Already generated → video-centric actions, not approve/reject/generate.
        <div style={{ marginTop: 14, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          {canComment && <input className="input" placeholder="Add a note…" value={comment} onChange={(e) => setComment(e.target.value)} onKeyDown={(e) => e.key === "Enter" && addComment()} style={{ flex: 1, minWidth: 180, padding: "9px 13px", fontSize: 13 }} />}
          {canComment && <button onClick={addComment} disabled={!comment.trim() || !!busy} className="btn" style={{ padding: "9px 14px", fontSize: 12 }}>Comment</button>}
          {c.run?.hasVideo ? (
            <>
              <Link href={`/post/${c.run.id}`} className="btn" style={{ padding: "9px 14px", fontSize: 12, color: "var(--accent)", borderColor: "var(--accent-muted, var(--accent))" }}>▶ Watch video</Link>
              <Link href={`/post/${c.run.id}/edit`} className="btn" style={{ padding: "9px 14px", fontSize: 12 }}>Edit</Link>
            </>
          ) : (
            <Link href={c.run ? `/post/${c.run.id}` : "/queue"} className="btn" style={{ padding: "9px 14px", fontSize: 12 }}>{c.run ? "View run →" : "Open queue →"}</Link>
          )}
          {canCreate && <button onClick={generate} disabled={!!busy} className="btn" style={{ padding: "9px 14px", fontSize: 12 }}>{busy === "generate" ? "Starting…" : "↻ Regenerate"}</button>}
        </div>
      ) : (
        <div style={{ marginTop: 14, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          {canComment && <input className="input" placeholder="Add a comment / direction…" value={comment} onChange={(e) => setComment(e.target.value)} onKeyDown={(e) => e.key === "Enter" && addComment()} style={{ flex: 1, minWidth: 200, padding: "9px 13px", fontSize: 13 }} />}
          {canComment && <button onClick={addComment} disabled={!comment.trim() || !!busy} className="btn" style={{ padding: "9px 14px", fontSize: 12 }}>Comment</button>}
          {canEdit && <button onClick={() => post("/api/concepts/status", { id: c.id, status: "approved" }, "approve")} disabled={!!busy} className="btn" style={{ padding: "9px 14px", fontSize: 12, color: "var(--success)", borderColor: "rgba(95,217,122,0.4)" }}>Approve</button>}
          {canEdit && <button onClick={() => post("/api/concepts/status", { id: c.id, status: "rejected" }, "reject")} disabled={!!busy} className="btn" style={{ padding: "9px 14px", fontSize: 12, color: "var(--error)", borderColor: "rgba(239,83,80,0.4)" }}>Reject</button>}
          {canCreate && <Select value={mood} onChange={setMood} width={160} ariaLabel="Mood"
            options={channelMoods.map((m) => ({ value: m.id, label: m.name }))} />}
          {canCreate && <button onClick={generate} disabled={!!busy} className="btn btn-primary" style={{ padding: "9px 16px", fontSize: 12 }}>{busy === "generate" ? "Starting…" : "Generate video →"}</button>}
        </div>
      )}
    </div>
  );
}

/* Shimmer placeholder shown while a board is being proposed — mirrors a concept
   card's shape so the wait reads as "working", not "nothing happened". */
function SkeletonCard({ i }: { i: number }) {
  return (
    <div className="card" style={{ animation: "fadein .3s ease both", animationDelay: `${i * 70}ms`, opacity: 0.9 }}>
      <div className="ai-think-head" style={{ marginBottom: 14 }}>
        <span className="ai-think-dot" />
        <span style={{ fontSize: 12.5, color: "var(--text-secondary)" }}>Proposing concept…</span>
      </div>
      <div className="ai-think-lines">
        <div className="ai-think-line" style={{ height: 20, width: "68%" }} />
        <div className="ai-think-line" style={{ width: "100%" }} />
        <div className="ai-think-line" style={{ width: "94%" }} />
        <div className="ai-think-line" style={{ width: "82%" }} />
        <div className="ai-think-line" style={{ width: "34%", marginTop: 6 }} />
      </div>
    </div>
  );
}

const TABS: { id: string; label: string; match: (s: string) => boolean }[] = [
  { id: "concept", label: "Concept", match: (s) => s !== "approved" && s !== "generated" && s !== "rejected" }, // new / proposed
  { id: "pending", label: "Pending", match: (s) => s === "approved" }, // approved, awaiting generation
  { id: "generated", label: "Generated", match: (s) => s === "generated" },
  { id: "rejected", label: "Rejected", match: (s) => s === "rejected" },
];

export function ConceptBoard({ concepts, role, userId }: { concepts: Concept[]; role: Role; userId: string | null }) {
  const router = useRouter();
  const [channel, setChannel] = useState("labrinox");
  const [gen, setGen] = useState(false);
  const [tab, setTab] = useState("concept");
  const [filterCh, setFilterCh] = useState("all"); // per-project filter for the displayed concepts
  const canCreate = can(role, "content.create"); // proposing a fresh board creates content

  // Long-form (16:9 YouTube) composer — a topic goes straight to the fleet as a
  // `longform` job (engine generateLongform: chapter-first, render-per-chapter).
  const [lfTopic, setLfTopic] = useState("");
  const [lfChannel, setLfChannel] = useState("labrinox");
  const lfMoods = moodsForChannel(lfChannel);
  const [lfMood, setLfMood] = useState(lfMoods[0].id);
  const [lfBusy, setLfBusy] = useState(false);
  const [lfMsg, setLfMsg] = useState("");

  const generateLongform = async () => {
    const topic = lfTopic.trim();
    if (!topic) return;
    setLfBusy(true);
    setLfMsg("");
    const r = await fetch("/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ seed: topic, channel: lfChannel, mood: lfMood, type: "longform" }),
    }).catch(() => null);
    const data = await r?.json().catch(() => ({}));
    setLfBusy(false);
    if (r?.ok) {
      setLfMsg(data?.device ? `dispatched → ${data.device}` : "started — watch the queue");
      setLfTopic("");
    } else {
      setLfMsg(data?.error ? `error: ${data.error}` : "failed to start");
    }
  };

  const generateBoard = async () => {
    setGen(true);
    const r = await fetch("/api/concepts", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ channel, n: 5 }) }).catch(() => null);
    const data = await r?.json().catch(() => ({}));
    setGen(false);
    // surface failures instead of silently doing nothing (e.g. the brain provider
    // returned no concepts). Empty result counts as a failure worth flagging.
    const produced = Array.isArray(data?.concepts) ? data.concepts.length : data?.count ?? (r?.ok ? -1 : 0);
    if (!r?.ok || produced === 0) {
      await alertDialog({ title: "Couldn't propose concepts", message: data?.error ?? "The engine returned no concepts. The brain provider may have failed — check that the API runs with BRAIN_PROVIDER=claude.", danger: true });
      return;
    }
    router.refresh();
  };

  const inChannel = (c: Concept) => filterCh === "all" || c.channel === filterCh;
  const count = (t: (typeof TABS)[number]) => concepts.filter((c) => inChannel(c) && t.match(c.status)).length;
  const active = TABS.find((t) => t.id === tab) ?? TABS[0];
  const shown = concepts.filter((c) => inChannel(c) && active.match(c.status));

  return (
    <>
      {canCreate && (
        <div className="card" style={{ marginBottom: 20, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <span className="stat-label">Generate a new board:</span>
          {CHANNELS.map((c) => (
            <button key={c.id} onClick={() => setChannel(c.id)} className={`btn${channel === c.id ? " btn-primary" : ""}`} style={{ padding: "8px 14px", fontSize: 12 }}>{c.name}</button>
          ))}
          <button onClick={generateBoard} disabled={gen} className="btn btn-primary" style={{ marginLeft: "auto", opacity: gen ? 0.6 : 1 }}>
            {gen ? "Thinking… (~30s)" : "✦ Propose 5 concepts"}
          </button>
        </div>
      )}

      {canCreate && (
        <div className="card" style={{ marginBottom: 20, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <span className="stat-label" title="16:9 multi-chapter YouTube video">▶ New long-form video:</span>
          <input
            value={lfTopic}
            onChange={(e) => setLfTopic(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !lfBusy) generateLongform(); }}
            placeholder="topic — e.g. How money really works, from barter to modern banking"
            disabled={lfBusy}
            className="input"
            style={{ flex: "1 1 320px", minWidth: 240, padding: "9px 12px", fontSize: 13 }}
          />
          <Select value={lfChannel} onChange={(v) => { setLfChannel(v); const m = moodsForChannel(v); setLfMood(m[0].id); }} width={150} ariaLabel="Channel"
            options={CHANNELS.map((c) => ({ value: c.id, label: c.name }))} />
          <Select value={lfMood} onChange={setLfMood} width={160} ariaLabel="Mood"
            options={lfMoods.map((m) => ({ value: m.id, label: m.name }))} />
          {lfMsg && <span className="stat-label" style={{ color: lfMsg.startsWith("error") || lfMsg === "failed to start" ? "var(--error)" : "var(--success)" }}>{lfMsg}</span>}
          <button onClick={generateLongform} disabled={lfBusy || !lfTopic.trim()} className="btn btn-primary" style={{ marginLeft: "auto", opacity: lfBusy || !lfTopic.trim() ? 0.6 : 1 }}>
            {lfBusy ? "Dispatching…" : "Generate long-form →"}
          </button>
        </div>
      )}

      {/* per-project filter */}
      <div className="chan-filter" style={{ marginBottom: 14 }}>
        {[{ id: "all", name: "All" }, ...CHANNELS].map((c) => (
          <button key={c.id} onClick={() => setFilterCh(c.id)} className={`chan-tab${filterCh === c.id ? " on" : ""}`}>{c.name}</button>
        ))}
      </div>

      <div className="concept-tabs" style={{ marginBottom: 18 }}>
        {TABS.map((t) => {
          const n = count(t);
          return (
            <button key={t.id} onClick={() => setTab(t.id)} className={`concept-tab${tab === t.id ? " on" : ""}`}>
              {t.label}
              <span className="concept-tab-n">{n}</span>
            </button>
          );
        })}
      </div>

      {/* generating state — shimmer skeletons so a proposed board reads as working */}
      {gen && (
        <div className="grid" style={{ gap: 14, marginBottom: shown.length ? 14 : 0 }}>
          {Array.from({ length: 5 }).map((_, i) => (
            <SkeletonCard key={i} i={i} />
          ))}
        </div>
      )}

      {concepts.length === 0 ? (
        gen ? null : <div className="empty">No concepts yet. Pick a channel and propose a board.</div>
      ) : shown.length === 0 ? (
        gen ? null : <div className="empty">No {active.label.toLowerCase()} concepts.</div>
      ) : (
        <div className="grid" style={{ gap: 14 }}>
          {shown.map((c, i) => (
            <Card key={c.id} c={c} role={role} userId={userId} i={i} />
          ))}
        </div>
      )}
    </>
  );
}
