"use client";

import { useEffect, useRef, useState } from "react";
import { Eye, Loader2, Sparkles, Music2, Type } from "lucide-react";
import type { FrameSeek } from "./types";

/* FrameInspector — the AT-FRAME read (Editor Frame-Control — Phase C). As the
   parent's `frame` changes, this debounces and GETs /api/studio/[id]/frame?atFrame=N
   (timeline_seek_frame) — the cross-modal read at that exact timeline frame:
     · vision — description / subjects / on-screen text + motion·quality·brightness
                from the dense grid (graceful "build dense vision" CTA when absent)
     · words  — the transcript words anchored on the frame
     · music  — the beats / section / energy at the frame

   Reuses the storyboard inspector tokens (.ed-pane) inside the .ed2 namespace; one
   accent, mono eyebrows, no new design language. Every modality degrades to its
   own empty state — the engine reads fail open, so a missing one never blocks. */

const SCRUB_DEBOUNCE_MS = 220;

function pct(n?: number): string {
  return typeof n === "number" ? `${Math.round(n * 100)}%` : "—";
}

/* A labelled meter — a mono eyebrow, a value, and a proportional bar. The visual
   gauge reads far faster than a bare percentage when scrubbing. */
function Meter({ label, value }: { label: string; value?: number }) {
  const has = typeof value === "number" && isFinite(value);
  const w = has ? Math.max(0, Math.min(100, value! * 100)) : 0;
  return (
    <div className="ed2-meter">
      <div className="ed2-meter-top"><b>{label}</b><span>{has ? `${Math.round(w)}%` : "—"}</span></div>
      <div className="ed2-meter-track"><div className="ed2-meter-fill" style={{ width: `${w}%` }} /></div>
    </div>
  );
}

/* A beat strip — the rhythm in a ±window around the playhead. Beats are ticks; a
   drop is a taller accent tick; the centre line is "now". */
function BeatStrip({ frame, beats, drops }: { frame: number; beats: number[]; drops: number[] }) {
  const HALF = 60; // frames each side (~2s @30)
  const lo = frame - HALF, hi = frame + HALF;
  const at = (f: number) => ((f - lo) / (HALF * 2)) * 100;
  const near = beats.filter((b) => b >= lo && b <= hi);
  const dropSet = new Set(drops);
  return (
    <div className="ed2-beats" aria-hidden>
      {near.map((b, i) => (
        <span key={i} className={`ed2-beat${dropSet.has(b) ? " drop" : ""}`} style={{ left: `${at(b)}%` }} />
      ))}
      <span className="ed2-beats-now" />
    </div>
  );
}

export function FrameInspector({
  runId,
  fps,
  frame,
  hasDenseVision,
  canEdit,
  building,
  onBuildDenseVision,
}: {
  runId: string;
  fps: number;
  frame: number;
  hasDenseVision: boolean;
  canEdit: boolean;
  building: boolean;
  onBuildDenseVision: () => void;
}) {
  const [seek, setSeek] = useState<FrameSeek | null>(null);
  const [loading, setLoading] = useState(false);
  const tRef = useRef<number | null>(null);

  /* Debounced seek read — the inspector follows the scrubber without hammering
     the route on every intermediate frame. */
  useEffect(() => {
    if (tRef.current) window.clearTimeout(tRef.current);
    tRef.current = window.setTimeout(async () => {
      setLoading(true);
      try {
        const res = await fetch(`/api/studio/${runId}/frame?atFrame=${frame}`, { cache: "no-store" });
        if (res.ok) setSeek((await res.json()) as FrameSeek);
      } catch {
        /* keep the last read */
      } finally {
        setLoading(false);
      }
    }, SCRUB_DEBOUNCE_MS);
    return () => { if (tRef.current) window.clearTimeout(tRef.current); };
  }, [runId, frame]);

  const vision = seek?.vision?.frame ?? null;
  const words = seek?.words ?? [];
  const music = seek?.music ?? null;

  return (
    <div className="ed2-inspector ed-pane">
      <div className="ed2-insp-head">
        <span className="ed2-eyebrow">Frame {frame}</span>
        {loading && <Loader2 size={12} className="spin" style={{ animation: "st-spin .8s linear infinite", opacity: 0.6 }} />}
      </div>

      {/* ── VISION ──────────────────────────────────────────────────────────── */}
      <section className="ed2-block">
        <div className="ed2-block-head"><Eye size={12} /> Vision</div>
        {vision ? (
          <div className="ed2-vision">
            {vision.description && <div className="ed2-vision-desc">{vision.description}</div>}
            {vision.onScreenText && (
              <div className="ed2-vision-ost"><span className="ed2-eyebrow">on screen</span> {vision.onScreenText}</div>
            )}
            {vision.subjects && vision.subjects.length > 0 && (
              <div className="ed2-tags">
                {vision.subjects.map((s, i) => <span key={i} className="ed2-tag">{s}</span>)}
              </div>
            )}
            <div className="ed2-meters">
              <Meter label="motion" value={vision.motionScore} />
              <Meter label="quality" value={vision.quality} />
              <Meter label="bright" value={vision.brightness} />
            </div>
            {seek?.vision && seek.vision.deltaSec > 0.05 && (
              <div className="ed2-note">nearest described frame · {seek.vision.deltaSec.toFixed(2)}s away</div>
            )}
          </div>
        ) : hasDenseVision ? (
          <div className="ed2-empty">No described frame near here.</div>
        ) : (
          <div className="ed2-cta">
            <Sparkles size={14} />
            <div className="ed2-cta-body">
              <div className="ed2-cta-title">No dense vision yet</div>
              <div className="ed2-cta-sub">Read every frame — subjects, on-screen text, what&apos;s happening — to inspect any frame.</div>
            </div>
            <button className="btn btn-primary" disabled={!canEdit || building} onClick={onBuildDenseVision}>
              {building ? <Loader2 size={13} className="spin" style={{ animation: "st-spin .8s linear infinite" }} /> : <Sparkles size={13} />}
              {building ? "Building…" : "Build"}
            </button>
          </div>
        )}
      </section>

      {/* ── WORDS ───────────────────────────────────────────────────────────── */}
      <section className="ed2-block">
        <div className="ed2-block-head"><Type size={12} /> Words</div>
        {words.length > 0 ? (
          <div className="ed2-words">
            {words.map((w, i) => {
              const active = frame >= w.fromFrame && frame <= w.toFrame;
              return (
                <span key={i} className={`ed2-word${active ? " hot" : ""}`} title={`${w.fromFrame}–${w.toFrame}f`}>{w.word}</span>
              );
            })}
          </div>
        ) : (
          <div className="ed2-empty">No transcript word on this frame.</div>
        )}
      </section>

      {/* ── MUSIC ───────────────────────────────────────────────────────────── */}
      <section className="ed2-block">
        <div className="ed2-block-head"><Music2 size={12} /> Music</div>
        {music && music.hasMusic ? (
          <div className="ed2-music">
            <BeatStrip frame={frame} beats={music.beats ?? []} drops={music.drops ?? []} />
            <div className="ed2-metrics">
              {music.sections[0] && <span className="ed2-metric"><b>section</b>{music.sections[0].kind}</span>}
              {typeof music.tempoBpm === "number" && <span className="ed2-metric"><b>tempo</b>{Math.round(music.tempoBpm)} bpm</span>}
              <span className="ed2-metric"><b>energy</b>{pct(music.energy[0]?.energy)}</span>
            </div>
            {music.beats.length > 0 && <div className="ed2-note">on a beat ({music.source})</div>}
            {music.drops.length > 0 && <div className="ed2-note ed2-note-hot">drop on this frame</div>}
          </div>
        ) : (
          <div className="ed2-empty">No music at this frame.</div>
        )}
      </section>
    </div>
  );
}
