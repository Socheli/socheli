/**
 * ingest.ts — Pillar 5 (Ingest & Understand) N1: the import front-door.
 * Roadmap docs/DAVINCI-ROADMAP.md §7.1.5 N1a–N1c + §7.1.2(a).
 *
 * THE ARCHITECTURAL BET (§7.1.1): an ingested user video registers as a NORMAL
 * `ContentItem` — `kind:"ingested"`, `status:"ingested"`, `videoPath` = the
 * normalized source — so every existing evidence tool (editor_analyze_av,
 * videoDiagnostics, analyzeClip), every craft pass (color/audio/comp), the NLE
 * timeline, the caption renderer and the agent loop operate on REAL footage
 * UNCHANGED. The only new spine here is: probe → normalize-if-needed → thumbnail
 * → build+save a ContentItem with a `source: SourceVideo` provenance block.
 *
 * FAIL-OPEN (CLAUDE.md hard rule — "ingest of real footage is messy, never
 * throw"): probe parses defensively (a missing stream field degrades, never
 * crashes); a transcode that fails falls back to referencing the original; a
 * thumbnail that fails is simply absent. We warn() + degrade, we don't abort.
 *
 * PII (§7.1.6): `source.originalPath` may carry a home-dir path/filename. It
 * lives only in private data/runs JSON (saveItem) and is served via the
 * ALLOWED_DIRS gate — never echoed into anything publishable.
 */

import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import {
  ContentItem,
  type SourceProbe,
  type SourceVideo,
  type TenantContext,
} from "@os/schemas";

import { RENDERS_DIR, logLine, newId, nowIso, saveItem, warn } from "./store.ts";

/* Ingested originals + their normalized copies are large — keep them off the boot
   disk next to renders (same external-volume logic). Override via env. Mirrors the
   RENDERS_DIR expression so a mounted ext volume holds both. (§7.1.3: INGEST_DIR =
   join(RENDERS_DIR, "..", "ingest").) */
export const INGEST_DIR = process.env.SOCHELI_INGEST_DIR || join(RENDERS_DIR, "..", "ingest");

const ensure = (d: string) => mkdirSync(d, { recursive: true });

// Run a binary, returning stdout as a string. Throws on non-zero — callers that
// must fail open wrap this in try/catch (probe/normalize/thumbnail all do).
function run(cmd: string, args: string[]): string {
  const res = spawnSync(cmd, args, { cwd: process.cwd(), encoding: "utf8", maxBuffer: 1 << 26 });
  if (res.status !== 0) {
    throw new Error(`${cmd} failed: ${res.stderr?.toString() || res.stdout?.toString() || `exit ${res.status}`}`);
  }
  return res.stdout ?? "";
}

// Parse a `num/den` rational (ffprobe avg_frame_rate / r_frame_rate) → number.
// Returns 0 for "0/0" or unparseable so the caller can fall back.
function parseRational(r: unknown): number {
  if (typeof r === "number") return r;
  if (typeof r !== "string" || !r.includes("/")) return Number(r) || 0;
  const [n, d] = r.split("/").map(Number);
  if (!d || !Number.isFinite(n) || !Number.isFinite(d)) return 0;
  return n / d;
}

/* Read rotation from the THREE places a container can hide it (§7.1.6 risk):
   `tags.rotate` (legacy mov/mp4), the `displaymatrix` side-data (modern, e.g.
   phone H.265), or a Display Matrix side_data rotation field. Normalized to a
   0/90/180/270 integer (negative angles wrapped). 0 when none present. */
function readRotation(stream: any): number {
  let deg = 0;
  const tagRotate = Number(stream?.tags?.rotate);
  if (Number.isFinite(tagRotate) && tagRotate) deg = tagRotate;
  for (const sd of stream?.side_data_list ?? []) {
    const t = String(sd?.side_data_type ?? "").toLowerCase();
    if (t.includes("display matrix") || t.includes("displaymatrix")) {
      const r = Number(sd?.rotation);
      if (Number.isFinite(r) && r) deg = r; // ffmpeg reports the display rotation here
    }
  }
  // ffmpeg's displaymatrix rotation is the negative of the human "rotate" angle.
  // Normalize to a non-negative multiple of 90 in [0,360).
  let norm = ((Math.round(deg / 90) * 90) % 360 + 360) % 360;
  return norm;
}

/**
 * probeVideo(path): SourceProbe — ffprobe -show_streams/-show_format → parsed
 * container/duration/video(codec,res,fps,rotation,pixfmt,sar,bitrate)/audio
 * streams/hasAudio. FAIL-OPEN: any parse hiccup degrades a field rather than
 * throwing, so a weird real-world file still yields a usable (if partial) probe.
 * A totally unreadable file yields a zero-duration audio-less probe (the caller
 * decides what to do with that).
 */
export function probeVideo(path: string): SourceProbe {
  let meta: any = {};
  try {
    meta = JSON.parse(run("ffprobe", ["-v", "error", "-show_format", "-show_streams", "-of", "json", path]));
  } catch {
    // Unreadable — return the minimal valid SourceProbe shape (fail-open).
    return { durationSec: 0, audioStreams: [], hasAudio: false };
  }

  const streams: any[] = Array.isArray(meta?.streams) ? meta.streams : [];
  const v = streams.find((s) => s?.codec_type === "video");
  const audio = streams.filter((s) => s?.codec_type === "audio");

  const durationSec =
    Number(meta?.format?.duration) ||
    Number(v?.duration) ||
    Number(audio[0]?.duration) ||
    0;

  const probe: SourceProbe = {
    container: meta?.format?.format_name ? String(meta.format.format_name) : undefined,
    durationSec,
    audioStreams: audio.map((a) => ({
      codec: String(a?.codec_name ?? "unknown"),
      channels: Number(a?.channels) || 0,
      sampleRate: Number(a?.sample_rate) || 0,
      language: a?.tags?.language ? String(a.tags.language) : undefined,
    })),
    hasAudio: audio.length > 0,
  };

  if (v) {
    // fps from avg_frame_rate (true average across the file), falling back to the
    // nominal r_frame_rate. KEEP source fps (24/25/29.97/60) — never force 30.
    const fps = parseRational(v.avg_frame_rate) || parseRational(v.r_frame_rate) || 0;
    probe.video = {
      codec: String(v.codec_name ?? "unknown"),
      width: Number(v.width) || 0,
      height: Number(v.height) || 0,
      fps: Number(fps.toFixed(3)),
      rotation: readRotation(v),
      pixFmt: v.pix_fmt ? String(v.pix_fmt) : undefined,
      sar: v.sample_aspect_ratio ? String(v.sample_aspect_ratio) : undefined,
      bitrate: Number(v.bit_rate) || Number(meta?.format?.bit_rate) || undefined,
    };
  }

  return probe;
}

/* The render-friendly target the hybrid render path (N6) and Remotion expect:
   H.264 in an mp4 container, 4:2:0 8-bit, no baked rotation flag (rotation applied
   to the pixels). We NORMALIZE only when the source deviates — otherwise we
   passthrough the original verbatim (no needless re-encode / quality loss). */
const FRIENDLY_CODECS = new Set(["h264"]);
const FRIENDLY_CONTAINERS = ["mp4", "mov"]; // format_name is a comma list (e.g. "mov,mp4,m4a,...")
const FRIENDLY_PIXFMTS = new Set(["yuv420p", "yuvj420p"]);

/**
 * needsNormalize(probe): decide whether the source must be transcoded to a
 * render-friendly file, and WHY. Returns null when the original can be used
 * as-is (passthrough). Rules (§7.1.2(a) / §7.1.6):
 *   - non-h264 video codec (hevc/vp9/av1/prores…) → transcode
 *   - container not mp4/mov → transcode (remux-or-recode; we recode for safety)
 *   - baked-in rotation flag (90/180/270) → transcode to bake rotation into pixels
 *   - non-4:2:0 pixel format (yuv422/444/10-bit) → transcode to yuv420p
 *   - no video stream at all → no normalize (audio-only / image; let it pass)
 * The reason string is persisted on SourceVideo.normalizeReason.
 */
export function needsNormalize(probe: SourceProbe): string | null {
  const v = probe.video;
  if (!v) return null; // no video stream → nothing to make render-friendly
  const reasons: string[] = [];
  if (!FRIENDLY_CODECS.has(v.codec.toLowerCase())) reasons.push(`codec=${v.codec}`);
  if (probe.container && !FRIENDLY_CONTAINERS.some((c) => probe.container!.toLowerCase().includes(c)))
    reasons.push(`container=${probe.container}`);
  if (v.rotation && v.rotation % 360 !== 0) reasons.push(`rotation=${v.rotation}`);
  if (v.pixFmt && !FRIENDLY_PIXFMTS.has(v.pixFmt.toLowerCase())) reasons.push(`pixfmt=${v.pixFmt}`);
  return reasons.length ? reasons.join(", ") : null;
}

/* Transcode the source to a render-friendly h264/yuv420p mp4 with rotation BAKED
   into the pixels (§7.1.6 — or N3 frame math + the Remotion overlay are 90° off).
   KEEP the source fps (do NOT force -r 30, unlike render.ts's concat). The
   `-noautorotate` + explicit transpose is avoided: ffmpeg auto-applies the
   display matrix on decode and we strip the metadata flag with `-metadata:s:v
   rotate=0`, so the output is already upright with no residual flag. Returns the
   output path, or throws (caller fails open to passthrough). */
function transcodeToFriendly(src: string, out: string): string {
  ensure(INGEST_DIR);
  // ffmpeg auto-rotates on decode (display matrix honored), so re-encoding bakes
  // the rotation into the frames; we then clear the rotate tag so nothing double-
  // rotates downstream. CRF 18 for a near-lossless ingest master (re-grade later).
  run("ffmpeg", [
    "-y",
    "-i", src,
    "-c:v", "libx264",
    "-crf", String(process.env.SOCHELI_INGEST_CRF || 18),
    "-pix_fmt", "yuv420p",
    "-metadata:s:v", "rotate=0",
    // Re-encode audio to AAC so the container is uniformly playable; copy if absent
    // is a no-op (ffmpeg drops the missing stream).
    "-c:a", "aac",
    "-b:a", "256k",
    "-movflags", "+faststart",
    out,
  ]);
  if (!existsSync(out)) throw new Error("transcode produced no output");
  return out;
}

/* Grab one representative frame as a jpg thumbnail (≈10% in, away from a cold
   open / black). FAIL-OPEN: returns undefined if the grab fails. */
function thumbnailSource(id: string, video: string, durationSec: number): string | undefined {
  try {
    ensure(RENDERS_DIR);
    const at = Math.max(0.5, Math.min(durationSec * 0.1, Math.max(0, durationSec - 0.5)));
    const out = join(RENDERS_DIR, `${id}_thumb.jpg`);
    run("ffmpeg", ["-y", "-ss", at.toFixed(3), "-i", video, "-frames:v", "1", "-vf", "scale=640:-1", "-q:v", "4", out]);
    return existsSync(out) ? out : undefined;
  } catch {
    return undefined;
  }
}

export type ImportOpts = {
  /** Channel to register the item under (default "labrinox"). */
  channel?: string;
  /** Force a transcode even when the probe says passthrough is fine. */
  forceNormalize?: boolean;
  /** Skip the thumbnail grab (faster import). */
  noThumbnail?: boolean;
  /** Tenant context for workspace scoping (saveItem stamps ownership). */
  ctx?: TenantContext;
  /** Pre-allocated id (so a detached transcode worker writes the SAME run). */
  id?: string;
};

/**
 * importVideo(path, opts?): Promise<ContentItem> — the N1 front-door.
 *  1. resolve + stat the source (fail fast only on a genuinely missing file).
 *  2. probeVideo → SourceProbe.
 *  3. needsNormalize → transcode to a render-friendly h264/yuv420p/baked-rotation
 *     mp4 (fail-open: a transcode error degrades to referencing the original).
 *  4. thumbnail a frame.
 *  5. build a kind:"ingested" / status:"ingested" ContentItem with
 *     videoPath = the normalized (or original) path and a SourceVideo provenance
 *     block, then saveItem (stamps workspace ownership for PII scoping).
 *
 * Long transcodes are heavy — the ingest_video TOOL detaches them via the
 * detached-spawn contract; importVideo itself runs inline (and is what the
 * detached worker calls). Never throws on a messy file: it degrades + warn()s.
 */
export async function importVideo(path: string, opts: ImportOpts = {}): Promise<ContentItem> {
  const originalPath = resolve(path);
  if (!existsSync(originalPath)) throw new Error(`source video not found: ${path}`);

  const channel = opts.channel || "labrinox";
  const id = opts.id || newId(channel);
  const originalName = basename(originalPath);

  let bytes: number | undefined;
  try {
    bytes = statSync(originalPath).size;
  } catch {
    bytes = undefined;
  }

  const probe = probeVideo(originalPath);

  // Build a minimal valid ContentItem up front so we can warn() onto it as we go.
  const item: ContentItem = {
    id,
    channel,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    status: "ingested",
    kind: "ingested",
    seedIdea: originalName, // human-readable handle; the real provenance is `source`
    ledger: { entries: [], totalUsd: 0 },
    log: [],
  };
  logLine(item, `ingest: ${originalName} — ${probe.video ? `${probe.video.width}×${probe.video.height} ${probe.video.codec} @ ${probe.video.fps}fps` : "no video stream"}, ${probe.durationSec.toFixed(1)}s, audio ${probe.hasAudio ? "present" : "none"}`);

  // ── normalize decision ──
  const reason = opts.forceNormalize ? (needsNormalize(probe) ?? "forced") : needsNormalize(probe);
  let normalizedPath = originalPath;
  let normalized = false;
  let normalizeReason: string | undefined;

  if (reason) {
    ensure(INGEST_DIR);
    const ext = extname(originalName).toLowerCase();
    const out = join(INGEST_DIR, `${id}${ext === ".mp4" ? "_norm.mp4" : ".mp4"}`);
    try {
      normalizedPath = transcodeToFriendly(originalPath, out);
      normalized = true;
      normalizeReason = reason;
      logLine(item, `ingest: normalized (${reason}) → ${basename(normalizedPath)}`);
    } catch (e) {
      // FAIL-OPEN: keep the original as the videoPath; downstream tools mostly
      // tolerate hevc/mov via ffmpeg — better a referenceable item than none.
      warn(item, "ingest", "transcode_failed", `normalize skipped (${reason}); referencing original`, e instanceof Error ? e.message : String(e));
      normalizedPath = originalPath;
    }
  } else {
    // Passthrough: optionally COPY the original into INGEST_DIR so the run owns a
    // stable file, OR reference it in place. We reference in place to avoid a
    // needless multi-GB copy; the original path is recorded for provenance.
    logLine(item, "ingest: passthrough (already render-friendly)");
  }

  // ── thumbnail ──
  let thumbPath: string | undefined;
  if (!opts.noThumbnail) {
    thumbPath = thumbnailSource(id, normalizedPath, probe.durationSec);
    if (!thumbPath) warn(item, "ingest", "thumbnail_failed", "could not grab a thumbnail frame");
  }

  const source: SourceVideo = {
    originalPath,
    originalName,
    path: normalizedPath,
    normalized,
    normalizeReason,
    bytes,
    probe,
    importedAt: nowIso(),
    importedBy: opts.ctx?.userId ?? undefined,
  };

  item.videoPath = normalizedPath;
  if (thumbPath) item.thumbPath = thumbPath;
  item.source = source;

  // Validate at the boundary (zod) then persist (stamps workspace ownership).
  const parsed = ContentItem.parse(item);
  saveItem(parsed, opts.ctx);
  return parsed;
}
