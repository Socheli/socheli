/**
 * frame-edit.ts — Editor Frame-Control B3: FRAME-EXACT edit primitives.
 *
 * These are the human/agent edit ops expressed in FRAMES (not seconds), so a UI
 * scrubber or a "split on the beat at frame 412" agent op lands on an exact
 * frame. They mutate `item.timeline` directly and saveItem — seconds stay the
 * authoritative storage (render reads seconds), but every write here snaps to a
 * whole frame (frameSec = frame/fps) so the result is frame-grid-aligned and the
 * derived inFrame/outFrame/startFrame mirror stays consistent.
 *
 * DISCIPLINE (mirrors creative/timeline-edit.ts exactly):
 *   - SKIP-NOT-THROW: a bad/ambiguous op returns { skipped } rather than throwing.
 *   - LOCKED-SAFE: a locked clip is never trimmed/split/moved.
 *   - MIN DURATION: never produce a clip shorter than MIN_FRAMES.
 *   - IDEMPOTENT: a trim/move to the value a clip already holds is a no-op skip;
 *     a split id is "<id>_b" (re-splitting the same clip collides → skip).
 *   - FAIL-OPEN: never throws out; recomputes the seconds + frame mirror fields.
 */

import type { Clip, ContentItem, Timeline, Track } from "@os/schemas";

import { loadItem, nowIso, saveItem } from "../store.ts";
import { resolveFps } from "./frame-index.ts";

/** Smallest a clip may become, in FRAMES (≈ MIN_CLIP_SEC 0.1s at 30fps = 3). */
const MIN_FRAMES = 3;

const toFrame = (sec: number, fps: number) => Math.max(0, Math.round(sec * fps));
const frameToSec = (frame: number, fps: number) => Number((frame / Math.max(1, fps)).toFixed(3));

export type FrameEditResult = {
  id: string;
  op: string;
  changed: string[];
  touched: string[];
  skipped?: string;
  fps?: number;
};

const skip = (id: string, op: string, why: string): FrameEditResult => ({
  id,
  op,
  changed: [],
  touched: [],
  skipped: why,
});

function withTimeline(id: string): { item: ContentItem; tl: Timeline; fps: number } | null {
  const item = loadItem(id);
  const tl = (item as any).timeline as Timeline | undefined;
  if (!tl) return null;
  return { item, tl, fps: resolveFps(item) };
}

function locate(tl: Timeline, clipId: string): { track: Track; clip: Clip; index: number } | null {
  for (const track of tl.tracks ?? []) {
    const index = (track.clips ?? []).findIndex((c) => c.id === clipId);
    if (index >= 0) return { track, clip: track.clips[index], index };
  }
  return null;
}

function reorder(track: Track) {
  track.clips.sort((a, b) => (a.startSec ?? 0) - (b.startSec ?? 0));
}

/** Snap a clip's seconds fields onto the frame grid and refresh its frame mirror
 *  (inFrame/outFrame/startFrame). Keeps seconds authoritative but frame-aligned. */
function syncClipFrames(clip: Clip, fps: number) {
  const inSec = clip.inSec ?? 0;
  const speed = clip.speed ?? 1;
  const durationSec = clip.durationSec ?? 0;
  const outSec = clip.outSec ?? inSec + durationSec * speed;
  clip.inFrame = toFrame(inSec, fps);
  clip.outFrame = toFrame(outSec, fps);
  clip.startFrame = toFrame(clip.startSec ?? 0, fps);
}

function commit(item: ContentItem) {
  // The persisted frameMetadata index is now stale; drop it so the next
  // buildFrameIndex / read rebuilds it (cheaper than re-indexing here, and a read
  // path can lazily rebuild). compiledAt is left as-is (timeline still owns time).
  const tl = (item as any).timeline as Timeline | undefined;
  if (tl?.frameMetadata) delete tl.frameMetadata;
  (item as any).updatedAt = nowIso();
  saveItem(item);
}

// ── trimClipByFrames ─────────────────────────────────────────────────────────
/**
 * Set a clip's SOURCE in/out edges to exact frames (frame-exact ripple-less trim
 * that keeps the clip's timeline START fixed and adjusts duration). Either edge
 * is optional; omitted edge is left untouched. The window is clamped so:
 *   - inFrame ≥ 0 and inFrame < outFrame - MIN_FRAMES
 *   - the resulting played duration stays ≥ MIN_FRAMES
 * Idempotent: a trim to the clip's current in/out is a no-op skip.
 */
export function trimClipByFrames(
  id: string,
  clipId: string,
  edges: { inFrame?: number; outFrame?: number },
): FrameEditResult {
  const op = "trim_frame";
  const got = withTimeline(id);
  if (!got) return skip(id, op, "no timeline on item — build one first");
  const { item, tl, fps } = got;
  const found = locate(tl, clipId);
  if (!found) return skip(id, op, `clip ${clipId} not found`);
  const { clip } = found;
  if (clip.locked) return skip(id, op, `clip ${clipId} is locked — never trimmed`);

  const speed = clip.speed ?? 1;
  const curInF = toFrame(clip.inSec ?? 0, fps);
  const curOutF = toFrame(clip.outSec ?? (clip.inSec ?? 0) + (clip.durationSec ?? 0) * speed, fps);

  let newInF = edges.inFrame != null ? Math.round(edges.inFrame) : curInF;
  let newOutF = edges.outFrame != null ? Math.round(edges.outFrame) : curOutF;
  newInF = Math.max(0, newInF);
  if (newOutF - newInF < MIN_FRAMES) {
    return skip(id, op, `trim would leave < ${MIN_FRAMES} source frames (in ${newInF}, out ${newOutF})`);
  }
  if (newInF === curInF && newOutF === curOutF) {
    return skip(id, op, "trim is a no-op (in/out already at those frames)");
  }

  const newInSec = frameToSec(newInF, fps);
  const newOutSec = frameToSec(newOutF, fps);
  clip.inSec = newInSec;
  clip.outSec = newOutSec;
  // Played (timeline) duration = source span / speed, snapped to the grid.
  const newDurSec = frameToSec(Math.round((newOutF - newInF) / Math.max(0.0001, speed)), fps);
  clip.durationSec = Math.max(frameToSec(MIN_FRAMES, fps), newDurSec);
  syncClipFrames(clip, fps);
  reorder(found.track);
  commit(item);
  return {
    id,
    op,
    fps,
    changed: [`trim ${clipId}: source [${newInF}..${newOutF}]f, dur ${clip.durationSec}s`],
    touched: [clipId],
  };
}

// ── splitClipAtFrame ─────────────────────────────────────────────────────────
/**
 * Razor a clip at an exact TIMELINE frame → two clips. LEFT keeps the original
 * id (refs survive); RIGHT is "<id>_b" inheriting every prop with its own source
 * window. The cut must land ≥ MIN_FRAMES inside each side. Idempotent: a "<id>_b"
 * collision (already split there) → skip.
 */
export function splitClipAtFrame(id: string, clipId: string, atFrame: number): FrameEditResult {
  const op = "split_frame";
  const got = withTimeline(id);
  if (!got) return skip(id, op, "no timeline on item — build one first");
  const { item, tl, fps } = got;
  const found = locate(tl, clipId);
  if (!found) return skip(id, op, `clip ${clipId} not found`);
  const { track, clip, index } = found;
  if (clip.locked) return skip(id, op, `clip ${clipId} is locked — never split`);

  const at = Math.round(atFrame);
  const startF = toFrame(clip.startSec ?? 0, fps);
  const endF = toFrame((clip.startSec ?? 0) + (clip.durationSec ?? 0), fps);
  if (at <= startF + MIN_FRAMES || at >= endF - MIN_FRAMES) {
    return skip(id, op, `atFrame ${at} outside splittable range (${startF + MIN_FRAMES}..${endF - MIN_FRAMES})`);
  }
  const rightId = `${clip.id}_b`;
  if ((track.clips ?? []).some((c) => c.id === rightId)) {
    return skip(id, op, `clip ${rightId} already exists — already split (idempotent)`);
  }

  const speed = clip.speed ?? 1;
  const atSec = frameToSec(at, fps);
  const splitOffsetSec = atSec - (clip.startSec ?? 0); // timeline seconds into the clip
  const srcSplitSec =
    clip.outSec !== undefined
      ? frameToSec(toFrame((clip.inSec ?? 0) + splitOffsetSec * speed, fps), fps)
      : undefined;

  const leftDurSec = frameToSec(at - startF, fps);
  const rightDurSec = frameToSec(endF - at, fps);

  const right: Clip = {
    ...clip,
    id: rightId,
    startSec: atSec,
    durationSec: rightDurSec,
    inSec: srcSplitSec ?? clip.inSec ?? 0,
    ...(clip.outSec !== undefined ? { outSec: clip.outSec } : {}),
  };
  clip.durationSec = leftDurSec;
  if (srcSplitSec !== undefined) clip.outSec = srcSplitSec;

  syncClipFrames(clip, fps);
  syncClipFrames(right, fps);
  track.clips.splice(index + 1, 0, right);
  reorder(track);
  commit(item);
  return {
    id,
    op,
    fps,
    changed: [`split ${clip.id} @ frame ${at} → ${clip.id} [${startF}..${at}]f + ${right.id} [${at}..${endF}]f`],
    touched: [clip.id, right.id],
  };
}

// ── moveClipByFrames ─────────────────────────────────────────────────────────
/**
 * Move a clip so it STARTS at an exact timeline frame (its content + duration
 * unchanged — a slide of the clip in time, NOT a ripple of neighbours). Clamped
 * to startFrame ≥ 0. Idempotent: moving to the clip's current start frame skips.
 */
export function moveClipByFrames(id: string, clipId: string, startFrame: number): FrameEditResult {
  const op = "move_frame";
  const got = withTimeline(id);
  if (!got) return skip(id, op, "no timeline on item — build one first");
  const { item, tl, fps } = got;
  const found = locate(tl, clipId);
  if (!found) return skip(id, op, `clip ${clipId} not found`);
  const { track, clip } = found;
  if (clip.locked) return skip(id, op, `clip ${clipId} is locked — never moved`);

  const target = Math.max(0, Math.round(startFrame));
  const curStartF = toFrame(clip.startSec ?? 0, fps);
  if (target === curStartF) return skip(id, op, `clip already starts at frame ${target} (no-op)`);

  clip.startSec = frameToSec(target, fps);
  syncClipFrames(clip, fps);
  reorder(track);
  commit(item);
  return {
    id,
    op,
    fps,
    changed: [`move ${clipId}: start ${curStartF}f → ${target}f (${clip.startSec}s)`],
    touched: [clipId],
  };
}
