import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, readFileSync, unlinkSync, renameSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { resolveInventoryBroll } from "./inventory.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const REMOTION_PUBLIC = join(HERE, "..", "..", "remotion", "public");
const BROLL_DIR = join(REMOTION_PUBLIC, "broll");
const SCRIPTS = join(HERE, "..", "scripts");
const VENV_PY = join(HERE, "..", "..", "..", ".venv-music", "bin", "python");
const DATA = join(HERE, "..", "..", "..", "data");
const USAGE_FILE = join(DATA, "broll-usage.json");

export type BrollAsset = { src: string; type: "video" | "image" }; // src relative to public/

const hash = (s: string) => createHash("sha1").update(s).digest("hex").slice(0, 16);

/* Cross-video de-dup ledger: remember which stock clips we've already used so
   the same popular footage doesn't reappear in every video. */
export function loadUsed(): Set<string> {
  try {
    return new Set(JSON.parse(readFileSync(USAGE_FILE, "utf8")) as string[]);
  } catch {
    return new Set();
  }
}

/* Flush a set of newly-used keys to the on-disk ledger in one atomic write.
   Batching writes here (rather than one write per API call) prevents concurrent
   Promise.all batches from clobbering each other's entries. */
function flushUsed(keys: string[]): void {
  if (!keys.length) return;
  try {
    const s = loadUsed();
    for (const k of keys) s.add(k);
    mkdirSync(DATA, { recursive: true });
    writeFileSync(USAGE_FILE, JSON.stringify([...s].slice(-800)));
  } catch {
    /* non-fatal */
  }
}

/* Resolution band score: best near 1080-1920 tall, gently penalise tiny or huge. */
const bandScore = (h: number): number => (h >= 1080 && h <= 1920 ? 1 : h < 1080 ? h / 1080 : Math.max(0, 1 - (h - 1920) / 2400));

/* 9:16 fill score: a portrait clip reads best when it's close to the 1.78 tall
   ratio of the frame — a near-square portrait has to be cropped hard and loses
   its composition. Peaks at 1.6–1.95, falls off outside. */
const aspectScore = (w: number, h: number): number => {
  const r = h / Math.max(1, w);
  if (r >= 1.6 && r <= 1.95) return 1;
  return Math.max(0, 1 - Math.abs(r - 1.777) / 0.9);
};

/* Duration fit score: prefer clips in the typical scene range (3–12 s), penalise
   very short clips (may not loop gracefully) and very long ones (waste bandwidth). */
const durScore = (dur: number): number =>
  dur >= 3 && dur <= 12 ? 1 : dur < 3 ? dur / 3 : Math.max(0, 1 - (dur - 12) / 30);

/* Retry helper: retries once on 429 with exponential backoff.
   Using a small retry budget keeps things fast while handling brief rate-limit
   windows on free API tiers. */
async function fetchWithRetry(url: string, init?: RequestInit, retries = 2): Promise<Response> {
  for (let i = 0; i <= retries; i++) {
    const res = await fetch(url, init);
    if (res.status !== 429 || i === retries) return res;
    await new Promise((r) => setTimeout(r, 800 * (i + 1)));
  }
  // unreachable — loop above always returns on the last iteration
  return fetch(url, init);
}

/* Enrich a B-roll query with scene-type-specific visual language.
   The goal is to guide stock-video search toward footage that works well
   for a given scene layout without overriding the AI's topical intent.
   The prefix is only prepended when the query doesn't already contain the
   key words (avoids redundant doubling like "cinematic cinematic city").
   Export so callers (stages.ts, render.ts) can use it before persisting
   the storyboard. */
export function enrichBrollQuery(query: string, sceneType?: string): string {
  if (!sceneType || !query) return query;
  const prefixes: Record<string, string> = {
    hook_text: "cinematic slow motion",
    big_number: "aerial establishing shot",
    kinetic_text: "abstract minimal motion",
    before_after: "transformation process",
    warning: "dramatic tension dark",
    cta: "inspiring forward motion",
    quote: "contemplative ambient",
    image_focus: "", // query is already a visual description
    chart: "data visualization abstract",
    timeline: "progression sequence",
    map: "aerial satellite view",
    dialogue: "dark tactical briefing",
  };
  const prefix = prefixes[sceneType] ?? "";
  if (!prefix) return query;
  const lower = query.toLowerCase();
  // Don't prepend if the query already contains the key visual cues
  if (prefix.split(" ").some((w) => lower.includes(w))) return query;
  return `${prefix} ${query}`.trim();
}

/* Pexels portrait stock video → returns a downloadable mp4 URL (or null). Ranks
   candidates on relevance (page-URL slug tokens) + resolution band + 9:16 fill +
   duration fit + quality bonuses, dedups by Pexels VIDEO ID against `used`
   (cross-video ledger seeded + this run's picks), and uses a per-query hash
   tiebreak so the same query in two different videos still diverges. `used` is
   mutated in-memory so callers see this run's picks; disk flush is done once by
   resolveBroll after a confirmed successful download. `styleHint` (e.g. the
   mood's footageSearch) is appended to the SEARCH query to bias what's returned —
   relevance is still scored on the ORIGINAL query tokens so the hint never crowds
   out on-topic matches, and the cache key upstream is unchanged so re-renders stay
   instant. */
async function pexelsVideoUrl(query: string, used: Set<string>, styleHint?: string): Promise<string | null> {
  const key = process.env.PEXELS_API_KEY;
  if (!key) return null;
  try {
    const searchQuery = styleHint ? `${query} ${styleHint}` : query;
    const res = await fetchWithRetry(
      `https://api.pexels.com/videos/search?query=${encodeURIComponent(searchQuery)}&per_page=30&orientation=portrait&size=large`,
      { headers: { Authorization: key } },
    );
    if (!res.ok) return null;
    const json = (await res.json()) as {
      videos?: {
        id: number;
        url: string;
        duration?: number;
        width: number;
        height: number;
        video_files: { link: string; width: number; height: number; quality: string }[];
      }[];
    };
    const qTokens = query.toLowerCase().split(/\W+/).filter((t) => t.length > 2);
    type Cand = { id: number; link: string; res: number; rel: number; asp: number; qualityBonus: number; dur: number };
    const cands: Cand[] = [];
    for (const v of (json.videos ?? []).filter((vv) => vv.height >= vv.width)) {
      // highest-res portrait file within a sane cap (avoid 4K monsters)
      const f = v.video_files
        .filter((x) => x.height >= x.width && x.height <= 2160)
        .sort((a, b) => b.height - a.height)[0];
      if (!f) continue;
      // Score relevance against the Pexels page URL slug (semantic title),
      // not the CDN link (which is a numeric vimeo ID with zero token content).
      const pageSlug = (v.url ?? "").toLowerCase();
      const rel = qTokens.length ? qTokens.filter((t) => pageSlug.includes(t)).length / qTokens.length : 0;
      // quality signal bonuses: reward HD/1080p and portrait-tagged page slugs,
      // penalise generic filler footage
      const qualityBonus =
        (pageSlug.includes("hd") || pageSlug.includes("1080") ? 0.08 : 0) +
        (pageSlug.includes("portrait") || pageSlug.includes("vertical") ? 0.06 : 0) -
        (pageSlug.includes("generic") || pageSlug.includes("stock-footage") ? 0.08 : 0);
      cands.push({ id: v.id, link: f.link, res: f.height, rel, asp: aspectScore(f.width, f.height), qualityBonus, dur: v.duration ?? 6 });
    }
    if (!cands.length) return null;
    // composite quality: relevance, 9:16 fill, resolution, duration fit, quality bonuses
    const score = (c: Cand) => c.rel * 0.8 + c.asp * 0.6 + bandScore(c.res) * 0.5 + durScore(c.dur) * 0.3 + c.qualityBonus;
    // prefer clips not seen this run / in prior videos; fall back when exhausted
    const fresh = cands.filter((c) => !used.has(`vid:${c.id}`));
    const pool = (fresh.length ? fresh : cands).sort((a, b) => score(b) - score(a));
    // hash tiebreak among the strongest few so different videos diverge
    const top = pool.slice(0, Math.min(4, pool.length));
    const chosen = top[parseInt(hash(query).slice(0, 8), 16) % top.length];
    // In-memory dedup only; disk flush is handled by resolveBroll after download succeeds.
    used.add(`vid:${chosen.id}`);
    return chosen.link;
  } catch {
    /* ignore */
  }
  return null;
}

/* Pixabay portrait stock video → returns a downloadable mp4 URL (or null).
   Uses the `tags` field (richer semantic signal than URL slugs) as the primary
   relevance signal, blended with slug token matching. Deduplicates against
   `used` with the `pix:` namespace so Pexels and Pixabay IDs never collide.
   `styleHint` is appended to the search query exactly as in pexelsVideoUrl.
   Note: the Pixabay Videos API does not support an `orientation` parameter
   (unlike the Images API); landscape filtering is done client-side. We prefer
   the `large` quality tier (~720p portrait) over `medium` (~360p) for a sharper
   result on a 1080×1920 frame. */
async function pixabayVideoUrl(query: string, used: Set<string>, styleHint?: string): Promise<string | null> {
  const key = process.env.PIXABAY_API_KEY;
  if (!key) return null;
  try {
    const searchQuery = styleHint ? `${query} ${styleHint}` : query;
    const res = await fetchWithRetry(
      `https://pixabay.com/api/videos/?key=${encodeURIComponent(key)}&q=${encodeURIComponent(searchQuery)}&video_type=film&per_page=20`,
    );
    if (!res.ok) return null;
    const json = (await res.json()) as {
      hits?: {
        id: number;
        tags: string;
        videos: {
          large?: { url: string; width: number; height: number };
          medium: { url: string; width: number; height: number };
        };
      }[];
    };
    const qTokens = query.toLowerCase().split(/\W+/).filter((t) => t.length > 2);
    type Cand = { id: number; link: string; res: number; rel: number; asp: number; tagScore: number };
    const cands: Cand[] = [];
    for (const v of json.hits ?? []) {
      // Prefer the large tier (720p portrait) when available; fall back to medium.
      const f = (v.videos.large?.url ? v.videos.large : v.videos.medium) as { url: string; width: number; height: number } | undefined;
      if (!f?.url || !f.width || !f.height) continue;
      if (f.width > f.height) continue; // skip landscape
      const tags = v.tags.toLowerCase().split(/,\s*/);
      // tag match is the stronger signal — tags are human-curated semantic labels
      const tagScore = qTokens.length ? qTokens.filter((t) => tags.some((tag) => tag.includes(t))).length / qTokens.length : 0;
      const slugRel = qTokens.filter((t) => f.url.toLowerCase().includes(t)).length / Math.max(1, qTokens.length);
      const rel = tagScore * 0.7 + slugRel * 0.3;
      cands.push({ id: v.id, link: f.url, res: f.height, rel, asp: aspectScore(f.width, f.height), tagScore });
    }
    if (!cands.length) return null;
    const score = (c: Cand) => c.rel * 0.75 + c.tagScore * 0.5 + c.asp * 0.6 + bandScore(c.res) * 0.4;
    const fresh = cands.filter((c) => !used.has(`pix:${c.id}`));
    const pool = (fresh.length ? fresh : cands).sort((a, b) => score(b) - score(a));
    const top = pool.slice(0, Math.min(4, pool.length));
    const chosen = top[parseInt(hash(query).slice(0, 8), 16) % top.length];
    // In-memory dedup only; disk flush is handled by resolveBroll after download succeeds.
    used.add(`pix:${chosen.id}`);
    return chosen.link;
  } catch {
    /* ignore */
  }
  return null;
}

/* Pexels popular-video fallback — returns the first fresh high-quality portrait
   clip from the Pexels /popular endpoint. Requires no extra key (same
   PEXELS_API_KEY). Used when all search-based sources are exhausted and we still
   want a video rather than a static image. */
async function pexelsPopularFallback(used: Set<string>): Promise<string | null> {
  const key = process.env.PEXELS_API_KEY;
  if (!key) return null;
  try {
    const res = await fetchWithRetry(
      "https://api.pexels.com/videos/popular?per_page=15&min_width=720&min_height=1280",
      { headers: { Authorization: key } },
    );
    if (!res.ok) return null;
    const json = (await res.json()) as {
      videos?: {
        id: number;
        duration?: number;
        width: number;
        height: number;
        video_files: { link: string; width: number; height: number; quality: string }[];
      }[];
    };
    type Cand = { id: number; link: string; res: number; asp: number; dur: number };
    const cands: Cand[] = [];
    for (const v of (json.videos ?? []).filter((vv) => vv.height >= vv.width)) {
      const f = v.video_files
        .filter((x) => x.height >= x.width && x.height <= 2160)
        .sort((a, b) => b.height - a.height)[0];
      if (!f) continue;
      cands.push({ id: v.id, link: f.link, res: f.height, asp: aspectScore(f.width, f.height), dur: v.duration ?? 6 });
    }
    if (!cands.length) return null;
    const score = (c: Cand) => c.asp * 0.7 + bandScore(c.res) * 0.5 + durScore(c.dur) * 0.3;
    const fresh = cands.filter((c) => !used.has(`vid:${c.id}`));
    const pool = (fresh.length ? fresh : cands).sort((a, b) => score(b) - score(a));
    const chosen = pool[0];
    used.add(`vid:${chosen.id}`);
    return chosen.link;
  } catch {
    /* ignore */
  }
  return null;
}

/* Pixabay photo (image) fallback for abstract scenes — searches the Pixabay
   Images API (separate endpoint from Videos) for a portrait still. Uses the
   `largeImageURL` for the highest available resolution (~780px+ portrait).
   Falls back to webformatURL when large is absent. */
async function pixabayImageUrl(query: string, used: Set<string>): Promise<string | null> {
  const key = process.env.PIXABAY_API_KEY;
  if (!key) return null;
  try {
    const res = await fetchWithRetry(
      `https://pixabay.com/api/?key=${encodeURIComponent(key)}&q=${encodeURIComponent(query)}&image_type=photo&orientation=vertical&per_page=20&safesearch=true`,
    );
    if (!res.ok) return null;
    const json = (await res.json()) as {
      hits?: { id: number; webformatURL: string; imageWidth: number; imageHeight: number; largeImageURL: string }[];
    };
    const portrait = (json.hits ?? []).filter((v) => v.imageHeight > v.imageWidth);
    if (!portrait.length) return null;
    const fresh = portrait.filter((v) => !used.has(`piximg:${v.id}`));
    const pool = fresh.length ? fresh : portrait;
    const chosen = pool[parseInt(hash(query).slice(0, 8), 16) % pool.length];
    used.add(`piximg:${chosen.id}`);
    return chosen.largeImageURL || chosen.webformatURL;
  } catch {
    return null;
  }
}

/* Download a media URL to `dest` atomically using a temp file.
   Writes to dest.tmp first, renames on success, deletes on failure.
   This prevents a corrupt stub from being cached as a valid asset on
   sub-1000-byte or non-video responses. Also checks Content-Type to reject
   HTML error pages (CDN 429 pages, Cloudflare challenges) before writing.
   A 30-second AbortController timeout prevents indefinite hangs on stalled CDN. */
async function download(url: string, dest: string): Promise<boolean> {
  const tmp = `${dest}.tmp`;
  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), 30_000);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    clearTimeout(tid);
    if (!res.ok) return false;
    const ct = res.headers.get("content-type") ?? "";
    // Reject HTML responses (error pages, captchas) before writing to disk.
    if (ct.startsWith("text/html")) return false;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length <= 1000) return false;
    writeFileSync(tmp, buf);
    renameSync(tmp, dest);
    return true;
  } catch {
    try { unlinkSync(tmp); } catch { /* non-fatal */ }
    return false;
  } finally {
    clearTimeout(tid);
  }
}

/* Verify a clip actually matches its line (CLIP). Returns true if relevant enough.
   Fail-open if the Python venv is unavailable. Uses a frame at 3 s (rather than
   1 s) to avoid black fade-in frames that would skew the cosine score toward 0.
   Deletes the probe JPEG after scoring to avoid accumulating stale frames. */
function brollRelevant(videoAbs: string, query: string): boolean {
  if (!existsSync(VENV_PY)) return true; // no python env → fail open
  const frame = `${videoAbs}.probe.jpg`;
  if (spawnSync("ffmpeg", ["-y", "-ss", "3", "-i", videoAbs, "-frames:v", "1", frame], { encoding: "utf8" }).status !== 0) return true;
  try {
    const r = spawnSync(VENV_PY, [join(SCRIPTS, "clip-score.py"), frame, query], { encoding: "utf8", timeout: 120000 });
    const score = (JSON.parse(r.stdout.trim().split("\n").pop() || "{}") as { score?: number }).score ?? 1;
    return score >= 0.21; // cosine threshold; below = off-topic → fall back to next source
  } catch {
    return true;
  } finally {
    try { unlinkSync(frame); } catch { /* non-fatal */ }
  }
}

function sdImage(query: string, dest: string): boolean {
  if (!existsSync(VENV_PY)) return false;
  const r = spawnSync(VENV_PY, [join(SCRIPTS, "sdturbo.py"), query, "512", "896", dest], { encoding: "utf8", timeout: 1000 * 60 * 6 });
  return r.status === 0 && existsSync(dest);
}

/* ─── AI VIDEO GENERATION LAYER ────────────────────────────────────────────── */

/* Generic async-poll helper for text-to-video APIs that follow the
   submit-then-poll pattern. Polls at `intervalMs` until `pollFn` signals
   done/failed or the `timeoutMs` wall-clock limit is reached.
   Returns null on timeout or failure so callers can fall through cleanly. */
async function pollUntilDone<T>(
  pollFn: () => Promise<{ done: boolean; result?: T; failed?: boolean }>,
  intervalMs = 3000,
  timeoutMs = 120_000,
): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, intervalMs));
    try {
      const check = await pollFn();
      if (check.failed) return null;
      if (check.done && check.result !== undefined) return check.result;
    } catch { /* ignore transient poll errors, keep trying */ }
  }
  return null; // timed out
}

/* Kling AI text-to-video (kling-v2.6-pro).
   API base: https://api.klingapi.com
   Supports 9:16 portrait natively, text-only (no image required), 5 or 10s.
   Cost ~$0.14/5s clip (std mode). Returns a CDN video URL or null. */
async function klingVideoGenerate(prompt: string, durationSec: number): Promise<string | null> {
  const key = process.env.KLING_API_KEY;
  if (!key) return null;
  try {
    const submitRes = await fetchWithRetry("https://api.klingapi.com/v1/videos/text2video", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: "kling-v2.6-pro",
        prompt,
        duration: durationSec >= 8 ? 10 : 5,
        aspect_ratio: "9:16",
        mode: "std",
        negative_prompt: "blurry, low quality, watermark, text overlay, logo",
      }),
    });
    if (!submitRes.ok) return null;
    const submitJson = (await submitRes.json()) as { task_id?: string; data?: { task_id?: string } };
    // API may return task_id at top level or nested under data
    const taskId = submitJson.task_id ?? submitJson.data?.task_id;
    if (!taskId) return null;

    const videoUrl = await pollUntilDone<string>(async () => {
      const pollRes = await fetch(`https://api.klingapi.com/v1/tasks/${taskId}`, {
        headers: { Authorization: `Bearer ${key}` },
      });
      if (!pollRes.ok) return { done: false };
      const pollJson = (await pollRes.json()) as {
        status?: string;
        state?: string;
        video_url?: string;
        video?: string;
        data?: { status?: string; video_url?: string; video?: string };
      };
      // Normalise: status may be top-level or under data
      const status = pollJson.status ?? pollJson.state ?? pollJson.data?.status;
      if (status === "failed" || status === "error") return { done: false, failed: true };
      if (status === "completed" || status === "succeed") {
        const url = pollJson.video_url ?? pollJson.video ?? pollJson.data?.video_url ?? pollJson.data?.video;
        return url ? { done: true, result: url } : { done: false, failed: true };
      }
      return { done: false };
    });

    return videoUrl ?? null;
  } catch {
    return null;
  }
}

/* Runway Gen-4 Turbo — STUBBED.
   Research finding: Runway Gen-4 requires BOTH an image input (promptImage URL)
   AND a text motion prompt. It does NOT support text-only video generation.
   Additionally it has no documented portrait (9:16) support.
   Use klingVideoGenerate or minimaxVideoGenerate for text-only portrait video. */
async function runwayVideoGenerate(_prompt: string, _durationSec: number): Promise<string | null> {
  // Runway requires image input for video generation — not usable as a text-to-video source.
  return null;
}

/* Minimax / Hailuo AI text-to-video (T2V-01-Director).
   API base: https://api.minimax.io
   Supports text-only prompts with inline camera commands ([Pan left], [Zoom in]),
   portrait via resolution control, 6 or 10s duration.
   Polling uses a POST to /v1/query/video_generation (not GET).
   Cost ~$0.045–$0.08/sec via fal.ai. Returns a CDN video URL or null. */
async function minimaxVideoGenerate(prompt: string, durationSec: number): Promise<string | null> {
  const key = process.env.MINIMAX_API_KEY;
  if (!key) return null;
  try {
    const submitRes = await fetchWithRetry("https://api.minimax.io/v1/video_generation", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: "T2V-01-Director",
        prompt,
        duration: durationSec >= 8 ? 10 : 6,
        resolution: "768P",
      }),
    });
    if (!submitRes.ok) return null;
    const submitJson = (await submitRes.json()) as { task_id?: string };
    const taskId = submitJson.task_id;
    if (!taskId) return null;

    // Minimax polling uses POST (not GET) with task_id in the body.
    const fileId = await pollUntilDone<string>(async () => {
      const pollRes = await fetchWithRetry("https://api.minimax.io/v1/query/video_generation", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify({ task_id: taskId }),
      });
      if (!pollRes.ok) return { done: false };
      const pollJson = (await pollRes.json()) as {
        status?: string;
        file_id?: string;
        task_id?: string;
      };
      if (pollJson.status === "Fail") return { done: false, failed: true };
      if (pollJson.status === "Success" && pollJson.file_id) {
        return { done: true, result: pollJson.file_id };
      }
      return { done: false };
    });

    if (!fileId) return null;

    // Retrieve the actual video URL from the file ID
    const fileRes = await fetchWithRetry(`https://api.minimax.io/v1/files/retrieve?GroupId=${fileId}`, {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (!fileRes.ok) return null;
    const fileJson = (await fileRes.json()) as { file?: { download_url?: string } };
    return fileJson.file?.download_url ?? null;
  } catch {
    return null;
  }
}

/* Luma Dream Machine text-to-video (ray-2).
   API base: https://api.lumalabs.ai
   Supports text-only prompts, 9:16 portrait, 5s or 9s duration.
   Cost ~$0.32/clip via official API. Returns a CDN video URL or null. */
async function lumaVideoGenerate(prompt: string): Promise<string | null> {
  const key = process.env.LUMALABS_API_KEY;
  if (!key) return null;
  try {
    const submitRes = await fetchWithRetry("https://api.lumalabs.ai/dream-machine/v1/generations", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        prompt,
        model: "ray-2",
        aspect_ratio: "9:16",
        duration: "5s",
        loop: false,
      }),
    });
    if (!submitRes.ok) return null;
    const submitJson = (await submitRes.json()) as { id?: string };
    const genId = submitJson.id;
    if (!genId) return null;

    const videoUrl = await pollUntilDone<string>(async () => {
      const r = await fetch(`https://api.lumalabs.ai/dream-machine/v1/generations/${genId}`, {
        headers: { Accept: "application/json", Authorization: `Bearer ${key}` },
      });
      if (!r.ok) return { done: false };
      const j = (await r.json()) as {
        state?: string;
        failure_reason?: string;
        assets?: { video?: string };
      };
      if (j.state === "failed") return { done: false, failed: true };
      if (j.state === "completed") {
        const url = j.assets?.video;
        return url ? { done: true, result: url } : { done: false, failed: true };
      }
      return { done: false };
    });

    return videoUrl ?? null;
  } catch {
    return null;
  }
}

/* Pika v2.2 text-to-video via fal.ai queue.
   Endpoint: https://fal.run/fal-ai/pika/v2.2/text-to-video
   Auth header uses "Key <token>" format (not "Bearer").
   Supports 9:16 portrait, text-only, 5 or 10s, 720p or 1080p.
   Cost ~$0.20/5s clip at 720p. Returns a CDN video URL or null. */
async function pikaVideoGenerate(prompt: string, durationSec: number): Promise<string | null> {
  const key = process.env.PIKA_API_KEY ?? process.env.FAL_API_KEY;
  if (!key) return null;
  try {
    // Submit to fal.ai queue
    const submitRes = await fetchWithRetry("https://queue.fal.run/fal-ai/pika/v2.2/text-to-video", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Key ${key}` },
      body: JSON.stringify({
        prompt,
        aspect_ratio: "9:16",
        resolution: "720p",
        duration: durationSec >= 8 ? 10 : 5,
        negative_prompt: "blurry, low quality, watermark",
      }),
    });
    if (!submitRes.ok) return null;
    const submitJson = (await submitRes.json()) as { request_id?: string };
    const requestId = submitJson.request_id;
    if (!requestId) return null;

    // Poll via fal.ai status endpoint
    const videoUrl = await pollUntilDone<string>(async () => {
      const pollRes = await fetch(
        `https://queue.fal.run/fal-ai/pika/v2.2/text-to-video/requests/${requestId}/status`,
        { headers: { Authorization: `Key ${key}` } },
      );
      if (!pollRes.ok) return { done: false };
      const pollJson = (await pollRes.json()) as {
        status?: string;
        output?: { video?: { url?: string } };
      };
      if (pollJson.status === "FAILED") return { done: false, failed: true };
      if (pollJson.status === "COMPLETED") {
        const url = pollJson.output?.video?.url;
        return url ? { done: true, result: url } : { done: false, failed: true };
      }
      return { done: false };
    });

    return videoUrl ?? null;
  } catch {
    return null;
  }
}

/* Main AI video generation entry point. Tries APIs in order of quality and cost:
   1. Kling AI (~$0.14/5s) — best quality, true text-to-video, portrait native
   2. Pika v2.2 (~$0.20/5s @ 720p) — wide aspect ratio support, good quality
   3. Minimax / Hailuo (~$0.225/5s @ 768p) — best camera control, text-only
   4. Luma Dream Machine (~$0.32/5s) — good quality, portrait support
   5. Runway Gen-4 Turbo — SKIPPED (requires image input, no text-only support)

   Each API is gated behind its own env-key so missing keys are silent skips.
   Returns a remote video URL (to be downloaded) or null if all fail/time out.
   Callers (resolveBroll) handle caching the downloaded result to disk. */
export async function aiVideoGenerate(query: string, durationSec = 5): Promise<string | null> {
  const generators: Array<() => Promise<string | null>> = [
    () => klingVideoGenerate(query, durationSec),
    () => pikaVideoGenerate(query, durationSec),
    () => minimaxVideoGenerate(query, durationSec),
    () => lumaVideoGenerate(query),
    // runwayVideoGenerate excluded — requires image input, not text-only
  ];
  for (const gen of generators) {
    try {
      const url = await gen();
      if (url) return url;
    } catch { /* silent skip — next generator */ }
  }
  return null;
}

/* Check whether any AI video API key is configured in the environment. */
function hasAiVideoKey(): boolean {
  return !!(
    process.env.KLING_API_KEY ||
    process.env.PIKA_API_KEY ||
    process.env.FAL_API_KEY ||
    process.env.MINIMAX_API_KEY ||
    process.env.LUMALABS_API_KEY
  );
}

/* ─── BROLL RESOLUTION ──────────────────────────────────────────────────────── */

/* Resolve one scene's B-roll.
   concrete → stock video cascade (Pexels → Pixabay → Pexels popular fallback)
            → AI video generation (Kling / Pika / Minimax / Luma)
            → Pixabay Images → SD Turbo → null.
   abstract → AI video generation → Pixabay Images → SD Turbo → null.
   Cached by (kind, query) so re-renders are instant.
   Null → caller falls back to the geometric background.
   The `used` set is mutated in-memory throughout and flushed to disk once per
   successful resolved asset, preventing concurrent batch races from clobbering
   each other's ledger entries. */
export async function resolveBroll(query: string, kind: "concrete" | "abstract", used?: Set<string>, styleHint?: string): Promise<BrollAsset | null> {
  mkdirSync(BROLL_DIR, { recursive: true });
  const h = hash(`${kind}:${query}`);
  const seen = used ?? loadUsed();

  // LEXDRIVE FIRST: the user's own footage trumps any stock source — it's owned,
  // on-brand, zero-cost, and never download-flaky. Falls through to stock when
  // nothing in the local inventory clears the relevance bar.
  const owned = resolveInventoryBroll(query, seen);
  if (owned) return owned;

  if (kind === "concrete") {
    const relVid = `broll/${h}.mp4`;
    const absVid = join(BROLL_DIR, `${h}.mp4`);
    if (existsSync(absVid)) return { src: relVid, type: "video" };

    // Source cascade: Pexels search → Pixabay search → Pexels popular
    const sources: Array<() => Promise<string | null>> = [
      () => pexelsVideoUrl(query, seen, styleHint),
      () => pixabayVideoUrl(query, seen, styleHint),
      () => pexelsPopularFallback(seen),
    ];
    for (const trySource of sources) {
      const url = await trySource();
      if (url && (await download(url, absVid)) && brollRelevant(absVid, query)) {
        // Flush the in-memory used entries to disk now that the download is confirmed.
        flushUsed([...seen]);
        return { src: relVid, type: "video" };
      }
      // Remove any bad partial file before trying the next source.
      if (existsSync(absVid)) {
        try { unlinkSync(absVid); } catch { /* non-fatal */ }
      }
    }
    // all stock video sources exhausted → try AI video generation (premium tier)
  }

  // AI video generation: premium tier before static image fallbacks.
  // For "concrete" kind: tried after stock sources fail.
  // For "abstract" kind: tried first (AI generates exactly what's described).
  if (hasAiVideoKey()) {
    const relVidAI = `broll/${h}_ai.mp4`;
    const absVidAI = join(BROLL_DIR, `${h}_ai.mp4`);
    if (existsSync(absVidAI)) return { src: relVidAI, type: "video" };

    const aiUrl = await aiVideoGenerate(query, 5);
    if (aiUrl && (await download(aiUrl, absVidAI))) {
      flushUsed([...seen]);
      return { src: relVidAI, type: "video" };
    }
    // Clean up any partial download before falling through.
    if (existsSync(absVidAI)) {
      try { unlinkSync(absVidAI); } catch { /* non-fatal */ }
    }
  }

  const relImg = `broll/${h}.png`;
  const absImg = join(BROLL_DIR, `${h}.png`);
  if (existsSync(absImg)) return { src: relImg, type: "image" };

  // Pixabay Images fallback (fast, no GPU required, works for both abstract and
  // concrete queries when stock video is unavailable or CLIP-rejected).
  const pixImgUrl = await pixabayImageUrl(query, seen);
  if (pixImgUrl && (await download(pixImgUrl, absImg))) {
    flushUsed([...seen]);
    return { src: relImg, type: "image" };
  }
  if (existsSync(absImg)) try { unlinkSync(absImg); } catch { /* non-fatal */ }

  // SD Turbo last resort (GPU-heavy, 6-minute timeout, may be unavailable)
  if (sdImage(query, absImg)) return { src: relImg, type: "image" };
  return null;
}

/* Resolve B-roll for every scene in parallel batches of 4. Sharing ONE `used`
   set (seeded from the cross-video ledger) prevents duplicate clips across scenes.
   Note: within a concurrent batch, two scenes can still theoretically pick the
   same clip (race between fetch completion and used.add). This is an acceptable
   low-impact trade-off vs. serialising all resolution. An optional `used` lets
   the caller share the set with resolveGridCells. The `type` field on each scene
   is forwarded to enrichBrollQuery so scene-type visual language is applied
   before the stock search. */
export async function resolveScenesBroll(
  scenes: { type?: string; broll?: { query: string; kind: "concrete" | "abstract" } }[],
  used: Set<string> = loadUsed(),
  styleHint?: string,
): Promise<(BrollAsset | null)[]> {
  const BATCH = 4;
  const out: (BrollAsset | null)[] = new Array(scenes.length).fill(null);
  for (let i = 0; i < scenes.length; i += BATCH) {
    const batchResults = await Promise.all(
      scenes.slice(i, i + BATCH).map((s) =>
        s.broll
          ? resolveBroll(enrichBrollQuery(s.broll.query, s.type), s.broll.kind, used, styleHint)
          : Promise.resolve(null),
      ),
    );
    batchResults.forEach((r, j) => {
      out[i + j] = r;
    });
  }
  return out;
}

/* Resolve a full-bleed background for every cell of every grid scene, in place.
   Shares the same `used` set so grid cells don't duplicate scene b-roll. */
export async function resolveGridCells(
  scenes: Array<{ type?: string; cells?: Array<{ query?: string; bg?: string; bgType?: string }> }>,
  used: Set<string> = loadUsed(),
  styleHint?: string,
): Promise<number> {
  let n = 0;
  for (const s of scenes) {
    if (s?.type !== "grid" || !Array.isArray(s.cells)) continue;
    for (const cell of s.cells) {
      if (!cell?.query) continue;
      const a = await resolveBroll(cell.query, "concrete", used, styleHint);
      if (a) {
        cell.bg = a.src;
        cell.bgType = a.type;
        n++;
      }
    }
  }
  return n;
}

/* Report which b-roll sources and quality gates are active in the current
   environment. Separates sources (video/image providers) from gates (CLIP
   verification) and fallbacks (AI generation) so callers can reason about
   the pipeline's capabilities independently of its quality filters. */
export function brollSources(): { sources: string[]; gates: string[]; fallbacks: string[] } {
  const sources: string[] = [];
  const gates: string[] = [];
  const fallbacks: string[] = [];
  if (process.env.PEXELS_API_KEY) sources.push("pexels");
  if (process.env.PIXABAY_API_KEY) { sources.push("pixabay_video"); sources.push("pixabay_images"); }
  // AI text-to-video sources (premium tier)
  if (process.env.KLING_API_KEY) sources.push("kling_ai");
  if (process.env.PIKA_API_KEY || process.env.FAL_API_KEY) sources.push("pika_v2");
  if (process.env.MINIMAX_API_KEY) sources.push("minimax_hailuo");
  if (process.env.LUMALABS_API_KEY) sources.push("luma_dream_machine");
  if (existsSync(VENV_PY)) { gates.push("clip_verify"); fallbacks.push("sd_turbo"); }
  fallbacks.unshift("pixabay_images_fallback");
  return { sources, gates, fallbacks };
}
