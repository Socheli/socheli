"use client";

import { useCallback, useRef } from "react";

/* Filmstrip — the whole cut laid out as thumbnails (Editor Frame-Control — Phase C).
   A single tiled jpg from /api/studio/[id]/filmstrip stretched across the full width,
   so the x-axis IS time: click or drag anywhere to seek there, and a cursor rides the
   strip at the current frame. Re-keys on videoKey so a fresh render regenerates it. */
export function Filmstrip({
  runId,
  videoKey,
  frame,
  totalFrames,
  hasVideo,
  onSeek,
}: {
  runId: string;
  videoKey: number;
  frame: number;
  totalFrames: number;
  hasVideo: boolean;
  onSeek: (frame: number) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const max = Math.max(1, totalFrames - 1);
  const frac = Math.max(0, Math.min(1, frame / max));

  const seekAt = useCallback(
    (clientX: number) => {
      const el = ref.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const p = r.width ? Math.max(0, Math.min(1, (clientX - r.left) / r.width)) : 0;
      onSeek(Math.round(p * max));
    },
    [max, onSeek],
  );

  if (!hasVideo) return null;

  return (
    <div
      ref={ref}
      className="ed2-filmstrip"
      role="slider"
      aria-label="Filmstrip scrubber"
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={frame}
      style={{ backgroundImage: `url(/api/studio/${runId}/filmstrip?v=${videoKey})` }}
      onPointerDown={(e) => { (e.target as HTMLElement).setPointerCapture(e.pointerId); dragging.current = true; seekAt(e.clientX); }}
      onPointerMove={(e) => { if (dragging.current) seekAt(e.clientX); }}
      onPointerUp={(e) => { dragging.current = false; try { (e.target as HTMLElement).releasePointerCapture(e.pointerId); } catch { /* */ } }}
      onPointerCancel={() => { dragging.current = false; }}
    >
      <div className="ed2-fs-cursor" style={{ left: `${frac * 100}%` }} />
    </div>
  );
}
