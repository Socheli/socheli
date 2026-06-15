import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Storyboard } from "@os/schemas";
import { COMPETITOR_INTEL, OUR_STRATEGIC_EDGE, UNMET_JOBS, competitorOpportunityScores, strategicRoadmap } from "./competitive-intel.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const DATA_DIR = join(ROOT, "data");
const RUNS_DIR = join(DATA_DIR, "runs");
// Keep render outputs on an external volume when mounted (see store.ts). Override via env.
const RENDERS_DIR =
  process.env.SOCHELI_RENDERS_DIR ||
  (process.env.SOCHELI_EXT_VOLUME && existsSync(process.env.SOCHELI_EXT_VOLUME)
    ? join(process.env.SOCHELI_EXT_VOLUME, "Socheli", "renders")
    : join(DATA_DIR, "renders"));
const VISION_DIR = join(DATA_DIR, "agent-vision");
const REVIEW_DIR = join(DATA_DIR, "agent-reviews");
const SCRIPTS_DIR = join(ROOT, "packages", "engine", "scripts");
const VENV_PY = join(ROOT, ".venv-music", "bin", "python");

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Item = Record<string, any>;
type TimelineScene = { index: number; id: string; type: string; startSec: number; endSec: number; durationSec: number };
const DEFAULT_AUDIO_TRACKS = [
  { id: "music", name: "Music", vol: 1, speed: 1, pan: 0, fadeIn: 0, fadeOut: 0 },
  { id: "voice", name: "Voice", vol: 1, speed: 1, pan: 0, fadeIn: 0, fadeOut: 0 },
  { id: "sfx", name: "SFX", vol: 1, speed: 1, pan: 0, fadeIn: 0, fadeOut: 0 },
];

export type ToolResult = {
  ok: boolean;
  message?: string;
  data?: Json | Record<string, unknown> | unknown[];
};

export type EditorTool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run: (input: any) => ToolResult;
};

function ensureDir(path: string) {
  mkdirSync(path, { recursive: true });
}

function itemPath(id: string) {
  return join(RUNS_DIR, `${id}.json`);
}

function loadRaw(id: string): Item {
  const path = itemPath(id);
  if (!existsSync(path)) throw new Error(`item not found: ${id}`);
  return JSON.parse(readFileSync(path, "utf8"));
}

function saveRaw(item: Item, targetId = item.id) {
  if (!targetId) throw new Error("cannot save item without id");
  item.id = targetId;
  item.updatedAt = new Date().toISOString();
  ensureDir(RUNS_DIR);
  writeFileSync(itemPath(targetId), JSON.stringify(item, null, 2));
}

function videoFile(item: Item): string | null {
  if (item.videoPath && existsSync(item.videoPath)) return item.videoPath;
  for (const p of [join(RENDERS_DIR, `${item.id}.mp4`), join(RENDERS_DIR, "Beta", `${item.id}.mp4`)]) {
    if (existsSync(p)) return p;
  }
  return null;
}

function splitPath(path: string): string[] {
  if (!path.trim()) throw new Error("path is required");
  return path.replace(/\[(\d+)\]/g, ".$1").split(".").filter(Boolean);
}

function readPath(root: any, path: string) {
  return splitPath(path).reduce((cur, part) => cur?.[part], root);
}

function writePath(root: any, path: string, value: unknown) {
  const parts = splitPath(path);
  let cur = root;
  for (const part of parts.slice(0, -1)) {
    if (cur[part] == null || typeof cur[part] !== "object") cur[part] = /^\d+$/.test(part) ? [] : {};
    cur = cur[part];
  }
  cur[parts[parts.length - 1]] = value;
}

function unsetPath(root: any, path: string) {
  const parts = splitPath(path);
  let cur = root;
  for (const part of parts.slice(0, -1)) cur = cur?.[part];
  if (cur && typeof cur === "object") delete cur[parts[parts.length - 1]];
}

function parseValue(value: unknown) {
  if (typeof value !== "string") return value;
  const s = value.trim();
  if (!s.length) return "";
  if (/^(true|false|null)$/i.test(s) || /^[\[{"]/.test(s) || /^-?\d+(\.\d+)?$/.test(s)) {
    try {
      return JSON.parse(s);
    } catch {
      return value;
    }
  }
  return value;
}

function requireScene(item: Item, index: number) {
  const scene = item.storyboard?.scenes?.[index];
  if (!scene) throw new Error(`scene not found at index ${index}`);
  return scene;
}

function validateStoryboard(item: Item) {
  if (!item.storyboard) return { valid: false, issues: ["item has no storyboard"] };
  const parsed = Storyboard.safeParse(item.storyboard);
  if (parsed.success) return { valid: true, issues: [] };
  return { valid: false, issues: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) };
}

function audioTrackDefaults(mix: any) {
  const saved = Array.isArray(mix?.tracks) ? mix.tracks : [];
  return DEFAULT_AUDIO_TRACKS.map((base) => ({ ...base, ...(saved.find((t: any) => t?.id === base.id) ?? {}) }));
}

function sceneStarts(item: Item): TimelineScene[] {
  let t = 0;
  return (item.storyboard?.scenes ?? []).map((scene: any, index: number) => {
    const startSec = t;
    const durationSec = Number(scene.durationSec || 2);
    t += durationSec;
    return { index, id: scene.id, type: scene.type, startSec, endSec: t, durationSec };
  });
}

function run(cmd: string, args: string[]) {
  const res = spawnSync(cmd, args, { cwd: ROOT, encoding: "utf8" });
  if (res.status !== 0) throw new Error(`${cmd} failed: ${res.stderr || res.stdout || `exit ${res.status}`}`);
  return res.stdout.trim();
}

function runRaw(cmd: string, args: string[]) {
  const res = spawnSync(cmd, args, { cwd: ROOT, encoding: "utf8" });
  if (res.status !== 0) throw new Error(`${cmd} failed: ${res.stderr || res.stdout || `exit ${res.status}`}`);
  return { stdout: res.stdout, stderr: res.stderr };
}

function runBuffer(cmd: string, args: string[]) {
  const res = spawnSync(cmd, args, { cwd: ROOT, encoding: "buffer", maxBuffer: 1024 * 1024 * 64 });
  if (res.status !== 0) throw new Error(`${cmd} failed: ${res.stderr?.toString() || res.stdout?.toString() || `exit ${res.status}`}`);
  return Buffer.isBuffer(res.stdout) ? res.stdout : Buffer.from(res.stdout ?? []);
}

function ffprobe(path: string) {
  const out = run("ffprobe", ["-v", "error", "-show_format", "-show_streams", "-of", "json", path]);
  return JSON.parse(out);
}

function sampleFrame(id: string, video: string, atSec: number, label: string) {
  ensureDir(VISION_DIR);
  const safeLabel = label.replace(/[^a-zA-Z0-9_.-]/g, "_");
  const out = join(VISION_DIR, `${id}_${safeLabel}_${atSec.toFixed(2)}.jpg`);
  run("ffmpeg", ["-y", "-ss", atSec.toFixed(3), "-i", video, "-frames:v", "1", "-vf", "scale=540:-1", out]);
  return out;
}

function sampleFrameTo(video: string, atSec: number, out: string, width = 360) {
  ensureDir(dirname(out));
  run("ffmpeg", ["-y", "-ss", atSec.toFixed(3), "-i", video, "-frames:v", "1", "-vf", `scale=${width}:-1`, out]);
  return out;
}

function rawFrame(video: string, atSec: number, width: number) {
  const meta = ffprobe(video);
  const stream = meta.streams?.find((s: any) => s.codec_type === "video");
  const sourceW = Number(stream?.width ?? 1080);
  const sourceH = Number(stream?.height ?? 1920);
  const height = Math.max(1, Math.round((width * sourceH) / Math.max(1, sourceW)));
  const data = runBuffer("ffmpeg", ["-v", "error", "-ss", atSec.toFixed(3), "-i", video, "-frames:v", "1", "-vf", `scale=${width}:${height}`, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]);
  return { width, height, data };
}

function contactSheet(id: string, frames: string[], label = "contact") {
  if (!frames.length) return null;
  const safeLabel = label.replace(/[^a-zA-Z0-9_.-]/g, "_");
  const list = join(VISION_DIR, `${id}_${safeLabel}_frames.txt`);
  writeFileSync(list, frames.map((f) => `file '${f.replace(/'/g, "'\\''")}'\nduration 1`).join("\n"));
  const out = join(VISION_DIR, `${id}_${safeLabel}.jpg`);
  const cols = Math.min(frames.length, frames.length > 12 ? 6 : 3);
  run("ffmpeg", ["-y", "-f", "concat", "-safe", "0", "-i", list, "-vf", `tile=${cols}x${Math.ceil(frames.length / cols)}:margin=8:padding=4`, "-frames:v", "1", out]);
  return out;
}

function durationFromProbe(meta: any) {
  return Number(meta?.format?.duration ?? meta?.streams?.find((s: any) => s.codec_type === "video")?.duration ?? 0);
}

function denseFrameScan(id: string, video: string, sampleFps: number, width: number, framesPerSheet: number) {
  ensureDir(VISION_DIR);
  const dir = join(VISION_DIR, `${id}_full_${String(sampleFps).replace(".", "p")}fps`);
  rmSync(dir, { recursive: true, force: true });
  ensureDir(dir);
  const pattern = join(dir, "frame_%05d.jpg");
  run("ffmpeg", ["-y", "-i", video, "-vf", `fps=${sampleFps},scale=${width}:-1`, "-q:v", "3", pattern]);
  const frames = readdirSync(dir)
    .filter((f) => /^frame_\d+\.jpg$/.test(f))
    .sort()
    .map((file, i) => ({ index: i, atSec: Number((i / sampleFps).toFixed(3)), path: join(dir, file) }));
  const sheets: { index: number; startFrame: number; endFrame: number; path: string | null }[] = [];
  for (let i = 0; i < frames.length; i += framesPerSheet) {
    const chunk = frames.slice(i, i + framesPerSheet);
    sheets.push({
      index: sheets.length,
      startFrame: chunk[0]?.index ?? i,
      endFrame: chunk[chunk.length - 1]?.index ?? i,
      path: contactSheet(id, chunk.map((f) => f.path), `sheet_${String(sheets.length).padStart(2, "0")}`),
    });
  }
  const manifest = {
    id,
    video,
    sampleFps,
    width,
    frameCount: frames.length,
    frameDir: dir,
    frames,
    sheets,
  };
  const manifestPath = join(dir, "manifest.json");
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  return { ...manifest, manifestPath };
}

function parseIntervals(text: string, startKey: string, endKey: string) {
  const starts = [...text.matchAll(new RegExp(`${startKey}:\\s*([0-9.]+)`, "g"))].map((m) => Number(m[1]));
  const ends = [...text.matchAll(new RegExp(`${endKey}:\\s*([0-9.]+)`, "g"))].map((m) => Number(m[1]));
  return starts.map((start, i) => ({ startSec: start, endSec: ends[i] ?? null, durationSec: ends[i] != null ? Number((ends[i] - start).toFixed(3)) : null }));
}

/* MIXER EVIDENCE (M6, roadmap §4.3): real EBU R128 loudness meters the audio
   pass reads to grade a mix toward a measured target (-14 LUFS, TP ≤ -1 dBTP).
   FAIL-OPEN: any field we cannot read stays NaN/undefined; the existing
   volumedetect/silencedetect diagnostics are untouched and authoritative. */
function ebur128Loudness(video: string) {
  // ffmpeg's ebur128 filter prints a "Summary:" block on stderr with the
  // integrated loudness (I), loudness range (LRA), and true-peak. `peak=true`
  // asks it to track the true-peak (dBTP). framelog=quiet keeps the per-frame
  // spam off so only the Summary remains. No audio is written (-f null).
  const res = spawnSync(
    "ffmpeg",
    ["-i", video, "-filter_complex", "ebur128=peak=true:framelog=quiet", "-vn", "-sn", "-dn", "-f", "null", "-"],
    { cwd: ROOT, encoding: "utf8" },
  );
  const text = res.stderr ?? "";
  // The Summary block looks like:
  //   Integrated loudness:\n     I:   -16.3 LUFS\n  Threshold:  -26.4 LUFS
  //   Loudness range:\n     LRA:    6.2 LU ...
  //   True peak:\n     Peak:   -1.4 dBFS
  const num = (re: RegExp) => {
    const m = re.exec(text);
    const n = m ? Number(m[1]) : NaN;
    return Number.isFinite(n) ? n : NaN;
  };
  return {
    integratedLufs: num(/I:\s*(-?[0-9.]+)\s*LUFS/),
    truePeakDb: num(/Peak:\s*(-?[0-9.]+)\s*dBFS/),
    lra: num(/LRA:\s*(-?[0-9.]+)\s*LU/),
  };
}

/* Per-region RMS: sample the mean level inside each scene window so the mixer
   can spot a region (e.g. a VO beat) sitting far under the bed. Uses
   volumedetect per trimmed segment (cheap, fail-open per region). The scene
   boundaries are the ones the tool already knows (sceneStarts). */
export function perRegionRms(video: string, regions: { startSec: number; endSec: number }[]) {
  return regions.map((r) => {
    const dur = Math.max(0, r.endSec - r.startSec);
    let rms = NaN;
    if (dur > 0.05) {
      const res = spawnSync(
        "ffmpeg",
        ["-ss", r.startSec.toFixed(3), "-t", dur.toFixed(3), "-i", video, "-af", "volumedetect", "-vn", "-sn", "-dn", "-f", "null", "-"],
        { cwd: ROOT, encoding: "utf8" },
      );
      const m = /mean_volume:\s*(-?[0-9.]+) dB/.exec(res.stderr ?? "");
      const n = m ? Number(m[1]) : NaN;
      rms = Number.isFinite(n) ? n : NaN;
    }
    return { startSec: Number(r.startSec.toFixed(3)), endSec: Number(r.endSec.toFixed(3)), rms };
  });
}

function videoDiagnostics(id: string, video: string, regions?: { startSec: number; endSec: number }[]) {
  ensureDir(VISION_DIR);
  const waveformPath = join(VISION_DIR, `${id}_waveform.png`);
  const waveform = spawnSync("ffmpeg", ["-y", "-i", video, "-filter_complex", "aformat=channel_layouts=mono,showwavespic=s=1600x240:colors=38bdf8", "-frames:v", "1", waveformPath], { cwd: ROOT, encoding: "utf8" });
  const hasWaveform = waveform.status === 0 && existsSync(waveformPath);
  const vol = runRaw("ffmpeg", ["-i", video, "-af", "volumedetect", "-vn", "-sn", "-dn", "-f", "null", "-"]);
  const silence = runRaw("ffmpeg", ["-i", video, "-af", "silencedetect=noise=-35dB:d=0.35", "-vn", "-sn", "-dn", "-f", "null", "-"]);
  const freeze = runRaw("ffmpeg", ["-i", video, "-vf", "freezedetect=n=-60dB:d=0.5", "-an", "-f", "null", "-"]);
  const black = runRaw("ffmpeg", ["-i", video, "-vf", "blackdetect=d=0.25:pic_th=0.98", "-an", "-f", "null", "-"]);
  const scene = runRaw("ffmpeg", ["-i", video, "-vf", "select='gt(scene,0.18)',showinfo", "-an", "-f", "null", "-"]);
  // Loudness meters (M6) — wrapped so an ffmpeg build without ebur128 fails open
  // to NaN fields rather than aborting the whole diagnostics call.
  let loudness: { integratedLufs: number; truePeakDb: number; lra: number; perRegion: { startSec: number; endSec: number; rms: number }[] };
  try {
    const meters = ebur128Loudness(video);
    loudness = {
      ...meters,
      perRegion: regions && regions.length ? perRegionRms(video, regions) : [],
    };
  } catch {
    loudness = { integratedLufs: NaN, truePeakDb: NaN, lra: NaN, perRegion: [] };
  }
  return {
    waveformPath: hasWaveform ? waveformPath : null,
    volume: {
      meanDb: Number(/mean_volume:\s*(-?[0-9.]+) dB/.exec(vol.stderr)?.[1] ?? NaN),
      maxDb: Number(/max_volume:\s*(-?[0-9.]+) dB/.exec(vol.stderr)?.[1] ?? NaN),
    },
    loudness,
    silence: parseIntervals(silence.stderr, "silence_start", "silence_end"),
    freezes: parseIntervals(freeze.stderr, "freeze_start", "freeze_end"),
    blackFrames: parseIntervals(black.stderr, "black_start", "black_end"),
    sceneChanges: [...scene.stderr.matchAll(/pts_time:([0-9.]+)/g)].map((m) => ({ atSec: Number(m[1]) })),
  };
}

/* COLORIST EVIDENCE (M3, roadmap §4.1 + §5): real ffmpeg SCOPES read off a
   rendered frame so the color pass grades toward measured numbers, not prose.
   Per scene we sample one mid-frame and emit three scope IMAGES the model can
   look at — a WAVEFORM (luma + RGB parade), a VECTORSCOPE (hue/sat distribution),
   a HISTOGRAM — plus numeric STATS from `signalstats` (per-channel/luma
   min/avg/max → P5/P50/P95, clip% high/low, and a white-balance bias from the
   R/G/B channel averages). FAIL-OPEN throughout: a scope image that ffmpeg can't
   produce stays null, a stat it can't read stays NaN; one bad scene never aborts
   the rest. Mirrors videoDiagnostics' artifact-path + spawnSync discipline. */

// Sample a 0..255 luma value to derive a coarse percentile from signalstats'
// YMIN/YAVG/YMAX. signalstats gives us min/avg/max only, so we approximate the
// distribution as triangular around the mean: P50≈avg, P5 leans toward min, P95
// toward max. It's a proxy (the loop optimizes toward these measured numbers),
// not a true CDF — good enough to tell "shadows crushed" from "lifted".
function approxPercentiles(min: number, avg: number, max: number) {
  const p5 = Number.isFinite(min) && Number.isFinite(avg) ? Math.round(min + (avg - min) * 0.25) : NaN;
  const p50 = Number.isFinite(avg) ? Math.round(avg) : NaN;
  const p95 = Number.isFinite(max) && Number.isFinite(avg) ? Math.round(avg + (max - avg) * 0.75) : NaN;
  return { p5, p50, p95 };
}

// True per-channel RGB MEANS + CLIP FRACTIONS read off a small raw RGB frame.
//
// WHY raw pixels and not signalstats: ffmpeg's `signalstats` filter runs in the
// video's native YUV space and only ever prints Y/U/V averages — there are NO
// RAVG/GAVG/BAVG keys (the old code read those, so rgbMean/wbBias were always
// NaN). And its YMIN/YMAX are single extreme values, not counts, so a clip% can
// never be derived from them (the old `(YMAX-235)/0.2` formula pinned to 100 on
// any frame with one white-ish pixel). Reading a downscaled rgb24 frame (reusing
// rawFrame, same path editor_video_evidence uses) gives us BOTH real per-channel
// means AND a real fraction of pixels sitting at/near each rail — cheaply, on a
// thumbnail, not the full 1080×1920 surface. FAIL-OPEN: any read failure → all
// fields NaN, never throws.
//
// `near` is how close to a rail counts as clipped: highlights ≥ 255-near,
// shadows ≤ near. A few codes of slack catches codec-rounded rails (235/240 in
// limited-range content still reads as "clipped to the viewer").
function rgbStatsAt(video: string, atSec: number, width = 192, near = 4) {
  let frame: { width: number; height: number; data: Buffer };
  try {
    frame = rawFrame(video, atSec, width);
  } catch {
    return {
      rgbMean: { r: NaN, g: NaN, b: NaN },
      wbBias: { warm: NaN, green: NaN },
      clipHighPct: NaN,
      clipLowPct: NaN,
    };
  }
  const { width: w, height: h, data } = frame;
  let rSum = 0, gSum = 0, bSum = 0;
  let clipHigh = 0, clipLow = 0;
  let total = 0;
  const hi = 255 - near;
  // Stride by 2 in both axes — a thumbnail mean/clip read doesn't need every
  // pixel and this halves the work, matching analyzeFramePixels' sampling.
  for (let y = 0; y < h; y += 2) {
    for (let x = 0; x < w; x += 2) {
      const i = (y * w + x) * 3;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      rSum += r; gSum += g; bSum += b;
      total++;
      // A pixel clips a highlight when ANY channel is at the top rail (one blown
      // channel is still a clipped detail); crushes a shadow when ALL channels
      // sit at the bottom rail (truly black, not just a dark blue).
      if (r >= hi || g >= hi || b >= hi) clipHigh++;
      if (r <= near && g <= near && b <= near) clipLow++;
    }
  }
  if (!total) {
    return {
      rgbMean: { r: NaN, g: NaN, b: NaN },
      wbBias: { warm: NaN, green: NaN },
      clipHighPct: NaN,
      clipLowPct: NaN,
    };
  }
  const rMean = rSum / total;
  const gMean = gSum / total;
  const bMean = bSum / total;
  // White-balance bias, NORMALIZED to ±100 so it's stable across exposure and
  // maps cleanly onto the grade's temperature/tint band (±1 after /100 in the
  // bridge). warm = red-over-blue (a positive value is warm); green = green over
  // the R/B midpoint (a positive value is a green/magenta tint). Divided by 255
  // (full code range) and ×100 → a percentage-of-range signed bias.
  const warm = Number((((rMean - bMean) / 255) * 100).toFixed(1));
  const green = Number((((gMean - (rMean + bMean) / 2) / 255) * 100).toFixed(1));
  return {
    rgbMean: { r: Number(rMean.toFixed(1)), g: Number(gMean.toFixed(1)), b: Number(bMean.toFixed(1)) },
    wbBias: { warm, green },
    clipHighPct: Number(((100 * clipHigh) / total).toFixed(2)),
    clipLowPct: Number(((100 * clipLow) / total).toFixed(2)),
  };
}

// Run signalstats over one frame and pull the LUMA stats ffmpeg prints via
// `metadata=print` (keys look like lavfi.signalstats.YAVG=123.4) for the
// exposure percentiles, then fold in the real RGB means + clip fractions from a
// raw-frame read (rgbStatsAt) — signalstats has no RGB channels of its own.
function signalStatsAt(video: string, atSec: number) {
  const res = spawnSync(
    "ffmpeg",
    ["-v", "error", "-ss", atSec.toFixed(3), "-i", video, "-frames:v", "1",
     "-vf", "signalstats,metadata=mode=print:file=-", "-an", "-f", "null", "-"],
    { cwd: ROOT, encoding: "utf8" },
  );
  const text = `${res.stdout ?? ""}\n${res.stderr ?? ""}`;
  const num = (key: string) => {
    const m = new RegExp(`signalstats\\.${key}=\\s*(-?[0-9.]+)`).exec(text);
    const n = m ? Number(m[1]) : NaN;
    return Number.isFinite(n) ? n : NaN;
  };
  const yMin = num("YMIN");
  const yAvg = num("YAVG");
  const yMax = num("YMAX");
  const { p5, p50, p95 } = approxPercentiles(yMin, yAvg, yMax);
  // Real per-channel means, clip fractions, and WB bias from the raw RGB frame.
  // (Fail-open: rgbStatsAt returns NaN fields on any read error.)
  const rgb = rgbStatsAt(video, atSec);
  return {
    lumaMin: yMin, lumaAvg: yAvg, lumaMax: yMax,
    lumaP5: p5, lumaP50: p50, lumaP95: p95,
    clipHighPct: rgb.clipHighPct, clipLowPct: rgb.clipLowPct,
    rgbMean: rgb.rgbMean,
    wbBias: rgb.wbBias,
  };
}

// Render one scope image for a frame via the named ffmpeg filter. The frame is
// seeked with -ss before -i (fast) then the scope filter rasterizes a single
// PNG. Returns the path on success, null on any failure (fail-open).
function renderScopeImage(video: string, atSec: number, out: string, filter: string) {
  ensureDir(dirname(out));
  const res = spawnSync(
    "ffmpeg",
    ["-y", "-v", "error", "-ss", atSec.toFixed(3), "-i", video, "-frames:v", "1", "-vf", filter, out],
    { cwd: ROOT, encoding: "utf8" },
  );
  return res.status === 0 && existsSync(out) ? out : null;
}

function colorScopes(id: string, video: string, regions: TimelineScene[]) {
  ensureDir(VISION_DIR);
  const scopeDir = join(VISION_DIR, `${id}_scopes`);
  rmSync(scopeDir, { recursive: true, force: true });
  ensureDir(scopeDir);
  // The three scope filters (roadmap §4.1):
  //  - waveform: luma + RGB PARADE (one column trace per channel) at a readable
  //    size — the colorist's exposure/contrast read.
  //  - vectorscope: hue/sat scatter (color=3 paints by input color) — WB + sat.
  //  - histogram: per-channel level distribution — clipping/crush at the rails.
  const WAVEFORM = "waveform=mode=column:display=parade:components=7,scale=480:270";
  const VECTORSCOPE = "vectorscope=mode=color3:graticule=green,scale=270:270";
  const HISTOGRAM = "histogram=display_mode=parade,scale=480:270";
  const scenes = regions.map((r) => {
    // Sample the scene's mid-frame (clamped just inside the window), matching the
    // mid-frame convention used by sceneReadability / visualSceneReadability.
    const atSec = r.startSec + Math.max(0.1, Math.min(r.durationSec * 0.5, r.durationSec - 0.1));
    const stem = `s${String(r.index).padStart(2, "0")}`;
    const scopeImages = {
      waveform: renderScopeImage(video, atSec, join(scopeDir, `${stem}_waveform.png`), WAVEFORM),
      vectorscope: renderScopeImage(video, atSec, join(scopeDir, `${stem}_vectorscope.png`), VECTORSCOPE),
      histogram: renderScopeImage(video, atSec, join(scopeDir, `${stem}_histogram.png`), HISTOGRAM),
    };
    let stats: ReturnType<typeof signalStatsAt> | null = null;
    try {
      stats = signalStatsAt(video, atSec);
    } catch {
      stats = null; // fail-open: a scene without numbers still has its images
    }
    return { index: r.index, id: r.id, type: r.type, atSec: Number(atSec.toFixed(3)), scopeImages, stats };
  });
  // A single contact sheet of every scene's waveform makes scene-to-scene
  // consistency (the colorist's main job) eyeballable in one image.
  const waveforms = scenes.map((s) => s.scopeImages.waveform).filter(Boolean) as string[];
  const contactSheet = waveforms.length ? contactSheetOf(id, waveforms, "scopes_waveforms") : null;
  return { scopeDir, scenes, contactSheet };
}

// Tile a set of images into one sheet (reuses the concat+tile pattern from
// contactSheet but takes pre-rendered scope PNGs of arbitrary size).
function contactSheetOf(id: string, images: string[], label: string) {
  if (!images.length) return null;
  const safeLabel = label.replace(/[^a-zA-Z0-9_.-]/g, "_");
  const list = join(VISION_DIR, `${id}_${safeLabel}_list.txt`);
  writeFileSync(list, images.map((f) => `file '${f.replace(/'/g, "'\\''")}'\nduration 1`).join("\n"));
  const out = join(VISION_DIR, `${id}_${safeLabel}.png`);
  const cols = Math.min(images.length, images.length > 12 ? 6 : 3);
  const res = spawnSync(
    "ffmpeg",
    ["-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", list, "-vf",
     `tile=${cols}x${Math.ceil(images.length / cols)}:margin=6:padding=4`, "-frames:v", "1", out],
    { cwd: ROOT, encoding: "utf8" },
  );
  return res.status === 0 && existsSync(out) ? out : null;
}

function visualPsnr(beforeVideo: string, afterVideo: string, durationSec: number, width: number) {
  if (durationSec <= 0) return null;
  const res = spawnSync("ffmpeg", [
    "-t", durationSec.toFixed(3), "-i", beforeVideo,
    "-t", durationSec.toFixed(3), "-i", afterVideo,
    "-filter_complex", `[0:v]fps=2,scale=${width}:-1,setpts=PTS-STARTPTS[a];[1:v]fps=2,scale=${width}:-1,setpts=PTS-STARTPTS[b];[a][b]psnr`,
    "-f", "null",
    "-",
  ], { cwd: ROOT, encoding: "utf8" });
  const text = `${res.stdout}\n${res.stderr}`;
  const m = /average:([0-9.inf]+)/.exec(text);
  if (!m) return { ok: false, average: null, raw: text.split("\n").slice(-8) };
  return { ok: res.status === 0, average: m[1] === "inf" ? Infinity : Number(m[1]), raw: text.split("\n").slice(-8) };
}

function pairedComparisonFrames(label: string, beforeVideo: string, afterVideo: string, durationSec: number, samples: number, width: number) {
  const dir = join(VISION_DIR, `${label}_compare`);
  rmSync(dir, { recursive: true, force: true });
  ensureDir(dir);
  const points = Array.from({ length: Math.max(1, samples) }, (_, i) => {
    if (samples <= 1) return Number((durationSec / 2).toFixed(3));
    return Number(((durationSec * i) / (samples - 1)).toFixed(3));
  }).map((t) => Math.max(0.05, Math.min(t, Math.max(0.05, durationSec - 0.05))));
  const frames = points.flatMap((atSec, i) => {
    const before = sampleFrameTo(beforeVideo, atSec, join(dir, `before_${String(i).padStart(3, "0")}.jpg`), width);
    const after = sampleFrameTo(afterVideo, atSec, join(dir, `after_${String(i).padStart(3, "0")}.jpg`), width);
    return [
      { side: "before", index: i, atSec, path: before },
      { side: "after", index: i, atSec, path: after },
    ];
  });
  const sheet = contactSheet(label, frames.map((f) => f.path), "before_after_compare");
  return { frameDir: dir, points, frames, contactSheet: sheet };
}

function timelineDelta(before: Item, after: Item) {
  const a = sceneStarts(before);
  const b = sceneStarts(after);
  const max = Math.max(a.length, b.length);
  return {
    beforeSceneCount: a.length,
    afterSceneCount: b.length,
    sceneCountDelta: b.length - a.length,
    beforeDurationSec: Number(a.reduce((sum, s) => sum + s.durationSec, 0).toFixed(3)),
    afterDurationSec: Number(b.reduce((sum, s) => sum + s.durationSec, 0).toFixed(3)),
    scenes: Array.from({ length: max }, (_, i) => ({
      index: i,
      before: a[i] ?? null,
      after: b[i] ?? null,
      durationDeltaSec: a[i] && b[i] ? Number((b[i].durationSec - a[i].durationSec).toFixed(3)) : null,
      typeChanged: !!(a[i] && b[i] && a[i].type !== b[i].type),
      textChanged: !!(before.storyboard?.scenes?.[i] && after.storyboard?.scenes?.[i] && primaryText(before.storyboard.scenes[i]) !== primaryText(after.storyboard.scenes[i])),
    })),
  };
}

function compareDiagnostics(beforeDiag: any, afterDiag: any) {
  return {
    volumeMeanDeltaDb: Number(((afterDiag.volume?.meanDb ?? NaN) - (beforeDiag.volume?.meanDb ?? NaN)).toFixed(3)),
    volumeMaxDeltaDb: Number(((afterDiag.volume?.maxDb ?? NaN) - (beforeDiag.volume?.maxDb ?? NaN)).toFixed(3)),
    silenceDelta: (afterDiag.silence?.length ?? 0) - (beforeDiag.silence?.length ?? 0),
    freezeDelta: (afterDiag.freezes?.length ?? 0) - (beforeDiag.freezes?.length ?? 0),
    blackFrameDelta: (afterDiag.blackFrames?.length ?? 0) - (beforeDiag.blackFrames?.length ?? 0),
    sceneChangeDelta: (afterDiag.sceneChanges?.length ?? 0) - (beforeDiag.sceneChanges?.length ?? 0),
  };
}

function compareRenders(beforeId: string, afterId: string, opts: { samples: number; width: number }) {
  ensureDir(REVIEW_DIR);
  const before = loadRaw(beforeId);
  const after = loadRaw(afterId);
  const beforeVideo = videoFile(before);
  const afterVideo = videoFile(after);
  if (!beforeVideo) throw new Error(`no rendered video found for before id ${beforeId}`);
  if (!afterVideo) throw new Error(`no rendered video found for after id ${afterId}`);
  const beforeMeta = ffprobe(beforeVideo);
  const afterMeta = ffprobe(afterVideo);
  const beforeDuration = durationFromProbe(beforeMeta);
  const afterDuration = durationFromProbe(afterMeta);
  const overlap = Math.max(0, Math.min(beforeDuration, afterDuration));
  const label = `${beforeId}_vs_${afterId}`.replace(/[^a-zA-Z0-9_.-]/g, "_");
  const beforeDiag = videoDiagnostics(`${label}_before`, beforeVideo);
  const afterDiag = videoDiagnostics(`${label}_after`, afterVideo);
  const diagnosticDelta = compareDiagnostics(beforeDiag, afterDiag);
  const psnr = visualPsnr(beforeVideo, afterVideo, overlap, opts.width);
  const evidence = pairedComparisonFrames(label, beforeVideo, afterVideo, overlap, opts.samples, opts.width);
  const timeline = timelineDelta(before, after);
  const regressions: string[] = [];
  const improvements: string[] = [];
  if (diagnosticDelta.blackFrameDelta > 0) regressions.push("after render has more black-frame intervals");
  if (diagnosticDelta.blackFrameDelta < 0) improvements.push("after render has fewer black-frame intervals");
  if (diagnosticDelta.freezeDelta > 0) regressions.push("after render has more freeze intervals");
  if (diagnosticDelta.freezeDelta < 0) improvements.push("after render has fewer freeze intervals");
  if (diagnosticDelta.silenceDelta > 0) regressions.push("after render has more silence intervals");
  if (diagnosticDelta.silenceDelta < 0) improvements.push("after render has fewer silence intervals");
  if (Math.abs(afterDuration - beforeDuration) > 4) regressions.push("duration changed by more than 4 seconds; verify pacing intentionally changed");
  if (timeline.sceneCountDelta !== 0) improvements.push(`scene count changed by ${timeline.sceneCountDelta}; verify timeline restructuring is intentional`);
  const report = {
    beforeId,
    afterId,
    generatedAt: new Date().toISOString(),
    videos: { before: beforeVideo, after: afterVideo },
    durations: { beforeSec: beforeDuration, afterSec: afterDuration, deltaSec: Number((afterDuration - beforeDuration).toFixed(3)), overlapSec: overlap },
    metadata: { before: beforeMeta, after: afterMeta },
    timeline,
    diagnostics: { before: beforeDiag, after: afterDiag, delta: diagnosticDelta },
    visualSimilarity: psnr,
    evidence,
    improvements,
    regressions,
    verdict: regressions.length ? "needs_review" : improvements.length ? "changed_with_no_detected_regression" : "no_major_regression_detected",
    nextCommands: [
      `pnpm editor frame ${beforeId} --time ${evidence.points[0]?.toFixed(2) ?? "1.0"}`,
      `pnpm editor frame ${afterId} --time ${evidence.points[0]?.toFixed(2) ?? "1.0"}`,
      `pnpm editor deep-review ${afterId} --sample-fps 2 --width ${opts.width}`,
    ],
  };
  const jsonPath = join(REVIEW_DIR, `${label}_render_compare.json`);
  const mdPath = join(REVIEW_DIR, `${label}_render_compare.md`);
  writeFileSync(jsonPath, JSON.stringify(report, null, 2));
  writeFileSync(mdPath, [
    `# Render Compare: ${beforeId} -> ${afterId}`,
    "",
    `Verdict: **${report.verdict}**`,
    "",
    `Duration delta: ${report.durations.deltaSec}s`,
    `Visual PSNR average: ${report.visualSimilarity?.average ?? "unavailable"}`,
    "",
    "## Improvements",
    ...(improvements.length ? improvements.map((x) => `- ${x}`) : ["- None detected by deterministic checks."]),
    "",
    "## Regressions",
    ...(regressions.length ? regressions.map((x) => `- ${x}`) : ["- None detected by deterministic checks."]),
    "",
    "## Evidence",
    `- Contact sheet: ${evidence.contactSheet}`,
    `- Frame dir: ${evidence.frameDir}`,
    `- JSON: ${jsonPath}`,
    "",
    "## Next Commands",
    ...report.nextCommands.map((x) => `- \`${x}\``),
  ].join("\n"));
  return { jsonPath, markdownPath: mdPath, report };
}

function reviewIssues(item: Item, diagnostics: any, scan: any | null) {
  const issues: { severity: "info" | "warning" | "error"; area: string; evidence: unknown; recommendation: string }[] = [];
  const timeline = sceneStarts(item);
  const validation = validateStoryboard(item);
  if (!validation.valid) {
    issues.push({ severity: "error", area: "schema", evidence: validation.issues, recommendation: `Run pnpm editor state ${item.id}, fix invalid scene fields, then pnpm editor validate ${item.id}.` });
  }
  for (const s of timeline) {
    if (s.durationSec > 8) issues.push({ severity: "warning", area: "pacing", evidence: s, recommendation: `Consider splitting scene ${s.index}: pnpm editor split-scene ${item.id} ${s.index} ${(s.durationSec / 2).toFixed(1)}` });
    if (s.durationSec < 2.2) issues.push({ severity: "warning", area: "pacing", evidence: s, recommendation: `Scene ${s.index} may be too fast for comprehension; increase duration or simplify text.` });
  }
  for (const silence of diagnostics.silence ?? []) {
    if ((silence.durationSec ?? 0) > 0.7) issues.push({ severity: "warning", area: "audio", evidence: silence, recommendation: "Patch mix/voice timing or rerender with voice/music checks." });
  }
  for (const freeze of diagnostics.freezes ?? []) {
    if ((freeze.durationSec ?? 0) > 1.25) issues.push({ severity: "warning", area: "motion", evidence: freeze, recommendation: "Inspect frames around this timestamp and add motion/effect changes if the stillness is not intentional." });
  }
  for (const black of diagnostics.blackFrames ?? []) {
    if ((black.durationSec ?? 0) > 0.5) issues.push({ severity: "error", area: "visual", evidence: black, recommendation: "Extract a frame in this interval and patch the affected scene or b-roll." });
  }
  if (Number.isFinite(diagnostics.volume?.maxDb) && diagnostics.volume.maxDb > -0.3) {
    issues.push({ severity: "warning", area: "audio", evidence: diagnostics.volume, recommendation: `Lower mix volume: pnpm editor set ${item.id} mix.musicVol 0.75` });
  }
  if (Number.isFinite(diagnostics.volume?.meanDb) && diagnostics.volume.meanDb < -24) {
    issues.push({ severity: "warning", area: "audio", evidence: diagnostics.volume, recommendation: "Audio is quiet; raise voice/music mix or rerender audio." });
  }
  if (scan && scan.frameCount < timeline.length) {
    issues.push({ severity: "info", area: "coverage", evidence: { frameCount: scan.frameCount, scenes: timeline.length }, recommendation: "Increase sampleFps for a denser visual review." });
  }
  return issues;
}

function competitiveReview(id: string, item: Item, video: string, opts: { sampleFps: number; width: number; framesPerSheet: number; scan: boolean }) {
  ensureDir(REVIEW_DIR);
  const metadata = ffprobe(video);
  const diagnostics = videoDiagnostics(id, video);
  const scan = opts.scan ? denseFrameScan(id, video, opts.sampleFps, opts.width, opts.framesPerSheet) : null;
  const timeline = sceneStarts(item);
  const issues = reviewIssues(item, diagnostics, scan);
  const opportunityScores = competitorOpportunityScores();
  const roadmap = strategicRoadmap();
  const nextCommands = [
    `pnpm editor clone ${id} --new-id ${id}_agent_draft`,
    `pnpm editor scan-video ${id} --sample-fps ${Math.max(2, opts.sampleFps)} --width ${opts.width} --frames-per-sheet ${opts.framesPerSheet}`,
    `pnpm editor analyze-av ${id}`,
    `pnpm editor frame ${id} --time ${timeline[0] ? (timeline[0].startSec + Math.min(1, timeline[0].durationSec / 2)).toFixed(2) : "1.0"}`,
  ];
  const review = {
    id,
    generatedAt: new Date().toISOString(),
    video,
    metadata,
    timeline,
    competitorIntel: COMPETITOR_INTEL,
    opportunityScores,
    unmetJobs: UNMET_JOBS,
    strategicEdge: OUR_STRATEGIC_EDGE,
    roadmap,
    diagnostics,
    scan,
    issues,
    nextCommands,
    thesis: "The product should not compete as another AI editor. It should compete as an agent-native video operating system: every visual/audio claim must have inspectable evidence, every edit must be executable by tool call, and every render must be reviewable by another model.",
  };
  const jsonPath = join(REVIEW_DIR, `${id}_competitive_review.json`);
  const mdPath = join(REVIEW_DIR, `${id}_competitive_review.md`);
  writeFileSync(jsonPath, JSON.stringify(review, null, 2));
  writeFileSync(mdPath, [
    `# Competitive Agent Review: ${id}`,
    "",
    review.thesis,
    "",
    "## Strategic Edge",
    ...OUR_STRATEGIC_EDGE.map((x) => `- ${x}`),
    "",
    "## Highest Opportunity Scores",
    ...opportunityScores.slice(0, 5).map((x) => `- **${x.dimension}** gap ${x.gap} (competitor avg ${x.competitorAvg}, target ${x.ourTarget})`),
    "",
    "## Competitor Baseline",
    ...COMPETITOR_INTEL.map((c) => `- **${c.name}** (${c.category}): ${c.strengths.join(", ")}. Gap: ${c.gaps[0]}`),
    "",
    "## Unmet Jobs",
    ...UNMET_JOBS.map((x) => `- **${x.job}** ${x.productMove}`),
    "",
    "## Issues",
    ...(issues.length ? issues.map((x) => `- **${x.severity} / ${x.area}** ${x.recommendation}`) : ["- No deterministic issues detected." ]),
    "",
    "## Roadmap",
    ...roadmap.map((x) => `- **${x.priority} ${x.id}**: ${x.reason} Command shape: \`${x.commandShape}\``),
    "",
    "## Next Commands",
    ...nextCommands.map((x) => `- \`${x}\``),
    "",
    "## Artifacts",
    `- JSON: ${jsonPath}`,
    `- Waveform: ${diagnostics.waveformPath ?? "none"}`,
    `- Frame manifest: ${scan?.manifestPath ?? "scan disabled"}`,
  ].join("\n"));
  return { reviewPath: jsonPath, markdownPath: mdPath, review };
}

function summarize(item: Item) {
  return {
    id: item.id,
    status: item.status,
    channel: item.channel,
    title: item.pkg?.title ?? item.idea?.topic ?? item.seedIdea,
    updatedAt: item.updatedAt,
    video: videoFile(item),
    scenes: sceneStarts(item).map((s) => ({ ...s, text: primaryText(item.storyboard.scenes[s.index]) })),
    mix: item.mix ?? {},
    storyboardValid: validateStoryboard(item),
  };
}

function primaryText(scene: any) {
  if (!scene) return "";
  if (scene.text) return scene.text;
  if (scene.caption) return scene.caption;
  if (scene.title) return scene.title;
  if (Array.isArray(scene.lines)) return scene.lines.map((x: any) => (typeof x === "string" ? x : x.text)).filter(Boolean).join(" / ");
  if (scene.code) return scene.code.split("\n").slice(0, 2).join(" ");
  return "";
}

function sceneTextBlocks(scene: any) {
  if (!scene) return [];
  const blocks: { label: string; text: string }[] = [];
  const add = (label: string, text: unknown) => {
    if (typeof text === "string" && text.trim()) blocks.push({ label, text: text.trim() });
  };
  add("text", scene.text);
  add("caption", scene.caption);
  add("title", scene.title);
  add("say", scene.say);
  add("warning", scene.type === "warning" ? scene.text : undefined);
  add("cta", scene.type === "cta" ? scene.text : undefined);
  if (Array.isArray(scene.lines)) {
    for (const [i, line] of scene.lines.entries()) add(`line_${i}`, typeof line === "string" ? line : line?.text);
  }
  if (scene.left) {
    add("left_title", scene.left.title);
    add("left_text", scene.left.text);
  }
  if (scene.right) {
    add("right_title", scene.right.title);
    add("right_text", scene.right.text);
  }
  add("code", scene.code);
  return blocks;
}

function words(text: string) {
  return text.trim().split(/\s+/).filter(Boolean);
}

function readabilityThresholds(sceneType: string) {
  if (sceneType === "terminal" || sceneType === "code_block") return { maxWordsPerSec: 3.2, maxCharsPerSec: 24, maxLineChars: 70, maxBlocks: 8 };
  if (sceneType === "before_after") return { maxWordsPerSec: 3.8, maxCharsPerSec: 28, maxLineChars: 42, maxBlocks: 8 };
  if (sceneType === "kinetic_text") return { maxWordsPerSec: 2.8, maxCharsPerSec: 22, maxLineChars: 36, maxBlocks: 4 };
  return { maxWordsPerSec: 2.6, maxCharsPerSec: 20, maxLineChars: 38, maxBlocks: 4 };
}

function sceneReadability(id: string, item: Item, video: string | null, timelineScene: TimelineScene) {
  const scene = item.storyboard?.scenes?.[timelineScene.index];
  const blocks = sceneTextBlocks(scene);
  const text = blocks.map((b) => b.text).join("\n");
  const wordCount = words(text).length;
  const charCount = text.replace(/\s+/g, " ").trim().length;
  const lines = text.split(/\n+/).flatMap((line) => line.split(/\\n/)).filter(Boolean);
  const longestLineChars = lines.reduce((n, line) => Math.max(n, line.length), 0);
  const thresholds = readabilityThresholds(scene?.type);
  const wordsPerSec = Number((wordCount / Math.max(0.1, timelineScene.durationSec)).toFixed(2));
  const charsPerSec = Number((charCount / Math.max(0.1, timelineScene.durationSec)).toFixed(2));
  const issues: { severity: "info" | "warning" | "error"; reason: string; command?: string }[] = [];
  if (wordsPerSec > thresholds.maxWordsPerSec) issues.push({
    severity: "warning",
    reason: `Too many words for duration (${wordsPerSec} w/s > ${thresholds.maxWordsPerSec} w/s).`,
    command: `pnpm editor patch-scene ${id} ${timelineScene.index} '{"durationSec":${Math.min(14, Number((timelineScene.durationSec * 1.25).toFixed(2)))}}'`,
  });
  if (charsPerSec > thresholds.maxCharsPerSec) issues.push({ severity: "warning", reason: `Text changes too fast (${charsPerSec} chars/s > ${thresholds.maxCharsPerSec} chars/s).` });
  if (longestLineChars > thresholds.maxLineChars) issues.push({ severity: "warning", reason: `Long line may wrap or clip (${longestLineChars} chars > ${thresholds.maxLineChars}).` });
  if (blocks.length > thresholds.maxBlocks) issues.push({ severity: "warning", reason: `Too many text blocks on one scene (${blocks.length} > ${thresholds.maxBlocks}).` });
  if ((scene?.style?.fontScale ?? 1) < 0.8) issues.push({
    severity: "info",
    reason: "Font scale is small for mobile reading.",
    command: `pnpm editor style ${id} ${timelineScene.index} '{"fontScale":1}'`,
  });
  const score = Math.max(0, Math.round(100
    - Math.max(0, wordsPerSec - thresholds.maxWordsPerSec) * 18
    - Math.max(0, charsPerSec - thresholds.maxCharsPerSec) * 2.2
    - Math.max(0, longestLineChars - thresholds.maxLineChars) * 1.2
    - Math.max(0, blocks.length - thresholds.maxBlocks) * 8
    - (issues.some((x) => x.severity === "error") ? 25 : 0)));
  const midSec = timelineScene.startSec + Math.max(0.1, Math.min(timelineScene.durationSec * 0.5, timelineScene.durationSec - 0.1));
  const framePath = video ? sampleFrame(id, video, midSec, `readability_s${timelineScene.index}`) : null;
  return {
    scene: timelineScene,
    type: scene?.type,
    blocks,
    metrics: { wordCount, charCount, lineCount: lines.length, longestLineChars, wordsPerSec, charsPerSec, blockCount: blocks.length, fontScale: scene?.style?.fontScale ?? 1 },
    thresholds,
    score,
    issues,
    evidence: { framePath, atSec: Number(midSec.toFixed(3)) },
  };
}

function readabilityReview(id: string, opts: { width?: number }) {
  ensureDir(REVIEW_DIR);
  const item = loadRaw(id);
  const video = videoFile(item);
  const timeline = sceneStarts(item);
  const scenes = timeline.map((t) => sceneReadability(id, item, video, t));
  const allIssues = scenes.flatMap((s) => s.issues.map((issue) => ({ sceneIndex: s.scene.index, type: s.type, ...issue })));
  const avgScore = scenes.length ? Math.round(scenes.reduce((sum, s) => sum + s.score, 0) / scenes.length) : 0;
  const worst = [...scenes].sort((a, b) => a.score - b.score).slice(0, 3);
  const verdict = avgScore >= 85 && !allIssues.some((i) => i.severity === "error") ? "readable" : avgScore >= 70 ? "needs_review" : "hard_to_read";
  const nextCommands = [
    ...worst.flatMap((s) => s.issues.map((i) => i.command).filter(Boolean) as string[]),
    `pnpm editor deep-review ${id} --sample-fps 2 --width ${opts.width ?? 360}`,
  ];
  const review = {
    id,
    generatedAt: new Date().toISOString(),
    video,
    verdict,
    avgScore,
    scenes,
    issues: allIssues,
    worstScenes: worst.map((s) => ({ index: s.scene.index, score: s.score, type: s.type, issues: s.issues, evidence: s.evidence })),
    nextCommands: [...new Set(nextCommands)],
    competitorAngle: "Caption tools in mainstream editors generate text; this review proves whether rendered text is readable enough for a model-operated production loop.",
  };
  const jsonPath = join(REVIEW_DIR, `${id}_readability_review.json`);
  const mdPath = join(REVIEW_DIR, `${id}_readability_review.md`);
  writeFileSync(jsonPath, JSON.stringify(review, null, 2));
  writeFileSync(mdPath, [
    `# Readability Review: ${id}`,
    "",
    `Verdict: **${verdict}**`,
    `Average score: ${avgScore}/100`,
    "",
    "## Worst Scenes",
    ...(worst.length ? worst.map((s) => `- Scene ${s.scene.index} (${s.type}) score ${s.score}: ${s.issues.map((i) => i.reason).join(" ") || "No issue text."} Evidence: ${s.evidence.framePath ?? "none"}`) : ["- None."]),
    "",
    "## Issues",
    ...(allIssues.length ? allIssues.map((i) => `- Scene ${i.sceneIndex} / ${i.severity}: ${i.reason}${i.command ? ` Command: \`${i.command}\`` : ""}`) : ["- No deterministic readability issues detected."]),
    "",
    "## Next Commands",
    ...review.nextCommands.map((x) => `- \`${x}\``),
    "",
    "## Artifacts",
    `- JSON: ${jsonPath}`,
  ].join("\n"));
  return { jsonPath, markdownPath: mdPath, review };
}

function analyzeFramePixels(frame: { width: number; height: number; data: Buffer }) {
  const { width, height, data } = frame;
  const luma = (idx: number) => 0.2126 * data[idx] + 0.7152 * data[idx + 1] + 0.0722 * data[idx + 2];
  const marginX = Math.round(width * 0.08);
  const marginY = Math.round(height * 0.08);
  const safe = { x0: marginX, y0: marginY, x1: width - marginX, y1: height - marginY };
  let bright = 0;
  let dark = 0;
  let edge = 0;
  let unsafeBright = 0;
  let unsafeEdge = 0;
  let centralBright = 0;
  let centralDark = 0;
  let centralCount = 0;
  let total = 0;
  for (let y = 1; y < height - 1; y += 2) {
    for (let x = 1; x < width - 1; x += 2) {
      const i = (y * width + x) * 3;
      const lum = luma(i);
      const right = luma((y * width + x + 1) * 3);
      const down = luma(((y + 1) * width + x) * 3);
      const grad = Math.abs(lum - right) + Math.abs(lum - down);
      const inSafe = x >= safe.x0 && x <= safe.x1 && y >= safe.y0 && y <= safe.y1;
      const inCentral = x >= width * 0.12 && x <= width * 0.88 && y >= height * 0.12 && y <= height * 0.88;
      total++;
      if (lum > 210) bright++;
      if (lum < 45) dark++;
      if (grad > 95) edge++;
      if (!inSafe && lum > 190) unsafeBright++;
      if (!inSafe && grad > 95) unsafeEdge++;
      if (inCentral) {
        centralCount++;
        if (lum > 200) centralBright++;
        if (lum < 55) centralDark++;
      }
    }
  }
  const pct = (n: number, d = total) => Number(((100 * n) / Math.max(1, d)).toFixed(3));
  const centralBrightPct = pct(centralBright, centralCount);
  const centralDarkPct = pct(centralDark, centralCount);
  const contrastBalance = Math.min(centralBrightPct, centralDarkPct);
  return {
    width,
    height,
    safeArea: safe,
    brightPct: pct(bright),
    darkPct: pct(dark),
    edgePct: pct(edge),
    unsafeBrightPct: pct(unsafeBright),
    unsafeEdgePct: pct(unsafeEdge),
    centralBrightPct,
    centralDarkPct,
    contrastBalance,
  };
}

function visualSceneReadability(id: string, item: Item, video: string, timelineScene: TimelineScene, width: number) {
  const atSec = timelineScene.startSec + Math.max(0.1, Math.min(timelineScene.durationSec * 0.5, timelineScene.durationSec - 0.1));
  const framePath = sampleFrame(id, video, atSec, `visual_readability_s${timelineScene.index}`);
  const metrics = analyzeFramePixels(rawFrame(video, atSec, width));
  const issues: { severity: "info" | "warning" | "error"; reason: string; command?: string }[] = [];
  if (metrics.unsafeBrightPct > 3.5 || metrics.unsafeEdgePct > 6) {
    issues.push({
      severity: "warning",
      reason: `High visual activity near unsafe edges (bright ${metrics.unsafeBrightPct}%, edge ${metrics.unsafeEdgePct}%).`,
      command: `pnpm editor style ${id} ${timelineScene.index} '{"align":"center"}'`,
    });
  }
  if (metrics.contrastBalance < 0.5 && metrics.edgePct < 4) {
    issues.push({
      severity: "warning",
      reason: `Low central contrast signal (balance ${metrics.contrastBalance}%, edge ${metrics.edgePct}%). Text may blend into background.`,
      command: `pnpm editor effect ${id} ${timelineScene.index} contrast true`,
    });
  }
  if (metrics.brightPct > 42 || metrics.darkPct > 74) {
    issues.push({ severity: "info", reason: `Frame luminance is extreme (bright ${metrics.brightPct}%, dark ${metrics.darkPct}%). Verify text remains readable.` });
  }
  const score = Math.max(0, Math.round(100
    - Math.max(0, metrics.unsafeBrightPct - 3.5) * 6
    - Math.max(0, metrics.unsafeEdgePct - 6) * 3
    - Math.max(0, 0.5 - metrics.contrastBalance) * 18
    - Math.max(0, 4 - metrics.edgePct) * 2));
  return {
    scene: timelineScene,
    type: item.storyboard?.scenes?.[timelineScene.index]?.type,
    metrics,
    score,
    issues,
    evidence: { framePath, atSec: Number(atSec.toFixed(3)) },
  };
}

function visualReadabilityReview(id: string, opts: { width: number }) {
  ensureDir(REVIEW_DIR);
  const item = loadRaw(id);
  const video = videoFile(item);
  if (!video) throw new Error("no rendered video found");
  const timeline = sceneStarts(item);
  const scenes = timeline.map((t) => visualSceneReadability(id, item, video, t, opts.width));
  const issues = scenes.flatMap((s) => s.issues.map((issue) => ({ sceneIndex: s.scene.index, type: s.type, ...issue })));
  const avgScore = scenes.length ? Math.round(scenes.reduce((sum, s) => sum + s.score, 0) / scenes.length) : 0;
  const worst = [...scenes].sort((a, b) => a.score - b.score).slice(0, 3);
  const verdict = avgScore >= 86 && !issues.some((i) => i.severity === "error") ? "visually_readable" : avgScore >= 72 ? "needs_review" : "visual_risk";
  const nextCommands = [
    ...worst.flatMap((s) => s.issues.map((i) => i.command).filter(Boolean) as string[]),
    `pnpm editor readability ${id} --width ${opts.width}`,
  ];
  const review = {
    id,
    generatedAt: new Date().toISOString(),
    video,
    width: opts.width,
    verdict,
    avgScore,
    scenes,
    issues,
    worstScenes: worst.map((s) => ({ index: s.scene.index, score: s.score, type: s.type, issues: s.issues, evidence: s.evidence, metrics: s.metrics })),
    nextCommands: [...new Set(nextCommands)],
    competitorAngle: "Mainstream caption tools usually stop after generating text. This checks rendered pixels for edge safety and visual contrast risk.",
  };
  const jsonPath = join(REVIEW_DIR, `${id}_visual_readability_review.json`);
  const mdPath = join(REVIEW_DIR, `${id}_visual_readability_review.md`);
  writeFileSync(jsonPath, JSON.stringify(review, null, 2));
  writeFileSync(mdPath, [
    `# Visual Readability Review: ${id}`,
    "",
    `Verdict: **${verdict}**`,
    `Average score: ${avgScore}/100`,
    "",
    "## Worst Scenes",
    ...(worst.length ? worst.map((s) => `- Scene ${s.scene.index} (${s.type}) score ${s.score}: ${s.issues.map((i) => i.reason).join(" ") || "No issue text."} Evidence: ${s.evidence.framePath}`) : ["- None."]),
    "",
    "## Issues",
    ...(issues.length ? issues.map((i) => `- Scene ${i.sceneIndex} / ${i.severity}: ${i.reason}${i.command ? ` Command: \`${i.command}\`` : ""}`) : ["- No deterministic visual readability issues detected."]),
    "",
    "## Next Commands",
    ...review.nextCommands.map((x) => `- \`${x}\``),
    "",
    "## Artifacts",
    `- JSON: ${jsonPath}`,
  ].join("\n"));
  return { jsonPath, markdownPath: mdPath, review };
}

function normalizeText(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function tokenSet(s: string) {
  return new Set(normalizeText(s).split(/\s+/).filter((x) => x.length > 1));
}

function textSimilarity(a: string, b: string) {
  const aa = tokenSet(a);
  const bb = tokenSet(b);
  if (!aa.size && !bb.size) return 1;
  if (!aa.size || !bb.size) return 0;
  let inter = 0;
  for (const x of aa) if (bb.has(x)) inter++;
  return Number((inter / Math.max(1, Math.min(aa.size, bb.size))).toFixed(3));
}

function runVisionOcr(paths: string[]) {
  const script = join(SCRIPTS_DIR, "vision-ocr.swift");
  if (!existsSync(script) || !paths.length) return { available: false, results: [], error: "Vision OCR script unavailable" };
  const res = spawnSync("swift", [script, ...paths], { cwd: ROOT, encoding: "utf8", timeout: 1000 * 60 });
  if (res.status !== 0) return { available: false, results: [], error: res.stderr || res.stdout || `swift exited ${res.status}` };
  try {
    return { available: true, results: JSON.parse(res.stdout), error: null };
  } catch (e) {
    return { available: false, results: [], error: e instanceof Error ? e.message : String(e) };
  }
}

function clampNum(value: unknown, min: number, max: number, fallback: number) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(n, max));
}

function frameVisualMetrics(video: string, atSec: number, width: number, previous?: { data: Buffer }) {
  const frame = rawFrame(video, atSec, width);
  const metrics = analyzeFramePixels(frame);
  let motionDelta = 0;
  if (previous?.data?.length === frame.data.length) {
    let diff = 0;
    for (let i = 0; i < frame.data.length; i += 9) diff += Math.abs(frame.data[i] - previous.data[i]);
    motionDelta = Number((diff / Math.max(1, frame.data.length / 9) / 255).toFixed(4));
  }
  return { frame, metrics, motionDelta };
}

function extractAudioForTranscript(id: string, video: string) {
  const out = join(VISION_DIR, `${id}_evidence_audio.wav`);
  const res = spawnSync("ffmpeg", ["-y", "-i", video, "-vn", "-ac", "1", "-ar", "16000", out], { cwd: ROOT, encoding: "utf8" });
  return res.status === 0 && existsSync(out) ? out : null;
}

/** Apply a caller-supplied glossary of "wrong → right" spellings to the transcript
 *  WITHOUT disturbing word timings: each fix is matched token-by-token (single or
 *  multi-word) on `words[]` and the matched run's timestamps are preserved (the
 *  replacement reuses the run's start/end, splitting evenly if the token count
 *  changes). `text`/`segments[].text` get a plain case-insensitive string swap.
 *  This is the safety net for proper nouns Whisper's initial_prompt still misses. */
function applyGlossary(
  parsed: { text?: string; words?: any[]; segments?: any[] },
  glossary: Array<{ from: string; to: string }>,
): { text: string; words: any[]; segments: any[] } {
  let words: any[] = Array.isArray(parsed.words) ? parsed.words.slice() : [];
  let text = parsed.text ?? "";
  let segments: any[] = Array.isArray(parsed.segments) ? parsed.segments.slice() : [];
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  for (const { from, to } of glossary) {
    const fromToks = from.trim().split(/\s+/).map(norm).filter(Boolean);
    const toToks = to.trim().split(/\s+/);
    if (!fromToks.length || !toToks.length) continue;
    // word-array: slide a window of fromToks.length, match on normalized tokens.
    const out: any[] = [];
    for (let i = 0; i < words.length; ) {
      const window = words.slice(i, i + fromToks.length);
      const hit = window.length === fromToks.length && window.every((w, k) => norm(String(w.word ?? "")) === fromToks[k]);
      if (hit) {
        const start = Number(window[0].start ?? window[0].end ?? 0);
        const end = Number(window[window.length - 1].end ?? window[window.length - 1].start ?? start);
        const span = Math.max(0, end - start) / toToks.length;
        // carry leading whitespace style of the first matched token.
        const lead = /^\s/.test(String(window[0].word ?? "")) ? " " : "";
        toToks.forEach((t, k) => out.push({ word: (k === 0 ? lead : " ") + t, start: round3(start + span * k), end: round3(start + span * (k + 1)) }));
        i += fromToks.length;
      } else {
        out.push(words[i]);
        i += 1;
      }
    }
    words = out;
    const re = new RegExp(from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
    text = text.replace(re, to);
    segments = segments.map((s) => ({ ...s, text: typeof s.text === "string" ? s.text.replace(re, to) : s.text }));
  }
  return { text, words, segments };
}
const round3 = (n: number) => Math.round(n * 1000) / 1000;

function transcribeVideoAudio(
  id: string,
  video: string,
  opts: { prompt?: string; glossary?: Array<{ from: string; to: string }> } = {},
) {
  // `segments` (Pillar 5 / Ingest §7.1.2): the line-level boundaries the deep
  // understanding pipeline needs (speaker turns / redundancy / editorial scorers).
  // Additive — every existing caller reads only `text`/`words` and is unaffected.
  // `opts.prompt` biases Whisper toward known names/jargon (initial_prompt); a
  // `opts.glossary` of wrong→right spellings is a deterministic post-correction
  // that preserves word timings (for names the model STILL mishears).
  if (!existsSync(VENV_PY)) return { available: false, reason: "local Whisper Python env unavailable", audioPath: null, text: "", words: [], segments: [] as any[] };
  const audioPath = extractAudioForTranscript(id, video);
  if (!audioPath) return { available: false, reason: "audio extraction failed", audioPath: null, text: "", words: [], segments: [] as any[] };
  const cliArgs = [join(SCRIPTS_DIR, "whisper-words.py"), audioPath];
  if (opts.prompt && opts.prompt.trim()) cliArgs.push("--prompt", opts.prompt.trim().slice(0, 800));
  const res = spawnSync(VENV_PY, cliArgs, { cwd: ROOT, encoding: "utf8", timeout: 1000 * 60 * 5 });
  if (res.status !== 0) return { available: false, reason: res.stderr || res.stdout || `whisper exited ${res.status}`, audioPath, text: "", words: [], segments: [] as any[] };
  try {
    let parsed = JSON.parse(res.stdout);
    if (opts.glossary && opts.glossary.length) parsed = { ...parsed, ...applyGlossary(parsed, opts.glossary) };
    return { available: true, reason: null, audioPath, text: parsed.text ?? "", words: parsed.words ?? [], segments: parsed.segments ?? [] };
  } catch (e) {
    return { available: false, reason: e instanceof Error ? e.message : String(e), audioPath, text: "", words: [], segments: [] as any[] };
  }
}

function wordsInRange(wordsList: any[], startSec: number, endSec: number) {
  return wordsList.filter((w) => Number(w.end ?? w.start ?? 0) >= startSec && Number(w.start ?? w.end ?? 0) <= endSec);
}

function sceneAtTime(timeline: TimelineScene[], atSec: number) {
  return timeline.find((s) => atSec >= s.startSec && atSec < s.endSec) ?? timeline[timeline.length - 1] ?? null;
}

function issueTagsForEvidence(entry: any, scene: TimelineScene | null, diagnostics: any, textSimilarityValue: number | null) {
  const tags: string[] = [];
  if (scene && scene.durationSec < 2.2) tags.push("fast_scene");
  if (entry.motionDelta < 0.006) tags.push("low_motion_sample");
  if (entry.motionDelta > 0.14) tags.push("high_motion_sample");
  if (entry.pixelMetrics.unsafeEdgePct > 6 || entry.pixelMetrics.unsafeBrightPct > 3.5) tags.push("unsafe_edge_activity");
  if (entry.pixelMetrics.contrastBalance < 0.5 && entry.pixelMetrics.edgePct < 4) tags.push("low_contrast_risk");
  if (textSimilarityValue != null && textSimilarityValue < 0.35) tags.push("ocr_storyboard_mismatch");
  if ((diagnostics.silence ?? []).some((x: any) => Number(x.startSec) <= entry.atSec && (x.endSec == null || Number(x.endSec) >= entry.atSec))) tags.push("audio_silence_here");
  if ((diagnostics.freezes ?? []).some((x: any) => Number(x.startSec) <= entry.atSec && (x.endSec == null || Number(x.endSec) >= entry.atSec))) tags.push("freeze_here");
  if ((diagnostics.blackFrames ?? []).some((x: any) => Number(x.startSec) <= entry.atSec && (x.endSec == null || Number(x.endSec) >= entry.atSec))) tags.push("black_frame_here");
  return [...new Set(tags)];
}

function videoEvidenceTimeline(id: string, opts: { sampleFps: number; width: number; framesPerSheet: number; maxOcrFrames: number; transcribe: boolean }) {
  ensureDir(REVIEW_DIR);
  ensureDir(VISION_DIR);
  const item = loadRaw(id);
  const video = videoFile(item);
  if (!video) throw new Error("no rendered video found");
  const sampleFps = clampNum(opts.sampleFps, 0.25, 8, 1);
  const width = Math.round(clampNum(opts.width, 120, 1080, 320));
  const framesPerSheet = Math.round(clampNum(opts.framesPerSheet, 6, 60, 24));
  const maxOcrFrames = Math.round(clampNum(opts.maxOcrFrames, 0, 240, 80));
  const metadata = ffprobe(video);
  const durationSec = durationFromProbe(metadata);
  const timeline = sceneStarts(item);
  const diagnostics = videoDiagnostics(`${id}_evidence`, video);
  const scan = denseFrameScan(`${id}_evidence`, video, sampleFps, width, framesPerSheet);
  const transcript = opts.transcribe === false ? { available: false, reason: "transcription disabled", audioPath: null, text: "", words: [] } : transcribeVideoAudio(`${id}_evidence`, video);
  const step = maxOcrFrames > 0 ? Math.max(1, Math.ceil(scan.frames.length / maxOcrFrames)) : Number.POSITIVE_INFINITY;
  const ocrTargets = scan.frames.filter((_, i) => i % step === 0).map((f) => f.path);
  const ocr = runVisionOcr(ocrTargets);
  const ocrByPath = new Map((ocr.results as any[]).map((r) => [r.path, r]));
  const entries: any[] = [];
  let previousRaw: { data: Buffer } | undefined;
  for (const frame of scan.frames) {
    const scene = sceneAtTime(timeline, frame.atSec);
    const visual = frameVisualMetrics(video, frame.atSec, Math.min(width, 320), previousRaw);
    previousRaw = { data: visual.frame.data };
    const ocrResult = ocrByPath.get(frame.path) ?? null;
    const renderedText = ocrResult ? (ocrResult.lines ?? []).map((l: any) => l.text).join("\n") : "";
    const intendedText = scene ? sceneTextBlocks(item.storyboard?.scenes?.[scene.index]).map((b) => b.text).join("\n") : "";
    const similarity = ocrResult ? textSimilarity(intendedText, renderedText) : null;
    const spokenWords = wordsInRange(transcript.words, frame.atSec, frame.atSec + 1 / sampleFps);
    const entry = {
      index: frame.index,
      atSec: frame.atSec,
      framePath: frame.path,
      scene: scene ? { index: scene.index, id: scene.id, type: scene.type, startSec: scene.startSec, endSec: scene.endSec, durationSec: scene.durationSec } : null,
      storyboardText: intendedText,
      transcriptText: spokenWords.map((w: any) => w.word).join(" "),
      ocr: ocrResult ? { sampled: true, text: renderedText, lines: ocrResult.lines ?? [], similarity } : { sampled: false, text: "", lines: [], similarity: null },
      pixelMetrics: visual.metrics,
      motionDelta: visual.motionDelta,
      issueTags: [] as string[],
    };
    entry.issueTags = issueTagsForEvidence(entry, scene, diagnostics, similarity);
    entries.push(entry);
  }
  const issueSummary = entries.reduce((acc: Record<string, number>, entry) => {
    for (const tag of entry.issueTags) acc[tag] = (acc[tag] ?? 0) + 1;
    return acc;
  }, {});
  const sceneSummaries = timeline.map((scene) => {
    const sceneEntries = entries.filter((e) => e.scene?.index === scene.index);
    const avgMotion = sceneEntries.length ? Number((sceneEntries.reduce((sum, e) => sum + e.motionDelta, 0) / sceneEntries.length).toFixed(4)) : 0;
    const tags = sceneEntries.flatMap((e) => e.issueTags);
    const tagCounts = tags.reduce((acc: Record<string, number>, tag) => ({ ...acc, [tag]: (acc[tag] ?? 0) + 1 }), {});
    const transcriptWords = wordsInRange(transcript.words, scene.startSec, scene.endSec).map((w: any) => w.word).join(" ");
    return {
      scene,
      storyboardText: sceneTextBlocks(item.storyboard?.scenes?.[scene.index]).map((b) => b.text).join("\n"),
      transcriptText: transcriptWords,
      frameCount: sceneEntries.length,
      avgMotion,
      issueTags: tagCounts,
      representativeFrames: sceneEntries.slice(0, 2).map((e) => ({ atSec: e.atSec, framePath: e.framePath, tags: e.issueTags })),
    };
  });
  const nextCommands = [
    `pnpm editor competitive-suite ${id} --width ${Math.max(width, 360)} --sample-fps ${Math.min(2, Math.max(1, sampleFps))}`,
    `pnpm editor ocr-review ${id} --width 540`,
    `pnpm editor visual-readability ${id} --width ${Math.min(width, 360)}`,
    ...entries.filter((e) => e.issueTags.length).slice(0, 6).map((e) => `pnpm editor frame ${id} --time ${e.atSec.toFixed(2)}`),
  ];
  const report = {
    id,
    generatedAt: new Date().toISOString(),
    video,
    durationSec,
    sampleFps,
    width,
    metadata,
    timeline,
    diagnostics,
    transcript,
    scan: { manifestPath: scan.manifestPath, frameDir: scan.frameDir, frameCount: scan.frameCount, sheets: scan.sheets },
    ocr: { available: ocr.available, error: ocr.error, sampledFrameCount: ocrTargets.length },
    issueSummary,
    sceneSummaries,
    entries,
    nextCommands: [...new Set(nextCommands)],
    modelUse: "Use entries as the model's timecoded video memory: inspect framePath/contact sheets for visual context, transcriptText for audio, ocr.text for rendered text, motionDelta for motion, and issueTags for exact ranges to patch.",
  };
  const jsonPath = join(REVIEW_DIR, `${id}_video_evidence.json`);
  const mdPath = join(REVIEW_DIR, `${id}_video_evidence.md`);
  writeFileSync(jsonPath, JSON.stringify(report, null, 2));
  writeFileSync(mdPath, [
    `# Video Evidence Timeline: ${id}`,
    "",
    report.modelUse,
    "",
    `Duration: ${durationSec.toFixed(2)}s`,
    `Frames: ${scan.frameCount} at ${sampleFps} FPS`,
    `OCR: ${ocr.available ? `${ocrTargets.length} sampled frames` : `unavailable (${ocr.error})`}`,
    `Transcript: ${transcript.available ? "available" : `unavailable (${transcript.reason})`}`,
    "",
    "## Issue Summary",
    ...(Object.keys(issueSummary).length ? Object.entries(issueSummary).map(([tag, count]) => `- ${tag}: ${count}`) : ["- No deterministic issue tags detected."]),
    "",
    "## Scene Summary",
    ...sceneSummaries.map((s) => `- Scene ${s.scene.index} (${s.scene.type}) frames ${s.frameCount}, avg motion ${s.avgMotion}, tags ${JSON.stringify(s.issueTags)}`),
    "",
    "## Evidence",
    `- JSON: ${jsonPath}`,
    `- Frame manifest: ${scan.manifestPath}`,
    `- Frame dir: ${scan.frameDir}`,
    `- Contact sheets: ${scan.sheets.map((s) => s.path).filter(Boolean).join(", ")}`,
    `- Waveform: ${diagnostics.waveformPath ?? "none"}`,
    "",
    "## Next Commands",
    ...report.nextCommands.map((x) => `- \`${x}\``),
  ].join("\n"));
  return { jsonPath, markdownPath: mdPath, report };
}

function ocrReview(id: string, opts: { width: number }) {
  ensureDir(REVIEW_DIR);
  const item = loadRaw(id);
  const video = videoFile(item);
  if (!video) throw new Error("no rendered video found");
  const timeline = sceneStarts(item);
  const sceneFrames = timeline.map((t) => {
    const atSec = t.startSec + Math.max(0.1, Math.min(t.durationSec * 0.5, t.durationSec - 0.1));
    return {
      scene: t,
      type: item.storyboard?.scenes?.[t.index]?.type,
      intendedText: sceneTextBlocks(item.storyboard?.scenes?.[t.index]).map((b) => b.text).join("\n"),
      framePath: sampleFrame(id, video, atSec, `ocr_s${t.index}`),
      atSec: Number(atSec.toFixed(3)),
    };
  });
  const ocr = runVisionOcr(sceneFrames.map((f) => f.framePath));
  const byPath = new Map((ocr.results as any[]).map((r) => [r.path, r]));
  const scenes = sceneFrames.map((f) => {
    const result = byPath.get(f.framePath) ?? { lines: [] };
    const renderedText = (result.lines ?? []).map((l: any) => l.text).join("\n");
    const similarity = textSimilarity(f.intendedText, renderedText);
    const confidence = (result.lines ?? []).length
      ? Number(((result.lines as any[]).reduce((sum, l) => sum + Number(l.confidence ?? 0), 0) / result.lines.length).toFixed(3))
      : 0;
    const issues: { severity: "info" | "warning" | "error"; reason: string; command?: string }[] = [];
    if (!ocr.available) issues.push({ severity: "warning", reason: `OCR unavailable: ${ocr.error}` });
    else if (f.intendedText.trim() && !renderedText.trim()) issues.push({ severity: "error", reason: "No rendered text detected despite intended scene text." });
    else if (f.intendedText.trim() && similarity < 0.35) issues.push({ severity: "warning", reason: `Low OCR/storyboard token overlap (${similarity}).` });
    if (confidence > 0 && confidence < 0.45) issues.push({ severity: "warning", reason: `Low OCR confidence (${confidence}). Consider increasing contrast or font size.`, command: `pnpm editor style ${id} ${f.scene.index} '{"fontScale":1.1}'` });
    return { ...f, renderedText, ocrLines: result.lines ?? [], similarity, confidence, issues };
  });
  const issues = scenes.flatMap((s) => s.issues.map((issue) => ({ sceneIndex: s.scene.index, type: s.type, ...issue })));
  const avgSimilarity = scenes.length ? Number((scenes.reduce((sum, s) => sum + s.similarity, 0) / scenes.length).toFixed(3)) : 0;
  const verdict = !ocr.available ? "ocr_unavailable" : issues.some((i) => i.severity === "error") ? "text_missing" : avgSimilarity < 0.45 ? "needs_review" : "ocr_match";
  const nextCommands = [
    ...scenes.flatMap((s) => s.issues.map((i) => i.command).filter(Boolean) as string[]),
    `pnpm editor visual-readability ${id} --width ${opts.width}`,
  ];
  const review = {
    id,
    generatedAt: new Date().toISOString(),
    video,
    width: opts.width,
    ocrAvailable: ocr.available,
    ocrError: ocr.error,
    verdict,
    avgSimilarity,
    scenes,
    issues,
    nextCommands: [...new Set(nextCommands)],
    competitorAngle: "This closes the gap between caption generation and rendered-text proof: the model can check what text actually appeared in the video frames.",
  };
  const jsonPath = join(REVIEW_DIR, `${id}_ocr_review.json`);
  const mdPath = join(REVIEW_DIR, `${id}_ocr_review.md`);
  writeFileSync(jsonPath, JSON.stringify(review, null, 2));
  writeFileSync(mdPath, [
    `# OCR Review: ${id}`,
    "",
    `Verdict: **${verdict}**`,
    `OCR available: ${ocr.available}`,
    `Average similarity: ${avgSimilarity}`,
    "",
    "## Scenes",
    ...scenes.map((s) => `- Scene ${s.scene.index} (${s.type}) similarity ${s.similarity}, confidence ${s.confidence}. Intended: "${s.intendedText.replace(/\s+/g, " ").slice(0, 90)}" OCR: "${s.renderedText.replace(/\s+/g, " ").slice(0, 90)}" Evidence: ${s.framePath}`),
    "",
    "## Issues",
    ...(issues.length ? issues.map((i) => `- Scene ${i.sceneIndex} / ${i.severity}: ${i.reason}${i.command ? ` Command: \`${i.command}\`` : ""}`) : ["- No deterministic OCR issues detected."]),
    "",
    "## Next Commands",
    ...review.nextCommands.map((x) => `- \`${x}\``),
    "",
    "## Artifacts",
    `- JSON: ${jsonPath}`,
  ].join("\n"));
  return { jsonPath, markdownPath: mdPath, review };
}

function scoreFromVerdict(verdict: string, fallback = 70) {
  if (/match|readable|no_major|changed_with_no_detected/.test(verdict)) return 90;
  if (/needs_review/.test(verdict)) return 65;
  if (/unavailable/.test(verdict)) return fallback;
  if (/hard|risk|missing/.test(verdict)) return 35;
  return fallback;
}

function competitiveSuite(id: string, opts: { width: number; sampleFps: number }) {
  ensureDir(REVIEW_DIR);
  const item = loadRaw(id);
  const video = videoFile(item);
  if (!video) throw new Error("no rendered video found");
  const metadata = ffprobe(video);
  const diagnostics = videoDiagnostics(id, video);
  const validation = validateStoryboard(item);
  const deep = competitiveReview(id, item, video, { scan: false, sampleFps: opts.sampleFps, width: opts.width, framesPerSheet: 24 });
  const readability = readabilityReview(id, { width: opts.width });
  const visual = visualReadabilityReview(id, { width: Math.min(opts.width, 360) });
  const ocr = ocrReview(id, { width: Math.max(opts.width, 540) });
  const readReview: any = readability.review;
  const visualReview: any = visual.review;
  const ocrReviewData: any = ocr.review;
  const categories = [
    {
      id: "premiere_precision",
      competitorReference: "Adobe Premiere Pro",
      score: validation.valid ? 92 : 25,
      gate: validation.valid,
      evidence: validation,
      reason: "Schema and timeline contract are valid enough for professional deterministic editing.",
    },
    {
      id: "descript_text_clarity",
      competitorReference: "Descript",
      score: Math.round((readReview.avgScore + scoreFromVerdict(ocrReviewData.verdict)) / 2),
      gate: readReview.avgScore >= 70 && !/missing/.test(ocrReviewData.verdict),
      evidence: { readability: readability.jsonPath, ocr: ocr.jsonPath, avgReadability: readReview.avgScore, ocrVerdict: ocrReviewData.verdict },
      reason: "Transcript/caption competitors generate text; this checks final rendered text timing and OCR evidence.",
    },
    {
      id: "capcut_creator_speed",
      competitorReference: "CapCut",
      score: readReview.issues.length <= 6 ? 82 : Math.max(30, 82 - readReview.issues.length * 3),
      gate: readReview.issues.length <= 8,
      evidence: { issueCount: readReview.issues.length, timeline: sceneStarts(item) },
      reason: "Short-form speed depends on dense but readable pacing, not just fast templates.",
    },
    {
      id: "runway_visual_polish",
      competitorReference: "Runway",
      score: visualReview.avgScore,
      gate: visualReview.avgScore >= 72,
      evidence: { visualReadability: visual.jsonPath, avgVisualScore: visualReview.avgScore },
      reason: "Generative-video polish is approximated here by rendered pixel risk, contrast, and safe-area evidence.",
    },
    {
      id: "opusclip_platform_package",
      competitorReference: "OpusClip",
      score: item.pkg?.title && item.pkg?.caption && item.pkg?.hashtags?.length ? 88 : 45,
      gate: !!(item.pkg?.title && item.pkg?.caption && item.pkg?.hashtags?.length),
      evidence: { title: item.pkg?.title, hasCaption: !!item.pkg?.caption, hashtags: item.pkg?.hashtags?.length ?? 0 },
      reason: "Repurposing tools win on packaging; every render should have platform-ready metadata.",
    },
    {
      id: "agent_native_evidence",
      competitorReference: "Our wedge",
      score: 95,
      gate: true,
      evidence: { deepReview: deep.reviewPath, readability: readability.jsonPath, visual: visual.jsonPath, ocr: ocr.jsonPath },
      reason: "This is the category competitors mostly miss: durable evidence artifacts and executable model commands.",
    },
    {
      id: "av_continuity",
      competitorReference: "Professional baseline",
      score: Math.max(30, 90 - (diagnostics.silence.length + diagnostics.freezes.length + diagnostics.blackFrames.length) * 12),
      gate: diagnostics.blackFrames.length === 0 && diagnostics.silence.length <= 1,
      evidence: { diagnostics },
      reason: "Professional output must avoid black frames, long silence, and freezes.",
    },
  ];
  const score = Math.round(categories.reduce((sum, c) => sum + c.score, 0) / categories.length);
  const failed = categories.filter((c) => !c.gate);
  const nextCommands = [
    ...new Set([
      ...readReview.nextCommands ?? [],
      ...visualReview.nextCommands ?? [],
      ...ocrReviewData.nextCommands ?? [],
      `pnpm editor deep-review ${id} --sample-fps 2 --width ${opts.width}`,
    ]),
  ];
  const suite = {
    id,
    generatedAt: new Date().toISOString(),
    video,
    durationSec: durationFromProbe(metadata),
    score,
    verdict: failed.length ? "competitive_gaps_found" : score >= 85 ? "competitive_ready" : "needs_review",
    categories,
    failedGates: failed.map((c) => ({ id: c.id, score: c.score, reason: c.reason, evidence: c.evidence })),
    artifacts: {
      deepReview: deep.reviewPath,
      readability: readability.jsonPath,
      visualReadability: visual.jsonPath,
      ocr: ocr.jsonPath,
    },
    nextCommands,
    thesis: "This suite turns competitor research into executable QA: each category maps a competitor strength to evidence we can inspect and commands an agent can run.",
  };
  const jsonPath = join(REVIEW_DIR, `${id}_competitive_suite.json`);
  const mdPath = join(REVIEW_DIR, `${id}_competitive_suite.md`);
  writeFileSync(jsonPath, JSON.stringify(suite, null, 2));
  writeFileSync(mdPath, [
    `# Competitive Suite: ${id}`,
    "",
    suite.thesis,
    "",
    `Verdict: **${suite.verdict}**`,
    `Score: ${score}/100`,
    "",
    "## Category Scorecard",
    ...categories.map((c) => `- **${c.id}** (${c.competitorReference}) ${c.score}/100 ${c.gate ? "pass" : "fail"}: ${c.reason}`),
    "",
    "## Failed Gates",
    ...(failed.length ? failed.map((c) => `- **${c.id}** score ${c.score}: ${c.reason}`) : ["- None."]),
    "",
    "## Next Commands",
    ...nextCommands.map((x) => `- \`${x}\``),
    "",
    "## Artifacts",
    `- JSON: ${jsonPath}`,
    `- Deep review: ${deep.reviewPath}`,
    `- Readability: ${readability.jsonPath}`,
    `- Visual readability: ${visual.jsonPath}`,
    `- OCR: ${ocr.jsonPath}`,
  ].join("\n"));
  return { jsonPath, markdownPath: mdPath, suite };
}

function cloneForDraft(item: Item, sourceId: string, newId?: string, reason = "agent draft") {
  const clone = structuredClone(item);
  const cloneId = String(newId || `${sourceId}_autofix_${Date.now().toString(36)}`);
  clone.id = cloneId;
  clone.status = "agent_draft";
  clone.videoPath = undefined;
  clone.thumbPath = undefined;
  clone.updatedAt = new Date().toISOString();
  clone.log = [...(clone.log ?? []), { at: new Date().toISOString(), msg: `${reason} cloned from ${sourceId}` }];
  return { cloneId, clone };
}

function applySuiteAutofix(id: string, opts: { newId?: string; width: number; sampleFps: number }) {
  ensureDir(REVIEW_DIR);
  const source = loadRaw(id);
  if (!source.storyboard?.scenes) throw new Error("item has no storyboard scenes");
  const { cloneId, clone } = cloneForDraft(source, id, opts.newId, "suite autofix draft");
  const suite = competitiveSuite(id, { width: opts.width, sampleFps: opts.sampleFps }).suite as any;
  const readability = JSON.parse(readFileSync(suite.artifacts.readability, "utf8"));
  const visual = JSON.parse(readFileSync(suite.artifacts.visualReadability, "utf8"));
  const ocr = JSON.parse(readFileSync(suite.artifacts.ocr, "utf8"));
  const patches: { sceneIndex: number; area: string; before: unknown; after: unknown; reason: string }[] = [];
  const durationTargets = new Map<number, number>();
  for (const issue of readability.issues ?? []) {
    const m = /"durationSec":([0-9.]+)/.exec(issue.command ?? "");
    if (m) durationTargets.set(issue.sceneIndex, Math.max(durationTargets.get(issue.sceneIndex) ?? 0, Number(m[1])));
  }
  for (const [sceneIndex, target] of durationTargets) {
    const scene = clone.storyboard.scenes[sceneIndex];
    if (!scene) continue;
    const before = scene.durationSec;
    const after = Math.min(14, Math.max(Number(before ?? 2), target));
    if (after !== before) {
      scene.durationSec = after;
      patches.push({ sceneIndex, area: "duration", before, after, reason: "Readability review found text density too high for current scene duration." });
    }
  }
  for (const issue of visual.issues ?? []) {
    if (!issue.command?.includes("contrast true")) continue;
    const scene = clone.storyboard.scenes[issue.sceneIndex];
    if (!scene) continue;
    const before = structuredClone(scene.effects ?? {});
    scene.effects = { ...(scene.effects ?? {}), contrast: true };
    patches.push({ sceneIndex: issue.sceneIndex, area: "effect", before, after: scene.effects, reason: "Visual readability found low central contrast signal." });
  }
  for (const issue of ocr.issues ?? []) {
    if (issue.severity !== "warning") continue;
    const scene = clone.storyboard.scenes[issue.sceneIndex];
    if (!scene) continue;
    const before = structuredClone(scene.style ?? {});
    const current = Number(scene.style?.fontScale ?? 1);
    scene.style = { ...(scene.style ?? {}), fontScale: Math.max(current, 1.1) };
    patches.push({ sceneIndex: issue.sceneIndex, area: "style", before, after: scene.style, reason: "OCR review found low rendered/storyboard text overlap or confidence." });
  }
  clone.mix = {
    ...(clone.mix ?? {}),
    musicVol: Math.min(Number(clone.mix?.musicVol ?? 1), 0.85),
  };
  patches.push({ sceneIndex: -1, area: "mix", before: source.mix ?? {}, after: clone.mix, reason: "Conservative mix ducking for review draft before rerender." });
  saveRaw(clone, cloneId);
  const validation = validateStoryboard(clone);
  const nextCommands = [
    `pnpm editor validate ${cloneId}`,
    `pnpm editor rerender ${cloneId} --broll`,
    `pnpm editor compare-renders ${id} ${cloneId} --samples 8 --width ${opts.width}`,
    `pnpm editor competitive-suite ${cloneId} --width ${opts.width}`,
  ];
  const report = {
    sourceId: id,
    draftId: cloneId,
    generatedAt: new Date().toISOString(),
    validation,
    sourceSuite: suite,
    patches,
    nextCommands,
    warning: "Autofix intentionally edits a clone only. Review, rerender, and compare before accepting.",
  };
  const jsonPath = join(REVIEW_DIR, `${id}_to_${cloneId}_suite_autofix.json`);
  const mdPath = join(REVIEW_DIR, `${id}_to_${cloneId}_suite_autofix.md`);
  writeFileSync(jsonPath, JSON.stringify(report, null, 2));
  writeFileSync(mdPath, [
    `# Suite Autofix: ${id} -> ${cloneId}`,
    "",
    report.warning,
    "",
    `Validation: ${validation.valid ? "valid" : "invalid"}`,
    `Patch count: ${patches.length}`,
    "",
    "## Patches",
    ...patches.map((p) => `- Scene ${p.sceneIndex} / ${p.area}: ${p.reason}`),
    "",
    "## Next Commands",
    ...nextCommands.map((x) => `- \`${x}\``),
    "",
    "## Artifacts",
    `- JSON: ${jsonPath}`,
  ].join("\n"));
  return { jsonPath, markdownPath: mdPath, report };
}

function failedGateIds(suite: any) {
  return new Set((suite.failedGates ?? []).map((g: any) => String(g.id)));
}

function gateDelta(sourceSuite: any, draftSuite: any) {
  const sourceFailed = failedGateIds(sourceSuite);
  const draftFailed = failedGateIds(draftSuite);
  const removed = [...sourceFailed].filter((id) => !draftFailed.has(id));
  const added = [...draftFailed].filter((id) => !sourceFailed.has(id));
  const stillFailing = [...sourceFailed].filter((id) => draftFailed.has(id));
  return { removed, added, stillFailing };
}

function acceptAutofix(sourceId: string, draftId: string, opts: { width: number; sampleFps: number; samples: number; minScoreGain: number }) {
  ensureDir(REVIEW_DIR);
  const source = loadRaw(sourceId);
  const draft = loadRaw(draftId);
  const sourceVideo = videoFile(source);
  const draftVideo = videoFile(draft);
  const validation = validateStoryboard(draft);
  const missing: string[] = [];
  if (!sourceVideo) missing.push(`source render missing for ${sourceId}`);
  if (!draftVideo) missing.push(`draft render missing for ${draftId}`);
  if (!validation.valid) missing.push("draft storyboard validation failed");
  const label = `${sourceId}_to_${draftId}`.replace(/[^a-zA-Z0-9_.-]/g, "_");
  const baseNextCommands = [
    `pnpm editor validate ${draftId}`,
    `pnpm editor rerender ${draftId} --broll`,
    `pnpm editor compare-renders ${sourceId} ${draftId} --samples ${opts.samples} --width ${opts.width}`,
    `pnpm editor competitive-suite ${draftId} --width ${opts.width} --sample-fps ${opts.sampleFps}`,
  ];
  if (missing.length) {
    const report = {
      sourceId,
      draftId,
      generatedAt: new Date().toISOString(),
      verdict: "cannot_accept_until_rendered",
      validation,
      missing,
      sourceVideo,
      draftVideo,
      nextCommands: baseNextCommands,
      warning: "Acceptance gate does not mutate source. Render the draft and rerun this gate.",
    };
    const jsonPath = join(REVIEW_DIR, `${label}_accept_autofix.json`);
    const mdPath = join(REVIEW_DIR, `${label}_accept_autofix.md`);
    writeFileSync(jsonPath, JSON.stringify(report, null, 2));
    writeFileSync(mdPath, [
      `# Autofix Acceptance Gate: ${sourceId} -> ${draftId}`,
      "",
      `Verdict: **${report.verdict}**`,
      "",
      "## Missing Evidence",
      ...missing.map((m) => `- ${m}`),
      "",
      "## Next Commands",
      ...baseNextCommands.map((x) => `- \`${x}\``),
      "",
      "## Artifacts",
      `- JSON: ${jsonPath}`,
    ].join("\n"));
    return { jsonPath, markdownPath: mdPath, report };
  }

  const compare = compareRenders(sourceId, draftId, { samples: opts.samples, width: opts.width });
  const sourceSuite = competitiveSuite(sourceId, { width: opts.width, sampleFps: opts.sampleFps });
  const draftSuite = competitiveSuite(draftId, { width: opts.width, sampleFps: opts.sampleFps });
  const sourceScore = Number((sourceSuite.suite as any).score ?? 0);
  const draftScore = Number((draftSuite.suite as any).score ?? 0);
  const scoreDelta = draftScore - sourceScore;
  const gates = gateDelta(sourceSuite.suite, draftSuite.suite);
  const compareReport: any = compare.report;
  const blockingRegressions = (compareReport.regressions ?? []).filter((r: string) => !/duration changed/.test(r));
  const durationReviewNeeded = (compareReport.regressions ?? []).some((r: string) => /duration changed/.test(r));
  const addedFailedGatePenalty = gates.added.length > 0;
  const verdict =
    blockingRegressions.length || addedFailedGatePenalty || scoreDelta < 0
      ? "reject_candidate"
      : scoreDelta >= opts.minScoreGain && gates.removed.length >= gates.added.length
        ? "accept_candidate"
        : "needs_human_review";
  const reasons = [
    `Score delta: ${scoreDelta} (${sourceScore} -> ${draftScore}), minimum requested gain ${opts.minScoreGain}.`,
    gates.removed.length ? `Resolved failed gates: ${gates.removed.join(", ")}.` : "No failed gates resolved.",
    gates.added.length ? `New failed gates: ${gates.added.join(", ")}.` : "No new failed gates.",
    blockingRegressions.length ? `Blocking render regressions: ${blockingRegressions.join("; ")}.` : "No blocking render regressions.",
    durationReviewNeeded ? "Duration changed substantially; verify pacing intentionally changed." : "No major duration review flag.",
  ];
  const nextCommands = verdict === "accept_candidate"
    ? [
        `pnpm editor state ${draftId}`,
        `pnpm editor compare-renders ${sourceId} ${draftId} --samples ${opts.samples} --width ${opts.width}`,
        `pnpm editor competitive-suite ${draftId} --width ${opts.width} --sample-fps ${opts.sampleFps}`,
      ]
    : [
        ...baseNextCommands,
        ...blockingRegressions.slice(0, 3).map((_r: string, i: number) => `pnpm editor frame ${draftId} --time ${compareReport.evidence?.points?.[i]?.toFixed?.(2) ?? "1.0"}`),
      ];
  const report = {
    sourceId,
    draftId,
    generatedAt: new Date().toISOString(),
    verdict,
    sourceVideo,
    draftVideo,
    validation,
    scores: { source: sourceScore, draft: draftScore, delta: scoreDelta, minScoreGain: opts.minScoreGain },
    gates,
    regressions: { all: compareReport.regressions ?? [], blocking: blockingRegressions, durationReviewNeeded },
    improvements: compareReport.improvements ?? [],
    artifacts: {
      compare: compare.jsonPath,
      sourceSuite: sourceSuite.jsonPath,
      draftSuite: draftSuite.jsonPath,
    },
    reasons,
    nextCommands: [...new Set(nextCommands)],
    warning: "Acceptance gate writes a decision report only. It does not replace or mutate the source run.",
  };
  const jsonPath = join(REVIEW_DIR, `${label}_accept_autofix.json`);
  const mdPath = join(REVIEW_DIR, `${label}_accept_autofix.md`);
  writeFileSync(jsonPath, JSON.stringify(report, null, 2));
  writeFileSync(mdPath, [
    `# Autofix Acceptance Gate: ${sourceId} -> ${draftId}`,
    "",
    report.warning,
    "",
    `Verdict: **${verdict}**`,
    `Score delta: ${scoreDelta} (${sourceScore} -> ${draftScore})`,
    "",
    "## Reasons",
    ...reasons.map((r) => `- ${r}`),
    "",
    "## Gate Delta",
    `- Removed failures: ${gates.removed.join(", ") || "none"}`,
    `- Added failures: ${gates.added.join(", ") || "none"}`,
    `- Still failing: ${gates.stillFailing.join(", ") || "none"}`,
    "",
    "## Artifacts",
    `- JSON: ${jsonPath}`,
    `- Compare: ${compare.jsonPath}`,
    `- Source suite: ${sourceSuite.jsonPath}`,
    `- Draft suite: ${draftSuite.jsonPath}`,
    "",
    "## Next Commands",
    ...report.nextCommands.map((x) => `- \`${x}\``),
  ].join("\n"));
  return { jsonPath, markdownPath: mdPath, report };
}

const EDIT_RECIPES = ["tighten_pacing", "make_terminal_clearer", "raise_retention", "fix_audio_ducking"] as const;
type EditRecipe = typeof EDIT_RECIPES[number];

function recipeSceneText(scene: any) {
  return sceneTextBlocks(scene).map((b) => b.text).join(" ");
}

function clampSceneDuration(value: number) {
  return Number(Math.max(2, Math.min(14, value)).toFixed(2));
}

function applyRecipe(id: string, opts: { recipe: EditRecipe; newId?: string; intensity: number }) {
  ensureDir(REVIEW_DIR);
  if (!EDIT_RECIPES.includes(opts.recipe)) throw new Error(`unknown recipe: ${opts.recipe}`);
  const source = loadRaw(id);
  if (!source.storyboard?.scenes) throw new Error("item has no storyboard scenes");
  const { cloneId, clone } = cloneForDraft(source, id, opts.newId ?? `${id}_${opts.recipe}`, `recipe ${opts.recipe} draft`);
  clone.log = [...(clone.log ?? []), { at: new Date().toISOString(), msg: `recipe ${opts.recipe} applied from ${id}` }];
  const intensity = Math.max(0.25, Math.min(Number(opts.intensity), 2));
  const patches: { sceneIndex: number; area: string; before: unknown; after: unknown; reason: string }[] = [];
  const record = (sceneIndex: number, area: string, before: unknown, after: unknown, reason: string) => {
    patches.push({ sceneIndex, area, before, after, reason });
  };

  if (opts.recipe === "tighten_pacing") {
    clone.storyboard.scenes.forEach((scene: any, index: number) => {
      const before = scene.durationSec;
      const wordCount = words(recipeSceneText(scene)).length;
      const readableFloor = Math.max(2.4, wordCount / 2.8);
      const target = scene.type === "terminal" || scene.type === "code_block"
        ? Math.max(readableFloor, Number(before ?? 4) * (0.96 - 0.03 * intensity))
        : Math.max(readableFloor, Number(before ?? 4) * (0.9 - 0.05 * intensity));
      const after = clampSceneDuration(target);
      if (after < Number(before ?? 0)) {
        scene.durationSec = after;
        record(index, "duration", before, after, "Tighten pacing while preserving a readable words-per-second floor.");
      }
      if (index > 0 && index < clone.storyboard.scenes.length - 1 && !scene.style?.transition) {
        const beforeStyle = structuredClone(scene.style ?? {});
        scene.style = { ...(scene.style ?? {}), transition: index % 2 ? "wipe" : "slide" };
        record(index, "transition", beforeStyle, scene.style, "Add intentional editorial motion between mid-roll scenes.");
      }
    });
  }

  if (opts.recipe === "make_terminal_clearer") {
    clone.storyboard.scenes.forEach((scene: any, index: number) => {
      if (scene.type !== "terminal" && scene.type !== "code_block") return;
      const beforeStyle = structuredClone(scene.style ?? {});
      scene.style = {
        ...(scene.style ?? {}),
        fontScale: Math.max(Number(scene.style?.fontScale ?? 1), 1.08),
        letterSpacing: Math.max(Number(scene.style?.letterSpacing ?? 0), 0.01),
        lineHeight: Math.max(Number(scene.style?.lineHeight ?? 1.12), 1.18),
        accent: scene.style?.accent ?? "#d4d4d4",
      };
      record(index, "style", beforeStyle, scene.style, "Increase terminal/code readability with larger type, spacing, and neutral high-contrast accent.");
      const beforeEffects = structuredClone(scene.effects ?? {});
      scene.effects = { ...(scene.effects ?? {}), contrast: true };
      record(index, "effect", beforeEffects, scene.effects, "Boost contrast on dense technical scenes.");
      if (Array.isArray(scene.lines)) {
        const beforeLines = structuredClone(scene.lines);
        scene.lines = scene.lines.slice(0, 7).map((line: any) => {
          if (typeof line === "string") return line.length > 92 ? `${line.slice(0, 89)}...` : line;
          if (typeof line?.text === "string" && line.text.length > 92) return { ...line, text: `${line.text.slice(0, 89)}...` };
          return line;
        });
        if (JSON.stringify(beforeLines) !== JSON.stringify(scene.lines)) record(index, "terminal_lines", beforeLines, scene.lines, "Trim overlong terminal lines so they fit a mobile frame.");
      }
    });
  }

  if (opts.recipe === "raise_retention") {
    clone.storyboard.scenes.forEach((scene: any, index: number) => {
      const before = { emphasis: scene.emphasis, style: structuredClone(scene.style ?? {}), effects: structuredClone(scene.effects ?? {}), broll: structuredClone(scene.broll ?? null) };
      if (index === 0 || index === Math.floor(clone.storyboard.scenes.length / 2)) scene.emphasis = true;
      scene.style = {
        ...(scene.style ?? {}),
        transition: scene.style?.transition ?? (index % 3 === 0 ? "slamzoom" : "wipe"),
        fontScale: Math.max(Number(scene.style?.fontScale ?? 1), index === 0 ? 1.12 : 1),
      };
      scene.effects = { ...(scene.effects ?? {}), grain: true };
      if (!scene.broll && index > 0 && index < clone.storyboard.scenes.length - 1) {
        scene.broll = { query: String(scene.say || primaryText(scene) || "abstract motion").slice(0, 60), kind: "concrete" };
      }
      record(index, "retention", before, { emphasis: scene.emphasis, style: scene.style, effects: scene.effects, broll: scene.broll ?? null }, "Add retention-oriented beat peaks, transitions, texture, and mid-roll visual support.");
    });
  }

  if (opts.recipe === "fix_audio_ducking") {
    const before = structuredClone(clone.mix ?? {});
    const tracks = audioTrackDefaults(clone.mix ?? {}).map((track) => {
      if (track.id === "music") return { ...track, vol: Math.min(Number(track.vol ?? 1), 0.72), fadeIn: Math.max(Number(track.fadeIn ?? 0), 0.25), fadeOut: Math.max(Number(track.fadeOut ?? 0), 0.45) };
      if (track.id === "voice") return { ...track, vol: Math.max(Number(track.vol ?? 1), 1.08), fadeIn: Math.max(Number(track.fadeIn ?? 0), 0.05), fadeOut: Math.max(Number(track.fadeOut ?? 0), 0.1) };
      return { ...track, vol: Math.min(Number(track.vol ?? 1), 0.85) };
    });
    clone.mix = {
      ...(clone.mix ?? {}),
      musicVol: Math.min(Number(clone.mix?.musicVol ?? 1), 0.72),
      voiceVol: Math.max(Number(clone.mix?.voiceVol ?? 1), 1.08),
      sfxVol: Math.min(Number(clone.mix?.sfxVol ?? 1), 0.85),
      beatIntensity: Math.min(Number(clone.mix?.beatIntensity ?? 1), 1.1),
      tracks,
    };
    record(-1, "mix", before, clone.mix, "Ducks music/SFX under voice and adds short fades for cleaner narration.");
  }

  saveRaw(clone, cloneId);
  const validation = validateStoryboard(clone);
  const nextCommands = [
    `pnpm editor validate ${cloneId}`,
    `pnpm editor rerender ${cloneId} --broll`,
    `pnpm editor video-evidence ${cloneId} --sample-fps 1 --width 320 --no-transcribe`,
    `pnpm editor competitive-suite ${cloneId} --width 360 --sample-fps 1`,
    `pnpm editor accept-autofix ${id} ${cloneId} --width 360 --sample-fps 1`,
  ];
  const report = {
    sourceId: id,
    draftId: cloneId,
    recipe: opts.recipe,
    intensity,
    generatedAt: new Date().toISOString(),
    validation,
    patches,
    nextCommands,
    warning: "Recipe edits a cloned draft only. Rerender and run accept-autofix before replacing source work.",
  };
  const jsonPath = join(REVIEW_DIR, `${id}_to_${cloneId}_${opts.recipe}_recipe.json`);
  const mdPath = join(REVIEW_DIR, `${id}_to_${cloneId}_${opts.recipe}_recipe.md`);
  writeFileSync(jsonPath, JSON.stringify(report, null, 2));
  writeFileSync(mdPath, [
    `# Edit Recipe: ${opts.recipe}`,
    "",
    `${id} -> ${cloneId}`,
    "",
    report.warning,
    "",
    `Validation: ${validation.valid ? "valid" : "invalid"}`,
    `Patch count: ${patches.length}`,
    "",
    "## Patches",
    ...(patches.length ? patches.map((p) => `- Scene ${p.sceneIndex} / ${p.area}: ${p.reason}`) : ["- No changes were needed for this recipe."]),
    "",
    "## Next Commands",
    ...nextCommands.map((x) => `- \`${x}\``),
    "",
    "## Artifacts",
    `- JSON: ${jsonPath}`,
  ].join("\n"));
  return { jsonPath, markdownPath: mdPath, report };
}

function ok(data?: ToolResult["data"], message?: string): ToolResult {
  return { ok: true, data, message };
}

function fail(error: unknown): ToolResult {
  return { ok: false, message: error instanceof Error ? error.message : String(error) };
}

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});

export const editorTools: EditorTool[] = [
  {
    name: "editor_list_items",
    description: "List all generated runs available to the video editor.",
    inputSchema: obj({}),
    run: () => {
      try {
        ensureDir(RUNS_DIR);
        return ok(
          readdirSync(RUNS_DIR)
            .filter((f) => f.endsWith(".json"))
            .map((f) => loadRaw(f.replace(/\.json$/, "")))
            .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
            .map((it) => summarize(it)),
        );
      } catch (e) {
        return fail(e);
      }
    },
  },
  {
    name: "editor_get_state",
    description: "Return the full editable state for one run, including scenes, mix, package, logs, and resolved video path.",
    inputSchema: obj({ id: { type: "string" } }, ["id"]),
    run: ({ id }) => {
      try {
        const item = loadRaw(id);
        return ok({ ...item, resolvedVideoPath: videoFile(item), sceneTimeline: sceneStarts(item), storyboardValidation: validateStoryboard(item) });
      } catch (e) {
        return fail(e);
      }
    },
  },
  {
    name: "editor_clone_item",
    description: "Clone a run for safe agent experimentation. The cloned item's internal id is rewritten to the new id.",
    inputSchema: obj({ id: { type: "string" }, newId: { type: "string" } }, ["id"]),
    run: ({ id, newId }) => {
      try {
        const item = loadRaw(id);
        const cloneId = String(newId || `${id}_agent_${Date.now().toString(36)}`);
        item.id = cloneId;
        item.videoPath = undefined;
        item.thumbPath = undefined;
        item.status = "agent_draft";
        item.log = [...(item.log ?? []), { at: new Date().toISOString(), msg: `cloned from ${id} for agent editing` }];
        saveRaw(item, cloneId);
        return ok({ id: cloneId, state: summarize(item) }, "item cloned");
      } catch (e) {
        return fail(e);
      }
    },
  },
  {
    name: "editor_get_scene",
    description: "Return one scene/component with its timeline timing and nested editable fields.",
    inputSchema: obj({ id: { type: "string" }, index: { type: "number" } }, ["id", "index"]),
    run: ({ id, index }) => {
      try {
        const item = loadRaw(id);
        return ok({ timing: sceneStarts(item)[index], scene: requireScene(item, index) });
      } catch (e) {
        return fail(e);
      }
    },
  },
  {
    name: "editor_set_path",
    description: "Set any JSON path on the item, for example storyboard.scenes.1.lines.0.text or mix.musicVol.",
    inputSchema: obj({ id: { type: "string" }, path: { type: "string" }, value: {} }, ["id", "path", "value"]),
    run: ({ id, path, value }) => {
      try {
        const item = loadRaw(id);
        writePath(item, path, parseValue(value));
        saveRaw(item, id);
        return ok({ path, value: readPath(item, path), validation: validateStoryboard(item) }, "path updated");
      } catch (e) {
        return fail(e);
      }
    },
  },
  {
    name: "editor_unset_path",
    description: "Delete a JSON path from the item.",
    inputSchema: obj({ id: { type: "string" }, path: { type: "string" } }, ["id", "path"]),
    run: ({ id, path }) => {
      try {
        const item = loadRaw(id);
        unsetPath(item, path);
        saveRaw(item, id);
        return ok({ path, validation: validateStoryboard(item) }, "path removed");
      } catch (e) {
        return fail(e);
      }
    },
  },
  {
    name: "editor_patch_scene",
    description: "Merge fields into a scene/component. Use for text, terminal path/status, code, before/after content, style, effects, broll, and animation fields.",
    inputSchema: obj({ id: { type: "string" }, index: { type: "number" }, patch: { type: "object" } }, ["id", "index", "patch"]),
    run: ({ id, index, patch }) => {
      try {
        const item = loadRaw(id);
        item.storyboard.scenes[index] = { ...requireScene(item, index), ...patch };
        saveRaw(item, id);
        return ok({ scene: item.storyboard.scenes[index], validation: validateStoryboard(item) }, "scene patched");
      } catch (e) {
        return fail(e);
      }
    },
  },
  {
    name: "editor_add_scene",
    description: "Insert a complete scene object at an index, or append when index is omitted.",
    inputSchema: obj({ id: { type: "string" }, scene: { type: "object" }, index: { type: "number" } }, ["id", "scene"]),
    run: ({ id, scene, index }) => {
      try {
        const item = loadRaw(id);
        if (!item.storyboard?.scenes) throw new Error("item has no storyboard");
        const at = Number.isInteger(index) ? Math.max(0, Math.min(index, item.storyboard.scenes.length)) : item.storyboard.scenes.length;
        item.storyboard.scenes.splice(at, 0, scene);
        saveRaw(item, id);
        return ok({ index: at, scene, validation: validateStoryboard(item) }, "scene inserted");
      } catch (e) {
        return fail(e);
      }
    },
  },
  {
    name: "editor_delete_scene",
    description: "Delete one scene from the timeline.",
    inputSchema: obj({ id: { type: "string" }, index: { type: "number" } }, ["id", "index"]),
    run: ({ id, index }) => {
      try {
        const item = loadRaw(id);
        requireScene(item, index);
        const [scene] = item.storyboard.scenes.splice(index, 1);
        saveRaw(item, id);
        return ok({ deleted: scene, validation: validateStoryboard(item) }, "scene deleted");
      } catch (e) {
        return fail(e);
      }
    },
  },
  {
    name: "editor_duplicate_scene",
    description: "Duplicate one scene/component, assigning a new id.",
    inputSchema: obj({ id: { type: "string" }, index: { type: "number" } }, ["id", "index"]),
    run: ({ id, index }) => {
      try {
        const item = loadRaw(id);
        const scene = structuredClone(requireScene(item, index));
        scene.id = `${scene.id}_copy_${Date.now().toString(36)}`;
        item.storyboard.scenes.splice(index + 1, 0, scene);
        saveRaw(item, id);
        return ok({ index: index + 1, scene, validation: validateStoryboard(item) }, "scene duplicated");
      } catch (e) {
        return fail(e);
      }
    },
  },
  {
    name: "editor_move_scene",
    description: "Move a scene from one timeline index to another.",
    inputSchema: obj({ id: { type: "string" }, from: { type: "number" }, to: { type: "number" } }, ["id", "from", "to"]),
    run: ({ id, from, to }) => {
      try {
        const item = loadRaw(id);
        requireScene(item, from);
        const [scene] = item.storyboard.scenes.splice(from, 1);
        const at = Math.max(0, Math.min(to, item.storyboard.scenes.length));
        item.storyboard.scenes.splice(at, 0, scene);
        saveRaw(item, id);
        return ok({ from, to: at, timeline: sceneStarts(item), validation: validateStoryboard(item) }, "scene moved");
      } catch (e) {
        return fail(e);
      }
    },
  },
  {
    name: "editor_split_scene",
    description: "Split a scene duration into two adjacent duplicate components at an offset in seconds.",
    inputSchema: obj({ id: { type: "string" }, index: { type: "number" }, atSec: { type: "number" } }, ["id", "index", "atSec"]),
    run: ({ id, index, atSec }) => {
      try {
        const item = loadRaw(id);
        const scene = requireScene(item, index);
        const duration = Number(scene.durationSec || 2);
        if (atSec <= 0.5 || atSec >= duration - 0.5) throw new Error(`split point must be inside scene duration ${duration}s`);
        const left = { ...scene, durationSec: Number(atSec.toFixed(2)) };
        const right = { ...structuredClone(scene), id: `${scene.id}_b_${Date.now().toString(36)}`, durationSec: Number((duration - atSec).toFixed(2)) };
        item.storyboard.scenes.splice(index, 1, left, right);
        saveRaw(item, id);
        return ok({ left, right, validation: validateStoryboard(item) }, "scene split");
      } catch (e) {
        return fail(e);
      }
    },
  },
  {
    name: "editor_terminal_line",
    description: "Add, update, delete, or move a terminal line inside a terminal component.",
    inputSchema: obj({
      id: { type: "string" },
      index: { type: "number" },
      action: { type: "string", enum: ["add", "update", "delete", "move"] },
      lineIndex: { type: "number" },
      to: { type: "number" },
      line: { type: "object" },
    }, ["id", "index", "action"]),
    run: ({ id, index, action, lineIndex, to, line }) => {
      try {
        const item = loadRaw(id);
        const scene = requireScene(item, index);
        if (scene.type !== "terminal") throw new Error(`scene ${index} is ${scene.type}, not terminal`);
        scene.lines ??= [];
        if (action === "add") scene.lines.splice(Number.isInteger(lineIndex) ? lineIndex : scene.lines.length, 0, line ?? { kind: "assistant", text: "" });
        if (action === "update") scene.lines[lineIndex] = { ...scene.lines[lineIndex], ...line };
        if (action === "delete") scene.lines.splice(lineIndex, 1);
        if (action === "move") {
          const [ln] = scene.lines.splice(lineIndex, 1);
          scene.lines.splice(Math.max(0, Math.min(to, scene.lines.length)), 0, ln);
        }
        saveRaw(item, id);
        return ok({ scene, validation: validateStoryboard(item) }, "terminal lines updated");
      } catch (e) {
        return fail(e);
      }
    },
  },
  {
    name: "editor_set_style",
    description: "Merge style fields into a scene, including accent, transition, fontScale, align, brightness, contrast, opacity, hue, saturation, and lightness.",
    inputSchema: obj({ id: { type: "string" }, index: { type: "number" }, style: { type: "object" } }, ["id", "index", "style"]),
    run: ({ id, index, style }) => {
      try {
        const item = loadRaw(id);
        const scene = requireScene(item, index);
        scene.style = { ...(scene.style ?? {}), ...style };
        saveRaw(item, id);
        return ok({ scene, validation: validateStoryboard(item) }, "style updated");
      } catch (e) {
        return fail(e);
      }
    },
  },
  {
    name: "editor_set_effect",
    description: "Enable or disable one scene effect such as grain, vignette, contrast, scanlines, blur, or invert.",
    inputSchema: obj({ id: { type: "string" }, index: { type: "number" }, effect: { type: "string" }, enabled: { type: "boolean" } }, ["id", "index", "effect", "enabled"]),
    run: ({ id, index, effect, enabled }) => {
      try {
        const item = loadRaw(id);
        const scene = requireScene(item, index);
        scene.effects = { ...(scene.effects ?? {}), [effect]: enabled };
        saveRaw(item, id);
        return ok({ scene, validation: validateStoryboard(item) }, "effect updated");
      } catch (e) {
        return fail(e);
      }
    },
  },
  {
    name: "editor_watch_video",
    description: "Let an agent inspect the rendered video: returns ffprobe metadata, scene timing, sampled frame files, and a contact sheet path.",
    inputSchema: obj({ id: { type: "string" }, scene: { type: "number" }, frames: { type: "number" } }, ["id"]),
    run: ({ id, scene, frames = 6 }) => {
      try {
        const item = loadRaw(id);
        const video = videoFile(item);
        if (!video) throw new Error("no rendered video found");
        const timeline = sceneStarts(item);
        const targets = Number.isInteger(scene) ? [timeline[scene]] : timeline.slice(0, Math.max(1, Math.min(Number(frames), timeline.length)));
        const samples = targets.filter((s): s is TimelineScene => !!s).map((s) => {
          const atSec = s.startSec + Math.max(0.15, Math.min(s.durationSec * 0.5, s.durationSec - 0.15));
          return { scene: s, framePath: sampleFrame(id, video, atSec, `s${s.index}`), atSec };
        });
        return ok({ video, metadata: ffprobe(video), timeline, samples, contactSheet: contactSheet(id, samples.map((s) => s.framePath)) });
      } catch (e) {
        return fail(e);
      }
    },
  },
  {
    name: "editor_extract_frame",
    description: "Extract a single inspectable JPEG frame from the rendered video at a specific time in seconds.",
    inputSchema: obj({ id: { type: "string" }, atSec: { type: "number" } }, ["id", "atSec"]),
    run: ({ id, atSec }) => {
      try {
        const item = loadRaw(id);
        const video = videoFile(item);
        if (!video) throw new Error("no rendered video found");
        return ok({ video, framePath: sampleFrame(id, video, Number(atSec), "manual"), atSec });
      } catch (e) {
        return fail(e);
      }
    },
  },
  {
    name: "editor_scan_entire_video",
    description: "Sample the entire rendered video at low FPS and return every frame path plus chunked contact sheets. Use this when an agent needs to watch the full edit, not just scene thumbnails.",
    inputSchema: obj({ id: { type: "string" }, sampleFps: { type: "number" }, width: { type: "number" }, framesPerSheet: { type: "number" } }, ["id"]),
    run: ({ id, sampleFps = 2, width = 360, framesPerSheet = 24 }) => {
      try {
        const item = loadRaw(id);
        const video = videoFile(item);
        if (!video) throw new Error("no rendered video found");
        const fps = Math.max(0.25, Math.min(Number(sampleFps), 8));
        const scan = denseFrameScan(id, video, fps, Math.max(180, Math.min(Number(width), 1080)), Math.max(6, Math.min(Number(framesPerSheet), 60)));
        return ok({ ...scan, timeline: sceneStarts(item), metadata: ffprobe(video) });
      } catch (e) {
        return fail(e);
      }
    },
  },
  {
    name: "editor_analyze_av",
    description: "Analyze audio/video continuity: waveform image, volume levels, silence intervals, freeze intervals, black frames, and detected visual scene changes.",
    inputSchema: obj({ id: { type: "string" } }, ["id"]),
    run: ({ id }) => {
      try {
        const item = loadRaw(id);
        const video = videoFile(item);
        if (!video) throw new Error("no rendered video found");
        const metadata = ffprobe(video);
        const timeline = sceneStarts(item);
        // Pass the scene windows so loudness.perRegion is keyed to scenes the
        // mixer can act on (a VO beat sitting far under the bed, etc.).
        const regions = timeline.map((s) => ({ startSec: s.startSec, endSec: s.endSec }));
        return ok({ video, durationSec: durationFromProbe(metadata), timeline, metadata, diagnostics: videoDiagnostics(id, video, regions) });
      } catch (e) {
        return fail(e);
      }
    },
  },
  {
    name: "editor_color_scopes",
    description: "Read real ffmpeg color scopes off a render: per scene sample a mid-frame and emit waveform (luma + RGB parade), vectorscope, and histogram images, plus signalstats numbers (luma P5/P50/P95, clip% high/low, per-channel means, white-balance bias). Fails open when no render exists.",
    inputSchema: obj({ id: { type: "string" } }, ["id"]),
    run: ({ id }) => {
      try {
        const item = loadRaw(id);
        const video = videoFile(item);
        // FAIL-OPEN: no render yet → an empty, well-formed result the colorist
        // pass can read without throwing (mirrors signals.ts' no-render path).
        if (!video) return ok({ hasRender: false, scenes: [], contactSheet: null }, "no rendered video found");
        const regions = sceneStarts(item);
        const { scenes, contactSheet, scopeDir } = colorScopes(id, video, regions);
        return ok({ hasRender: true, video, scopeDir, scenes, contactSheet });
      } catch (e) {
        return fail(e);
      }
    },
  },
  {
    name: "editor_video_evidence",
    description: "Build a timecoded video-memory artifact for model review: dense frame stream, contact sheets, AV diagnostics, OCR samples, transcript words when available, pixel metrics, motion deltas, issue tags, and scene summaries.",
    inputSchema: obj({
      id: { type: "string" },
      sampleFps: { type: "number" },
      width: { type: "number" },
      framesPerSheet: { type: "number" },
      maxOcrFrames: { type: "number" },
      transcribe: { type: "boolean" },
    }, ["id"]),
    run: ({ id, sampleFps = 1, width = 320, framesPerSheet = 24, maxOcrFrames = 80, transcribe = true }) => {
      try {
        return ok(videoEvidenceTimeline(id, { sampleFps, width, framesPerSheet, maxOcrFrames, transcribe }));
      } catch (e) {
        return fail(e);
      }
    },
  },
  {
    name: "editor_competitive_deep_review",
    description: "Generate a competitor-aware deep review pack: video evidence, diagnostics, storyboard/timeline audit, strategic gaps, and suggested executable editor commands.",
    inputSchema: obj({ id: { type: "string" }, scan: { type: "boolean" }, sampleFps: { type: "number" }, width: { type: "number" }, framesPerSheet: { type: "number" } }, ["id"]),
    run: ({ id, scan = true, sampleFps = 2, width = 360, framesPerSheet = 24 }) => {
      try {
        const item = loadRaw(id);
        const video = videoFile(item);
        if (!video) throw new Error("no rendered video found");
        const review = competitiveReview(id, item, video, {
          scan: scan !== false,
          sampleFps: Math.max(0.25, Math.min(Number(sampleFps), 8)),
          width: Math.max(180, Math.min(Number(width), 1080)),
          framesPerSheet: Math.max(6, Math.min(Number(framesPerSheet), 60)),
        });
        return ok(review);
      } catch (e) {
        return fail(e);
      }
    },
  },
  {
    name: "editor_competitive_intel",
    description: "Return the structured competitive intelligence matrix: sourced competitors, scores, unmet jobs, strategic edge, and roadmap.",
    inputSchema: obj({}),
    run: () => ok({
      generatedAt: new Date().toISOString(),
      competitors: COMPETITOR_INTEL,
      opportunityScores: competitorOpportunityScores(),
      unmetJobs: UNMET_JOBS,
      strategicEdge: OUR_STRATEGIC_EDGE,
      roadmap: strategicRoadmap(),
    }),
  },
  {
    name: "editor_compare_renders",
    description: "Compare two rendered runs with evidence: before/after frames, contact sheet, timeline deltas, audio/video diagnostics deltas, visual similarity, regressions, and next commands.",
    inputSchema: obj({ beforeId: { type: "string" }, afterId: { type: "string" }, samples: { type: "number" }, width: { type: "number" } }, ["beforeId", "afterId"]),
    run: ({ beforeId, afterId, samples = 8, width = 360 }) => {
      try {
        return ok(compareRenders(beforeId, afterId, {
          samples: Math.max(2, Math.min(Number(samples), 24)),
          width: Math.max(180, Math.min(Number(width), 1080)),
        }));
      } catch (e) {
        return fail(e);
      }
    },
  },
  {
    name: "editor_readability_review",
    description: "Score rendered text readability scene-by-scene using storyboard text, timing, mobile thresholds, representative frame evidence, and exact edit recommendations.",
    inputSchema: obj({ id: { type: "string" }, width: { type: "number" } }, ["id"]),
    run: ({ id, width = 360 }) => {
      try {
        return ok(readabilityReview(id, { width: Math.max(180, Math.min(Number(width), 1080)) }));
      } catch (e) {
        return fail(e);
      }
    },
  },
  {
    name: "editor_visual_readability_review",
    description: "Inspect actual rendered frames for safe-area and contrast risk using pixel analysis, representative evidence frames, and exact edit recommendations.",
    inputSchema: obj({ id: { type: "string" }, width: { type: "number" } }, ["id"]),
    run: ({ id, width = 240 }) => {
      try {
        return ok(visualReadabilityReview(id, { width: Math.max(120, Math.min(Number(width), 720)) }));
      } catch (e) {
        return fail(e);
      }
    },
  },
  {
    name: "editor_ocr_review",
    description: "Run rendered-frame OCR and compare detected text against intended storyboard/component text, with frame evidence and exact edit recommendations.",
    inputSchema: obj({ id: { type: "string" }, width: { type: "number" } }, ["id"]),
    run: ({ id, width = 540 }) => {
      try {
        return ok(ocrReview(id, { width: Math.max(180, Math.min(Number(width), 1080)) }));
      } catch (e) {
        return fail(e);
      }
    },
  },
  {
    name: "editor_competitive_suite",
    description: "Run the full competitor-inspired regression suite and produce one scorecard across precision, text clarity, creator pacing, visual polish, packaging, evidence, and AV continuity.",
    inputSchema: obj({ id: { type: "string" }, width: { type: "number" }, sampleFps: { type: "number" } }, ["id"]),
    run: ({ id, width = 360, sampleFps = 2 }) => {
      try {
        return ok(competitiveSuite(id, {
          width: Math.max(180, Math.min(Number(width), 1080)),
          sampleFps: Math.max(0.25, Math.min(Number(sampleFps), 8)),
        }));
      } catch (e) {
        return fail(e);
      }
    },
  },
  {
    name: "editor_suite_autofix",
    description: "Create a safe cloned draft and apply conservative fixes from competitive-suite failures: duration, contrast, font scale, and mix adjustments.",
    inputSchema: obj({ id: { type: "string" }, newId: { type: "string" }, width: { type: "number" }, sampleFps: { type: "number" } }, ["id"]),
    run: ({ id, newId, width = 360, sampleFps = 1 }) => {
      try {
        return ok(applySuiteAutofix(id, {
          newId,
          width: Math.max(180, Math.min(Number(width), 1080)),
          sampleFps: Math.max(0.25, Math.min(Number(sampleFps), 8)),
        }));
      } catch (e) {
        return fail(e);
      }
    },
  },
  {
    name: "editor_accept_autofix",
    description: "Gate an autofix draft after rerender: compare source vs draft, run competitive suites on both, measure score/gate deltas, flag regressions, and write an accept/reject/needs-review report without mutating the source.",
    inputSchema: obj({
      sourceId: { type: "string" },
      draftId: { type: "string" },
      width: { type: "number" },
      sampleFps: { type: "number" },
      samples: { type: "number" },
      minScoreGain: { type: "number" },
    }, ["sourceId", "draftId"]),
    run: ({ sourceId, draftId, width = 360, sampleFps = 1, samples = 8, minScoreGain = 5 }) => {
      try {
        return ok(acceptAutofix(sourceId, draftId, {
          width: Math.max(180, Math.min(Number(width), 1080)),
          sampleFps: Math.max(0.25, Math.min(Number(sampleFps), 8)),
          samples: Math.max(2, Math.min(Number(samples), 24)),
          minScoreGain: Number(minScoreGain),
        }));
      } catch (e) {
        return fail(e);
      }
    },
  },
  {
    name: "editor_apply_recipe",
    description: "Apply a named professional edit recipe to a cloned draft only. Recipes: tighten_pacing, make_terminal_clearer, raise_retention, fix_audio_ducking. Writes patch report plus rerender/review commands.",
    inputSchema: obj({
      id: { type: "string" },
      recipe: { type: "string", enum: EDIT_RECIPES },
      newId: { type: "string" },
      intensity: { type: "number" },
    }, ["id", "recipe"]),
    run: ({ id, recipe, newId, intensity = 1 }) => {
      try {
        return ok(applyRecipe(id, {
          recipe,
          newId,
          intensity: Math.max(0.25, Math.min(Number(intensity), 2)),
        }));
      } catch (e) {
        return fail(e);
      }
    },
  },
  {
    name: "editor_start_rerender",
    description: "Start a background rerender for a run after edits. Returns the spawned process id and log path.",
    inputSchema: obj({ id: { type: "string" }, voice: { type: "boolean" }, broll: { type: "boolean" }, procedural: { type: "boolean" } }, ["id"]),
    run: ({ id, voice, broll, procedural }) => {
      try {
        const script = join(ROOT, "packages", "engine", "src", "rerender.ts");
        const args = ["--import", "tsx", script, id];
        if (voice) args.push("--voice");
        if (broll) args.push("--broll");
        if (procedural) args.push("--procedural");
        const logPath = join(DATA_DIR, "agent-rerender.log");
        const out = openSync(logPath, "a");
        const child = spawn("node", args, { cwd: ROOT, detached: true, stdio: ["ignore", out, out], env: process.env });
        child.unref();
        return ok({ id, pid: child.pid, logPath }, "rerender started");
      } catch (e) {
        return fail(e);
      }
    },
  },
  {
    name: "editor_validate",
    description: "Validate a run storyboard against the shared renderer schema without changing files.",
    inputSchema: obj({ id: { type: "string" } }, ["id"]),
    run: ({ id }) => {
      try {
        return ok(validateStoryboard(loadRaw(id)));
      } catch (e) {
        return fail(e);
      }
    },
  },
];

export function callEditorTool(name: string, input: any): ToolResult {
  const tool = editorTools.find((t) => t.name === name);
  if (!tool) return { ok: false, message: `unknown tool: ${name}` };
  return tool.run(input ?? {});
}

export function toolManifest() {
  return editorTools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
}

export function repoRoot() {
  return ROOT;
}

export function formatCliResult(result: ToolResult) {
  if (!result.ok) {
    process.exitCode = 1;
    return JSON.stringify(result, null, 2);
  }
  return JSON.stringify(result.data ?? { ok: true, message: result.message }, null, 2);
}

export function latestItemId() {
  ensureDir(RUNS_DIR);
  const latest = readdirSync(RUNS_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => loadRaw(basename(f, ".json")))
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0];
  return latest?.id;
}

/* ─── Pillar 5 (Ingest & Understand) reuse surface ───────────────────────────
   The deep-understanding pipeline (understanding.ts, N2) reuses these analysis
   primitives VERBATIM — the same ffmpeg/Whisper/OCR/pixel-metric code that powers
   editor_video_evidence / editor_analyze_av / the colorist scopes. Exporting them
   (rather than re-shelling-out in understanding.ts) keeps ONE implementation of
   each measurement, so a fix to scene-detect or transcription is felt everywhere.
   All are best-effort: transcribe/diagnostics fail open to empty/NaN, never throw
   (videoDiagnostics' sub-probes throw on a hard ffmpeg error — the caller wraps). */
export {
  videoFile as resolveVideoFile, // item → its on-disk video (ingested: videoPath = source)
  ffprobe as probeVideo,
  durationFromProbe,
  transcribeVideoAudio, // Whisper words + segments (+ audioPath) — the single transcript path
  videoDiagnostics, // scene-change ∪ silence ∪ freeze/black ∪ ebur128 ∪ per-region RMS
  // perRegionRms is exported at its declaration (P3 punch-ins import it) — not re-exported here.
  denseFrameScan, // evenly-strided frame stream + contact sheets
  rawFrame, // decode one frame to raw rgb24 at a source timestamp
  analyzeFramePixels, // bright/dark/edge/central-contrast pixel metrics from a raw frame
  frameVisualMetrics, // analyzeFramePixels + motionDelta vs a previous frame
  runVisionOcr, // macOS Vision OCR over frame images (fail-open when unavailable)
  wordsInRange, // transcript words whose span overlaps [startSec,endSec]
  textSimilarity, // token-overlap similarity (0..1) for redundancy detection
  sampleFrame, // write one scaled jpg at a source timestamp (keyframe thumbs)
};
