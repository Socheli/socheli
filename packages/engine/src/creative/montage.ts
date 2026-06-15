/**
 * montage.ts — Pillar 5 N5.2: re-montage an ingested+understood video into a
 * fast-cut highlight reel / teaser / supercut, grounded in `item.understanding`.
 *
 * Where N3a (seed-from-footage.ts) lays an ASSEMBLY cut (every shot, in capture
 * order), this module is the SELECTIVE compiler: it ranks the understood shots by
 * their composite editorial score (highlight overlap + per-shot energy/motion +
 * spoken-content presence, minus dead-air/filler), KEEPS the strongest ones to fit
 * a target length / clip budget, ORDERS them by intent (narrative / energy /
 * chronological), and REBUILDS the timeline's video spine from just those shots —
 * each a Clip cutting the source at the shot's source in/out, laid sequentially.
 * The audio (A1) + caption (CAP1) tracks are re-mapped to match the new picture.
 *
 * Three exported pieces (the roadmap §7.1.5 N5.2 contract):
 *   - selectHighlights(id, spec) → Selection[]  (ranked, score-fitted shot picks)
 *   - orderMontage(selected, spec) → Selection[] (ordered per spec.orderBy)
 *   - montageFromHighlights(id, spec) → Timeline  (rebuilds + saves the timeline)
 *
 * REUSE: it reads the SAME artifacts the rest of the pillar reads — the
 * `Understanding` (shots / perShot / highlights / deadAir / filler, all in SOURCE
 * seconds) and the `Timeline`/`Clip` schema — and writes the SAME mutable layer
 * (`item.timeline`, seededFrom:"footage") so compile/render/QA pick it up unchanged.
 *
 * HARD RULES honoured: never throws (fail-open — degrades to the assembly cut /
 * a single fallback clip and warn()s); clamps every length; locked clips/tracks
 * are left untouched; IDEMPOTENT (re-running with the same spec produces the same
 * timeline, and a manual trim on a still-selected shot's clip survives a re-run).
 */

import type { Clip, Marker, Timeline, Track } from "@os/schemas";
import type { MontageSpec, Shot, Understanding } from "@os/schemas";

import { loadItem, nowIso, saveItem, warn } from "../store.ts";
import { beatSyncTimeline } from "./beat-sync.ts";

const round2 = (n: number) => Math.round(n * 100) / 100;
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

// Same stable per-shot clip id seed-from-footage.ts uses, so a re-montage can
// match a previously-seeded clip to its shot and PRESERVE any manual trim on it.
const clipIdForShot = (shotId: string) => `vclip_${shotId}`;

// ---------------------------------------------------------------------------
// Defaults — what each style means when the spec leaves a knob unset. A teaser is
// short + few hard cuts; a supercut is many tight cuts; highlight_reel is the
// middle ground; tight_cut keeps order but drops the weakest. These only fill
// GAPS in the spec — an explicit spec.targetSec/maxClips/orderBy always wins.
// ---------------------------------------------------------------------------
const STYLE_DEFAULTS: Record<
  NonNullable<MontageSpec["style"]>,
  { targetSec: number; maxClips: number; orderBy: NonNullable<MontageSpec["orderBy"]> }
> = {
  teaser: { targetSec: 20, maxClips: 4, orderBy: "energy" },
  highlight_reel: { targetSec: 45, maxClips: 8, orderBy: "energy" },
  supercut: { targetSec: 60, maxClips: 16, orderBy: "narrative" },
  tight_cut: { targetSec: 90, maxClips: 24, orderBy: "chronological" },
};

// A picked shot carried through select → order → build, with the score + the
// (possibly trimmed) source window the clip should cut. `why` is the cited
// reasons (highlight hit / high energy / spoken line) for the audit trail.
export type Selection = {
  shot: Shot;
  score: number;
  inSec: number; // source in (may be tightened toward a highlight window)
  outSec: number; // source out
  why: string[];
};

// ---------------------------------------------------------------------------
// Scoring — rank a shot by how montage-worthy it is, grounded in understanding.
// ---------------------------------------------------------------------------

/* Composite per-shot score in roughly 0..1+, summed from independent evidence so
   a shot that's strong on ONE axis (e.g. a punchy VO line over a static frame)
   still ranks. Each term is bounded; the total isn't capped (a shot strong on
   every axis should out-rank one strong on a single axis).

   Terms:
     + highlight overlap  — the biggest signal: a shot covering a scored Highlight
                            inherits that highlight's score (the composite the
                            understanding already computed from motion/VO/text).
     + per-shot energy    — energyRms (dB, negative) normalized: louder ⇒ higher.
     + per-shot motion    — visual motion (capped) — movement reads as "alive".
     + spoken content     — a shot with transcript text carries narrative weight.
     − dead-air dominance — fraction of the shot covered by deadAir spans (a shot
                            that's mostly silence is a weak pick) → subtract.
     − filler dominance   — density of filler hits in the shot (ums/long pauses).

   All fail-open: a missing perShot entry / no highlights just zeroes that term. */
function scoreShot(shot: Shot, u: Understanding): { score: number; why: string[] } {
  const why: string[] = [];
  let score = 0;

  // ── Highlight overlap (dominant term). Take the best-overlapping highlight's
  //    score, weighted by how much of it lands inside the shot. ──
  let bestHi = 0;
  for (const h of u.highlights ?? []) {
    const ov = Math.max(0, Math.min(shot.outSec, h.endSec) - Math.max(shot.inSec, h.startSec));
    if (ov <= 0) continue;
    const hiLen = Math.max(0.01, h.endSec - h.startSec);
    const weighted = h.score * clamp(ov / hiLen, 0, 1);
    if (weighted > bestHi) bestHi = weighted;
  }
  if (bestHi > 0) {
    score += bestHi; // highlight scores are already a tuned composite
    why.push(`highlight ${round2(bestHi)}`);
  }

  const sa = u.perShot?.[shot.id];

  // ── Energy: energyRms is dBFS (≈ −60 silent … 0 hot). Map −40..0 → 0..1. ──
  if (sa?.energyRms != null) {
    const e = clamp((sa.energyRms + 40) / 40, 0, 1);
    score += e * 0.4;
    if (e > 0.55) why.push(`energy ${round2(sa.energyRms)}dB`);
  }

  // ── Motion: ClipAnalysis.motion is ~0..1; cap its contribution so a shaky pan
  //    can't out-shout a real highlight. ──
  if (sa?.motion != null) {
    const m = clamp(sa.motion, 0, 1);
    score += m * 0.25;
    if (m > 0.5) why.push(`motion ${round2(m)}`);
  }

  // ── Spoken content: a shot carrying a transcript line has narrative value. ──
  const said = (sa?.transcriptText ?? wordsTextInShot(shot, u)).trim();
  if (said.length > 0) {
    score += clamp(said.length / 120, 0, 1) * 0.3; // longer line ⇒ more content, capped
    why.push("spoken");
  }

  // ── CONTENT-AWARE (not just energy): a coherent reel keeps the story spine, so
  //    the OPENING (hook) and CLOSING (CTA) are load-bearing, and a shot stating a
  //    real CLAIM (proper noun / number / causal or pitch marker) carries narrative
  //    weight a high-energy filler beat doesn't. This is what turns an energy-peak
  //    montage into hook→solution→CTA. ──
  const lastIdx = (u.shots?.length ?? 1) - 1;
  if (shot.index === 0) {
    score += 0.6;
    why.push("hook");
  } else if (shot.index === lastIdx) {
    score += 0.5;
    why.push("cta");
  }
  if (said.length > 0) {
    const properNouns = said.match(/\b[A-Z][a-z]{2,}/g)?.length ?? 0;
    const pitchMarker = /\b(\d+|because|so that|which means|the problem|the solution|imagine|introducing|that's why|the key)\b/i.test(said) ? 2 : 0;
    const claim = properNouns + pitchMarker;
    if (claim > 0) {
      score += clamp(claim * 0.12, 0, 0.55);
      why.push(`claim ${claim}`);
    }
  }

  // ── Dead-air penalty: fraction of the shot covered by silence spans. ──
  const shotLen = Math.max(0.01, shot.outSec - shot.inSec);
  let deadCov = 0;
  for (const d of u.deadAir ?? []) {
    deadCov += Math.max(0, Math.min(shot.outSec, d.endSec) - Math.max(shot.inSec, d.startSec));
  }
  const deadFrac = clamp(deadCov / shotLen, 0, 1);
  if (deadFrac > 0) {
    score -= deadFrac * 0.6;
    if (deadFrac > 0.4) why.push(`dead ${Math.round(deadFrac * 100)}%`);
  }

  // ── Filler penalty: density of filler hits (ums / long pauses) inside the shot. ──
  let fillerCount = 0;
  for (const f of u.filler ?? []) {
    if (f.atSec >= shot.inSec && f.atSec < shot.outSec) fillerCount++;
  }
  if (fillerCount > 0) {
    const dens = clamp(fillerCount / shotLen, 0, 1); // hits/sec, capped
    score -= dens * 0.3;
  }

  return { score: round2(score), why };
}

// Gather the transcript words that fall inside a shot's source window (fallback
// when perShot.transcriptText is absent). Reads understanding.transcript.words.
function wordsTextInShot(shot: Shot, u: Understanding): string {
  const ws = u.transcript?.words ?? [];
  const inWin = ws.filter((w) => w.startSec < shot.outSec && w.endSec > shot.inSec);
  return inWin.map((w) => w.word).join(" ");
}

// A shot is UNUSABLE for a montage if it's dominated by dead air / filler — we
// never want a teaser built out of silence. Conservative: only reject when a shot
// is OVERWHELMINGLY dead (so a normal pause inside a good line isn't dropped).
function isDeadDominated(shot: Shot, u: Understanding): boolean {
  const shotLen = Math.max(0.01, shot.outSec - shot.inSec);
  let deadCov = 0;
  for (const d of u.deadAir ?? []) {
    deadCov += Math.max(0, Math.min(shot.outSec, d.endSec) - Math.max(shot.inSec, d.startSec));
  }
  return deadCov / shotLen >= 0.7; // ≥70% silence ⇒ skip
}

// ---------------------------------------------------------------------------
// 1. selectHighlights — rank + pick to fit the spec.
// ---------------------------------------------------------------------------

/**
 * Rank the run's understood shots by composite score and pick the strongest to
 * fit `spec.targetSec` / `spec.maxClips`. Never selects a dead-air/filler-dominated
 * shot. Honours `spec.mustKeepShotIds`-style intent only via the spec we have
 * (MontageSpec has no mustKeep field in this schema), so selection is purely by
 * score. Returns the picks in DESCENDING score (ordering is orderMontage's job).
 *
 * Pure + fail-open: loads the item read-only, never mutates/saves. No understanding
 * (or no shots) ⇒ returns [] (the caller falls back to a usable timeline).
 */
export function selectHighlights(id: string, spec: MontageSpec): Selection[] {
  const item = loadItem(id);
  const u = item.understanding;
  if (!u || (u.shots?.length ?? 0) === 0) return [];

  const style = spec.style ?? "highlight_reel";
  const def = STYLE_DEFAULTS[style];
  // Clamp the budgets so a wild spec can't blow up the cut. targetSec is bounded
  // to the source length; maxClips to the available shot count.
  const targetSec = clamp(spec.targetSec ?? def.targetSec, 1, Math.max(1, u.durationSec || def.targetSec));
  const maxClips = clamp(Math.round(spec.maxClips ?? def.maxClips), 1, u.shots.length);
  // Per-clip floor: a teaser of 0.2s flickers; keep each pick at least this long.
  const perClipMinSec = 0.6;

  // ── Score every usable shot, drop the dead-dominated ones, sort desc. ──
  const scored: Selection[] = u.shots
    .filter((sh) => !isDeadDominated(sh, u))
    .map((sh) => {
      const { score, why } = scoreShot(sh, u);
      // The picked window is the shot's source window, but if a single Highlight
      // sits inside the shot we TIGHTEN toward it (with a little handle) so a long
      // shot contributes its punchiest moment, not its whole length. Fail-open: no
      // contained highlight ⇒ keep the full shot window.
      const win = tightenToHighlight(sh, u);
      return { shot: sh, score, inSec: win.inSec, outSec: win.outSec, why };
    })
    .sort((a, b) => b.score - a.score);

  if (scored.length === 0) return [];

  // ── Greedy fit: take from the top until we hit the clip budget OR the target
  //    length. We never go BELOW one clip; we stop adding once both budgets are
  //    met. A pick shorter than perClipMinSec is widened back toward the full shot. ──
  const picked: Selection[] = [];
  let acc = 0;
  for (const sel of scored) {
    if (picked.length >= maxClips) break;
    // Ensure the pick clears the per-clip floor (widen within the shot if needed).
    const widened = ensureMinLen(sel, perClipMinSec);
    const len = widened.outSec - widened.inSec;
    // Stop once we'd overshoot the target — UNLESS we have nothing yet (always
    // return at least one clip so the montage is never empty).
    if (picked.length > 0 && acc + len > targetSec) break;
    picked.push(widened);
    acc = round2(acc + len);
    if (acc >= targetSec) break;
  }

  return picked;
}

/* If a single Highlight is contained in the shot, return a window tightened to
   that highlight (± a 0.25s handle, clamped to the shot). Otherwise the full shot.
   This makes a long talking-head shot contribute just its punchline. */
function tightenToHighlight(shot: Shot, u: Understanding): { inSec: number; outSec: number } {
  const handle = 0.25;
  let best: { startSec: number; endSec: number; score: number } | null = null;
  for (const h of u.highlights ?? []) {
    // contained-ish: the highlight's centre lands inside the shot
    const mid = (h.startSec + h.endSec) / 2;
    if (mid >= shot.inSec && mid < shot.outSec) {
      if (!best || h.score > best.score) best = h;
    }
  }
  if (!best) return { inSec: round2(shot.inSec), outSec: round2(shot.outSec) };
  const inSec = round2(clamp(best.startSec - handle, shot.inSec, shot.outSec));
  const outSec = round2(clamp(best.endSec + handle, inSec, shot.outSec));
  // Degenerate (zero-length) tighten ⇒ fall back to the full shot.
  if (outSec - inSec < 0.2) return { inSec: round2(shot.inSec), outSec: round2(shot.outSec) };
  return { inSec, outSec };
}

/* Widen a too-short pick back toward its full shot window (centred) until it
   clears the floor or hits the shot bounds. Never exceeds the shot. */
function ensureMinLen(sel: Selection, minSec: number): Selection {
  const len = sel.outSec - sel.inSec;
  if (len >= minSec) return sel;
  const need = minSec - len;
  const inSec = round2(clamp(sel.inSec - need / 2, sel.shot.inSec, sel.shot.outSec));
  const outSec = round2(clamp(sel.outSec + need / 2, inSec, sel.shot.outSec));
  return { ...sel, inSec, outSec };
}

// ---------------------------------------------------------------------------
// 2. orderMontage — sequence the picks per the spec's intent.
// ---------------------------------------------------------------------------

/**
 * Order the selected clips per `spec.orderBy`:
 *   - "narrative"     — keep the SOURCE/story order (sort by shot source in-point)
 *                       so the transcript still reads as a coherent throughline.
 *   - "chronological" — same as narrative here (source order); kept distinct because
 *                       it's the explicit "as-shot" intent (no story re-weighting).
 *   - "energy"        — a BUILD→PEAK curve: open on a strong-but-not-peak beat, rise
 *                       to the single highest-energy clip near the END (a reel that
 *                       crescendos). We interleave so the climax lands last.
 *
 * Pure: returns a new array, never mutates the input. Unknown/absent orderBy
 * defaults to the style default (energy for reel/teaser, narrative for supercut).
 */
export function orderMontage(selected: Selection[], spec: MontageSpec): Selection[] {
  if (selected.length <= 1) return [...selected];
  const style = spec.style ?? "highlight_reel";
  const orderBy = spec.orderBy ?? STYLE_DEFAULTS[style].orderBy;

  if (orderBy === "narrative" || orderBy === "chronological") {
    // Story/source order — the as-captured sequence keeps the VO coherent.
    return [...selected].sort((a, b) => a.shot.inSec - b.shot.inSec);
  }

  // ── energy: build to a peak. Sort by score asc, then arrange as a rising curve
  //    with the single strongest clip LAST. We take the sorted-ascending list and
  //    keep it ascending — so the reel opens softer and climaxes on the top pick. ──
  const asc = [...selected].sort((a, b) => a.score - b.score);
  // A common reel shape: a strong HOOK first, then build to the peak. Pull the
  // 2nd-best to the front as the hook, leave the best last, ascending in between.
  if (asc.length >= 3) {
    const best = asc[asc.length - 1];
    const hook = asc[asc.length - 2];
    const middle = asc.slice(0, asc.length - 2); // weakest..3rd-best, ascending
    return [hook, ...middle, best];
  }
  return asc; // 2 clips: weaker then stronger (a mini build)
}

// ---------------------------------------------------------------------------
// 3. montageFromHighlights — rebuild the timeline from selected + ordered shots.
// ---------------------------------------------------------------------------

/**
 * Re-montage an ingested run into a highlight reel / teaser / supercut: select +
 * order the strongest shots, then REBUILD `item.timeline`:
 *   - V1 (video): one Clip per selected shot, cutting the source at the shot's
 *     (tightened) source window, laid SEQUENTIALLY (no gaps) in the chosen order.
 *     A still-selected shot's clip preserves a prior MANUAL trim (idempotency).
 *   - A1 (audio): re-built to MATCH — one source-audio clip per kept picture clip,
 *     same source window, laid in lock-step under V1, so the production audio
 *     follows the cut. Degrades to absent on silent footage.
 *   - CAP1 (captions): existing caption clips are RE-MAPPED from SOURCE time onto
 *     the new sequential timeline — a caption is kept only if its words fall inside
 *     a selected window, and is repositioned to where that window now sits. Captions
 *     for dropped footage are removed (no orphan subtitles over a cut).
 *   - Markers: one ruler marker at the start of each kept clip (its top reason).
 *
 * IDEMPOTENT: same spec ⇒ same selection ⇒ same timeline. seededFrom stays
 * "footage". FAIL-OPEN: no understanding/shots, or an empty selection, falls back
 * to re-seeding the full assembly (or a single fallback clip) and warn()s — never
 * throws, never leaves the run without a usable timeline. LOCKED-SAFE: a clip the
 * user locked on a prior cut is preserved (kept in place, not re-montaged away).
 */
export function montageFromHighlights(id: string, spec: MontageSpec): Timeline {
  const item = loadItem(id);
  const u = item.understanding;

  const sourceRef = item.source?.path ?? item.videoPath ?? "";
  const sourceDurationSec = u?.durationSec ?? item.source?.probe?.durationSec ?? 0;
  const hasAudio = Boolean(item.source?.probe?.hasAudio);

  // ── Index prior V1 clips by shot id so a re-montage preserves a manual trim on a
  //    still-selected shot, and so we can carry forward LOCKED clips untouched. ──
  const prior = item.timeline;
  const priorV1 = prior?.tracks?.find((t) => t.id === "V1");
  const priorClipById = new Map<string, Clip>();
  for (const c of priorV1?.clips ?? []) if (c.id) priorClipById.set(c.id, c);

  // ── Select + order. Fail-open to the full shot set if selection comes back empty
  //    (e.g. understanding present but every shot scored as dead). ──
  let ordered: Selection[] = [];
  if (u && (u.shots?.length ?? 0) > 0) {
    const selected = selectHighlights(id, spec);
    ordered = orderMontage(selected, spec);
  }

  // Degrade path: no usable picks → fall back to the assembly (all shots in source
  // order) so the timeline is still a valid footage cut, never empty.
  if (ordered.length === 0) {
    warn(item, "montage", "no_selection", "no montage-worthy shots selected — falling back to the full assembly cut");
    ordered = (u?.shots ?? [])
      .slice()
      .sort((a, b) => a.inSec - b.inSec)
      .map((sh) => ({ shot: sh, score: 0, inSec: round2(sh.inSec), outSec: round2(sh.outSec), why: [] }));
  }

  // ── Build V1 (+ a remap table: which source window now sits where on the
  //    timeline, so A1 + captions can follow). ──
  const videoClips: Clip[] = [];
  // remap[i] = {srcIn, srcOut, tlStart} — the i-th kept clip's source window and
  // its new timeline start. Used to project captions from source→timeline time.
  const remap: { srcIn: number; srcOut: number; tlStart: number }[] = [];
  let cursor = 0;

  if (ordered.length === 0 || !sourceRef) {
    // Ultimate fallback: a single full-length clip (mirrors seed-from-footage).
    const dur = round2(sourceDurationSec);
    if (dur > 0 && sourceRef) {
      videoClips.push({ id: "vclip_fallback", kind: "video", src: sourceRef, inSec: 0, outSec: dur, startSec: 0, durationSec: dur, speed: 1, enabled: true });
      remap.push({ srcIn: 0, srcOut: dur, tlStart: 0 });
      cursor = dur;
    } else {
      warn(item, "montage", "no_source", "no source video path — cannot build a footage montage");
    }
  } else {
    for (const sel of ordered) {
      const cid = clipIdForShot(sel.shot.id);
      const existing = priorClipById.get(cid);
      // Preserve a manual trim on a still-selected shot: keep the hand-edited
      // source window if the user already tweaked this clip. Otherwise use the
      // montage-chosen (tightened) window.
      const inSec = existing?.inSec ?? sel.inSec;
      const outSec = existing?.outSec ?? sel.outSec;
      const durationSec = round2(existing?.durationSec ?? Math.max(0, (outSec ?? sel.outSec) - inSec));
      if (durationSec <= 0) continue; // skip a degenerate zero-length pick
      const startSec = round2(cursor);
      videoClips.push({
        id: cid,
        kind: "video",
        src: sourceRef,
        sceneRef: sel.shot.id, // tie the clip back to its source shot
        inSec: round2(inSec),
        outSec: outSec !== undefined ? round2(outSec) : undefined,
        startSec,
        durationSec,
        speed: existing?.speed ?? 1,
        enabled: existing?.enabled ?? true,
        ...(existing?.locked !== undefined ? { locked: existing.locked } : {}),
        ...(existing?.gain !== undefined ? { gain: existing.gain } : {}),
      });
      remap.push({ srcIn: round2(inSec), srcOut: round2((outSec ?? sel.outSec)), tlStart: startSec });
      cursor = round2(cursor + durationSec);
    }
  }

  const tracks: Track[] = [{ id: "V1", kind: "video", name: "Video", clips: videoClips }];

  // ── A1: re-cut the production audio to follow the picture — one audio clip per
  //    kept video clip, same source window + timeline position. Only when the
  //    source actually has audio (degrade silently otherwise). ──
  if (hasAudio && sourceRef) {
    const audioClips: Clip[] = remap.map((r, i) => ({
      id: `aclip_${i}`,
      kind: "audio",
      src: sourceRef,
      inSec: r.srcIn,
      outSec: r.srcOut,
      startSec: r.tlStart,
      durationSec: round2(Math.max(0, r.srcOut - r.srcIn)),
      speed: 1,
      enabled: true,
    }));
    if (audioClips.length) tracks.push({ id: "A1", kind: "audio", name: "Source Audio", clips: audioClips });
  } else if (!hasAudio) {
    warn(item, "montage", "no_audio", "source has no audio stream — montage built without an A1 audio track");
  }

  // ── CAP1: re-map the existing caption track from SOURCE time onto the new
  //    sequential timeline. A caption clip is kept iff its word-window overlaps a
  //    SELECTED source window; it's repositioned to where that window now sits
  //    (tlStart + offset-into-window). Captions over dropped footage vanish. ──
  const priorCap = prior?.tracks?.find((t) => t.id === "CAP1");
  if (priorCap && priorCap.clips.length && remap.length) {
    const newCapClips: Clip[] = [];
    for (const cap of priorCap.clips) {
      // The caption's source span (captions carry SOURCE-time words; fall back to
      // the clip's own startSec/duration which seed-from-footage set in source time).
      const capStart = cap.words?.[0]?.fromSec ?? cap.startSec ?? 0;
      const capEnd = cap.words?.[cap.words.length - 1]?.toSec ?? capStart + (cap.durationSec ?? 0);
      // Find the kept window this caption lands in (centre inside the window).
      const mid = (capStart + capEnd) / 2;
      const win = remap.find((r) => mid >= r.srcIn && mid < r.srcOut);
      if (!win) continue; // caption belongs to dropped footage — drop it
      const offset = clamp(capStart - win.srcIn, 0, win.srcOut - win.srcIn);
      const newStart = round2(win.tlStart + offset);
      // Clamp the caption duration so it never runs past the kept clip's end.
      const maxDur = round2(win.tlStart + (win.srcOut - win.srcIn) - newStart);
      const dur = round2(clamp(cap.durationSec ?? capEnd - capStart, 0, Math.max(0, maxDur)));
      if (dur <= 0) continue;
      newCapClips.push({ ...cap, startSec: newStart, durationSec: dur });
    }
    if (newCapClips.length) {
      // keep the caption clips in timeline order
      newCapClips.sort((a, b) => a.startSec - b.startSec);
      tracks.push({ id: "CAP1", kind: "text", name: "captions", clips: newCapClips });
    }
  }

  // ── Markers: one at each kept clip's start, labelled with its top reason. ──
  const markers: Marker[] = ordered.length
    ? remap.map((r, i) => ({
        atSec: r.tlStart,
        label: ordered[i]?.why?.[0] ?? `clip ${i + 1}`,
        color: "#ffd166",
      }))
    : [];

  const timeline: Timeline = {
    tracks,
    markers,
    compiledAt: nowIso(), // the montaged timeline OWNS timing (§2.1 precedence)
    fps: u?.fps ?? item.source?.probe?.video?.fps ?? prior?.fps,
    seededFrom: "footage",
  };

  item.timeline = timeline;
  item.updatedAt = nowIso();
  saveItem(item);

  // BEAT-SYNC auto-pass (P5): if a music bed is already set, lock the cuts to its
  // downbeats. Pure post-pass over V1 (source windows preserved → captions remap
  // at render). beatSyncTimeline reloads the item, so we save FIRST then snap.
  // No-op until edit-music has set musicSrc; run creative_beat_sync later otherwise.
  if ((item as { musicSrc?: string }).musicSrc) {
    try {
      return beatSyncTimeline(id).timeline;
    } catch {
      /* fail-open */
    }
  }
  return timeline;
}

/* ── TIGHTEN ──────────────────────────────────────────────────────────────────
   The COHERENT alternative to a highlight-reel montage: keep the WHOLE narrative
   in order, but cut out only the dead air and filler ("um"/"uh"/long pauses) so a
   talking-head pitch gets tighter WITHOUT the jump-cuts a highlight reel creates.
   We compute the KEEP spans = [0,duration] minus (deadAir ∪ filler windows), and
   rebuild V1 from those spans in source order. The render-time caption remap
   (render.ts sourceToTimelineSec) drops the removed words and re-anchors the rest,
   so captions follow automatically. FAIL-OPEN: no understanding / nothing to cut →
   a single full-length clip (identity), never throws. */
export function tightenFootage(id: string, opts?: { padSec?: number }): Timeline {
  const item = loadItem(id);
  const u = item.understanding;
  const sourceRef = item.source?.path ?? item.videoPath ?? "";
  const dur = round2(u?.durationSec ?? item.source?.probe?.durationSec ?? 0);
  const hasAudio = Boolean(item.source?.probe?.hasAudio);
  const pad = opts?.padSec ?? 0.12;

  // CUT intervals: every dead-air span + a tight window around each filler word
  // (use the transcript word's own span when we can find it, else a small default).
  const words = u?.transcript?.words ?? [];
  const cuts: { start: number; end: number }[] = [];
  for (const d of u?.deadAir ?? []) cuts.push({ start: d.startSec, end: d.endSec });
  for (const f of u?.filler ?? []) {
    const w = words.find((x) => f.atSec >= x.startSec - 0.05 && f.atSec <= x.endSec + 0.05);
    if (w) cuts.push({ start: w.startSec - pad, end: w.endSec + pad });
    else cuts.push({ start: f.atSec - 0.2, end: f.atSec + 0.4 });
  }
  // Merge overlapping/adjacent cuts.
  cuts.sort((a, b) => a.start - b.start);
  const merged: { start: number; end: number }[] = [];
  for (const c of cuts) {
    const last = merged[merged.length - 1];
    if (last && c.start <= last.end + 0.05) last.end = Math.max(last.end, c.end);
    else merged.push({ start: Math.max(0, c.start), end: c.end });
  }
  // KEEP = the complement of the cuts over [0, dur]; drop sub-0.3s slivers.
  const keep: { start: number; end: number }[] = [];
  let pos = 0;
  for (const c of merged) {
    if (c.start - pos >= 0.3) keep.push({ start: round2(pos), end: round2(Math.min(c.start, dur)) });
    pos = Math.max(pos, c.end);
  }
  if (dur - pos >= 0.3) keep.push({ start: round2(pos), end: dur });
  if (!keep.length && dur > 0) keep.push({ start: 0, end: dur }); // nothing to cut → identity

  // Build V1 from the keep spans (source order), laid out back-to-back.
  const videoClips: Clip[] = [];
  let cursor = 0;
  keep.forEach((k, i) => {
    const d = round2(k.end - k.start);
    if (d <= 0 || !sourceRef) return;
    videoClips.push({ id: `tighten_${i}`, kind: "video", src: sourceRef, inSec: k.start, outSec: k.end, startSec: round2(cursor), durationSec: d, speed: 1, enabled: true });
    cursor = round2(cursor + d);
  });
  if (!videoClips.length && sourceRef && dur > 0) {
    videoClips.push({ id: "tighten_full", kind: "video", src: sourceRef, inSec: 0, outSec: dur, startSec: 0, durationSec: dur, speed: 1, enabled: true });
    cursor = dur;
  }

  const tracks: Track[] = [{ id: "V1", kind: "video", name: "Video", clips: videoClips }];
  if (hasAudio && sourceRef) tracks.push({ id: "A1", kind: "audio", name: "Source Audio", clips: [{ id: "a_full", kind: "audio", src: sourceRef, inSec: 0, outSec: dur, startSec: 0, durationSec: round2(cursor), speed: 1, enabled: true }] });
  // Carry the existing caption track unchanged — the render remap re-anchors its
  // words to the tightened cut (and drops words whose source moment we cut).
  const priorCap = item.timeline?.tracks?.find((t) => t.id === "CAP1");
  if (priorCap) tracks.push(priorCap);

  const cutSec = round2(dur - cursor);
  warn(item, "tighten", "ok", `tightened ${dur}s → ${round2(cursor)}s (cut ${cutSec}s of dead air + filler across ${keep.length} kept span(s))`);
  const timeline: Timeline = { tracks, markers: item.timeline?.markers ?? [], compiledAt: nowIso(), fps: u?.fps ?? item.source?.probe?.video?.fps, seededFrom: "footage" };
  item.timeline = timeline;
  item.updatedAt = nowIso();
  saveItem(item);
  // BEAT-SYNC auto-pass (P5): lock the cuts to the bed's downbeats if a music bed
  // is set. Save FIRST (beatSyncTimeline reloads). No-op until edit-music ran.
  if ((item as { musicSrc?: string }).musicSrc) {
    try {
      return beatSyncTimeline(id).timeline;
    } catch {
      /* fail-open */
    }
  }
  return timeline;
}
