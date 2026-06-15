"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import {
  ArrowLeft,
  ChevronRight,
  Loader2,
  Sparkles,
  Tag,
  X,
} from "lucide-react";
import type { ObsFull } from "../../../lib/observations";

/* ── helpers ──────────────────────────────────────────────────────────────── */

function fmtNum(n?: number): string {
  if (!n) return "—";
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "K";
  return String(n);
}

/* ── platform badge (inline color pill) ──────────────────────────────────── */

function PlatformBadge({ platform }: { platform: string }) {
  const colors: Record<string, string> = {
    instagram: "#c13584",
    youtube: "#e5383b",
    tiktok: "#ededed",
    x: "#5f5f5f",
    other: "#5f5f5f",
  };
  const color = colors[platform] ?? "#5f5f5f";
  const label = platform.charAt(0).toUpperCase() + platform.slice(1);
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        padding: "3px 10px",
        borderRadius: 999,
        fontSize: 11,
        fontFamily: "var(--font-mono)",
        fontWeight: 600,
        letterSpacing: "0.05em",
        textTransform: "uppercase" as const,
        background: `${color}22`,
        border: `1px solid ${color}66`,
        color,
      }}
    >
      {label}
    </span>
  );
}

/* ── score bar ────────────────────────────────────────────────────────────── */

function ScoreBar({ label, value, max = 10 }: { label: string; value?: number; max?: number }) {
  if (value == null) return null;
  const pct = Math.max(0, Math.min(1, value / max));
  const color = pct >= 0.7 ? "var(--success)" : pct >= 0.4 ? "var(--warning)" : "var(--error)";
  return (
    <div className="qa-row">
      <div className="qa-name">{label}</div>
      <div className="qa-track">
        <div className="qa-fill" style={{ width: `${pct * 100}%`, background: color }} />
      </div>
      <div className="qa-num">{value.toFixed(1)}</div>
    </div>
  );
}

/* ── kv row ───────────────────────────────────────────────────────────────── */

function KV({ k, v }: { k: string; v?: string | number | null }) {
  if (!v && v !== 0) return null;
  return (
    <div className="kv">
      <span className="kv-k">{k}</span>
      <span className="kv-v" style={{ textAlign: "right" }}>{String(v)}</span>
    </div>
  );
}

/* ── tag input ────────────────────────────────────────────────────────────── */

function TagInput({ id, existingTags }: { id: string; existingTags: string[] }) {
  const [tags, setTags] = useState<string[]>(existingTags);
  const [input, setInput] = useState("");
  const [saving, setSaving] = useState(false);

  const addTag = useCallback(async () => {
    const t = input.trim().toLowerCase().replace(/\s+/g, "_");
    if (!t || tags.includes(t)) { setInput(""); return; }
    setSaving(true);
    try {
      const r = await fetch(`/api/observations/${id}/tag`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tags: [t] }),
      });
      if (r.ok) {
        setTags((prev) => [...prev, t]);
        setInput("");
      }
    } finally {
      setSaving(false);
    }
  }, [id, input, tags]);

  return (
    <div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 10 }}>
        {tags.map((t) => (
          <span key={t} className="tag">{t}</span>
        ))}
      </div>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && !saving && addTag()}
          placeholder="Add tag…"
          className="input"
          style={{ maxWidth: 200, padding: "8px 12px", fontSize: 12.5 }}
        />
        <button
          onClick={addTag}
          disabled={saving || !input.trim()}
          className="btn"
          style={{ padding: "8px 14px", fontSize: 12.5 }}
        >
          {saving ? <Loader2 size={13} style={{ animation: "spin 0.8s linear infinite" }} /> : <Tag size={13} />}
          Tag
        </button>
      </div>
    </div>
  );
}

/* ── use as reference ─────────────────────────────────────────────────────── */

function UseAsReference({ id, channelId }: { id: string; channelId?: string }) {
  const [done, setDone] = useState(false);
  const [saving, setSaving] = useState(false);

  const save = useCallback(async () => {
    if (!channelId) return;
    setSaving(true);
    try {
      await fetch(`/api/dna/${channelId}/reference`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ observationId: id }),
      });
      setDone(true);
    } finally {
      setSaving(false);
    }
  }, [id, channelId]);

  if (!channelId) return null;

  return (
    <button
      onClick={save}
      disabled={saving || done}
      className={`btn${done ? " btn-active" : ""}`}
    >
      {saving && <Loader2 size={14} style={{ animation: "spin 0.8s linear infinite" }} />}
      <Sparkles size={14} />
      {done ? "Saved to DNA" : "Use as reference"}
    </button>
  );
}

/* ── frame strip ──────────────────────────────────────────────────────────── */

function FrameStrip({ frames }: { frames?: string[] }) {
  if (!frames?.length) return null;
  return (
    <div>
      <div style={{ fontFamily: "var(--font-mono)", fontSize: 11, letterSpacing: "0.08em", textTransform: "uppercase" as const, color: "var(--text-muted)", marginBottom: 10 }}>
        Extracted frames — {frames.length}
      </div>
      <div style={{ display: "flex", gap: 8, overflowX: "auto", paddingBottom: 4 }}>
        {frames.map((f, i) => (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            key={i}
            src={`/api/media?path=${encodeURIComponent(f)}`}
            alt={`frame ${i + 1}`}
            style={{
              height: 100,
              width: "auto",
              borderRadius: 6,
              border: "1px solid var(--border-subtle)",
              flexShrink: 0,
              objectFit: "cover",
            }}
          />
        ))}
      </div>
    </div>
  );
}

/* ── main detail view ─────────────────────────────────────────────────────── */

export function ObsDetail({ id, initial }: { id: string; initial: ObsFull | null }) {
  const [obs, setObs] = useState<ObsFull | null>(initial);
  const [polling, setPolling] = useState(!initial || !initial.analysis);

  /* Poll until analysis is populated (scan may still be running). */
  useEffect(() => {
    if (!polling) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const r = await fetch(`/api/observations/${id}`, { cache: "no-store" });
        if (!r.ok) return;
        const j = (await r.json()) as { observation?: ObsFull };
        if (!cancelled && j.observation) {
          setObs(j.observation);
          if (j.observation.analysis) setPolling(false);
        }
      } catch {/* transient */}
    };
    tick();
    const iv = setInterval(tick, 4_000);
    return () => { cancelled = true; clearInterval(iv); };
  }, [id, polling]);

  const thumbSrc = obs?.thumbnailPath
    ? `/api/media?path=${encodeURIComponent(obs.thumbnailPath)}`
    : null;

  return (
    <>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>

      {/* breadcrumb */}
      <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 22, fontSize: 13, color: "var(--text-muted)" }}>
        <Link href="/creative-lab" style={{ display: "flex", alignItems: "center", gap: 5, color: "var(--text-muted)" }}>
          <ArrowLeft size={13} /> Creative Lab
        </Link>
        <ChevronRight size={12} />
        <span style={{ color: "var(--text-secondary)" }}>
          {obs?.title ?? obs?.creator?.handle ?? id}
        </span>
      </div>

      {/* scanning state */}
      {(!obs || !obs.analysis) && polling && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            padding: "16px 20px",
            background: "var(--bg-surface)",
            border: "1px solid var(--border-subtle)",
            borderRadius: "var(--radius)",
            marginBottom: 24,
          }}
        >
          <Loader2 size={16} style={{ animation: "spin 0.8s linear infinite", color: "var(--text-muted)", flexShrink: 0 }} />
          <div>
            <div style={{ fontSize: 14, fontWeight: 580, color: "var(--text-light)" }}>Scanning in progress…</div>
            <div style={{ fontSize: 12.5, color: "var(--text-muted)", marginTop: 2 }}>
              Downloading, extracting frames, and running AI vision analysis. This takes ~30–60 seconds.
            </div>
          </div>
        </div>
      )}

      {obs && (
        <div className="obs-detail-grid">
          {/* left: thumbnail + metrics */}
          <div className="post-aside" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            {thumbSrc ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={thumbSrc}
                alt="thumbnail"
                style={{
                  width: "100%",
                  aspectRatio: "9/16",
                  objectFit: "cover",
                  borderRadius: "var(--radius)",
                  border: "1px solid var(--border-subtle)",
                }}
              />
            ) : (
              <div
                style={{
                  width: "100%",
                  aspectRatio: "9/16",
                  background: "var(--bg-surface)",
                  borderRadius: "var(--radius)",
                  border: "1px solid var(--border-subtle)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  color: "var(--text-muted)",
                  fontSize: 11,
                  fontFamily: "var(--font-mono)",
                  letterSpacing: "0.05em",
                  textTransform: "uppercase" as const,
                }}
              >
                No thumbnail
              </div>
            )}

            {/* platform + creator */}
            <div className="card" style={{ display: "flex", flexDirection: "column", gap: 0 }}>
              <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 12 }}>
                <PlatformBadge platform={obs.platform} />
                {obs.kind && (
                  <span style={{ fontFamily: "var(--font-mono)", fontSize: 10.5, color: "var(--text-muted)", textTransform: "uppercase" }}>
                    {obs.kind}
                  </span>
                )}
              </div>
              <KV k="Handle" v={obs.creator?.handle ? `@${obs.creator.handle}` : null} />
              <KV k="Name" v={obs.creator?.name} />
              <KV k="Followers" v={obs.creator?.followers ? fmtNum(obs.creator.followers) : null} />
              <KV k="Duration" v={obs.duration ? `${obs.duration}s` : null} />
            </div>

            {/* metrics */}
            {obs.metrics && (
              <div className="card" style={{ display: "flex", flexDirection: "column", gap: 0 }}>
                <div style={{ fontFamily: "var(--font-mono)", fontSize: 10.5, letterSpacing: "0.08em", textTransform: "uppercase" as const, color: "var(--text-muted)", marginBottom: 10 }}>Metrics</div>
                <KV k="Views" v={fmtNum(obs.metrics.views)} />
                <KV k="Likes" v={fmtNum(obs.metrics.likes)} />
                <KV k="Comments" v={fmtNum(obs.metrics.comments)} />
                <KV k="Shares" v={fmtNum(obs.metrics.shares)} />
                <KV k="Saves" v={fmtNum(obs.metrics.saves)} />
                {obs.metrics.engagementRate != null && (
                  <KV k="Eng. rate" v={`${(obs.metrics.engagementRate * 100).toFixed(2)}%`} />
                )}
              </div>
            )}

            {/* actions */}
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <UseAsReference id={obs.id} channelId={obs.channelId} />
              <a
                href={obs.url}
                target="_blank"
                rel="noopener noreferrer"
                className="btn"
                style={{ justifyContent: "center" }}
              >
                Open original ↗
              </a>
            </div>
          </div>

          {/* right: full analysis */}
          <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
            {/* header */}
            <div>
              <h1 style={{ fontSize: 22, fontWeight: 680, letterSpacing: "-0.02em", margin: "0 0 6px" }}>
                {obs.title ?? obs.creator?.handle ?? "Untitled observation"}
              </h1>
              {obs.description && (
                <p style={{ fontSize: 13.5, color: "var(--text-secondary)", margin: 0 }}>{obs.description}</p>
              )}
            </div>

            {obs.analysis ? (
              <>
                {/* inspiration score */}
                <div className="card">
                  <div style={{ fontFamily: "var(--font-mono)", fontSize: 10.5, letterSpacing: "0.08em", textTransform: "uppercase" as const, color: "var(--text-muted)", marginBottom: 14 }}>
                    Creative Score
                  </div>
                  <ScoreBar label="Inspiration" value={obs.analysis.inspirationScore} />
                </div>

                {/* visual language */}
                <div className="card">
                  <div style={{ fontFamily: "var(--font-mono)", fontSize: 10.5, letterSpacing: "0.08em", textTransform: "uppercase" as const, color: "var(--text-muted)", marginBottom: 14 }}>
                    Visual Language
                  </div>
                  {obs.analysis.visualLanguage && (
                    <p style={{ fontSize: 14, color: "var(--text-light)", lineHeight: 1.6, margin: "0 0 14px" }}>
                      {obs.analysis.visualLanguage}
                    </p>
                  )}
                  <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
                    <KV k="Backgrounds" v={obs.analysis.backgrounds} />
                    <KV k="Typography" v={obs.analysis.typography} />
                    <KV k="Colour palette" v={obs.analysis.colorPalette?.join(", ")} />
                    {obs.analysis.sceneTypes?.length && (
                      <KV k="Scene types" v={obs.analysis.sceneTypes.join(", ")} />
                    )}
                  </div>
                </div>

                {/* edit rhythm + audio */}
                <div className="card">
                  <div style={{ fontFamily: "var(--font-mono)", fontSize: 10.5, letterSpacing: "0.08em", textTransform: "uppercase" as const, color: "var(--text-muted)", marginBottom: 14 }}>
                    Edit Rhythm &amp; Audio
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
                    <KV k="Edit rhythm" v={obs.analysis.editRhythm} />
                    <KV k="Avg scene" v={obs.analysis.avgSceneDuration ? `${obs.analysis.avgSceneDuration}s` : null} />
                    <KV k="Music style" v={obs.analysis.musicStyle} />
                    <KV k="Music energy" v={obs.analysis.musicEnergy} />
                  </div>
                </div>

                {/* narrative + tone */}
                <div className="card">
                  <div style={{ fontFamily: "var(--font-mono)", fontSize: 10.5, letterSpacing: "0.08em", textTransform: "uppercase" as const, color: "var(--text-muted)", marginBottom: 14 }}>
                    Narrative &amp; Tone
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
                    <KV k="Tone" v={obs.analysis.tone} />
                    <KV k="Narrative format" v={obs.analysis.narrativeFormat} />
                    <KV k="Hook pattern" v={obs.analysis.hookPattern} />
                    <KV k="Mood mapping" v={obs.analysis.socheliMoodMapping} />
                  </div>
                </div>

                {/* key insights */}
                {obs.analysis.keyInsights?.length && (
                  <div className="card">
                    <div style={{ fontFamily: "var(--font-mono)", fontSize: 10.5, letterSpacing: "0.08em", textTransform: "uppercase" as const, color: "var(--text-muted)", marginBottom: 14 }}>
                      Key Insights
                    </div>
                    <ul style={{ margin: 0, padding: "0 0 0 18px", display: "flex", flexDirection: "column", gap: 8 }}>
                      {obs.analysis.keyInsights.map((ins, i) => (
                        <li key={i} style={{ fontSize: 13.5, color: "var(--text-light)", lineHeight: 1.55 }}>{ins}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </>
            ) : polling ? (
              <div className="card" style={{ display: "flex", alignItems: "center", gap: 10, color: "var(--text-muted)" }}>
                <Loader2 size={15} style={{ animation: "spin 0.8s linear infinite", flexShrink: 0 }} />
                <span>Analysis in progress — refreshing automatically…</span>
              </div>
            ) : (
              <div className="card" style={{ color: "var(--text-muted)", fontSize: 13.5 }}>
                No analysis available for this observation.
              </div>
            )}

            {/* frame strip */}
            {obs.frames?.length ? (
              <div className="card">
                <FrameStrip frames={obs.frames} />
              </div>
            ) : null}

            {/* top comments */}
            {obs.topComments?.length ? (
              <div className="card">
                <div style={{ fontFamily: "var(--font-mono)", fontSize: 10.5, letterSpacing: "0.08em", textTransform: "uppercase" as const, color: "var(--text-muted)", marginBottom: 14 }}>
                  Top Comments
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  {obs.topComments.slice(0, 8).map((c, i) => (
                    <div key={i} style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
                      <div
                        style={{
                          flexShrink: 0,
                          width: 26,
                          height: 26,
                          borderRadius: "50%",
                          background: "var(--bg-surface)",
                          border: "1px solid var(--border-subtle)",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          fontSize: 10,
                          color: "var(--text-muted)",
                          fontFamily: "var(--font-mono)",
                        }}
                      >
                        {i + 1}
                      </div>
                      <div style={{ flex: 1 }}>
                        <p style={{ margin: 0, fontSize: 13, color: "var(--text-secondary)", lineHeight: 1.5 }}>{c.text}</p>
                        {c.likes != null && (
                          <span style={{ fontSize: 11, fontFamily: "var(--font-mono)", color: "var(--text-muted)" }}>♥ {c.likes}</span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}

            {/* tagging */}
            <div className="card">
              <div style={{ fontFamily: "var(--font-mono)", fontSize: 10.5, letterSpacing: "0.08em", textTransform: "uppercase" as const, color: "var(--text-muted)", marginBottom: 14 }}>
                Tags
              </div>
              <TagInput id={obs.id} existingTags={obs.tags} />
            </div>
          </div>
        </div>
      )}
    </>
  );
}
