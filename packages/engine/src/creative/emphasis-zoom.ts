/* ─── P3 — Emphasis punch-ins (auto-zoom on vocally-stressed words) ───────────
   WORLD-CLASS-EDITING §3. Detect the vocally-stressed word per minute and fire a
   subtle eased zoom-in (≈112%, 12-frame ease-in / 6-frame hold / 14-frame ease-out)
   that LANDS on the emphasized word, ≤3 big zooms/min, ≥6–8s apart and JITTERED so
   the cadence never reads robotic. Zoom windows are computed engine-side in TIMELINE
   frames and animated by the ONE transform wrapper in HybridPost.FootageSpine —
   the SOLE zoom animator (roadmap §3 Conflict A). FAIL-OPEN: any compute failure
   returns [] → a flat spine, byte-identical to today. */

import type { ContentItem, Timeline } from "@os/schemas";
import { perRegionRms } from "../editor-tools.ts";
// Conflict C: ONE emphasis heuristic, imported — never re-derive a stopword set here.
import { emphasisScore } from "./caption-style.ts";
// Conflict B: ONE downbeat grid + snapper, owned by P5 (beat-sync.ts). Punch-in
// zoom peaks snap through the SAME grid the cuts use. Fail-open (no bed ⇒ no-op).
import { resolveDownbeats, snapFrameToDownbeat } from "./beat-sync.ts";

export type ZoomWindow = {
  startF: number;
  peakF: number;
  holdF: number;
  endF: number;
  scale: number;
  originX: number;
  originY: number;
};

type VClip = { inSec?: number; outSec?: number; startSec?: number; durationSec?: number; speed?: number };
type ZoomOpts = {
  enabled?: boolean;
  scale?: number;
  maxPerMin?: number;
  minSpacingSec?: number;
  originX?: number;
  originY?: number;
};

const toFrame = (sec: number, fps: number) => Math.round(sec * fps);

/* Source-second → timeline-second through the cut V1 clips (same bridge captions
   use). Returns null when the source time was cut OUT of the montage so a punch-in
   on a removed word is dropped, never desynced. */
function sourceToTimelineSec(t: number, clips: VClip[]): number | null {
  for (const c of clips) {
    const inSec = c.inSec ?? 0;
    const outSec = c.outSec ?? inSec + (c.durationSec ?? 0) * (c.speed ?? 1);
    if (t >= inSec && t < outSec) return (c.startSec ?? 0) + (t - inSec) / (c.speed ?? 1);
  }
  return null;
}

function median(xs: number[]): number {
  const s = xs.filter(Number.isFinite).sort((a, b) => a - b);
  return s.length ? s[(s.length - 1) >> 1] : NaN;
}

// deterministic ±1.5s jitter from a word's source time (no Math.random → reproducible renders)
function jitter(t: number): number {
  const x = Math.sin(t * 99.137) * 43758.5453;
  return (x - Math.floor(x)) * 3 - 1.5;
}

export function computeZoomWindows(
  item: ContentItem,
  fps: number,
  footageClips: VClip[],
  opts?: ZoomOpts,
): ZoomWindow[] {
  if (opts?.enabled === false) return [];
  const timeline = item.timeline as Timeline | undefined;
  const src = ((item.source?.path ?? (item as { videoPath?: string }).videoPath ?? "") as string);
  if (!timeline || !src) return [];
  const capTrack = timeline.tracks.find((t) => t.kind === "text");
  if (!capTrack) return [];

  // 1. flatten enabled caption clips' words → {word, fromSec, toSec} in SOURCE seconds.
  const words: { word: string; fromSec: number; toSec: number }[] = [];
  for (const c of (capTrack.clips ?? [])) {
    if ((c as { enabled?: boolean }).enabled === false) continue;
    for (const w of ((c as { words?: { word: string; fromSec: number; toSec: number }[] }).words ?? [])) words.push(w);
  }
  if (words.length < 3) return [];

  // 2. per-word vocal energy (mean dB) over the SOURCE file — the EXACT probe
  //    understanding.ts uses for shot energy. FAIL-OPEN → flat spine.
  let rms: number[];
  try {
    rms = perRegionRms(src, words.map((w) => ({ startSec: w.fromSec, endSec: w.toSec }))).map((r) => r.rms);
  } catch {
    return [];
  }

  // 3. local-peak score per word: energy above the rolling ±8-word local median +
  //    the SHARED content weight (emphasisScore, Conflict C). highlights add weight.
  const highlights = (item.understanding?.highlights ?? []) as { startSec: number; endSec: number }[];
  const inHi = (t: number) => highlights.some((h) => t >= h.startSec && t < h.endSec);
  const scored = words
    .map((w, i) => {
      const lo = Math.max(0, i - 8), hi = Math.min(words.length, i + 9);
      const localMed = median(rms.slice(lo, hi));
      const eDb = Number.isFinite(rms[i]) && Number.isFinite(localMed) ? rms[i] - localMed : -99;
      const energy = Math.max(0, Math.min(1, eDb / 4));
      const mid = (w.fromSec + w.toSec) / 2;
      // emphasisScore is an unbounded length-ish score; normalize to 0..1 (cap ~12).
      const content = Math.min(1, emphasisScore(w.word, { inHighlight: inHi(mid) }) / 12);
      return { i, w, eDb, content, total: 0.7 * energy + 0.3 * content };
    })
    // a real vocal peak (≥+2dB over local median) AND a meaning-bearing word.
    .filter((s) => s.eDb >= 2.0 && s.content > 0);

  // 4. governor: greedy by score, ≤maxPerMin per 60s, ≥(minSpacing±jitter)s apart.
  const scale = Math.max(1.04, Math.min(1.25, opts?.scale ?? 1.12));
  const maxPerMin = opts?.maxPerMin ?? 3;
  const baseSpacing = opts?.minSpacingSec ?? 6.5;
  const originX = opts?.originX ?? 0.5, originY = opts?.originY ?? 0.42;
  const k = fps / 30; // research frame counts are @30fps
  const rampIn = Math.round(12 * k), holdF = Math.round(6 * k), rampOut = Math.round(14 * k);
  const accepted: { srcSec: number }[] = [];
  for (const s of [...scored].sort((a, b) => b.total - a.total)) {
    const t = (s.w.fromSec + s.w.toSec) / 2;
    const spacing = baseSpacing + jitter(t); // 6.5 ± 1.5 → 5–8s, never uniform
    if (accepted.some((a) => Math.abs(a.srcSec - t) < spacing)) continue;
    if (accepted.filter((a) => Math.abs(a.srcSec - t) <= 30).length >= maxPerMin) continue;
    accepted.push({ srcSec: t });
  }

  // 5. re-anchor source→timeline frames; drop any word cut out of the montage;
  //    snap the peak frame to the SHARED downbeat grid (Conflict B). Resolved once
  //    here; fail-open to [] (snapper is a no-op) when there's no music bed.
  const { downbeats, bpm } = resolveDownbeats(item, fps);
  const wins: ZoomWindow[] = [];
  for (const a of accepted) {
    const at = sourceToTimelineSec(a.srcSec, footageClips);
    if (at == null) continue;
    const peakF = snapFrameToDownbeat(toFrame(at, fps), downbeats, fps, bpm);
    const startF = Math.max(0, peakF - rampIn);
    const endF = peakF + holdF + rampOut;
    if (endF <= startF) continue;
    wins.push({ startF, peakF, holdF, endF, scale, originX, originY });
  }
  wins.sort((a, b) => a.startF - b.startF);

  // 6. de-overlap: a zoom must fully resolve before the next (belt-and-suspenders
  //    on top of the spacing rule).
  const out: ZoomWindow[] = [];
  for (const w of wins) {
    const prev = out[out.length - 1];
    if (prev && w.startF < prev.endF) continue;
    out.push(w);
  }
  return out;
}
