/* understanding-music.ts — Pillar 5 (Ingest & Understand), DEEP MUSIC pass.
 *
 * `analyzeMusic(id)` is the OPT-IN, EXPENSIVE companion to buildUnderstanding:
 * where the fast path knows only silence/loudness/speech, this pass hears the
 * SOUNDTRACK — its beats, tempo, where it drops, and a music-vs-speech-vs-silence
 * map the editor can cut to. It loads the ingested item, fills
 * `item.understanding.music` (zod `MusicAnalysis`), saves, and returns it.
 *
 * REUSE-FIRST (CLAUDE.md): there is NO new audio plumbing here.
 *   • BEATS come from the PROVEN python beat tracker — the same
 *     `.venv-music python scripts/beat-times.py <audio>` that media.ts
 *     `musicBeatFrames` shells out to (VENV_PY / SCRIPTS pattern). musicBeatFrames
 *     rounds beats to FRAMES for motion-sync; we call beat-times.py directly to
 *     keep them in SECONDS (the schema stores seconds) and to read its `bpm`.
 *   • ENERGY comes from ffmpeg `volumedetect` mean_volume (dB) over a window —
 *     the EXACT probe editor-tools `perRegionRms` already uses, re-exported here.
 *   • SPEECH spans come from the Whisper transcript already on the item
 *     (`understanding.transcript.segments`); their complements are the candidate
 *     MUSIC/SILENCE windows we classify by energy. No librosa/aubio (not in venv).
 *
 * FAIL-OPEN, ALWAYS (CLAUDE.md hard rule — this must NEVER break ingest): every
 * probe is wrapped; a failed step leaves its field empty/false and pushes a note,
 * never throws. No beats → empty beats[] + a caveat note; no transcript → the
 * whole clip is treated as one unknown window and classified purely by energy.
 */

import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import {
  type MusicAnalysis,
  type AudioSection,
  type Understanding,
  MusicAnalysis as MusicAnalysisSchema,
  Understanding as UnderstandingSchema,
} from "@os/schemas";
import { loadItem, saveItem, logLine, nowIso, warn } from "./store.ts";
// REUSE the same source-video resolver + ffprobe duration the fast pass uses, and
// perRegionRms = the volumedetect mean-dB probe (one energy implementation).
import { resolveVideoFile, probeVideo, durationFromProbe, perRegionRms } from "./editor-tools.ts";

// Same venv/scripts wiring as media.ts (musicBeatFrames) and editor-tools.ts. The
// beat tracker lives in the music venv; absent → we fail open to no beats.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SCRIPTS = join(ROOT, "packages", "engine", "scripts");
const VENV_PY = join(ROOT, ".venv-music", "bin", "python");
const VISION_DIR = join(ROOT, "data", "agent-vision"); // scratch dir, shared with the evidence probes

// ── Tunables ────────────────────────────────────────────────────────────────
// volumedetect mean_volume is in dBFS (≤ 0). These floors are deliberately loose
// so messy real footage classifies sensibly rather than over-fitting.
const SILENCE_DB = -45; // a window quieter than this (mean) is "silence"
const MUSIC_DB = -38; // non-speech + louder than this = a real bed → "music"/"mixed"
const ENERGY_STEP_SEC = 0.5; // energyCurve / drop sampling stride
const DROP_JUMP_DB = 6; // a positive dB jump this big between adjacent windows = a drop/hit
const MIN_GAP_SEC = 0.25; // ignore sub-window slivers between speech spans

/* Attach `music` to the item's existing Understanding (the fast pass runs first;
   deep is opt-in ON TOP of it). If — defensively — no Understanding exists yet,
   build a minimal VALID one so the assignment stays a well-typed Understanding
   rather than a partial spread (which would drop required fields like builtAt). */
// NOTE: these beats/tempoBpm describe the SOURCE soundtrack. creative/beat-sync.ts
// prefers the ADDED instrumental bed's beats (musicBeatFrames(item.musicSrc)) for
// cut-sync and only falls back to these when no bed is set.
function attachMusic(item: any, music: MusicAnalysis): Understanding {
  const base: Understanding =
    item.understanding ??
    UnderstandingSchema.parse({ builtAt: nowIso(), durationSec: 0, transcript: { text: "", words: [], segments: [] }, notes: ["music pass ran before buildUnderstanding"] });
  return { ...base, music };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/* Extract the source AUDIO to a temp mono wav (beat-times.py re-decodes anyway,
   but a clean mono wav is the cheapest stable input and matches the toolchain
   everything else uses). Returns null on any ffmpeg failure (fail-open). */
function extractAudio(id: string, video: string): string | null {
  try {
    mkdirSync(VISION_DIR, { recursive: true });
    const out = join(VISION_DIR, `${id}_music_audio.wav`);
    const r = spawnSync(
      "ffmpeg",
      ["-y", "-i", video, "-vn", "-ac", "1", "-ar", "22050", out],
      { cwd: ROOT, encoding: "utf8" },
    );
    return r.status === 0 && existsSync(out) ? out : null;
  } catch {
    return null;
  }
}

/* BEATS — reuse the proven beat tracker (beat-times.py), but in SECONDS.
   media.ts musicBeatFrames rounds these to frames; we keep raw seconds + bpm.
   Fail-open: missing venv / non-zero exit / unparseable stdout → {beats:[]}. */
function trackBeats(audio: string): { beats: number[]; bpm?: number } {
  if (!existsSync(VENV_PY)) return { beats: [] };
  try {
    const r = spawnSync(VENV_PY, [join(SCRIPTS, "beat-times.py"), audio], { cwd: ROOT, encoding: "utf8", timeout: 60000 });
    if (r.status !== 0) return { beats: [] };
    const j = JSON.parse(r.stdout) as { bpm?: number; beats?: number[] };
    const beats = (j.beats ?? []).filter((n) => Number.isFinite(n)).map(round3);
    const bpm = Number.isFinite(j.bpm) && (j.bpm as number) > 0 ? round2(j.bpm as number) : undefined;
    return { beats, bpm };
  } catch {
    return { beats: [] };
  }
}

/* Mean energy (dBFS) over a window via the reused volumedetect probe. NaN when
   the probe fails or the window is too short — callers treat NaN as "unknown". */
function windowDb(video: string, startSec: number, endSec: number): number {
  try {
    const [r] = perRegionRms(video, [{ startSec, endSec }]);
    return Number.isFinite(r?.rms) ? (r!.rms as number) : NaN;
  } catch {
    return NaN;
  }
}

/* SPEECH spans from the Whisper transcript already on the item. Merge segments
   that touch/overlap so the complements are clean MUSIC/SILENCE candidate gaps. */
function speechSpans(transcript: any): { startSec: number; endSec: number }[] {
  const segs: { startSec: number; endSec: number }[] = (transcript?.segments ?? [])
    .map((s: any) => ({ startSec: Number(s.startSec), endSec: Number(s.endSec) }))
    .filter((s: { startSec: number; endSec: number }) => Number.isFinite(s.startSec) && Number.isFinite(s.endSec) && s.endSec > s.startSec)
    .sort((a: { startSec: number }, b: { startSec: number }) => a.startSec - b.startSec);
  const merged: { startSec: number; endSec: number }[] = [];
  for (const s of segs) {
    const last = merged[merged.length - 1];
    if (last && s.startSec <= last.endSec + 0.05) last.endSec = Math.max(last.endSec, s.endSec);
    else merged.push({ ...s });
  }
  return merged;
}

/* Build the music-vs-speech-vs-silence map. Each SPEECH span is a section whose
   kind is "speech" (clean) or "mixed" (a music bed plays UNDER the speech, judged
   by that span's own energy); each GAP between speech is classified purely by
   energy: loud → "music", quiet → "silence". */
function buildSections(
  video: string,
  durationSec: number,
  speech: { startSec: number; endSec: number }[],
): AudioSection[] {
  const sections: AudioSection[] = [];
  let cursor = 0;
  const pushGap = (a: number, b: number) => {
    if (b - a < MIN_GAP_SEC) return;
    const db = windowDb(video, a, b);
    let kind: AudioSection["kind"] = "silence";
    let note: string | undefined;
    if (!Number.isFinite(db)) {
      kind = "silence";
      note = "energy probe unavailable";
    } else if (db >= MUSIC_DB) {
      kind = "music";
    } else if (db <= SILENCE_DB) {
      kind = "silence";
    } else {
      // low-but-not-silent bed (e.g. faint ambience) — call it music, note the doubt
      kind = "music";
      note = "low-level bed";
    }
    sections.push({ startSec: round3(a), endSec: round3(b), kind, ...(note ? { note } : {}) });
  };

  for (const sp of speech) {
    if (sp.startSec > cursor) pushGap(cursor, sp.startSec);
    // speech span: is there an audible MUSIC BED under the voice? Speech alone
    // sits well above SILENCE_DB; a span LOUDER than the music floor implies a
    // bed reinforcing the voice → "mixed", else clean "speech".
    const db = windowDb(video, sp.startSec, sp.endSec);
    const kind: AudioSection["kind"] = Number.isFinite(db) && db >= MUSIC_DB ? "mixed" : "speech";
    sections.push({ startSec: round3(sp.startSec), endSec: round3(sp.endSec), kind });
    cursor = Math.max(cursor, sp.endSec);
  }
  if (durationSec > cursor) pushGap(cursor, durationSec);
  return sections;
}

/* Coarse loudness-over-time (energyCurve) + DROPS. We sample mean dB every
   ENERGY_STEP_SEC via the same volumedetect probe; a big positive dB jump between
   adjacent samples is a drop/hit (a section boundary an editor would cut on). */
function buildEnergyAndDrops(
  video: string,
  durationSec: number,
): { energyCurve: { atSec: number; energy: number }[]; drops: number[] } {
  const energyCurve: { atSec: number; energy: number }[] = [];
  const drops: number[] = [];
  if (!(durationSec > 0)) return { energyCurve, drops };
  // Cap the number of probes so a long clip can't make this pass pathological.
  const maxSamples = 600;
  const step = Math.max(ENERGY_STEP_SEC, durationSec / maxSamples);
  let prev: number | null = null;
  for (let t = 0; t < durationSec; t += step) {
    const end = Math.min(durationSec, t + step);
    const db = windowDb(video, t, end);
    if (!Number.isFinite(db)) {
      prev = null; // gap in measurement — don't read a spurious jump across it
      continue;
    }
    energyCurve.push({ atSec: round2(t), energy: round2(db) });
    if (prev != null && db - prev >= DROP_JUMP_DB) drops.push(round2(t));
    prev = db;
  }
  return { energyCurve, drops };
}

/* ── analyzeMusic — the deep MUSIC pass ──────────────────────────────────────
   OPT-IN (called only on the "deep" ingest path, never the fast path). Loads the
   ingested item, derives beats/tempo + the audio-section map + energyCurve/drops,
   saves item.understanding.music, and returns the MusicAnalysis. Fail-open at
   every step: a failed probe yields an empty field + a caveat note, never a throw,
   so a deep ingest can never be broken by the music pass. */
export async function analyzeMusic(id: string): Promise<MusicAnalysis> {
  const item = loadItem(id);
  const notes: string[] = [];

  const empty = (extra: string[] = []): MusicAnalysis =>
    MusicAnalysisSchema.parse({ hasMusic: false, notes: [...notes, ...extra] });

  // Source video → no video, nothing to hear.
  const video = resolveVideoFile(item as any);
  if (!video) {
    warn(item, "music", "no_video", "no source video — music analysis skipped");
    const u = empty(["no source video on disk"]);
    item.understanding = attachMusic(item, u);
    saveItem(item);
    return u;
  }

  // Duration (prefer the recorded ingest probe; fall back to ffprobe). Needed for
  // the trailing gap + the energy sampling bound.
  let durationSec = 0;
  try {
    durationSec = round2(durationFromProbe(probeVideo(video)));
  } catch {
    /* fall through to recorded probe */
  }
  if (!(durationSec > 0) && item.source?.probe?.durationSec) durationSec = round2(Number(item.source.probe.durationSec) || 0);
  if (!(durationSec > 0)) notes.push("duration unknown — sections/energy may be partial");

  // Extract audio once for the beat tracker. (Sections/energy probe the video
  // directly via perRegionRms, so a failed extraction only costs us beats.)
  const audio = extractAudio(id, video);

  // 1) BEATS + tempo (proven beat-times.py, kept in seconds).
  let beats: number[] = [];
  let tempoBpm: number | undefined;
  if (audio) {
    const tracked = trackBeats(audio);
    beats = tracked.beats;
    // Prefer the tracker's reported bpm; otherwise derive from the median beat
    // interval (robust to a few missed/extra beats).
    if (tracked.bpm != null) tempoBpm = tracked.bpm;
    else if (beats.length >= 2) {
      const intervals = beats.slice(1).map((b, i) => b - beats[i]).filter((d) => d > 0).sort((a, b) => a - b);
      const mid = intervals[Math.floor(intervals.length / 2)];
      if (mid && mid > 0) tempoBpm = round2(60 / mid);
    }
    if (!beats.length) notes.push("no beat tracker output (silent or no clear pulse)");
  } else {
    notes.push("audio extraction failed — no beats/tempo");
  }

  // 2) MUSIC-vs-SPEECH sections (speech from the Whisper transcript already on
  //    the item; gaps classified by energy).
  let sections: AudioSection[] = [];
  try {
    const speech = speechSpans(item.understanding?.transcript);
    if (!speech.length) notes.push("no transcript speech spans — classifying audio by energy only");
    sections = buildSections(video, durationSec || (beats.length ? beats[beats.length - 1] + 1 : 0), speech);
  } catch (e) {
    notes.push(`section classification failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  // 3) energyCurve + drops.
  let energyCurve: { atSec: number; energy: number }[] = [];
  let drops: number[] = [];
  try {
    const r = buildEnergyAndDrops(video, durationSec);
    energyCurve = r.energyCurve;
    drops = r.drops;
  } catch (e) {
    notes.push(`energy/drop sampling failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  // hasMusic: any section carrying an actual bed.
  const hasMusic = sections.some((s) => s.kind === "music" || s.kind === "mixed");
  if (sections.length && !hasMusic) notes.push("no music bed detected (speech/silence only)");
  if (audio) rmSync(audio, { force: true }); // scratch wav — don't leave it around

  // Persist (parsed at the boundary; fail-open to a minimal valid block).
  let music: MusicAnalysis;
  try {
    music = MusicAnalysisSchema.parse({ sections, beats, ...(tempoBpm != null ? { tempoBpm } : {}), drops, energyCurve, hasMusic, notes });
  } catch (e) {
    warn(item, "music", "parse_failed", "music analysis failed schema parse — saved minimal", e instanceof Error ? e.message : String(e));
    music = empty(["assembly parse failed"]);
  }

  item.understanding = attachMusic(item, music);
  logLine(item, `music: ${beats.length} beat(s)${tempoBpm ? ` @ ${tempoBpm}bpm` : ""}, ${sections.length} section(s), ${drops.length} drop(s), hasMusic=${hasMusic}`);
  saveItem(item);
  return music;
}
