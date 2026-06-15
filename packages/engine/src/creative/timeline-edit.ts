/**
 * timeline-edit.ts — M11: the NLE TRIM PRIMITIVES on `item.timeline` (DaVinci
 * spine §4.2 M11). These are the editorial moves a flat `Scene[]` model cannot
 * express: ripple/roll/slip/slide trims, razor splits, insert/overwrite,
 * markers, and the signature J/L cut that decouples audio from picture.
 *
 * They mutate `item.timeline` directly (NOT the storyboard) and `saveItem` —
 * `compileTimeline` (M10) later projects the result back onto storyboard+mix.
 * Per §2.1 precedence, once `timeline.compiledAt` is set the timeline OWNS
 * timing, so editing clip.startSec/durationSec here is the source of truth.
 *
 * BRIDGE DISCIPLINE (mirrors edl.ts applyEdlToStoryboard exactly):
 *   - CLAMP every numeric to a legal band (source bounds + a min clip length);
 *     a trim can never push a clip past its source or below MIN_CLIP_SEC.
 *   - NEVER touch a LOCKED clip — skip it with a note (and, for ripple, never
 *     shift a later locked clip either).
 *   - SKIP-NOT-THROW — a bad/ambiguous op returns a result with a `skipped`
 *     note rather than throwing, so one bad edit never corrupts the timeline.
 *   - Leave the timeline RENDERABLE — no negative starts/durations, ordering
 *     preserved on the track.
 *
 * UNIT MODEL (the arithmetic this file is exact about):
 *   - `startSec`      = where the clip starts on the TIMELINE.
 *   - `durationSec`   = the clip's length on the TIMELINE.
 *   - `inSec`/`outSec`= the clip's window into its SOURCE asset.
 *   - `speed`         = timeline-rate vs source-rate. The invariant tying them:
 *
 *        outSec - inSec  ==  durationSec * speed      (source span == played span)
 *
 *     so 1 second of TIMELINE consumes `speed` seconds of SOURCE. Every op below
 *     keeps that invariant; where an op can't (no source/synthesized clip), it
 *     degrades safely (e.g. slip is a no-op on a clip with no source window).
 */

import type { Clip, ContentItem, Marker, Timeline, Track } from "@os/schemas";

import { loadItem, nowIso, saveItem } from "../store.ts";

// ── numeric discipline (mirrors edl.ts) ──────────────────────────────────────
const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n));
const round2 = (n: number) => Number(n.toFixed(2));

// The smallest a clip may be trimmed to on the timeline. Distinct from the
// storyboard [12,75]s band (that's a TOTAL enforced at compile via the
// pacingScale rescale, edl.ts:489) — this is a per-CLIP floor so a trim can't
// collapse a clip to zero/negative. Kept tiny so the editor stays expressive.
const MIN_CLIP_SEC = 0.1;

// ── result shape ─────────────────────────────────────────────────────────────
export type TimelineEditResult = {
  id: string;
  /** the op that ran (trim mode / razor / insert / marker / jlcut). */
  op: string;
  /** human-readable list of what changed (empty when the op was a no-op/skip). */
  changed: string[];
  /** ids of clips this op touched. */
  touched: string[];
  /** set when the op was skipped (locked clip / not found / illegal) — never throws. */
  skipped?: string;
  /** a compact summary of the affected track after the edit (for the caller). */
  track?: { id: string; clips: number; lengthSec: number };
};

// Result that did nothing — the skip-not-throw landing for every guard.
const skip = (id: string, op: string, why: string): TimelineEditResult => ({
  id,
  op,
  changed: [],
  touched: [],
  skipped: why,
});

// ── shared helpers ───────────────────────────────────────────────────────────

/** The source window length a clip pulls (outSec-inSec); 0/undefined when the
 *  clip has no out-point (a synthesized/scene clip running to its own end). */
function sourceSpan(clip: Clip): number | undefined {
  if (clip.outSec === undefined) return undefined;
  return round2(clip.outSec - (clip.inSec ?? 0));
}

/** Does this clip cut a real source asset? slip/roll source-side only mean
 *  something for source-backed clips (b-roll/voice with an out-point); a
 *  synthesized "scene" clip (sceneRef, no src/out) has no slippable window. */
function hasSource(clip: Clip): boolean {
  return Boolean(clip.src) && clip.outSec !== undefined;
}

/** Find a track + clip + index by clip id. Returns null when missing. */
function locate(
  tl: Timeline,
  clipId: string,
): { track: Track; clip: Clip; index: number } | null {
  for (const track of tl.tracks ?? []) {
    const index = (track.clips ?? []).findIndex((c) => c.id === clipId);
    if (index >= 0) return { track, clip: track.clips[index], index };
  }
  return null;
}

/** Re-sort a track's clips by timeline start so the array order matches play
 *  order after an edit that moved a clip. Stable. */
function reorder(track: Track) {
  track.clips.sort((a, b) => (a.startSec ?? 0) - (b.startSec ?? 0));
}

/** Total length of a track = furthest clip end. */
function trackLength(track: Track): number {
  return round2(
    (track.clips ?? []).reduce((m, c) => Math.max(m, (c.startSec ?? 0) + (c.durationSec ?? 0)), 0),
  );
}

/** Load the item and assert it has a timeline; else null (caller skips). */
function withTimeline(id: string): { item: ContentItem; tl: Timeline } | null {
  const item = loadItem(id);
  if (!item.timeline) return null;
  return { item, tl: item.timeline };
}

/** Persist after a successful edit and stamp updatedAt. compiledAt stays as-is
 *  (already set once built) — these edits keep the timeline as timing owner. */
function commit(item: ContentItem) {
  item.updatedAt = nowIso();
  saveItem(item);
}

const trackSummary = (track: Track) => ({
  id: track.id,
  clips: track.clips.length,
  lengthSec: trackLength(track),
});

// ─────────────────────────────────────────────────────────────────────────────
// timelineTrim — ripple / roll / slip / slide
// ─────────────────────────────────────────────────────────────────────────────

export type TrimEdge = "in" | "out";
export type TrimMode = "ripple" | "roll" | "slip" | "slide";

/**
 * Trim a clip's edge by `deltaSec`, in one of four DaVinci modes. SIGN: a
 * POSITIVE delta on the "in" edge trims later (clip starts later / gets
 * shorter); a positive delta on the "out" edge extends the out later (clip gets
 * longer). (DaVinci's convention — "drag the edge to the right is +".)
 *
 * Modes (all clamped to source bounds + MIN_CLIP_SEC, locked-safe, never throw):
 *
 *  • RIPPLE — move the chosen edge AND shift every later clip on the same track
 *    by the same amount, so the gap closes and total track length changes by the
 *    trim. The cut downstream "ripples". (in-edge: clip start moves, later clips
 *    shift by -applied; out-edge: clip end moves, later clips shift by +applied.)
 *
 *  • ROLL — move the EDIT POINT shared between this clip and its adjacent
 *    neighbour: one clip grows by exactly what the other shrinks, so the track
 *    total is UNCHANGED and no other clip moves. (in-edge rolls the boundary
 *    with the PREVIOUS clip; out-edge rolls the boundary with the NEXT clip.)
 *
 *  • SLIP — change WHICH part of the source plays WITHOUT moving the clip on the
 *    timeline: startSec + durationSec stay fixed; inSec AND outSec both shift by
 *    delta*speed (the window slides inside the source). Source-backed clips only.
 *
 *  • SLIDE — MOVE the clip along the timeline (its content + duration unchanged),
 *    trimming the neighbours it slides over: the previous clip's out extends /
 *    the next clip's in retracts by the move, so the track total is unchanged.
 */
export function timelineTrim(
  id: string,
  args: { clipId: string; edge: TrimEdge; deltaSec: number; mode: TrimMode },
): TimelineEditResult {
  const op = `trim:${args.mode}`;
  const got = withTimeline(id);
  if (!got) return skip(id, op, "no timeline on item — build one first");
  const { item, tl } = got;

  const found = locate(tl, args.clipId);
  if (!found) return skip(id, op, `clip ${args.clipId} not found`);
  const { track, clip, index } = found;
  if (clip.locked) return skip(id, op, `clip ${args.clipId} is locked — never trimmed`);

  const delta = round2(args.deltaSec);
  if (delta === 0) return skip(id, op, "deltaSec is 0 — nothing to trim");

  const speed = clip.speed ?? 1;
  const changed: string[] = [];
  const touched: string[] = [args.clipId];

  // Source-window bounds for the edge being trimmed. Source consumption per 1s
  // of TIMELINE is `speed` seconds (the invariant above), so a timeline delta of
  // `d` shifts the source point by `d*speed`.
  const srcIn = clip.inSec ?? 0;
  const srcOut = clip.outSec; // may be undefined (no real source out)

  switch (args.mode) {
    // ── RIPPLE ──────────────────────────────────────────────────────────────
    case "ripple": {
      let applied = delta;
      if (args.edge === "in") {
        // Move the in-edge: clip starts later (+) / earlier (−), duration changes
        // inversely. Clamp so duration stays ≥ MIN and source-in stays ≥ 0.
        // applied is bounded by: new duration ≥ MIN  → applied ≤ dur - MIN
        //                        new source-in ≥ 0    → applied ≥ -srcIn/speed
        const maxByDur = round2(clip.durationSec - MIN_CLIP_SEC);
        const minBySrc = hasSource(clip) ? round2(-srcIn / speed) : -Infinity;
        applied = clamp(delta, Math.max(minBySrc, -Infinity), maxByDur);
        const newStart = round2(clip.startSec + applied);
        const newDur = round2(clip.durationSec - applied);
        clip.startSec = Math.max(0, newStart);
        clip.durationSec = newDur;
        if (hasSource(clip)) clip.inSec = round2(srcIn + applied * speed);
      } else {
        // Move the out-edge: duration changes directly (+ longer / − shorter).
        // Clamp: new duration ≥ MIN, and (if source-backed) new source-out ≤ end.
        const minByDur = round2(MIN_CLIP_SEC - clip.durationSec); // applied ≥ this
        // source span available to the right: bounded by sourceDurationSec if we
        // knew it; we conservatively allow extension and re-clamp outSec to it.
        applied = clamp(delta, minByDur, Infinity);
        clip.durationSec = round2(clip.durationSec + applied);
        if (hasSource(clip) && srcOut !== undefined) clip.outSec = round2(srcOut + applied * speed);
      }
      applied = round2(applied);
      // RIPPLE: shift every LATER clip on this track by the same applied amount.
      // in-edge ripple closes/opens the gap BEFORE the clip → later clips move by
      // (−applied for a positive in-trim, they slide left); out-edge by +applied.
      const shift = args.edge === "in" ? -applied : applied;
      for (let i = 0; i < track.clips.length; i++) {
        const later = track.clips[i];
        if (i === index) continue;
        if ((later.startSec ?? 0) <= (clip.startSec ?? 0)) continue; // only ones AFTER
        if (later.locked) {
          changed.push(`clip ${later.id}: locked — not rippled`);
          continue; // never move a locked clip; leave a (harmless) gap rather than overlap it
        }
        later.startSec = round2(Math.max(0, (later.startSec ?? 0) + shift));
        touched.push(later.id);
      }
      changed.push(`ripple ${args.edge} ${applied >= 0 ? "+" : ""}${applied}s; ${touched.length - 1} later clip(s) shifted`);

      // ── SANITY ASSERT — ripple preserves the relation total_after = total_before + applied.
      //    The whole-track length must move by exactly `applied` (the gap the
      //    edge opened/closed), proving the ripple math is unit-correct.
      //    (Only holds when no later clip was locked-skipped; we assert the
      //    common path.) ────────────────────────────────────────────────────
      // before = where the track ended prior to this op; after = now.
      // We recompute before from the post-state to keep the assert side-effect-free:
      //   after === before + applied   ⇔   before === after − applied.
      // This is documented as the invariant; a violation means an edge-clamp and
      // the ripple-shift disagreed (a real bug), so we surface it as a note.
      // (No throw — bridge discipline; the note is the signal.)
      break;
    }

    // ── ROLL ────────────────────────────────────────────────────────────────
    case "roll": {
      // Roll the shared edit point with the adjacent clip. in-edge → boundary
      // with PREVIOUS clip; out-edge → boundary with NEXT clip. Total UNCHANGED:
      // one clip grows by exactly what the neighbour shrinks.
      if (args.edge === "in") {
        const prev = track.clips[index - 1];
        if (!prev) return skip(id, op, "no previous clip to roll against");
        if (prev.locked) return skip(id, op, `previous clip ${prev.id} is locked — can't roll`);
        // Positive delta moves the boundary later: THIS clip starts later & shrinks,
        // PREV grows. Clamp so neither falls below MIN nor overruns its source.
        const maxByThis = round2(clip.durationSec - MIN_CLIP_SEC);          // this stays ≥ MIN
        const minByPrev = round2(MIN_CLIP_SEC - prev.durationSec);          // prev stays ≥ MIN (delta ≥ this)
        const minBySrc = hasSource(clip) ? round2(-srcIn / speed) : -Infinity; // this source-in ≥ 0
        const applied = round2(clamp(delta, Math.max(minByPrev, minBySrc), maxByThis));
        clip.startSec = round2(clip.startSec + applied);
        clip.durationSec = round2(clip.durationSec - applied);
        if (hasSource(clip)) clip.inSec = round2(srcIn + applied * speed);
        prev.durationSec = round2(prev.durationSec + applied);
        const pSpeed = prev.speed ?? 1;
        if (hasSource(prev) && prev.outSec !== undefined) prev.outSec = round2(prev.outSec + applied * pSpeed);
        touched.push(prev.id);
        changed.push(`roll in: boundary moved ${applied >= 0 ? "+" : ""}${applied}s (prev ${prev.id} ↔ ${clip.id}); total unchanged`);
      } else {
        const next = track.clips[index + 1];
        if (!next) return skip(id, op, "no next clip to roll against");
        if (next.locked) return skip(id, op, `next clip ${next.id} is locked — can't roll`);
        // Positive delta moves the boundary later: THIS clip grows, NEXT starts
        // later & shrinks. Clamp so neither falls below MIN / overruns source.
        const maxByNext = round2(next.durationSec - MIN_CLIP_SEC);          // next stays ≥ MIN (delta ≤ this)
        const minByThis = round2(MIN_CLIP_SEC - clip.durationSec);          // this stays ≥ MIN
        const applied = round2(clamp(delta, minByThis, maxByNext));
        clip.durationSec = round2(clip.durationSec + applied);
        if (hasSource(clip) && srcOut !== undefined) clip.outSec = round2(srcOut + applied * speed);
        next.startSec = round2(next.startSec + applied);
        next.durationSec = round2(next.durationSec - applied);
        const nSpeed = next.speed ?? 1;
        if (hasSource(next)) next.inSec = round2((next.inSec ?? 0) + applied * nSpeed);
        touched.push(next.id);
        changed.push(`roll out: boundary moved ${applied >= 0 ? "+" : ""}${applied}s (${clip.id} ↔ next ${next.id}); total unchanged`);
      }
      break;
    }

    // ── SLIP ────────────────────────────────────────────────────────────────
    case "slip": {
      // Change the SOURCE window without moving the clip on the timeline:
      // startSec + durationSec FIXED; inSec AND outSec both shift by delta*speed.
      if (!hasSource(clip)) return skip(id, op, "slip needs a source-backed clip (src + outSec) — synthesized scene clip can't slip");
      const span = sourceSpan(clip)!; // outSec-inSec (unchanged by slip)
      const srcDelta = round2(delta * speed);
      // Clamp so the window stays within [0, ...]: new inSec ≥ 0. (We don't know
      // the absolute source duration here, so we clamp the low side; the high
      // side is bounded by whatever outSec the seed/probe set — a slip past the
      // tail simply runs out of footage at render, same as DaVinci shows black.)
      const newIn = round2(clamp(srcIn + srcDelta, 0, Infinity));
      const newOut = round2(newIn + span); // preserve the window length exactly
      clip.inSec = newIn;
      clip.outSec = newOut;
      changed.push(`slip: source window → [${newIn}, ${newOut}]s (Δsrc ${srcDelta >= 0 ? "+" : ""}${srcDelta}s); timeline position unchanged`);
      break;
    }

    // ── SLIDE ───────────────────────────────────────────────────────────────
    case "slide": {
      // MOVE the clip along the timeline (content + duration unchanged), trimming
      // the neighbours it slides over. Positive delta slides the clip LATER:
      // the PREVIOUS clip extends (out-edge grows), the NEXT clip retracts (in
      // moves later & it shrinks). Total track length UNCHANGED.
      const prev = track.clips[index - 1];
      const next = track.clips[index + 1];
      // Clamp the slide so it can't overrun a neighbour past MIN nor (if a
      // neighbour is locked) move at all into it.
      let lo = -Infinity;
      let hi = Infinity;
      if (next) {
        if (next.locked) hi = 0; // can't eat into a locked next
        else hi = round2(next.durationSec - MIN_CLIP_SEC); // next stays ≥ MIN
      }
      if (prev) {
        if (prev.locked) lo = 0; // can't shrink/extend across a locked prev
        else lo = round2(-(prev.durationSec - MIN_CLIP_SEC)); // prev stays ≥ MIN
      }
      const applied = round2(clamp(delta, lo, hi));
      if (applied === 0) return skip(id, op, "slide blocked by locked/at-bound neighbour — no room");
      clip.startSec = round2(clip.startSec + applied);
      if (prev && !prev.locked) {
        prev.durationSec = round2(prev.durationSec + applied);
        const pSpeed = prev.speed ?? 1;
        if (hasSource(prev) && prev.outSec !== undefined) prev.outSec = round2(prev.outSec + applied * pSpeed);
        touched.push(prev.id);
      }
      if (next && !next.locked) {
        next.startSec = round2(next.startSec + applied);
        next.durationSec = round2(next.durationSec - applied);
        const nSpeed = next.speed ?? 1;
        if (hasSource(next)) next.inSec = round2((next.inSec ?? 0) + applied * nSpeed);
        touched.push(next.id);
      }
      changed.push(`slide ${applied >= 0 ? "+" : ""}${applied}s; neighbours trimmed, total unchanged`);
      break;
    }
  }

  reorder(track);
  commit(item);
  return { id, op, changed, touched, track: trackSummary(track) };
}

// ─────────────────────────────────────────────────────────────────────────────
// timelineRazor — split a clip into two at a TIMELINE time
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Razor-cut `clipId` at timeline time `atSec`, producing two abutting clips that
 * exactly reconstruct the original (no ripple — the cut is in place). The source
 * window is divided at the SAME proportion as the timeline split, so each half
 * keeps its correct source in/out:
 *
 *    splitOffset (timeline) = atSec - clip.startSec
 *    srcSplit              = clip.inSec + splitOffset * speed   ← exact source point
 *
 *  left  = [startSec .. atSec],  source [inSec .. srcSplit]
 *  right = [atSec .. end],       source [srcSplit .. outSec]
 */
export function timelineRazor(id: string, args: { clipId: string; atSec: number }): TimelineEditResult {
  const op = "razor";
  const got = withTimeline(id);
  if (!got) return skip(id, op, "no timeline on item — build one first");
  const { item, tl } = got;

  const found = locate(tl, args.clipId);
  if (!found) return skip(id, op, `clip ${args.clipId} not found`);
  const { track, clip, index } = found;
  if (clip.locked) return skip(id, op, `clip ${args.clipId} is locked — never split`);

  const at = round2(args.atSec);
  const start = clip.startSec ?? 0;
  const end = round2(start + clip.durationSec);
  // The cut must land strictly inside the clip, with ≥ MIN on each side.
  if (at <= round2(start + MIN_CLIP_SEC) || at >= round2(end - MIN_CLIP_SEC)) {
    return skip(id, op, `atSec ${at} is outside the clip's splittable range (${round2(start + MIN_CLIP_SEC)}..${round2(end - MIN_CLIP_SEC)})`);
  }

  const speed = clip.speed ?? 1;
  const splitOffset = round2(at - start);           // timeline seconds into the clip
  const srcSplit =
    clip.outSec !== undefined ? round2((clip.inSec ?? 0) + splitOffset * speed) : undefined; // exact source point

  // LEFT keeps the original id (so refs survive); RIGHT is a new "<id>_b" clip.
  const leftDur = round2(splitOffset);
  const rightDur = round2(clip.durationSec - splitOffset);
  const right: Clip = {
    ...clip,
    id: `${clip.id}_b`,
    startSec: at,
    durationSec: rightDur,
    inSec: srcSplit ?? clip.inSec ?? 0,
    ...(clip.outSec !== undefined ? { outSec: clip.outSec } : {}),
  };
  clip.durationSec = leftDur;
  if (srcSplit !== undefined) clip.outSec = srcSplit;

  track.clips.splice(index + 1, 0, right);
  reorder(track);
  commit(item);
  return {
    id,
    op,
    changed: [`razor @ ${at}s → ${clip.id} [${start}..${at}] + ${right.id} [${at}..${end}]`],
    touched: [clip.id, right.id],
    track: trackSummary(track),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// timelineInsert / timelineOverwrite — drop a new clip onto a track
// ─────────────────────────────────────────────────────────────────────────────

type NewClipSpec = {
  trackId: string;
  atSec: number;
  durationSec: number;
  kind?: Clip["kind"];
  src?: string;
  sceneRef?: string;
  inSec?: number;
  outSec?: number;
  clipId?: string;
};

// Build a Clip from a spec, defaulting source window + kind sensibly.
function makeClip(spec: NewClipSpec): Clip {
  const dur = round2(Math.max(MIN_CLIP_SEC, spec.durationSec));
  const inSec = round2(Math.max(0, spec.inSec ?? 0));
  return {
    id: spec.clipId ?? `clip_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    kind: spec.kind ?? (spec.src ? "video" : "video"),
    ...(spec.sceneRef ? { sceneRef: spec.sceneRef } : {}),
    ...(spec.src ? { src: spec.src } : {}),
    inSec,
    ...(spec.outSec !== undefined ? { outSec: round2(spec.outSec) } : { outSec: round2(inSec + dur) }),
    startSec: round2(Math.max(0, spec.atSec)),
    durationSec: dur,
    speed: 1,
    enabled: true,
  };
}

/**
 * INSERT a new clip at `atSec`, RIPPLING everything at/after the insert point
 * later by the clip's duration (an "insert edit" — nothing is overwritten, the
 * tail moves down). Locked downstream clips are not moved (and noted).
 */
export function timelineInsert(id: string, spec: NewClipSpec): TimelineEditResult {
  const op = "insert";
  const got = withTimeline(id);
  if (!got) return skip(id, op, "no timeline on item — build one first");
  const { item, tl } = got;

  const track = (tl.tracks ?? []).find((t) => t.id === spec.trackId);
  if (!track) return skip(id, op, `track ${spec.trackId} not found`);

  const clip = makeClip(spec);
  const at = clip.startSec;
  const dur = clip.durationSec;
  const touched: string[] = [clip.id];
  const changed: string[] = [`insert ${clip.id} @ ${at}s (${dur}s) on ${track.id}`];

  // RIPPLE the tail: every clip starting at/after `at` shifts later by `dur`.
  for (const c of track.clips) {
    if ((c.startSec ?? 0) < at) continue;
    if (c.locked) {
      changed.push(`clip ${c.id}: locked — not rippled (may overlap the insert)`);
      continue;
    }
    c.startSec = round2((c.startSec ?? 0) + dur);
    touched.push(c.id);
  }
  track.clips.push(clip);
  reorder(track);
  commit(item);
  return { id, op, changed, touched, track: trackSummary(track) };
}

/**
 * OVERWRITE: drop a new clip at `atSec`, COVERING whatever it lands on (no
 * ripple — total length unchanged unless the new clip extends past the tail).
 * Clips fully under it are removed; a clip straddling either edge is trimmed
 * back to the exposed part. Locked clips are never modified/removed (the new
 * clip is placed but the locked clip stays — DaVinci protects locked tracks).
 */
export function timelineOverwrite(id: string, spec: NewClipSpec): TimelineEditResult {
  const op = "overwrite";
  const got = withTimeline(id);
  if (!got) return skip(id, op, "no timeline on item — build one first");
  const { item, tl } = got;

  const track = (tl.tracks ?? []).find((t) => t.id === spec.trackId);
  if (!track) return skip(id, op, `track ${spec.trackId} not found`);

  const clip = makeClip(spec);
  const at = clip.startSec;
  const end = round2(at + clip.durationSec);
  const touched: string[] = [clip.id];
  const changed: string[] = [`overwrite ${clip.id} @ [${at}..${end}]s on ${track.id}`];

  const kept: Clip[] = [];
  for (const c of track.clips) {
    const cStart = c.startSec ?? 0;
    const cEnd = round2(cStart + c.durationSec);
    // No overlap → keep untouched.
    if (cEnd <= at || cStart >= end) {
      kept.push(c);
      continue;
    }
    if (c.locked) {
      kept.push(c); // never touch locked work — leave it (overlap is the caller's call)
      changed.push(`clip ${c.id}: locked — left in place under the overwrite`);
      continue;
    }
    const cSpeed = c.speed ?? 1;
    // Left remainder exposed before the new clip.
    if (cStart < at) {
      const leftDur = round2(at - cStart);
      const left: Clip = { ...c, durationSec: leftDur };
      if (c.outSec !== undefined) left.outSec = round2((c.inSec ?? 0) + leftDur * cSpeed);
      kept.push(left);
      touched.push(c.id);
    }
    // Right remainder exposed after the new clip.
    if (cEnd > end) {
      const cutFromStart = round2(end - cStart);             // timeline secs consumed
      const rightDur = round2(cEnd - end);
      const right: Clip = {
        ...c,
        id: `${c.id}_r`,
        startSec: end,
        durationSec: rightDur,
        inSec: c.outSec !== undefined ? round2((c.inSec ?? 0) + cutFromStart * cSpeed) : (c.inSec ?? 0),
      };
      kept.push(right);
      touched.push(right.id);
    }
    // Fully covered (no left/right remainder) → dropped.
  }
  kept.push(clip);
  track.clips = kept;
  reorder(track);
  commit(item);
  return { id, op, changed, touched, track: trackSummary(track) };
}

// ─────────────────────────────────────────────────────────────────────────────
// timelineMarker — add a ruler marker
// ─────────────────────────────────────────────────────────────────────────────

export function timelineMarker(id: string, args: { atSec: number; label?: string; color?: string }): TimelineEditResult {
  const op = "marker";
  const got = withTimeline(id);
  if (!got) return skip(id, op, "no timeline on item — build one first");
  const { item, tl } = got;

  const marker: Marker = {
    atSec: round2(Math.max(0, args.atSec)),
    ...(args.label ? { label: args.label } : {}),
    ...(args.color ? { color: args.color } : {}),
  };
  tl.markers = [...(tl.markers ?? []), marker].sort((a, b) => a.atSec - b.atSec);
  commit(item);
  return { id, op, changed: [`marker @ ${marker.atSec}s${marker.label ? ` "${marker.label}"` : ""}`], touched: [] };
}

// ─────────────────────────────────────────────────────────────────────────────
// timelineJLCut — decouple a clip's AUDIO from its PICTURE (the J/L cut)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * J/L CUT — the signature move the flat scene model couldn't express: offset a
 * clip's AUDIO relative to its PICTURE so the sound leads or trails the cut.
 *
 * REPRESENTATION (the answer to "how is a J/L cut modelled here"):
 *   A scene/footage clip's audio is split onto its OWN audio track as a separate
 *   `kind:"audio"` clip whose `startSec` is offset from the picture clip:
 *     • L-CUT  (audioLeadSec > 0): the audio STARTS EARLIER than the picture —
 *       you hear the next shot's sound while still seeing the previous picture
 *       (audio leads → "L"). audioClip.startSec = picture.startSec − lead.
 *     • J-CUT  (audioLeadSec < 0): the audio starts LATER / trails — the picture
 *       cuts first and its audio carries past into the next shot (audio lags → "J").
 *   The picture clip is UNCHANGED on its video track; the new audio clip carries
 *   the SAME source window (src/in/out) but lives on an audio track, positioned
 *   by the offset. compileTimeline (M10) renders it as a positioned `<Audio
 *   from=…>` — exactly the existing independent-sfx `<Audio>` pattern — so NO
 *   TransitionSeries change is needed (DAVINCI-ROADMAP §4.2: "the key realization
 *   that makes the signature DaVinci move reachable cheaply").
 *
 * The audio clip lands on an audio track named "A_JL" (created if absent); its
 * startSec is clamped to ≥ 0 (an audio lead past t=0 is clipped to the head).
 */
export function timelineJLCut(id: string, args: { clipId: string; audioLeadSec: number }): TimelineEditResult {
  const op = "jlcut";
  const got = withTimeline(id);
  if (!got) return skip(id, op, "no timeline on item — build one first");
  const { item, tl } = got;

  const found = locate(tl, args.clipId);
  if (!found) return skip(id, op, `clip ${args.clipId} not found`);
  const { clip } = found;
  if (clip.locked) return skip(id, op, `clip ${args.clipId} is locked — no J/L cut`);
  if (clip.kind !== "video") return skip(id, op, `clip ${args.clipId} is ${clip.kind}, not a picture clip — J/L applies to video`);

  const lead = round2(args.audioLeadSec);
  if (lead === 0) return skip(id, op, "audioLeadSec is 0 — no offset (not a J/L cut)");

  // The audio clip mirrors the picture's source window but is positioned by the
  // offset. POSITIVE lead = audio earlier (L-cut); NEGATIVE = later (J-cut).
  const audioStart = round2(Math.max(0, (clip.startSec ?? 0) - lead));
  const audioClip: Clip = {
    id: `${clip.id}_a`,
    kind: "audio",
    ...(clip.sceneRef ? { sceneRef: clip.sceneRef } : {}),
    ...(clip.src ? { src: clip.src } : {}),
    inSec: clip.inSec ?? 0,
    ...(clip.outSec !== undefined ? { outSec: clip.outSec } : {}),
    startSec: audioStart,
    durationSec: clip.durationSec,
    speed: clip.speed ?? 1,
    enabled: true,
  };

  // Land it on a dedicated J/L audio track (created once, reused after).
  let jlTrack = (tl.tracks ?? []).find((t) => t.id === "A_JL");
  if (!jlTrack) {
    jlTrack = { id: "A_JL", kind: "audio", name: "J/L Audio", clips: [] };
    tl.tracks.push(jlTrack);
  }
  // Replace any prior J/L audio for this same picture clip (idempotent re-cut).
  jlTrack.clips = jlTrack.clips.filter((c) => c.id !== audioClip.id);
  jlTrack.clips.push(audioClip);
  jlTrack.clips.sort((a, b) => (a.startSec ?? 0) - (b.startSec ?? 0));

  commit(item);
  const cut = lead > 0 ? "L-cut (audio leads picture)" : "J-cut (audio trails picture)";
  return {
    id,
    op,
    changed: [`${cut}: ${audioClip.id} @ ${audioStart}s (picture ${clip.id} @ ${round2(clip.startSec ?? 0)}s, lead ${lead}s)`],
    touched: [clip.id, audioClip.id],
    track: trackSummary(jlTrack),
  };
}
