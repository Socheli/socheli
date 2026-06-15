import { bundle } from "@remotion/bundler";
import { selectComposition, renderMedia, renderStill, makeCancelSignal } from "@remotion/renderer";
import { spawnSync } from "node:child_process";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, renameSync, writeFileSync, readFileSync, rmSync, readdirSync, mkdirSync, symlinkSync, copyFileSync, statSync } from "node:fs";
import { RENDERS_DIR, ensureDir, loadItem, saveItem } from "./store.ts";
import { ASPECT_PRESETS } from "./format.ts";
import type { PostProps, WordCue, SubtitleCue } from "./types.ts";
import type { CarouselSpec, Clip, ColorGrade, ContentItem, Mix, Timeline } from "@os/schemas";
import { buildAudioFiltergraph, duckMusic } from "./media.ts";
import { resolveClipPlan, type ClipPlanEntry } from "./creative/compile.ts";
import { computeZoomWindows, type ZoomWindow } from "./creative/emphasis-zoom.ts";

export type CoverProps = {
  title: string;
  eyebrow?: string;
  themeName?: string;
  mood?: string;
  bg?: string;
  logo?: string;
  handle?: string;
  highlight?: string;
};

/* Master the final mix to the platform-standard integrated loudness so every post is
   consistently loud. M7: the integrated target is read from `mix.loudnessTarget` when set
   (a track may carry a platform-derived target); absent → the historical -14 LUFS, so
   every existing render masters byte-identically. */
function masterAudio(mp4: string, log: (m: string) => void, loudnessTarget?: number): void {
  const tmp = mp4.replace(/\.mp4$/, "_m.mp4");
  const I = typeof loudnessTarget === "number" && Number.isFinite(loudnessTarget) ? loudnessTarget : -14;
  const r = spawnSync(
    "ffmpeg",
    ["-y", "-i", mp4, "-c:v", "copy", "-af", `loudnorm=I=${I}:TP=-1.5:LRA=11,afade=t=in:st=0:d=0.25`, "-c:a", "aac", "-b:a", "256k", tmp],
    { encoding: "utf8" },
  );
  if (r.status === 0 && existsSync(tmp)) {
    renameSync(tmp, mp4);
    log(`mastered to ${I} LUFS`);
  }
}

/* M18 — ffmpeg FINISHING pass: fidelity the in-browser SVG/CSS render can't reach.
 *   • lut3d=<file.cube>  — a film-accurate 3D-LUT grade beyond the GradePipeline
 *   • chromakey/despill  — a TRUE colour key (the M14 key_chroma node's "ffmpeg hook")
 *   • unsharp            — optional finishing sharpen
 * NON-BREAKING: with NOTHING requested it returns the input UNCHANGED (no re-encode),
 * so every existing render is byte-identical. FAIL-OPEN: any ffmpeg failure returns the
 * original path rather than throwing into the render/publish loop. Audio is stream-copied. */
export function finishVideo(
  inPath: string,
  opts: { lut?: string; chromaKey?: { color: string; similarity?: number; blend?: number }; sharpen?: boolean; out?: string } = {},
  log: (m: string) => void = () => {},
): string {
  const vf: string[] = [];
  if (opts.lut && existsSync(opts.lut)) vf.push(`lut3d='${opts.lut.replace(/'/g, "\\'")}'`);
  if (opts.chromaKey?.color) {
    const { color, similarity = 0.1, blend = 0.1 } = opts.chromaKey;
    // chromakey drops the keyed colour to alpha; flatten back over black so the mp4
    // stays opaque (a true alpha composite belongs to the timeline, not the master).
    vf.push(`chromakey=${color}:${similarity}:${blend}`, "despill", "format=yuv420p");
  }
  if (opts.sharpen) vf.push("unsharp=5:5:0.6:5:5:0.0");
  if (!vf.length) return inPath; // nothing to finish → byte-identical passthrough

  const out = opts.out ?? inPath.replace(/\.mp4$/, "_finished.mp4");
  const r = spawnSync(
    "ffmpeg",
    ["-y", "-i", inPath, "-vf", vf.join(","), "-c:a", "copy", "-c:v", "libx264", "-crf", "18", "-pix_fmt", "yuv420p", out],
    { encoding: "utf8" },
  );
  if (r.status === 0 && existsSync(out)) {
    log(`finished (${vf.map((f) => f.split("=")[0]).join("+")})`);
    if (!opts.out) { renameSync(out, inPath); return inPath; } // in-place finish
    return out;
  }
  log(`finish skipped (ffmpeg ${r.status})`);
  return inPath; // fail-open
}

/* Region-blocked Chrome download — use an installed Chrome instead. */
function findBrowser(): string | undefined {
  const candidates = [
    process.env.REMOTION_BROWSER,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
  ].filter(Boolean) as string[];
  return candidates.find((p) => existsSync(p));
}
const BROWSER = findBrowser();

const HERE = dirname(fileURLToPath(import.meta.url));
const REMOTION_ROOT = resolve(HERE, "..", "..", "remotion");
const ENTRY = join(REMOTION_ROOT, "src", "index.ts");

let cachedBundle: string | null = null;

const alias = {
  "@os/schemas": resolve(REMOTION_ROOT, "..", "schemas", "src", "index.ts"),
  "@os/tokens": resolve(REMOTION_ROOT, "..", "tokens", "src", "index.ts"),
};

/* A FIXED bundle output dir, on an external volume when mounted. bundle() otherwise
   writes to a fresh os.tmpdir() folder on EVERY call and never cleans it up — with the
   ~2GB public/ (b-roll) copied in each time and resetBundle() forcing a re-bundle
   per chapter, that leaked tens of GB onto the small boot disk. A stable outDir is
   overwritten in place (one copy, no leak) and lives on the big external disk. */
const BUNDLE_BASE =
  process.env.SOCHELI_BUNDLE_DIR ||
  (process.env.SOCHELI_EXT_VOLUME && existsSync(process.env.SOCHELI_EXT_VOLUME)
    ? join(process.env.SOCHELI_EXT_VOLUME, "Socheli", "bundle")
    : join(REMOTION_ROOT, "..", "..", "data", "bundle"));

/* Concurrent renders must NOT share an outDir: two bundles race on the public/
   broll symlink (EEXIST) and longform re-bundles mid-run, clobbering a sibling's
   snapshot while it renders. Each process gets its own subdir; stale siblings
   (dead pids) are reaped on first use, so steady-state disk cost stays one copy. */
const BUNDLE_DIR = join(BUNDLE_BASE, `p${process.pid}`);

function reapStaleBundles(): void {
  try {
    for (const name of readdirSync(BUNDLE_BASE)) {
      const m = /^p(\d+)$/.exec(name);
      if (!m || Number(m[1]) === process.pid) continue;
      try {
        process.kill(Number(m[1]), 0); // alive → leave its bundle alone
      } catch {
        try { rmSync(join(BUNDLE_BASE, name), { recursive: true, force: true }); } catch { /* ignore */ }
      }
    }
  } catch { /* base missing yet — nothing to reap */ }
}

/* Long-form renders chapters in sequence; each chapter resolves NEW b-roll into
   public/ AFTER the previous chapter's bundle snapshot was taken, so those assets
   404. Reset the cache before each chapter so it re-bundles with assets present. */
export function resetBundle(): void {
  cachedBundle = null;
}

async function getBundle(onProgress?: (p: number) => void): Promise<string> {
  if (cachedBundle) return cachedBundle;
  reapStaleBundles();
  ensureDir(BUNDLE_DIR);
  // Always wipe the bundle's WHOLE public/ before (re)bundling. Remotion recreates it
  // by symlinking packages/remotion/public into the bundle; ANY stale symlink/copy left
  // from a previous chapter's bundle — the broll dir OR a spine/<id>.mp4 from an earlier
  // hybrid render — makes the next bundle() throw EEXIST mid-longform. Wiping the whole
  // public/ (not just broll) covers every such subdir. The real assets live under
  // packages/remotion/public, so re-symlinking them is cheap and safe.
  try { rmSync(join(BUNDLE_DIR, "public"), { recursive: true, force: true }); } catch { /* ignore */ }
  cachedBundle = await bundle({
    entryPoint: ENTRY,
    publicDir: join(REMOTION_ROOT, "public"),
    outDir: BUNDLE_DIR,
    onProgress: (p) => onProgress?.(p),
    webpackOverride: (config) => ({
      ...config,
      resolve: {
        ...config.resolve,
        alias: { ...(config.resolve?.alias ?? {}), ...alias },
      },
    }),
  });
  return cachedBundle;
}

export async function renderPost(
  id: string,
  props: PostProps,
  opts: { preview?: boolean; log?: (m: string) => void } = {},
): Promise<string> {
  const log = opts.log ?? (() => {});
  ensureDir(RENDERS_DIR);
  // persist the exact render props as a sidecar so the dashboard's live Player
  // preview matches the final video.
  try {
    const propsDir = join(RENDERS_DIR, "..", "props");
    ensureDir(propsDir);
    writeFileSync(join(propsDir, `${id}.json`), JSON.stringify(props));
  } catch {
    /* non-fatal */
  }
  // resetBundle FIRST: getBundle caches the bundle (a COPY of remotion/public taken
  // at build time) for the whole process. A long-running fleet AGENT renders many
  // runs in sequence; this run's freshly-written assets (music/voice/sfx/b-roll in
  // remotion/public) are NOT in a bundle cached by an earlier run → Remotion 404s
  // them mid-render (e.g. <id>_music.wav). Re-bundle per render so the served public
  // dir always has THIS run's assets. (Mirrors renderHybrid + the longform-chapter reset.)
  resetBundle();
  log("bundling renderer…");
  const serveUrl = await getBundle((p) => p > 0.99 && log("bundle ready"));
  const composition = await selectComposition({
    serveUrl,
    id: "Post",
    inputProps: props as unknown as Record<string, unknown>,
    browserExecutable: BROWSER,
  });
  const scale = opts.preview ? 0.5 : 1;
  const outPath = join(RENDERS_DIR, `${id}${opts.preview ? "_preview" : ""}.mp4`);
  log(`rendering ${composition.durationInFrames} frames @ ${scale}x…`);
  let lastPct = -1;
  // Long single renders OOM Chrome / hang a delayRender on a slow asset and the
  // tab gets "Target closed". Render with a generous per-frame timeout and modest
  // concurrency, and retry the whole pass on a fresh browser if it dies.
  // A render that emits NO progress for this long is wedged (Chrome pegged on a
  // frame / a runaway composition), not merely slow — a healthy render reports
  // every few seconds even on weak GPUs. We cancel it and let the retry loop
  // restart on a fresh browser, so one bad frame can't hang the whole run.
  const STALL_MS = Number(process.env.SOCHELI_RENDER_STALL_MS || 3 * 60 * 1000);
  const doRender = () => {
    const { cancelSignal, cancel } = makeCancelSignal();
    let lastProgressAt = Date.now();
    let watchdog: ReturnType<typeof setInterval> | undefined;
    const render = renderMedia({
      composition,
      serveUrl,
      codec: "h264",
      outputLocation: outPath,
      inputProps: props as unknown as Record<string, unknown>,
      browserExecutable: BROWSER,
      scale,
      // CRF 21 is visually transparent at 1080p and ~halves the file vs 18 — the
      // platforms (YouTube/IG/TikTok) re-encode on upload anyway, so feeding them a
      // leaner master cuts render size + upload time with no perceptible loss.
      // Override with SOCHELI_RENDER_CRF (e.g. 18 for an archival master).
      crf: opts.preview ? 28 : Number(process.env.SOCHELI_RENDER_CRF || 21),
      concurrency: Number(process.env.SOCHELI_RENDER_CONCURRENCY || 3),
      timeoutInMilliseconds: 90000,
      offthreadVideoCacheSizeInBytes: 512 * 1024 * 1024,
      chromiumOptions: { gl: "angle" },
      cancelSignal,
      onProgress: ({ progress, renderedFrames, encodedFrames }) => {
        lastProgressAt = Date.now();
        const pct = Math.round(progress * 100);
        // every ~5% so the render reads as a live, moving bar (the agent's 30s
        // heartbeat backstops any quieter stretches)
        if (pct !== lastPct && pct % 5 === 0) { lastPct = pct; log(`rendering ${pct}% (${renderedFrames ?? encodedFrames ?? 0} frames)`); }
      },
    });
    const stalled = new Promise<never>((_, reject) => {
      watchdog = setInterval(() => {
        if (Date.now() - lastProgressAt > STALL_MS) {
          try { cancel(); } catch { /* already settling */ }
          reject(new Error(`render stalled — no progress for ${Math.round(STALL_MS / 1000)}s`));
        }
      }, 15000);
    });
    return Promise.race([render, stalled]).finally(() => { if (watchdog) clearInterval(watchdog); });
  };
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await doRender();
      lastErr = undefined;
      break;
    } catch (e) {
      lastErr = e;
      log(`render attempt ${attempt} failed (${(e as Error)?.message?.slice(0, 80) ?? e}); ${attempt < 3 ? "retrying on a fresh browser…" : "giving up"}`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  if (lastErr) throw lastErr;
  if (!opts.preview) masterAudio(outPath, log, props.mix?.loudnessTarget);
  return outPath;
}

const PUBLIC = join(REMOTION_ROOT, "public");

/* Resolve a key-visual image for the cover from the post's b-roll. An image
   b-roll is referenced by its (already-bundled) static path; a video b-roll has
   a frame extracted and returned as a data: URL — the render bundle is cached
   before this runs, so a freshly-written static file would 404. */
export function coverBg(id: string, brolls?: ({ src: string; type: string } | null)[]): string | undefined {
  const pick = (brolls ?? []).find(Boolean) as { src: string; type: string } | undefined;
  if (!pick) return undefined;
  if (pick.type === "image") return pick.src; // already in the bundle's public dir
  const src = join(PUBLIC, pick.src);
  if (!existsSync(src)) return undefined;
  const tmp = join(RENDERS_DIR, `${id}_coverbg.jpg`);
  const r = spawnSync("ffmpeg", ["-y", "-ss", "0.6", "-i", src, "-frames:v", "1", "-vf", "scale=640:-1", "-q:v", "4", tmp], { encoding: "utf8" });
  if (r.status !== 0 || !existsSync(tmp)) return undefined;
  const dataUrl = `data:image/jpeg;base64,${readFileSync(tmp).toString("base64")}`;
  rmSync(tmp, { force: true });
  return dataUrl;
}

/* Render the DESIGNED cover as a still (replaces the old frame-grab thumbnail). */
export async function renderCover(id: string, props: CoverProps): Promise<string | null> {
  ensureDir(RENDERS_DIR);
  const serveUrl = await getBundle();
  const out = join(RENDERS_DIR, `${id}_thumb.jpg`);
  const composition = await selectComposition({ serveUrl, id: "Cover", inputProps: props as unknown as Record<string, unknown>, browserExecutable: BROWSER });
  await renderStill({
    composition,
    serveUrl,
    output: out,
    inputProps: props as unknown as Record<string, unknown>,
    browserExecutable: BROWSER,
    imageFormat: "jpeg",
    jpegQuality: 92,
    scale: 1,
    overwrite: true,
  });
  return existsSync(out) ? out : null;
}

/* Render the StaticPost composition as a PNG still. */
export async function renderStatic(
  id: string,
  props: {
    headline: string;
    body?: string;
    eyebrow?: string;
    layout: string;
    bgImageSrc?: string;
    bgColor?: string;
    accent: string;
    themeName: string;
    mood?: string;
    handle?: string;
    logo?: string;
    width?: number;
    height?: number;
    slideNumber?: number;
    totalSlides?: number;
    isCover?: boolean;
    isCta?: boolean;
  },
  opts: { log?: (m: string) => void } = {},
): Promise<string> {
  const log = opts.log ?? (() => {});
  ensureDir(RENDERS_DIR);
  log("bundling renderer for static…");
  const serveUrl = await getBundle();
  const inputProps = {
    width: 1080,
    height: 1080,
    ...props,
  };
  const composition = await selectComposition({
    serveUrl,
    id: "StaticPost",
    inputProps: inputProps as unknown as Record<string, unknown>,
    browserExecutable: BROWSER,
  });
  const out = join(RENDERS_DIR, `${id}-static.png`);
  log("rendering static PNG…");
  await renderStill({
    composition,
    serveUrl,
    output: out,
    inputProps: inputProps as unknown as Record<string, unknown>,
    browserExecutable: BROWSER,
    imageFormat: "png",
    scale: 1,
    overwrite: true,
  });
  return existsSync(out) ? out : (() => { throw new Error(`renderStatic: output not found at ${out}`); })();
}

/* ─── Long-form helpers ────────────────────────────────────────────────── */

/* Concat chapter mp4s (uniform codec/size/fps from renderMedia) into one video. */
export function concatVideos(id: string, files: string[]): string | null {
  ensureDir(RENDERS_DIR);
  const listFile = join(RENDERS_DIR, `${id}_list.txt`);
  writeFileSync(listFile, files.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join("\n"));
  const out = join(RENDERS_DIR, `${id}.mp4`);
  // Inputs are normalized to one timebase upstream (every chapter re-encoded), so
  // stream-copy concat is correct AND fast. Re-encode fallback just in case.
  let r = spawnSync("ffmpeg", ["-y", "-f", "concat", "-safe", "0", "-i", listFile, "-c", "copy", "-movflags", "+faststart", out], { encoding: "utf8" });
  if (r.status !== 0 || !existsSync(out)) {
    r = spawnSync("ffmpeg", ["-y", "-f", "concat", "-safe", "0", "-i", listFile, "-c:v", "libx264", "-crf", String(process.env.SOCHELI_RENDER_CRF || 21), "-pix_fmt", "yuv420p", "-r", "30", "-c:a", "aac", "-b:a", "256k", "-movflags", "+faststart", out], { encoding: "utf8", maxBuffer: 1 << 26 });
  }
  rmSync(listFile, { force: true });
  return existsSync(out) ? out : null;
}

/* ─────────────────────────────────────────────────────────────────────────────
   N6.0 — the ffmpeg FOOTAGE SPINE (hybrid render, roadmap §7.1.4 steps 1-3).

   The hybrid render cuts a real ingested source into one silent "spine" mp4 that
   the Remotion HybridPost (N6.1) later composites over via OffthreadVideo. This
   file owns the FOOTAGE-CUTTING half only: compile → cut each part → concat. The
   overlay/grade/audio halves land in N6.1/N6.2.

   Two pieces:
     • cutClip()    — ffmpeg-trim ONE source window to a normalized part file.
     • renderSpine()— resolve the timeline's clipPlan, cutClip each, concat them.

   WHY RE-ENCODE every part (the load-bearing decision): a stream-copy trim can
   only cut on a keyframe, so `-ss` lands the part on the nearest prior I-frame and
   the seam is off by up to a GOP. Re-encoding with libx264 makes each part start
   at its own frame 0 → frame-accurate seams. And because every part is forced to
   ONE timebase / codec / WxH / fps / pix_fmt, the downstream concatVideos() can
   stream-copy them together (its fast path) and the result has a single coherent
   timeline. (§7.1.6: keep SOURCE fps, normalize to yuv420p so grade.tsx doesn't
   double-convert color space.) */

/** The normalized geometry every spine part is cut to: one WxH/fps for the whole
 *  spine so concat can stream-copy. Pulled from the item's probe, target fallback. */
type SpineFormat = { width: number; height: number; fps: number };

/** How to reframe ingested footage to a target aspect for social. `aspect` picks the
 *  output shape; `fill` picks how the (differently-shaped) source fills it:
 *    blur — source FIT to width, centered, over a blurred COVER copy (the IG/Reels look)
 *    crop — source COVER + center-crop the sides (fills the frame, loses edges)
 *    fit  — letterbox-pad with black bars (no crop, no fill) */
export type Reframe = { aspect?: "9:16" | "1:1" | "16:9" | "original"; fill?: "blur" | "crop" | "fit" };

/** Even, h264-friendly dimensions for a target aspect (1080 on the short side).
 *  Shares the one preset table in format.ts; "original" keeps the source shape. */
function aspectDims(aspect: NonNullable<Reframe["aspect"]>): { width: number; height: number } | null {
  return aspect === "original" ? null : ASPECT_PRESETS[aspect];
}

/** Resolve the spine's output geometry. With a `reframe.aspect` (e.g. "9:16" for
 *  social) the spine is cut to THAT shape; otherwise it keeps the source dimensions.
 *  fps is kept from the SOURCE (never coerced) so caption/word timing in source
 *  seconds stays aligned (§7.1.6). */
function spineFormat(item: ContentItem, reframe?: Reframe): SpineFormat {
  const v = item.source?.probe?.video;
  const fps = v?.fps && Number.isFinite(v.fps) && v.fps > 0 ? v.fps : 30;
  const target = reframe?.aspect && reframe.aspect !== "original" ? aspectDims(reframe.aspect) : null;
  if (target) return { ...target, fps };
  const width = v?.width && v.width > 0 ? v.width : 1080;
  const height = v?.height && v.height > 0 ? v.height : 1920;
  return { width, height, fps };
}

/** Build the ffmpeg -vf reframe chain for one fill mode at target WxH. */
function reframeVf(W: number, H: number, fill: NonNullable<Reframe["fill"]>): string {
  if (fill === "crop") return `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1`;
  if (fill === "blur")
    // split → a blurred COVER background + a FIT foreground, centered over it.
    return (
      `split=2[bg][fg];` +
      `[bg]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},gblur=sigma=24[bgb];` +
      `[fg]scale=${W}:${H}:force_original_aspect_ratio=decrease[fgs];` +
      `[bgb][fgs]overlay=(W-w)/2:(H-h)/2,setsar=1`
    );
  // fit: letterbox-pad (black bars), the original behaviour.
  return `scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2,setsar=1`;
}

/**
 * cutClip — ffmpeg-trim ONE source clip window to a normalized, silent part file.
 *
 * Cuts [inSec, outSec) of `src` and re-encodes (libx264/crf18/yuv420p) so the part
 * starts at frame 0 (frame-accurate seam) and shares ONE timebase/codec/WxH/fps
 * with every sibling part — the precondition for concatVideos()'s stream-copy path.
 *
 * Flags (the exact trim contract, roadmap §7.1.4 step 2):
 *   -ss inSec                  seek to the source in-point. INPUT-side (before -i):
 *                              fast, and frame-accurate from that point because we
 *                              re-encode below.
 *   -t (outSec - inSec)        length of the SOURCE window to read, in SOURCE
 *                              seconds. ALSO input-side (before -i) — this is
 *                              load-bearing: a window-bounded INPUT means setpts
 *                              retimes exactly (outSec-inSec) of source into a
 *                              (outSec-inSec)/speed output. (An output-side -t would
 *                              instead clamp the *played* length and break speed≠1.)
 *   -i src
 *   -an                        strip audio — the spine is silent (audio is N6.2)
 *   -vf "scale=W:H:force_original_aspect_ratio=decrease,pad=W:H:(ow-iw)/2:(oh-ih)/2,
 *        setsar=1[,setpts=PTS/speed]"
 *                              letterbox-fit into WxH (never distort), square pixels,
 *                              and — only when speed≠1 — retime by PTS/speed
 *   -r FPS                     force the one spine frame rate (CFR-normalize)
 *   -c:v libx264 -crf 18       visually-lossless re-encode
 *   -pix_fmt yuv420p           one pixel format (grade.tsx grades real pixels, no
 *                              color-space double-convert; §7.1.6)
 *
 * `speed`: >1 = faster (shorter), <1 = slower. setpts=PTS/speed scales presentation
 * timestamps; combined with `-t (outSec-inSec)` reading the source window, the
 * OUTPUT part is (outSec-inSec)/speed long — exactly the clip's timeline durationSec.
 * speed defaults to 1 (no setpts term → byte-identical to a plain trim).
 *
 * Returns the part path. Throws only on ffmpeg failure (the caller — renderSpine —
 * decides skip-vs-abort; a single bad part must not corrupt the spine silently).
 */
export function cutClip(
  src: string,
  inSec: number,
  outSec: number,
  opts: { width: number; height: number; fps: number; speed?: number; out: string; fill?: NonNullable<Reframe["fill"]> },
): string {
  const { width: W, height: H, fps: FPS, out } = opts;
  const speed = opts.speed && Number.isFinite(opts.speed) && opts.speed > 0 ? opts.speed : 1;
  const durSec = Math.max(0, outSec - inSec); // source-time window length

  // Reframe the source into the spine frame per the fill mode (default "fit" =
  // letterbox so we NEVER stretch). For 9:16 social, "blur" or "crop" fill the
  // frame instead of black-barring a 16:9 source. setsar=1 squares pixels so every
  // part declares identical SAR (concat is picky). setpts retimes only when speed≠1.
  let vf = reframeVf(W, H, opts.fill ?? "fit");
  if (speed !== 1) vf += `,setpts=PTS/${speed}`;

  // -ss + -t BOTH precede -i (input-side): bound the source READ window to
  // [inSec, inSec+durSec) so setpts=PTS/speed retimes exactly that window into a
  // durSec/speed output. Re-encoding makes the input-side seek frame-accurate.
  const args = [
    "-y",
    "-ss", String(inSec),
    "-t", String(durSec),
    "-i", src,
    "-vf", vf,
    "-an",
    "-r", String(FPS),
    "-c:v", "libx264",
    "-crf", "18",
    "-pix_fmt", "yuv420p",
    out,
  ];
  const r = spawnSync("ffmpeg", args, { encoding: "utf8", maxBuffer: 1 << 26 });
  if (r.status !== 0 || !existsSync(out)) {
    throw new Error(`cutClip failed (${src} ${inSec}->${outSec}): ${(r.stderr || "").slice(-400)}`);
  }
  return out;
}

/**
 * renderSpine — resolve a footage timeline → cut each clip → concat into ONE silent
 * spine mp4 of exact total length (roadmap §7.1.4 steps 1-3, N6.0).
 *
 * 1. loadItem(id) → resolveClipPlan() walks V1 in startSec order → ordered ClipPlan
 *    of {src,inSec,outSec,speed,durationSec}. For ingested clips src falls back to
 *    item.source.path inside resolveClipPlan, so a footage clip cuts the source.
 * 2. cutClip() each entry to a normalized part (one WxH/fps/codec from spineFormat).
 *    A part that fails to cut is SKIPPED (skip-not-throw, bridge discipline) so one
 *    bad window never aborts the whole spine — it just shortens it.
 * 3. concatVideos(id+"_spine", parts) — reused VERBATIM — stream-copies the parts
 *    (they're already one-timebase) into the spine. Part files are cleaned up after.
 *
 * Returns the spine mp4 path. Throws when there is nothing to render (no plan) or
 * the concat itself fails — the caller (render_spine_preview / a runner) surfaces
 * that, vs. the per-part skip which is non-fatal.
 */
export function renderSpine(id: string, log: (m: string) => void = () => {}, reframe?: Reframe): string {
  ensureDir(RENDERS_DIR);
  const item = loadItem(id);
  const plan = resolveClipPlan(item);
  if (!plan.length) throw new Error(`renderSpine: no clipPlan for ${id} (not a footage timeline, or empty V1)`);

  const fmt = spineFormat(item, reframe);
  log(`spine: ${plan.length} clip(s) @ ${fmt.width}x${fmt.height} ${fmt.fps}fps${reframe?.aspect && reframe.aspect !== "original" ? ` (${reframe.aspect} ${reframe.fill ?? "fit"})` : ""}`);

  const parts: string[] = [];
  plan.forEach((c: ClipPlanEntry, i: number) => {
    const part = join(RENDERS_DIR, `${id}_spine_part_${String(i).padStart(3, "0")}.mp4`);
    try {
      cutClip(c.src, c.inSec, c.outSec, { width: fmt.width, height: fmt.height, fps: fmt.fps, speed: c.speed, out: part, fill: reframe?.fill });
      parts.push(part);
      log(`spine: part ${i + 1}/${plan.length} cut (${c.inSec}->${c.outSec}s, x${c.speed})`);
    } catch (e) {
      // skip-not-throw: a single un-cuttable window shortens the spine, never kills it.
      log(`spine: SKIP part ${i + 1} — ${e instanceof Error ? e.message : String(e)}`);
    }
  });

  if (!parts.length) throw new Error(`renderSpine: every part failed to cut for ${id}`);

  const spine = concatVideos(`${id}_spine`, parts);
  // Clean up the part files regardless of concat outcome — they're scratch.
  for (const p of parts) { try { rmSync(p, { force: true }); } catch { /* ignore */ } }
  if (!spine) throw new Error(`renderSpine: concat failed for ${id}`);

  log(`spine: done → ${spine}`);
  return spine;
}

/* ─────────────────────────────────────────────────────────────────────────────
   N6.2 — renderHybrid: the full hybrid render end-to-end (roadmap §7.1.4 + N6.2).

   Wires the seven §7.1.4 steps into ONE entry point:
     1-3  renderSpine(id)  → the silent ffmpeg-cut footage spine (N6.0, above).
     4    symlink the spine into remotion/public/ + build HybridPostProps (the
          OffthreadVideo base path + footageGrade + caption WordCues + overlays).
     5    Remotion renders the "HybridPost" composition over the spine (one H.264
          pass, audio IGNORED) — reusing getBundle/selectComposition/renderMedia
          EXACTLY like renderPost.
     6    buildFootageAudio(id) → the mastered ffmpeg audio mix (per-clip extract →
          channel-strip filtergraph → adelay → amix → music duck → loudnorm).
     7    ffmpeg MUX video+audio, STREAM-COPYING the Remotion video (no re-encode).

   THE SAFE-SUPERSET ENTRY POINT: an item with NO `source` is a generated run, and
   HybridPost is a byte-identical superset of Post when `spineSrc` is absent — so
   renderHybrid just delegates to renderPost (one safe path for both run kinds).

   Fail-open + log each step. The spine/render/mux failures throw (a caller surfaces
   them); a missing audio mix falls back to a SILENT mux rather than aborting the
   whole render (a graded+captioned video with no bed still ships). ──────────────── */

const PROPS_DIR = join(RENDERS_DIR, "..", "props");

/** ffprobe a file's container duration in seconds (0 on failure). Local mirror of
 *  media.ts's private probeDuration — render.ts owns the spine length so it reads
 *  it here rather than reaching across modules. */
function probeDurationSec(file: string): number {
  const r = spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file], { encoding: "utf8" });
  return parseFloat((r.stdout || "0").trim()) || 0;
}

/** Round seconds → a frame index at fps. Uses ROUND (not floor) at the single
 *  caption-build boundary so word highlights don't desync from the cut (§7.1.6
 *  "sec↔frame drift"). */
const toFrame = (sec: number, fps: number) => Math.max(0, Math.round(sec * fps));

/** Symlink the cut spine into remotion/public/ so staticFile() resolves it inside
 *  the Remotion bundle, returning the PUBLIC-RELATIVE path HybridPostProps.spineSrc
 *  wants. Reuses the broll symlink-into-public discipline: symlink (never copy — a
 *  multi-GB spine must not be duplicated into the bundle, §7.1.6), and the
 *  EEXIST-safe rmSync-FIRST fix so a stale link/file from a prior render of this id
 *  never blocks the new one. */
function linkSpineIntoPublic(id: string, spineAbs: string): string {
  const rel = join("spine", `${id}.mp4`); // public-relative (staticFile() arg)
  const dst = join(PUBLIC, rel);
  mkdirSync(dirname(dst), { recursive: true });
  // rmSync-first so a stale file from a previous run never blocks the new one.
  try { rmSync(dst, { force: true }); } catch { /* ignore */ }
  // COPY (not symlink): Remotion's bundle() copies publicDir into the served bundle,
  // and a symlinked FILE inside it ends up unserved (404 at /public/spine/<id>.mp4).
  // A spine is ONE modest mp4 (not the 2GB broll dir), so a copy is cheap + robust.
  copyFileSync(spineAbs, dst);
  return rel;
}

/* CAPTIONS BEHIND THE SUBJECT (Odysser depth). Generate — or reuse a cached — PERSON
 *  ALPHA MATTE of the cut spine: a ProRes-4444 .mov where the speaker is opaque and
 *  the background transparent. Layered over [spine + behind-caption] in HybridPost,
 *  the speaker re-covers the caption while the background still shows it. Generated
 *  FROM the spine so geometry/timing align exactly. Cache keyed by spine mtime (a
 *  re-montage/reframe rewrites the spine → newer → regenerate). Returns the public-
 *  relative matte path, or null on any failure (caller falls back to front captions).
 *  Slow (~per-frame segmentation) but cached, so a re-render of the same cut is free. */
function ensurePersonMatte(id: string, spineAbs: string, log: (m: string) => void): string | null {
  try {
    const VENV_PY = join(HERE, "..", "..", "..", ".venv-music", "bin", "python");
    const SCRIPTS_DIR = join(HERE, "..", "scripts");
    if (!existsSync(VENV_PY)) { log("matte: no python venv — behind-captions fall back to front"); return null; }
    const matteAbs = join(RENDERS_DIR, `${id}_matte.webm`);
    // Cache by spine CONTENT (size), not mtime: renderSpine re-cuts an identical spine
    // every render (new mtime, same bytes), and the matte takes minutes to segment —
    // an mtime key would needlessly regenerate it each time. A size sidecar reuses the
    // matte whenever the cut is unchanged.
    const sidecar = join(RENDERS_DIR, `${id}_matte.json`);
    const spineSize = statSync(spineAbs).size;
    let fresh = false;
    if (existsSync(matteAbs) && existsSync(sidecar)) {
      try { fresh = (JSON.parse(readFileSync(sidecar, "utf8")) as { spineSize?: number }).spineSize === spineSize; } catch { fresh = false; }
    }
    if (!fresh) {
      log("matte: segmenting the speaker (person alpha matte)…");
      const r = spawnSync(VENV_PY, [join(SCRIPTS_DIR, "person-matte.py"), spineAbs, matteAbs], { encoding: "utf8", timeout: 1000 * 60 * 12 });
      if (r.status !== 0 || !existsSync(matteAbs)) { log(`matte: generation failed — ${(r.stderr || "").slice(-160)}`); return null; }
      try { writeFileSync(sidecar, JSON.stringify({ spineSize })); } catch { /* non-fatal */ }
    } else {
      log("matte: reusing cached person matte");
    }
    // copy into public for staticFile() (same COPY-into-public discipline as the spine).
    const rel = join("matte", `${id}.webm`);
    const dst = join(PUBLIC, rel);
    mkdirSync(dirname(dst), { recursive: true });
    try { rmSync(dst, { force: true }); } catch { /* ignore */ }
    copyFileSync(matteAbs, dst);
    return rel;
  } catch (e) {
    log(`matte: error — ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

/* M16 — copy ONE overlay asset (a b-roll cutaway video / an image) into public/
 *  so staticFile() resolves it for the HybridPost overlay layer. Same COPY-into-
 *  public + rmSync-first discipline as the spine; keyed by clip index so multiple
 *  overlays on one run don't collide. Returns the public-relative path (or null if
 *  the asset is missing/unreadable — the caller skips that overlay, fail-open). */
function linkAssetIntoPublic(id: string, assetAbs: string, idx: number): string | null {
  try {
    if (!existsSync(assetAbs)) return null;
    const ext = (assetAbs.match(/\.[a-z0-9]+$/i)?.[0] || ".mp4").toLowerCase();
    const rel = join("overlay", `${id}_${idx}${ext}`);
    const dst = join(PUBLIC, rel);
    mkdirSync(dirname(dst), { recursive: true });
    try { rmSync(dst, { force: true }); } catch { /* ignore */ }
    copyFileSync(assetAbs, dst);
    return rel;
  } catch {
    return null;
  }
}

/* M16 — build the OVERLAY layer (real overlapping multi-track picture) from the
 *  timeline: every clip on an OVERLAY track, or a VIDEO clip NOT on the V1 footage
 *  spine (a B-roll cutaway), that has a usable local asset becomes a positioned
 *  <Sequence> drawn OVER the footage for its [startSec,end) window. Captions/text
 *  are handled by the caption path, so we only take asset-backed (video/image)
 *  clips here. FAIL-OPEN: a missing asset → that overlay is skipped, never thrown.
 *  Empty result ⇒ HybridPost renders no overlay layer (byte-identical to today). */
function buildOverlayClips(id: string, item: ContentItem, fps: number): unknown[] {
  const tracks = item.timeline?.tracks ?? [];
  const out: unknown[] = [];
  let idx = 0;
  for (const track of tracks) {
    const isOverlayTrack = track.kind === "overlay" || (track.kind === "video" && track.id !== "V1");
    if (!isOverlayTrack) continue;
    for (const clip of track.clips ?? []) {
      if (clip.enabled === false || !clip.src) continue;
      // Resolve the asset: an absolute path, else a public-relative one (resolved
      // b-roll lives under remotion/public/). A bare query / unresolved broll has no
      // file on disk → linkAssetIntoPublic returns null and we skip it (fail-open).
      const abs = clip.src.startsWith("/") ? clip.src : join(PUBLIC, clip.src);
      const rel = linkAssetIntoPublic(id, abs, idx++);
      if (!rel) continue;
      const type: "video" | "image" = /\.(png|jpe?g|webp|gif)$/i.test(rel) ? "image" : "video";
      const startSec = clip.startSec ?? 0;
      out.push({
        kind: "broll",
        fromF: toFrame(startSec, fps),
        toF: toFrame(startSec + (clip.durationSec ?? 0), fps),
        asset: { src: rel, type },
      });
    }
  }
  return out;
}

/** Map a footage caption track's word payload (SOURCE seconds, Clip.words) into the
 *  render's WordCue[] (FRAMES) — this is the bridge that lights up N4b: an ingested
 *  transcript's auto-subtitle track renders through Post's Karaoke engine. Each
 *  caption clip's `words` are clip-local? No — N3a seeds them in SOURCE seconds on
 *  the assembled cut, so we map sec→frame directly with ROUND (§7.1.6). A clip with
 *  no `words` contributes nothing (a phrase/line clip is handled via subtitles). */
/** Find where a SOURCE second `t` plays on the TIMELINE given the footage video
 *  clips (each plays source [inSec,outSec) at timeline [startSec,…] at `speed`).
 *  Returns the timeline second, or null when `t` was CUT OUT (no clip plays it).
 *  For a 1:1 seed this is the identity; after a montage/trim it re-anchors a
 *  caption to wherever its footage now sits — so words ALWAYS follow the cut. */
function sourceToTimelineSec(t: number, videoClips: { inSec?: number; outSec?: number; startSec?: number; durationSec?: number; speed?: number }[]): number | null {
  for (const c of videoClips) {
    const inSec = c.inSec ?? 0;
    const outSec = c.outSec ?? inSec + (c.durationSec ?? 0) * (c.speed ?? 1);
    if (t >= inSec && t < outSec) return (c.startSec ?? 0) + (t - inSec) / (c.speed ?? 1);
  }
  return null;
}

function captionWordsToWordCues(timeline: Timeline, fps: number, videoClips?: { inSec?: number; outSec?: number; startSec?: number; durationSec?: number; speed?: number }[]): WordCue[] {
  const capTrack = timeline.tracks.find((t) => t.kind === "text");
  if (!capTrack) return [];
  const cues: WordCue[] = [];
  for (const clip of capTrack.clips ?? []) {
    if (clip.enabled === false) continue;
    for (const w of clip.words ?? []) {
      if (videoClips) {
        // Re-anchor source-time captions onto the actual footage timeline. A word
        // whose source moment was cut out is dropped; otherwise it rides its clip.
        const at = sourceToTimelineSec(w.fromSec, videoClips);
        if (at == null) continue;
        cues.push({ word: w.word, fromF: toFrame(at, fps), toF: toFrame(at + Math.max(0.08, w.toSec - w.fromSec), fps) });
      } else {
        cues.push({ word: w.word, fromF: toFrame(w.fromSec, fps), toF: toFrame(w.toSec, fps) });
      }
    }
  }
  return cues.sort((a, b) => a.fromF - b.fromF);
}

/** CAPTION STYLE CHOREOGRAPHY → per-line overlay clips. When the caption track has
 *  been styled (creative/caption-style.ts annotates each clip with `captionStyle`),
 *  every line renders as its OWN positioned Karaoke overlay carrying that line's
 *  preset/position/size/accent (and depth) — instead of one global single-style
 *  Karaoke for the whole video. Words are re-anchored onto the cut timeline exactly
 *  like captionWordsToWordCues. Returns [] when no clip is styled (caller keeps the
 *  legacy single-style global path). */
function buildStyledCaptionClips(
  timeline: Timeline,
  fps: number,
  videoClips: { inSec?: number; outSec?: number; startSec?: number; durationSec?: number; speed?: number }[] | undefined,
  base: NonNullable<Mix["subtitles"]> | undefined,
): { fromF: number; toF: number; words: WordCue[]; subtitleSettings: Record<string, unknown>; preset?: string; depth?: "front" | "behind" }[] {
  const capTrack = timeline.tracks.find((t) => t.kind === "text");
  if (!capTrack) return [];
  const styledAny = (capTrack.clips ?? []).some((c) => (c as { captionStyle?: unknown }).captionStyle);
  if (!styledAny) return [];
  const out: { fromF: number; toF: number; words: WordCue[]; subtitleSettings: Record<string, unknown>; preset?: string; depth?: "front" | "behind" }[] = [];
  for (const clip of capTrack.clips ?? []) {
    if (clip.enabled === false) continue;
    const st = (clip as { captionStyle?: { preset?: string; position?: string; fontScale?: number; highlightColor?: string; depth?: "front" | "behind" } }).captionStyle ?? {};
    // Re-anchor this line's words onto the cut timeline (drop words cut away).
    const cues: WordCue[] = [];
    for (const w of clip.words ?? []) {
      const at = videoClips ? sourceToTimelineSec(w.fromSec, videoClips) : w.fromSec;
      if (at == null) continue;
      cues.push({ word: w.word, fromF: toFrame(at, fps), toF: toFrame(at + Math.max(0.08, w.toSec - w.fromSec), fps) });
    }
    if (!cues.length) continue;
    cues.sort((a, b) => a.fromF - b.fromF);
    const fromF = cues[0].fromF;
    const toF = Math.max(fromF + 1, cues[cues.length - 1].toF);
    // The clip is placed via <Sequence from={fromF}>, which re-bases the inner
    // frame to 0 — so the Karaoke word cues must be RELATIVE to the clip start,
    // not absolute timeline frames (else no word is ever "active" off-screen).
    for (const c of cues) { c.fromF -= fromF; c.toF -= fromF; }
    // Per-line settings = the global subtitle style with this line's overrides on top.
    const subtitleSettings: Record<string, unknown> = {
      ...(base ?? {}),
      ...(st.position ? { position: st.position } : {}),
      ...(st.fontScale != null ? { fontScale: st.fontScale } : {}),
      ...(st.highlightColor ? { highlightColor: st.highlightColor } : {}),
      ...(st.preset ? { preset: st.preset } : {}),
    };
    out.push({ fromF, toF, words: cues, subtitleSettings, preset: st.preset ?? base?.preset, depth: st.depth ?? "front" });
  }
  return out.sort((a, b) => a.fromF - b.fromF);
}

/** Line-subtitle fallback cues from a caption track's clips that carry NO per-word
 *  timing — each such clip becomes one SubtitleCue spanning its [startSec,end)
 *  window (source seconds → frames), its captionText wrapped into ≤2 lines. Keeps a
 *  phrase-style ingested caption renderable through SubtitleLayer when Whisper words
 *  are absent. */
function captionLinesToSubtitleCues(timeline: Timeline, fps: number): SubtitleCue[] {
  const capTrack = timeline.tracks.find((t) => t.kind === "text");
  if (!capTrack) return [];
  const cues: SubtitleCue[] = [];
  for (const clip of capTrack.clips ?? []) {
    if (clip.enabled === false || (clip.words && clip.words.length)) continue; // worded clips → Karaoke
    const text = (clip.captionText ?? "").trim();
    if (!text) continue;
    const startSec = clip.startSec ?? 0;
    const endSec = startSec + (clip.durationSec ?? 0);
    // crude 2-line wrap at ~34 chars (mirrors media.ts wrap())
    const words = text.split(/\s+/);
    const lines: string[] = [];
    let cur = "";
    for (const wd of words) {
      if ((cur + " " + wd).trim().length > 34 && cur) { lines.push(cur.trim()); cur = wd; }
      else cur = (cur + " " + wd).trim();
    }
    if (cur) lines.push(cur.trim());
    cues.push({ fromF: toFrame(startSec, fps), toF: toFrame(endSec, fps), lines: lines.slice(0, 2) });
  }
  return cues;
}

/** The HybridPostProps the Remotion "HybridPost" composition consumes (kept as a
 *  loose object — the renderMedia boundary takes Record<string,unknown>, mirroring
 *  renderPost). Built purely from the item: probe-derived geometry, the footage
 *  grade, the caption track's WordCues, and (N6.3, later) overlay clips. */
type HybridProps = {
  spineSrc?: string;
  spineWidth: number;
  spineHeight: number;
  fps: number;
  totalFrames: number;
  footageGrade?: ColorGrade;
  words?: WordCue[];
  subtitles?: SubtitleCue[];
  subtitleSettings?: NonNullable<Mix["subtitles"]>;
  overlayClips?: unknown[];
  // P3 — emphasis punch-in zoom windows (timeline frames); the SOLE footage zoom.
  zoomWindows?: ZoomWindow[];
  // Person alpha matte (public-relative ProRes 4444) for behind-subject captions.
  matteSrc?: string;
  themeName?: string;
  brandAccent?: string;
  postProps?: PostProps;
};

/**
 * buildFootageAudio — the ffmpeg AUDIO mix for a footage render (roadmap §7.1.4
 * step 6). Mirrors today's shorts division of labour (ffmpeg owns mastered audio)
 * but sources the audio from the REAL footage instead of a synth voice stem:
 *
 *   1. Per AUDIO clip on the timeline: ffmpeg-EXTRACT its source window
 *      (`-ss inSec -t (durationSec*speed) -i source` → a wav part), so the audio is
 *      cut on exactly the same windows the video spine was.
 *   2. Apply that clip's TRACK chain via buildAudioFiltergraph (M7) — the same
 *      gate→denoise→eq→deess→comp→gain channel strip the generated mix uses.
 *   3. `adelay` the part to its `startSec` on the assembled timeline, then `amix`
 *      every delayed part into one stereo bus.
 *   4. If the run carries a music bed (item.mix music track / a resolved music
 *      file), lay it under with a WORD-ACCURATE duck (reuse addMusicBed/duckMusic).
 *   5. masterAudio to mix.loudnessTarget (-14 default).
 *
 * Returns the absolute path of the mixed audio file, or "" when there's nothing to
 * mix (no audio clips AND no bed) so the caller mux can ship a silent video.
 *
 * §7.1.6 caveat enforced: SOURCE audio is production audio (voice+bed already
 * mixed), NOT a clean synth stem — so a clip with speed≠1 would need an atempo to
 * keep A/V in sync, which v1 does NOT do; we GATE speed≠1 audio clips OUT of the
 * mix (the silent spine still plays; the bed/captions carry) rather than drift.
 */
export function buildFootageAudio(id: string, log: (m: string) => void = () => {}): string {
  ensureDir(RENDERS_DIR);
  const item = loadItem(id);
  const timeline = item.timeline;
  const sourcePath = item.source?.path ?? item.videoPath ?? "";
  const mix = item.mix;

  // Collect the enabled AUDIO clips across all audio tracks, in startSec order.
  const audioClips: { clip: Clip; trackId: string }[] = [];
  for (const tr of timeline?.tracks ?? []) {
    if (tr.kind !== "audio") continue;
    for (const c of tr.clips ?? []) {
      if (c.enabled === false) continue;
      audioClips.push({ clip: c, trackId: tr.id.startsWith("A_") ? tr.id.slice(2) : tr.id });
    }
  }

  const parts: string[] = []; // [filtered+delayed] labels for amix
  const inputs: string[] = []; // ffmpeg -i args
  const filters: string[] = [];
  let inIdx = 0;
  for (const { clip, trackId } of audioClips) {
    const speed = clip.speed && Number.isFinite(clip.speed) ? clip.speed : 1;
    // §7.1.6: gate speed≠1 source-audio clips out of v1 (no atempo yet → A/V drift).
    if (Math.abs(speed - 1) > 1e-3) { log(`audio: SKIP clip ${clip.id} (speed=${speed} — atempo not in v1)`); continue; }
    const src = clip.src || sourcePath;
    if (!src || !existsSync(src)) { log(`audio: SKIP clip ${clip.id} (no source ${src})`); continue; }
    const inSec = Math.max(0, clip.inSec ?? 0);
    const winSec = Math.max(0, clip.durationSec ?? 0); // speed==1 → window == duration
    if (winSec <= 0) continue;

    // 1+2. extract the source window → a wav, applying the track's M7 channel strip.
    //      No chain on the track → buildAudioFiltergraph returns "" → a clean extract.
    const part = join(RENDERS_DIR, `${id}_aud_${String(inIdx).padStart(3, "0")}.wav`);
    const chain = buildAudioFiltergraph(mix?.tracks?.find((t) => t.id === trackId), { durSec: winSec }).af;
    const af = chain ? ["-af", chain] : [];
    const r = spawnSync(
      "ffmpeg",
      ["-y", "-ss", String(inSec), "-t", String(winSec), "-i", src, "-vn", "-ac", "2", "-ar", "44100", ...af, part],
      { encoding: "utf8" },
    );
    if (r.status !== 0 || !existsSync(part)) { log(`audio: extract failed for ${clip.id} — skipped`); continue; }

    // 3. delay the part to its timeline position + register it for the amix.
    const delayMs = Math.round((clip.startSec ?? 0) * 1000);
    inputs.push("-i", part);
    filters.push(`[${inIdx}:a]adelay=${delayMs}|${delayMs}[d${inIdx}]`);
    parts.push(`[d${inIdx}]`);
    inIdx++;
  }

  let mixed = "";
  if (parts.length) {
    mixed = join(RENDERS_DIR, `${id}_audio.wav`);
    const filter = `${filters.join(";")};${parts.join("")}amix=inputs=${parts.length}:normalize=0[a]`;
    const r = spawnSync("ffmpeg", ["-y", ...inputs, "-filter_complex", filter, "-map", "[a]", mixed], { encoding: "utf8" });
    // clean up the per-clip parts regardless of the amix outcome — they're scratch.
    for (let i = 0; i < inIdx; i++) { try { rmSync(join(RENDERS_DIR, `${id}_aud_${String(i).padStart(3, "0")}.wav`), { force: true }); } catch { /* ignore */ } }
    if (r.status !== 0 || !existsSync(mixed)) { log(`audio: amix failed — no footage audio`); mixed = ""; }
    else log(`audio: mixed ${parts.length} clip(s)`);
  } else {
    log("audio: no source-audio clips to mix");
  }

  // 4. Music bed + word-accurate duck. addMusicBed/duckMusic operate on the
  //    remotion/public dir + a baked video, so we reuse them by treating the mixed
  //    wav as the "voice" and a resolved music file as the bed: duck the bed under
  //    the footage words, amix, then loudnorm. Reuse duckMusic for the keyed duck,
  //    then a plain amix here (we're at the audio-only layer, not a baked mp4).
  const musicSrc = (item as { musicSrc?: string }).musicSrc; // resolved bed (public-relative), when a run carried one
  if (musicSrc) {
    const words = timeline ? captionWordsToWordCues(timeline, timeline.fps ?? item.source?.probe?.video?.fps ?? 30) : [];
    // duckMusic returns a public-relative ducked bed (or the input unchanged on failure).
    const fps = timeline?.fps ?? item.source?.probe?.video?.fps ?? 30;
    const duckedRel = mixed
      ? duckMusicAgainst(id, musicSrc, mixed, { mix, words, fps })
      : musicSrc;
    const bedAbs = join(PUBLIC, duckedRel);
    if (existsSync(bedAbs)) {
      const withBed = join(RENDERS_DIR, `${id}_audio_bed.wav`);
      if (mixed && existsSync(mixed)) {
        // amix dropout=longest so the bed (often longer than the cut) doesn't get
        // truncated to the footage and the whole bed plays at full level (default
        // amix weights both inputs 1/N and ends at the SHORTEST → the bed gets halved
        // AND cut). duration=first keeps the bus to the footage length.
        const r = spawnSync("ffmpeg", ["-y", "-i", mixed, "-i", bedAbs, "-filter_complex", "[0:a][1:a]amix=inputs=2:duration=first:normalize=0[a]", "-map", "[a]", withBed], { encoding: "utf8" });
        if (r.status === 0 && existsSync(withBed)) { try { rmSync(mixed, { force: true }); } catch { /* ignore */ } mixed = withBed; log("audio: music bed laid under footage"); }
        else log(`audio: music bed amix FAILED — ${(r.stderr || "").slice(-200)}`);
      } else {
        // no footage audio at all → the bed IS the track.
        const r = spawnSync("ffmpeg", ["-y", "-i", bedAbs, "-ac", "2", "-ar", "44100", withBed], { encoding: "utf8" });
        if (r.status === 0 && existsSync(withBed)) { mixed = withBed; log("audio: music bed only (no source audio)"); }
      }
    }
  }

  if (!mixed) return "";
  // 5. master the bus to the platform loudness target (-14 default). masterAudio
  //    operates on an mp4 (-c:v copy); the audio bus is a wav, so apply the same
  //    loudnorm chain directly here to keep one mastering definition.
  const I = typeof mix?.loudnessTarget === "number" && Number.isFinite(mix.loudnessTarget) ? mix.loudnessTarget : -14;
  const mastered = mixed.replace(/\.wav$/, "_m.wav");
  const r = spawnSync("ffmpeg", ["-y", "-i", mixed, "-af", `loudnorm=I=${I}:TP=-1.5:LRA=11,afade=t=in:st=0:d=0.25`, mastered], { encoding: "utf8" });
  if (r.status === 0 && existsSync(mastered)) { try { rmSync(mixed, { force: true }); } catch { /* ignore */ } mixed = mastered; log(`audio: mastered to ${I} LUFS`); }
  return mixed;
}

/** Duck a music bed under the footage audio bus using the SAME keyed-duck machinery
 *  duckMusic uses (buildDuckSpans-driven volume envelope), so footage ducking is
 *  word-accurate and identical to shorts/long-form. duckMusic expects its inputs in
 *  remotion/public; the footage bus lives in RENDERS_DIR, so we hand it a temporary
 *  public-relative copy and return the ducked bed's public-relative path. */
function duckMusicAgainst(id: string, musicRel: string, busAbs: string, opts: { mix?: Mix; words?: WordCue[]; fps?: number }): string {
  // copy the bus into public as the "voice" duckMusic keys against.
  const voiceRel = `${id}_footbus.wav`;
  const voiceAbs = join(PUBLIC, voiceRel);
  try {
    const r = spawnSync("ffmpeg", ["-y", "-i", busAbs, "-ac", "2", "-ar", "44100", voiceAbs], { encoding: "utf8" });
    if (r.status !== 0 || !existsSync(voiceAbs)) return musicRel;
    const ducked = duckMusic(id, musicRel, voiceRel, opts);
    return ducked;
  } catch {
    return musicRel;
  } finally {
    try { rmSync(voiceAbs, { force: true }); } catch { /* ignore */ }
  }
}

/**
 * renderHybrid — the single safe entry point for rendering a run (roadmap §7.1.4).
 *
 * Footage run (item.source present): cut spine → symlink into public → build
 * HybridPostProps → render "HybridPost" (video only) → build the footage audio mix
 * → stream-copy mux. Generated run (no source): delegate to renderPost (HybridPost
 * is a byte-identical superset when spineSrc is absent), so one call renders either.
 *
 * `opts.postProps` carries the PostProps for a generated run (renderPost needs the
 * full props, which are built upstream); absent, we fall back to the persisted
 * render-props sidecar so a re-render of a known run still works.
 */
export async function renderHybrid(
  id: string,
  opts: { postProps?: PostProps; preview?: boolean; reframe?: Reframe; log?: (m: string) => void } = {},
): Promise<string> {
  const log = opts.log ?? (() => {});
  const item = loadItem(id);

  // ── GENERATED-ITEM DELEGATION ───────────────────────────────────────────────
  // No source ⇒ a generated run. HybridPost(spineSrc absent) === Post, so render
  // the normal Post path. This makes renderHybrid one safe entry point for both.
  if (!item.source) {
    let props = opts.postProps;
    if (!props) {
      // fall back to the persisted render-props sidecar (renderPost writes it).
      try { props = JSON.parse(readFileSync(join(PROPS_DIR, `${id}.json`), "utf8")) as PostProps; } catch { /* none */ }
    }
    if (!props) throw new Error(`renderHybrid: ${id} has no source and no PostProps to delegate to renderPost`);
    log("hybrid: no source — delegating to renderPost (Post superset)");
    return renderPost(id, props, { preview: opts.preview, log });
  }

  ensureDir(RENDERS_DIR);

  // P6 — PACING GOVERNOR + HOOK (§3/§6): a PURE timeline post-pass that guarantees
  // the visual-change cadence + a premium first-3s. Runs BEFORE everything else reads
  // the timeline (before renderSpine and before footageClips/zoomWindows are computed)
  // so the governor-written Clip.zoom keyframes are picked up by P3's flatten in the
  // same render. Idempotent (strip-then-recompute by id prefix) so a re-render is
  // byte-stable. Gated on a footage timeline + opt-out via SOCHELI_NO_GOVERN=1.
  if (item.timeline?.seededFrom === "footage" && process.env.SOCHELI_NO_GOVERN !== "1") {
    try {
      const { applyHook, governPacing } = await import("./creative/pacing-governor.ts");
      applyHook(id, log);
      governPacing(id, log);
      // re-load so the post-pass mutations are visible to the rest of renderHybrid.
      Object.assign(item, loadItem(id));
    } catch (e) {
      log(`govern: skipped — ${e instanceof Error ? e.message : e}`);
    }
  }

  // 1-3. the silent footage spine (N6.0) — reframed to the target aspect if asked.
  const reframe = opts.reframe;
  if (reframe?.aspect && reframe.aspect !== "original") log(`hybrid: reframing → ${reframe.aspect} (${reframe.fill ?? "fit"})`);
  log("hybrid: cutting footage spine…");
  const spineAbs = renderSpine(id, log, reframe);

  // 4. symlink the spine into public + build HybridPostProps. Geometry comes from
  //    spineFormat (the reframed target dims) so the composition matches the spine.
  const spineRel = linkSpineIntoPublic(id, spineAbs);
  const fmt = spineFormat(item, reframe);
  const fps = fmt.fps;
  const width = fmt.width;
  const height = fmt.height;
  const spineDurSec = probeDurationSec(spineAbs);
  const totalFrames = Math.max(1, toFrame(spineDurSec, fps));
  // The footage VIDEO clips (the cut spine) — used to re-anchor source-time
  // captions onto the timeline so they follow a montage/trim (not desync).
  const footageClips = (item.timeline?.tracks.find((t) => t.kind === "video" && t.id === "V1")?.clips ?? item.timeline?.tracks.find((t) => t.kind === "video")?.clips ?? []) as { inSec?: number; outSec?: number; startSec?: number; durationSec?: number; speed?: number }[];
  const words = item.timeline ? captionWordsToWordCues(item.timeline, fps, footageClips) : [];
  const subtitles = item.timeline ? captionLinesToSubtitleCues(item.timeline, fps) : [];
  // Caption choreography: if the caption track is styled, each line becomes its own
  // positioned/styled Karaoke overlay and the single global-style caption path is
  // suppressed (so we don't double-draw). Else keep the legacy global `words`.
  const styledCaptions = item.timeline ? buildStyledCaptionClips(item.timeline, fps, footageClips, item.mix?.subtitles) : [];
  if (styledCaptions.length) log(`hybrid: ${styledCaptions.length} choreographed caption line(s)`);
  // Behind-subject captions: if any styled line asks to sit behind the speaker,
  // generate (or reuse) a person alpha matte from the spine. If it can't be made,
  // those lines fall back to FRONT so a caption is never lost over nothing.
  const wantsBehind = styledCaptions.some((c) => c.depth === "behind");
  let matteSrc: string | undefined;
  if (wantsBehind) {
    const m = ensurePersonMatte(id, spineAbs, log);
    if (m) matteSrc = m;
    else styledCaptions.forEach((c) => { if (c.depth === "behind") c.depth = "front"; });
  }
  const overlayClips = [...buildOverlayClips(id, item, fps), ...styledCaptions.map((c) => ({ kind: "caption" as const, fromF: c.fromF, toF: c.toF, words: c.words, subtitleSettings: c.subtitleSettings, preset: c.preset, depth: c.depth }))];

  // P3 — emphasis punch-ins (roadmap §3 Conflict A): the ONE zoom representation.
  // Merge TWO producers into a single ZoomWindow[] that FootageSpine animates:
  //   (a) the AUTO RMS path — computeZoomWindows probes per-word vocal energy;
  //   (b) the discrete Clip.zoom keyframes (clip-relative frames) written by the
  //       governor (P6) / beat-sync, flattened to TIMELINE-frame windows here.
  // Governor and punch-ins never both ANIMATE — they both FEED this one array.
  const auto = computeZoomWindows(item, fps, footageClips, (item.mix as { zoomPunch?: Parameters<typeof computeZoomWindows>[3] } | undefined)?.zoomPunch);
  const fromClips: ZoomWindow[] = footageClips.flatMap((c) =>
    (((c as { startSec?: number; zoom?: { atFrame: number; scale: number; holdF?: number; rampInF?: number; rampOutF?: number }[] }).zoom) ?? []).map((z) => {
      const peakF = toFrame(c.startSec ?? 0, fps) + z.atFrame;
      const rampInF = z.rampInF ?? 12, rampOutF = z.rampOutF ?? 14, holdF = z.holdF ?? 6;
      return { startF: Math.max(0, peakF - rampInF), peakF, holdF, endF: peakF + holdF + rampOutF, scale: z.scale, originX: 0.5, originY: 0.42 };
    }),
  );
  // De-overlap the merged set: keep the higher-scale window on any collision.
  const zoomWindows: ZoomWindow[] = (() => {
    const merged = [...auto, ...fromClips].sort((a, b) => a.startF - b.startF);
    const out: ZoomWindow[] = [];
    for (const w of merged) {
      const prev = out[out.length - 1];
      if (prev && w.startF < prev.endF) { if (w.scale > prev.scale) out[out.length - 1] = w; continue; }
      out.push(w);
    }
    return out;
  })();
  if (zoomWindows.length) log(`hybrid: ${zoomWindows.length} emphasis punch-in(s)`);

  const props: HybridProps = {
    spineSrc: spineRel,
    spineWidth: width,
    spineHeight: height,
    fps,
    totalFrames,
    // footage gets the storyboard master grade (GlobalGrade is structurally a
    // ColorGrade); absent ⇒ HybridPost renders the spine ungraded.
    footageGrade: (item.storyboard as { grade?: ColorGrade } | undefined)?.grade,
    // styled caption lines own the captions ⇒ drop the global single-style path.
    words: styledCaptions.length ? undefined : words.length ? words : undefined,
    subtitles: styledCaptions.length ? undefined : subtitles.length ? subtitles : undefined,
    subtitleSettings: item.mix?.subtitles,
    overlayClips, // M16 b-roll/overlay tracks + choreographed caption lines
    zoomWindows, // P3 emphasis punch-ins (auto RMS + flattened Clip.zoom) — the ONE zoom
    matteSrc, // person alpha matte for behind-subject captions (undefined ⇒ none)
    themeName: (item.storyboard as { theme?: string } | undefined)?.theme,
    brandAccent: (item as { brandAccent?: string }).brandAccent,
  };

  // persist the props sidecar (parity with renderPost — dashboard live-preview).
  try { mkdirSync(PROPS_DIR, { recursive: true }); writeFileSync(join(PROPS_DIR, `${id}.json`), JSON.stringify(props)); } catch { /* non-fatal */ }

  // 5. render the HybridPost composition (video only — audio ignored).
  // resetBundle FIRST: the spine just changed in public/, and a bundle cached from a
  // prior render in this process would serve a stale (or absent) spine → 404. Forcing
  // a fresh bundle guarantees the new spine is in the served publicDir.
  resetBundle();
  log(`hybrid: rendering HybridPost — ${totalFrames} frames @ ${width}x${height} ${fps}fps`);
  const serveUrl = await getBundle((p) => p > 0.99 && log("bundle ready"));
  const composition = await selectComposition({
    serveUrl,
    id: "HybridPost",
    inputProps: props as unknown as Record<string, unknown>,
    browserExecutable: BROWSER,
  });
  const videoOnly = join(RENDERS_DIR, `${id}_hybrid_v.mp4`);
  await renderMedia({
    composition,
    serveUrl,
    codec: "h264",
    outputLocation: videoOnly,
    inputProps: props as unknown as Record<string, unknown>,
    browserExecutable: BROWSER,
    crf: opts.preview ? 28 : Number(process.env.SOCHELI_RENDER_CRF || 21),
    concurrency: Number(process.env.SOCHELI_RENDER_CONCURRENCY || 3),
    timeoutInMilliseconds: 90000,
    offthreadVideoCacheSizeInBytes: 512 * 1024 * 1024,
    chromiumOptions: { gl: "angle" },
  });

  // 6. the ffmpeg audio mix (extract → filtergraph → adelay → amix → duck → master).
  log("hybrid: building footage audio mix…");
  const audio = buildFootageAudio(id, log);

  // 7. MUX video + audio, STREAM-COPYING the Remotion video (no re-encode). No
  //    audio ⇒ keep the video-only file as the final (a silent graded+captioned cut).
  const finalOut = join(RENDERS_DIR, `${id}${opts.preview ? "_preview" : ""}.mp4`);
  if (audio && existsSync(audio)) {
    const r = spawnSync(
      "ffmpeg",
      ["-y", "-i", videoOnly, "-i", audio, "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy", "-c:a", "aac", "-b:a", "256k", "-shortest", "-movflags", "+faststart", finalOut],
      { encoding: "utf8" },
    );
    if (r.status !== 0 || !existsSync(finalOut)) {
      log(`hybrid: mux failed — shipping the silent video (${(r.stderr || "").slice(-200)})`);
      renameSync(videoOnly, finalOut);
    } else {
      try { rmSync(videoOnly, { force: true }); rmSync(audio, { force: true }); } catch { /* ignore */ }
      log("hybrid: muxed video + mastered audio");
    }
  } else {
    log("hybrid: no audio mix — shipping the silent graded video");
    renameSync(videoOnly, finalOut);
  }

  // clean up the public spine symlink (scratch — the final mp4 stands alone).
  try { rmSync(join(PUBLIC, spineRel), { force: true }); } catch { /* ignore */ }

  item.videoPath = finalOut;
  saveItem(item);
  log(`hybrid: done → ${finalOut}`);
  return finalOut;
}

/* Lay ONE continuous music bed under a finished (voice-baked) video: duck the
   music under the voice, mix, and master to -14 LUFS. musicSrc is relative to
   the remotion public dir (as returned by ensureMusic). */
export function addMusicBed(videoPath: string, musicSrc: string, log: (m: string) => void = () => {}, mix?: Mix): string {
  const music = join(PUBLIC, musicSrc);
  if (!existsSync(music)) return videoPath;
  const out = videoPath.replace(/\.mp4$/, "_scored.mp4");
  // M7: integrated target from the mix (platform-derived) when set, else the historical
  // -14 LUFS → byte-identical when no `mix`/`loudnessTarget` is passed.
  const I = typeof mix?.loudnessTarget === "number" && Number.isFinite(mix.loudnessTarget) ? mix.loudnessTarget : -14;
  // M7: optionally bake the music track's schema EQ/comp chain into the bed before the
  // duck (mirrors duckMusic on the shorts path). Empty when no chain → identical filter.
  const musicChain = buildAudioFiltergraph(mix?.tracks?.find((t) => t.id === "music")).af;
  const preChain = musicChain ? `,${musicChain}` : "";
  const filter =
    `[1:a]aresample=44100,volume=0.62${preChain}[m];` +
    "[m][0:a]sidechaincompress=threshold=0.06:ratio=4:attack=20:release=260:makeup=2.5[md];" +
    `[0:a][md]amix=inputs=2:normalize=0,loudnorm=I=${I}:TP=-1.5:LRA=11[a]`;
  const r = spawnSync(
    "ffmpeg",
    ["-y", "-i", videoPath, "-i", music, "-filter_complex", filter, "-map", "0:v", "-map", "[a]", "-c:v", "copy", "-c:a", "aac", "-b:a", "256k", "-movflags", "+faststart", out],
    { encoding: "utf8" },
  );
  if (r.status === 0 && existsSync(out)) {
    renameSync(out, videoPath);
    log("scored + mastered to -14 LUFS");
  }
  return videoPath;
}

/* ─── Carousel slides ──────────────────────────────────────────────────────
   Render each slide of a CarouselSpec as a PNG still using the CarouselSlide
   composition (StaticPost with slideNumber/totalSlides props). Returns the
   array of absolute PNG paths in slide order. */
export async function renderCarouselSlides(
  id: string,
  carousel: CarouselSpec,
  channelAccent: string,
  opts: {
    handle?: string;
    logo?: string;
    themeName?: string;
    mood?: string;
    log?: (m: string) => void;
  } = {},
): Promise<string[]> {
  const log = opts.log ?? (() => {});
  ensureDir(RENDERS_DIR);
  log("bundling renderer for carousel slides…");
  const serveUrl = await getBundle((p) => p > 0.99 && log("bundle ready"));

  // Dimensions from aspect ratio.
  const isPortrait = carousel.aspect === "4:5";
  const width = 1080;
  const height = isPortrait ? 1350 : 1080;

  const total = carousel.slides.length;
  const paths: string[] = [];

  for (let i = 0; i < total; i++) {
    const slide = carousel.slides[i];
    // Resolved background: either from a prior generateImage pass (stored on
    // the slide as a transient _resolvedBg field) or the slide's own bgColor.
    const resolvedBg = (slide as Record<string, unknown>)._resolvedBg as string | undefined;

    const inputProps = {
      headline: slide.headline,
      body: slide.body,
      eyebrow: slide.eyebrow,
      layout: slide.layout ?? "highlight_bar",
      bgImageSrc: resolvedBg,
      bgColor: slide.bgColor,
      accent: slide.accent ?? channelAccent,
      themeName: opts.themeName ?? "concept",
      mood: opts.mood,
      handle: opts.handle,
      logo: opts.logo,
      width,
      height,
      slideNumber: i + 1,
      totalSlides: total,
      isCover: slide.isCover ?? false,
      isCta: slide.isCta ?? false,
    };

    const out = join(RENDERS_DIR, `${id}_slide_${String(i + 1).padStart(2, "0")}.png`);
    log(`rendering slide ${i + 1}/${total} (${slide.id})…`);

    const composition = await selectComposition({
      serveUrl,
      id: "CarouselSlide",
      inputProps: inputProps as unknown as Record<string, unknown>,
      browserExecutable: BROWSER,
    });

    await renderStill({
      composition,
      serveUrl,
      output: out,
      inputProps: inputProps as unknown as Record<string, unknown>,
      browserExecutable: BROWSER,
      imageFormat: "png",
      scale: 1,
      overwrite: true,
    });

    if (existsSync(out)) {
      paths.push(out);
    } else {
      log(`  warning: slide ${i + 1} output not found at ${out}`);
    }
  }

  return paths;
}
