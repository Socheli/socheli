/**
 * frame-transcript.ts — Editor Frame-Control B4: map transcript WORDS onto
 * TIMELINE frames.
 *
 * understanding.transcript.words carry SOURCE-second timing (Whisper word-level
 * output over item.source). The timeline cuts that source into clips, so a word
 * is only on the timeline if its source moment survived the cut — and lands at a
 * different time than its source second. This module re-anchors each word through
 * the clip source windows (same arithmetic as render.ts sourceToTimelineSec),
 * converts to timeline frames, and returns the words clipped to [startFrame,
 * endFrame].
 *
 * Fail-open: no transcript / no timeline → empty words.
 */

import type { Clip, ContentItem, Timeline, Track, TWord } from "@os/schemas";

import { loadItem } from "../store.ts";
import { resolveFps } from "./frame-index.ts";

const toFrame = (sec: number, fps: number) => Math.max(0, Math.round(sec * fps));

type SourceClip = { inSec: number; outSec: number; startSec: number; speed: number };

/** The picture clips that cut the SOURCE, in render.ts' shape. Used to re-anchor
 *  a source second onto the timeline. */
function sourceClips(timeline: Timeline | undefined): SourceClip[] {
  if (!timeline?.tracks) return [];
  const out: SourceClip[] = [];
  for (const track of timeline.tracks as Track[]) {
    if (track.kind !== "video" && track.kind !== "overlay") continue;
    for (const clip of track.clips ?? []) {
      if (clip.enabled === false) continue;
      const inSec = clip.inSec ?? 0;
      const speed = clip.speed ?? 1;
      const durationSec = clip.durationSec ?? 0;
      const outSec = clip.outSec ?? inSec + durationSec * speed;
      out.push({ inSec, outSec, startSec: clip.startSec ?? 0, speed });
    }
  }
  return out;
}

/** Map a SOURCE second onto the TIMELINE through the clip windows (mirrors
 *  render.ts sourceToTimelineSec). null = that source moment was cut away. When
 *  there are NO source-cutting clips (a storyboard-seeded timeline), the source
 *  IS the timeline → identity. */
function sourceToTimelineSec(t: number, clips: SourceClip[]): number | null {
  if (!clips.length) return t; // identity: nothing cut the source
  for (const c of clips) {
    if (t >= c.inSec && t < c.outSec) return c.startSec + (t - c.inSec) / (c.speed || 1);
  }
  return null;
}

export type WordsInRange = {
  id: string;
  fps: number;
  startFrame: number;
  endFrame: number;
  words: {
    word: string;
    /** timeline frames this word occupies after re-anchoring. */
    fromFrame: number;
    toFrame: number;
    fromSec: number;
    toSec: number;
    /** original source timing (for provenance). */
    sourceFromSec: number;
    sourceToSec: number;
    conf?: number;
  }[];
};

/**
 * Transcript words whose re-anchored TIMELINE frames overlap [startFrame,
 * endFrame]. Each word is mapped from source time through the clip windows;
 * words cut away are dropped.
 */
export function wordsInFrameRange(id: string, startFrame: number, endFrame: number): WordsInRange {
  const item = loadItem(id);
  return wordsInFrameRangeFor(item as ContentItem, startFrame, endFrame);
}

/** Item-in-hand variant (avoids a reload when the caller already has the item). */
export function wordsInFrameRangeFor(
  item: ContentItem,
  startFrame: number,
  endFrame: number,
): WordsInRange {
  const fps = resolveFps(item);
  const a = Math.max(0, Math.round(Math.min(startFrame, endFrame)));
  const b = Math.max(a, Math.round(Math.max(startFrame, endFrame)));
  const timeline = (item as any).timeline as Timeline | undefined;
  const tWords = ((item as any)?.understanding?.transcript?.words ?? []) as TWord[];

  const clips = sourceClips(timeline);
  const out: WordsInRange["words"] = [];
  for (const w of tWords) {
    const tlFrom = sourceToTimelineSec(w.startSec, clips);
    if (tlFrom == null) continue;
    // Map the end through the same window; if the end fell outside the clip,
    // clamp it to the word's mapped start + its played duration.
    const mappedEnd = sourceToTimelineSec(Math.max(w.startSec, w.endSec - 1e-3), clips);
    const tlTo = mappedEnd != null ? mappedEnd : tlFrom + Math.max(0.04, w.endSec - w.startSec);
    const fromFrame = toFrame(tlFrom, fps);
    const toF = Math.max(fromFrame, toFrame(tlTo, fps));
    if (toF < a || fromFrame > b) continue; // no overlap with the range
    out.push({
      word: w.word,
      fromFrame,
      toFrame: toF,
      fromSec: Number(tlFrom.toFixed(3)),
      toSec: Number(tlTo.toFixed(3)),
      sourceFromSec: Number(w.startSec.toFixed(3)),
      sourceToSec: Number(w.endSec.toFixed(3)),
      conf: w.conf,
    });
  }
  out.sort((x, y) => x.fromFrame - y.fromFrame);
  return { id: (item as any).id, fps, startFrame: a, endFrame: b, words: out };
}
