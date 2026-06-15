import { existsSync, readdirSync } from "node:fs";
import { join, extname, basename } from "node:path";
import { REPO_ROOT } from "../../../lib/data";
import { currentContext, ctxCan, forbidden } from "../../../lib/tenancy";

export const dynamic = "force-dynamic";

/* OVERLAY + SFX ASSET CATALOG.
   GET /api/assets            → overlay catalog { emoji, shapes, logos }
   GET /api/assets?kind=sfx   → { sfx: [{ src, name }] }

   Backs the editor's "Add overlay" picker and the mixer's SFX picker. The data
   shapes mirror packages/engine/src/assets.ts (and scene.style.overlays in
   @os/schemas: type sticker|shape|image|logo|emoji|text, shape ∈ rect|circle|
   triangle|star|arrow|line). Logos/SFX are scanned from remotion public so new
   files appear automatically; emoji + shapes are a curated built-in set. This
   route reimplements the catalog locally (rather than importing the engine's
   .ts module) to stay self-contained under Next's bundler — same pattern as the
   waveform route. */

const REMOTION_PUBLIC = join(REPO_ROOT, "packages", "remotion", "public");

const EMOJI: { emoji: string; keyword: string }[] = [
  { emoji: "🔥", keyword: "fire hot trending" },
  { emoji: "✅", keyword: "check done success" },
  { emoji: "❌", keyword: "cross wrong fail" },
  { emoji: "⚠️", keyword: "warning caution" },
  { emoji: "💡", keyword: "idea bulb insight" },
  { emoji: "🚀", keyword: "rocket launch ship" },
  { emoji: "⭐", keyword: "star favorite rating" },
  { emoji: "💯", keyword: "100 perfect score" },
  { emoji: "👀", keyword: "eyes look watch" },
  { emoji: "🤯", keyword: "mind blown shock" },
  { emoji: "🧠", keyword: "brain smart think" },
  { emoji: "⚡", keyword: "fast speed bolt energy" },
  { emoji: "💰", keyword: "money cash bag" },
  { emoji: "💸", keyword: "money flying spend" },
  { emoji: "📈", keyword: "chart up growth" },
  { emoji: "📉", keyword: "chart down loss" },
  { emoji: "🎯", keyword: "target goal aim" },
  { emoji: "🛠️", keyword: "tools build dev" },
  { emoji: "💻", keyword: "laptop code dev" },
  { emoji: "🤖", keyword: "robot ai bot" },
  { emoji: "📌", keyword: "pin save note" },
  { emoji: "🔑", keyword: "key access secret" },
  { emoji: "🏆", keyword: "trophy win best" },
  { emoji: "👇", keyword: "point down below" },
  { emoji: "👉", keyword: "point right next" },
  { emoji: "🤔", keyword: "thinking hmm question" },
  { emoji: "😱", keyword: "scream shock omg" },
  { emoji: "🙌", keyword: "raise hands celebrate" },
  { emoji: "🎉", keyword: "party celebrate launch" },
  { emoji: "🔒", keyword: "lock secure private" },
];

const SHAPES: { shape: string; name: string }[] = [
  { shape: "rect", name: "Rectangle" },
  { shape: "circle", name: "Circle" },
  { shape: "triangle", name: "Triangle" },
  { shape: "star", name: "Star" },
  { shape: "arrow", name: "Arrow" },
  { shape: "line", name: "Line" },
];

const IMAGE_EXT = [".png", ".svg", ".jpg", ".jpeg", ".webp", ".gif"];
const SFX_EXT = [".wav", ".mp3", ".m4a", ".aac", ".ogg", ".flac"];

function prettyName(stem: string): string {
  return stem
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function listDir(sub: string, exts: string[], prefix: string): { src: string; name: string }[] {
  const dir = join(REMOTION_PUBLIC, sub);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => exts.includes(extname(f).toLowerCase()))
    .sort()
    .map((f) => ({ src: `${prefix}${f}`, name: prettyName(basename(f, extname(f))) }));
}

export async function GET(req: Request) {
  // The overlay/SFX catalog feeds the editor's authoring pickers — gate it to
  // members who can create content (the catalog itself holds no tenant data).
  const ctx = await currentContext();
  if (!ctxCan(ctx, "content.create")) return forbidden("content.create");

  const url = new URL(req.url);
  const kind = (url.searchParams.get("kind") ?? "").trim().toLowerCase();

  if (kind === "sfx") {
    return Response.json({ sfx: listDir("sfx", SFX_EXT, "sfx/") });
  }

  // default: overlay catalog (emoji + shapes + scanned logos)
  return Response.json({
    emoji: EMOJI,
    shapes: SHAPES,
    logos: listDir("logos", IMAGE_EXT, "logos/"),
  });
}
