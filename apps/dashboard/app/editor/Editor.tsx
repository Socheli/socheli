"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Film, Loader2 } from "lucide-react";
import { VideoScrubber } from "./VideoScrubber";
import { TimelineView } from "./TimelineView";
import { FrameInspector } from "./FrameInspector";
import { EditChatPanel } from "./EditChatPanel";
import type { EditorRun, TimelineView as TLView, TimelineClip } from "./types";

/* The FRAME EDITOR client surface (Editor Frame-Control — Phase C).

   Layout — three columns over a chat dock:
     LEFT  · VideoScrubber  — frame-accurate scrub over the rendered/source video;
                              dragging sets the current frame (mm:ss:ff) and the
                              inspector follows.
     MID   · FrameInspector — the at-frame read (timeline_seek_frame): vision
                              (description/subjects/motion/quality), transcript
                              words, music context. Empty states CTA dense-vision.
     RIGHT · (in the chat dock) EditChatPanel — chat-edit through the same /studio
                              /[id]/edit route + EditPlan approval card as /studio.
     UNDER · TimelineView    — tracks/clips from timeline_get, a playhead at the
                              current frame; click-the-ruler to seek, click-a-clip
                              to select, drag-trim / razor-split → /frame-edit.

   The single source of truth is `frame` (the current timeline frame) + `selected`
   (the selected clip id). Everything reads/derives from those. Long jobs (render,
   dense-vision) follow the detached-spawn contract; we poll GET /api/studio/[id]
   on the house 3500ms interval and bump videoKey when a new cut lands. */

type Job = { kind: "render" | "dense"; note: string };

export function Editor({ run, canEdit, canView }: { run: EditorRun; canEdit: boolean; canView: boolean }) {
  const fps = run.fps || 30;

  const [timeline, setTimeline] = useState<TLView | null>(null);
  const [frame, setFrame] = useState(0); // the current TIMELINE frame (source of truth)
  const [selected, setSelected] = useState<string | null>(null); // selected clip id
  const [hasVideo, setHasVideo] = useState(run.hasVideo);
  const [hasDenseVision, setHasDenseVision] = useState(run.hasDenseVision);
  const [videoKey, setVideoKey] = useState(0); // bump → remount the player on a new cut

  const [job, setJob] = useState<Job | null>(null); // a long detached job we're polling
  const [busy, setBusy] = useState(false); // a mutate/render request in flight
  const [err, setErr] = useState<string | null>(null);
  const [okMsg, setOkMsg] = useState<string | null>(null);

  const totalFrames = timeline?.totalFrames ?? Math.round((timeline?.totalSec ?? 0) * fps);

  /* ── timeline load (timeline_get + a fresh frame index) ───────────────────── */
  const loadTimeline = useCallback(async () => {
    try {
      const res = await fetch(`/api/studio/${run.id}/timeline`, { cache: "no-store" });
      if (!res.ok) return;
      const j = (await res.json()) as { timeline?: TLView };
      if (j.timeline) setTimeline(j.timeline);
    } catch {
      /* keep the current view */
    }
  }, [run.id]);

  useEffect(() => {
    if (canView) void loadTimeline();
  }, [canView, loadTimeline]);

  /* ── seek: set the current frame, clamped to the timeline ─────────────────── */
  const seek = useCallback(
    (f: number) => {
      const max = Math.max(0, totalFrames - 1);
      setFrame(Math.max(0, Math.min(max || f, Math.round(f))));
    },
    [totalFrames],
  );

  /* ── job polling: while a render / dense-vision runs, poll the detail GET ──── */
  useEffect(() => {
    if (!job) return;
    let alive = true;
    const tick = async () => {
      try {
        const res = await fetch(`/api/studio/${run.id}`, { cache: "no-store" });
        if (!res.ok || !alive) return;
        const d = (await res.json()) as {
          hasVideo?: boolean;
          understanding?: { built?: boolean; understanding?: { denseFrameVision?: { frameCount?: number } } };
        };
        if (job.kind === "render" && d.hasVideo) {
          setJob(null);
          setHasVideo(true);
          setVideoKey((k) => k + 1);
          setOkMsg("Render complete — preview updated.");
          void loadTimeline();
        } else if (job.kind === "dense") {
          const cnt = d.understanding?.understanding?.denseFrameVision?.frameCount ?? 0;
          if (cnt > 0) {
            setJob(null);
            setHasDenseVision(true);
            setOkMsg("Dense vision built — scrub to read any frame.");
          }
        }
      } catch {
        /* keep polling */
      }
    };
    const iv = setInterval(tick, 3500);
    void tick();
    return () => { alive = false; clearInterval(iv); };
  }, [job, run.id, loadTimeline]);

  /* ── frame edits (trim / split / move) → /frame-edit, optimistic refresh ──── */
  const frameEdit = useCallback(
    async (body: Record<string, unknown>) => {
      if (!canEdit) return;
      setBusy(true);
      setErr(null);
      setOkMsg(null);
      try {
        const res = await fetch(`/api/studio/${run.id}/frame-edit`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const j = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
        if (j.skipped) setOkMsg(`Skipped — ${j.skipped}`);
        else setOkMsg(`Applied ${String(j.op ?? "edit")}.`);
        await loadTimeline(); // optimistic refresh against the new geometry
      } catch (e) {
        setErr(e instanceof Error ? e.message : "frame edit failed");
      } finally {
        setBusy(false);
      }
    },
    [canEdit, run.id, loadTimeline],
  );

  const onTrim = useCallback((clipId: string, edges: { inFrame?: number; outFrame?: number }) => frameEdit({ op: "trim", clipId, ...edges }), [frameEdit]);
  const onSplit = useCallback((clipId: string, atFrame: number) => frameEdit({ op: "split", clipId, atFrame }), [frameEdit]);
  const onMove = useCallback((clipId: string, startFrame: number) => frameEdit({ op: "move", clipId, startFrame }), [frameEdit]);

  /* ── dense vision (build the grid) ────────────────────────────────────────── */
  const onBuildDenseVision = useCallback(async () => {
    if (!canEdit) return;
    setErr(null);
    setOkMsg(null);
    try {
      const res = await fetch(`/api/studio/${run.id}/dense-vision`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sampleFps: 1 }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
      setJob({ kind: "dense", note: "Reading every frame (dense vision)…" });
    } catch (e) {
      setErr(e instanceof Error ? e.message : "dense vision failed");
    }
  }, [canEdit, run.id]);

  /* ── render the cut ───────────────────────────────────────────────────────── */
  const onRender = useCallback(async () => {
    if (!canEdit) return;
    setErr(null);
    setOkMsg(null);
    try {
      const res = await fetch(`/api/studio/${run.id}/render`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
      if (j.job?.status === "started") setJob({ kind: "render", note: "Rendering the new cut…" });
      else { setOkMsg("Render complete."); setVideoKey((k) => k + 1); }
    } catch (e) {
      setErr(e instanceof Error ? e.message : "render failed");
    }
  }, [canEdit, run.id]);

  const selectedClip: TimelineClip | null = useMemo(() => {
    if (!selected || !timeline) return null;
    for (const t of timeline.tracks) for (const c of t.clips) if (c.id === selected) return c;
    return null;
  }, [selected, timeline]);

  if (!canView) {
    return <div className="empty">You don&apos;t have access to view this run.</div>;
  }

  return (
    <div className="ed2">
      {/* toolbar */}
      <div className="ed2-bar">
        <Link href="/studio" className="ed2-back" title="Back to Editor Studio">
          <ArrowLeft size={14} /> Studio
        </Link>
        <div className="ed2-title">
          <span className="ed2-eyebrow">Frame Editor</span>
          <span className="ed2-run">{run.name}</span>
        </div>
        <span className="ed2-spacer" />
        {job && (
          <span className="ed2-job"><span className="spin" />{job.note}</span>
        )}
        <button className="btn btn-primary" onClick={onRender} disabled={!canEdit || !!job}>
          {job?.kind === "render" ? <Loader2 size={14} className="spin" style={{ animation: "st-spin .8s linear infinite" }} /> : <Film size={14} />}
          Render cut
        </button>
      </div>

      {err && <div className="st-err">{err}</div>}
      {okMsg && !job && <div className="st-ok">{okMsg}</div>}

      {/* stage: scrubber + inspector */}
      <div className="ed2-stage">
        <VideoScrubber
          src={hasVideo ? `/api/video/${run.id}?v=${videoKey}` : null}
          videoKey={videoKey}
          fps={fps}
          frame={frame}
          totalFrames={totalFrames}
          onSeek={seek}
        />
        <FrameInspector
          runId={run.id}
          fps={fps}
          frame={frame}
          hasDenseVision={hasDenseVision}
          canEdit={canEdit}
          building={job?.kind === "dense"}
          onBuildDenseVision={onBuildDenseVision}
        />
      </div>

      {/* timeline */}
      <TimelineView
        timeline={timeline}
        fps={fps}
        frame={frame}
        totalFrames={totalFrames}
        selected={selected}
        canEdit={canEdit}
        busy={busy}
        onSeek={seek}
        onSelect={setSelected}
        onSplit={onSplit}
        onTrim={onTrim}
        onMove={onMove}
      />

      {/* chat-edit dock (reuses the /studio edit route + EditPlan approval card) */}
      <EditChatPanel
        runId={run.id}
        canEdit={canEdit}
        onRendering={() => setJob({ kind: "render", note: "Rendering the new cut…" })}
        onApplied={() => { setOkMsg("Applied."); void loadTimeline(); setVideoKey((k) => k + 1); }}
      />

      {selectedClip && (
        <div className="sub" style={{ fontSize: 11.5, marginTop: -6 }}>
          Selected clip <b>{selectedClip.id}</b> · {selectedClip.startFrame}–{selectedClip.endFrame}f
          {selectedClip.locked ? " · locked" : ""}
        </div>
      )}
    </div>
  );
}
