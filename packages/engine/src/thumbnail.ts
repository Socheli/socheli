import { writeFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import type { ContentItem } from "@os/schemas";
import { httpCurl, proxyReachable } from "./http.ts";
import { RENDERS_DIR, ensureDir } from "./store.ts";

/* ─── AI key-visual thumbnails ──────────────────────────────────────────────
   Premium, ChatGPT-quality thumbnail BACKGROUNDS. We generate only the key
   visual (text-free) and let Remotion's Cover composite the real title/brand on
   top (AI-rendered text is unreliable; designed type is crisp).

   Two backends, first available wins:
   1. Codex CLI `$imagegen` (PRIMARY) — uses the user's ChatGPT/Codex
      subscription, no API key. Saves to ~/.codex/generated_images and we copy it
      to public/thumbs. This is what's wired today.
   2. OpenAI gpt-image-1 (fallback) — if OPENAI_API_KEY is set (pay-as-you-go).
      Routed through the SOCKS tunnel when reachable (OpenAI is geo-blocked in some regions).

   No backend → returns null and the pipeline falls back to the b-roll/gradient
   cover, unchanged. */

const HERE = dirname(fileURLToPath(import.meta.url));
const REMOTION_PUBLIC = join(HERE, "..", "..", "remotion", "public");
const THUMB_DIR = join(REMOTION_PUBLIC, "thumbs");
const OPENAI_VIA_PROXY = proxyReachable();

function codexAvailable(): boolean {
  if (process.env.AI_THUMBNAILS === "0") return false;
  try {
    execFileSync(process.env.CODEX_BIN || "codex", ["--version"], { stdio: "ignore", timeout: 10_000 });
    return existsSync(join(homedir(), ".codex", "auth.json"));
  } catch {
    return false;
  }
}

export function thumbnailConfigured(): boolean {
  return codexAvailable() || !!process.env.OPENAI_API_KEY;
}

/* Craft a premium-thumbnail image prompt. Hard constraints: NO text (the Cover
   overlays it) and generous negative space for the title. */
export function thumbPrompt(item: ContentItem): string {
  const title = item.pkg?.title ?? item.idea?.topic ?? "this topic";
  const angle = item.idea?.angle ?? "";
  const aspect = item.kind === "longform" ? "16:9 landscape" : "9:16 vertical";
  return (
    `Premium, cinematic ${aspect} thumbnail background for a video titled "${title}". ` +
    `${angle ? `Concept: ${angle} ` : ""}` +
    `One bold, striking conceptual subject. Dramatic lighting, rich tasteful color grade, high contrast, ` +
    `photoreal or elegant 3D-render quality, editorial magazine polish. Clean composition with generous empty ` +
    `negative space on one side for a title overlay. Absolutely NO text, NO words, NO letters, NO numbers, NO logos, NO watermarks.`
  );
}

/* Backend 1: Codex `$imagegen`. Runs non-interactively in public/thumbs (a git-
   tracked, writable dir) and asks the skill to save the file there. Returns true
   if the file landed. */
function codexImage(prompt: string, absOut: string): boolean {
  mkdirSync(dirname(absOut), { recursive: true });
  const full = `$imagegen ${prompt} Save the generated image as ${basename(absOut)} in the current working directory.`;
  try {
    execFileSync(
      process.env.CODEX_BIN || "codex",
      ["exec", "--skip-git-repo-check", "-s", "workspace-write", "-C", dirname(absOut), full],
      { stdio: "ignore", timeout: Number(process.env.THUMB_TIMEOUT_MS || 300_000) },
    );
  } catch {
    /* fall through to existence check */
  }
  return existsSync(absOut);
}

/* Backend 2: OpenAI gpt-image-1 (prompt → file). */
const GPT_SIZE: Record<string, string> = { "16:9": "1536x1024", "9:16": "1024x1536", "1:1": "1024x1024" };
function gptImage(prompt: string, aspect: Aspect, absOut: string, log: (m: string) => void): boolean {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return false;
  const body = JSON.stringify({ model: "gpt-image-1", prompt, size: GPT_SIZE[aspect] ?? "1536x1024", n: 1 });
  try {
    const r = httpCurl(
      ["-X", "POST", "https://api.openai.com/v1/images/generations", "-H", `Authorization: Bearer ${key}`, "-H", "Content-Type: application/json", "-d", body],
      { proxy: OPENAI_VIA_PROXY, timeoutMs: 150_000 },
    );
    const j = JSON.parse(r.stdout) as { data?: { b64_json?: string }[]; error?: { message?: string } };
    const b64 = j.data?.[0]?.b64_json;
    if (!b64) {
      log(`gpt-image-1: ${j.error?.message ?? r.stdout.slice(0, 120)}`);
      return false;
    }
    writeFileSync(absOut, Buffer.from(b64, "base64"));
    return existsSync(absOut);
  } catch (e: any) {
    log(`gpt-image-1 failed: ${String(e?.message ?? e).slice(0, 80)}`);
    return false;
  }
}

export type Aspect = "16:9" | "9:16" | "1:1";
export type ImageBackend = "codex" | "gpt-image-1" | "none";

/** Which image backend is active (Codex subscription preferred, then API key). */
export function imageBackend(): ImageBackend {
  if (codexAvailable()) return "codex";
  if (process.env.OPENAI_API_KEY) return "gpt-image-1";
  return "none";
}

/**
 * General-purpose AI image generation — the reusable harness primitive.
 * Backend order: Codex `$imagegen` (subscription, no key) → gpt-image-1. Writes
 * to absOut (cached) and returns it, or null when no backend / generation fails.
 * Used by thumbnails, and exposed as a tool so any agent/pipeline can call it.
 */
export function generateImage(
  prompt: string,
  absOut: string,
  opts: { aspect?: Aspect; log?: (m: string) => void } = {},
): string | null {
  const log = opts.log ?? (() => {});
  const aspect = opts.aspect ?? "16:9";
  mkdirSync(dirname(absOut), { recursive: true });
  if (existsSync(absOut)) return absOut; // cached
  const full = `${prompt} Aspect ratio ${aspect}.`;
  if (codexAvailable() && codexImage(full, absOut)) return absOut;
  if (gptImage(prompt, aspect, absOut, log)) return absOut;
  return null;
}

/**
 * Generate an image into the Remotion public/gen dir (so it's renderable as a
 * scene/cover background and servable by the dashboard). Returns the public-
 * relative src ("gen/<name>.png") or null.
 */
export function generateImagePublic(prompt: string, name: string, opts: { aspect?: Aspect; log?: (m: string) => void } = {}): string | null {
  const safe = name.replace(/[^a-z0-9._-]/gi, "_").slice(0, 64);
  const abs = join(REMOTION_PUBLIC, "gen", `${safe}.png`);
  return generateImage(prompt, abs, opts) ? `gen/${safe}.png` : null;
}

/**
 * Generate a finished 16:9 YouTube thumbnail (title baked in) for a long-form
 * item, saved as `<id>_thumb.jpg` at 1280x720 — the right shape + text for a
 * YouTube video, instead of the vertical short-form Cover. Codex/gpt-image
 * render short bold thumbnail titles reliably. Returns the jpg path or null.
 */
export function youtubeThumbnail(item: ContentItem, log: (m: string) => void = () => {}): string | null {
  if (imageBackend() === "none") return null;
  mkdirSync(THUMB_DIR, { recursive: true });
  ensureDir(RENDERS_DIR);
  const title = (item.pkg?.title ?? item.idea?.topic ?? "").trim();
  const subject = item.idea?.angle ?? title;
  const png = join(THUMB_DIR, `${item.id}_yt.png`);
  const prompt =
    `Create a premium 16:9 YouTube thumbnail (landscape, 1280x720 feel). ` +
    `Visual / metaphor: ${subject}. Dramatic cinematic background, high contrast, volumetric light, ` +
    `premium documentary quality, strong focal subject on one side. ` +
    `Add a BOLD, clean, high-impact sans-serif TITLE — a punchy SHORT version (max 5 words) of: "${title}" — ` +
    `crisp white with a subtle accent colour, perfectly spelled, large and legible, with breathing room. ` +
    `Eye-catching, click-worthy, professional. No watermark, no logo.`;
  if (!generateImage(prompt, png, { aspect: "16:9", log })) return null;
  const out = join(RENDERS_DIR, `${item.id}_thumb.jpg`);
  const r = spawnSync("ffmpeg", ["-y", "-i", png, "-vf", "scale=1280:720", "-q:v", "2", out], { encoding: "utf8" });
  return r.status === 0 && existsSync(out) ? out : null;
}

/**
 * Generate a key-visual background for an item and return it as a `data:` URL
 * for Cover's `bg` prop (Cover.tsx accepts data:/http:/staticFile).
 *
 * Why a data URL and not the public-relative path: the render bundle is cached
 * (render.ts getBundle) from a snapshot of public/ taken during the main render,
 * BEFORE this image is written. A freshly-written public/thumbs/<id>.png is not
 * in that snapshot, so Cover's staticFile() 404s ("source image cannot be
 * decoded") and the cover silently falls back to a frame grab. Inlining the
 * bytes sidesteps the stale bundle entirely (same approach coverBg() uses for
 * video frames) — no multi-GB re-bundle just to composite a thumbnail.
 *
 * The PNG is still cached on disk at THUMB_DIR for reference. Returns null when
 * unconfigured/failed (pipeline falls back to the b-roll/gradient cover).
 */
export async function aiKeyVisual(item: ContentItem, log: (m: string) => void = () => {}): Promise<string | null> {
  const abs = join(THUMB_DIR, `${item.id}.png`);
  const aspect: Aspect = item.kind === "longform" ? "16:9" : "9:16";
  if (!generateImage(thumbPrompt(item), abs, { aspect, log }) || !existsSync(abs)) return null;
  return `data:image/png;base64,${readFileSync(abs).toString("base64")}`;
}
