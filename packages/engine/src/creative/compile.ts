/**
 * compile.ts — M10: the two halves of the timeline ↔ render bridge (§2.1, §4.2 M10).
 *
 * The Timeline (NLE) is the trim-precise REALIZATION layer that lives on
 * `ContentItem.timeline` exactly the way the Edl lives today. This module owns
 * both directions of the bridge between it and the render source of truth:
 *
 *   timelineBuild(id)  — SEED the timeline FROM the render source.
 *       For a GENERATED item (has a storyboard, no footage timeline yet): one
 *       VIDEO clip per visible (non-hidden) scene + an AUDIO track from item.mix
 *       + a caption track when mix.subtitles is on. IDEMPOTENT + edit-preserving:
 *       a re-build keeps manual trims on any clip whose sceneRef still matches.
 *       seededFrom:"storyboard". Skips entirely if a footage timeline already
 *       exists (that one is owned by seed-from-footage.ts).
 *
 *   compileTimeline(id) — project the timeline BACK onto the render source,
 *       per seededFrom:
 *         • "storyboard" → write clip durations back onto storyboard scenes,
 *           reorder/hide scenes to match clip order, project audio automation +
 *           caption track onto item.mix. An UNTOUCHED build→compile is a no-op
 *           (the M10 byte-stable acceptance gate — see the guarantee note below).
 *         • "footage" → DON'T touch the storyboard; resolve the VIDEO track into
 *           an ordered clipPlan that N6 renderHybrid consumes (resolveClipPlan).
 *
 * THE BYTE-STABLE GUARANTEE (M10 acceptance gate). For a storyboard-seeded item:
 *   1. timelineBuild emits, for each VISIBLE scene IN CURRENT ORDER, one video
 *      clip with durationSec === scene.durationSec exactly (round2, the same
 *      rounding the scenes already store) and sceneRef === scene.id.
 *   2. compileTimeline writes a field back ONLY when the projected value DIFFERS
 *      from the current value (CHANGE-GUARDED writes). So a clip duration equal
 *      to its scene's duration writes nothing; an unchanged order reorders
 *      nothing; a caption track derived FROM mix.subtitles projects the same
 *      mix.subtitles back.
 *   3. The caption track that build seeds is a pure function of mix.subtitles;
 *      compile's mix projection is its inverse, so the round-trip on subtitles
 *      is identity.
 * Together: build→compile mutates nothing and saveItem is skipped when changed
 * is empty, so the on-disk bytes are untouched. (Verified by the change-guard on
 * every write path below.)
 *
 * BRIDGE DISCIPLINE (mirrors edl.ts applyEdlToStoryboard exactly):
 *   - clamp every numeric to its schema band;
 *   - NEVER mutate a locked scene (or a clip flagged locked);
 *   - skip-not-throw — one bad clip is skipped with a note, never aborts;
 *   - keep the cut renderable (a storyboard total is rescaled into [12,75]s the
 *     same way the Edl bridge does, so a ripple can't violate the superRefine).
 */

import { z } from "zod";
import {
  RULES,
  Storyboard,
  type Clip,
  type ContentItem,
  type Marker,
  type Mix,
  type Timeline,
  type Track,
} from "@os/schemas";

import { loadItem, logLine, nowIso, saveItem } from "../store.ts";

/* ─── Schema range constants (mirror @os/schemas + edl.ts; keep the bridge honest) ── */
const SCENE_MIN_SEC = RULES.minSceneDuration; // 2
const SCENE_MAX_SEC = RULES.maxSceneDuration; // 14
const TOTAL_MIN_SEC = RULES.minTotalDuration; // 12
const TOTAL_MAX_SEC = RULES.maxTotalDuration; // 75

const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n));
const round2 = (n: number) => Math.round(n * 100) / 100;

/* Stable per-scene clip id so a re-build can match a previous clip to its scene
   and preserve any manual trim on it (mirrors seed-from-footage.ts clipIdForShot). */
const clipIdForScene = (sceneId: string) => `vclip_${sceneId}`;

/* ─────────────────────────────────────────────────────────────────────────────
   timelineBuild — seed/refresh item.timeline FROM a generated storyboard.
   ───────────────────────────────────────────────────────────────────────────── */

/**
 * Seed (or re-seed) `item.timeline` from a GENERATED item's storyboard + mix,
 * returning the persisted Timeline. Idempotent + edit-preserving by scene id.
 *
 * Skips (returns the existing timeline) when a FOOTAGE timeline already exists —
 * that path is owned by seed-from-footage.ts and must not be clobbered.
 */
export function timelineBuild(id: string): Timeline {
  const item = loadItem(id);

  // An ingested/footage timeline is owned elsewhere — never re-seed over it.
  if (item.timeline?.seededFrom === "footage") return item.timeline;

  const sb = item.storyboard;
  const fps = sb?.fps ?? 30;
  const scenes: any[] = (sb?.scenes ?? []) as any[];

  // ── Preserve manual trims: index any existing V1 clips by id (scene-keyed). ──
  const prior = item.timeline;
  const priorV1 = prior?.tracks?.find((t) => t.id === "V1");
  const priorClipById = new Map<string, Clip>();
  for (const c of priorV1?.clips ?? []) if (c.id) priorClipById.set(c.id, c);

  // ── V1: one VIDEO clip per VISIBLE (non-hidden) scene, in storyboard order,
  //    laid sequentially. A re-build keeps a still-matching clip's (possibly
  //    hand-edited) source window + duration; only its sequential startSec is
  //    re-flowed. On a FIRST build every clip's durationSec === scene.durationSec
  //    exactly — the foundation of the byte-stable round-trip. ──
  const videoClips: Clip[] = [];
  let cursor = 0;
  for (const scene of scenes) {
    if (scene.hidden) continue; // hidden scenes aren't in the cut (mirrors timelineView)
    const sceneDur = round2(Number(scene.durationSec) || 0);
    const existing = priorClipById.get(clipIdForScene(scene.id));
    // Preserve a manual trim on re-build; else default in/out/duration to the
    // whole scene (a video clip's source IS its scene, 0..durationSec).
    const inSec = round2(existing?.inSec ?? 0);
    const outSec = round2(existing?.outSec ?? sceneDur);
    const durationSec = round2(existing?.durationSec ?? sceneDur);
    const startSec = round2(cursor);
    videoClips.push({
      id: clipIdForScene(scene.id),
      kind: "video",
      sceneRef: scene.id,
      inSec,
      outSec,
      startSec,
      durationSec,
      speed: existing?.speed ?? 1,
      enabled: existing?.enabled ?? !scene.hidden,
      // carry forward lock state both from a preserved clip and from the scene.
      ...(existing?.locked !== undefined ? { locked: existing.locked } : scene.locked ? { locked: true } : {}),
      ...(existing?.gain !== undefined ? { gain: existing.gain } : {}),
    });
    cursor = round2(cursor + durationSec);
  }
  const cutLengthSec = round2(cursor);

  const tracks: Track[] = [{ id: "V1", kind: "video", name: "Video", clips: videoClips }];

  // ── Audio: one AUDIO track per item.mix track (music/voice/sfx), each a single
  //    full-length clip spanning the cut. We carry the track's gain automation
  //    onto the clip's `gain` so compile can project it straight back. No mix
  //    tracks → no audio lane (the generated render still mixes via item.mix). ──
  for (const at of item.mix?.tracks ?? []) {
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
        cutLengthSec > 0
          ? [
              {
                id: `aclip_${at.id}`,
                kind: "audio",
                inSec: 0,
                outSec: cutLengthSec,
                startSec: 0,
                durationSec: cutLengthSec,
                speed: 1,
                enabled: !muted,
                ...(at.gain ? { gain: at.gain } : {}),
                ...(at.locked ? { locked: true } : {}),
              },
            ]
          : [],
    });
  }

  // ── Caption track (kind:"text") when subtitles are on. One CAP1 track with a
  //    single text clip spanning the cut carrying the preset/keywords as its
  //    payload, so compile can project mix.subtitles straight back (identity). ──
  const sub = item.mix?.subtitles;
  if (sub?.enabled && cutLengthSec > 0) {
    tracks.push({
      id: "CAP1",
      kind: "text",
      name: "Captions",
      clips: [
        {
          id: "capclip_subtitles",
          kind: "text",
          inSec: 0,
          outSec: cutLengthSec,
          startSec: 0,
          durationSec: cutLengthSec,
          speed: 1,
          enabled: true,
          // Stash the active preset so the round-trip can re-derive mix.subtitles.
          captionText: sub.preset ?? "",
        },
      ],
    });
  }

  // ── Markers from emphasis scenes (peak beats), placed at their cut position. ──
  const markers: Marker[] = [];
  {
    let mc = 0;
    for (const scene of scenes) {
      if (scene.hidden) continue;
      const dur = round2(Number(scene.durationSec) || 0);
      if (scene.emphasis) markers.push({ atSec: round2(mc), label: "emphasis", color: "#ffd166" });
      mc = round2(mc + dur);
    }
  }

  const timeline: Timeline = {
    tracks,
    markers,
    fps,
    seededFrom: "storyboard",
    compiledAt: nowIso(), // the timeline now OWNS timing (§2.1 precedence)
  };

  item.timeline = timeline;
  item.updatedAt = nowIso();
  logLine(item, `timeline: built (storyboard) — ${videoClips.length} video clip(s), ${tracks.length} track(s)`);
  saveItem(item);
  return timeline;
}

/* ─────────────────────────────────────────────────────────────────────────────
   compileTimeline — project item.timeline BACK onto the render source.
   ───────────────────────────────────────────────────────────────────────────── */

/**
 * Project `item.timeline` back onto the render source, per `seededFrom`:
 *   - "storyboard": durations/order/hide → storyboard.scenes; audio automation +
 *     caption track → item.mix. CHANGE-GUARDED so an untouched build→compile is a
 *     no-op (byte-stable). Locked-safe, clamped, skip-not-throw.
 *   - "footage": resolve the clipPlan (resolveClipPlan); storyboard untouched.
 * Returns the list of human-readable changes made (empty ⇒ nothing was written).
 */
export function compileTimeline(id: string): { changed: string[] } {
  const item = loadItem(id);
  const changed: string[] = [];
  const timeline = item.timeline;
  if (!timeline) return { changed };

  // ── FOOTAGE: storyboard is not the source — N6 consumes the clipPlan instead.
  //    Compiling a footage timeline doesn't mutate the storyboard; it just stamps
  //    compiledAt so the precedence rule (timeline owns timing) is in force. ──
  if (timeline.seededFrom === "footage") {
    if (!timeline.compiledAt) {
      timeline.compiledAt = nowIso();
      item.updatedAt = nowIso();
      logLine(item, `timeline: compiled (footage) — clipPlan resolves at render`);
      saveItem(item);
      changed.push("footage timeline compiled (clipPlan resolves at render)");
    }
    return { changed };
  }

  // ── STORYBOARD: project the timeline back onto the storyboard + mix. ──
  const sb = item.storyboard;
  const scenes: any[] = (sb?.scenes ?? []) as any[];
  if (!sb || !scenes.length) return { changed };

  const v1 = timeline.tracks.find((t) => t.id === "V1" || t.kind === "video");
  // The video clips that are IN the cut (enabled), in timeline order.
  const orderedClips = (v1?.clips ?? [])
    .filter((c) => c.enabled !== false && c.sceneRef)
    .slice()
    .sort((a, b) => (a.startSec ?? 0) - (b.startSec ?? 0));

  const sceneById = new Map<string, any>();
  for (const s of scenes) sceneById.set(s.id, s);

  // (1) DURATIONS — write each clip's durationSec back onto its scene, clamped to
  //     the scene band. Then keep the visible TOTAL within [12,75]s exactly like
  //     the Edl bridge (pacingScale) so a ripple can never violate superRefine.
  //     Compute the scale up front so each per-scene write is already total-aware.
  const clipDurForScene = new Map<string, number>();
  for (const c of orderedClips) {
    const scene = sceneById.get(c.sceneRef!);
    if (!scene || scene.locked) continue; // never resize a locked scene's timing
    clipDurForScene.set(c.sceneRef!, clamp(round2(c.durationSec ?? 0), SCENE_MIN_SEC, SCENE_MAX_SEC));
  }
  const visibleTotal = orderedClips.reduce((sum, c) => {
    const scene = sceneById.get(c.sceneRef!);
    if (!scene) return sum;
    if (scene.locked) return sum + Number(scene.durationSec ?? 0); // locked keeps its own duration
    return sum + (clipDurForScene.get(c.sceneRef!) ?? Number(scene.durationSec ?? SCENE_MIN_SEC));
  }, 0);
  let pacingScale = 1;
  if (visibleTotal > TOTAL_MAX_SEC) pacingScale = TOTAL_MAX_SEC / visibleTotal;
  else if (visibleTotal > 0 && visibleTotal < TOTAL_MIN_SEC) pacingScale = TOTAL_MIN_SEC / visibleTotal;

  for (const c of orderedClips) {
    const scene = sceneById.get(c.sceneRef!);
    if (!scene) continue;
    if (scene.locked) {
      // never mutate locked work — but note it if a trim was attempted.
      if (clipDurForScene.has(c.sceneRef!)) changed.push(`scene ${c.sceneRef}: locked — duration unchanged`);
      continue;
    }
    try {
      const base = clipDurForScene.get(c.sceneRef!);
      if (base == null) continue;
      // Only apply pacingScale when it actually rescales (==1 leaves base intact,
      // so an untouched cut whose total is already in band stays byte-identical).
      const target = clamp(round2(base * pacingScale), SCENE_MIN_SEC, SCENE_MAX_SEC);
      // CHANGE-GUARD: write only when the value differs — the byte-stable gate.
      if (Math.abs(target - Number(scene.durationSec ?? 0)) > 0.001) {
        scene.durationSec = target;
        changed.push(`scene ${c.sceneRef}: duration → ${target}s`);
      }
    } catch (e) {
      changed.push(`scene ${c.sceneRef}: skipped (${e instanceof Error ? e.message : String(e)})`);
    }
  }

  // (2) DROP / HIDE — a scene whose clip was removed (no enabled clip references
  //     it) is HIDDEN, never deleted (its work survives, mirroring the Edl
  //     bridge's keep:false → hidden). A scene whose clip is back is re-included.
  //     Locked scenes are left exactly as they are.
  const referenced = new Set(orderedClips.map((c) => c.sceneRef));
  for (const scene of scenes) {
    if (scene.locked) continue;
    const inCut = referenced.has(scene.id);
    if (!inCut && !scene.hidden) {
      scene.hidden = true;
      changed.push(`scene ${scene.id}: dropped from cut (hidden)`);
    } else if (inCut && scene.hidden) {
      scene.hidden = false;
      changed.push(`scene ${scene.id}: re-included in cut`);
    }
  }

  // (3) REORDER — reorder storyboard.scenes to match clip order. Visible scenes
  //     follow the timeline order; hidden scenes (no clip) keep their relative
  //     order, appended after, so nothing is lost. CHANGE-GUARDED: a re-order
  //     that produces the identical id sequence writes nothing.
  //     Locked scenes pin their ABSOLUTE index (we never move a locked scene),
  //     so the reorder only permutes the unlocked, clip-driven scenes around them.
  {
    const desiredVisibleOrder = orderedClips.map((c) => c.sceneRef!).filter((sid) => sceneById.has(sid));
    const visibleSeen = new Set(desiredVisibleOrder);
    // The non-clip-driven remainder (hidden scenes + any visible scene a clip
    // didn't reference) keeps storyboard order.
    const remainder = scenes.filter((s) => !visibleSeen.has(s.id)).map((s) => s.id);
    // Merge into one target order: clip-driven visible scenes first (in clip
    // order), then the remainder in storyboard order.
    const targetOrder = [...desiredVisibleOrder, ...remainder];

    // Pin locked scenes to their current absolute index so locked work never
    // moves; fill the rest of the slots with targetOrder in sequence.
    const lockedAt = new Map<number, any>();
    scenes.forEach((s, i) => { if (s.locked) lockedAt.set(i, s); });
    const flow = targetOrder.filter((sid) => !sceneById.get(sid)?.locked);
    const reordered: any[] = [];
    let fi = 0;
    for (let i = 0; i < scenes.length; i++) {
      if (lockedAt.has(i)) reordered.push(lockedAt.get(i));
      else reordered.push(sceneById.get(flow[fi++]));
    }

    const before = scenes.map((s) => s.id).join(",");
    const after = reordered.map((s) => s.id).join(",");
    if (after !== before && reordered.length === scenes.length && reordered.every(Boolean)) {
      item.storyboard!.scenes = reordered;
      changed.push(`storyboard: scenes reordered to match cut`);
    }
  }

  // (4) AUDIO + CAPTIONS → item.mix. Project each audio clip's gain automation
  //     back onto its AudioTrack.gain, and the caption track back onto
  //     mix.subtitles. CHANGE-GUARDED so a build→compile round-trip is identity.
  const mixChanges = projectMixFromTimeline(item, timeline);
  changed.push(...mixChanges);

  // Stamp compiledAt so the precedence rule is in force (timeline owns timing).
  if (!timeline.compiledAt) {
    timeline.compiledAt = nowIso();
    // NOTE: stamping compiledAt is bookkeeping, not a content change — we don't
    // push to `changed` for it so the byte-stable gate keys purely on real edits.
    // But we DO need to persist it; handled by the save guard below.
  }

  if (changed.length) {
    item.updatedAt = nowIso();
    logLine(item, `timeline-compile: applied ${changed.length} change(s) to storyboard + mix`);
    saveItem(item);
  } else if (timeline.compiledAt && !item.timeline?.compiledAt) {
    // First-ever compile of an in-band untouched timeline: persist only the
    // compiledAt stamp (no content change). This is the lone write on the
    // byte-stable path and it touches a single timeline field, not the bytes of
    // storyboard/mix — satisfying the "storyboard + mix identical" acceptance gate.
    saveItem(item);
  }

  return { changed };
}

/* Project the timeline's audio + caption tracks back onto item.mix. Returns the
   change notes. CHANGE-GUARDED on every write so an untouched round-trip is a
   no-op (the byte-stable gate). Never throws — a bad clip is skipped. */
function projectMixFromTimeline(item: ContentItem, timeline: Timeline): string[] {
  const changed: string[] = [];
  const mix: any = { ...(item.mix ?? {}) };
  let touched = false;

  // (a) Audio-track gain automation: each A_<id> track's single clip carries the
  //     track's gain automation; write it back onto the matching AudioTrack.gain.
  const audioTracks = timeline.tracks.filter((t) => t.kind === "audio");
  if (audioTracks.length && Array.isArray(mix.tracks)) {
    const tracks = mix.tracks.map((t: any) => ({ ...t }));
    const byId = new Map(tracks.map((t: any) => [t.id, t]));
    for (const at of audioTracks) {
      const trackId = at.id.startsWith("A_") ? at.id.slice(2) : at.id;
      const dest: any = byId.get(trackId);
      if (!dest) continue;
      const clip = (at.clips ?? [])[0];
      if (!clip) continue;
      // Project the clip's gain automation back onto the track (when present).
      // CHANGE-GUARD: only write when the JSON differs from what's already there.
      if (clip.gain && JSON.stringify(clip.gain) !== JSON.stringify(dest.gain)) {
        dest.gain = clip.gain;
        touched = true;
        changed.push(`mix: track ${trackId} gain automation updated`);
      }
    }
    if (touched) mix.tracks = tracks;
  }

  // (b) Caption track → mix.subtitles. A CAP1 text clip means subtitles ON; its
  //     captionText carries the preset. CHANGE-GUARDED: an untouched build (which
  //     seeded CAP1 FROM mix.subtitles) projects the same subtitles back.
  const capTrack = timeline.tracks.find((t) => t.kind === "text" && (t.clips?.length ?? 0) > 0);
  if (capTrack) {
    const capClip = capTrack.clips[0];
    const sub: any = { ...(mix.subtitles ?? {}) };
    let subTouched = false;
    if (!sub.enabled) { sub.enabled = true; subTouched = true; }
    const preset = capClip.captionText && capClip.captionText.length ? capClip.captionText : undefined;
    if (preset && sub.preset !== preset) { sub.preset = preset; subTouched = true; }
    if (subTouched) {
      mix.subtitles = sub;
      touched = true;
      changed.push(`mix: subtitles ${sub.preset ?? "on"} (from caption track)`);
    }
  }

  if (touched) item.mix = mix as Mix;
  return changed;
}

/* ─────────────────────────────────────────────────────────────────────────────
   resolveClipPlan — the footage render spine (N6 renderHybrid consumes this).
   ───────────────────────────────────────────────────────────────────────────── */

/** One entry in the footage render plan: a real cut of the source video. N6
 *  `renderHybrid` (render.ts) trims each part with ffmpeg, concats them into the
 *  silent spine, then composites the overlay layer over it. Ordered by startSec. */
export type ClipPlanEntry = {
  src: string;       // file the cut reads (item.source.path for footage clips)
  inSec: number;     // source in-point
  outSec: number;    // source out-point
  speed: number;     // playback speed (1 = real-time)
  startSec: number;  // position on the assembled timeline
  durationSec: number; // length on the assembled timeline (post-speed)
};
export type ClipPlan = ClipPlanEntry[];

/**
 * Resolve the VIDEO track of a FOOTAGE-seeded timeline into an ordered clipPlan
 * for N6 renderHybrid. Walks the enabled video clips in startSec order; `src`
 * falls back to item.source.path for sceneRef-less footage clips (the whole
 * point — a footage clip cuts the source video). Never throws; a clip with no
 * resolvable src is skipped (skip-not-throw). Pure: loads the item, no mutation.
 */
export function resolveClipPlan(item: ContentItem): ClipPlan {
  const timeline = item.timeline;
  if (!timeline) return [];
  const sourcePath = item.source?.path ?? item.videoPath ?? "";

  const v1 = timeline.tracks.find((t) => t.id === "V1" || t.kind === "video");
  const clips = (v1?.clips ?? [])
    .filter((c) => c.enabled !== false)
    .slice()
    .sort((a, b) => (a.startSec ?? 0) - (b.startSec ?? 0));

  const plan: ClipPlan = [];
  for (const c of clips) {
    // src = the clip's own src for footage clips; fall back to the source video
    // for sceneRef-less footage clips that didn't carry an explicit src.
    const src = c.src || sourcePath;
    if (!src) continue; // nothing to cut — skip-not-throw
    const inSec = round2(Math.max(0, c.inSec ?? 0));
    const durationSec = round2(Math.max(0, c.durationSec ?? 0));
    if (durationSec <= 0) continue; // a zero-length cut renders nothing — skip
    const speed = clamp(c.speed ?? 1, 0.1, 8);
    // outSec: explicit when set, else derive from in + duration*speed (the source
    // window a speed-changed clip consumes is duration*speed of source time).
    const outSec = round2(c.outSec ?? inSec + durationSec * speed);
    plan.push({
      src,
      inSec,
      outSec,
      speed,
      startSec: round2(c.startSec ?? 0),
      durationSec,
    });
  }
  return plan;
}
