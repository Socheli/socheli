import React, { useMemo } from "react";
import { AbsoluteFill, Sequence, useCurrentFrame, useVideoConfig, Audio, Img, OffthreadVideo, staticFile, interpolate, Easing, spring } from "remotion";
// M0: <TransitionSeries> was removed (it re-mounts each scene ~16× under React
// 19.2.3 + Remotion 4.0.461 → stacked/black device_mockup/diagram). Transitions
// are now reproduced by the manual crossfade sequencer below, so none of the
// @remotion/transitions presentations/timings are imported anymore.
import type { Storyboard } from "@os/schemas";
import { RULES } from "@os/schemas";
import { getTheme, getMood, brollFilter, resolveStudio, type ResolvedStudio, type as typePresets, primitive } from "@os/tokens";
import { CinematicBackground } from "./lib/effects.tsx";
import { ColorGrade, FilmGrain, LightLeak, ChromaDefs, gateWeave, GradePipeline, gradeToFilterId } from "./lib/grade.tsx";
import { SceneRenderer } from "./scenes.tsx";
import { resolveKeyframes, type KfValues } from "./lib/keyframes.ts";
import { getMoodDisplayFont, getMoodMonoFont, captionFontFor } from "./lib/fonts.ts";
// M13 (§4.4): post-scope effect-node graph. An ABSENT/empty storyboard.comp makes
// CompositeGraph render its children verbatim (identity), so the default look is
// byte-identical to today — see the wiring note at the visual-stack wrap below.
import { CompositeGraph } from "./CompositeGraph.tsx";

export type SubtitleCue = { fromF: number; toF: number; lines: string[] };
export type WordCue = { word: string; fromF: number; toF: number };
export type BrollAsset = { src: string; type: "video" | "image" };
export type SfxCue = { src: string; atF: number; vol?: number };
// M8: a keyframed automation curve (mirrors @os/schemas AutoCurve). `t∈0..1` over
// the span it scopes; `v` is the gain multiplier (or pan position) at that point.
export type AutoEase = "linear" | "easeIn" | "easeOut" | "easeInOut" | "hold";
export type AutoCurve = { points: { t: number; v: number }[]; easing?: AutoEase };
// M8: a per-clip automation region — a gain/pan curve scoped to one track id over
// a [startSec, startSec+durSec) window. Lives in Mix.clips[]; the renderer applies
// its gain in-frame (pan is baked by the ffmpeg pass — see TODO in evalAutomation).
export type AudioClip = { trackId: string; startSec: number; durSec?: number; gain?: AutoCurve; pan?: AutoCurve };
// M8: AudioTrack += an optional keyframed `gain` curve (per-track gain automation)
// over the whole track timeline. EQ/comp/de-ess/gate/denoise/pan are pre-baked by
// the ffmpeg filtergraph (media.ts) before the file reaches <Audio>, so the only
// schema axis the renderer evaluates in-frame is gain (and, where stereo, pan).
export type AudioTrack = { id: string; name?: string; vol?: number; mute?: boolean; disabled?: boolean; speed?: number; pan?: number; fadeIn?: number; fadeOut?: number; splits?: number[]; gain?: AutoCurve };
export type SubtitleSettings = {
  enabled?: boolean;
  mode?: "karaoke" | "lines";
  preset?: "pop" | "bounce" | "phrase" | "hormozi" | "glow" | "clean" | "springy";
  position?: "bottom" | "middle" | "top";
  fontScale?: number;
  letterSpacing?: number;
  lineHeight?: number;
  background?: boolean;
  backgroundOpacity?: number;
  highlightColor?: string;
  inactiveOpacity?: number;
  maxWords?: number;
  keywords?: string[];
};
export type Mix = {
  musicVol?: number; // multiplier on base music level (1 = default)
  voiceVol?: number;
  sfxVol?: number;
  beatIntensity?: number; // 0..2, scales the emphasis beat reaction
  muteMusic?: boolean;
  muteVoice?: boolean;
  muteSfx?: boolean;
  captionStyle?: "pop" | "bounce" | "phrase" | "hormozi" | "glow" | "clean" | "springy";
  subtitles?: SubtitleSettings;
  tracks?: AudioTrack[];
  duck?: DuckSettings;
  clips?: AudioClip[];          // M8: per-clip gain/pan automation regions
  loudnessTarget?: number;       // M7/M9: integrated LUFS master target (ffmpeg)
};
export type DuckSettings = {
  enabled?: boolean;
  amount?: number; // 0..1: how far to reduce music under voice (0.6 = down to 40%)
  attack?: number; // seconds to ramp music down at the start of a voiced span
  release?: number; // seconds to ramp music back up after a voiced span
};
export type PostProps = {
  storyboard: Storyboard;
  subtitles?: SubtitleCue[];
  words?: WordCue[];
  // Caption choreography: per-line style spans so the captions don't wear one static
  // look across the whole video (hook glow → stat hormozi → quiet phrase).
  captionLineStyles?: CaptionLineStyle[];
  brolls?: (BrollAsset | null)[];
  beatFrames?: number[];
  sfx?: SfxCue[];
  mix?: Mix;
  musicSrc?: string;
  voiceSrc?: string;
  channelLabel?: string;
  channelLogo?: string;
  channelHandle?: string;
  channelSite?: string;
  channelSocials?: string[];
  mood?: string;
  brandAccent?: string; // brand signature colour; overrides theme/mood accent
  // Long-form chapter mode: suppress the per-chapter outro card / intro sting so
  // concatenated chapters only get ONE outro (last chapter) and ONE intro (first).
  noOutro?: boolean;
  noIntro?: boolean;
};

const TR = RULES.transitionFrames;
export const OUTRO_F = 100; // ~3.3s branded end card

/* C6: per-transition duration — scene.style.transitionDuration (seconds) → frames at fps,
   clamped to the schema's 0.1..1.5s range; falls back to the global TR when unset. */
const transitionFramesFor = (scene: any, fps: number): number => {
  const sec = scene?.style?.transitionDuration;
  if (typeof sec === "number" && Number.isFinite(sec)) {
    return Math.max(1, Math.round(clamp(sec, 0.1, 1.5) * fps));
  }
  return TR;
};
/* C6: scene.style.transitionEase maps to an easing applied to the manual entry
   crossfade (linear / easeIn / easeOut / easeInOut). Unset → easeOut, which best
   approximates the previous springTiming feel without the @remotion/transitions
   spring machinery. */
const transitionEasings: Record<string, (input: number) => number> = {
  linear: Easing.linear,
  easeIn: Easing.in(Easing.cubic),
  easeOut: Easing.out(Easing.cubic),
  easeInOut: Easing.inOut(Easing.cubic),
};
const transitionEaseFor = (scene: any): ((input: number) => number) => {
  const ease = scene?.style?.transitionEase as string | undefined;
  return (ease && transitionEasings[ease]) || Easing.out(Easing.cubic);
};

/* Decaying impulse since the last beat drives subtle beat-synced motion. */
function beatPulse(frame: number, beats: number[] | undefined): number {
  if (!beats || !beats.length) return 0;
  let last = -1;
  for (const b of beats) {
    if (b <= frame) last = b;
    else break;
  }
  if (last < 0) return 0;
  return Math.exp(-(frame - last) / 3.5);
}

// C11: hidden scenes (scene.hidden === true) are dropped from the render entirely —
// they neither draw nor consume time. Unset/false keeps a scene visible as before.
const visibleScenes = (sb: Storyboard) => sb.scenes.filter((s) => !(s as any).hidden);

export const totalFrames = (sb: Storyboard, fps: number) => {
  // C6: each scene's entry transition can have its own duration; the sequence is
  // shortened by every transition's frames (the overlap), not a flat TR each.
  // C11: only visible scenes count toward the timeline length.
  const scenes = visibleScenes(sb);
  const trFs = scenes.map((s) => transitionFramesFor(s, fps));
  const durs = scenes.map((s, i) => Math.max(2 * trFs[i] + 4, Math.round(s.durationSec * fps)));
  // sum of all transition overlaps between scenes + the outro's own transition in
  const sceneOverlap = trFs.slice(1).reduce((a, t) => a + t, 0);
  const outroTr = scenes.length ? trFs[trFs.length - 1] : TR;
  // scenes (with crossfade overlaps) + the appended outro card (also transitions in)
  return durs.reduce((a, d) => a + d, 0) - sceneOverlap + (OUTRO_F - outroTr);
};

const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));
const num = (v: unknown, fallback: number) => (typeof v === "number" && Number.isFinite(v) ? v : fallback);
const trackFor = (mix: Mix | undefined, id: string): AudioTrack => mix?.tracks?.find((t) => t.id === id) ?? { id };
const trackMuted = (mix: Mix | undefined, id: string, legacyMute?: boolean) => !!legacyMute || !!trackFor(mix, id).mute || !!trackFor(mix, id).disabled;
const trackSpeed = (mix: Mix | undefined, id: string) => clamp(num(trackFor(mix, id).speed, 1), 0.25, 4);
const trackVolume = (mix: Mix | undefined, id: string, legacyVol: number) => legacyVol * clamp(num(trackFor(mix, id).vol, 1), 0, 3);
const fadeVolume = (frame: number, durationInFrames: number, fps: number, track: AudioTrack, base: number) => {
  const fadeInF = Math.max(0, num(track.fadeIn, 0) * fps);
  const fadeOutF = Math.max(0, num(track.fadeOut, 0) * fps);
  const inMul = fadeInF > 0 ? interpolate(frame, [0, fadeInF], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }) : 1;
  const outMul = fadeOutF > 0 ? interpolate(frame, [durationInFrames - fadeOutF, durationInFrames], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }) : 1;
  return base * inMul * outMul;
};

/* M8: AutoCurve evaluation — interpolate a keyframed gain curve over a normalized
   0→1 timeline. Same easing/interp family as resolveKeyframes (lib/keyframes.ts),
   but the schema carries ONE `easing` for the whole curve (not per-point). A curve
   with a single point holds that value; an empty/absent curve is handled by the
   callers (they never call this when there's no curve). */
const autoEase = (e?: AutoEase) => {
  switch (e) {
    case "linear": return Easing.linear;
    case "easeIn": return Easing.in(Easing.cubic);
    case "easeOut": return Easing.out(Easing.cubic);
    case "hold": return Easing.linear; // handled as a step below, never as interp
    case "easeInOut":
    default: return Easing.inOut(Easing.cubic);
  }
};
const evalAutoCurve = (curve: AutoCurve | undefined, tNorm: number): number | null => {
  const pts = [...(curve?.points ?? [])].filter((p) => typeof p?.v === "number" && typeof p?.t === "number").sort((a, b) => a.t - b.t);
  if (!pts.length) return null;
  const t = clamp(tNorm, 0, 1);
  if (t <= pts[0].t) return pts[0].v;
  if (t >= pts[pts.length - 1].t) return pts[pts.length - 1].v;
  const hold = curve?.easing === "hold";
  const ease = autoEase(curve?.easing);
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    if (t >= a.t && t <= b.t) {
      return hold ? a.v : interpolate(t, [a.t, b.t], [a.v, b.v], { easing: ease, extrapolateLeft: "clamp", extrapolateRight: "clamp" });
    }
  }
  return pts[pts.length - 1].v;
};

/* M8: evalAutomation — the per-track volume engine that REPLACES fadeVolume in the
   <Audio>/<OffthreadVideo> callbacks. It returns:

       fadeVolume(frame, durF, fps, track, base)            // today's value
         × (track.gain ? evalAutoCurve(track.gain, frame/durF) : 1)   // per-TRACK gain
         × Π over mix.clips matching this track:                       // per-CLIP gain
             clip.gain ? evalAutoCurve(clip.gain, (frame−startF)/clipDurF) : 1   inside its window, else 1

   NON-BREAKING CONTRACT: when the track has no `gain` curve AND no mix clip targets
   this track id, BOTH extra multipliers are exactly 1, so evalAutomation returns
   the IDENTICAL value fadeVolume returned before — byte-for-byte, no new math runs.

   Pan: AutoCurve pan is applied by the ffmpeg pre-bake pass (media.ts), not here —
   Remotion's <Audio> exposes only a scalar volume, no stereo balance callback. The
   in-render path is gain-only; pan automation rides on the baked file. (TODO: if a
   future Remotion exposes per-channel volume, evaluate clip.pan/track.panAuto here.) */
const evalAutomation = (
  frame: number,
  durationInFrames: number,
  fps: number,
  track: AudioTrack,
  base: number,
  mixClips?: AudioClip[],
): number => {
  let v = fadeVolume(frame, durationInFrames, fps, track, base);
  // Per-track gain automation (over the track's full timeline).
  if (track.gain && (track.gain.points?.length ?? 0) > 0) {
    const g = evalAutoCurve(track.gain, durationInFrames > 0 ? frame / durationInFrames : 0);
    if (g != null) v *= clamp(g, 0, 4);
  }
  // Per-clip gain automation — each clip is a [startF, startF+clipDurF) window on
  // this track. Outside the window the clip contributes nothing (multiplier 1).
  if (mixClips && mixClips.length) {
    for (const c of mixClips) {
      if (c.trackId !== track.id || !c.gain) continue;
      const startF = Math.max(0, num(c.startSec, 0) * fps);
      // Window length: explicit durSec, else the curve's last point relative to the
      // remaining track length, else the rest of the track. Always ≥ 1 frame.
      const clipDurF = c.durSec != null ? Math.max(1, num(c.durSec, 0) * fps) : Math.max(1, durationInFrames - startF);
      if (frame < startF || frame > startF + clipDurF) continue;
      const g = evalAutoCurve(c.gain, clipDurF > 0 ? (frame - startF) / clipDurF : 0);
      if (g != null) v *= clamp(g, 0, 4);
    }
  }
  return v;
};

/* Dynamic music arc: softer intro, swell into the climax (~70%), gentle settle —
   so the score breathes with the story instead of sitting at one flat level. */
const musicArc = (frame: number, dur: number) =>
  // peak capped at 1.0 so the swell never rises ABOVE the ducked baseline level
  // (the bed breathes in the gaps, but never climbs over the narration).
  interpolate(frame, [0, dur * 0.12, dur * 0.68, dur * 0.9, dur], [0.78, 0.92, 1.0, 0.94, 0.86], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });

/* C4: auto-duck — build voiced spans, then a per-frame music multiplier that ramps
   down (attack) at the start of each voiced span and back up (release) after it.
   Spans come from word cues when present, else a single span over the whole voiced
   region; merged so overlapping/touching cues don't re-trigger the ramp. */
type Span = { fromF: number; toF: number };
const mergeSpans = (spans: Span[], gapF: number): Span[] => {
  const sorted = [...spans].filter((s) => s.toF > s.fromF).sort((a, b) => a.fromF - b.fromF);
  const out: Span[] = [];
  for (const s of sorted) {
    const last = out[out.length - 1];
    if (last && s.fromF - last.toF <= gapF) last.toF = Math.max(last.toF, s.toF);
    else out.push({ ...s });
  }
  return out;
};
const buildDuckEnvelope = (words: WordCue[] | undefined, duck: DuckSettings, fps: number, totalF: number) => {
  const amount = clamp(num(duck.amount, 0.6), 0, 1);
  const floor = 1 - amount; // music level while fully under voice
  const attackF = Math.max(1, num(duck.attack, 0.12) * fps);
  const releaseF = Math.max(1, num(duck.release, 0.35) * fps);
  // gap shorter than attack+release shouldn't bother popping back up
  const spans = mergeSpans(
    words && words.length ? words.map((w) => ({ fromF: w.fromF, toF: w.toF })) : [{ fromF: 0, toF: totalF }],
    attackF + releaseF,
  );
  return (f: number): number => {
    let v = 1;
    for (const s of spans) {
      if (f < s.fromF - attackF || f > s.toF + releaseF) continue;
      // ramp down before/at span start, hold floor through it, ramp up after end
      const m = interpolate(
        f,
        [s.fromF - attackF, s.fromF, s.toF, s.toF + releaseF],
        [1, floor, floor, 1],
        { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
      );
      v = Math.min(v, m);
    }
    return v;
  };
};

/* ─── Word-level karaoke captions (the flint-style signature) ─────────────── */
function buildGroups(words: WordCue[], maxWords = 4): WordCue[][] {
  const groups: WordCue[][] = [];
  let cur: WordCue[] = [];
  for (const w of words) {
    cur.push(w);
    if (cur.length >= maxWords || /[.!?,:]$/.test(w.word)) {
      groups.push(cur);
      cur = [];
    }
  }
  if (cur.length) groups.push(cur);
  return groups;
}

const subtitlePosition = (settings?: SubtitleSettings) => {
  if (settings?.position === "top") return { justifyContent: "flex-start", paddingTop: 230 };
  if (settings?.position === "middle") return { justifyContent: "center", paddingTop: 0 };
  // Default: raised well ABOVE the platform's bottom UI (handle/caption/progress)
  // so captions never tuck under Instagram/TikTok chrome.
  return { justifyContent: "flex-end", paddingBottom: 470 };
};

/* N6.1: exported so the HybridPost composition reuses the EXACT caption engine
   (word-level karaoke) over a footage spine — captions are identical whether the
   base layer is a generated scene stack or real ingested footage. */
/* CAPTION STYLE CHOREOGRAPHY span: a time window [fromF,toF) with a style the
   active caption group adopts while it's on screen. Lets ONE Karaoke vary its look
   line-by-line (hook glow → stat hormozi → quiet phrase) — used by BOTH generated
   posts and ingested footage so neither wears a single static subtitle style. */
export type CaptionLineStyle = {
  fromF: number;
  toF: number;
  preset?: "pop" | "bounce" | "phrase" | "hormozi" | "glow" | "clean" | "springy";
  position?: "bottom" | "middle" | "top";
  fontScale?: number;
  highlightColor?: string;
};

/* Stopwords for the single-emphasis-word picker (mirror of caption-style.ts STOPWORDS —
   this is the render side and can't import the engine, so it's duplicated minimally). */
const STOP = new Set([
  "the", "a", "an", "to", "of", "and", "is", "it", "in", "on", "for", "you", "your",
  "i", "we", "that", "this", "so", "but", "with", "as", "at", "or", "if", "be", "are",
  "was", "were", "im", "ive", "its", "my", "me", "they", "them", "he", "she", "do",
  "does", "did", "have", "has", "had", "will", "just", "not", "no", "yes", "all", "can",
]);

/* ONE emphasis word per group — pure, deterministic given (group, keywordSet).
   Kept as a plain function (not a useMemo) because it's evaluated after Karaoke's
   early returns, where an extra hook would vary the hook count and trip React #300. */
function pickEmphIdx(group: WordCue[], keywordSet: Set<string>): number {
  let kw = -1, best = -1, bestI = -1;
  group.forEach((w, idx) => {
    const n = w.word.toLowerCase().replace(/[^a-z0-9]+/gi, "");
    if (keywordSet.size > 0 && keywordSet.has(n) && kw < 0) kw = idx;
    if (!n || STOP.has(n)) return;
    const sc = n.length + (/\d|%/.test(w.word) ? 6 : 0) + (/^[A-Z][a-z]/.test(w.word.trim()) ? 1.5 : 0);
    if (sc > best) { best = sc; bestI = idx; }
  });
  return kw >= 0 ? kw : bestI;
}

export const Karaoke: React.FC<{ words: WordCue[]; themeName: string; pulse?: number; style?: "pop" | "bounce" | "phrase" | "hormozi" | "glow" | "clean" | "springy"; accent?: string; settings?: SubtitleSettings; lineStyles?: CaptionLineStyle[] }> = ({ words, themeName, pulse = 0, style: styleProp = "pop", accent, settings: settingsProp, lineStyles }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const baseTheme = getTheme(themeName);
  const theme = accent ? { ...baseTheme, accent: { ...baseTheme.accent, brand: accent } } : baseTheme;
  const maxWords = Math.round(clamp(num(settingsProp?.maxWords, 4), 1, 8));
  const groups = useMemo(() => buildGroups(words, maxWords), [words, maxWords]);
  // keyword emphasis — strip punctuation + lowercase for a tolerant case-insensitive match
  const keywordSet = useMemo(
    () => new Set((settingsProp?.keywords ?? []).map((k) => k.toLowerCase().replace(/[^a-z0-9]+/gi, "")).filter(Boolean)),
    [settingsProp?.keywords],
  );
  const isKeyword = (word: string) => keywordSet.size > 0 && keywordSet.has(word.toLowerCase().replace(/[^a-z0-9]+/gi, ""));
  if (!groups.length) return null;

  let gi = groups.findIndex((g) => frame >= g[0].fromF && frame <= g[g.length - 1].toF + 6);
  if (gi < 0) {
    // between groups, show the most recent past group briefly, else none
    for (let i = groups.length - 1; i >= 0; i--) {
      if (groups[i][0].fromF <= frame) {
        gi = i;
        break;
      }
    }
  }
  if (gi < 0) return null;
  const group = groups[gi];
  const gStart = group[0].fromF;
  const gEnd = group[group.length - 1].toF;
  if (frame > gEnd + 10 && gi === groups.length - 1) return null;

  // Resolve THIS group's choreographed style (the span covering the group's start),
  // overriding the global preset/position/size/accent only where the span sets them.
  const ls = lineStyles?.find((s) => gStart >= s.fromF && gStart < s.toF) ?? lineStyles?.find((s) => gStart < s.toF);
  const style = ls?.preset ?? styleProp;
  const settings: SubtitleSettings | undefined = ls
    ? { ...settingsProp, ...(ls.position ? { position: ls.position } : {}), ...(ls.fontScale != null ? { fontScale: ls.fontScale } : {}), ...(ls.highlightColor ? { highlightColor: ls.highlightColor } : {}) }
    : settingsProp;
  const hormozi = style === "hormozi" || style === "clean";
  const glow = style === "glow";
  // Two SCHOOLS (docs/WORLD-CLASS-EDITING.md §1): School A "clean" (Anton caps, snap,
  // one gold word) for hormozi/phrase/clean; School B "springy" (Montserrat-900, spring
  // overshoot, brighter accent) for pop/bounce/glow/springy. Captions override the
  // per-mood display face with the school font.
  const school: "clean" | "springy" = style === "hormozi" || style === "phrase" || style === "clean" ? "clean" : "springy";
  const captionFont = captionFontFor(school);
  // ONE emphasis word per group (single source of truth — keyword set first, else the
  // longest non-stopword content word / number). Colors EXACTLY one word, not all hits.
  // NOTE: this is a plain (pure) computation, NOT a hook — it sits AFTER the early
  // returns above, so a useMemo here would vary the hook count between frames and
  // crash with React #300 ("rendered fewer hooks"). pickEmphIdx is cheap + pure.
  const emphIdx = pickEmphIdx(group, keywordSet);

  // Entrance: School A = a tight snap (≤1.03×, no bounce); School B = a spring overshoot.
  const pop = school === "clean"
    ? interpolate(frame - gStart, [0, 3], [0.97, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })
    : interpolate(spring({ fps, frame: frame - gStart, config: { damping: 10, mass: 0.5 }, durationInFrames: 12 }), [0, 1], [0.82, 1]);
  const op = interpolate(frame - gStart, [0, 4], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });

  return (
    <AbsoluteFill style={{ ...subtitlePosition(settings), alignItems: "center", paddingLeft: 70, paddingRight: 70 }}>
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          justifyContent: "center",
          gap: "0 18px",
          opacity: op,
          transform: `scale(${pop})`,
          maxWidth: 720,
          background: settings?.background ? `rgba(0,0,0,${clamp(num(settings.backgroundOpacity, 0.48), 0, 1)})` : undefined,
          borderRadius: settings?.background ? 14 : undefined,
          padding: settings?.background ? "14px 22px" : undefined,
        }}
      >
        {group.map((w, i) => {
          const spoken = frame >= w.fromF;
          const active = frame >= w.fromF && frame <= w.toF;
          // EXACTLY ONE emphasis word per phrase (emphIdx) — the world-class "one gold
          // word" tell. School A golds it #f7c204; School B brightens to #FFD93D.
          const emphasized = i === emphIdx;
          const accentColor = settings?.highlightColor ?? (school === "clean" ? "#f7c204" : "#FFD93D");
          const color =
            style === "phrase"
              ? spoken
                ? (emphasized ? accentColor : theme.text.primary) // phrase: only the key word golds
                : `rgba(255,255,255,${clamp(num(settings?.inactiveOpacity, 0.4), 0.1, 0.8)})`
              : emphasized
                ? accentColor // the single emphasis word always reads in accent
                : spoken
                  ? theme.text.primary
                  : `rgba(255,255,255,${clamp(num(settings?.inactiveOpacity, 0.32), 0.1, 0.8)})`;
          const since = frame - w.fromF;
          const bounceY = style === "bounce" && active ? -10 * Math.exp(-since / 4) : 0;
          // School A = a tight static look (only the gold word nudges); School B keeps
          // the per-word active pop/bounce.
          const tf =
            school === "clean"
              ? emphasized ? "scale(1.04)" : "none"
              : style === "phrase"
                ? emphasized ? "scale(1.08)" : "none"
                : active
                  ? `translateY(${-4 + bounceY}px) scale(${1.05 + (emphasized ? 0.06 : 0) + pulse * 0.08})`
                  : emphasized
                    ? "scale(1.06)"
                    : "none";
          // School A = Anton (single weight 400, the face carries the heft); School B = Montserrat 900.
          const fontWeight = school === "clean" ? 400 : 900;
          const fontSize = primitive.size.xl * clamp(num(settings?.fontScale, 1), 0.6, 2.2) * (emphasized ? 1.08 : 1);
          const glowShadow =
            `0 0 18px ${accentColor}aa, 0 0 38px ${accentColor}66, 0 2px 12px rgba(0,0,0,0.7)`;
          // A SOLID black outline keeps every word legible on ANY background. Kept
          // tighter than the old 8–14px (a thick WebkitTextStroke clumps at corners
          // and fills letter counters, reading muddy/blobby), and fully opaque so the
          // edge is crisp instead of greyed. paintOrder keeps the stroke behind the fill.
          const strokeW = emphasized ? clamp(fontSize * 0.055, 3.5, 7) : Math.max(2, fontSize * 0.034);
          const textShadow = glow
            ? glowShadow
            : emphasized
              ? `0 0 30px ${accentColor}88, 0 2px 12px rgba(0,0,0,0.7)`
              : active && style !== "phrase"
                ? `0 0 28px ${theme.accent.brand}66, 0 2px 12px rgba(0,0,0,0.6)`
                : "0 2px 12px rgba(0,0,0,0.7)";
          return (
            <span
              key={i}
              style={{
                // captions use the SCHOOL font (Anton/Montserrat), not the per-mood display face.
                fontFamily: captionFont,
                fontSize,
                fontWeight,
                // School A is ALL-CAPS (the Hormozi look); School B keeps source case.
                textTransform: school === "clean" ? "uppercase" : undefined,
                letterSpacing: `${clamp(num(settings?.letterSpacing, school === "clean" ? -0.02 : -0.01), -0.08, 0.2)}em`,
                lineHeight: clamp(num(settings?.lineHeight, 1.05), 0.8, 1.8),
                color,
                transform: tf,
                WebkitTextStroke: `${strokeW}px #000`,
                paintOrder: "stroke" as unknown as undefined,
                textShadow,
              }}
            >
              {w.word}
            </span>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};

/* ─── Line subtitles (no-voice fallback) ─────────────────────────────────── */
/* N6.1: exported so HybridPost reuses the same line-caption fallback over footage. */
export const SubtitleLayer: React.FC<{ cues: SubtitleCue[]; themeName: string; settings?: SubtitleSettings }> = ({ cues, themeName, settings }) => {
  const frame = useCurrentFrame();
  const theme = getTheme(themeName);
  const idx = cues.findIndex((c) => frame >= c.fromF && frame < c.toF);
  if (idx < 0) return null;
  const cue = cues[idx];
  const local = frame - cue.fromF;
  const next = cues[idx + 1];
  const gapAfter = !next || next.fromF - cue.toF > 2;
  const span = cue.toF - cue.fromF;
  const op = gapAfter
    ? interpolate(local, [0, 6, span - 6, span], [0, 1, 1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })
    : interpolate(local, [0, 6], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  return (
    <AbsoluteFill style={{ ...subtitlePosition(settings), alignItems: "center", paddingLeft: 70, paddingRight: 70 }}>
      <div style={{ opacity: op, textAlign: "center", maxWidth: 720 }}>
        {cue.lines.map((l, i) => (
          <div
            key={i}
            style={{
              display: "inline-block",
              background: settings?.background === false ? "transparent" : `rgba(0,0,0,${clamp(num(settings?.backgroundOpacity, 0.5), 0, 1)})`,
              backdropFilter: settings?.background === false ? undefined : "blur(8px)",
              borderRadius: 8,
              padding: settings?.background === false ? "0" : "8px 18px",
              margin: "4px 0",
              ...typePresets(theme).subtitle,
              fontSize: primitive.size.base * clamp(num(settings?.fontScale, 1), 0.6, 2.2),
              letterSpacing: `${clamp(num(settings?.letterSpacing, 0), -0.08, 0.2)}em`,
              lineHeight: clamp(num(settings?.lineHeight, 1.15), 0.8, 1.8),
              color: settings?.highlightColor ?? theme.text.primary,
            }}
          >
            {l}
          </div>
        ))}
      </div>
    </AbsoluteFill>
  );
};

/* ─── Cinematic treatment: grain + vignette + letterbox ──────────────────── */
type Treatment = { letterbox: boolean; scanlines: boolean; grainScale: number; bloomScale: number };
const CinematicTreatment: React.FC<{ w: number; h: number; grain?: number; treatment?: Treatment }> = ({ w, h, grain, treatment }) => {
  const frame = useCurrentFrame();
  const tr = treatment ?? { letterbox: true, scanlines: false, grainScale: 1, bloomScale: 1 };
  // F2: bar thickness scales with the actual frame height (54px on a 1920-tall 9:16
  // frame) so letterboxing is proportionate on any aspect (1:1, 16:9, …) instead of
  // a fixed pixel slab that looks oversized on short frames.
  const barH = Math.round((h || 1920) * 0.028);
  return (
    <AbsoluteFill style={{ pointerEvents: "none" }}>
      {/* vignette */}
      <AbsoluteFill style={{ boxShadow: "inset 0 0 360px 90px rgba(0,0,0,0.7)" }} />
      {/* letterbox bars — per-mood (mindfulness has none for an open, airy frame) */}
      {tr.letterbox && (
        <>
          <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: barH, background: "#000", opacity: 0.92 }} />
          <div style={{ position: "absolute", bottom: 0, left: 0, right: 0, height: barH, background: "#000", opacity: 0.92 }} />
        </>
      )}
      {/* CRT scanlines — tech mood only */}
      {tr.scanlines && (
        <AbsoluteFill style={{ opacity: 0.12, mixBlendMode: "overlay", backgroundImage: "repeating-linear-gradient(180deg, rgba(255,255,255,0.22) 0, rgba(255,255,255,0.22) 1px, transparent 1px, transparent 5px)" }} />
      )}
      {/* true film grain — reseeds every frame, scaled per mood */}
      <FilmGrain w={w} h={h} frame={frame} opacity={(grain ?? 0.06) * (tr.grainScale ?? 1)} />
    </AbsoluteFill>
  );
};

const GrainOverlay: React.FC<{ w: number; h: number; opacity?: number }> = ({ w, h, opacity = 0.08 }) => {
  const frame = useCurrentFrame();
  const seed = Math.floor(frame / 2);
  return (
    <svg width={w} height={h} style={{ position: "absolute", inset: 0, opacity, mixBlendMode: "overlay", pointerEvents: "none" }}>
      <filter id={`scenegrain${seed}`}>
        <feTurbulence type="fractalNoise" baseFrequency="0.95" numOctaves="2" seed={seed} stitchTiles="stitch" />
        <feColorMatrix type="saturate" values="0" />
      </filter>
      <rect width={w} height={h} filter={`url(#scenegrain${seed})`} />
    </svg>
  );
};

const SceneEffectOverlay: React.FC<{ effects: Record<string, unknown>; w: number; h: number; intensity?: number }> = ({ effects, w, h, intensity = 1 }) => {
  if (!effects || !Object.values(effects).some(Boolean)) return null;
  // intensity scales each effect's strength; default 1 keeps the original look
  const k = clamp(num(intensity, 1), 0, 2);
  return (
    <AbsoluteFill style={{ pointerEvents: "none" }}>
      {Boolean(effects.grain) && <GrainOverlay w={w} h={h} opacity={0.08 * k} />}
      {Boolean(effects.vignette) && <AbsoluteFill style={{ boxShadow: "inset 0 0 420px 120px rgba(0,0,0,0.82)", opacity: k }} />}
      {Boolean(effects.scanlines) && (
        <AbsoluteFill
          style={{
            opacity: 0.18 * k,
            mixBlendMode: "overlay",
            backgroundImage: "repeating-linear-gradient(180deg, rgba(255,255,255,0.22) 0, rgba(255,255,255,0.22) 1px, transparent 1px, transparent 5px)",
          }}
        />
      )}
    </AbsoluteFill>
  );
};

const sceneFilter = (scene: any) => {
  const style = scene.style ?? {};
  const effects = scene.effects ?? {};
  const brightness = clamp(num(style.brightness, 1), 0.2, 2);
  const contrast = clamp(num(style.contrast, 1) * (effects.contrast ? 1.25 : 1), 0.2, 3);
  const blur = effects.blur ? " blur(4px)" : "";
  const invert = effects.invert ? " invert(1)" : "";
  // Keep colour: saturate(0) used to grey out everything — including the mood accent —
  // making every mood look identical. Let colour through; the ColorGrade still unifies tone.
  return `brightness(${brightness}) contrast(${contrast}) saturate(1)${blur}${invert}`;
};

const textAnimStyle = (scene: any, frame: number, durF: number, fps: number, fontScale?: number): React.CSSProperties => {
  const anim = scene.textAnim ?? {};
  const inF = Math.max(0, num(anim.inSec, 0.35) * fps);
  const outF = Math.max(0, num(anim.outSec, 0.35) * fps);
  const preset = anim.preset ?? "fade";
  const inP = inF > 0 ? interpolate(frame, [0, inF], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }) : 1;
  const outP = outF > 0 ? interpolate(frame, [durF - outF, durF], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }) : 1;
  const p = Math.min(inP, outP);
  const scale = fontScale && fontScale !== 1 ? ` scale(${fontScale})` : "";
  if (preset === "slide") return { opacity: p, transform: `translateY(${(1 - p) * 36}px)${scale}` };
  if (preset === "scale") return { opacity: p, transform: `scale(${0.92 + p * 0.08})${scale}` };
  if (preset === "type") return { opacity: p, clipPath: `inset(0 ${Math.max(0, (1 - inP) * 100)}% 0 0)` };
  return { opacity: p, ...(scale ? { transform: scale.trim() } : {}) };
};

/* Per-mood entrance signature — the SAME component enters differently by mood
   (slam / dissolve / type / slide / fade_up), paced by the mood. */
type MoodMotion = { entrance: string; pace: number };
const moodEntranceStyle = (motion: MoodMotion, frame: number, durF: number, fps: number, fontScale?: number): React.CSSProperties => {
  const pace = motion.pace || 1;
  const inF = Math.max(4, 0.42 * pace * fps);
  const outF = 0.3 * fps;
  const ease = { extrapolateLeft: "clamp" as const, extrapolateRight: "clamp" as const, easing: Easing.out(Easing.cubic) };
  const inP = interpolate(frame, [0, inF], [0, 1], ease);
  const outP = interpolate(frame, [durF - outF, durF], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const op = Math.min(inP, outP);
  const fs = fontScale && fontScale !== 1 ? fontScale : 1;
  switch (motion.entrance) {
    case "slam": {
      const s = interpolate(frame, [0, inF * 0.55, inF], [1.45, 0.97, 1], ease);
      return { opacity: Math.min(1, inP * 1.5) * outP, transform: `scale(${s * fs})` };
    }
    case "dissolve":
      return { opacity: op, transform: `scale(${(0.985 + inP * 0.015) * fs})`, filter: `blur(${(1 - inP) * 7}px)` };
    case "type":
      return { opacity: op, clipPath: `inset(0 ${Math.max(0, (1 - inP) * 100)}% 0 0)`, ...(fs !== 1 ? { transform: `scale(${fs})` } : {}) };
    case "slide":
      return { opacity: op, transform: `translateX(${(1 - inP) * 64}px) scale(${fs})` };
    case "fade_up":
    default:
      return { opacity: op, transform: `translateY(${(1 - inP) * 42}px) scale(${fs})` };
  }
};

const sceneTextTransformStyle = (scene: any, kf?: KfValues | null): React.CSSProperties => {
  const style = scene.style ?? {};
  const x = clamp(num(kf?.x ?? style.x, 0), -420, 420);
  const y = clamp(num(kf?.y ?? style.y, 0), -720, 720);
  const rotation = clamp(num(kf?.rotation ?? style.rotation, 0), -45, 45);
  const scale = typeof kf?.scale === "number" ? clamp(kf.scale, 0, 6) : undefined;
  const letterSpacing = style.letterSpacing;
  const lineHeight = style.lineHeight;
  const paragraphSpacing = style.paragraphSpacing;
  const textCase = style.textCase;
  const typography: React.CSSProperties = {
    ...(typeof letterSpacing === "number" ? { letterSpacing: `${clamp(letterSpacing, -0.08, 0.2)}em` } : {}),
    ...(typeof lineHeight === "number" ? { lineHeight: clamp(lineHeight, 0.8, 1.8) } : {}),
    ...(typeof paragraphSpacing === "number" ? { rowGap: clamp(paragraphSpacing, 0, 80) } : {}),
    ...(textCase === "upper" ? { textTransform: "uppercase" } : {}),
    ...(textCase === "lower" ? { textTransform: "lowercase" } : {}),
    ...(textCase === "title" ? { textTransform: "capitalize" } : {}),
  };
  const hasScale = scale !== undefined && scale !== 1;
  if (!x && !y && !rotation && !hasScale) return typography;
  return {
    ...typography,
    transform: `translate(${x}px, ${y}px) rotate(${rotation}deg)${hasScale ? ` scale(${scale})` : ""}`,
    transformOrigin: "center center",
  };
};

/* Text stroke + drop shadow from scene.style.stroke / scene.style.shadow.
   Applied on the scene's text transform layer; the CSS props inherit to every
   text node rendered inside SceneRenderer. Unset → empty object (no change). */
const textTreatmentStyle = (scene: any): React.CSSProperties => {
  const style = scene.style ?? {};
  const out: React.CSSProperties = {};
  const stroke = style.stroke;
  if (stroke && typeof stroke.color === "string" && typeof stroke.width === "number" && stroke.width > 0) {
    const w = clamp(stroke.width, 0, 20);
    (out as any).WebkitTextStrokeWidth = `${w}px`;
    (out as any).WebkitTextStrokeColor = stroke.color;
  }
  const shadow = style.shadow;
  if (shadow && typeof shadow.color === "string") {
    const x = clamp(num(shadow.x, 0), -40, 40);
    const y = clamp(num(shadow.y, 0), -40, 40);
    const blur = clamp(num(shadow.blur, 0), 0, 60);
    out.textShadow = `${x}px ${y}px ${blur}px ${shadow.color}`;
  }
  return out;
};

/* Free-form overlay layer: stickers, shapes, images, logos, emoji, free text.
   Positioned in 1080-space with a center origin (matching style.x/y). Rendered
   above the scene content but below captions/treatment. Unset/empty → null. */
export type Overlay = {
  id: string;
  type: "sticker" | "shape" | "image" | "logo" | "emoji" | "text";
  content?: string;
  src?: string;
  shape?: "rect" | "circle" | "triangle" | "star" | "arrow" | "line";
  color?: string;
  x: number;
  y: number;
  scale?: number;
  rotation?: number;
  opacity?: number;
};

const OverlayShape: React.FC<{ shape: NonNullable<Overlay["shape"]>; color: string }> = ({ shape, color }) => {
  const S = 200; // base box the shape draws into; overlay.scale resizes it
  switch (shape) {
    case "rect":
      return <div style={{ width: S, height: S, background: color, borderRadius: 8 }} />;
    case "circle":
      return <div style={{ width: S, height: S, background: color, borderRadius: "50%" }} />;
    case "line":
      return <div style={{ width: S, height: Math.max(4, S * 0.04), background: color, borderRadius: 4 }} />;
    case "triangle":
      return (
        <svg width={S} height={S} viewBox="0 0 100 100">
          <polygon points="50,6 96,94 4,94" fill={color} />
        </svg>
      );
    case "star":
      return (
        <svg width={S} height={S} viewBox="0 0 100 100">
          <polygon points="50,4 61,38 97,38 68,60 79,95 50,73 21,95 32,60 3,38 39,38" fill={color} />
        </svg>
      );
    case "arrow":
      return (
        <svg width={S} height={S * 0.5} viewBox="0 0 100 50">
          <polygon points="0,18 64,18 64,4 100,25 64,46 64,32 0,32" fill={color} />
        </svg>
      );
    default:
      return null;
  }
};

/* N6.1: exported so HybridPost can place sticker/image/logo/emoji/text overlay
   clips over the footage spine through the same positioning math as generated posts. */
export const OverlayItem: React.FC<{ ov: Overlay }> = ({ ov }) => {
  const x = num(ov.x, 0);
  const y = num(ov.y, 0);
  const scale = num(ov.scale, 1);
  const rotation = num(ov.rotation, 0);
  const opacity = clamp(num(ov.opacity, 1), 0, 1);
  const wrap: React.CSSProperties = {
    position: "absolute",
    left: "50%",
    top: "50%",
    transform: `translate(-50%, -50%) translate(${x}px, ${y}px) rotate(${rotation}deg) scale(${scale})`,
    transformOrigin: "center center",
    opacity,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  };
  let inner: React.ReactNode = null;
  if ((ov.type === "image" || ov.type === "logo" || ov.type === "sticker") && ov.src) {
    inner = <Img src={staticFile(ov.src)} style={{ maxWidth: 600, maxHeight: 600, objectFit: "contain", filter: "drop-shadow(0 4px 18px rgba(0,0,0,0.45))" }} />;
  } else if (ov.type === "shape" && ov.shape) {
    inner = <OverlayShape shape={ov.shape} color={ov.color ?? "#ffffff"} />;
  } else if ((ov.type === "emoji" || ov.type === "text" || ov.type === "sticker") && ov.content) {
    inner = (
      <span style={{ fontSize: 120, lineHeight: 1, color: ov.color ?? "#ffffff", textShadow: "0 4px 18px rgba(0,0,0,0.45)", whiteSpace: "pre", fontWeight: 700 }}>
        {ov.content}
      </span>
    );
  }
  if (!inner) return null;
  return <div style={wrap}>{inner}</div>;
};

const OverlayLayer: React.FC<{ overlays?: Overlay[] }> = ({ overlays }) => {
  if (!overlays || !overlays.length) return null;
  return (
    <AbsoluteFill style={{ pointerEvents: "none" }}>
      {overlays.map((ov) => (
        <OverlayItem key={ov.id} ov={ov} />
      ))}
    </AbsoluteFill>
  );
};

const Watermark: React.FC<{ label: string; themeName: string; logo?: string }> = ({ label, themeName, logo }) => {
  const theme = getTheme(themeName);
  return (
    <AbsoluteFill style={{ justifyContent: "flex-start", alignItems: "center", paddingTop: 64 }}>
      {logo ? (
        // logos are black on transparent; invert to white for the dark video
        <Img src={staticFile(logo)} style={{ height: 58, opacity: 0.85, filter: "drop-shadow(0 2px 10px rgba(0,0,0,0.55))" }} />
      ) : (
        <div style={{ display: "flex", alignItems: "center", gap: 10, opacity: 0.5 }}>
          <span style={{ width: 8, height: 8, borderRadius: 4, background: theme.accent.brand }} />
          <span style={{ ...typePresets(theme).eyebrow, color: theme.text.muted }}>{label}</span>
        </div>
      )}
    </AbsoluteFill>
  );
};

const ProgressBar: React.FC<{ themeName: string; accent?: string }> = ({ themeName, accent }) => {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const col = accent ?? getTheme(themeName).accent.brand;
  const p = Math.min(1, frame / durationInFrames);
  return (
    <AbsoluteFill style={{ justifyContent: "flex-end" }}>
      <div style={{ height: 5, width: `${p * 100}%`, background: col, boxShadow: `0 0 16px ${col}` }} />
    </AbsoluteFill>
  );
};

/* ─── B-roll background: graded to theme, darkened, Ken Burns ─────────────── */
/* N6.1: exported so HybridPost can drop a b-roll cutaway clip over the footage
   spine using the SAME Ken-Burns/graded treatment generated posts use. */
export const BrollBackground: React.FC<{ asset: BrollAsset; themeName: string; durF: number; pulse: number; accent?: string; index?: number; chroma?: boolean; brollGrade?: string }> = ({ asset, themeName, durF, pulse, accent, index = 0, chroma, brollGrade }) => {
  const frame = useCurrentFrame();
  const theme = getTheme(themeName);
  const tint = accent ?? theme.accent.brand;
  const prog = Math.min(1, frame / Math.max(1, durF));
  const scale = 1.1 + prog * 0.16 + pulse * 0.045; // Ken Burns + beat zoom-punch
  // directional camera drift — varies per scene so the move isn't always "up"
  const dir = index % 4;
  const dx = (dir === 1 ? -1 : dir === 3 ? 1 : 0) * prog * 34;
  const dy = (dir === 0 ? -1 : dir === 2 ? 1 : 0) * prog * 34;
  // per-MOOD grade (not a single hardcoded grayscale crush on every video)
  const grade = (brollGrade ?? "grayscale(0.12) contrast(1.06) brightness(0.66) saturate(1.08)") + (chroma ? " url(#chroma)" : "");
  const common: React.CSSProperties = {
    position: "absolute",
    width: "120%",
    height: "120%",
    top: "-10%",
    left: "-10%",
    objectFit: "cover",
    filter: grade,
    transform: `scale(${scale}) translate(${dx}px, ${dy}px)`,
  };
  return (
    <AbsoluteFill>
      {asset.type === "video" ? (
        <OffthreadVideo src={staticFile(asset.src)} muted style={common} />
      ) : (
        <Img src={staticFile(asset.src)} style={common} />
      )}
      {/* mood-accent tint + dark wash so captions stay readable */}
      <AbsoluteFill style={{ background: tint, opacity: 0.14, mixBlendMode: "color" }} />
      <AbsoluteFill style={{ background: `linear-gradient(180deg, ${theme.bg}b3 0%, ${theme.bg}80 45%, ${theme.bg}e0 100%)` }} />
    </AbsoluteFill>
  );
};

const SceneInner: React.FC<{ scene: Storyboard["scenes"][number]; themeName: string; durF: number; broll: BrollAsset | null; pulse: number; moodAccent?: string; motion?: MoodMotion; index?: number; brollGrade?: string }> = ({
  scene,
  themeName,
  durF,
  broll,
  pulse,
  moodAccent,
  motion,
  index = 0,
  brollGrade,
}) => {
  const frame = useCurrentFrame();
  const { width, height, fps } = useVideoConfig();
  const baseTheme = getTheme(themeName);
  const sceneAny = scene as any;
  // per-scene accent wins; otherwise the mood's accent recolours the whole post
  const accent = (sceneAny.style?.accent as string | undefined) ?? moodAccent;
  const fontScale = sceneAny.style?.fontScale as number | undefined;
  const opacity = clamp(num(sceneAny.style?.opacity, 1), 0, 1);
  const kf = resolveKeyframes(sceneAny, frame, durF);
  const effects = sceneAny.effects ?? {};
  const theme = accent ? { ...baseTheme, accent: { ...baseTheme.accent, brand: accent } } : baseTheme;
  // Only emphasis scenes react to the beat for emotional highs vs calm lows.
  const p = scene.emphasis ? pulse : 0;
  // chromatic-aberration punch fires only on the B-ROLL (footage) at a beat peak —
  // NEVER on the text, which would shred legibility into a magenta/cyan ghost.
  const chroma = p > 0.5;
  // slow camera push on the CONTENT layer — moves less than the b-roll behind it,
  // so the two layers parallax for depth (and the move varies per scene).
  const prog = Math.min(1, frame / Math.max(1, durF));
  const camDir = index % 4;
  const camX = (camDir === 1 ? -1 : camDir === 3 ? 1 : 0) * prog * 10;
  const camY = (camDir === 0 ? -1 : camDir === 2 ? 1 : 0) * prog * 9;
  const camera = `translate(${camX}px, ${camY}px) scale(${1 + prog * 0.022})`;
  // M2 (§4.1): real per-scene colour grade. `gradeToFilterId` returns "" for an
  // identity/absent grade → we emit NO <GradePipeline> def and the legacy filter
  // string is unchanged (byte-identical legacy output). Otherwise we mount the
  // grade's SVG <filter> once (keyed by its stable hash) and chain it AFTER the
  // legacy brightness/contrast filter, so the grade reads on the composited scene.
  const sceneGrade = sceneAny.style?.grade;
  const gradeId = gradeToFilterId(sceneGrade, sceneAny.id ?? `s${index}`);
  const baseFilter = sceneFilter(sceneAny);
  const filter = gradeId ? `${baseFilter} url(#${gradeId})` : baseFilter;
  // M14 (§4.4): a PER-SCENE compositing graph. When the scene carries
  // `style.comp` (an EffectGraph), the scene's rendered content is the graph's
  // `source` node and we composite it through <CompositeGraph> (mask/key/glow/
  // grade/transform/displace…). ABSENT/empty comp ⇒ <CompositeGraph> renders its
  // children verbatim (its identity guarantee: no graph ⇒ <>{children}</>), so a
  // comp-less scene is BYTE-IDENTICAL to today.
  const sceneComp = sceneAny.style?.comp as import("@os/schemas").EffectGraph | undefined;
  const content = (
    <>
      {scene.emphasis && (
        <AbsoluteFill style={{ background: theme.accent.brand, opacity: p * 0.07, mixBlendMode: "screen", pointerEvents: "none" }} />
      )}
      <AbsoluteFill style={{ transform: camera }}>
        <AbsoluteFill style={sceneAny.textAnim || !motion ? textAnimStyle(sceneAny, frame, durF, fps, fontScale) : moodEntranceStyle(motion, frame, durF, fps, fontScale)}>
          {(() => {
            // text stroke/shadow inherit to all text inside SceneRenderer; merge onto
            // the transform layer so they ride the same node as x/y/rotate/scale.
            const transformStyle = kf?.opacity != null ? { ...sceneTextTransformStyle(sceneAny, kf), opacity: clamp(kf.opacity, 0, 1) } : sceneTextTransformStyle(sceneAny, kf);
            return (
              <AbsoluteFill style={{ ...transformStyle, ...textTreatmentStyle(sceneAny) }}>
                <SceneRenderer scene={scene} theme={theme} frame={frame} durF={durF} />
              </AbsoluteFill>
            );
          })()}
        </AbsoluteFill>
      </AbsoluteFill>
      {/* free-form overlays sit above the scene content, below captions/treatment */}
      <OverlayLayer overlays={sceneAny.overlays as Overlay[] | undefined} />
      <SceneEffectOverlay effects={effects} w={width} h={height} intensity={num(sceneAny.style?.effectIntensity, 1)} />
      {/* light leak ONLY on the 1-2 emphasis peak scenes — never a constant beat */}
      {scene.emphasis && <LightLeak amount={p} />}
    </>
  );
  return (
    <AbsoluteFill style={{ transform: `scale(${1 + p * 0.018})`, filter, opacity }}>
      {gradeId && <GradePipeline grade={sceneGrade} id={gradeId} />}
      {/* b-roll background stays OUTSIDE the per-scene comp so a mask/key isolates
          the scene's CONTENT against its footage, not the footage itself. */}
      {broll && <BrollBackground asset={broll} themeName={themeName} durF={durF} pulse={p} accent={accent ?? baseTheme.accent.brand} index={index} chroma={chroma} brollGrade={brollGrade} />}
      {/* M14: comp-less scene ⇒ CompositeGraph passes `content` through verbatim. */}
      <CompositeGraph graph={sceneComp} w={width} h={height} frame={frame} durF={durF}>
        {content}
      </CompositeGraph>
    </AbsoluteFill>
  );
};

/* ─── M0: manual-crossfade entry transitions ──────────────────────────────────
   The old <TransitionSeries> re-mounts each Sequence ~16× under React 19.2.3 +
   Remotion 4.0.461, so device_mockup/diagram scenes render stacked/black. We
   replace it with a manual sequencer (a plain <Sequence from={startF}> per scene,
   z-stacked, entering scene on top) and reproduce every transition as a per-scene
   ENTRY wrapper: each presentation's "entering" branch, re-keyed by the local
   crossfade progress p = clamp(localFrame / trFs). The exiting scene simply keeps
   playing underneath — visually identical for these looks, where the entering
   layer draws on top of the (opaque) previous scene during the overlap.

   ★ The default transition cycle (PRES_NAMES) is the name-form of the old PRES
   array the TransitionSeries default used, in the SAME order, so an unnamed
   transition picks the SAME look per scene index as before:
   PRES[0..4] = slide(from-bottom) / fade / slide(from-right) / wipe(from-left) /
   slide(from-top)  →  slide / fade / slamzoom / wipe / slide_top. */
const PRES_NAMES = ["slide", "fade", "slamzoom", "wipe", "slide_top"] as const;

/* Pick the transition NAME for scene i — mirrors the old presFor() resolution
   order but returns the name (so the manual entry wrapper can branch on it).
   Unnamed → the same default cycle the old TransitionSeries used. */
const transitionNameFor = (name: string | undefined, i: number): string =>
  name ?? PRES_NAMES[i % PRES_NAMES.length];

/* Convert a transition name + crossfade progress p∈[0,1] into the entering
   scene's wrapper style. Each branch is the "entering" half of the matching
   presentation component above (or of the @remotion/transitions built-in). At
   p=0 the scene is at its pre-roll pose (off-screen / scaled / clipped); at p=1
   it sits exactly where SceneInner expects (identity), so beyond trFs frames the
   wrapper is a no-op and the scene plays untouched.
   Returns BOTH a style for the wrapper AND an optional clip element (scan line). */
const entryTransition = (name: string, p: number): { style: React.CSSProperties; lead?: React.ReactNode } => {
  switch (name) {
    case "fade":
    case "dissolve":
      return { style: { opacity: p } };
    case "slide": // from-bottom (matches slide({direction:"from-bottom"}))
      return { style: { opacity: 1, transform: `translateY(${(1 - p) * 100}%)` } };
    case "slide_top": // PRES[4] = slide({direction:"from-top"})
      return { style: { opacity: 1, transform: `translateY(${-(1 - p) * 100}%)` } };
    case "slamzoom": // slide({direction:"from-right"})
      return { style: { opacity: 1, transform: `translateX(${(1 - p) * 100}%)` } };
    case "push": // slide({direction:"from-left"})
      return { style: { opacity: 1, transform: `translateX(${-(1 - p) * 100}%)` } };
    case "wipe": // wipe({direction:"from-left"}) — entering revealed by a left→right clip
      return { style: { clipPath: `inset(0 ${(1 - p) * 100}% 0 0)` } };
    case "cover": // flip({direction:"from-right"}) — entering rotates in around Y
      return { style: { opacity: Math.min(1, p * 1.6), transform: `perspective(1600px) rotateY(${(1 - p) * 90}deg)`, transformOrigin: "left center" } };
    // custom presentations — the "entering" branch of each component above
    case "zoom": // ZoomPresentation entering
      return { style: { opacity: p, transform: `scale(${0.72 + p * 0.28})` } };
    case "spin": // SpinPresentation entering
      return { style: { opacity: p, transform: `rotate(${(1 - p) * -22}deg) scale(${0.7 + p * 0.3})`, transformOrigin: "center center" } };
    case "glitch": { // GlitchPresentation entering
      const amt = 1 - p;
      const jitter = (seed: number) => Math.sin(p * 60 + seed) * 16 * amt;
      return {
        style: {
          opacity: Math.min(1, p * 1.4),
          transform: `translate(${jitter(0)}px, ${jitter(1.7) * 0.4}px) skewX(${jitter(3) * 0.3}deg)`,
          filter: `hue-rotate(${amt * 40}deg) contrast(${1 + amt * 0.4})`,
          clipPath: amt > 0.4 ? `inset(${amt * 18}% 0 ${amt * 12}% 0)` : undefined,
        },
      };
    }
    case "scan_wipe": { // ScanWipePresentation entering — clip from the right + lead scan line
      const lead = (
        <div style={{
          position: "absolute", top: 0, bottom: 0,
          left: `calc(${(p * 100).toFixed(2)}% - 3px)`,
          width: 3, background: "rgba(0,201,167,0.9)",
          boxShadow: "0 0 18px 4px rgba(0,201,167,0.55)", zIndex: 10, pointerEvents: "none",
        }} />
      );
      return { style: { clipPath: `inset(0 ${(100 - p * 100).toFixed(2)}% 0 0)` }, lead: p < 1 ? lead : undefined };
    }
    case "smash": // SmashPresentation entering — appears instantly, brief red flash at the cut
      return {
        style: { opacity: p > 0 ? 1 : 0 },
        lead: p > 0 && p < 0.15 ? (
          <div style={{ position: "absolute", inset: 0, background: "#e63946", opacity: ((0.15 - p) / 0.15) * 0.35, pointerEvents: "none" }} />
        ) : undefined,
      };
    // terminal_wipe is handled wholesale inside TransitionScene (it needs 16 masked
    // copies of the scene subtree), so it never reaches entryTransition during the
    // wipe; this branch only covers p===1 (post-wipe identity).
    case "terminal_wipe":
      return { style: { opacity: 1 } };
    default:
      return { style: { opacity: p } };
  }
};

/* One visible scene as a plain <Sequence> with its entry transition driven
   manually — replaces a TransitionSeries.Sequence + its preceding Transition. The
   <Sequence from> values reproduce the EXACT TransitionSeries overlap that
   totalFrames() already encodes (see SceneSequencer below).

   terminal_wipe is special: its look is 16 masked copies of the SAME content. We
   render the content once, plus (during the wipe) a strip-masked overlay stack so
   the visual matches TerminalWipePresentation without re-mounting SceneInner 16×. */
const TransitionScene: React.FC<{
  name: string;
  trFs: number;
  easing: (input: number) => number;
  children: React.ReactNode;
}> = ({ name, trFs, easing, children }) => {
  const frame = useCurrentFrame(); // local to this Sequence (starts at 0)
  // linear crossfade progress, then the per-scene easing (C6 transitionEase, default
  // easeOut) shapes the curve — approximating the old springTiming feel.
  const linP = trFs > 0 ? clamp(frame / trFs, 0, 1) : 1;
  const p = easing(linP);
  const { style, lead } = entryTransition(name, p);
  // terminal_wipe: the base layer is the content; during the wipe we overlay 16
  // strips that each clip a full-frame copy of the content, mirroring the original
  // presentation (which wrapped `children` per strip). Cheap: the copies are the
  // same React subtree but only visible for trFs frames.
  if (name === "terminal_wipe" && p < 1) {
    const strips = 16;
    return (
      <AbsoluteFill style={{ overflow: "hidden" }}>
        {/* base content stays hidden until the wipe finishes; strips reveal it */}
        <AbsoluteFill style={{ opacity: 0 }}>{children}</AbsoluteFill>
        {Array.from({ length: strips }, (_, i) => {
          const threshold = i / strips;
          const localP = Math.max(0, Math.min(1, (p - threshold) / (1 / strips)));
          const pct = (localP * 100).toFixed(1);
          return (
            <div key={i} style={{
              position: "absolute", top: `${((i / strips) * 100).toFixed(2)}%`, left: 0, right: 0,
              height: `${((1 / strips) * 100).toFixed(2)}%`, overflow: "hidden",
              clipPath: `inset(0 ${(100 - Number(pct)).toFixed(1)}% 0 0)`,
            }}>
              <div style={{ position: "absolute", top: `${((-i / strips) * 100).toFixed(2)}%`, left: 0, right: 0, height: `${strips * 100}%` }}>
                {children}
              </div>
            </div>
          );
        })}
      </AbsoluteFill>
    );
  }
  return (
    <AbsoluteFill style={style}>
      {children}
      {lead}
    </AbsoluteFill>
  );
};

/* ─── M0: the manual crossfade sequencer ──────────────────────────────────────
   Reproduces the <TransitionSeries> on-screen timeline with plain <Sequence>s.

   TIMING MATH (must match totalFrames() at Post.tsx:127 byte-for-byte):
   TransitionSeries overlaps the ENTERING scene over the previous scene's tail by
   the ENTERING scene's own transition frames. totalFrames() encodes exactly that:
   it removes Σ trFs[1..n-1] (each entering scene i>0 overlaps by trFs[i]) plus a
   final trFs[n-1] for the outro. So the absolute starts are:

     startF[0]   = 0
     startF[k]   = startF[k-1] + durFs[k-1] - trFs[k]          (k = 1..n-1)
     outroStart  = startF[n-1] + durFs[n-1] - trFs[n-1]
     total       = outroStart + OUTRO_F   ≡ totalFrames(sb, fps)   (verified)

   Each scene Sequence spans [startF[k], startF[k]+durFs[k]); the next scene's
   Sequence begins trFs[k+1] frames before this one ends and draws ON TOP, so the
   crossfade overlap is identical to TransitionSeries. The entry transition runs
   over the first trFs[k] LOCAL frames of scene k (p = localFrame/trFs[k]); scene 0
   gets no entry wrapper (it had no preceding transition), matching the old layout.
   The outro overlaps the last scene by trFs[n-1] and gets the same entry wrapper
   keyed to the last scene's transition, reproducing the final TransitionSeries
   crossfade into the end card. */
const SceneSequencer: React.FC<{
  scenes: Storyboard["scenes"];
  themeName: string;
  durFs: number[];
  trFs: number[];
  brolls?: (BrollAsset | null)[];
  pulse: number;
  accent?: string;
  motion: MoodMotion;
  moodId?: string;
  studio: ResolvedStudio;
  outro: React.ReactNode;
}> = ({ scenes, themeName, durFs, trFs, brolls, pulse, accent, motion, moodId, studio, outro }) => {
  // Absolute start of each visible scene (see TIMING MATH above).
  const startF: number[] = [];
  for (let k = 0; k < scenes.length; k++) {
    startF[k] = k === 0 ? 0 : startF[k - 1] + durFs[k - 1] - trFs[k];
  }
  const n = scenes.length;
  const outroStart = n ? startF[n - 1] + durFs[n - 1] - trFs[n - 1] : 0;
  const outroName = n ? transitionNameFor((scenes[n - 1] as any).style?.transition ?? pickStudioTransition(studio, n - 1), n - 1) : "fade";
  const outroTr = n ? trFs[n - 1] : TR;
  // the outro crossfade mirrors the last scene's transition (name + duration + ease).
  const outroEasing = n ? transitionEaseFor(scenes[n - 1]) : Easing.out(Easing.cubic);

  return (
    <>
      {scenes.map((scene, i) => {
        const name = transitionNameFor((scene as any).style?.transition ?? pickStudioTransition(studio, i), i);
        const easing = transitionEaseFor(scene);
        const inner = (
          <SceneInner
            scene={scene}
            themeName={themeName}
            durF={durFs[i]}
            broll={brolls?.[i] ?? null}
            pulse={pulse}
            moodAccent={accent}
            motion={motion}
            index={i}
            brollGrade={brollFilter(moodId)}
          />
        );
        return (
          <Sequence key={`s${i}`} from={startF[i]} durationInFrames={durFs[i]} layout="none">
            {/* scene 0 had no preceding TransitionSeries.Transition → no entry wrapper */}
            {i === 0 ? (
              <AbsoluteFill>{inner}</AbsoluteFill>
            ) : (
              <TransitionScene name={name} trFs={trFs[i]} easing={easing}>
                {inner}
              </TransitionScene>
            )}
          </Sequence>
        );
      })}
      <Sequence key="outro" from={outroStart} durationInFrames={OUTRO_F} layout="none">
        <TransitionScene name={outroName} trFs={outroTr} easing={outroEasing}>
          {outro}
        </TransitionScene>
      </Sequence>
    </>
  );
};

/* Per-DNA transition grammar: cycle the studio's transition list across scenes
   (so a channel has its own rhythm), else fall back to the mood/motion default. */
const pickStudioTransition = (studio: ResolvedStudio, i: number): string =>
  studio.transitions && studio.transitions.length ? studio.transitions[i % studio.transitions.length] : studio.motion.transition;

/* Branded end card: logo + handle + site + subscribe + socials. */
const Outro: React.FC<{ themeName: string; logo?: string; handle?: string; site?: string; socials?: string[]; accent?: string }> = ({ themeName, logo, handle, site, socials, accent }) => {
  const frame = useCurrentFrame();
  const base = getTheme(themeName);
  const theme = accent ? { ...base, accent: { ...base.accent, brand: accent } } : base;
  const t = typePresets(theme);
  const ease = { extrapolateLeft: "clamp" as const, extrapolateRight: "clamp" as const };
  const logoScale = interpolate(frame, [0, 18], [0.78, 1], ease);
  const logoOp = interpolate(frame, [0, 12], [0, 1], ease);
  const handleOp = interpolate(frame, [10, 22], [0, 1], ease);
  const handleY = interpolate(frame, [10, 24], [22, 0], ease);
  const pillScale = interpolate(frame, [22, 34, 40], [0.7, 1.06, 1], ease);
  const pillOp = interpolate(frame, [22, 32], [0, 1], ease);
  const socialOp = interpolate(frame, [34, 46], [0, 1], ease);
  return (
    <AbsoluteFill style={{ justifyContent: "center", alignItems: "center", background: `${theme.bg}f7` }}>
      {logo && (
        <Img src={staticFile(logo)} style={{ height: 230, filter: "drop-shadow(0 2px 10px rgba(0,0,0,0.55))", opacity: logoOp, transform: `scale(${logoScale})` }} />
      )}
      {handle && (
        <div style={{ ...t.title, fontSize: primitive.size.xl, marginTop: 18, opacity: handleOp, transform: `translateY(${handleY}px)` }}>{handle}</div>
      )}
      {site && <div style={{ ...t.mono, color: theme.accent.brand, fontSize: primitive.size.sm, marginTop: 12, opacity: handleOp, letterSpacing: "0.04em", whiteSpace: "nowrap" }}>{site}</div>}
      <div
        style={{
          marginTop: 40,
          display: "flex",
          alignItems: "center",
          gap: 16,
          background: theme.accent.brand,
          color: "#0a0a0a",
          padding: "20px 46px",
          borderRadius: 999,
          fontFamily: t.body.fontFamily,
          fontWeight: 700,
          fontSize: primitive.size.md,
          opacity: pillOp,
          transform: `scale(${pillScale})`,
          boxShadow: `0 0 40px ${theme.accent.brand}66`,
        }}
      >
        <span style={{ fontSize: primitive.size.sm, letterSpacing: "0.1em" }}>SUB</span> Subscribe
      </div>
      <div style={{ ...t.eyebrow, color: theme.text.secondary, marginTop: 30, opacity: socialOp, letterSpacing: "0.16em" }}>
        {(socials && socials.length ? socials : ["Instagram", "X"]).join(" / ")}
      </div>
    </AbsoluteFill>
  );
};

/* Brand sting: a quick logo punch + light flash at the very start (~0.6s). */
const IntroSting: React.FC<{ themeName: string; logo?: string }> = ({ themeName, logo }) => {
  const frame = useCurrentFrame();
  if (frame > 20 || !logo) return null;
  const c = { extrapolateLeft: "clamp" as const, extrapolateRight: "clamp" as const };
  const flash = interpolate(frame, [0, 3, 11], [0.45, 0, 0], c);
  const op = interpolate(frame, [0, 4, 13, 20], [0, 1, 1, 0], c);
  const s = interpolate(frame, [0, 9], [1.35, 1], c);
  return (
    <AbsoluteFill style={{ pointerEvents: "none" }}>
      <AbsoluteFill style={{ background: "#fff", opacity: flash, mixBlendMode: "screen" }} />
      <AbsoluteFill style={{ justifyContent: "center", alignItems: "center" }}>
        <Img src={staticFile(logo)} style={{ height: 260, filter: "drop-shadow(0 2px 10px rgba(0,0,0,0.55))", opacity: op, transform: `scale(${s})` }} />
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

export const Post: React.FC<PostProps> = ({ storyboard, subtitles = [], words, captionLineStyles, brolls, beatFrames, sfx, mix, musicSrc, voiceSrc, channelLabel, channelLogo, channelHandle, channelSite, channelSocials, mood: moodId, brandAccent }) => {
  const frame = useCurrentFrame();
  const { fps, width, height, durationInFrames } = useVideoConfig();
  const theme = getTheme(storyboard.theme);
  const mood = getMood(moodId);
  // The STUDIO layers the channel's directorial signature (accent-lock, motion,
  // grade tint, treatment, background, transitions) over the mood. Broad channels
  // (concept/builder) take the mood accent; brand channels keep their signature.
  // A brand's CUSTOM accent (set in brand settings) wins over everything.
  const studio = resolveStudio(storyboard.theme, mood, brandAccent || theme.accent.brand);
  const accent = brandAccent || studio.accent;
  const displayFont = getMoodDisplayFont(moodId);
  const monoFont = getMoodMonoFont(moodId);
  const bgVariant = studio.bgVariant;
  // C11: drop hidden scenes before building the timeline so they neither render nor
  // consume frames; totalFrames() filters identically so durations stay consistent.
  const scenes = useMemo(() => visibleScenes(storyboard), [storyboard]);
  // C11: brolls is indexed by ORIGINAL scene index; re-map it to the visible-scene
  // order so b-roll assets stay aligned after hidden scenes are dropped.
  const brollsForVisibleScenes = useMemo(() => {
    if (!brolls) return brolls;
    const visibleIndices = storyboard.scenes.map((s, idx) => (!(s as any).hidden ? idx : -1)).filter((idx) => idx >= 0);
    return visibleIndices.map((idx) => brolls[idx]);
  }, [storyboard.scenes, brolls]);
  const bgSeed = ((storyboard.topic ?? "").length * 3 + storyboard.scenes.length * 5 + 7) % 97;
  const trFs = scenes.map((s) => transitionFramesFor(s, fps));
  const durFs = scenes.map((s, i) => Math.max(2 * trFs[i] + 4, Math.round(s.durationSec * fps)));
  const pulse = beatPulse(frame, beatFrames) * (mix?.beatIntensity ?? studio.beatIntensity);
  const musicTrack = trackFor(mix, "music");
  const voiceTrack = trackFor(mix, "voice");
  const sfxTrack = trackFor(mix, "sfx");
  const musicVolume = trackMuted(mix, "music", mix?.muteMusic) ? 0 : trackVolume(mix, "music", (voiceSrc ? 0.66 : 0.8) * (mix?.musicVol ?? 1));
  const voiceVolume = trackMuted(mix, "voice", mix?.muteVoice) ? 0 : trackVolume(mix, "voice", 1.05 * (mix?.voiceVol ?? 1));
  const sfxMul = trackMuted(mix, "sfx", mix?.muteSfx) ? 0 : trackVolume(mix, "sfx", mix?.sfxVol ?? 1);
  // C4: auto-duck the music under voice. Only when explicitly enabled and a voice
  // track is present; otherwise the envelope is a constant 1 (no change).
  const duckEnabled = !!mix?.duck?.enabled && !!voiceSrc && voiceVolume > 0;
  const duckEnvelope = useMemo(
    () => (duckEnabled ? buildDuckEnvelope(words, mix!.duck!, fps, durationInFrames) : null),
    [duckEnabled, words, mix?.duck, fps, durationInFrames],
  );

  // M2 (§4.1): the storyboard-level master grade (GlobalGrade), composited over
  // the whole visual stack AFTER the per-scene grades — a project trim. Absent /
  // identity ⇒ "" ⇒ no <GradePipeline> def and the wrapper filter is the legacy
  // `contrast(...)` (or undefined), so a grade-less storyboard renders identically.
  const globalGrade = (storyboard as any).grade;
  const globalGradeId = gradeToFilterId(globalGrade, "global");
  const legacyContrast = studio.grade.contrast !== 1 ? `contrast(${studio.grade.contrast})` : "";
  const stackFilter = [legacyContrast, globalGradeId ? `url(#${globalGradeId})` : ""].filter(Boolean).join(" ") || undefined;

  // M13 (§4.4): the POST-SCOPE effect graph composites over the whole visual stack
  // (background + scenes + the filmic look), OUTSIDE the scene sequencer. When
  // `storyboard.comp` is absent the graph is undefined and <CompositeGraph> renders
  // its children VERBATIM — no wrapper, no filter, no overlay — so the default look
  // is BYTE-IDENTICAL to today. (Captions/treatment/audio stay outside the wrap,
  // exactly as they sat outside the gate-weave stack before.)
  const postComp = (storyboard as any).comp as import("@os/schemas").EffectGraph | undefined;

  return (
    <AbsoluteFill style={{ backgroundColor: theme.bg, fontFamily: displayFont, "--font-display": displayFont, "--font-mono": monoFont } as React.CSSProperties}>
      {/* M2: the global grade <filter> def (mounted once; absent when identity). */}
      {globalGradeId && <GradePipeline grade={globalGrade} id={globalGradeId} />}
      {/* M13: post-scope graph wraps the gate-weave visual stack. Absent comp ⇒ identity. */}
      <CompositeGraph graph={postComp} w={width} h={height} frame={frame} durF={durationInFrames}>
      {/* visual stack drifts with a sub-pixel gate weave; captions/treatment stay locked */}
      <AbsoluteFill style={{ transform: gateWeave(frame), filter: stackFilter }}>
        <CinematicBackground theme={theme} w={width} h={height} frame={frame} energy={(bgVariant === "tactical" || bgVariant === "newsroom") ? mood.accent : accent} variant={bgVariant} seed={bgSeed} />
        <AbsoluteFill>
        {/* M0: manual crossfade sequencer (was <TransitionSeries>) — see SceneSequencer.
            Frame offsets are byte-identical to the old TransitionSeries timeline and
            totalFrames() is unchanged, so captions/voice/duck/sfx/beats stay in sync. */}
        <SceneSequencer
          scenes={scenes}
          themeName={storyboard.theme}
          durFs={durFs}
          trFs={trFs}
          brolls={brollsForVisibleScenes ?? undefined}
          pulse={pulse}
          accent={accent}
          motion={studio.motion}
          moodId={moodId}
          studio={studio}
          outro={<Outro themeName={storyboard.theme} logo={channelLogo} handle={channelHandle} site={channelSite} socials={channelSocials} accent={accent} />}
        />
        </AbsoluteFill>
        <ColorGrade grade={{ ...studio.grade, bloom: studio.grade.bloom * studio.treatment.bloomScale }} tint={studio.tint} tintOpacity={studio.tintOpacity} tintBlend={studio.tintBlend} bloomHue={studio.bloomHue} />
      </AbsoluteFill>
      </CompositeGraph>
      {mix?.subtitles?.enabled === false ? null : words && words.length && mix?.subtitles?.mode !== "lines" ? (
        <Karaoke words={words} themeName={storyboard.theme} style={mix?.subtitles?.preset ?? mix?.captionStyle ?? "pop"} accent={accent} settings={mix?.subtitles} lineStyles={captionLineStyles} />
      ) : (
        <SubtitleLayer cues={subtitles} themeName={storyboard.theme} settings={mix?.subtitles} />
      )}
      <CinematicTreatment w={width} h={height} grain={studio.grain} treatment={studio.treatment} />
      <ProgressBar themeName={storyboard.theme} accent={accent} />
      <ChromaDefs amount={pulse * 3.5} />
      {/* M8: evalAutomation replaces fadeVolume — it folds the per-track `gain`
          AutoCurve + any per-clip mix.clips[] gain over the fade value. With no
          gain curve + no clip targeting the track it returns the IDENTICAL fade
          value, so a legacy mix renders byte-for-byte unchanged. SFX clips live in
          their own <Sequence> frame-space, so per-clip automation (timeline-scoped)
          isn't applied to them — they keep the plain fade over their 22-frame hit. */}
      {musicSrc && musicVolume > 0 && <Audio src={staticFile(musicSrc)} playbackRate={trackSpeed(mix, "music")} volume={(f) => evalAutomation(f, durationInFrames, fps, musicTrack, musicVolume * musicArc(f, durationInFrames) * (duckEnvelope ? duckEnvelope(f) : 1), mix?.clips)} />}
      {voiceSrc && voiceVolume > 0 && <Audio src={staticFile(voiceSrc)} playbackRate={trackSpeed(mix, "voice")} volume={(f) => evalAutomation(f, durationInFrames, fps, voiceTrack, voiceVolume, mix?.clips)} />}
      {sfxMul > 0 &&
        (sfx ?? []).map((c, i) => (
          <Sequence key={`sfx${i}`} from={Math.max(0, c.atF)} durationInFrames={22}>
            <Audio src={staticFile(c.src)} playbackRate={trackSpeed(mix, "sfx")} volume={(f) => evalAutomation(f, 22, fps, sfxTrack, (c.vol ?? 0.5) * sfxMul)} />
          </Sequence>
        ))}
    </AbsoluteFill>
  );
};
