/**
 * caption-style.ts — CAPTION STYLE CHOREOGRAPHY.
 *
 * The problem: a video whose subtitles wear ONE style top-to-bottom reads flat.
 * Hormozi/Odysser-grade captions CHANGE through the video — the hook lands big and
 * centered, stats slam in huge, key brand words pop in accent, connective lines sit
 * quiet at the bottom, and some lines tuck BEHIND the speaker. This director walks
 * the CAP1 caption track and assigns each line its own `captionStyle`
 * (preset/position/size/accent/depth), scored from the line's content + the
 * understanding (highlights, accent keywords) + its role (hook / body / CTA).
 *
 * It does NOT render anything — it only annotates the caption clips. The footage
 * compiler (render.ts) turns each styled clip into its own positioned Karaoke
 * overlay, and `depth:"behind"` lines composite under the subject matte when one
 * exists (else they fall back to front, never hidden over nothing).
 *
 * FAIL-OPEN: no caption track ⇒ no-op (returns {styled:0}); never throws.
 */

import type { CaptionStyle, ContentItem } from "@os/schemas";

import { loadItem, nowIso, saveItem } from "../store.ts";

type Look = { preset: NonNullable<CaptionStyle["preset"]>; position: NonNullable<CaptionStyle["position"]>; fontScale: number };

// The repertoire the director draws from. Each "look" is a coherent treatment;
// the scorer picks one per line so the sequence feels intentional, not random.
// READABILITY RULE: every FRONT look sits in the lower third — the safe zone that
// never overlaps a talking-head's face (dead-center "middle" was landing captions
// on the speaker's mouth). Variety comes from PRESET + SIZE + COLOUR, not vertical
// position. Only the rare behind-subject flourish rises to head height.
const LOOKS: Record<string, Look> = {
  HERO: { preset: "hormozi", position: "bottom", fontScale: 1.5 }, // the single biggest stat/line
  EMPHASIS: { preset: "hormozi", position: "bottom", fontScale: 1.26 }, // keyword/number lines
  HOOK: { preset: "glow", position: "bottom", fontScale: 1.3 }, // opening / questions
  CTA: { preset: "hormozi", position: "bottom", fontScale: 1.4 }, // the closing ask
  BASE: { preset: "hormozi", position: "bottom", fontScale: 1.0 }, // ordinary lines (School A clean)
  SOFT: { preset: "phrase", position: "bottom", fontScale: 0.96 }, // quiet/connective (behind-subject candidates)
};

/** Auto-detect accent words (proper nouns / acronyms) from a word stream — a
 *  capitalized token mid-sentence or any ALL-CAPS token. Capped + de-duped. */
function autoAccentWords(words: { word: string }[]): string[] {
  const out = new Set<string>();
  for (let i = 0; i < words.length && out.size < 10; i++) {
    const raw = (words[i]?.word ?? "").replace(/[^A-Za-z0-9]/g, "");
    if (raw.length < 3) continue;
    const prev = (words[i - 1]?.word ?? "").trim();
    const startsSentence = i === 0 || /[.!?]["')\]]?$/.test(prev);
    if ((/^[A-Z][a-z0-9]+/.test(raw) && !startsSentence) || /^[A-Z0-9]{2,}$/.test(raw)) out.add(raw);
  }
  return [...out];
}

const STAT_RE = /(\d|\bmillion\b|\bbillion\b|\bthousand\b|\bpercent\b|%|\bx\b|\b10x\b|\b100\b)/i;
const QUESTION_RE = /\?\s*$/;
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/* ── SHARED emphasis heuristics (ONE source of truth — Conflict C in the build
   roadmap). Captions, punch-ins, keyword-b-roll and the pacing governor all need
   "which word carries the meaning"; they import THESE instead of re-deriving a
   slightly-different stopword set each, so the gold caption word, the punch-in word,
   and the b-roll trigger all agree. */
export const STOPWORDS: Set<string> = new Set([
  "the", "a", "an", "to", "of", "and", "is", "it", "in", "on", "for", "you", "your",
  "i", "we", "that", "this", "so", "but", "with", "as", "at", "or", "if", "be", "are",
  "was", "were", "im", "ive", "its", "my", "me", "they", "them", "he", "she", "do",
  "does", "did", "have", "has", "had", "will", "just", "not", "no", "yes", "all", "can",
]);

/** Normalize a token for matching: lowercase, strip non-alphanumerics. */
export const normWord = (w: string): string => (w ?? "").toLowerCase().replace(/[^a-z0-9]+/gi, "");

/** Per-WORD emphasis score — how much this word "carries" its phrase. Numbers/percents
 *  win big, longer content words beat short ones, stopwords score 0. `inHighlight`
 *  (the word sits in a highlighted span) adds weight. The single highest-scoring word
 *  in a phrase is the one to gold / zoom on / cut b-roll to. */
export function emphasisScore(word: string, opts?: { inHighlight?: boolean }): number {
  const n = normWord(word);
  if (!n || STOPWORDS.has(n)) return 0;
  let s = n.length; // longer content words read as more meaningful
  if (/\d|%/.test(word)) s += 6; // a number/percent is almost always the point
  if (/^[A-Z][a-z]/.test(word.trim())) s += 1.5; // proper-noun-ish (mid-sentence cap)
  if (opts?.inHighlight) s += 3;
  return s;
}

/** Pick the index of the ONE emphasis word in a phrase (keyword set wins, else the
 *  highest emphasisScore). Returns -1 if nothing qualifies (all stopwords). */
export function pickEmphasisWord(words: { word: string }[], keywords?: Set<string>): number {
  let bestI = -1, bestKw = -1, best = -1;
  for (let i = 0; i < words.length; i++) {
    const n = normWord(words[i]?.word ?? "");
    if (keywords && keywords.size && keywords.has(n) && bestKw < 0) bestKw = i; // first keyword hit wins
    const sc = emphasisScore(words[i]?.word ?? "");
    if (sc > best) { best = sc; bestI = i; }
  }
  return bestKw >= 0 ? bestKw : bestI;
}

/** Score one caption line's importance (0..1) from its content + context. */
function emphasisOf(text: string, inHighlight: boolean, keywordHit: boolean): number {
  let s = 0;
  if (STAT_RE.test(text)) s += 0.42;
  if (keywordHit) s += 0.34;
  if (inHighlight) s += 0.3;
  if (QUESTION_RE.test(text)) s += 0.22;
  const wc = text.trim().split(/\s+/).length;
  if (wc <= 3) s += 0.16; // short punchy lines hit harder
  return Math.min(1, s);
}

/**
 * Assign each CAP1 caption clip a `captionStyle`. Returns how many were styled.
 * `behindEvery` (default 4): of the low-emphasis body lines, tuck every Nth one
 * behind the subject for the Odysser depth effect (render gates on a real matte).
 */
export function styleCaptions(
  id: string,
  opts?: { behindEvery?: number; accent?: string; behind?: boolean; school?: "clean" | "springy" },
): { styled: number; looks: Record<string, number> } {
  const item = loadItem(id);
  const cap = item.timeline?.tracks.find((t) => t.id === "CAP1" || (t.kind === "text" && t.name === "captions"));
  const clips = cap?.clips ?? [];
  if (!clips.length) return { styled: 0, looks: {} };

  const accent = opts?.accent ?? (item as { brandAccent?: string }).brandAccent ?? item.mix?.subtitles?.highlightColor;
  // Behind-subject captions are OFF by default: they're a high-risk flourish (a line
  // tucked behind a centred head can lose its middle words). Opt in with behindEvery>0
  // (or behind:true); when on, only short lines qualify and they go big + outlined so
  // they stay readable. Default output is the clean, fully-readable lower-third set.
  const behindEvery = Math.max(0, opts?.behindEvery ?? (opts?.behind === true ? 5 : 0));
  const keywords = new Set((item.mix?.subtitles?.keywords ?? []).map(norm).filter(Boolean));
  const highlights = (item.understanding?.highlights ?? []) as { startSec: number; endSec: number }[];
  const inHighlight = (startSec: number, endSec: number) =>
    highlights.some((h) => Math.min(endSec, h.endSec) - Math.max(startSec, h.startSec) > 0.01);

  // First pass: emphasis per line + locate the single strongest (→ HERO).
  const n = clips.length;
  const scored = clips.map((c, i) => {
    const text = c.captionText ?? (c.words ?? []).map((w) => w.word).join(" ");
    const start = c.startSec;
    const end = c.startSec + c.durationSec;
    const keywordHit = (c.words ?? []).some((w) => keywords.has(norm(w.word))) || text.split(/\s+/).some((w) => keywords.has(norm(w)));
    return { i, text, emphasis: emphasisOf(text, inHighlight(start, end), keywordHit), keywordHit };
  });
  const heroIdx = scored.reduce((best, s) => (s.emphasis > scored[best].emphasis ? s.i : best), 0);

  const looksUsed: Record<string, number> = {};
  let bodyLowCount = 0;

  clips.forEach((clip, i) => {
    const sc = scored[i];
    const isHook = i <= Math.min(1, n - 1); // first 1-2 lines
    const isCta = i >= n - 1; // final line (the ask)
    const isStrongHero = i === heroIdx && sc.emphasis >= 0.5;

    let lookName: keyof typeof LOOKS;
    if (isStrongHero) lookName = "HERO";
    else if (isCta) lookName = "CTA";
    else if (isHook) lookName = "HOOK";
    else if (sc.emphasis >= 0.34) lookName = "EMPHASIS";
    else if (sc.emphasis <= 0.12) lookName = "SOFT";
    else lookName = "BASE";

    const look = { ...LOOKS[lookName] };

    // Depth: the behind-subject "tuck" is a RARE flourish, not a constant. It only
    // reads when the line is SHORT (≤3 words) — a long line loses its middle words
    // behind the head and becomes unreadable, which is exactly the bug we're fixing.
    // So: only short, quiet, non-keyword body lines, on the `behindEvery` cadence.
    const wordCount = (clip.words ?? sc.text.split(/\s+/)).length;
    let depth: NonNullable<CaptionStyle["depth"]> = "front";
    if (
      behindEvery > 0 &&
      (lookName === "SOFT" || lookName === "BASE") &&
      !sc.keywordHit &&
      wordCount <= 3 &&
      !isHook && !isCta
    ) {
      bodyLowCount += 1;
      if (bodyLowCount % behindEvery === 0) depth = "behind";
    }
    // A behind line rises to head height (so the narrow head — not the wide torso —
    // is what occludes it) and goes BIG + bold so the outlined words read clearly on
    // either side of the speaker. The heavy stroke (render side) keeps edges legible.
    if (depth === "behind") { look.position = "middle"; look.preset = "hormozi"; look.fontScale = Math.max(look.fontScale, 1.35); }

    const style: CaptionStyle = {
      preset: coerceSchool(look.preset, opts?.school),
      position: look.position,
      fontScale: look.fontScale,
      depth,
      emphasis: Math.round(sc.emphasis * 100) / 100,
      // School A's signature is the GOLD emphasis word — don't override it with the
      // brand accent (often low-contrast vs the footage). Only stamp the brand accent
      // on emphasis lines when NOT pinned to the clean school.
      ...(accent && opts?.school !== "clean" && (lookName === "EMPHASIS" || lookName === "HERO" || lookName === "CTA") ? { highlightColor: accent } : {}),
    };
    clip.captionStyle = style;
    looksUsed[lookName] = (looksUsed[lookName] ?? 0) + 1;
  });

  // When a school is pinned, set the GLOBAL caption highlight to that school's accent
  // (gold #f7c204 for clean / #FFD93D for springy) so the base subtitle settings don't
  // carry a stale brand colour that would override the school's signature emphasis hue.
  if (opts?.school && item.mix?.subtitles) {
    item.mix = { ...item.mix, subtitles: { ...item.mix.subtitles, highlightColor: opts.school === "clean" ? "#f7c204" : "#FFD93D" } };
  }

  item.updatedAt = nowIso();
  saveItem(item as ContentItem);
  return { styled: clips.length, looks: looksUsed };
}

/** Force a preset into one caption SCHOOL when the caller pins it. clean = School A
 *  (hormozi/phrase/clean → Anton caps); springy = School B (pop/glow → Montserrat). */
function coerceSchool(preset: NonNullable<CaptionStyle["preset"]>, school?: "clean" | "springy"): NonNullable<CaptionStyle["preset"]> {
  if (!school) return preset;
  const cleanSet = new Set(["hormozi", "phrase", "clean"]);
  if (school === "clean") return cleanSet.has(preset) ? preset : preset === "glow" ? "clean" : "hormozi";
  return cleanSet.has(preset) ? (preset === "phrase" ? "glow" : "pop") : preset;
}

/** Pick a look name from a line's emphasis + role (shared by both choreographers). */
function pickLook(emphasis: number, isHook: boolean, isCta: boolean, isHero: boolean): keyof typeof LOOKS {
  if (isHero) return "HERO";
  if (isCta) return "CTA";
  if (isHook) return "HOOK";
  if (emphasis >= 0.34) return "EMPHASIS";
  if (emphasis <= 0.12) return "SOFT";
  return "BASE";
}

/** A choreographed style span for one caption GROUP, in FRAMES (what the Karaoke
 *  `lineStyles` prop consumes). The generation path produces these directly from the
 *  voice word-cues — no caption track needed — so a GENERATED post gets the same
 *  varied-subtitle choreography as an ingested edit. */
export type CaptionLineStyleSpan = {
  fromF: number;
  toF: number;
  preset: NonNullable<CaptionStyle["preset"]>;
  position: NonNullable<CaptionStyle["position"]>;
  fontScale: number;
  highlightColor?: string;
};

/** Choreograph a WordCue stream (word + frame window) into per-group style spans —
 *  the generation-path twin of styleCaptions. Groups words into short caption lines
 *  (same rule as the renderer), scores each, and assigns the LOOKS rubric. `accent`
 *  colours the emphasis/hero/cta lines; `keywords` mark brand/jargon hits. */
export function choreographWordCues(
  words: { word: string; fromF: number; toF: number }[],
  opts?: { keywords?: string[]; accent?: string; maxWords?: number },
): CaptionLineStyleSpan[] {
  if (!words || !words.length) return [];
  const maxWords = Math.max(1, Math.min(8, opts?.maxWords ?? 4));
  // Keywords default to AUTO-detected proper nouns / acronyms (a capitalized word
  // mid-sentence, or an ALL-CAPS token) so a generated post emphasizes brand/jargon
  // without the caller having to supply a list.
  const autoKeys = opts?.keywords?.length ? opts.keywords : autoAccentWords(words);
  const keys = new Set(autoKeys.map(norm).filter(Boolean));
  // group exactly like the renderer's buildGroups (maxWords or sentence punctuation).
  const groups: { word: string; fromF: number; toF: number }[][] = [];
  let cur: { word: string; fromF: number; toF: number }[] = [];
  for (const w of words) {
    cur.push(w);
    if (cur.length >= maxWords || /[.!?,:]$/.test(w.word)) { groups.push(cur); cur = []; }
  }
  if (cur.length) groups.push(cur);
  if (!groups.length) return [];

  const scored = groups.map((g) => {
    const text = g.map((w) => w.word).join(" ");
    const keywordHit = g.some((w) => keys.has(norm(w.word)));
    return { text, keywordHit, emphasis: emphasisOf(text, false, keywordHit) };
  });
  const heroIdx = scored.reduce((b, s, i) => (s.emphasis > scored[b].emphasis ? i : b), 0);
  const n = groups.length;

  let prevKey = "";
  return groups.map((g, i) => {
    const sc = scored[i];
    const look = { ...LOOKS[pickLook(sc.emphasis, i <= Math.min(1, n - 1), i >= n - 1, i === heroIdx && sc.emphasis >= 0.5)] };
    const key = `${look.preset}:${look.position}`;
    if (key === prevKey && look.preset !== "hormozi") look.position = look.position === "bottom" ? "middle" : "bottom";
    prevKey = `${look.preset}:${look.position}`;
    const strong = look.fontScale >= 1.28;
    return {
      fromF: g[0].fromF,
      toF: g[g.length - 1].toF + 6,
      preset: look.preset,
      position: look.position,
      fontScale: look.fontScale,
      ...(opts?.accent && strong ? { highlightColor: opts.accent } : {}),
    };
  });
}
