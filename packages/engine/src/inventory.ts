import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, statSync, readdirSync, rmSync } from "node:fs";
import { join, dirname, basename, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { resolveClaudeBin } from "./brain.ts";

/* ─── LEXDRIVE: the user's own b-roll inventory ──────────────────────────────
   A LOCAL, self-hosted store of the user's own footage/images. The render pulls
   from here FIRST (premium, owned, zero-cost, on-brand) and only falls back to
   Pexels/Pixabay/AI stock when nothing in the inventory matches a scene.

   Layout (all under data/inventory/):
     data/inventory/assets/<id><ext>   — the copied source media (owned)
     data/inventory/index.json         — the searchable catalog

   Matching is keyword-overlap scoring over tags + description + original
   filename. Assets are auto-tagged on add: ffprobe for dims/duration, plus a
   best-effort Claude-vision pass over a couple of sampled frames for tags +
   a one-line description. If vision is unavailable we degrade to filename tags
   so the asset is still added and searchable. */

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..", "..");
const REMOTION_PUBLIC = join(HERE, "..", "..", "remotion", "public");
const BROLL_DIR = join(REMOTION_PUBLIC, "broll");
const INVENTORY_DIR = join(ROOT, "data", "inventory");
const ASSETS_DIR = join(INVENTORY_DIR, "assets");
const INDEX_FILE = join(INVENTORY_DIR, "index.json");

export type InventoryAsset = {
  id: string;
  file: string; // relative to ASSETS_DIR
  type: "video" | "image";
  tags: string[];
  description: string;
  durationSec?: number;
  width?: number;
  height?: number;
  orientation?: "portrait" | "landscape" | "square";
  addedAt: string;
  source?: string; // original filename, for provenance
};

type InventoryFile = { assets: InventoryAsset[]; updatedAt: string };

const now = () => new Date().toISOString();
const hash = (s: string) => createHash("sha1").update(s).digest("hex").slice(0, 16);

const VIDEO_EXT = new Set([".mp4", ".mov", ".webm", ".mkv", ".m4v"]);
const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);

export function loadInventory(): InventoryFile {
  try {
    return JSON.parse(readFileSync(INDEX_FILE, "utf8")) as InventoryFile;
  } catch {
    return { assets: [], updatedAt: "" };
  }
}

export function saveInventory(f: InventoryFile): void {
  mkdirSync(INVENTORY_DIR, { recursive: true });
  f.updatedAt = now();
  writeFileSync(INDEX_FILE, JSON.stringify(f, null, 2));
}

/* ── probing & tagging ─────────────────────────────────────────────────────── */

function ffprobe(path: string): { width?: number; height?: number; durationSec?: number } {
  const r = spawnSync(
    "ffprobe",
    ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height:format=duration", "-of", "json", path],
    { encoding: "utf8", timeout: 20000 },
  );
  try {
    const j = JSON.parse(r.stdout || "{}");
    const s = j.streams?.[0] ?? {};
    const dur = j.format?.duration ? Number(j.format.duration) : undefined;
    return {
      width: s.width ? Number(s.width) : undefined,
      height: s.height ? Number(s.height) : undefined,
      durationSec: Number.isFinite(dur) ? dur : undefined,
    };
  } catch {
    return {};
  }
}

/* Auto-tag with Claude vision over a couple of sampled frames (videos) or the
   image itself. Best-effort: returns null on any failure so the caller can fall
   back to filename-derived tags. */
function visionTag(path: string, type: "video" | "image"): { tags: string[]; description: string } | null {
  const claudeBin = resolveClaudeBin();
  if (!claudeBin) return null;

  const frames: string[] = [];
  let tmpFrameDir: string | undefined;
  if (type === "video") {
    tmpFrameDir = join(tmpdir(), "lexdrive_" + hash(path + now()));
    mkdirSync(tmpFrameDir, { recursive: true });
    const pattern = join(tmpFrameDir, "f_%02d.jpg");
    spawnSync("ffmpeg", ["-i", path, "-vf", "fps=1/2,scale=640:-1", "-frames:v", "3", "-q:v", "3", pattern, "-y"], {
      encoding: "utf8",
      timeout: 30000,
    });
    if (existsSync(tmpFrameDir)) {
      for (const f of readdirSync(tmpFrameDir).filter((x) => x.endsWith(".jpg")).sort()) frames.push(join(tmpFrameDir, f));
    }
  } else {
    frames.push(path);
  }
  if (!frames.length) {
    if (tmpFrameDir) try { rmSync(tmpFrameDir, { recursive: true, force: true }); } catch { /* non-fatal */ }
    return null;
  }

  const prompt = `You are cataloguing a piece of b-roll footage for a video editor's media library.
Look at the attached frame(s) and return ONLY a JSON object:
{
  "tags": ["8-15 lowercase keyword tags: subject, setting, objects, mood, colors, action — searchable terms an editor would type"],
  "description": "one concise sentence describing what the footage shows"
}
Return ONLY valid JSON, no markdown.`;

  try {
    const fileArgs: string[] = [];
    for (const f of frames.slice(0, 3)) fileArgs.push("--file", f);
    const r = spawnSync(claudeBin, ["-p", prompt, ...fileArgs, "--output-format", "text"], {
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
      timeout: 60000,
    });
    const out = (r.stdout ?? "").trim();
    const m = out.match(/\{[\s\S]*\}/);
    if (m) {
      const j = JSON.parse(m[0]) as { tags?: unknown; description?: unknown };
      const tags = Array.isArray(j.tags) ? j.tags.map((t) => String(t).toLowerCase().trim()).filter(Boolean) : [];
      const description = typeof j.description === "string" ? j.description : "";
      if (tags.length) return { tags, description };
    }
    return null;
  } catch {
    return null;
  } finally {
    if (tmpFrameDir) try { rmSync(tmpFrameDir, { recursive: true, force: true }); } catch { /* non-fatal */ }
  }
}

/* Derive crude tags from a filename when vision is unavailable:
   "sunset_beach drone-04.mp4" → ["sunset", "beach", "drone"]. */
function filenameTags(file: string): string[] {
  return basename(file, extname(file))
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2 && !/^\d+$/.test(w));
}

/* ── add ───────────────────────────────────────────────────────────────────── */

export function addAsset(srcPath: string, opts: { tags?: string[]; description?: string } = {}): InventoryAsset {
  if (!existsSync(srcPath)) throw new Error(`file not found: ${srcPath}`);
  const ext = extname(srcPath).toLowerCase();
  const type: "video" | "image" = VIDEO_EXT.has(ext) ? "video" : IMAGE_EXT.has(ext) ? "image" : (() => {
    throw new Error(`unsupported media type: ${ext} (videos: ${[...VIDEO_EXT].join(",")}; images: ${[...IMAGE_EXT].join(",")})`);
  })();

  mkdirSync(ASSETS_DIR, { recursive: true });
  const id = hash(srcPath + statSync(srcPath).size + now());
  const file = `${id}${ext}`;
  copyFileSync(srcPath, join(ASSETS_DIR, file));

  const probe = ffprobe(join(ASSETS_DIR, file));
  const orientation =
    probe.width && probe.height
      ? probe.width > probe.height
        ? "landscape"
        : probe.width < probe.height
          ? "portrait"
          : "square"
      : undefined;

  const vision = opts.tags?.length ? null : visionTag(join(ASSETS_DIR, file), type);
  const tags = Array.from(
    new Set([...(opts.tags ?? []), ...(vision?.tags ?? []), ...filenameTags(srcPath)].map((t) => t.toLowerCase().trim()).filter(Boolean)),
  );
  const description = opts.description ?? vision?.description ?? "";

  const asset: InventoryAsset = {
    id,
    file,
    type,
    tags,
    description,
    durationSec: probe.durationSec,
    width: probe.width,
    height: probe.height,
    orientation,
    addedAt: now(),
    source: basename(srcPath),
  };

  const f = loadInventory();
  f.assets.unshift(asset);
  saveInventory(f);
  return asset;
}

/* ── search ────────────────────────────────────────────────────────────────── */

const STOP = new Set(["the", "a", "an", "of", "and", "or", "in", "on", "at", "to", "for", "with", "is", "are", "shot", "scene", "video", "footage", "clip"]);
const tokenize = (s: string): string[] => s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !STOP.has(w));

function scoreAsset(asset: InventoryAsset, terms: string[]): number {
  if (!terms.length) return 0;
  const hay = new Set([...asset.tags.flatMap(tokenize), ...tokenize(asset.description), ...filenameTags(asset.source ?? asset.file)]);
  let score = 0;
  for (const t of terms) {
    if (hay.has(t)) score += 2; // exact term hit
    else if ([...hay].some((h) => h.includes(t) || t.includes(h))) score += 1; // partial
  }
  return score / terms.length;
}

export function searchInventory(query: string, limit = 10): Array<InventoryAsset & { score: number }> {
  const terms = tokenize(query);
  return loadInventory()
    .assets.map((a) => ({ ...a, score: scoreAsset(a, terms) }))
    .filter((a) => a.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/* ── b-roll resolution (the integration point for the render) ────────────────
   Find the best-matching owned asset for a scene query and stage it into the
   Remotion public/broll dir so the render can reference it. Returns a BrollAsset
   ({ src, type } with src relative to public/) or null when nothing clears the
   relevance bar — in which case the caller falls through to stock sources.

   For 9:16 renders we prefer portrait/square clips; a strong-enough match in
   any orientation still wins (Remotion cover-fits it). The `used` set carries
   inventory ids (prefixed `inv:`) so the same owned clip isn't reused across
   scenes of one video. */
export function resolveInventoryBroll(
  query: string,
  used?: Set<string>,
  opts: { vertical?: boolean; minScore?: number } = {},
): { src: string; type: "video" | "image" } | null {
  const minScore = opts.minScore ?? 0.34; // ~at least one solid term hit
  const candidates = searchInventory(query, 20).filter((a) => a.score >= minScore && !used?.has(`inv:${a.id}`));
  if (!candidates.length) return null;

  // Prefer the right orientation, then video over image, then higher score.
  const wantPortrait = opts.vertical ?? true;
  candidates.sort((a, b) => {
    const oa = orientFit(a, wantPortrait), ob = orientFit(b, wantPortrait);
    if (oa !== ob) return ob - oa;
    if (a.type !== b.type) return a.type === "video" ? -1 : 1;
    return b.score - a.score;
  });

  const pick = candidates[0];
  used?.add(`inv:${pick.id}`);

  mkdirSync(BROLL_DIR, { recursive: true });
  const ext = extname(pick.file);
  const rel = `broll/inv_${pick.id}${ext}`;
  const abs = join(BROLL_DIR, `inv_${pick.id}${ext}`);
  if (!existsSync(abs)) {
    try {
      copyFileSync(join(ASSETS_DIR, pick.file), abs);
    } catch {
      return null; // source vanished — let caller fall back to stock
    }
  }
  return { src: rel, type: pick.type };
}

function orientFit(a: InventoryAsset, wantPortrait: boolean): number {
  if (!a.orientation || a.orientation === "square") return 1;
  if (wantPortrait) return a.orientation === "portrait" ? 2 : 0;
  return a.orientation === "landscape" ? 2 : 0;
}

export { INVENTORY_DIR, ASSETS_DIR };
