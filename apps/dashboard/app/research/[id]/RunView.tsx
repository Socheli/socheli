"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  Check,
  Compass,
  ExternalLink,
  FileText,
  Globe,
  Search,
  ShieldCheck,
  Sparkles,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";
import { Markdown } from "../../docs/Markdown";
import type { ResearchRunData, ResearchSource } from "../../../lib/research";
import { CLAIM_META, FreshBadge, KindBadge, StatusBadge, fmtUsd } from "../meta";

/* One research run, live. While the detached worker runs we poll the run JSON
   every 2.5s — steps[] grows into the same rail-timeline the Algo Lab uses —
   and once it's done the cited report, adjudicated claims and sources render.
   [S#] citations in the report anchor-link to the source list (intercepted
   click → smooth scroll + highlight flash, so the docs Markdown renderer is
   reused untouched). */

const POLL_MS = 2500;
const MAX_MISSES = 24; // ~60s of 404s before we call the run missing

export function RunView({ id, initialRun }: { id: string; initialRun: ResearchRunData | null }) {
  const [run, setRun] = useState<ResearchRunData | null>(initialRun);
  const [misses, setMisses] = useState(0);
  const [hl, setHl] = useState<string | null>(null);
  const hlTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const live = !run || run.status === "running";

  useEffect(() => {
    if (!live) return;
    let stop = false;
    const tick = async () => {
      try {
        const r = await fetch(`/api/research/${id}`, { cache: "no-store" });
        if (stop) return;
        if (r.ok) {
          const j = (await r.json()) as { run?: ResearchRunData };
          if (j.run) {
            setRun(j.run);
            setMisses(0);
            return;
          }
        }
        if (r.status === 404) setMisses((m) => m + 1);
      } catch {
        /* transient network blip — next tick retries */
      }
    };
    tick();
    const iv = setInterval(tick, POLL_MS);
    return () => {
      stop = true;
      clearInterval(iv);
    };
  }, [id, live]);

  useEffect(() => () => { if (hlTimer.current) clearTimeout(hlTimer.current); }, []);

  /* Scroll to + flash a source row (citation / claim-chip click target). */
  const flashSource = (domId: string) => {
    document.getElementById(domId)?.scrollIntoView({ behavior: "smooth", block: "center" });
    setHl(domId);
    if (hlTimer.current) clearTimeout(hlTimer.current);
    hlTimer.current = setTimeout(() => setHl(null), 1800);
  };

  /* ── Pre-run states: booting / genuinely missing ────────────────────── */
  if (!run) {
    if (misses >= MAX_MISSES) {
      return (
        <>
          <BackLink />
          <div className="empty">
            <div style={{ fontSize: 15, fontWeight: 600, color: "var(--text-light)", marginBottom: 6 }}>Run not found</div>
            <div style={{ fontSize: 13 }}>
              No research run <span style={{ fontFamily: "var(--font-mono)" }}>{id}</span> in this workspace — it may belong to
              another workspace, or its worker failed before writing anything.
            </div>
          </div>
        </>
      );
    }
    return (
      <>
        <BackLink />
        <div className="empty">
          <div style={{ display: "inline-flex", alignItems: "center", gap: 10 }}>
            <span className="pulse-dot" style={{ width: 9, height: 9, borderRadius: "50%", background: "var(--accent)", boxShadow: "0 0 10px var(--accent)" }} />
            <span style={{ fontFamily: "var(--font-mono)", fontSize: 12.5, color: "var(--text-secondary)" }}>starting research worker…</span>
          </div>
        </div>
      </>
    );
  }

  const ageHours = Math.max(0, (Date.now() - new Date(run.createdAt).getTime()) / 36e5);
  const lastStep = run.steps[run.steps.length - 1];

  return (
    <>
      <BackLink />
      <div className="page-head" style={{ marginBottom: 26 }}>
        <div className="eyebrow">// research / {run.kind}</div>
        <h1 className="h1" style={{ fontSize: 24, lineHeight: 1.3 }}>{run.query}</h1>
        <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", marginTop: 12 }}>
          <KindBadge kind={run.kind} />
          <span className="tag" style={{ margin: 0, opacity: 0.75 }}>{run.depth}</span>
          {run.channel && <span className="tag" style={{ margin: 0 }}>{run.channel.replace(/_/g, " ")}</span>}
          <StatusBadge status={run.status} />
          <FreshBadge status={run.status} ageHours={ageHours} ttlHours={run.ttlHours} />
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 11.5, color: "var(--text-muted)" }}>{fmtUsd(run.usd)}</span>
        </div>
      </div>

      {run.status === "failed" && (
        <div className="card" style={{ marginBottom: 16, borderColor: "var(--error, #ef5350)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--error, #ef5350)", fontSize: 13.5, fontWeight: 600 }}>
            <TriangleAlert size={15} />
            Research failed
          </div>
          {lastStep?.detail && (
            <div className="sub" style={{ marginTop: 6, fontFamily: "var(--font-mono)", fontSize: 12 }}>{lastStep.detail}</div>
          )}
        </div>
      )}

      {/* While running, the live timeline leads; once done it becomes the run log below the report. */}
      {run.status === "running" && (
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="stat-label" style={{ marginBottom: 14 }}>Live steps</div>
          <StepsTimeline steps={run.steps} running />
        </div>
      )}

      {run.status !== "running" && run.report ? (
        <div className="grid cols-2 research-split" style={{ alignItems: "start", gridTemplateColumns: "minmax(0, 1fr) minmax(280px, 380px)" }}>
          {/* ── Report ─────────────────────────────────────────────────── */}
          <div className="card">
            <div className="stat-label" style={{ marginBottom: 14 }}>Cited report</div>
            <div
              onClickCapture={(e) => {
                const a = (e.target as HTMLElement).closest?.("a");
                const href = a?.getAttribute("href");
                if (href?.startsWith("#src-")) {
                  e.preventDefault();
                  e.stopPropagation();
                  flashSource(href.slice(1));
                }
              }}
            >
              <Markdown>{linkCitations(run.report)}</Markdown>
            </div>
          </div>

          {/* ── Claims + sources aside ─────────────────────────────────── */}
          <div style={{ display: "grid", gap: 16 }}>
            <ClaimsCard run={run} onSource={flashSource} />
            <SourcesCard sources={run.sources} hl={hl} />
          </div>
        </div>
      ) : run.status !== "running" ? (
        <div className="empty">This run produced no report{run.status === "failed" ? " before it failed" : ""}.</div>
      ) : (
        <div style={{ display: "grid", gap: 16 }}>
          {run.claims.length > 0 && <ClaimsCard run={run} onSource={flashSource} />}
          {run.sources.length > 0 && <SourcesCard sources={run.sources} hl={hl} />}
        </div>
      )}

      {run.status !== "running" && run.steps.length > 0 && (
        <div className="card" style={{ marginTop: 16 }}>
          <div className="stat-label" style={{ marginBottom: 14 }}>Run log</div>
          <StepsTimeline steps={run.steps} />
        </div>
      )}
    </>
  );
}

/* ── Pieces ──────────────────────────────────────────────────────────────── */

function BackLink() {
  return (
    <Link
      href="/research"
      style={{ display: "inline-flex", alignItems: "center", gap: 6, fontFamily: "var(--font-mono)", fontSize: 11, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--text-muted)", textDecoration: "none", marginBottom: 16 }}
    >
      <ArrowLeft size={12} />
      All research
    </Link>
  );
}

/* Step icon from the label — the persisted step rows carry no kind, so the
   phase is inferred from the orchestrator's stable label vocabulary. */
function stepMeta(label: string): { Icon: LucideIcon; color: string } {
  const l = label.toLowerCase();
  if (/fail|degraded|unavailable|budget cap/.test(l)) return { Icon: TriangleAlert, color: "var(--error, #ef5350)" };
  if (/research ready/.test(l)) return { Icon: Check, color: "var(--success, #5fd97a)" };
  if (/searching|sub-quer/.test(l)) return { Icon: Search, color: "var(--text-secondary)" };
  if (/fetching|readable/.test(l)) return { Icon: Globe, color: "var(--text-secondary)" };
  if (/extract/.test(l)) return { Icon: FileText, color: "var(--text-secondary)" };
  if (/verif|adjudicat|claim/.test(l)) return { Icon: ShieldCheck, color: "var(--text-secondary)" };
  if (/synthesiz/.test(l)) return { Icon: Sparkles, color: "var(--accent)" };
  return { Icon: Compass, color: "var(--text-light)" };
}

function StepsTimeline({ steps, running = false }: { steps: ResearchRunData["steps"]; running?: boolean }) {
  if (steps.length === 0 && !running) return <div className="sub">No steps recorded.</div>;
  return (
    <div style={{ position: "relative", paddingLeft: 26 }}>
      <div style={{ position: "absolute", left: 7, top: 6, bottom: 6, width: 1, background: "var(--border-subtle)" }} />
      {steps.map((s, i) => {
        const { Icon, color } = stepMeta(s.label);
        return (
          <div key={i} style={{ position: "relative", padding: "7px 0 13px" }}>
            <span
              style={{
                position: "absolute",
                left: -24,
                top: 8,
                width: 15,
                height: 15,
                borderRadius: "50%",
                background: "var(--bg-card)",
                border: `1px solid ${color}`,
                color,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <Icon size={8.5} strokeWidth={2.4} />
            </span>
            <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
              <span style={{ fontSize: 13.5, fontWeight: 600, color: "var(--text-light)" }}>{s.label}</span>
              <span style={{ fontFamily: "var(--font-mono)", fontSize: 10.5, color: "var(--text-muted)" }}>
                {new Date(s.at).toLocaleTimeString([], { hour12: false })}
              </span>
            </div>
            {s.detail && (
              <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 3, lineHeight: 1.55, overflowWrap: "anywhere" }}>{s.detail}</div>
            )}
          </div>
        );
      })}
      {running && (
        <div style={{ position: "relative", display: "flex", alignItems: "center", gap: 10, padding: "6px 0", color: "var(--text-muted)", fontSize: 12 }}>
          <span
            className="pulse-dot"
            style={{ position: "absolute", left: -22, width: 11, height: 11, borderRadius: "50%", background: "var(--accent)", boxShadow: "0 0 10px var(--accent)" }}
          />
          <span style={{ fontFamily: "var(--font-mono)" }}>working…</span>
        </div>
      )}
    </div>
  );
}

function ClaimsCard({ run, onSource }: { run: ResearchRunData; onSource: (domId: string) => void }) {
  const counts = { verified: 0, "single-source": 0, disputed: 0 } as Record<string, number>;
  for (const c of run.claims) counts[c.status] = (counts[c.status] ?? 0) + 1;
  return (
    <div className="card">
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 14 }}>
        <span className="stat-label">Claims</span>
        <span style={{ flex: 1 }} />
        {(Object.keys(CLAIM_META) as (keyof typeof CLAIM_META)[]).map((s) =>
          counts[s] ? (
            <span key={s} style={{ fontFamily: "var(--font-mono)", fontSize: 10.5, color: CLAIM_META[s].color }}>
              {counts[s]} {CLAIM_META[s].label}
            </span>
          ) : null,
        )}
      </div>
      {run.claims.length === 0 ? (
        <div className="sub" style={{ fontSize: 12.5 }}>
          {run.status === "running" ? "No claims adjudicated yet." : "No claims were extracted on this run."}
        </div>
      ) : (
        <div style={{ display: "grid", gap: 10 }}>
          {run.claims.map((c, i) => {
            const m = CLAIM_META[c.status] ?? CLAIM_META["single-source"];
            const Icon = m.icon;
            return (
              <div key={i} style={{ padding: "10px 12px", border: "1px solid var(--border-subtle)", borderRadius: 8, background: "var(--bg-elevated)" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}>
                  <span
                    style={{ display: "inline-flex", alignItems: "center", gap: 5, fontFamily: "var(--font-mono)", fontSize: 10, letterSpacing: "0.07em", textTransform: "uppercase", color: m.color, border: `1px solid ${m.color}`, borderRadius: 5, padding: "2px 7px" }}
                  >
                    <Icon size={10} />
                    {m.label}
                  </span>
                  <span style={{ flex: 1 }} />
                  {c.sourceIds.map((sid) => (
                    <button
                      key={sid}
                      onClick={() => onSource(`src-${sid}`)}
                      title={`jump to source ${sid}`}
                      style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--text-secondary)", background: "var(--bg-surface)", border: "1px solid var(--border-subtle)", borderRadius: 5, padding: "2px 6px", cursor: "pointer" }}
                    >
                      {sid}
                    </button>
                  ))}
                </div>
                <div style={{ fontSize: 12.5, lineHeight: 1.55, color: "var(--text-secondary)" }}>{c.text}</div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function SourcesCard({ sources, hl }: { sources: ResearchSource[]; hl: string | null }) {
  return (
    <div className="card">
      <div className="stat-label" style={{ marginBottom: 14 }}>Sources · {sources.length}</div>
      {sources.length === 0 ? (
        <div className="sub" style={{ fontSize: 12.5 }}>No readable sources on this run.</div>
      ) : (
        <div style={{ display: "grid", gap: 8 }}>
          {sources.map((s) => {
            const domId = `src-${s.id}`;
            const active = hl === domId;
            return (
              <div
                key={s.id}
                id={domId}
                style={{
                  display: "flex",
                  gap: 10,
                  padding: "10px 12px",
                  border: `1px solid ${active ? "var(--accent)" : "var(--border-subtle)"}`,
                  boxShadow: active ? "0 0 0 1px var(--accent), 0 0 18px var(--accent-muted)" : "none",
                  borderRadius: 8,
                  background: "var(--bg-elevated)",
                  transition: "border-color 250ms, box-shadow 250ms",
                  scrollMarginTop: 90,
                }}
              >
                <Favicon url={s.url} />
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 7, minWidth: 0 }}>
                    <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--text-muted)", flexShrink: 0 }}>{s.id}</span>
                    <a
                      href={s.url}
                      target="_blank"
                      rel="noreferrer"
                      style={{ fontSize: 12.5, fontWeight: 600, color: "var(--text-light)", textDecoration: "none", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}
                    >
                      {s.title}
                    </a>
                    <ExternalLink size={11} style={{ color: "var(--text-muted)", flexShrink: 0 }} />
                  </div>
                  <div style={{ fontFamily: "var(--font-mono)", fontSize: 10.5, color: "var(--text-muted)", marginTop: 2 }}>{hostOf(s.url)}</div>
                  {s.excerpt && (
                    <div style={{ fontSize: 11.5, color: "var(--text-secondary)", marginTop: 5, lineHeight: 1.5, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>
                      {s.excerpt}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function Favicon({ url }: { url: string }) {
  const [err, setErr] = useState(false);
  const domain = hostOf(url);
  const box: React.CSSProperties = { width: 18, height: 18, borderRadius: 4, flexShrink: 0, marginTop: 2 };
  if (err || !domain) {
    return (
      <span style={{ ...box, display: "inline-flex", alignItems: "center", justifyContent: "center", background: "var(--bg-surface)", border: "1px solid var(--border-subtle)", color: "var(--text-muted)" }}>
        <Globe size={11} />
      </span>
    );
  }
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={`https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=64`} alt="" width={18} height={18} style={box} onError={() => setErr(true)} />;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

/* Turn the report's [S1] / [S2, S5] citation markers into anchor links onto
   the source rows. Pure string preprocessing, so the shared docs Markdown
   renderer is reused as-is. */
function linkCitations(md: string): string {
  return md.replace(/\[((?:S\d+)(?:\s*,\s*S\d+)*)\]/g, (_m, group: string) =>
    group
      .split(/\s*,\s*/)
      .map((s) => `[${s}](#src-${s})`)
      .join(" "),
  );
}
