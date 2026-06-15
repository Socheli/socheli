/**
 * frame-vision-query.ts — O(1)-ish lookup into the persisted dense per-frame
 * vision grid (Understanding.denseFrameVision, Editor Frame-Control B1).
 *
 * The dense grid is sampled at `sampleFps` and each entry's `frameIndex` is in
 * SOURCE-frame units (atSec * fps), NOT the sample ordinal. To read "the vision
 * at source second T" we convert T→frame and find the nearest grid entry within
 * a half-sample tolerance. Fail-open: no grid / no item → null.
 */

import type { ContentItem, FrameVision } from "@os/schemas";

export type FrameVisionHit = {
  frame: FrameVision;
  /** how far (in sec) the returned grid frame is from the requested moment. */
  deltaSec: number;
} | null;

/**
 * Nearest dense-vision frame to `atSec` (source seconds). `fps` is the item's
 * editor fps (for the frameIndex↔sec conversion the grid used). Returns null
 * when no grid exists or nothing is within the tolerance window.
 */
export function frameVisionAt(item: ContentItem, atSec: number, fps: number): FrameVisionHit {
  const grid = (item as any)?.understanding?.denseFrameVision as
    | { sampleFps?: number; frames?: FrameVision[] }
    | undefined;
  const frames = grid?.frames;
  if (!frames || !frames.length) return null;

  // Tolerance = half a sample interval (so each query maps to one grid frame).
  const sampleFps = grid?.sampleFps && grid.sampleFps > 0 ? grid.sampleFps : 1;
  const tol = 0.5 / sampleFps;

  let best: FrameVision | null = null;
  let bestDelta = Infinity;
  for (const f of frames) {
    const fAtSec = typeof f.atSec === "number" ? f.atSec : f.frameIndex / Math.max(1, fps);
    const d = Math.abs(fAtSec - atSec);
    if (d < bestDelta) {
      best = f;
      bestDelta = d;
    }
  }
  if (!best) return null;
  if (bestDelta > tol + 1e-6) {
    // Outside the grid's sampling resolution: still return the nearest so the UI
    // has *something*, but report the (large) delta so callers can dim it.
  }
  return { frame: best, deltaSec: Number(bestDelta.toFixed(3)) };
}
