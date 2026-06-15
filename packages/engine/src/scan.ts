import "./env.ts";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ContentObservation, ProfileObservation, ObservationAnalysis } from "@os/schemas";
import { saveObservation, saveProfileObservation, newObsId, findObservationByUrl } from "./observation-store.ts";
import { nowIso } from "./store.ts";
import { think, resolveClaudeBin } from "./brain.ts";

const DATA_DIR = join(process.cwd(), "data", "observations");
const YTDLP = process.env.YTDLP_BIN ?? (() => {
  for (const p of ["/opt/homebrew/bin/yt-dlp", "/usr/local/bin/yt-dlp"]) {
    if (existsSync(p)) return p;
  }
  return "yt-dlp";
})();

function ensureDir(path: string) {
  if (!existsSync(path)) mkdirSync(path, { recursive: true });
}

/** Detect platform from URL */
export function detectPlatform(url: string): ContentObservation["platform"] {
  if (url.includes("instagram.com")) return "instagram";
  if (url.includes("youtube.com") || url.includes("youtu.be")) return "youtube";
  if (url.includes("tiktok.com")) return "tiktok";
  if (url.includes("twitter.com") || url.includes("x.com")) return "x";
  return "other";
}

/** Download video + metadata via yt-dlp */
function ytdlpDownload(url: string, outDir: string, opts: { cookieBrowser?: string; skipVideo?: boolean } = {}): {
  videoPath?: string;
  thumbnailPath?: string;
  meta?: Record<string, unknown>;
} {
  ensureDir(outDir);
  const videoOut = join(outDir, "video.%(ext)s");
  const cookieArgs = opts.cookieBrowser ? ["--cookies-from-browser", opts.cookieBrowser] : [];

  // Pass 1: metadata only (fast, no download) — --write-info-json + --write-thumbnail
  const metaArgs = [
    "--skip-download",
    "--write-info-json",
    "--write-thumbnail",
    "--write-comments",
    "--extractor-args", "instagram:max_comments=20",
    "--no-playlist",
    "-o", videoOut,
    ...cookieArgs,
    url,
  ];
  spawnSync(YTDLP, metaArgs, { cwd: outDir, encoding: "utf8", maxBuffer: 20 * 1024 * 1024, timeout: 30000 });

  // Read info.json written by pass 1
  let meta: Record<string, unknown> | undefined;
  const infoFiles = existsSync(outDir) ? readdirSync(outDir).filter(f => f.endsWith(".info.json")) : [];
  if (infoFiles.length) {
    try { meta = JSON.parse(readFileSync(join(outDir, infoFiles[0]), "utf8")); } catch { /* ignore */ }
  }

  // Pass 2: actual video download (skipped if skipVideo)
  if (!opts.skipVideo) {
    const dlArgs = [
      "--no-playlist",
      "-o", videoOut,
      ...cookieArgs,
      url,
    ];
    spawnSync(YTDLP, dlArgs, { cwd: outDir, encoding: "utf8", maxBuffer: 20 * 1024 * 1024, timeout: 120000 });
  }

  // Find downloaded files
  const videoFiles = existsSync(outDir) ? readdirSync(outDir).filter(f =>
    f.match(/\.(mp4|webm|mkv|mov)$/i) && !f.includes(".info")
  ) : [];
  const thumbFiles = existsSync(outDir) ? readdirSync(outDir).filter(f =>
    f.match(/\.(jpg|jpeg|png|webp)$/i) && !f.includes(".info")
  ) : [];

  return {
    videoPath: videoFiles.length ? join(outDir, videoFiles[0]) : undefined,
    thumbnailPath: thumbFiles.length ? join(outDir, thumbFiles[0]) : undefined,
    meta,
  };
}

/** Extract key frames from a video (1 per N seconds) */
function extractFrames(videoPath: string, outDir: string, fps = "1/4"): string[] {
  ensureDir(outDir);
  const pattern = join(outDir, "frame_%03d.jpg");
  spawnSync("ffmpeg", ["-i", videoPath, "-vf", `fps=${fps},scale=720:-1`, "-q:v", "3", pattern, "-y"], {
    encoding: "utf8",
  });
  return existsSync(outDir)
    ? readdirSync(outDir).filter(f => f.startsWith("frame_") && f.endsWith(".jpg")).sort().map(f => join(outDir, f))
    : [];
}

/** Read frames as base64 for vision analysis */
function framesToBase64(framePaths: string[], maxFrames = 12): Array<{ path: string; b64: string }> {
  const selected = framePaths.length <= maxFrames ? framePaths :
    Array.from({ length: maxFrames }, (_, i) => framePaths[Math.floor(i * framePaths.length / maxFrames)]);
  return selected.map(p => ({ path: p, b64: readFileSync(p).toString("base64") }));
}

/** Call Claude vision to analyze frames */
async function analyzeFrames(frames: Array<{ path: string; b64: string }>, context: {
  url: string;
  platform: string;
  duration?: number;
  title?: string;
  description?: string;
}): Promise<ObservationAnalysis> {
  const prompt = `You are a creative director analyzing a social media video for creative intelligence.

Platform: ${context.platform}
URL: ${context.url}
Duration: ${context.duration ?? "?"}s
Title: ${context.title ?? ""}
Description: ${context.description ?? ""}

I am attaching ${frames.length} key frames sampled evenly across the video.

Analyze this content and return a JSON object with these fields:
{
  "visualLanguage": "2-3 sentence description of the overall visual style, aesthetic, design language",
  "colorPalette": ["list of dominant colors as hex or descriptive"],
  "typography": "description of font choices, text treatment, size, weight, positioning",
  "backgrounds": "what backgrounds are used (texture, footage, solid, gradient etc)",
  "sceneTypes": ["list of distinct scene/layout types you identify"],
  "editRhythm": "description of pacing, cut frequency, transition style",
  "avgSceneDuration": estimated_seconds_per_scene_as_number,
  "musicStyle": "description of music style and energy",
  "musicEnergy": "low|medium|high|very_high",
  "tone": "editorial tone — serious/humorous/urgent/calm/authoritative/etc",
  "narrativeFormat": "how the story is structured (dialogue/list/journey/briefing/etc)",
  "hookPattern": "how does the first 3 seconds hook the viewer",
  "keyInsights": ["3-5 actionable creative insights for replicating this style"],
  "socheliMoodMapping": "which Socheli mood preset this is closest to: explainer|motivational|business|tech|mindfulness|cinematic|ops_room|war_economy|motion_graphics",
  "inspirationScore": score_0_to_10
}

Return ONLY valid JSON, no markdown.
`;

  const claudeBin = resolveClaudeBin();
  if (claudeBin && frames.length > 0) {
    // Write frames as temp files and pass via --file to the claude CLI
    const tmpPromptFile = join(tmpdir(), "scan_prompt_" + Date.now() + ".txt");
    writeFileSync(tmpPromptFile, prompt);
    const fileArgs: string[] = [];
    for (const f of frames) fileArgs.push("--file", f.path);
    const r = spawnSync(claudeBin, ["-p", prompt, ...fileArgs, "--output-format", "text"], {
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
      timeout: 60000,
    });
    const out = (r.stdout ?? "").trim();
    try {
      const jsonMatch = out.match(/\{[\s\S]*\}/);
      if (jsonMatch) return ObservationAnalysis.parse(JSON.parse(jsonMatch[0]));
    } catch { /* fall through to brain */ }
  }

  // Fallback: use think() (the brain) with text-only prompt
  const { data } = await think(
    ObservationAnalysis,
    prompt + "\n\nNote: Images cannot be attached in this context. Provide best-effort analysis based on the URL and metadata alone, filling fields with reasonable estimates.",
    "smart",
    2,
    "observation_analyze"
  );
  return data;
}

/** Scrape bio links from a profile URL */
async function scrapeBioLinks(profileUrl: string): Promise<string[]> {
  try {
    const r = spawnSync("curl", ["-s", "-L", "--max-time", "10", "-A",
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15",
      profileUrl,
    ], { encoding: "utf8", maxBuffer: 2 * 1024 * 1024 });
    const html = r.stdout ?? "";
    // Extract URLs from bio link patterns (exclude same-platform links)
    const links = new Set<string>();
    for (const m of html.matchAll(/href="(https?:\/\/(?!www\.instagram\.com|www\.tiktok\.com|www\.youtube\.com)[^"]+)"/g)) {
      links.add(m[1]);
    }
    return [...links].slice(0, 5);
  } catch { return []; }
}

/** Main: scan a single content URL */
export async function scanContent(url: string, opts: {
  deep?: boolean;
  channelId?: string;
  tags?: string[];
  forceRescan?: boolean;
  log?: (m: string) => void;
} = {}): Promise<ContentObservation> {
  const log = opts.log ?? console.log;

  // Cache check
  if (!opts.forceRescan) {
    const cached = findObservationByUrl(url);
    if (cached) { log("obs: cached observation " + cached.id); return cached; }
  }

  const id = newObsId();
  const outDir = join(DATA_DIR, id);
  ensureDir(outDir);
  const platform = detectPlatform(url);
  log(`obs: scanning ${platform} — ${url.slice(0, 60)}`);

  // Download
  log("obs: downloading…");
  const { videoPath, thumbnailPath, meta } = ytdlpDownload(url, outDir, { cookieBrowser: "safari" });
  log(`obs: ${videoPath ? "video ok" : "no video"}, meta: ${meta ? "ok" : "none"}`);

  // Extract frames
  let frames: string[] = [];
  if (videoPath) {
    log("obs: extracting frames…");
    const framesDir = join(outDir, "frames");
    frames = extractFrames(videoPath, framesDir, "1/3");
    log(`obs: ${frames.length} frames extracted`);
  }

  // Comments
  const rawComments = (meta as Record<string, unknown> & { comments?: Array<Record<string, unknown>> })?.comments ?? [];
  const topComments = rawComments
    .sort((a, b) => ((b.like_count as number) ?? 0) - ((a.like_count as number) ?? 0))
    .slice(0, 10)
    .map((c) => ({ text: (c.text as string) ?? "", likes: c.like_count as number | undefined }));

  // Creator info
  const creator: ContentObservation["creator"] = meta ? {
    handle: (meta.uploader_id as string) ?? (meta.uploader as string) ?? "",
    name: meta.uploader as string | undefined,
    platform,
    profileUrl: platform === "instagram"
      ? `https://www.instagram.com/${meta.uploader_id}/`
      : undefined,
  } : undefined;

  // Analyze frames with vision
  let analysis: ObservationAnalysis | undefined;
  if (frames.length > 0 || meta) {
    log("obs: analyzing with Claude vision…");
    const frameData = framesToBase64(frames, 12);
    analysis = await analyzeFrames(frameData, {
      url,
      platform,
      duration: meta?.duration as number | undefined,
      title: meta?.title as string | undefined,
      description: meta?.description as string | undefined,
    });
    log(`obs: analysis done — score ${analysis.inspirationScore ?? "?"}/10`);
  }

  const obs: ContentObservation = {
    id,
    url,
    platform,
    kind: platform === "youtube" ? "video" : "reel",
    title: meta?.title as string | undefined,
    description: meta?.description as string | undefined,
    duration: meta?.duration as number | undefined,
    creator,
    metrics: meta ? {
      views: meta.view_count as number | undefined,
      likes: meta.like_count as number | undefined,
      comments: meta.comment_count as number | undefined,
    } : undefined,
    videoPath,
    thumbnailPath,
    frames,
    analysis,
    topComments,
    tags: opts.tags ?? [],
    channelId: opts.channelId,
    createdAt: nowIso(),
    scannedAt: nowIso(),
    deepScanned: false,
  };

  saveObservation(obs);
  log(`obs: saved → ${id}`);
  return obs;
}

/** Deep scan a creator profile: bio + recent posts + top performers */
export async function scanProfile(profileUrl: string, opts: {
  limit?: number;
  channelId?: string;
  tags?: string[];
  log?: (m: string) => void;
} = {}): Promise<ProfileObservation> {
  const log = opts.log ?? console.log;
  const limit = opts.limit ?? 5;
  const platform = detectPlatform(profileUrl);
  const id = newObsId();

  log(`profile: deep scanning ${platform} — ${profileUrl}`);

  // 1. Get list of recent posts via yt-dlp flat-playlist
  const listR = spawnSync(YTDLP, [
    "--flat-playlist", "--dump-json", "--no-playlist",
    "--playlist-items", `1:${limit * 2}`,
    "--cookies-from-browser", "safari",
    profileUrl,
  ], { encoding: "utf8", maxBuffer: 10 * 1024 * 1024, timeout: 30000 });

  const posts: Array<{ url: string; views?: number; likes?: number; title?: string }> = [];
  for (const line of (listR.stdout ?? "").split("\n")) {
    try {
      const d = JSON.parse(line.trim()) as Record<string, unknown>;
      if (d.id) posts.push({
        url: (d.url as string) ?? `https://www.instagram.com/reel/${d.id}/`,
        views: d.view_count as number | undefined,
        likes: d.like_count as number | undefined,
        title: d.title as string | undefined,
      });
    } catch { /* ignore */ }
  }
  log(`profile: found ${posts.length} posts`);

  // 2. Bio link scraping
  const bioLinks = await scrapeBioLinks(profileUrl);
  log(`profile: bio links: ${bioLinks.join(", ")}`);

  // 3. Scan top posts (up to limit)
  const topPosts = posts
    .sort((a, b) => ((b.views ?? b.likes ?? 0) - (a.views ?? a.likes ?? 0)))
    .slice(0, limit);
  const scannedPosts: Array<{ url: string; views?: number; likes?: number; title?: string; observationId?: string }> = [];

  for (const post of topPosts) {
    try {
      log(`profile: scanning post ${post.url.slice(-20)}`);
      const obs = await scanContent(post.url, { channelId: opts.channelId, log });
      scannedPosts.push({ ...post, observationId: obs.id });
    } catch (e) {
      log(`profile: post scan failed — ${(e as Error).message}`);
      scannedPosts.push(post);
    }
  }

  const prof: ProfileObservation = {
    id,
    profileUrl,
    platform,
    creator: {
      handle: profileUrl.split("/").filter(Boolean).pop() ?? "",
      platform,
      bioLinks,
    },
    topPosts: scannedPosts,
    createdAt: nowIso(),
    channelId: opts.channelId,
    tags: opts.tags ?? [],
  };

  saveProfileObservation(prof);
  log(`profile: saved → ${id}`);
  return prof;
}
