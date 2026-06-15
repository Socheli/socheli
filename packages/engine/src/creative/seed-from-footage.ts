/**
 * seed-from-footage.ts — N3a: seed a real-footage NLE timeline from understanding.
 *
 * Pillar 5 (Ingest & Understand) §7.1.5 N3a. An ingested user video is a NORMAL
 * ContentItem (kind:"ingested", videoPath = normalized source). This module turns
 * its `understanding` (transcript + shots + highlights, all in SOURCE seconds)
 * into the mutable realization layer everything else already reads: `item.timeline`
 * (a `Timeline` with `seededFrom:"footage"`).
 *
 * The mapping (shots → clips, at SOURCE time):
 *   - VIDEO track V1: one Clip per understanding shot. The clip CUTS the source
 *     video — `src` = the source path, `inSec`/`outSec` = the shot's SOURCE window
 *     (shot.inSec/outSec), `startSec` laid SEQUENTIALLY on the timeline (no gaps,
 *     in shot order), `durationSec` = the shot length. So the seed is a 1:1
 *     "assembly cut" of the footage in capture order; trims/reorders happen later.
 *   - AUDIO track A1: one Clip spanning the WHOLE source audio (the production
 *     audio — voice+bed mixed). Per §7.1.6 this is NOT a clean synth stem; A1 is a
 *     single full-length clip the mixer treats as source audio.
 *   - CAPTION track is produced by N4a (auto-subtitle.ts), not here.
 *   - per-shot clipAnalysis (motion/quality/brightness/onScreenText/framing) is
 *     copied from understanding.perShot onto item.clipAnalysis (keyed by shot id)
 *     where useful, so the existing perception-driven passes can read it.
 *   - Markers: one ruler marker per highlight (the scored peak moments).
 *
 * IDEMPOTENT by shot id: re-seeding preserves MANUAL TRIMS on a clip whose shot
 * still matches (same shot id). If a prior V1 clip for shot `s` exists, its
 * (possibly hand-edited) inSec/outSec/durationSec are kept and only its sequential
 * startSec is re-flowed; clips for shots that no longer exist are dropped.
 *
 * FAIL-OPEN: ingest of real footage is messy. We never throw — we warn() and
 * degrade (e.g. no audio → no A1; no shots → a single full-length fallback clip).
 */

import type { Clip, ContentItem, Marker, Timeline, Track } from "@os/schemas";

import { loadItem, nowIso, saveItem, warn } from "../store.ts";
import { buildUnderstanding } from "../understanding.ts";

const round2 = (n: number) => Math.round(n * 100) / 100;

// Stable per-shot clip id so re-seed can match a previous clip to its shot and
// preserve any manual trim on it.
const clipIdForShot = (shotId: string) => `vclip_${shotId}`;

/**
 * Seed (or re-seed) `item.timeline` from `item.understanding`, returning the
 * persisted Timeline. Ensures understanding exists first (builds it if absent).
 *
 * Idempotent by shot id — manual trims on still-matching clips survive a re-seed.
 */
export async function seedTimelineFromFootage(id: string): Promise<Timeline> {
  const item = loadItem(id);

  // ── Ensure the understanding index exists (N2). buildUnderstanding is fail-open
  //    itself; we still guard so a failure here degrades to an empty understanding
  //    rather than aborting the seed. It's async (per-shot OCR/perception), so we
  //    await it; the persisted item.understanding is then pulled forward below. ──
  let understanding = item.understanding;
  if (!understanding) {
    try {
      understanding = await buildUnderstanding(id);
    } catch (e) {
      warn(item, "ingest_seed", "understand_failed", "buildUnderstanding threw — seeding from a minimal fallback", String(e));
    }
    // Re-load: buildUnderstanding persists item.understanding via saveItem, so the
    // on-disk item is now ahead of our in-memory copy. Pull it forward.
    const fresh = loadItem(id);
    understanding = fresh.understanding ?? understanding;
    Object.assign(item, fresh);
  }

  // The source the clips cut. For an ingested item this is the normalized source
  // (source.path) — videoPath points at the same file. Fall back across both.
  const sourceRef = item.source?.path ?? item.videoPath ?? "";
  const sourceDurationSec =
    understanding?.durationSec ?? item.source?.probe?.durationSec ?? 0;

  if (!sourceRef) {
    warn(item, "ingest_seed", "no_source", "no source video path on the item — seeding an empty footage timeline");
  }

  // ── Preserve manual trims: index any existing V1 clips by shot id. ──
  const prior = item.timeline;
  const priorV1 = prior?.tracks?.find((t) => t.id === "V1");
  const priorClipById = new Map<string, Clip>();
  for (const c of priorV1?.clips ?? []) {
    if (c.id) priorClipById.set(c.id, c);
  }

  const shots = understanding?.shots ?? [];

  // ── Build V1 video clips: one per shot, laid sequentially. ──
  const videoClips: Clip[] = [];
  let cursor = 0;
  if (shots.length === 0) {
    // Fallback: no shots segmented (e.g. understanding failed / single-take) →
    // one clip covering the whole source so the timeline is still usable.
    const dur = round2(sourceDurationSec);
    if (dur > 0 && sourceRef) {
      videoClips.push({
        id: "vclip_fallback",
        kind: "video",
        src: sourceRef,
        inSec: 0,
        outSec: dur,
        startSec: 0,
        durationSec: dur,
        speed: 1,
        enabled: true,
      });
      cursor = dur;
    }
  } else {
    // Keep shots in chronological order so the assembly mirrors the source.
    const ordered = [...shots].sort((a, b) => a.inSec - b.inSec);
    for (const shot of ordered) {
      const existing = priorClipById.get(clipIdForShot(shot.id));
      // Re-seed preserves manual trims: if we seeded this shot before, keep the
      // (possibly hand-edited) source window + duration; only re-flow startSec.
      const inSec = existing?.inSec ?? round2(shot.inSec);
      const outSec = existing?.outSec ?? round2(shot.outSec);
      const durationSec = round2(
        existing?.durationSec ?? Math.max(0, (outSec ?? shot.outSec) - inSec),
      );
      const startSec = round2(cursor);
      videoClips.push({
        id: clipIdForShot(shot.id),
        kind: "video",
        src: sourceRef,
        sceneRef: shot.id, // tie the clip back to its source shot
        inSec,
        outSec,
        startSec,
        durationSec,
        speed: existing?.speed ?? 1,
        // carry forward any manual lock/enabled state on a preserved clip
        enabled: existing?.enabled ?? true,
        ...(existing?.locked !== undefined ? { locked: existing.locked } : {}),
        ...(existing?.gain !== undefined ? { gain: existing.gain } : {}),
      });
      cursor = round2(cursor + durationSec);
    }
  }

  const cutLengthSec = round2(cursor);

  const tracks: Track[] = [{ id: "V1", kind: "video", name: "Video", clips: videoClips }];

  // ── A1: one clip spanning the source audio (production audio). Only when the
  //    probe says there IS audio (degrade gracefully on silent footage). ──
  if (item.source?.probe?.hasAudio && sourceDurationSec > 0 && sourceRef) {
    const dur = round2(sourceDurationSec);
    tracks.push({
      id: "A1",
      kind: "audio",
      name: "Source Audio",
      clips: [
        {
          id: "aclip_source",
          kind: "audio",
          src: sourceRef,
          inSec: 0,
          outSec: dur,
          startSec: 0,
          durationSec: dur,
          speed: 1,
          enabled: true,
        },
      ],
    });
  } else if (!item.source?.probe?.hasAudio) {
    warn(item, "ingest_seed", "no_audio", "source has no audio stream — seeding without an A1 audio track");
  }

  // ── Markers from highlights (the scored peak moments). Placed at SOURCE time;
  //    callers map to the assembled timeline if/when shots are reordered. ──
  const markers: Marker[] = (understanding?.highlights ?? []).map((h) => ({
    atSec: round2(h.startSec),
    label: h.why?.[0] ?? `highlight ${h.score.toFixed(2)}`,
    color: "#ffd166",
  }));

  // ── Copy per-shot clipAnalysis where useful so existing perception passes read
  //    it. We keep any prior clipAnalysis and overlay the shot-derived entries
  //    (keyed by shot id — matching sceneRef on the V1 clips). ──
  const clipAnalysis: NonNullable<ContentItem["clipAnalysis"]> = { ...(item.clipAnalysis ?? {}) };
  for (const shot of shots) {
    const sa = understanding?.perShot?.[shot.id];
    if (!sa) continue;
    clipAnalysis[shot.id] = {
      // ShotAnalysis extends ClipAnalysis — carry the shared perception fields the
      // passes read (motion/shaky/quality/brightness/hasText/bestMomentSec/notes).
      source: sa.source ?? sourceRef,
      sceneId: shot.id,
      ...(sa.motion !== undefined ? { motion: sa.motion } : {}),
      ...(sa.shaky !== undefined ? { shaky: sa.shaky } : {}),
      ...(sa.quality !== undefined ? { quality: sa.quality } : {}),
      ...(sa.brightness !== undefined ? { brightness: sa.brightness } : {}),
      ...(sa.hasText !== undefined ? { hasText: sa.hasText } : {}),
      ...(sa.bestMomentSec !== undefined ? { bestMomentSec: sa.bestMomentSec } : {}),
      suitableFor: sa.suitableFor ?? [],
      ...(sa.notes !== undefined ? { notes: sa.notes } : {}),
    };
  }

  const timeline: Timeline = {
    tracks,
    markers,
    compiledAt: nowIso(), // the timeline now OWNS timing (§2.1 precedence)
    fps: understanding?.fps ?? item.source?.probe?.video?.fps,
    seededFrom: "footage",
  };

  item.timeline = timeline;
  item.clipAnalysis = clipAnalysis;
  item.updatedAt = nowIso();
  saveItem(item);

  return timeline;
}
