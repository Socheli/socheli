/**
 * frame-index.ts — Editor Frame-Control Phase B2: make the timeline
 * FRAME-ADDRESSABLE.
 *
 * The timeline (schemas/index.ts Timeline/Track/Clip) already stores everything
 * in SECONDS plus an optional `timeline.fps`. This module adds the frame layer:
 *
 *   - buildFrameIndex(id)        — compute Clip.inFrame/outFrame/startFrame from
 *                                  sec*fps and persist a per-clip
 *                                  Timeline.frameMetadata index. Seconds stay the
 *                                  source of truth; frame fields are a derived
 *                                  mirror. Idempotent & legacy-safe.
 *   - queryFrameOnTimeline(id,…) — "which clip is at TIMELINE frame N / sec T",
 *                                  with the clip's source window.
 *   - seekTimelineFrame(id, N)   — the full at-a-frame read: clip + source window
 *                                  + vision + words + music (composes the sibling
 *                                  helpers).
 *   - queryFrameRange(id, a, b)  — clips + metadata overlapping [a,b] for a
 *                                  scrubber.
 *
 * UNIT MODEL (mirrors render.ts / timeline-edit.ts):
 *   - startSec/durationSec = the clip on the TIMELINE.
 *   - inSec/outSec/speed   = the clip's window into its SOURCE asset.
 *   - TIMELINE frame  = round(timelineSec * fps)   (frameMetadata.frames[].frameIndex)
 *   - SOURCE  frame   = round(sourceSec   * fps)   (Clip.inFrame/outFrame)
 *   - Clip.startFrame = round(startSec * fps)      (timeline frame of the start)
 *
 * FAIL-OPEN throughout: a missing timeline / item never throws out of a query —
 * read paths return null/empty; the mutate (buildFrameIndex) clamps and skips.
 */

import type { Clip, ContentItem, Timeline, Track } from "@os/schemas";

import { loadItem, nowIso, saveItem } from "../store.ts";
import { frameVisionAt } from "./frame-vision-query.ts";
import { wordsInFrameRange } from "./frame-transcript.ts";
import { queryMusicInFrameRange } from "./frame-music.ts";

// ── fps resolution ───────────────────────────────────────────────────────────
/** The fps to use for EVERY sec↔frame conversion on this item. Precedence:
 *  timeline.fps → storyboard.fps → source probe fps → 30. */
export function resolveFps(item: ContentItem): number {
  const t = (item as any)?.timeline?.fps;
  if (typeof t === "number" && t > 0) return t;
  const sb = (item as any)?.storyboard?.fps;
  if (typeof sb === "number" && sb > 0) return sb;
  const probe = (item as any)?.source?.probe?.video?.fps;
  if (typeof probe === "number" && probe > 0) return probe;
  return 30;
}

const toFrame = (sec: number, fps: number) => Math.max(0, Math.round(sec * fps));
const toSec = (frame: number, fps: number) => Number((frame / Math.max(1, fps)).toFixed(3));

function videoTracks(timeline: Timeline | undefined): Track[] {
  if (!timeline?.tracks) return [];
  return timeline.tracks.filter((t) => t.kind === "video" || t.kind === "overlay");
}

/** All clips that play on the timeline, flattened across video/overlay tracks
 *  with their owning track id, sorted by timeline start. */
function timelineClips(timeline: Timeline | undefined): { track: Track; clip: Clip }[] {
  const out: { track: Track; clip: Clip }[] = [];
  for (const track of videoTracks(timeline)) {
    for (const clip of track.clips ?? []) {
      if (clip.enabled === false) continue;
      out.push({ track, clip });
    }
  }
  return out.sort((a, b) => (a.clip.startSec ?? 0) - (b.clip.startSec ?? 0));
}

// ── B2: buildFrameIndex ──────────────────────────────────────────────────────
export type FrameIndexResult = {
  id: string;
  fps: number;
  clipCount: number;
  frameCount: number;
  /** total addressable timeline frames (timeline duration * fps). */
  timelineFrames: number;
};

/**
 * Compute the frame mirror for every clip and persist the per-clip timeline
 * frame index. Idempotent: re-running recomputes from the (authoritative)
 * seconds fields. Legacy-safe: clips without out/duration degrade gracefully.
 */
export function buildFrameIndex(id: string): FrameIndexResult {
  const item = loadItem(id);
  const timeline = (item as any).timeline as Timeline | undefined;
  if (!timeline) {
    return { id, fps: resolveFps(item), clipCount: 0, frameCount: 0, timelineFrames: 0 };
  }
  const fps = resolveFps(item);
  const frameMetadata: NonNullable<Timeline["frameMetadata"]> = {};
  let frameCount = 0;
  let maxTimelineFrame = 0;

  for (const track of timeline.tracks ?? []) {
    for (const clip of track.clips ?? []) {
      const inSec = clip.inSec ?? 0;
      const speed = clip.speed ?? 1;
      const durationSec = clip.durationSec ?? 0;
      // Mirror the SOURCE window in frames.
      const outSec = clip.outSec ?? inSec + durationSec * speed;
      clip.inFrame = toFrame(inSec, fps);
      clip.outFrame = toFrame(outSec, fps);
      // Mirror the TIMELINE start in frames.
      const startSec = clip.startSec ?? 0;
      clip.startFrame = toFrame(startSec, fps);

      // Only picture clips get a per-frame timeline index (audio/text don't need
      // frame-by-frame scrub addressing). Build the dense per-frame list for the
      // span this clip occupies on the timeline.
      if (track.kind === "video" || track.kind === "overlay") {
        const startF = clip.startFrame;
        const endF = toFrame(startSec + durationSec, fps);
        const frames: { frameIndex: number; atSec: number }[] = [];
        for (let f = startF; f < Math.max(startF + 1, endF); f++) {
          frames.push({ frameIndex: f, atSec: toSec(f, fps) });
        }
        frameMetadata[clip.id] = { frames };
        frameCount += frames.length;
        maxTimelineFrame = Math.max(maxTimelineFrame, endF);
      }
    }
  }

  timeline.frameMetadata = frameMetadata;
  timeline.fps = fps;
  (item as any).updatedAt = nowIso();
  saveItem(item as ContentItem);

  return {
    id,
    fps,
    clipCount: timelineClips(timeline).length,
    frameCount,
    timelineFrames: maxTimelineFrame,
  };
}

// ── queryFrameOnTimeline ─────────────────────────────────────────────────────
export type FrameOnTimeline = {
  /** the picture clip occupying this frame (null if the frame is in a gap). */
  clip: Clip | null;
  /** the source-time window of `clip` that this timeline frame samples. */
  sourceInSec: number | null;
  sourceOutSec: number | null;
  /** the exact source second this timeline frame reads (in source time). */
  sourceAtSec: number | null;
  /** the timeline frame where `clip` starts. */
  timelineStartFrame: number | null;
  /** the resolved timeline position. */
  atSec: number;
  atFrame: number;
};

/**
 * Resolve a position on the TIMELINE (by frame or sec) to the picture clip
 * playing there and the source window it reads. Fail-open: an out-of-range or
 * gap position returns clip:null with the resolved atFrame/atSec.
 */
export function queryFrameOnTimeline(
  id: string,
  pos: { atFrame?: number; atSec?: number },
): FrameOnTimeline {
  const item = loadItem(id);
  const timeline = (item as any).timeline as Timeline | undefined;
  const fps = resolveFps(item);
  const atFrame =
    pos.atFrame != null
      ? Math.max(0, Math.round(pos.atFrame))
      : toFrame(pos.atSec ?? 0, fps);
  const atSec = pos.atSec != null ? pos.atSec : toSec(atFrame, fps);

  const empty: FrameOnTimeline = {
    clip: null,
    sourceInSec: null,
    sourceOutSec: null,
    sourceAtSec: null,
    timelineStartFrame: null,
    atSec: Number(atSec.toFixed(3)),
    atFrame,
  };
  if (!timeline) return empty;

  // The topmost picture clip whose timeline window contains atSec (later tracks
  // / later clips win, matching an overlay-over-base composite).
  let hit: Clip | null = null;
  for (const { clip } of timelineClips(timeline)) {
    const start = clip.startSec ?? 0;
    const end = start + (clip.durationSec ?? 0);
    if (atSec >= start && atSec < end) hit = clip;
  }
  if (!hit) return empty;

  const startSec = hit.startSec ?? 0;
  const inSec = hit.inSec ?? 0;
  const speed = hit.speed ?? 1;
  const durationSec = hit.durationSec ?? 0;
  const outSec = hit.outSec ?? inSec + durationSec * speed;
  // Map the timeline offset back into the source window.
  const sourceAtSec = Number((inSec + (atSec - startSec) * speed).toFixed(3));

  return {
    clip: hit,
    sourceInSec: Number(inSec.toFixed(3)),
    sourceOutSec: Number(outSec.toFixed(3)),
    sourceAtSec,
    timelineStartFrame: toFrame(startSec, fps),
    atSec: Number(atSec.toFixed(3)),
    atFrame,
  };
}

// ── seekTimelineFrame: the full at-a-frame read ─────────────────────────────
export type FrameSeek = FrameOnTimeline & {
  fps: number;
  /** dense per-frame vision at (or nearest to) this frame, if a grid exists. */
  vision: ReturnType<typeof frameVisionAt>;
  /** transcript words mapped onto this single timeline frame. */
  words: ReturnType<typeof wordsInFrameRange>["words"];
  /** beats/sections/energy overlapping this single timeline frame. */
  music: ReturnType<typeof queryMusicInFrameRange>;
};

/**
 * The composite "what's at timeline frame N": which clip, its source window, the
 * dense-vision read at that source moment, the transcript words on that frame,
 * and the music context at that frame. Fail-open: every modality degrades to
 * null/empty independently.
 */
export function seekTimelineFrame(id: string, frameIndex: number): FrameSeek {
  const item = loadItem(id);
  const fps = resolveFps(item);
  const atFrame = Math.max(0, Math.round(frameIndex));
  const base = queryFrameOnTimeline(id, { atFrame });

  // Vision is indexed in SOURCE/timeline-frame units of the dense grid (its
  // frameIndex = atSec*fps over the SOURCE). Look it up at the source moment this
  // timeline frame reads (falls back to the timeline second when no clip).
  const visionAtSec = base.sourceAtSec ?? base.atSec;
  const vision = frameVisionAt(item as ContentItem, visionAtSec, fps);

  const words = wordsInFrameRange(id, atFrame, atFrame).words;
  const music = queryMusicInFrameRange(id, atFrame, atFrame);

  return { ...base, fps, vision, words, music };
}

// ── queryFrameRange ──────────────────────────────────────────────────────────
export type FrameRange = {
  id: string;
  fps: number;
  startFrame: number;
  endFrame: number;
  startSec: number;
  endSec: number;
  /** every picture clip overlapping [startFrame,endFrame] with its frame mirror. */
  clips: {
    clip: Clip;
    trackId: string;
    startFrame: number;
    endFrame: number;
    /** the slice of this clip's timeline-frame metadata inside the range. */
    frames: { frameIndex: number; atSec: number }[];
  }[];
};

/**
 * Every picture clip (and its persisted frame metadata) overlapping the timeline
 * frame range [startFrame, endFrame] — what a scrubber needs to paint a window.
 * Fail-open: no timeline → empty clips.
 */
export function queryFrameRange(id: string, startFrame: number, endFrame: number): FrameRange {
  const item = loadItem(id);
  const timeline = (item as any).timeline as Timeline | undefined;
  const fps = resolveFps(item);
  const a = Math.max(0, Math.round(Math.min(startFrame, endFrame)));
  const b = Math.max(a, Math.round(Math.max(startFrame, endFrame)));
  const startSec = toSec(a, fps);
  const endSec = toSec(b, fps);

  const clips: FrameRange["clips"] = [];
  if (timeline) {
    for (const { track, clip } of timelineClips(timeline)) {
      const cStartF = toFrame(clip.startSec ?? 0, fps);
      const cEndF = toFrame((clip.startSec ?? 0) + (clip.durationSec ?? 0), fps);
      if (cEndF <= a || cStartF > b) continue; // no overlap
      const meta = timeline.frameMetadata?.[clip.id]?.frames ?? [];
      const frames = meta.filter((f) => f.frameIndex >= a && f.frameIndex <= b);
      clips.push({ clip, trackId: track.id, startFrame: cStartF, endFrame: cEndF, frames });
    }
  }

  return { id, fps, startFrame: a, endFrame: b, startSec, endSec, clips };
}
