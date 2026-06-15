/**
 * timeline.ts — the COMPUTED, read-only timeline VIEW (DaVinci spine, M1 §2.1/§5).
 *
 * This is the single inspection surface all four crafts read (§2.1: "a computed
 * timeline view — the single inspection surface all four crafts read"). It is the
 * READ side only — NOT the build (`timeline_build` / `compileTimeline` land in
 * later milestones M10/M11). `timelineView` never mutates and never saves.
 *
 * Two paths, one shape:
 *   1. If `item.timeline` exists, RESOLVE its persisted tracks/clips into a
 *      frame-addressed read-only table (frames computed from the editor fps,
 *      falling back to storyboard fps).
 *   2. If there is NO timeline yet, DERIVE a view from the current render source
 *      of truth — one video clip per VISIBLE scene (start/duration from the
 *      storyboard's sequential scene timing) plus one audio clip per Mix track —
 *      so the view ALWAYS works, even pre-build. This mirrors the existing
 *      read-only `sceneStarts()`/`TimelineScene` derivation in editor-tools.ts.
 *
 * The frame axis is the contract every craft addresses against: each clip carries
 * BOTH seconds (authoring) and frames (render-aligned), so a colorist/mixer can
 * line evidence (scopes/meters read off rendered frames) up with a clip without
 * re-deriving timing.
 */

import type { Clip, Marker, Track } from "@os/schemas";

import { loadItem } from "../store.ts";

// One resolved clip on the read-only view: timeline placement in BOTH seconds
// (authoring) and frames (render-aligned), plus the source in/out window.
export type TimelineViewClip = {
  id: string;
  trackId: string;
  kind: Clip["kind"];
  /** storyboard scene this clip realizes (video/text clips), if any. */
  sceneRef?: string;
  /** asset path/url for source-backed clips (b-roll/voice/sfx), if any. */
  src?: string;
  startFrame: number;
  endFrame: number;
  startSec: number;
  endSec: number;
  durationSec: number;
  /** source window into the underlying asset/scene (seconds). */
  sourceInSec: number;
  sourceOutSec?: number;
  enabled: boolean;
  locked: boolean;
};

export type TimelineViewTrack = {
  id: string;
  kind: Track["kind"];
  name?: string;
  clips: TimelineViewClip[];
};

export type TimelineView = {
  fps: number;
  totalFrames: number;
  totalSec: number;
  /** whether this view was resolved from a persisted timeline (vs derived). */
  derived: boolean;
  tracks: TimelineViewTrack[];
  markers: Marker[];
};

// Seconds → whole frames. Round (not floor) so a 2.0s clip at 30fps is exactly
// 60 frames and sub-frame drift doesn't accumulate into off-by-one gaps.
const toFrames = (sec: number, fps: number) => Math.round(sec * fps);
const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Compute the read-only, frame-addressed timeline view for a run.
 *
 * Pure: loads the item, never mutates or saves. Always returns a usable view —
 * resolved from `item.timeline` when present, otherwise derived from the
 * storyboard (visible scenes) + Mix (audio tracks).
 */
export function timelineView(id: string): TimelineView {
  const item = loadItem(id);
  const sbFps = item.storyboard?.fps ?? 30;

  // ── Path 1: a persisted timeline exists → resolve its clips to frames. ──
  if (item.timeline) {
    const fps = item.timeline.fps ?? sbFps;
    const tracks: TimelineViewTrack[] = (item.timeline.tracks ?? []).map((track) => ({
      id: track.id,
      kind: track.kind,
      name: track.name,
      clips: (track.clips ?? []).map((clip) => {
        const startSec = round2(clip.startSec ?? 0);
        const durationSec = round2(clip.durationSec ?? 0);
        const endSec = round2(startSec + durationSec);
        const sourceInSec = round2(clip.inSec ?? 0);
        return {
          id: clip.id,
          trackId: track.id,
          kind: clip.kind,
          sceneRef: clip.sceneRef,
          src: clip.src,
          startFrame: toFrames(startSec, fps),
          endFrame: toFrames(endSec, fps),
          startSec,
          endSec,
          durationSec,
          sourceInSec,
          sourceOutSec: clip.outSec !== undefined ? round2(clip.outSec) : undefined,
          enabled: clip.enabled ?? true,
          locked: clip.locked ?? false,
        };
      }),
    }));

    // Total = the furthest clip end across all tracks (the cut's length).
    const totalSec = round2(
      tracks.reduce((max, t) => t.clips.reduce((m, c) => Math.max(m, c.endSec), max), 0),
    );
    return {
      fps,
      totalFrames: toFrames(totalSec, fps),
      totalSec,
      derived: false,
      tracks,
      markers: item.timeline.markers ?? [],
    };
  }

  // ── Path 2: no timeline yet → derive from storyboard + mix. ──
  const fps = sbFps;
  const scenes = item.storyboard?.scenes ?? [];

  // One video clip per VISIBLE (non-hidden) scene, laid sequentially — the same
  // timing the renderer plays scenes at (cf. sceneStarts() in editor-tools.ts).
  // We honour `hidden` so the derived view matches what actually renders.
  const videoClips: TimelineViewClip[] = [];
  let cursor = 0;
  for (const scene of scenes) {
    if ((scene as any).hidden) continue;
    const durationSec = round2(Number((scene as any).durationSec) || 0);
    const startSec = round2(cursor);
    const endSec = round2(startSec + durationSec);
    videoClips.push({
      id: `clip_${scene.id}`,
      trackId: "V1",
      kind: "video",
      sceneRef: scene.id,
      startFrame: toFrames(startSec, fps),
      endFrame: toFrames(endSec, fps),
      startSec,
      endSec,
      durationSec,
      sourceInSec: 0,
      sourceOutSec: durationSec,
      enabled: true,
      locked: Boolean((scene as any).locked),
    });
    cursor = endSec;
  }

  const totalSec = round2(cursor);
  const totalFrames = toFrames(totalSec, fps);

  const tracks: TimelineViewTrack[] = [{ id: "V1", kind: "video", name: "Video", clips: videoClips }];

  // One audio clip per Mix track (music/voice/sfx), each spanning the full cut —
  // we have no per-clip audio timing pre-build, so the bed runs the whole length.
  // A muted/disabled track yields a clip flagged `enabled: false` so the view
  // still shows the lane (matching the editor's layer semantics).
  const mixTracks = item.mix?.tracks ?? [];
  for (const at of mixTracks) {
    const muted =
      at.mute ||
      at.disabled ||
      (at.id === "music" && item.mix?.muteMusic) ||
      (at.id === "voice" && item.mix?.muteVoice) ||
      (at.id === "sfx" && item.mix?.muteSfx);
    tracks.push({
      id: `A_${at.id}`,
      kind: "audio",
      name: at.name ?? at.id,
      clips:
        totalSec > 0
          ? [
              {
                id: `clip_${at.id}`,
                trackId: `A_${at.id}`,
                kind: "audio",
                startFrame: 0,
                endFrame: totalFrames,
                startSec: 0,
                endSec: totalSec,
                durationSec: totalSec,
                sourceInSec: 0,
                sourceOutSec: totalSec,
                enabled: !muted,
                locked: Boolean(at.locked),
              },
            ]
          : [],
    });
  }

  return { fps, totalFrames, totalSec, derived: true, tracks, markers: [] };
}
