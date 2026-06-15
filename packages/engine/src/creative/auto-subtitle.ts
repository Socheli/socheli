/**
 * auto-subtitle.ts — N4a: build an editable caption track from the transcript.
 *
 * Pillar 5 (Ingest & Understand) §7.1.5 N4a. Reads `item.understanding.transcript`
 * (word-level timestamps, SOURCE seconds) and groups the words into readable
 * caption LINES, each persisted as a `kind:"text"` Clip on a CAPTION track
 * (`track.name="captions"` per the §7.1.2(c) convention — NO new track-enum
 * member). Each caption clip carries `captionText` (the line) + `words[]`
 * ({word, fromSec, toSec} in SOURCE seconds) so a later milestone can map word
 * timing to karaoke WordCue FRAMES.
 *
 * It also flips `item.mix.subtitles.source = "track"` (+ a sensible default
 * preset) so the renderer knows to read this caption track instead of deriving
 * captions from a synthesized voice.
 *
 * IMPORTANT — render mapping is a LATER milestone. The sec→frame caption render
 * mapping (Caption seconds → karaoke WordCue frames, wired into compileTimeline
 * behind seededFrom="footage") is N4b/N6, NOT here. This function only produces
 * the editable caption track + sets subtitles.source — captions WON'T burn in
 * until N6.1 teaches the render path to read `subtitles.source==="track"`.
 *
 * Caption-grouping rule (readable lines): accumulate words into a line, and FLUSH
 * the line when ANY of:
 *   - the line reaches MAX_WORDS (default 7) words, OR
 *   - the current word ends a sentence (trailing . ! ? … : ;), OR
 *   - the GAP before the next word exceeds GAP_FLUSH_SEC (0.6s — a natural pause), OR
 *   - the line's on-screen duration would exceed MAX_LINE_SEC (4s — readability cap).
 * Each line's clip spans [first word.startSec, last word.endSec] on the timeline.
 *
 * FAIL-OPEN: no transcript / no words → no caption track (returns {captionClips:0})
 * with a warn(), never throws.
 */

import type { Clip, ContentItem, Mix, Track } from "@os/schemas";

import { loadItem, nowIso, saveItem, warn } from "../store.ts";

// Grouping knobs (tuned for vertical short-form readability).
const MAX_WORDS = 7;
const GAP_FLUSH_SEC = 0.6;
const MAX_LINE_SEC = 4;
// Sentence-final punctuation that forces a line break after the word.
const SENTENCE_END = /[.!?…:;]+["')\]]?$/;

const round2 = (n: number) => Math.round(n * 100) / 100;

type LineWord = { word: string; fromSec: number; toSec: number };

/**
 * Build a caption track from the transcript and set Mix.subtitles.source="track".
 * Returns the number of caption clips produced. Idempotent: a prior CAP1 caption
 * track is replaced (re-running re-groups from the same transcript).
 */
type SubPreset = "pop" | "bounce" | "phrase" | "hormozi" | "glow";

/* Pull a few high-signal ACCENT words from the transcript so a punchy preset can
 * pop them: proper nouns / brand terms (a capitalized word that ISN'T just a
 * sentence start) carry the most weight in a pitch ("CognitiveX", "ChatGPT", "YC").
 * De-duped, cleaned of punctuation, capped — fail-safe to []. */
function accentKeywords(words: { word: string }[]): string[] {
  const out = new Set<string>();
  for (let i = 0; i < words.length; i++) {
    const raw = (words[i]?.word ?? "").replace(/[^A-Za-z0-9]/g, "");
    if (raw.length < 3) continue;
    const prev = (words[i - 1]?.word ?? "").trim();
    const startsSentence = i === 0 || /[.!?]["')\]]?$/.test(prev);
    // A capitalized word mid-sentence ≈ a proper noun / brand; an ALL-CAPS token
    // (acronym like "YC", "AI") anywhere is high-signal too.
    if ((/^[A-Z][a-z0-9]+/.test(raw) && !startsSentence) || /^[A-Z0-9]{2,}$/.test(raw)) out.add(raw);
    if (out.size >= 8) break;
  }
  return [...out];
}

export function autoSubtitle(id: string, opts?: { preset?: SubPreset; keywords?: string[]; highlightColor?: string }): { captionClips: number } {
  const item = loadItem(id);

  const words = item.understanding?.transcript?.words ?? [];
  if (words.length === 0) {
    warn(item, "auto_subtitle", "no_transcript", "no word-level transcript on item.understanding — no caption track built");
    return { captionClips: 0 };
  }

  // ── Group words into readable caption lines. ──
  const lines: LineWord[][] = [];
  let cur: LineWord[] = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    cur.push({ word: w.word, fromSec: round2(w.startSec), toSec: round2(w.endSec) });

    const next = words[i + 1];
    const lineStart = cur[0].fromSec;
    const lineEnd = round2(w.endSec);
    const gapToNext = next ? next.startSec - w.endSec : Infinity;

    const flush =
      cur.length >= MAX_WORDS ||
      SENTENCE_END.test(w.word.trim()) ||
      gapToNext > GAP_FLUSH_SEC ||
      lineEnd - lineStart >= MAX_LINE_SEC ||
      !next; // always flush the final line
    if (flush) {
      lines.push(cur);
      cur = [];
    }
  }
  if (cur.length) lines.push(cur);

  // ── Materialize each line as a kind:"text" caption clip. ──
  const clips: Clip[] = lines.map((line, idx) => {
    const startSec = round2(line[0].fromSec);
    const endSec = round2(line[line.length - 1].toSec);
    return {
      id: `cap_${idx}`,
      kind: "text",
      inSec: 0, // captions don't cut a source asset; window is 0..duration
      startSec,
      durationSec: round2(Math.max(0, endSec - startSec)),
      speed: 1,
      enabled: true,
      captionText: line.map((w) => w.word).join(" ").replace(/\s+/g, " ").trim(),
      words: line,
    };
  });

  const captionTrack: Track = { id: "CAP1", kind: "text", name: "captions", clips };

  // ── Attach the caption track to the timeline (create a minimal one if absent,
  //    though N3a normally seeds it first). Replace any prior CAP1. ──
  const timeline = item.timeline ?? { tracks: [], markers: [] };
  timeline.tracks = (timeline.tracks ?? []).filter((t) => t.id !== "CAP1");
  timeline.tracks.push(captionTrack);
  item.timeline = timeline;

  // ── Tell the renderer to read the caption TRACK (not the synth-voice words).
  //    Keep any existing subtitle styling; default to a clean preset if unset. ──
  const subtitles: NonNullable<Mix["subtitles"]> = {
    ...(item.mix?.subtitles ?? {}),
    enabled: item.mix?.subtitles?.enabled ?? true,
    // KARAOKE (word-level): autoSubtitle always emits per-word timing, and the
    // render only routes `words` to the Karaoke engine when mode !== "lines".
    // "lines" would look for SubtitleCue[] (which we don't produce) → no captions.
    mode: "karaoke",
    // Style: caller's preset wins, else any existing, else "phrase". For social a
    // punchy preset (hormozi/glow) + accented brand keywords reads far better.
    preset: opts?.preset ?? item.mix?.subtitles?.preset ?? "phrase",
    keywords: opts?.keywords ?? (item.mix?.subtitles?.keywords?.length ? item.mix.subtitles.keywords : accentKeywords(words)),
    ...(opts?.highlightColor ? { highlightColor: opts.highlightColor } : item.mix?.subtitles?.highlightColor ? { highlightColor: item.mix.subtitles.highlightColor } : {}),
    source: "track",
  };
  const mix: ContentItem["mix"] = { ...(item.mix ?? {}), subtitles };
  item.mix = mix;

  item.updatedAt = nowIso();
  saveItem(item);

  return { captionClips: clips.length };
}
