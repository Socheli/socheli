import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

import type { TrackData, EffectGraph, EffectNode } from "@os/schemas";
import { TrackData as TrackDataSchema, EffectGraph as EffectGraphSchema } from "@os/schemas";
import { loadItem, saveItem, logLine } from "../store.ts";
import {
  resolveVideoFile,
  probeVideo,
  durationFromProbe,
  rawFrame,
} from "../editor-tools.ts";

/* creative/tracking.ts — motion TRACKING for the compositor (DaVinci spine §4.4, M15).
 *
 * Two operations, both BEST-EFFORT and FAIL-OPEN (opencv may be absent; ffmpeg may
 * be an old build without vidstab; there may be no render at all):
 *
 *   compTrack(id, region, opts) → TrackData
 *     Track a point/region across the run's rendered frames and emit a per-frame
 *     pixel position ({frame,x,y}). We try, in descending order of robustness:
 *       1. ffmpeg `vidstabdetect` GLOBAL-motion transforms (when the build has it):
 *          a robust whole-frame translation per frame, parsed from its transforms
 *          file, integrated onto the region's start point — the camera/scene drift
 *          the region rides with.
 *       2. A coarse per-frame BLOCK MATCH on downscaled raw RGB frames (reusing the
 *          editor's rawFrame primitive): for each sampled frame, search a small
 *          window around the previous point for the translation that best matches a
 *          luma patch from the prior frame. This is the same evidence the compositor
 *          already produces (dense frames + motion deltas), turned into a coarse
 *          tracker — no extra dependency.
 *       3. A SINGLE STATIC point at the region centre, noted "static fallback (no
 *          tracker)", when neither tracker can run (no render / no ffmpeg / a tiny
 *          clip). The graph still gets a valid TrackData; the layer simply doesn't
 *          move.
 *     Every emitted point is clamped to the frame; the sample count is capped so a
 *     long clip can't explode the track.
 *
 *   trackAttach(id, sceneIndex, nodeId, track) → { changed }
 *     Attach a comp node's TRANSFORM to a TrackData: we convert the track's pixel
 *     positions into `transform`-node KEYFRAMES on `tx`/`ty` (the same prop names
 *     the renderer's transform node reads + animates via resolveParamTracks), so an
 *     element rides the tracked motion. `track_attach` is a no-op in the renderer
 *     (it needs precomputed data, never computed in React); we therefore retype the
 *     attached node to `transform` and write the keyframes there — the schema-real,
 *     renderable expression of "pin this layer to the motion". Locked scene → skip;
 *     re-parsed through EffectGraph before persist; never throws.
 *
 * Determinism: tracking runs OFFLINE here (frames decoded once), producing a fixed
 * TrackData; the React render only interpolates the precomputed keyframes — so the
 * render stays deterministic (the roadmap's hard rule). */

/* A pixel rectangle/point to track, given in NORMALIZED [0,1] coords (resolution-
   independent — a region authored on a thumbnail tracks the same place at 1080p).
   x/y is the region's anchor (centre by default); w/h its extent (0 → a point). */
export type TrackRegion = {
  x?: number; // 0..1 centre x (default 0.5)
  y?: number; // 0..1 centre y (default 0.5)
  w?: number; // 0..1 width  (default 0.2)
  h?: number; // 0..1 height (default 0.2)
};

export type TrackOpts = {
  /** frames-per-second to sample the track at (coarse is fine; clamped 1..12). */
  sampleFps?: number;
  /** decode width for the coarse block-match path (clamped 96..512). */
  width?: number;
  /** hard cap on emitted samples so a long clip can't explode the track. */
  maxSamples?: number;
};

export type TrackResult = {
  track: TrackData;
  method: "vidstab" | "block_match" | "static_fallback";
  note: string;
  sampleFps: number;
  frameCount: number;
};

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
const round2 = (n: number) => Number(n.toFixed(2));

/* Resolve the region anchor + patch extent into source PIXELS at a given frame
   resolution. Defaults to the centre with a ~20% patch. */
function resolveRegion(region: TrackRegion | undefined, w: number, h: number) {
  const cx = clamp(Number(region?.x ?? 0.5), 0, 1) * w;
  const cy = clamp(Number(region?.y ?? 0.5), 0, 1) * h;
  const pw = clamp(Number(region?.w ?? 0.2), 0, 1) * w;
  const ph = clamp(Number(region?.h ?? 0.2), 0, 1) * h;
  return { cx, cy, pw, ph };
}

/* ─── Path 1: ffmpeg vidstabdetect global-motion transforms ───────────────────
   vidstabdetect writes a transforms file (one line per frame) with the estimated
   global translation/rotation. We parse the per-frame (dx,dy) in PIXELS of the
   SOURCE resolution and integrate them onto the region's start point. Returns null
   (fail-open) when the build lacks vidstab, the file is empty/unparseable, or the
   probe fails — the caller then tries the block-match path. */
function trackViaVidstab(
  video: string,
  region: TrackRegion | undefined,
  sampleFps: number,
  maxSamples: number,
): { points: { frame: number; x: number; y: number }[]; srcW: number; srcH: number } | null {
  let srcW = 1080;
  let srcH = 1920;
  try {
    const meta = probeVideo(video);
    const stream = meta.streams?.find((s: any) => s.codec_type === "video");
    srcW = Number(stream?.width ?? srcW);
    srcH = Number(stream?.height ?? srcH);
  } catch {
    /* keep defaults — fail-open */
  }

  const dir = mkdtempSync(join(tmpdir(), "soli-track-"));
  const trf = join(dir, "transforms.trf");
  try {
    // detect pass only: -f null discards output; the transforms file is the product.
    const res = spawnSync(
      "ffmpeg",
      ["-i", video, "-vf", `fps=${sampleFps},vidstabdetect=shakiness=5:accuracy=15:result=${trf}`, "-an", "-f", "null", "-"],
      { encoding: "utf8" },
    );
    // A build without libvidstab fails here; treat any non-zero / missing file as
    // "tracker unavailable" and fall through to the block-match path.
    if (res.status !== 0 || !existsSync(trf)) return null;
    const text = readFileSync(trf, "utf8");
    // The .trf format varies by ffmpeg version; we read whatever per-frame (x,y)
    // pairs we can. Newer builds emit lines like "Frame N (...): ... x=.. y=..";
    // older binary-ish files won't parse → null (fail-open). We extract numeric
    // x=/y= pairs in order; if none, bail.
    const pairs = [...text.matchAll(/x=(-?[0-9.]+)\s+y=(-?[0-9.]+)/g)].map((m) => ({
      dx: Number(m[1]),
      dy: Number(m[2]),
    }));
    if (pairs.length < 2) return null;

    const { cx, cy } = resolveRegion(region, srcW, srcH);
    const points: { frame: number; x: number; y: number }[] = [];
    let x = cx;
    let y = cy;
    const stride = Math.max(1, Math.ceil(pairs.length / maxSamples));
    for (let i = 0; i < pairs.length; i += stride) {
      // vidstab's (x,y) is the global shift; the region rides it (subtract = the
      // content moved by +dx, so a pinned point appears to move by +dx too).
      x = clamp(cx + pairs[i].dx, 0, srcW);
      y = clamp(cy + pairs[i].dy, 0, srcH);
      points.push({ frame: Math.floor(i / 1), x: round2(x), y: round2(y) });
    }
    // Re-index frames densely (0..n) so consumers see contiguous frame numbers.
    points.forEach((p, i) => (p.frame = i));
    return points.length >= 2 ? { points, srcW, srcH } : null;
  } catch {
    return null;
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  }
}

/* ─── Path 2: coarse per-frame block match on raw RGB frames ───────────────────
   Reusing the editor's rawFrame primitive (the SAME decode path editor_video_
   evidence uses), we sample frames at sampleFps and, for each, search a small
   window around the previous point for the (dx,dy) that minimises the luma SAD of
   a patch vs the previous frame. A coarse tracker, no opencv — good enough to ride
   a moving subject for a composited element. Fail-open: a decode error stops the
   track early (we keep what we have); fewer than 2 points → null (caller falls back
   to static). */
function trackViaBlockMatch(
  video: string,
  region: TrackRegion | undefined,
  durationSec: number,
  sampleFps: number,
  width: number,
  maxSamples: number,
): { points: { frame: number; x: number; y: number }[]; srcW: number; srcH: number } | null {
  const total = Math.min(maxSamples, Math.max(2, Math.floor(durationSec * sampleFps)));
  if (total < 2 || durationSec <= 0) return null;

  // Decode the first frame to learn the working resolution + seed the patch.
  let first: { width: number; height: number; data: Buffer };
  try {
    first = rawFrame(video, 0, width);
  } catch {
    return null;
  }
  const W = first.width;
  const H = first.height;
  const { cx, cy, pw, ph } = resolveRegion(region, W, H);

  // Patch half-extents (kept small for speed) + a search radius around the prior
  // point. Both clamped so a "point" region still has a usable patch.
  const halfW = clamp(Math.round(pw / 2) || Math.round(W * 0.08), 4, Math.floor(W / 3));
  const halfH = clamp(Math.round(ph / 2) || Math.round(H * 0.08), 4, Math.floor(H / 3));
  const search = clamp(Math.round(Math.max(W, H) * 0.06), 4, 28);

  const lumaAt = (data: Buffer, x: number, y: number) => {
    const i = (clamp(y, 0, H - 1) * W + clamp(x, 0, W - 1)) * 3;
    return 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
  };

  const points: { frame: number; x: number; y: number }[] = [{ frame: 0, x: round2(cx), y: round2(cy) }];
  let prev = first;
  let px = cx;
  let py = cy;
  const step = 4; // sub-sample the patch grid for speed (every 4px)

  for (let f = 1; f < total; f++) {
    const atSec = (f / sampleFps);
    let cur: { width: number; height: number; data: Buffer };
    try {
      cur = rawFrame(video, atSec, width);
    } catch {
      break; // decode failed — keep the track we have so far (fail-open)
    }
    if (cur.width !== W || cur.height !== H) break; // resolution drift — stop cleanly

    // Search the window for the (dx,dy) minimising luma SAD of the patch sampled
    // from the PREVIOUS frame at (px,py) vs the CURRENT frame at (px+dx,py+dy).
    let best = Number.POSITIVE_INFINITY;
    let bestDx = 0;
    let bestDy = 0;
    for (let dy = -search; dy <= search; dy += 2) {
      for (let dx = -search; dx <= search; dx += 2) {
        let sad = 0;
        let n = 0;
        for (let oy = -halfH; oy <= halfH; oy += step) {
          for (let ox = -halfW; ox <= halfW; ox += step) {
            const a = lumaAt(prev.data, Math.round(px + ox), Math.round(py + oy));
            const b = lumaAt(cur.data, Math.round(px + dx + ox), Math.round(py + dy + oy));
            sad += Math.abs(a - b);
            n++;
          }
        }
        sad = sad / Math.max(1, n);
        // Prefer the centre on ties (penalise large moves slightly) so a flat/empty
        // patch doesn't wander — restraint, like the rest of the compositor.
        sad += (Math.abs(dx) + Math.abs(dy)) * 0.02;
        if (sad < best) {
          best = sad;
          bestDx = dx;
          bestDy = dy;
        }
      }
    }
    px = clamp(px + bestDx, 0, W);
    py = clamp(py + bestDy, 0, H);
    points.push({ frame: f, x: round2(px), y: round2(py) });
    prev = cur;
  }

  return points.length >= 2 ? { points, srcW: W, srcH: H } : null;
}

/* ─── compTrack — the public tracker (best-effort, fail-open) ─────────────────
   Try vidstab → block-match → a single static point. Always returns a valid,
   schema-parsed TrackData; never throws. */
export function compTrack(id: string, region?: TrackRegion, opts: TrackOpts = {}): TrackResult {
  const sampleFps = clamp(Number(opts.sampleFps ?? 6), 1, 12);
  const width = Math.round(clamp(Number(opts.width ?? 240), 96, 512));
  const maxSamples = Math.round(clamp(Number(opts.maxSamples ?? 240), 8, 1200));

  let video: string | null = null;
  try {
    video = resolveVideoFile(loadItem(id) as any);
  } catch {
    video = null;
  }

  // ── No render → a single static point (still a valid TrackData). ──
  if (!video || !existsSync(video)) {
    return staticFallback(region, "static fallback (no tracker): no rendered video to track");
  }

  let durationSec = 0;
  try {
    durationSec = durationFromProbe(probeVideo(video));
  } catch {
    durationSec = 0;
  }

  // 1) vidstab global motion (most robust when the build has it).
  const viaStab = trackViaVidstab(video, region, sampleFps, maxSamples);
  if (viaStab) {
    const track = safeParseTrack(viaStab.points);
    if (track.points.length >= 2) {
      logLine(loadItem(id), `comp-track: vidstab global motion (${track.points.length} samples @ ${sampleFps}fps)`);
      return { track, method: "vidstab", note: "ffmpeg vidstabdetect global motion", sampleFps, frameCount: track.points.length };
    }
  }

  // 2) coarse block-match on raw frames (no extra dependency).
  if (durationSec > 0) {
    const viaBlock = trackViaBlockMatch(video, region, durationSec, sampleFps, width, maxSamples);
    if (viaBlock) {
      const track = safeParseTrack(viaBlock.points);
      if (track.points.length >= 2) {
        logLine(loadItem(id), `comp-track: block-match (${track.points.length} samples @ ${sampleFps}fps)`);
        return { track, method: "block_match", note: "coarse luma block-match tracker", sampleFps, frameCount: track.points.length };
      }
    }
  }

  // 3) static fallback.
  return staticFallback(region, "static fallback (no tracker): neither vidstab nor block-match produced a usable track");
}

/* A single static point at the region anchor — the always-valid fallback. We emit
   it at a nominal 1080×1920 anchor when we couldn't decode a real resolution, so a
   downstream attach has a sane absolute pixel to pin to. */
function staticFallback(region: TrackRegion | undefined, note: string): TrackResult {
  const { cx, cy } = resolveRegion(region, 1080, 1920);
  const track = safeParseTrack([{ frame: 0, x: round2(cx), y: round2(cy) }]);
  return { track, method: "static_fallback", note, sampleFps: 0, frameCount: track.points.length };
}

/* Parse points through the TrackData schema (drops any malformed sample, never
   throws). A parse failure yields an empty track rather than crashing the pass. */
function safeParseTrack(points: { frame: number; x: number; y: number }[]): TrackData {
  try {
    return TrackDataSchema.parse({ points });
  } catch {
    try {
      // Coerce + re-filter to integers/finite, then re-parse.
      const clean = points
        .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y))
        .map((p, i) => ({ frame: Number.isInteger(p.frame) && p.frame >= 0 ? p.frame : i, x: p.x, y: p.y }));
      return TrackDataSchema.parse({ points: clean });
    } catch {
      return { points: [] } as TrackData;
    }
  }
}

/* ─── trackAttach — pin a comp node's transform to a TrackData ────────────────
   Convert a TrackData's pixel positions into `tx`/`ty` keyframes on the target
   node, retyped to `transform` (the renderable expression of track_attach). The
   keyframe `t` is normalized 0..1 over the scene's frame span; `tx`/`ty` are pixel
   OFFSETS from the track's first point (so the element starts where authored and
   then RIDES the motion). Locked scene → skipped; re-parsed before persist. */
export function trackAttach(
  id: string,
  sceneIndex: number,
  nodeId: string,
  track: TrackData,
): { ok: boolean; changed: string[] } {
  let item: ReturnType<typeof loadItem>;
  try {
    item = loadItem(id);
  } catch (e) {
    return { ok: false, changed: [`run ${id} not loadable — ${e instanceof Error ? e.message : String(e)}`] };
  }
  const scenes: any[] = item.storyboard?.scenes ?? [];
  const scope: "scene" | "post" = Number.isInteger(sceneIndex) && sceneIndex >= 0 ? "scene" : "post";
  const scene = scope === "scene" ? scenes[sceneIndex] : null;

  if (scope === "scene" && !scene) return { ok: false, changed: [`scene ${sceneIndex} not found`] };
  if (scene?.locked) return { ok: false, changed: [`scene ${sceneIndex}: locked — skipped`] };

  const rawGraph: any = scope === "post" ? item.storyboard?.comp : scene?.style?.comp;
  const nodes: EffectNode[] = Array.isArray(rawGraph?.nodes) ? rawGraph.nodes.map((n: any) => ({ ...n })) : [];
  const target = nodes.find((n) => n.id === nodeId);
  if (!target) return { ok: false, changed: [`node ${nodeId} not found in ${scope} graph`] };

  const pts = (track?.points ?? []).filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
  if (pts.length < 2) {
    return { ok: false, changed: [`track has < 2 points — nothing to ride (static); left ${nodeId} unchanged`] };
  }

  const x0 = pts[0].x;
  const y0 = pts[0].y;
  const lastFrame = pts[pts.length - 1].frame || pts.length - 1;
  // Build tx/ty keyframe tracks. Normalize frame→t over the track span; v is the
  // pixel OFFSET from the anchor, clamped to the transform node's render band.
  const txPoints = pts.map((p) => ({
    t: clamp(lastFrame > 0 ? p.frame / lastFrame : 0, 0, 1),
    v: clamp(round2(p.x - x0), -2000, 2000),
    ease: "linear" as const,
  }));
  const tyPoints = pts.map((p) => ({
    t: clamp(lastFrame > 0 ? p.frame / lastFrame : 0, 0, 1),
    v: clamp(round2(p.y - y0), -2000, 2000),
    ease: "linear" as const,
  }));

  // Retype the node to `transform` (track_attach is a renderer no-op — the
  // renderable form is a keyframed transform) and attach the tracks. Preserve any
  // existing non-tx/ty keyframe tracks the node already had.
  target.type = "transform";
  const keptKf = (target.keyframes ?? []).filter((k: any) => k.prop !== "tx" && k.prop !== "ty");
  target.keyframes = [...keptKf, { prop: "tx", points: txPoints }, { prop: "ty", points: tyPoints }];
  // Seed static params so the node is non-identity even before interpolation.
  target.params = { ...(target.params ?? {}), tx: txPoints[0].v, ty: tyPoints[0].v };

  // Persist the graph back through the schema (malformed → skip, identity-safe).
  let parsed: z.infer<typeof EffectGraph> | undefined;
  try {
    parsed = nodes.length ? EffectGraphSchema.parse({ nodes, output: rawGraph?.output ?? nodes[nodes.length - 1].id }) : undefined;
  } catch {
    return { ok: false, changed: [`graph re-parse failed — left ${nodeId} unchanged`] };
  }

  if (scope === "post") {
    (item as any).storyboard = { ...((item as any).storyboard ?? {}), comp: parsed };
  } else {
    scene.style = { ...(scene.style ?? {}), comp: parsed };
  }
  logLine(item, `comp-track-attach: ${nodeId} (scene ${sceneIndex}) rides ${pts.length}-sample track`);
  saveItem(item); // saveItem stamps updatedAt

  return {
    ok: true,
    changed: [`node ${nodeId} → transform riding a ${pts.length}-sample track (Δ ${round2(pts[pts.length - 1].x - x0)}px,${round2(pts[pts.length - 1].y - y0)}px)`],
  };
}
