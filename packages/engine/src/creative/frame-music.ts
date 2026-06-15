/**
 * frame-music.ts — Editor Frame-Control B4: the MUSIC context inside a TIMELINE
 * frame range.
 *
 * Sources of truth (precedence):
 *   1. understanding.music (MusicAnalysis from the deep "music" pass) — beats,
 *      sections, drops, energyCurve, all in SECONDS.
 *   2. fallback: musicBeatFrames(item.musicSrc, fps) — the proven python beat
 *      tracker — when no deep grid exists but the run carries a bed.
 *
 * Everything is returned in FRAME units (sec*fps) clipped to [startFrame,
 * endFrame], so the editor can "cut on the drop" / "split on the beat" entirely
 * in frame space. Beats/sections/energy in the music understanding are timed in
 * the SAME source time as the soundtrack the run renders (a music bed plays from
 * t0 on the timeline), so for a music BED the source time == timeline time and we
 * use it directly.
 *
 * Fail-open: no music understanding and no bed → empty arrays, never throws.
 */

import type { ContentItem, MusicAnalysis } from "@os/schemas";

import { loadItem } from "../store.ts";
import { musicBeatFrames } from "../media.ts";
import { resolveFps } from "./frame-index.ts";

const toFrame = (sec: number, fps: number) => Math.max(0, Math.round(sec * fps));
const toSec = (frame: number, fps: number) => Number((frame / Math.max(1, fps)).toFixed(3));

export type MusicInRange = {
  id: string;
  fps: number;
  startFrame: number;
  endFrame: number;
  hasMusic: boolean;
  tempoBpm?: number;
  /** beat onsets, in timeline frames, inside the range. */
  beats: number[];
  /** drops / big-energy hits, in timeline frames, inside the range. */
  drops: number[];
  /** sections (music/speech/mixed/silence) overlapping the range, in frames. */
  sections: { startFrame: number; endFrame: number; kind: string; note?: string }[];
  /** coarse energy samples overlapping the range, in frames. */
  energy: { atFrame: number; atSec: number; energy: number }[];
  /** where the beat grid came from. */
  source: "understanding" | "beat-tracker" | "none";
};

/**
 * Beats / sections / drops / energy that overlap the timeline frame range, in
 * frame units. Use item-in-hand variant when you already loaded the item.
 */
export function queryMusicInFrameRange(id: string, startFrame: number, endFrame: number): MusicInRange {
  const item = loadItem(id);
  return queryMusicInFrameRangeFor(item as ContentItem, startFrame, endFrame);
}

export function queryMusicInFrameRangeFor(
  item: ContentItem,
  startFrame: number,
  endFrame: number,
): MusicInRange {
  const fps = resolveFps(item);
  const a = Math.max(0, Math.round(Math.min(startFrame, endFrame)));
  const b = Math.max(a, Math.round(Math.max(startFrame, endFrame)));
  const music = (item as any)?.understanding?.music as MusicAnalysis | undefined;

  const inRangeF = (sec: number) => {
    const f = toFrame(sec, fps);
    return f >= a && f <= b ? f : null;
  };

  // 1) Prefer the deep music understanding.
  if (music) {
    const beats = (music.beats ?? [])
      .map(inRangeF)
      .filter((f): f is number => f != null);
    const drops = (music.drops ?? [])
      .map(inRangeF)
      .filter((f): f is number => f != null);
    const sections = (music.sections ?? [])
      .map((s) => ({ startF: toFrame(s.startSec, fps), endF: toFrame(s.endSec, fps), s }))
      .filter((x) => x.endF >= a && x.startF <= b)
      .map((x) => ({ startFrame: x.startF, endFrame: x.endF, kind: x.s.kind, note: x.s.note }));
    const energy = (music.energyCurve ?? [])
      .map((e) => ({ f: toFrame(e.atSec, fps), e }))
      .filter((x) => x.f >= a && x.f <= b)
      .map((x) => ({ atFrame: x.f, atSec: toSec(x.f, fps), energy: x.e.energy }));
    return {
      id: (item as any).id,
      fps,
      startFrame: a,
      endFrame: b,
      hasMusic: music.hasMusic ?? (beats.length > 0 || sections.some((s) => s.kind === "music")),
      tempoBpm: music.tempoBpm,
      beats,
      drops,
      sections,
      energy,
      source: "understanding",
    };
  }

  // 2) Fallback: the proven beat tracker on the run's music bed (frames already).
  const musicSrc = (item as { musicSrc?: string }).musicSrc;
  if (musicSrc) {
    const allBeatFrames = musicBeatFrames(musicSrc, fps);
    const beats = allBeatFrames.filter((f) => f >= a && f <= b);
    return {
      id: (item as any).id,
      fps,
      startFrame: a,
      endFrame: b,
      hasMusic: beats.length > 0,
      beats,
      drops: [],
      sections: [],
      energy: [],
      source: "beat-tracker",
    };
  }

  return {
    id: (item as any).id,
    fps,
    startFrame: a,
    endFrame: b,
    hasMusic: false,
    beats: [],
    drops: [],
    sections: [],
    energy: [],
    source: "none",
  };
}
