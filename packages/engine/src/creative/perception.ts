/* creative/perception.ts — SOURCE-clip perception.
 *
 * WHAT THE EDITOR "SEES" before committing footage to a cut. This is the eyes of
 * the editorial-judgement layer: given a clip (local path or http(s) URL) it
 * derives best-effort visual metrics — brightness, motion, shakiness, a quality
 * composite, the most interesting moment, and which scene FUNCTIONS the clip is
 * suited for — using only ffmpeg/ffprobe (the binaries the rest of the engine
 * already shells out to; see media.ts and editor-tools.ts for the patterns).
 *
 * DESIGN: fail-open, always. Perception is advisory, never a gate. Every metric
 * is optional; on ANY probe/sample failure we return a minimal ClipAnalysis that
 * records what failed in `notes` and leaves `reject` undefined (i.e. "unknown",
 * not "bad") so a flaky ffmpeg run never silently throws out usable footage.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { ClipAnalysis } from "@os/schemas";
import { loadItem, saveItem, logLine } from "../store.ts";
// enrichBrollQuery is how broll.ts mangles a scene query BEFORE hashing the
// cache filename — we must mirror it to locate the resolved asset on disk.
import { enrichBrollQuery } from "../broll.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
// public/broll mirrors broll.ts: assets live at <REMOTION_PUBLIC>/broll/<h>.{mp4,png}
const REMOTION_PUBLIC = join(HERE, "..", "..", "..", "remotion", "public");
const BROLL_DIR = join(REMOTION_PUBLIC, "broll");
// scratch dir for short remote-segment downloads; reuse the engine's hf-cache so
// we don't litter os.tmpdir on long-lived hosts (cleaned up after each analyze).
const SCRATCH = join(HERE, "..", "..", "..", "data", "hf-cache");

// Number of frames we aim to sample across a clip for motion/brightness.
const N_SAMPLES = 8;

const sha16 = (s: string) => createHash("sha1").update(s).digest("hex").slice(0, 16);
const isUrl = (s: string) => /^https?:\/\//i.test(s);
const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

/* Thin ffmpeg/ffprobe wrappers. These NEVER throw — perception is best-effort,
   so a non-zero exit just yields null/empty and the caller degrades gracefully.
   (Contrast with editor-tools.ts `run`, which throws; there a render must fail
   loudly, here a missing metric is fine.) */
function probe(args: string[]): { ok: boolean; stdout: string; stderr: string } {
  const r = spawnSync("ffprobe", args, { encoding: "utf8", timeout: 30_000 });
  return { ok: r.status === 0, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}
function ff(args: string[]): { ok: boolean; stdout: string; stderr: string } {
  // ffmpeg writes its measurement metadata (signalstats, showinfo, scene scores)
  // to STDERR, so we always capture both streams.
  const r = spawnSync("ffmpeg", args, { encoding: "utf8", timeout: 60_000 });
  return { ok: r.status === 0, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/* Clip duration via ffprobe (0 if unknown). Used to spread frame samples. */
function probeDuration(src: string): number {
  const r = probe(["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", src]);
  if (!r.ok) return 0;
  const d = parseFloat(r.stdout.trim());
  return Number.isFinite(d) && d > 0 ? d : 0;
}

/* Brightness via ffmpeg `signalstats`: YAVG is mean luma (0-255) per frame. We
   sample a handful of frames across the clip (`select` + signalstats) and read
   the per-frame `lavfi.signalstats.YAVG` from metadata, averaging them. Returns
   { mean 0-1, samples } or null on failure. Filter string mirrors the analysis
   idiom in editor-tools.ts (signalstats/showinfo over a frame stride). */
function brightnessSamples(src: string, dur: number): { mean: number; values: number[] } | null {
  // ~8 evenly spaced frames; on unknown duration fall back to fps-strided sampling.
  // Thin the stream with `fps` so signalstats runs over roughly N frames spread
  // across the clip, then print each frame's YAVG via metadata=print.
  const N = N_SAMPLES;
  const vf =
    dur > 0
      ? `fps=${(N / dur).toFixed(4)},signalstats,metadata=print`
      : `select='not(mod(n\\,15))',signalstats,metadata=print`;
  const r = ff(["-v", "info", "-i", src, "-vf", vf, "-an", "-frames:v", String(N * 2), "-f", "null", "-"]);
  const matches = [...r.stderr.matchAll(/lavfi\.signalstats\.YAVG=([0-9.]+)/g)].map((m) => Number(m[1]));
  if (!matches.length) return null;
  const values = matches.map((y) => clamp01(y / 255));
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return { mean, values };
}

/* Motion via ffmpeg scene-change scoring: `select='gt(scene,0)',showinfo` emits
   a per-frame `scene:<score>` (0..1, how different this frame is from the prior).
   We average those scores for an overall motion estimate, and use their spread
   (variance) as a shakiness proxy — handheld/jittery footage has BOTH high mean
   motion AND high variance. Returns { motion 0-1, shaky, scores, peakSec } or
   null. Mirrors editor-tools.ts which uses select='gt(scene,0.18)' for cuts. */
function motionProfile(src: string, dur: number): { motion: number; shaky: boolean; peakSec?: number } | null {
  // Thin the stream first (fps) so we score a manageable, evenly spread set of
  // frames rather than every frame of a 60fps clip.
  const fps = dur > 0 ? Math.min(12, Math.max(2, Math.round(N_SAMPLES / dur))) : 6;
  const r = ff([
    "-v", "info",
    "-i", src,
    "-vf", `fps=${fps},select='gt(scene,0)',metadata=print`,
    "-an",
    "-f", "null", "-",
  ]);
  // metadata=print emits paired lines: "pts_time:<t>" then "lavfi.scene_score=<s>".
  // Pair them up positionally so we can locate the peak-motion timestamp.
  const times = [...r.stderr.matchAll(/pts_time:([0-9.]+)/g)].map((m) => Number(m[1]));
  const scores = [...r.stderr.matchAll(/lavfi\.scene_score=([0-9.]+)/g)].map((m) => Number(m[1]));
  if (!scores.length) return null;
  const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
  // Scene scores are typically small (0..0.3 for ordinary motion); scale so that
  // a mean of ~0.25 reads as fully frenetic, clamped.
  const motion = clamp01(mean / 0.25);
  const variance = scores.reduce((a, b) => a + (b - mean) ** 2, 0) / scores.length;
  const std = Math.sqrt(variance);
  // Shaky = energetic AND erratic: high mean motion and high relative spread.
  const shaky = motion > 0.45 && std > 0.06;
  // Peak moment = timestamp of the highest scene score (most visually eventful).
  let peakSec: number | undefined;
  if (times.length === scores.length && scores.length) {
    let bi = 0;
    for (let i = 1; i < scores.length; i++) if (scores[i] > scores[bi]) bi = i;
    peakSec = times[bi];
  }
  return { motion, shaky, peakSec };
}

/* Map measured energy → candidate scene FUNCTIONS. High-energy footage carries a
   hook/tension/cut; calm footage settles a resolution/proof/context beat. Always
   include b_roll as a safe baseline (this IS b-roll). Returns the SceneFunction
   string tags ClipAnalysis.suitableFor expects (validated by zod on save). */
function suitabilityFor(motion: number): string[] {
  const tags = new Set<string>(["b_roll"]);
  if (motion >= 0.55) {
    tags.add("hook");
    tags.add("tension");
    tags.add("transition");
  } else if (motion <= 0.25) {
    tags.add("resolution");
    tags.add("proof");
    tags.add("context");
  } else {
    // mid-energy reads as illustrative support
    tags.add("example");
    tags.add("context");
  }
  return [...tags];
}

/* Download just the FIRST few seconds of a remote clip to a temp file so motion
   sampling has real frames to chew on without pulling the whole asset. Uses
   ffmpeg stream-copy with -t; returns the temp path or null. Caller cleans up. */
function fetchSegment(url: string, seconds = 6): string | null {
  try {
    mkdirSync(SCRATCH, { recursive: true });
  } catch {
    /* fall through to os.tmpdir below if hf-cache isn't writable */
  }
  const dir = existsSync(SCRATCH) ? SCRATCH : tmpdir();
  const out = join(dir, `perc_${sha16(url)}_${Date.now()}.mp4`);
  // -t before -i would limit input read time; we want OUTPUT duration, so place
  // -t after -i. Stream-copy keeps it cheap; re-encode fallback if copy fails.
  let r = ff(["-y", "-i", url, "-t", String(seconds), "-c", "copy", "-an", out]);
  if (!r.ok || !existsSync(out)) {
    r = ff(["-y", "-i", url, "-t", String(seconds), "-c:v", "libx264", "-preset", "ultrafast", "-an", out]);
  }
  return r.ok && existsSync(out) ? out : null;
}

/**
 * analyzeClip — perceive a single source clip. FAIL-OPEN: any failure yields a
 * minimal ClipAnalysis (source + notes), never throws.
 *
 * @param source local file path OR http(s) URL to a video
 * @param opts.sceneId optional sceneId to tag the result with
 */
export async function analyzeClip(source: string, opts?: { sceneId?: string }): Promise<ClipAnalysis> {
  const base = { sceneId: opts?.sceneId, source };

  // Resolve what we'll actually probe/sample. For local files, must exist.
  let probeTarget = source;
  let segment: string | null = null;
  const remote = isUrl(source);

  try {
    if (!remote && !existsSync(source)) {
      return ClipAnalysis.parse({ ...base, notes: "source file not found on disk" });
    }

    // Duration: ffprobe works directly on a URL, so probe the original target.
    const dur = probeDuration(source);

    // For motion/brightness sampling on remote URLs, decoding the whole stream
    // repeatedly is wasteful and flaky — grab a short local segment to sample.
    // Brightness/motion of the opening seconds is a fine proxy for "the look".
    if (remote) {
      segment = fetchSegment(source, Math.min(8, dur > 0 ? Math.ceil(dur) : 6));
      if (segment) probeTarget = segment;
    }

    const segDur = remote && segment ? probeDuration(segment) || dur : dur;

    // Best-effort metrics — each independently optional.
    const bright = brightnessSamples(probeTarget, segDur);
    const mot = motionProfile(probeTarget, segDur);

    const brightness = bright ? clamp01(bright.mean) : undefined;
    const motion = mot ? clamp01(mot.motion) : undefined;
    const shaky = mot ? mot.shaky : undefined;

    // Quality composite (heuristic, 0-1): favour well-exposed (mid-bright, not
    // crushed or blown) and stable footage. Only computed when we have signal.
    let quality: number | undefined;
    if (brightness !== undefined || motion !== undefined) {
      // Exposure score peaks around mid-grey (~0.45) and falls off toward black/white.
      const expo = brightness === undefined ? 0.6 : clamp01(1 - Math.abs(brightness - 0.45) / 0.45);
      // Stability score: penalise shaky footage; reward calm-to-moderate motion.
      const stability = shaky ? 0.35 : motion === undefined ? 0.6 : clamp01(1 - Math.max(0, motion - 0.6));
      quality = clamp01(0.6 * expo + 0.4 * stability);
    }

    // Best moment: prefer the peak-motion timestamp, but only trust it if the
    // clip isn't near-black there. We don't re-sample brightness per-instant
    // (too costly); the peak-motion ts within an overall well-exposed clip is a
    // good "most interesting frame" pick. Fall back to ~1/3 in.
    let bestMomentSec: number | undefined;
    if (mot?.peakSec !== undefined && (brightness === undefined || brightness > 0.06)) {
      // peakSec is measured on the (possibly short) segment; for remote clips
      // that's still within [0, segDur], a valid timestamp into the asset.
      bestMomentSec = Number(mot.peakSec.toFixed(2));
    } else if (dur > 0) {
      bestMomentSec = Number((dur / 3).toFixed(2));
    }

    // Reject ONLY when clearly unusable: near-black throughout, or probing failed
    // outright with nothing salvageable. Otherwise leave undefined (= acceptable).
    let reject: boolean | undefined;
    const notes: string[] = [];
    if (brightness !== undefined && brightness < 0.04) {
      reject = true;
      notes.push("near-black footage (mean luma < 4%)");
    }
    if (brightness === undefined && motion === undefined) {
      // Both probes yielded nothing — degraded, but don't auto-reject a clip we
      // simply couldn't measure (it may still render fine). Note the gap.
      if (dur === 0) {
        reject = true;
        notes.push("ffprobe/ffmpeg yielded no signal and no duration — likely unreadable");
      } else {
        notes.push("could not sample frames; metrics unavailable (fail-open)");
      }
    }
    if (shaky) notes.push("high + erratic motion (shaky)");

    const suitableFor = motion !== undefined ? suitabilityFor(motion) : ["b_roll"];

    return ClipAnalysis.parse({
      ...base,
      brightness,
      motion,
      shaky,
      quality,
      bestMomentSec,
      suitableFor,
      reject,
      // hasText intentionally left undefined — heavy OCR is out of scope here.
      notes: notes.length ? notes.join("; ") : undefined,
    });
  } catch (err) {
    // Absolute backstop: never throw out of perception.
    return ClipAnalysis.parse({
      ...base,
      notes: `analyze failed: ${(err as Error)?.message ?? String(err)}`,
    });
  } finally {
    // Clean up any downloaded segment regardless of outcome.
    if (segment) {
      try {
        rmSync(segment, { force: true });
      } catch {
        /* non-fatal */
      }
    }
  }
}

/* Locate a resolved local b-roll asset for a scene query. broll.ts caches assets
   at broll/<sha1_16(`${kind}:${query}`)>.{mp4,png} where `query` is the ENRICHED
   query (enrichBrollQuery(rawQuery, sceneType)), plus a `_ai.mp4` variant for AI
   generations. We can't know which provider won, so we try every candidate hash
   (enriched AND raw, both kinds defensively) across all three extensions, newest
   match wins. Returns an absolute path or null. */
function locateBrollAsset(rawQuery: string, kind: string, sceneType?: string): string | null {
  if (!existsSync(BROLL_DIR)) return null;
  const enriched = (() => {
    try {
      return enrichBrollQuery(rawQuery, sceneType);
    } catch {
      return rawQuery;
    }
  })();
  // Candidate query strings (enriched is what the pipeline actually hashes; raw
  // is a fallback in case a caller resolved without enrichment).
  const queries = enriched === rawQuery ? [rawQuery] : [enriched, rawQuery];
  // Defensive: try the scene's kind first, then the other kind.
  const kinds = kind === "abstract" ? ["abstract", "concrete"] : ["concrete", "abstract"];
  const exts = [".mp4", "_ai.mp4", ".png"]; // video preferred over still

  for (const q of queries) {
    for (const k of kinds) {
      const h = sha16(`${k}:${q}`);
      for (const ext of exts) {
        const p = join(BROLL_DIR, `${h}${ext}`);
        if (existsSync(p)) return p;
      }
    }
  }
  return null;
}

/**
 * perceiveItemBroll — perceive every resolved b-roll asset behind an item's
 * storyboard, keyed by scene.id. Persists results onto item.clipAnalysis (merge)
 * and returns the Record. FAIL-OPEN: scenes whose asset can't be located are
 * skipped; if NOTHING is resolvable, returns {} without throwing.
 */
export async function perceiveItemBroll(id: string): Promise<Record<string, ClipAnalysis>> {
  const item = loadItem(id);
  const scenes = item.storyboard?.scenes ?? [];
  const results: Record<string, ClipAnalysis> = {};

  for (const scene of scenes) {
    if (!scene?.broll?.query) continue;
    const asset = locateBrollAsset(scene.broll.query, scene.broll.kind ?? "concrete", scene.type);
    if (!asset) continue; // unresolved on disk → nothing to perceive, skip quietly
    // analyzeClip never throws, but guard anyway so one bad clip can't abort the loop.
    try {
      results[scene.id] = await analyzeClip(asset, { sceneId: scene.id });
    } catch {
      /* fail-open: skip this scene */
    }
  }

  if (Object.keys(results).length) {
    // Merge onto any existing perception (don't clobber other-keyed analyses).
    item.clipAnalysis = { ...(item.clipAnalysis ?? {}), ...results };
    saveItem(item);
    logLine(item, `perception: analyzed ${Object.keys(results).length} b-roll clip(s)`);
  }
  return results;
}
