"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Play, Pause, ChevronLeft, ChevronRight } from "lucide-react";

/* VideoScrubber — a FRAME-ACCURATE scrubber over the rendered/source video
   (Editor Frame-Control — Phase C). A thin sibling of VideoPlayer (the studio
   preview): where VideoPlayer is a seconds-based playback UI, this is a CONTROLLED
   frame surface — the parent owns `frame` (the current timeline frame), and
   dragging the strip / stepping calls onSeek(frame). The <video> is slaved to
   frame/fps so the picture always matches the inspector's at-frame read.

   Reuses the house player chrome via the .ed-tp-* transport tokens (the storyboard
   editor's playhead/scrub) — one accent (white), mono numerals, no new design. */

/* Seconds → "M:SS". */
function mmss(t: number): string {
  if (!isFinite(t) || t < 0) t = 0;
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}
/* Frame → "MM:SS:FF" timecode at fps. */
function tc(frame: number, fps: number): string {
  const f = ((frame % fps) + fps) % fps;
  const secs = Math.floor(frame / fps);
  return `${mmss(secs)}:${String(Math.round(f)).padStart(2, "0")}`;
}

export function VideoScrubber({
  src,
  videoKey,
  fps,
  frame,
  totalFrames,
  onSeek,
}: {
  src: string | null;
  videoKey: number;
  fps: number;
  frame: number;
  totalFrames: number;
  onSeek: (frame: number) => void;
}) {
  const v = useRef<HTMLVideoElement>(null);
  const stripRef = useRef<HTMLDivElement>(null);
  const [playing, setPlaying] = useState(false);
  const [ready, setReady] = useState(false);
  const draggingRef = useRef(false);

  const max = Math.max(1, totalFrames - 1);
  const frac = Math.max(0, Math.min(1, frame / max));

  /* Slave the <video> to the controlled frame (unless the user is playing it,
     where the timeupdate handler drives `frame` instead). */
  useEffect(() => {
    const el = v.current;
    if (!el || !ready || playing) return;
    const want = frame / fps;
    if (Math.abs(el.currentTime - want) > 0.5 / fps) {
      try { el.currentTime = want; } catch { /* not seekable yet */ }
    }
  }, [frame, fps, ready, playing]);

  const togglePlay = useCallback(() => {
    const el = v.current;
    if (!el) return;
    if (el.paused) void el.play().catch(() => {});
    else el.pause();
  }, []);

  const step = useCallback((d: number) => {
    const el = v.current;
    if (el && !el.paused) el.pause();
    onSeek(frame + d);
  }, [frame, onSeek]);

  /* While playing, mirror the picture's time back onto `frame`. */
  const onTime = useCallback(() => {
    const el = v.current;
    if (!el || !playing) return;
    onSeek(Math.round(el.currentTime * fps));
  }, [playing, fps, onSeek]);

  /* Global transport shortcuts (editor muscle memory) — space play/pause, ←/→ a
     frame, ⇧←/→ a second, Home/End, J/K/L. Ignored while typing in a field. */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      const big = e.shiftKey ? fps : 1;
      switch (e.key) {
        case " ": case "k": e.preventDefault(); togglePlay(); break;
        case "ArrowLeft": case "j": e.preventDefault(); step(-big); break;
        case "ArrowRight": case "l": e.preventDefault(); step(big); break;
        case "Home": e.preventDefault(); onSeek(0); break;
        case "End": e.preventDefault(); onSeek(max); break;
        default: break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [togglePlay, step, onSeek, max, fps]);

  /* scrub strip — click + drag map x → frame */
  const frameFromX = useCallback((clientX: number) => {
    const bar = stripRef.current;
    if (!bar) return frame;
    const r = bar.getBoundingClientRect();
    const p = Math.max(0, Math.min(1, (r.width ? (clientX - r.left) / r.width : 0)));
    return Math.round(p * max);
  }, [frame, max]);

  const onStripDown = (e: React.PointerEvent) => {
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    draggingRef.current = true;
    const el = v.current;
    if (el && !el.paused) el.pause();
    onSeek(frameFromX(e.clientX));
  };
  const onStripMove = (e: React.PointerEvent) => {
    if (!draggingRef.current) return;
    onSeek(frameFromX(e.clientX));
  };
  const onStripUp = (e: React.PointerEvent) => {
    draggingRef.current = false;
    try { (e.target as HTMLElement).releasePointerCapture(e.pointerId); } catch { /* */ }
  };

  return (
    <div className="ed2-scrubber">
      <div className="ed2-screen">
        {src ? (
          <video
            key={videoKey}
            ref={v}
            src={src}
            preload="auto"
            playsInline
            muted
            className="ed2-video"
            onLoadedMetadata={() => setReady(true)}
            onTimeUpdate={onTime}
            onPlay={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
            onClick={togglePlay}
          />
        ) : (
          <div className="ed2-screen-empty">No rendered cut yet — render to preview the frames.</div>
        )}
      </div>

      {/* frame transport */}
      <div className="ed2-transport">
        <button className="ed-tp-btn" onClick={() => step(-1)} title="Previous frame ( , )" aria-label="Previous frame"><ChevronLeft size={15} /></button>
        <button className="ed-tp-btn ed-tp-play" onClick={togglePlay} disabled={!src} aria-label={playing ? "Pause" : "Play"}>
          {playing ? <Pause size={14} /> : <Play size={14} />}
        </button>
        <button className="ed-tp-btn" onClick={() => step(1)} title="Next frame ( . )" aria-label="Next frame"><ChevronRight size={15} /></button>

        <div className="ed-tp-time">{tc(frame, fps)}<span> / {tc(max, fps)}</span></div>

        <div
          ref={stripRef}
          className="ed-tp-scrub"
          role="slider"
          aria-label="Frame scrubber"
          aria-valuemin={0}
          aria-valuemax={max}
          aria-valuenow={frame}
          tabIndex={0}
          onPointerDown={onStripDown}
          onPointerMove={onStripMove}
          onPointerUp={onStripUp}
          onPointerCancel={onStripUp}
          onKeyDown={(e) => {
            if (e.key === "ArrowLeft") { e.preventDefault(); step(-1); }
            else if (e.key === "ArrowRight") { e.preventDefault(); step(1); }
          }}
        >
          <div className="ed-tp-fill" style={{ width: `${frac * 100}%` }} />
          <div className="ed-tp-knob" style={{ left: `${frac * 100}%` }} />
        </div>

        <div className="ed2-frameno">f{frame}<span> / {max}</span></div>
      </div>
    </div>
  );
}
