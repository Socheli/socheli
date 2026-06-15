"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import { Select } from "../Select";
import { TimePicker } from "../TimePicker";

/* The Algo Lab: a live, visual algorithm-hacking research run. Streams the
   planner's steps over SSE (search → ranking signals → per-platform playbook →
   scored ideas → schedule) and renders them as a growing timeline, then drops a
   dated content slate onto the calendar. */

type PlatformKey = "youtube" | "instagram" | "tiktok" | "x" | "linkedin" | "telegram";
const PLATFORMS: Record<PlatformKey, { label: string; color: string }> = {
  youtube: { label: "YouTube", color: "#ff4e45" },
  instagram: { label: "Instagram", color: "#e1306c" },
  tiktok: { label: "TikTok", color: "#25f4ee" },
  x: { label: "X", color: "#e7e9ea" },
  linkedin: { label: "LinkedIn", color: "#0a66c2" },
  telegram: { label: "Telegram", color: "#29a9eb" },
};

// Brand → platforms (mirrors engine channels.ts socials).
const CHANNELS: { id: string; name: string; platforms: PlatformKey[] }[] = [
  { id: "labrinox", name: "Labrinox", platforms: ["instagram", "x", "youtube"] },
  { id: "claude_code_lab", name: "Code Labrinox", platforms: ["instagram", "x"] },
  { id: "agentic_builder", name: "Agentic Builder", platforms: ["instagram", "x"] },
  { id: "moltjobs", name: "MoltJobs", platforms: ["x", "linkedin", "telegram"] },
  { id: "cognitivx", name: "iCog by CognitivX", platforms: ["x", "linkedin", "instagram"] },
];

type StepKind = "init" | "search" | "signals" | "playbook" | "brief" | "subject" | "cadence" | "ideate" | "schedule" | "done" | "error";
type ResearchStep = {
  id: string;
  kind: StepKind;
  label: string;
  detail?: string;
  platform?: PlatformKey;
  data?: any;
  at: string;
};

const KIND_META: Record<StepKind, { icon: string; color: string }> = {
  init: { icon: "◆", color: "var(--text-light)" },
  search: { icon: "⌕", color: "#9b8cff" },
  signals: { icon: "≈", color: "#f5a623" },
  playbook: { icon: "▤", color: "var(--accent)" },
  brief: { icon: "❖", color: "#9b8cff" },
  subject: { icon: "✸", color: "#f5a623" },
  cadence: { icon: "⌗", color: "#5fd97a" },
  ideate: { icon: "✦", color: "#5fd97a" },
  schedule: { icon: "▦", color: "var(--accent)" },
  done: { icon: "✓", color: "var(--success, #5fd97a)" },
  error: { icon: "!", color: "var(--error, #ef5350)" },
};

function PlatformBadge({ k }: { k: PlatformKey }) {
  const p = PLATFORMS[k];
  return (
    <span
      className="tag"
      style={{ display: "inline-flex", alignItems: "center", gap: 6, borderColor: "var(--border-subtle)" }}
    >
      <span style={{ width: 7, height: 7, borderRadius: 2, background: p.color, boxShadow: `0 0 8px ${p.color}` }} />
      {p.label}
    </span>
  );
}

export function AlgoLab({ canPlan = true }: { canPlan?: boolean }) {
  const [channel, setChannel] = useState("labrinox");
  const [days, setDays] = useState(14);
  const [time, setTime] = useState("09:00");
  const [running, setRunning] = useState(false);
  const [steps, setSteps] = useState<ResearchStep[]>([]);
  const [summary, setSummary] = useState<{ planRunId: string; count: number; usd: number } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const ch = CHANNELS.find((c) => c.id === channel)!;

  const run = async () => {
    if (!canPlan) { setErr("You don't have permission to run the planner."); return; }
    setRunning(true);
    setSteps([]);
    setSummary(null);
    setErr(null);
    const ac = new AbortController();
    abortRef.current = ac;
    try {
      const res = await fetch("/api/plan/research", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channel, days, time }),
        signal: ac.signal,
      });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      // Minimal SSE parser: split on blank lines into event/data pairs.
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let sep: number;
        while ((sep = buf.indexOf("\n\n")) >= 0) {
          const raw = buf.slice(0, sep);
          buf = buf.slice(sep + 2);
          const ev = parseSSE(raw);
          if (!ev) continue;
          if (ev.event === "step") setSteps((s) => [...s, ev.data as ResearchStep]);
          else if (ev.event === "result") setSummary(ev.data as { planRunId: string; count: number; usd: number });
          else if (ev.event === "error") setErr((ev.data as { message?: string }).message ?? "research failed");
        }
      }
    } catch (e) {
      if (!ac.signal.aborted) setErr(e instanceof Error ? e.message : "research failed");
    } finally {
      setRunning(false);
      abortRef.current = null;
    }
  };

  const stop = () => abortRef.current?.abort();

  return (
    <>
      {/* ── Control deck ───────────────────────────────────────────────── */}
      <div className="card" style={{ marginBottom: 18 }}>
        <div className="stat-label" style={{ marginBottom: 10 }}>Brand</div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 16 }}>
          {CHANNELS.map((c) => (
            <button
              key={c.id}
              onClick={() => !running && setChannel(c.id)}
              className={`btn${channel === c.id ? " btn-primary" : ""}`}
              style={{ padding: "8px 14px", fontSize: 12, opacity: running && channel !== c.id ? 0.5 : 1 }}
            >
              {c.name}
            </button>
          ))}
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span className="stat-label">Platforms</span>
            {ch.platforms.map((p) => (
              <PlatformBadge key={p} k={p} />
            ))}
          </div>
          <span style={{ flex: 1 }} />
          <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "var(--text-muted)" }}>
            Window
            <Select
              value={String(days)}
              onChange={(v) => setDays(Number(v))}
              width={110}
              ariaLabel="Planning window"
              options={[7, 14, 21, 30].map((d) => ({ value: String(d), label: `${d} days` }))}
            />
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "var(--text-muted)" }}>
            Time
            <TimePicker value={time} onChange={setTime} width={110} ariaLabel="Default post time" />
          </label>
          {running ? (
            <button onClick={stop} className="btn" style={{ padding: "9px 18px" }}>
              ◼ Stop
            </button>
          ) : (
            <button onClick={run} disabled={!canPlan} className="btn btn-primary" style={{ padding: "9px 18px", opacity: canPlan ? 1 : 0.5, cursor: canPlan ? "pointer" : "not-allowed" }} title={canPlan ? undefined : "You don't have permission to run the planner"}>
              ✦ Run algo research →
            </button>
          )}
        </div>
        {!canPlan && (
          <div className="sub" style={{ fontSize: 11, marginTop: 8 }}>Your role can view the planner but not run it. Ask an admin to run a plan.</div>
        )}
      </div>

      {err && (
        <div className="card" style={{ marginBottom: 16, borderColor: "var(--error, #ef5350)" }}>
          <div className="sub" style={{ color: "var(--error, #ef5350)" }}>{err}</div>
        </div>
      )}

      {/* ── Live research timeline ─────────────────────────────────────── */}
      {steps.length === 0 && !running ? (
        <div className="empty">
          Pick a brand and run the research. Each step — algorithm search, ranking signals, the per-platform
          playbook, scored ideas — appears here live, then lands on the calendar.
        </div>
      ) : (
        <div style={{ position: "relative", paddingLeft: 26 }}>
          {/* rail */}
          <div style={{ position: "absolute", left: 7, top: 6, bottom: 6, width: 1, background: "var(--border-subtle)" }} />
          {steps.map((s) => (
            <StepRow key={s.id} step={s} />
          ))}
          {running && (
            <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "6px 0", color: "var(--text-muted)", fontSize: 12 }}>
              <span className="pulse-dot" style={{ position: "absolute", left: 2, width: 11, height: 11, borderRadius: "50%", background: "var(--accent)", boxShadow: "0 0 10px var(--accent)" }} />
              <span style={{ fontFamily: "var(--font-mono)" }}>thinking…</span>
            </div>
          )}
        </div>
      )}

      {/* ── Summary ────────────────────────────────────────────────────── */}
      {summary && (
        <div className="card" style={{ marginTop: 18, borderColor: "var(--accent-muted, var(--accent))", display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
          <div style={{ fontSize: 30, fontWeight: 700, color: "var(--accent)", letterSpacing: "-0.03em", lineHeight: 1 }}>{summary.count}</div>
          <div>
            <div style={{ fontSize: 15, fontWeight: 600 }}>posts planned for {ch.name}</div>
            <div className="sub" style={{ marginTop: 2 }}>Plan {summary.planRunId} · ${summary.usd.toFixed(3)} · now on the calendar</div>
          </div>
          <span style={{ flex: 1 }} />
          <Link href="/calendar" className="btn btn-primary" style={{ padding: "9px 18px" }}>
            View on calendar →
          </Link>
        </div>
      )}
    </>
  );
}

function StepRow({ step }: { step: ResearchStep }) {
  const m = KIND_META[step.kind] ?? KIND_META.init;
  return (
    <div style={{ position: "relative", padding: "8px 0 14px" }}>
      <span
        style={{
          position: "absolute",
          left: -24,
          top: 9,
          width: 15,
          height: 15,
          borderRadius: "50%",
          background: "var(--bg-card)",
          border: `1px solid ${m.color}`,
          color: m.color,
          fontSize: 9,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontWeight: 700,
        }}
      >
        {m.icon}
      </span>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        {step.platform && <PlatformBadge k={step.platform} />}
        <span style={{ fontSize: 13.5, fontWeight: 600, color: "var(--text-light)" }}>{step.label}</span>
      </div>
      {step.detail && (
        <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 3, fontFamily: step.kind === "search" ? "var(--font-mono)" : undefined }}>
          {step.detail}
        </div>
      )}
      <StepData step={step} />
    </div>
  );
}

function StepData({ step }: { step: ResearchStep }) {
  const d = step.data as any;
  if (!d) return null;

  // search → result links
  if (step.kind === "search" && Array.isArray(d.results) && d.results.length) {
    return (
      <div style={{ marginTop: 8, display: "grid", gap: 4 }}>
        {d.results.slice(0, 4).map((r: any, i: number) => (
          <a key={i} href={r.url} target="_blank" rel="noreferrer" style={{ fontSize: 11.5, color: "var(--text-secondary)", textDecoration: "none", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            <span style={{ color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>↳ </span>
            {r.title || r.url}
          </a>
        ))}
      </div>
    );
  }

  // playbook → ranking signals + plays
  if (step.kind === "playbook" && d.playbook) {
    const pb = d.playbook;
    const wColor = (w: string) => (w === "decisive" ? "var(--accent)" : w === "high" ? "#5fd97a" : "var(--text-muted)");
    const wPct = (w: string) => (w === "decisive" ? 100 : w === "high" ? 70 : 45);
    return (
      <div className="card" style={{ marginTop: 10, padding: 14 }}>
        <div className="stat-label" style={{ marginBottom: 8 }}>Ranking signals → how to hack them</div>
        <div style={{ display: "grid", gap: 8 }}>
          {pb.rankingSignals?.map((s: any, i: number) => (
            <div key={i}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ fontSize: 12.5, fontWeight: 600, color: "var(--text-light)", flex: 1 }}>{s.signal}</span>
                <span className="tag" style={{ color: wColor(s.weight), borderColor: wColor(s.weight) }}>{s.weight}</span>
              </div>
              <div className="qa-track" style={{ margin: "4px 0" }}>
                <div className="qa-fill" style={{ width: `${wPct(s.weight)}%`, background: wColor(s.weight) }} />
              </div>
              <div style={{ fontSize: 11.5, color: "var(--text-secondary)" }}>{s.howToHack}</div>
            </div>
          ))}
        </div>
        {pb.doNow?.length > 0 && (
          <div style={{ marginTop: 12 }}>
            <div className="stat-label" style={{ marginBottom: 6 }}>Do now</div>
            {pb.doNow.map((p: string, i: number) => (
              <div key={i} style={{ fontSize: 12, color: "var(--text-light)", marginBottom: 4 }}>
                <span style={{ color: "var(--accent)" }}>→ </span>{p}
              </div>
            ))}
          </div>
        )}
        {(pb.postingCadence || pb.optimalLengthSec) && (
          <div style={{ marginTop: 10, display: "flex", gap: 10, flexWrap: "wrap" }}>
            {pb.postingCadence && <span className="tag">cadence: {pb.postingCadence}</span>}
            {pb.optimalLengthSec && <span className="tag">length: {pb.optimalLengthSec}s</span>}
          </div>
        )}
      </div>
    );
  }

  // ideate → top concepts
  if (step.kind === "ideate" && Array.isArray(d.concepts) && d.concepts.length) {
    return (
      <div style={{ marginTop: 10, display: "grid", gap: 6 }}>
        {d.concepts.slice(0, 8).map((c: any, i: number) => (
          <div key={i} style={{ display: "flex", alignItems: "center", gap: 10, padding: "7px 11px", border: "1px solid var(--border-subtle)", borderRadius: 6, background: "var(--bg-elevated)" }}>
            <span style={{ fontFamily: "var(--font-mono)", fontSize: 13, fontWeight: 700, color: c.overall >= 8 ? "var(--success, #5fd97a)" : "var(--text-light)", minWidth: 30 }}>{Number(c.overall ?? 0).toFixed(1)}</span>
            <span style={{ fontSize: 12.5, color: "var(--text-light)", flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.topic}</span>
            <span className="tag">{c.format}</span>
          </div>
        ))}
      </div>
    );
  }

  // schedule → posts grouped by platform
  if (step.kind === "schedule" && Array.isArray(d.posts) && d.posts.length) {
    const byPlatform = new Map<string, number>();
    for (const p of d.posts) byPlatform.set(p.platform, (byPlatform.get(p.platform) ?? 0) + 1);
    return (
      <div style={{ marginTop: 8, display: "flex", gap: 8, flexWrap: "wrap" }}>
        {[...byPlatform.entries()].map(([k, n]) => (
          <span key={k} className="tag" style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            <span style={{ width: 7, height: 7, borderRadius: 2, background: PLATFORMS[k as PlatformKey]?.color ?? "#888" }} />
            {PLATFORMS[k as PlatformKey]?.label ?? k} · {n}
          </span>
        ))}
      </div>
    );
  }

  // init → platforms
  if (step.kind === "init" && Array.isArray(d.platforms)) {
    return (
      <div style={{ marginTop: 8, display: "flex", gap: 8, flexWrap: "wrap" }}>
        {d.platforms.map((p: any) => (
          <PlatformBadge key={p.key} k={p.key} />
        ))}
      </div>
    );
  }

  // brief → channel + topic deep research
  if (step.kind === "brief" && d.brief) {
    const b = d.brief;
    return (
      <div className="card" style={{ marginTop: 10, padding: 14, display: "grid", gap: 12 }}>
        {b.audienceProfile && <Block label="Audience">{b.audienceProfile}</Block>}
        {b.positioning && <Block label="Positioning" accent>{b.positioning}</Block>}
        <Bullets label="Audience insights" items={b.audienceInsights} />
        <Bullets label="Content gaps to own" items={b.contentGaps} accent />
        {Array.isArray(b.bestSubtopics) && b.bestSubtopics.length > 0 && (
          <div>
            <div className="stat-label" style={{ marginBottom: 6 }}>Best subtopics</div>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>{b.bestSubtopics.map((s: string, i: number) => <span key={i} className="tag">{s}</span>)}</div>
          </div>
        )}
        {Array.isArray(b.topAccounts) && b.topAccounts.length > 0 && (
          <div>
            <div className="stat-label" style={{ marginBottom: 6 }}>Who's winning in the niche</div>
            <div style={{ display: "grid", gap: 5 }}>
              {b.topAccounts.map((a: any, i: number) => (
                <div key={i} style={{ fontSize: 12, color: "var(--text-secondary)" }}><span style={{ color: "var(--text-light)", fontWeight: 600 }}>{a.name}</span> — {a.why}</div>
              ))}
            </div>
          </div>
        )}
      </div>
    );
  }

  // subject → the hooks/captions/CTAs/comments/post-types playbook
  if (step.kind === "subject" && d.subject) {
    const s = d.subject;
    return (
      <div className="card" style={{ marginTop: 10, padding: 14, display: "grid", gap: 12 }}>
        <Bullets label="Winning hooks" items={s.winningHooks} accent mono />
        {Array.isArray(s.bestPostTypes) && s.bestPostTypes.length > 0 && (
          <div>
            <div className="stat-label" style={{ marginBottom: 6 }}>Best post types</div>
            <div style={{ display: "grid", gap: 5 }}>
              {s.bestPostTypes.map((p: any, i: number) => (
                <div key={i} style={{ fontSize: 12, color: "var(--text-secondary)" }}><span className="tag" style={{ marginRight: 8 }}>{p.name}</span>{p.why}</div>
              ))}
            </div>
          </div>
        )}
        {s.captionStyle && <Block label="Caption style">{s.captionStyle}</Block>}
        <Bullets label="Caption examples" items={s.captionExamples} />
        <Bullets label="CTAs that convert" items={s.ctaPatterns} accent />
        <Bullets label="Comment strategy" items={s.commentStrategy} />
        <Bullets label="Engagement prompts" items={s.engagementPrompts} />
      </div>
    );
  }

  // cadence → per-cluster posting frequency
  if (step.kind === "cadence" && d.cadence && Array.isArray(d.cadence.clusters)) {
    return (
      <div className="card" style={{ marginTop: 10, padding: 14 }}>
        <div className="stat-label" style={{ marginBottom: 8 }}>How often each category should post</div>
        <div style={{ display: "grid", gap: 8 }}>
          {d.cadence.clusters.map((cl: any, i: number) => (
            <div key={i} style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
              <span style={{ fontSize: 12.5, fontWeight: 600, color: "var(--text-light)", textTransform: "capitalize", minWidth: 90 }}>{cl.mood}</span>
              <span className="tag" style={{ color: "var(--accent)", borderColor: "var(--accent)" }}>{Number(cl.postsPerWeek ?? 0)}× / week</span>
              {cl.bestPostType && <span className="tag">{cl.bestPostType}</span>}
              {Array.isArray(cl.bestPlatforms) && cl.bestPlatforms.slice(0, 3).map((p: string, j: number) => <span key={j} className="tag" style={{ opacity: 0.7 }}>{p}</span>)}
              {cl.rationale && <span style={{ fontSize: 11, color: "var(--text-muted)", flexBasis: "100%" }}>{cl.rationale}</span>}
            </div>
          ))}
        </div>
      </div>
    );
  }

  return null;
}

/* small shared layout helpers for the brief/subject sections */
function Block({ label, accent, children }: { label: string; accent?: boolean; children: React.ReactNode }) {
  return (
    <div>
      <div className="stat-label" style={{ marginBottom: 5 }}>{label}</div>
      <div style={{ fontSize: 12.5, lineHeight: 1.55, color: accent ? "var(--text-light)" : "var(--text-secondary)", fontWeight: accent ? 600 : 400 }}>{children}</div>
    </div>
  );
}
function Bullets({ label, items, accent, mono }: { label: string; items?: string[]; accent?: boolean; mono?: boolean }) {
  if (!Array.isArray(items) || !items.length) return null;
  return (
    <div>
      <div className="stat-label" style={{ marginBottom: 6 }}>{label}</div>
      <div style={{ display: "grid", gap: 5 }}>
        {items.map((t, i) => (
          <div key={i} style={{ fontSize: 12, color: "var(--text-secondary)", lineHeight: 1.5, fontFamily: mono ? "var(--font-mono)" : undefined }}>
            <span style={{ color: accent ? "var(--accent)" : "var(--text-muted)" }}>{mono ? "› " : "• "}</span>{t}
          </div>
        ))}
      </div>
    </div>
  );
}

function parseSSE(raw: string): { event: string; data: any } | null {
  let event = "message";
  const dataLines: string[] = [];
  for (const line of raw.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
  }
  if (!dataLines.length) return null;
  try {
    return { event, data: JSON.parse(dataLines.join("\n")) };
  } catch {
    return null;
  }
}
