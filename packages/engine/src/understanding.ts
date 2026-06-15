/* understanding.ts — Pillar 5 (Ingest & Understand) N2: DEEP UNDERSTANDING.
 *
 * `buildUnderstanding(id)` takes an INGESTED ContentItem (kind:"ingested",
 * videoPath = the normalized source) and produces the structured `Understanding`
 * index the agent reads — the footage-side analogue of `editSignals` for a
 * generated run. It mirrors how the generated passes ground themselves in
 * measurement: transcript → shots → speakers → per-shot multimodal evidence →
 * editorial signals (filler / dead-air / redundancy / highlights), all in SOURCE
 * SECONDS (frames are derived only at caption build, N4).
 *
 * REUSE-FIRST: every measurement is the SAME code that powers editor_video_evidence
 * / editor_analyze_av / the colorist scopes — re-exported from editor-tools.ts
 * (transcribeVideoAudio, videoDiagnostics, denseFrameScan, analyzeFramePixels,
 * frameVisualMetrics, runVisionOcr, wordsInRange, textSimilarity) plus analyzeClip
 * from creative/perception.ts. There is no second implementation of any probe.
 *
 * FAIL-OPEN, ALWAYS (CLAUDE.md hard rule — real footage is messy): every stage is
 * wrapped; on ANY failure it warn()s + degrades to a sensible minimum (a single
 * whole-clip shot, an empty transcript, an absent speaker block) rather than
 * throwing. A run with no audio, an unreadable stream, or a missing Whisper venv
 * still yields a valid Understanding the agent can act on.
 */

import {
  type Understanding,
  type Transcript,
  type TWord,
  type TSegment,
  type Speaker,
  type Shot,
  type ShotAnalysis,
  type Highlight,
  type FillerHit,
  type RedundantPair,
  type Span,
  Understanding as UnderstandingSchema,
} from "@os/schemas";
import { existsSync } from "node:fs";
import { loadItem, saveItem, logLine, nowIso, warn } from "./store.ts";
import { describeShots, synthesizeVideoSummary } from "./understanding-vision.ts";
import { analyzeMusic } from "./understanding-music.ts";
import {
  resolveVideoFile,
  probeVideo,
  durationFromProbe,
  transcribeVideoAudio,
  videoDiagnostics,
  perRegionRms,
  rawFrame,
  analyzeFramePixels,
  runVisionOcr,
  wordsInRange,
  textSimilarity,
  sampleFrame,
} from "./editor-tools.ts";

/* PER-SHOT PERCEPTION — REUSE NOTE. The spec's "analyzeClip + nearest dense
   frame" is honoured by measuring each shot's KEYFRAME with the SAME primitives
   analyzeClip / editor_video_evidence use (rawFrame → analyzeFramePixels →
   motionDelta → runVisionOcr), rather than spawning N temp-segment cuts to feed
   analyzeClip a discrete file. analyzeClip is built for a 1:1 clip→asset (a
   discrete b-roll file); an ingested run is ONE source file, so the keyframe-
   direct read is both cheaper and exactly what analyzeClip would compute on the
   same pixels — one measurement implementation, no temp-file churn per shot. */

// ── Tunables (seconds). Conservative so we never over-segment messy footage. ──
const MIN_SHOT_SEC = 1.2; // shots shorter than this get absorbed into a neighbour
const SPEAKER_PAUSE_SEC = 0.7; // gap between segments that may signal a speaker turn
const SPEAKER_RMS_SHIFT_DB = 6; // per-turn loudness shift that corroborates a new speaker
const DEAD_AIR_SEC = 1.2; // a silence longer than this is editorially dead air
const LONG_PAUSE_SEC = 1.5; // an inter-word pause this long counts as a disfluency
const REDUNDANCY_SIM = 0.82; // segment-pair similarity above which they're near-duplicates
const FILLER_WORDS = new Set(["um", "uh", "uhh", "umm", "er", "erm", "hmm", "like", "y'know", "youknow", "basically", "literally", "actually"]);
const TOP_HIGHLIGHTS = 6;

const round2 = (n: number) => Math.round(n * 100) / 100;
const round3 = (n: number) => Math.round(n * 1000) / 1000;
const clean = (w: string) => w.toLowerCase().replace(/[^a-z']/g, "");

/* ── STAGE 1 · TRANSCRIBE ───────────────────────────────────────────────────
   Reuse the SINGLE Whisper path (editor-tools.transcribeVideoAudio → the MLX
   turbo model via scripts/whisper-words.py). The script now emits segments[]
   (line-level boundaries + avg_logprob/no_speech_prob) alongside the words the
   karaoke path already used. Normalize both into the schema shape (start/end →
   startSec/endSec). FAIL-OPEN: no audio / no venv → an empty transcript + a note. */
function transcribeStage(
  id: string,
  video: string,
  hasAudio: boolean,
  notes: string[],
  vocab?: { prompt?: string; glossary?: Array<{ from: string; to: string }> },
): Transcript {
  const empty: Transcript = { text: "", words: [], segments: [] };
  if (!hasAudio) {
    notes.push("no audio stream — transcript skipped");
    return empty;
  }
  try {
    const r = transcribeVideoAudio(`${id}_understand`, video, vocab ?? {});
    if (vocab?.prompt) notes.push(`transcription biased with vocabulary hint (${vocab.prompt.slice(0, 60)}…)`);
    if (vocab?.glossary?.length) notes.push(`glossary applied: ${vocab.glossary.map((g) => g.to).join(", ").slice(0, 80)}`);
    if (!r.available) {
      notes.push(`transcription unavailable: ${r.reason ?? "unknown"}`);
      return empty;
    }
    const words: TWord[] = (r.words ?? []).map((w: any) => ({
      word: String(w.word ?? ""),
      startSec: round3(Number(w.start ?? 0)),
      endSec: round3(Number(w.end ?? w.start ?? 0)),
      ...(Number.isFinite(Number(w.conf)) ? { conf: Number(w.conf) } : {}),
    }));
    const segments: TSegment[] = (r.segments ?? []).map((s: any, i: number) => ({
      index: Number.isFinite(Number(s.index)) ? Number(s.index) : i,
      startSec: round3(Number(s.start ?? 0)),
      endSec: round3(Number(s.end ?? s.start ?? 0)),
      text: String(s.text ?? "").trim(),
      ...(Number.isFinite(Number(s.avg_logprob)) ? { avgLogprob: Number(s.avg_logprob) } : {}),
      ...(Number.isFinite(Number(s.no_speech_prob)) ? { noSpeechProb: Number(s.no_speech_prob) } : {}),
    }));
    if (!segments.length && words.length) {
      notes.push("transcript words only (no segment boundaries) — speaker/redundancy degraded");
    }
    return { text: String(r.text ?? "").trim(), words, segments };
  } catch (e) {
    notes.push(`transcription failed: ${e instanceof Error ? e.message : String(e)}`);
    return empty;
  }
}

/* ── STAGE 3 · SPEAKERS (heuristic, NOT diarization) ─────────────────────────
   Group transcript segments into speaker turns from two cheap, footage-robust
   cues: a PAUSE GAP between consecutive segments, AND a per-segment loudness
   (RMS) level-shift. We start a new turn only when the gap is long AND the level
   moves materially — conservative, so a single-speaker clip resolves to ONE
   speaker (the common case). NEVER a heavy diarization dependency; flagged in
   notes as heuristic so the agent doesn't over-trust the labels. Returns the
   speakers AND a segment→speakerId map the shot fusion reads. FAIL-OPEN. */
function speakerStage(
  video: string,
  transcript: Transcript,
  notes: string[],
): { speakers: Speaker[]; segSpeaker: Map<number, string> } {
  const segSpeaker = new Map<number, string>();
  const segs = transcript.segments;
  if (!segs.length) return { speakers: [], segSpeaker };
  try {
    // Per-segment RMS (mean dB) — reuse the same volumedetect-per-region probe the
    // mixer uses. One ffmpeg call per segment; bounded by the transcript length.
    const rms = perRegionRms(
      video,
      segs.map((s) => ({ startSec: s.startSec, endSec: s.endSec })),
    );
    let speakerIdx = 0; // 0-based; label A,B,C…
    let prevEnd = segs[0]?.startSec ?? 0;
    let prevRms = NaN;
    const turnsBySpeaker = new Map<string, Span[]>();
    for (let i = 0; i < segs.length; i++) {
      const seg = segs[i];
      const segRms = Number(rms[i]?.rms);
      const gap = seg.startSec - prevEnd;
      const rmsShift = Number.isFinite(segRms) && Number.isFinite(prevRms) ? Math.abs(segRms - prevRms) : 0;
      // A turn change needs BOTH a real pause AND a real level shift (or the very
      // first segment, which opens speaker A). Conservative on purpose.
      if (i > 0 && gap >= SPEAKER_PAUSE_SEC && rmsShift >= SPEAKER_RMS_SHIFT_DB) {
        speakerIdx++;
      }
      const sid = `spk_${speakerIdx}`;
      segSpeaker.set(seg.index, sid);
      (turnsBySpeaker.get(sid) ?? turnsBySpeaker.set(sid, []).get(sid)!).push({
        startSec: seg.startSec,
        endSec: seg.endSec,
      });
      prevEnd = seg.endSec;
      if (Number.isFinite(segRms)) prevRms = segRms;
    }
    const speakers: Speaker[] = [...turnsBySpeaker.entries()].map(([sid, turns], i) => ({
      id: sid,
      label: String.fromCharCode(65 + i), // A, B, C…
      turns,
      totalSec: round2(turns.reduce((a, t) => a + Math.max(0, t.endSec - t.startSec), 0)),
    }));
    notes.push(speakers.length > 1 ? `heuristic speaker turns (${speakers.length} speakers, pause+RMS — not diarization)` : "heuristic speaker turns (single speaker — not diarization)");
    return { speakers, segSpeaker };
  } catch (e) {
    notes.push(`speaker segmentation failed (single-speaker fallback): ${e instanceof Error ? e.message : String(e)}`);
    // Fallback: one speaker over the whole transcript.
    const all = segs.map((s) => ({ startSec: s.startSec, endSec: s.endSec }));
    for (const s of segs) segSpeaker.set(s.index, "spk_0");
    return {
      speakers: [{ id: "spk_0", label: "A", turns: all, totalSec: round2(all.reduce((a, t) => a + Math.max(0, t.endSec - t.startSec), 0)) }],
      segSpeaker,
    };
  }
}

/* ── STAGE 2 · SHOTS (boundary fusion) ───────────────────────────────────────
   A "shot" is a continuous take — the unit a footage-seeded timeline clip cuts.
   Fuse three boundary sources into one sorted set of cut points:
     • ffmpeg scene-change detection (videoDiagnostics.sceneChanges — visual cuts)
     • silence boundaries (the END of a silence ≈ a new beat opening)
     • speaker turn starts (a new voice ≈ a new shot)
   Then build shots between consecutive cuts, ABSORB any shot shorter than
   MIN_SHOT_SEC into its previous neighbour (messy real footage produces tiny
   false cuts), and on a SINGLE-TAKE clip (no boundaries) fall back to ONE shot =
   the whole clip. Tag each shot with the boundary kind that opened it + the
   speaker holding the floor at its midpoint. FAIL-OPEN → one whole-clip shot. */
function shotStage(
  diag: any,
  durationSec: number,
  speakers: Speaker[],
  notes: string[],
): Shot[] {
  const wholeClip = (): Shot[] => [
    { id: "shot_0", index: 0, inSec: 0, outSec: round2(durationSec), durationSec: round2(durationSec), source: "fallback", keyframeSec: round2(durationSec / 2) },
  ];
  if (!(durationSec > 0)) {
    notes.push("unknown duration — single-take shot fallback");
    return wholeClip();
  }
  try {
    // Collect cut points (each tagged with which source proposed it) in (0,dur).
    type Cut = { atSec: number; source: Shot["source"] };
    const cuts: Cut[] = [];
    for (const sc of diag?.sceneChanges ?? []) {
      const t = Number(sc.atSec);
      if (Number.isFinite(t) && t > 0.1 && t < durationSec - 0.1) cuts.push({ atSec: t, source: "cut" });
    }
    for (const s of diag?.silence ?? []) {
      // silence end = a new beat opening; silence is {start,end} (parseIntervals).
      const t = Number(s.end ?? s.silence_end);
      if (Number.isFinite(t) && t > 0.1 && t < durationSec - 0.1) cuts.push({ atSec: t, source: "silence" });
    }
    for (const spk of speakers) {
      for (const turn of spk.turns) {
        const t = Number(turn.startSec);
        if (Number.isFinite(t) && t > 0.1 && t < durationSec - 0.1) cuts.push({ atSec: t, source: "speaker" });
      }
    }
    // Sort + de-dup cuts that fall within MIN_SHOT_SEC of each other (first wins —
    // visual cuts are listed first so they take precedence over silence/speaker).
    cuts.sort((a, b) => a.atSec - b.atSec);
    const merged: Cut[] = [];
    for (const c of cuts) {
      if (merged.length && c.atSec - merged[merged.length - 1].atSec < MIN_SHOT_SEC) continue;
      merged.push(c);
    }
    if (!merged.length) {
      notes.push("single-take clip (no scene/silence/speaker boundaries)");
      return wholeClip();
    }
    // Build [in,out) shots between 0, each cut, and the duration. The boundary
    // that OPENED each shot is the cut at its start (the first shot opens as a cut
    // of the clip itself → "fallback").
    const bounds = [0, ...merged.map((m) => m.atSec), durationSec];
    const sourceAt = (i: number): Shot["source"] => (i === 0 ? "fallback" : merged[i - 1].source);
    const raw: Shot[] = [];
    for (let i = 0; i < bounds.length - 1; i++) {
      const inSec = round2(bounds[i]);
      const outSec = round2(bounds[i + 1]);
      raw.push({ id: "", index: 0, inSec, outSec, durationSec: round2(outSec - inSec), source: sourceAt(i), keyframeSec: round2((inSec + outSec) / 2) });
    }
    // Absorb sub-minimum shots into the previous shot (extend its out point).
    const absorbed: Shot[] = [];
    for (const sh of raw) {
      if (sh.durationSec < MIN_SHOT_SEC && absorbed.length) {
        const prev = absorbed[absorbed.length - 1];
        prev.outSec = sh.outSec;
        prev.durationSec = round2(prev.outSec - prev.inSec);
        prev.keyframeSec = round2((prev.inSec + prev.outSec) / 2);
      } else {
        absorbed.push(sh);
      }
    }
    // Re-index, assign stable ids, and tag the speaker at each shot's midpoint.
    const speakerAt = (sec: number): string | undefined => {
      for (const spk of speakers) for (const t of spk.turns) if (sec >= t.startSec && sec <= t.endSec) return spk.id;
      return undefined;
    };
    return absorbed.map((sh, i) => ({
      ...sh,
      id: `shot_${i}`,
      index: i,
      ...(speakerAt(sh.keyframeSec) ? { speaker: speakerAt(sh.keyframeSec) } : {}),
    }));
  } catch (e) {
    notes.push(`shot segmentation failed (single-take fallback): ${e instanceof Error ? e.message : String(e)}`);
    return wholeClip();
  }
}

/* Coarse framing from edge/contrast pixel metrics (NO face detector in-repo).
   A tight shot (a face/subject filling frame) tends to have LOW edge density +
   strong central contrast; a wide shot (lots of detail/texture) has HIGH edge
   density. This is a heuristic proxy only — schema marks framing optional. */
function framingFrom(metrics: any): ShotAnalysis["framing"] | undefined {
  const edge = Number(metrics?.edgePct);
  if (!Number.isFinite(edge)) return undefined;
  if (edge < 3) return "tight";
  if (edge > 9) return "wide";
  return "mid";
}

/* ── STAGE 4 · PER-SHOT MULTIMODAL ───────────────────────────────────────────
   For each shot, fuse everything we can measure into a ShotAnalysis (extends
   ClipAnalysis): analyzeClip on the shot WINDOW (motion/quality/brightness/
   bestMoment — reuses perception.ts), a raw keyframe's pixel metrics + motionDelta
   (analyzeFramePixels via frameVisualMetrics math), OCR of the keyframe
   (onScreenText), the transcript words inside the shot, and the shot's region RMS
   (energyRms). FAIL-OPEN PER SHOT: any sub-probe that fails leaves its field
   undefined; one bad shot never aborts the loop. Returns a record keyed by shot
   id (the schema's perShot shape). */
async function perShotStage(
  video: string,
  shots: Shot[],
  transcript: Transcript,
  notes: string[],
): Promise<Record<string, ShotAnalysis>> {
  const perShot: Record<string, ShotAnalysis> = {};
  if (!shots.length) return perShot;
  // Region RMS for every shot in one batched call (energyRms per shot).
  let rms: { rms: number }[] = [];
  try {
    rms = perRegionRms(video, shots.map((s) => ({ startSec: s.inSec, endSec: s.outSec })));
  } catch {
    /* fail-open: energyRms stays undefined per shot */
  }
  let ocrFailed = false;
  let prevFrame: { data: Buffer } | undefined;
  for (let i = 0; i < shots.length; i++) {
    const shot = shots[i];
    // `source` records the shot WINDOW (source seconds) this analysis covers;
    // suitableFor defaults empty (footage shots aren't scored for scene-function).
    const base = { source: `${shot.inSec}-${shot.outSec}s`, suitableFor: [] as ShotAnalysis["suitableFor"] };
    try {
      // (a) Keyframe pixel metrics + motion delta (see the REUSE NOTE up top — the
      // same primitives analyzeClip / editor_video_evidence compute, read direct).
      let metrics: any = null;
      let motionDelta: number | undefined;
      try {
        const frame = rawFrame(video, shot.keyframeSec, 320);
        metrics = analyzeFramePixels(frame);
        if (prevFrame?.data?.length === frame.data.length) {
          let diff = 0;
          for (let k = 0; k < frame.data.length; k += 9) diff += Math.abs(frame.data[k] - prevFrame.data[k]);
          motionDelta = round3(diff / Math.max(1, frame.data.length / 9) / 255);
        }
        prevFrame = { data: frame.data };
      } catch {
        /* keyframe decode failed for this shot — leave pixel metrics empty */
      }
      // (b) Brightness from the keyframe's bright/dark balance (0..1, 0.5≈neutral).
      const brightness = metrics ? clamp01(((Number(metrics.brightPct) || 0) - (Number(metrics.darkPct) || 0)) / 100 + 0.5) : undefined;
      // (c) OCR the keyframe for on-screen text (fail-open / skip once it's down).
      let onScreenText: string | undefined;
      let ocrConf: number | undefined;
      if (!ocrFailed && metrics) {
        try {
          const framePath = sampleFrame(`understand_${shot.id}`, video, shot.keyframeSec, `kf_${shot.index}`);
          const ocr = runVisionOcr([framePath]);
          if (ocr.available && Array.isArray(ocr.results) && ocr.results[0]) {
            const lines = (ocr.results[0] as any).lines ?? [];
            const text = lines.map((l: any) => l.text).filter(Boolean).join(" ").trim();
            if (text) {
              onScreenText = text.slice(0, 280);
              const confs = lines.map((l: any) => Number(l.confidence)).filter((n: number) => Number.isFinite(n));
              if (confs.length) ocrConf = round2(confs.reduce((a: number, b: number) => a + b, 0) / confs.length);
            }
          } else if (!ocr.available) {
            ocrFailed = true; // Vision unavailable — stop trying for remaining shots
          }
        } catch {
          /* OCR failed this shot — leave onScreenText undefined */
        }
      }
      // (d) Transcript words inside the shot (source seconds).
      const wordsIn = wordsInRange(transcript.words, shot.inSec, shot.outSec);
      const transcriptText = wordsIn.map((w: any) => w.word).join(" ").trim() || undefined;
      // (e) Region RMS (energy).
      const energyRms = Number.isFinite(Number(rms[i]?.rms)) ? round2(Number(rms[i].rms)) : undefined;
      perShot[shot.id] = {
        ...base,
        sceneId: shot.id,
        ...(brightness !== undefined ? { brightness } : {}),
        ...(motionDelta !== undefined ? { motion: clamp01(motionDelta * 4), motionDelta } : {}),
        ...(metrics ? { quality: qualityFrom(metrics) } : {}),
        bestMomentSec: shot.keyframeSec,
        ...(onScreenText ? { onScreenText, hasText: true } : {}),
        ...(ocrConf !== undefined ? { ocrConf } : {}),
        ...(framingFrom(metrics) ? { framing: framingFrom(metrics) } : {}),
        ...(transcriptText ? { transcriptText } : {}),
        ...(energyRms !== undefined ? { energyRms } : {}),
      };
    } catch (e) {
      // Absolute per-shot backstop: a minimal analysis, never throw.
      perShot[shot.id] = { ...base, sceneId: shot.id, notes: `shot analysis failed: ${e instanceof Error ? e.message : String(e)}` };
    }
  }
  if (ocrFailed) notes.push("on-screen-text OCR unavailable (Vision) — onScreenText degraded");
  return perShot;
}

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));
// Quality proxy: well-exposed (not crushed/blown) + some edge detail reads as a
// usable, in-focus frame. Mirrors analyzeClip's exposure-centred composite.
function qualityFrom(metrics: any): number {
  const bright = Number(metrics?.brightPct) || 0;
  const dark = Number(metrics?.darkPct) || 0;
  const edge = Number(metrics?.edgePct) || 0;
  const expo = clamp01(1 - (bright + dark) / 100); // penalize clipped highs/lows
  const detail = clamp01(edge / 8); // some edge = in focus
  return round2(clamp01(0.7 * expo + 0.3 * detail));
}

/* ── STAGE 5 · EDITORIAL SIGNALS ─────────────────────────────────────────────
   The judgments the footage-edit passes act on, all grounded in the transcript +
   diagnostics + per-shot energy:
     • FILLER / disfluency: filler words (um/uh/like…) in the transcript, plus
       LONG inter-word pauses (a stall the tighten pass can ripple out).
     • DEAD AIR: silences longer than DEAD_AIR_SEC (from videoDiagnostics.silence).
     • REDUNDANCY: near-duplicate segment pairs (token-overlap similarity ≥ thresh)
       — the supercut/tighten pass can collapse them.
     • HIGHLIGHTS: a composite score per shot from energy (RMS) + motion + whether
       it carries spoken content + on-screen text, top-N. These are the moments a
       montage/reel selector ranks.
   Each sub-stage is independently fail-open. */
function editorialStage(
  transcript: Transcript,
  diag: any,
  shots: Shot[],
  perShot: Record<string, ShotAnalysis>,
  durationSec: number,
  notes: string[],
): { filler: FillerHit[]; deadAir: Span[]; redundancy: RedundantPair[]; highlights: Highlight[] } {
  // FILLER words + LONG pauses.
  const filler: FillerHit[] = [];
  try {
    const ws = transcript.words;
    for (let i = 0; i < ws.length; i++) {
      const w = ws[i];
      if (FILLER_WORDS.has(clean(w.word))) filler.push({ atSec: round2(w.startSec), word: w.word.trim(), kind: "filler" });
      if (i > 0) {
        const gap = w.startSec - ws[i - 1].endSec;
        if (gap >= LONG_PAUSE_SEC) filler.push({ atSec: round2(ws[i - 1].endSec), word: `${round2(gap)}s pause`, kind: "long_pause" });
      }
    }
  } catch (e) {
    notes.push(`filler detection failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  // DEAD AIR from the silence diagnostics (spans > threshold), source seconds.
  const deadAir: Span[] = [];
  try {
    for (const s of diag?.silence ?? []) {
      const start = Number(s.start ?? s.silence_start);
      const end = Number(s.end ?? s.silence_end ?? durationSec);
      if (Number.isFinite(start) && Number.isFinite(end) && end - start >= DEAD_AIR_SEC) {
        deadAir.push({ startSec: round2(start), endSec: round2(end), reason: `${round2(end - start)}s silence` });
      }
    }
  } catch (e) {
    notes.push(`dead-air detection failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  // REDUNDANCY: compare every segment pair (O(n²) over LINES, not words — small)
  // via the same token-overlap textSimilarity the editor uses for OCR matching.
  const redundancy: RedundantPair[] = [];
  try {
    const segs = transcript.segments;
    for (let a = 0; a < segs.length; a++) {
      for (let b = a + 1; b < segs.length; b++) {
        const sim = textSimilarity(segs[a].text, segs[b].text);
        if (sim >= REDUNDANCY_SIM) redundancy.push({ aSeg: segs[a].index, bSeg: segs[b].index, similarity: round2(sim) });
      }
    }
  } catch (e) {
    notes.push(`redundancy detection failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  // HIGHLIGHTS: composite score per shot, top-N.
  const highlights: Highlight[] = [];
  try {
    const rmsVals = shots.map((s) => Number(perShot[s.id]?.energyRms)).filter((n) => Number.isFinite(n));
    const loudest = rmsVals.length ? Math.max(...rmsVals) : 0;
    const quietest = rmsVals.length ? Math.min(...rmsVals) : -60;
    const rmsRange = Math.max(1, loudest - quietest);
    const scored = shots.map((s) => {
      const a = perShot[s.id] ?? ({} as ShotAnalysis);
      const why: string[] = [];
      let score = 0;
      // energy (loud relative to the clip) — voiced/punchy moment
      if (Number.isFinite(Number(a.energyRms))) {
        const e = clamp01((Number(a.energyRms) - quietest) / rmsRange);
        score += 0.4 * e;
        if (e > 0.7) why.push("high energy");
      }
      // motion — visually eventful
      if (Number.isFinite(Number(a.motion))) {
        score += 0.3 * clamp01(Number(a.motion));
        if (Number(a.motion) > 0.5) why.push("high motion");
      }
      // spoken content present — likely a substantive line
      if (a.transcriptText) {
        score += 0.2;
        why.push("spoken line");
      }
      // on-screen text — a titled/emphasized moment
      if (a.onScreenText) {
        score += 0.1;
        why.push("on-screen text");
      }
      return { startSec: s.inSec, endSec: s.outSec, score: round2(score), why };
    });
    scored.sort((x, y) => y.score - x.score);
    for (const h of scored.slice(0, TOP_HIGHLIGHTS)) if (h.score > 0) highlights.push(h);
  } catch (e) {
    notes.push(`highlight scoring failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  return { filler, deadAir, redundancy, highlights };
}

/**
 * buildUnderstanding — run the full deep-understanding pipeline on an ingested
 * run, persist item.understanding, and return it. FAIL-OPEN at every stage: a
 * messy / no-audio / unreadable clip still yields a valid Understanding.
 */
export async function buildUnderstanding(
  id: string,
  opts?: { deep?: boolean; vocabulary?: string[]; glossary?: Array<{ from: string; to: string }> },
): Promise<Understanding> {
  const item = loadItem(id);
  const notes: string[] = [];

  // Resolve the video to understand. For an INGESTED item we MUST analyze the
  // original source, never item.videoPath — after an edit that field points at the
  // rendered (cut-down) reel, and re-understanding it would transcribe/measure the
  // short edit instead of the full footage (corrupting the index). Fall back to the
  // generic resolver only when there's no source on record (generated runs).
  const sourcePath = (item as any).kind === "ingested"
    ? ((item as any).source?.path as string | undefined) ?? ((item as any).source?.originalPath as string | undefined)
    : undefined;
  const video = (sourcePath && existsSync(sourcePath)) ? sourcePath : resolveVideoFile(item as any);
  if (!video) {
    warn(item, "understand", "no_video", "no source/rendered video found — understanding is minimal");
    const u = UnderstandingSchema.parse({ builtAt: nowIso(), durationSec: 0, transcript: { text: "", words: [], segments: [] }, notes: ["no video on disk"] });
    item.understanding = u;
    saveItem(item);
    return u;
  }

  // Duration + whether there's an audio stream (skip transcription if not).
  let durationSec = 0;
  let fps: number | undefined;
  let hasAudio = true;
  try {
    const meta = probeVideo(video);
    durationSec = round2(durationFromProbe(meta));
    const v = (meta?.streams ?? []).find((s: any) => s.codec_type === "video");
    const fpsRaw = String(v?.avg_frame_rate ?? v?.r_frame_rate ?? "");
    const [num, den] = fpsRaw.split("/").map(Number);
    if (Number.isFinite(num) && Number.isFinite(den) && den > 0) fps = round2(num / den);
    hasAudio = (meta?.streams ?? []).some((s: any) => s.codec_type === "audio");
  } catch (e) {
    warn(item, "understand", "probe_failed", "ffprobe failed — duration/fps unknown", e instanceof Error ? e.message : String(e));
  }
  // Prefer the recorded probe when present (N1's source.probe is authoritative).
  if (item.source?.probe) {
    if (!(durationSec > 0)) durationSec = round2(Number(item.source.probe.durationSec) || 0);
    if (fps == null && item.source.probe.video?.fps) fps = Number(item.source.probe.video.fps);
    if (typeof item.source.probe.hasAudio === "boolean") hasAudio = item.source.probe.hasAudio;
  }

  // ── 1 TRANSCRIBE ──
  // A caller-supplied vocabulary (proper nouns, brand/product names, the speaker's
  // name) biases Whisper's decoder and seeds a deterministic glossary correction so
  // names like "Ada Lovelace"/"CognitiveX" stop coming back as "Ada Lovejoy".
  const vocab = (opts?.vocabulary && opts.vocabulary.length) || (opts?.glossary && opts.glossary.length)
    ? { prompt: opts?.vocabulary?.length ? opts.vocabulary.join(", ") : undefined, glossary: opts?.glossary }
    : undefined;
  const transcript = transcribeStage(id, video, hasAudio, notes, vocab);

  // ── audio/video diagnostics (scene changes ∪ silence) — used by shots + signals ──
  let diag: any = { sceneChanges: [], silence: [] };
  try {
    diag = videoDiagnostics(`${id}_understand`, video);
  } catch (e) {
    notes.push(`diagnostics failed (shots/dead-air degraded): ${e instanceof Error ? e.message : String(e)}`);
  }

  // ── 3 SPEAKERS (before shots — shot fusion consumes speaker turns) ──
  const { speakers } = speakerStage(video, transcript, notes);

  // ── 2 SHOTS ──
  const shots = shotStage(diag, durationSec, speakers, notes);

  // ── 4 PER-SHOT MULTIMODAL ──
  const perShot = await perShotStage(video, shots, transcript, notes);

  // ── 5 EDITORIAL SIGNALS ──
  const { filler, deadAir, redundancy, highlights } = editorialStage(transcript, diag, shots, perShot, durationSec, notes);

  // Persist as item.understanding (parsed at the boundary). Fail-open: if the
  // assembled object somehow fails to parse, degrade to a minimal valid one.
  let understanding: Understanding;
  try {
    understanding = UnderstandingSchema.parse({
      builtAt: nowIso(),
      durationSec,
      ...(fps != null ? { fps } : {}),
      transcript,
      speakers,
      shots,
      perShot,
      highlights,
      deadAir,
      filler,
      redundancy,
      notes,
    });
  } catch (e) {
    warn(item, "understand", "parse_failed", "understanding assembly failed schema parse — saved minimal", e instanceof Error ? e.message : String(e));
    understanding = UnderstandingSchema.parse({ builtAt: nowIso(), durationSec, transcript: { text: transcript.text, words: [], segments: [] }, notes: [...notes, "assembly parse failed"] });
  }

  item.understanding = understanding;
  logLine(item, `understanding: ${shots.length} shot(s), ${speakers.length} speaker(s), ${transcript.segments.length} segment(s), ${highlights.length} highlight(s), ${deadAir.length} dead-air, ${filler.length} filler`);
  saveItem(item);

  // ── DEEP pass (opt-in, EXPENSIVE): make the index actually SEE + HEAR the video.
  //    Each stage loads+saves item.understanding itself and is fail-open, so a
  //    vision/music hiccup never loses the base index. Music first so the holistic
  //    summary can reference it. We reload + return the enriched index at the end. ──
  if (opts?.deep) {
    try {
      await analyzeMusic(id);
    } catch (e) {
      warn(item, "understand", "music_failed", "deep music pass failed — base index kept", e instanceof Error ? e.message : String(e));
    }
    try {
      await describeShots(id);
    } catch (e) {
      warn(item, "understand", "vision_failed", "deep vision pass failed — base index kept", e instanceof Error ? e.message : String(e));
    }
    try {
      await synthesizeVideoSummary(id);
    } catch (e) {
      warn(item, "understand", "summary_failed", "video summary synthesis failed", e instanceof Error ? e.message : String(e));
    }
    return loadItem(id).understanding ?? understanding;
  }

  return understanding;
}

/* ── understandingSummary — a compact, prompt-/Soli-readable digest ──────────
   The footage analogue of signalsSummary(): a few lines an editor pass or Soli
   can read to ground a decision ("cut the dead air" / "what's in this video?")
   without scrolling the whole index. Pure + synchronous. */
export function understandingSummary(u: Understanding): string {
  const lines: string[] = [];
  const dur = round2(u.durationSec);
  lines.push(`UNDERSTANDING — ${dur}s${u.fps ? ` @ ${u.fps}fps` : ""}, ${u.shots.length} shot(s), ${u.speakers.length} speaker(s)`);

  // The holistic "what this video IS" (deep pass) leads — it's the one line that
  // answers "what's in this video?" before the reader scans the detail.
  if (u.videoSummary) lines.push(`WHAT IT IS: ${u.videoSummary}`);

  // Transcript gist (first ~220 chars) + word/segment counts.
  if (u.transcript.text) {
    const gist = u.transcript.text.length > 220 ? `${u.transcript.text.slice(0, 220).trim()}…` : u.transcript.text;
    lines.push(`TRANSCRIPT (${u.transcript.words.length} words, ${u.transcript.segments.length} segments): "${gist}"`);
  } else {
    lines.push("TRANSCRIPT: (none — no audio or transcription unavailable)");
  }

  // Shots table (cap at 12 so the digest stays compact).
  if (u.shots.length) {
    const rows = u.shots.slice(0, 12).map((sh) => {
      const a = u.perShot[sh.id];
      const bits: string[] = [];
      if (a?.framing) bits.push(a.framing);
      if (a?.motion != null) bits.push(`mot ${round2(a.motion)}`);
      if (a?.energyRms != null) bits.push(`${round2(a.energyRms)}dB`);
      if (a?.onScreenText) bits.push(`text:"${a.onScreenText.slice(0, 28)}"`);
      const spk = sh.speaker ? ` ${u.speakers.find((s) => s.id === sh.speaker)?.label ?? sh.speaker}` : "";
      // The deep VISION description (what's actually in the shot) when present —
      // the difference between "tight, high-motion" and "a person unboxing a phone".
      const desc = a?.description ? ` — ${a.description.slice(0, 90)}` : "";
      return `  #${sh.index} ${sh.inSec}-${sh.outSec}s [${sh.source}${spk}]${bits.length ? " " + bits.join(" ") : ""}${desc}`;
    });
    lines.push("SHOTS:", ...rows);
    if (u.shots.length > 12) lines.push(`  … +${u.shots.length - 12} more`);
  }

  // Editorial signals — the actionable bits an edit pass reaches for.
  if (u.deadAir.length) lines.push(`DEAD AIR (${u.deadAir.length}): ${u.deadAir.slice(0, 4).map((s) => `${s.startSec}-${s.endSec}s`).join(", ")}${u.deadAir.length > 4 ? " …" : ""}`);
  if (u.filler.length) {
    const f = u.filler.filter((x) => x.kind === "filler").length;
    const p = u.filler.filter((x) => x.kind === "long_pause").length;
    lines.push(`FILLER: ${f} filler word(s), ${p} long pause(s)`);
  }
  if (u.redundancy.length) lines.push(`REDUNDANCY: ${u.redundancy.length} near-duplicate segment pair(s)`);
  if (u.highlights.length) {
    lines.push("HIGHLIGHTS:", ...u.highlights.slice(0, 5).map((h) => `  ${h.startSec}-${h.endSec}s (score ${h.score})${h.why.length ? " — " + h.why.join(", ") : ""}`));
  }

  // MUSIC (deep pass): the soundtrack model an edit can cut ON — tempo, beats,
  // where music vs speech sits, and the drops a hook should land on.
  if (u.music && (u.music.hasMusic || u.music.beats.length || u.music.sections.length)) {
    const m = u.music;
    const secBits = m.sections.slice(0, 6).map((s) => `${s.kind} ${Math.round(s.startSec)}-${Math.round(s.endSec)}s`).join(", ");
    lines.push(
      `MUSIC: ${m.hasMusic ? "present" : "none"}${m.tempoBpm ? ` ~${Math.round(m.tempoBpm)}bpm` : ""}, ${m.beats.length} beat(s)` +
        (m.drops.length ? `, drops @ ${m.drops.slice(0, 5).map((d) => `${round2(d)}s`).join(", ")}` : "") +
        (secBits ? `\n  sections: ${secBits}${m.sections.length > 6 ? " …" : ""}` : ""),
    );
  }

  // Caveats (heuristic speaker turns, no-audio, OCR-down…) so the reader doesn't
  // over-trust degraded fields.
  if (u.notes.length) lines.push(`NOTES: ${u.notes.slice(0, 4).join(" · ")}`);
  return lines.join("\n");
}
