"use client";

import { useCallback, useRef, useState } from "react";
import { Scissors, Lock, ZoomIn, ZoomOut } from "lucide-react";
import type { TimelineView as TLView, TimelineClip } from "./types";

/* TimelineView — the frame-addressed timeline (Editor Frame-Control — Phase C).
   Renders every track's clips positioned by their FRAME extents (timeline_get
   returns both sec + frames; we lay out in frames against totalFrames), a playhead
   at the current frame, a ruler you click to seek, and per-clip selection + edits:
     · click the ruler            → onSeek(frame)
     · click a clip               → onSelect(clipId)
     · the razor button on a clip → onSplit(clipId, currentFrame)  (timeline_split_clip_frame)
     · drag a clip's edge handle  → onTrim(clipId, {inFrame|outFrame}) (timeline_trim_clip_frame)
     · drag the clip body         → onMove(clipId, startFrame)       (timeline_move_clip_frame)
   All edits are optimistic — the parent reloads timeline_get after each.

   Reuses the storyboard editor's .ed-track / .ed-playhead tokens inside the .ed2
   namespace; one accent (white). */

const PX_PER_FRAME_MIN = 0.06; // floor so a long cut stays scrollable, not infinite

export function TimelineView({
  timeline,
  fps,
  frame,
  totalFrames,
  selected,
  canEdit,
  busy,
  onSeek,
  onSelect,
  onSplit,
  onTrim,
  onMove,
}: {
  timeline: TLView | null;
  fps: number;
  frame: number;
  totalFrames: number;
  selected: string | null;
  canEdit: boolean;
  busy: boolean;
  onSeek: (frame: number) => void;
  onSelect: (clipId: string | null) => void;
  onSplit: (clipId: string, atFrame: number) => void;
  onTrim: (clipId: string, edges: { inFrame?: number; outFrame?: number }) => void;
  onMove: (clipId: string, startFrame: number) => void;
}) {
  const laneRef = useRef<HTMLDivElement>(null);
  const total = Math.max(1, totalFrames);
  const [zoom, setZoom] = useState(1); // 1 = fit; up to 8× for frame-level work
  const zoomBy = (f: number) => setZoom((z) => Math.max(0.5, Math.min(8, Math.round(z * f * 100) / 100)));

  // A drag in progress: which clip, which edge (or "body"), and the frame it started.
  const drag = useRef<{ clipId: string; mode: "in" | "out" | "body"; startFrame: number; baseStart: number; baseIn: number; baseOut: number } | null>(null);

  const frameFromX = useCallback((clientX: number) => {
    const lane = laneRef.current;
    if (!lane) return 0;
    const r = lane.getBoundingClientRect();
    const p = r.width ? (clientX - r.left + lane.scrollLeft) / lane.scrollWidth : 0;
    return Math.max(0, Math.min(total, Math.round(p * total)));
  }, [total]);

  const onRulerClick = (e: React.PointerEvent) => onSeek(frameFromX(e.clientX));

  const beginDrag = (e: React.PointerEvent, clip: TimelineClip, mode: "in" | "out" | "body") => {
    if (!canEdit || clip.locked) return;
    e.stopPropagation();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = {
      clipId: clip.id,
      mode,
      startFrame: frameFromX(e.clientX),
      baseStart: clip.startFrame,
      baseIn: Math.round(clip.sourceInSec * fps),
      baseOut: Math.round((clip.sourceOutSec ?? clip.endSec) * fps),
    };
  };

  const endDrag = (e: React.PointerEvent) => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    try { (e.target as HTMLElement).releasePointerCapture(e.pointerId); } catch { /* */ }
    const deltaF = frameFromX(e.clientX) - d.startFrame;
    if (deltaF === 0) return;
    if (d.mode === "body") onMove(d.clipId, Math.max(0, d.baseStart + deltaF));
    else if (d.mode === "in") onTrim(d.clipId, { inFrame: Math.max(0, d.baseIn + deltaF) });
    else onTrim(d.clipId, { outFrame: Math.max(0, d.baseOut + deltaF) });
  };

  const playheadPct = (frame / total) * 100;
  const widthPx = Math.max(640, total * PX_PER_FRAME_MIN * 100) * zoom; // zoomable, with a grab floor

  return (
    <div className="ed2-timeline">
      <div className="ed2-tl-head">
        <span className="ed2-eyebrow">Timeline</span>
        <div className="ed2-tl-tools">
          <span className="ed2-tl-meta">{total} frames · {fps}fps{timeline?.derived ? " · derived" : ""}</span>
          <div className="ed2-zoom">
            <button className="ed2-zoom-btn" onClick={() => zoomBy(1 / 1.5)} disabled={zoom <= 0.5} title="Zoom out" aria-label="Zoom out"><ZoomOut size={13} /></button>
            <span className="ed2-zoom-val">{zoom.toFixed(1)}×</span>
            <button className="ed2-zoom-btn" onClick={() => zoomBy(1.5)} disabled={zoom >= 8} title="Zoom in" aria-label="Zoom in"><ZoomIn size={13} /></button>
          </div>
        </div>
      </div>

      {!timeline ? (
        <div className="ed2-tl-empty">Loading the timeline…</div>
      ) : (
        <div className="ed2-tl-scroll" ref={laneRef}>
          <div className="ed2-tl-inner ed2-grid" style={{ width: widthPx }}>
            {/* ruler — click to seek */}
            <div className="ed2-ruler" onPointerDown={onRulerClick} role="slider" aria-label="Seek" aria-valuemin={0} aria-valuemax={total} aria-valuenow={frame}>
              {Array.from({ length: 11 }).map((_, i) => (
                <span key={i} className="ed2-tick" style={{ left: `${i * 10}%` }}>
                  {Math.round((i / 10) * total)}
                </span>
              ))}
            </div>

            {/* tracks */}
            {timeline.tracks.map((track) => (
              <div key={track.id} className="ed2-lane">
                <span className="ed2-lane-name">{track.name ?? track.id}</span>
                <div className="ed2-lane-clips">
                  {track.clips.map((clip) => {
                    const left = (clip.startFrame / total) * 100;
                    const width = Math.max(0.4, ((clip.endFrame - clip.startFrame) / total) * 100);
                    const isSel = clip.id === selected;
                    const isVideo = track.kind === "video";
                    return (
                      <div
                        key={clip.id}
                        className={`ed2-clip${isSel ? " sel" : ""}${clip.locked ? " locked" : ""}${isVideo ? " video" : ""}`}
                        style={{ left: `${left}%`, width: `${width}%` }}
                        onClick={(e) => { e.stopPropagation(); onSelect(isSel ? null : clip.id); }}
                        onPointerDown={(e) => beginDrag(e, clip, "body")}
                        onPointerUp={endDrag}
                        onPointerCancel={endDrag}
                        title={`${clip.id} · ${clip.startFrame}–${clip.endFrame}f`}
                      >
                        {/* head trim handle */}
                        {isVideo && !clip.locked && (
                          <span
                            className="ed2-clip-edge in"
                            onPointerDown={(e) => beginDrag(e, clip, "in")}
                            onPointerUp={endDrag}
                            onPointerCancel={endDrag}
                            title="Trim source in"
                          />
                        )}
                        <span className="ed2-clip-label">
                          {clip.locked && <Lock size={9} style={{ verticalAlign: "-1px", marginRight: 3, opacity: 0.7 }} />}
                          {clip.sceneRef ?? clip.id}
                        </span>
                        {/* razor at playhead — only when the playhead is inside this clip */}
                        {isVideo && !clip.locked && frame > clip.startFrame && frame < clip.endFrame && (
                          <button
                            className="ed2-clip-razor"
                            disabled={busy}
                            onClick={(e) => { e.stopPropagation(); onSplit(clip.id, frame); }}
                            title={`Split at frame ${frame}`}
                            aria-label="Split at playhead"
                          >
                            <Scissors size={11} />
                          </button>
                        )}
                        {/* tail trim handle */}
                        {isVideo && !clip.locked && (
                          <span
                            className="ed2-clip-edge out"
                            onPointerDown={(e) => beginDrag(e, clip, "out")}
                            onPointerUp={endDrag}
                            onPointerCancel={endDrag}
                            title="Trim source out"
                          />
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}

            {/* playhead spans all lanes */}
            <div className="ed-playhead ed2-playhead" style={{ left: `${playheadPct}%` }} />
          </div>
        </div>
      )}

      {!canEdit && <div className="sub" style={{ fontSize: 11.5, marginTop: 8 }}>View only — editing needs content access.</div>}
    </div>
  );
}
