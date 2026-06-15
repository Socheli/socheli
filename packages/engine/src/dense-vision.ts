/* dense-vision.ts — DENSE per-frame VISION grid (Editor Frame-Control B1).
 *
 * Today vision is shot-level only (understanding-vision.ts describeShots →
 * item.understanding.perShot, one read per representative shot). This builds a
 * DENSE, uniformly-sampled grid: sample the ingested SOURCE at `sampleFps`, then
 * for each sampled frame record a FrameVision — cheap pixel metrics
 * (motion/quality/brightness) for EVERY frame, plus a Claude-vision semantic read
 * (description/subjects/onScreenText) for a CAPPED subset (cost control). The grid
 * is indexed by frameIndex (= round(atSec * fps)) for O(1) "what is at frame N".
 *
 * REUSE-FIRST: frame extraction is editor-tools.denseFrameScan (the same
 * evenly-strided frame stream the review path uses); per-frame metrics are
 * analyzeFramePixels on a rawFrame read; the semantic read batches frame paths
 * through understanding-vision.describeFrames (the proven `claude -p --add-dir`
 * vision path). Nothing new is plumbed.
 *
 * COST CONTROL (CLAUDE.md hard rule): vision is slow + paid. We describe at most
 * MAX_DESCRIBED_FRAMES frames, evenly spread across the grid; every other frame is
 * metrics-only. Batched FRAMES_PER_CALL per vision call.
 *
 * FAIL-OPEN, ALWAYS: no source on disk → note + return; claude CLI absent → grid is
 * metrics-only; a single frame's metric/parse failure leaves that frame degraded and
 * never aborts the scan. A dense pass must never break an ingest.
 */

import "./env.ts";
import { existsSync } from "node:fs";
import { z } from "zod";
import { type Understanding, type FrameVision, type DenseFrameVision } from "@os/schemas";
import { loadItem, saveItem, logLine, warn, nowIso } from "./store.ts";
import { resolveClaudeBin } from "./brain.ts";
import {
  resolveVideoFile,
  probeVideo,
  durationFromProbe,
  denseFrameScan,
  rawFrame,
  analyzeFramePixels,
} from "./editor-tools.ts";
import { describeFrames } from "./understanding-vision.ts";

// Cap the number of frames that get a (slow, paid) vision read. The rest are
// metrics-only. At 1fps a 2-min clip is 120 frames; we describe ≤40 of them,
// evenly spread, so the budget buys coverage across the whole arc.
const MAX_DESCRIBED_FRAMES = 40;
// Keyframes batched into ONE describeFrames vision call. 6-8 is the cheap-but-
// reliable middle (more frames/prompt degrades per-frame attention).
const FRAMES_PER_CALL = 7;
// Frame thumbnail width for the metrics read (matches the review path's default).
const METRIC_WIDTH = 360;
// Frames per contact sheet handed to denseFrameScan (we don't use the sheets here,
// but the helper requires the arg; keep it modest).
const FRAMES_PER_SHEET = 12;

/* The per-frame shape we ask the vision model to return. Lenient (all optional) so
   a partial reply still parses and we keep whatever the model grounded. `i` is the
   1-based index of the frame in THIS batch so we can map objects back even if the
   model reorders them. */
const VisionFrame = z
  .object({
    i: z.number().optional(),
    description: z.string().optional(),
    subjects: z.array(z.string()).optional(),
    onScreenText: z.string().optional(),
  })
  .passthrough();
type VisionFrame = z.infer<typeof VisionFrame>;

function visionInstruction(n: number): string {
  return `You are a senior video editor scrubbing a timeline. I am attaching ${n} still frame${n > 1 ? "s" : ""} sampled from a video, in time order (frame 1, frame 2, …).

For EACH frame, look closely and describe what it actually CONTAINS — concrete and specific, not generic.

Return ONLY a JSON array with exactly ${n} object${n > 1 ? "s" : ""}, one per frame, in frame order. Each object:
{
  "i": <1-based frame number this object describes>,
  "description": "<1 plain sentence: what this frame shows>",
  "subjects": ["<each person/object present, e.g. 'a man in a suit', 'a laptop'>"],
  "onScreenText": "<any burned-in / visible text in the frame, verbatim; omit if none>"
}

Omit any field you genuinely cannot judge. Return ONLY the JSON array — no markdown, no prose.`;
}

/* Cheap per-frame pixel metrics → the FrameVision motion/quality/brightness fields,
   all normalized 0..1. brightness = mean-luma proxy from bright vs dark pixel share;
   quality = edge density (a sharpness/detail proxy); motion = |luma delta| vs the
   previous frame's raw buffer. Fail-open: any read failure leaves the field absent. */
function frameMetrics(
  video: string,
  atSec: number,
  prev?: Buffer,
): { motionScore?: number; quality?: number; brightness?: number; data?: Buffer } {
  let frame: { width: number; height: number; data: Buffer };
  try {
    frame = rawFrame(video, atSec, METRIC_WIDTH);
  } catch {
    return {}; // decode failed — metrics-less frame, never throw
  }
  let brightness: number | undefined;
  let quality: number | undefined;
  try {
    const m = analyzeFramePixels(frame);
    // brightness: lift bright share, drop dark share, recenter to 0..1.
    if (Number.isFinite(m.brightPct) && Number.isFinite(m.darkPct)) {
      brightness = clamp01(0.5 + (m.brightPct - m.darkPct) / 200);
    }
    // quality: edge density as a sharpness proxy (clamped; ~30% edges → 1.0).
    if (Number.isFinite(m.edgePct)) quality = clamp01(m.edgePct / 30);
  } catch {
    /* metrics unreadable — leave brightness/quality absent */
  }
  let motionScore: number | undefined;
  if (prev && prev.length === frame.data.length) {
    let diff = 0;
    // Stride by 9 (every 3rd pixel, R channel) — matches frameVisualMetrics' cheap
    // motion read; enough signal for a 0..1 motion score.
    for (let i = 0; i < frame.data.length; i += 9) diff += Math.abs(frame.data[i] - prev[i]);
    const raw = diff / Math.max(1, frame.data.length / 9) / 255;
    // Scale: ~0.15 mean luma delta already reads as heavy motion → map to 1.0.
    motionScore = clamp01(raw / 0.15);
  }
  return { motionScore, quality, brightness, data: frame.data };
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, Number(n.toFixed(4))));
}

/* Evenly pick at most `cap` indices from [0, count) so the described frames spread
   across the whole grid rather than clustering at the head. */
function evenlyPick(count: number, cap: number): Set<number> {
  if (count <= cap) return new Set(Array.from({ length: count }, (_, i) => i));
  const step = count / cap;
  const chosen = new Set<number>();
  for (let k = 0; k < cap; k++) chosen.add(Math.min(count - 1, Math.round(k * step)));
  return chosen;
}

/**
 * buildDenseVision — sample the ingested SOURCE at `sampleFps`, build a FrameVision
 * per sampled frame (metrics for all, vision for a capped even subset), persist as
 * item.understanding.denseFrameVision (indexed by frameIndex = round(atSec * fps)).
 *
 * FAIL-OPEN throughout: no source on disk → note + empty-ish return; claude CLI
 * absent → metrics-only grid; per-frame failures degrade that frame only.
 */
export async function buildDenseVision(
  id: string,
  opts?: { sampleFps?: number },
): Promise<DenseFrameVision> {
  const item = loadItem(id);
  const u = (item.understanding ?? null) as Understanding | null;
  const sampleFps = Math.max(0.1, Number(opts?.sampleFps) || 1);

  const empty: DenseFrameVision = {
    sampleFps,
    frameCount: 0,
    startSec: 0,
    endSec: 0,
    frames: [],
    lastUpdatedAt: nowIso(),
  };

  const video = resolveVideoFile(item as any);
  if (!video || !existsSync(video)) {
    warn(item, "dense_vision", "no_video", "no source video on disk — dense vision pass skipped");
    if (u) {
      u.denseFrameVision = empty;
      item.understanding = u;
      saveItem(item);
    }
    return empty;
  }

  // fps for sec↔frame conversion: understanding fps, then source probe fps, else 30.
  let fps = Number(u?.fps);
  if (!Number.isFinite(fps) || fps <= 0) {
    try {
      const probe = probeVideo(video);
      const stream = probe?.streams?.find((s: any) => s.codec_type === "video");
      const rate = stream?.avg_frame_rate || stream?.r_frame_rate || "";
      const [n, d] = String(rate).split("/").map(Number);
      if (Number.isFinite(n) && Number.isFinite(d) && d > 0) fps = n / d;
    } catch {
      /* probe failed — fall through to default */
    }
  }
  if (!Number.isFinite(fps) || fps <= 0) fps = 30;

  // Sample the source into an evenly-strided frame stream (paths + atSec per frame).
  let scan: ReturnType<typeof denseFrameScan>;
  try {
    scan = denseFrameScan(id, video, sampleFps, METRIC_WIDTH, FRAMES_PER_SHEET);
  } catch (e) {
    warn(item, "dense_vision", "scan_failed", "dense frame scan failed — dense vision pass skipped", e instanceof Error ? e.message : String(e));
    if (u) {
      u.denseFrameVision = empty;
      item.understanding = u;
      saveItem(item);
    }
    return empty;
  }

  const scanned: { index: number; atSec: number; path: string }[] = scan.frames ?? [];
  const endSec = scanned.length ? scanned[scanned.length - 1].atSec : durationFromProbe((() => { try { return probeVideo(video); } catch { return null; } })());

  // 1) METRICS for every sampled frame (cheap, fail-open per frame).
  const frames: FrameVision[] = [];
  let prevData: Buffer | undefined;
  for (const s of scanned) {
    const frameIndex = Math.max(0, Math.round(s.atSec * fps));
    const m = frameMetrics(video, s.atSec, prevData);
    prevData = m.data ?? prevData;
    const fv: FrameVision = { frameIndex, atSec: Number(s.atSec.toFixed(3)) };
    if (m.motionScore != null) fv.motionScore = m.motionScore;
    if (m.quality != null) fv.quality = m.quality;
    if (m.brightness != null) fv.brightness = m.brightness;
    frames.push(fv);
  }

  // 2) VISION for a capped, evenly-spread subset (skip entirely if CLI is absent).
  const claudeBin = resolveClaudeBin();
  let described = 0;
  let batchFailures = 0;
  if (!claudeBin) {
    if (u) (u.notes ??= []).push("dense vision: claude CLI not found — grid is metrics-only");
  } else if (scanned.length) {
    const pick = evenlyPick(scanned.length, MAX_DESCRIBED_FRAMES);
    const toDescribe = scanned.filter((_, i) => pick.has(i)).filter((s) => s.path && existsSync(s.path));
    for (let off = 0; off < toDescribe.length; off += FRAMES_PER_CALL) {
      const batch = toDescribe.slice(off, off + FRAMES_PER_CALL);
      try {
        const reply = await describeFrames(batch.map((b) => b.path), visionInstruction(batch.length));
        let raw: unknown[] = [];
        if (Array.isArray(reply)) raw = reply;
        else if (reply && typeof reply === "object") raw = [reply];
        if (!raw.length) {
          batchFailures++;
          continue;
        }
        for (let k = 0; k < batch.length; k++) {
          const match = raw.find((o) => Number((o as any)?.i) === k + 1) ?? raw[k];
          if (!match || typeof match !== "object") continue;
          const parsed = VisionFrame.safeParse(match);
          if (!parsed.success) continue;
          const frameIndex = Math.max(0, Math.round(batch[k].atSec * fps));
          const target = frames.find((f) => f.frameIndex === frameIndex);
          if (!target) continue;
          const v = parsed.data;
          if (v.description) target.description = v.description.trim().slice(0, 400);
          if (v.subjects?.length) {
            target.subjects = v.subjects.map((s) => String(s).trim()).filter(Boolean).slice(0, 12);
          }
          if (v.onScreenText) target.onScreenText = v.onScreenText.trim().slice(0, 400);
          target.confidence = 0.7; // vision-read frames carry a baseline confidence
          described++;
        }
      } catch {
        batchFailures++; // a whole batch failed — those frames stay metrics-only
      }
    }
  }

  const dense: DenseFrameVision = {
    sampleFps,
    frameCount: frames.length,
    startSec: scanned.length ? Number(scanned[0].atSec.toFixed(3)) : 0,
    endSec: Number((endSec || 0).toFixed(3)),
    frames,
    lastUpdatedAt: nowIso(),
  };

  if (u) {
    if (batchFailures) (u.notes ??= []).push(`dense vision: ${batchFailures} batch(es) failed — some frames metrics-only`);
    u.denseFrameVision = dense;
    item.understanding = u;
    saveItem(item);
    logLine(item, `dense-vision: ${frames.length} frame(s) @ ${sampleFps}fps, ${described} described${batchFailures ? `, ${batchFailures} batch fail` : ""}`);
  } else {
    warn(item, "dense_vision", "no_understanding", "item has no understanding — dense grid built but not persisted (run editor_understand first)");
  }

  return dense;
}
