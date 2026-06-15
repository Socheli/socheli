import { existsSync, readdirSync } from "node:fs";
import { join, dirname, extname, basename } from "node:path";
import { fileURLToPath } from "node:url";

/* ─── Overlay asset catalog ────────────────────────────────────────────────
   The built-in catalog that backs the editor's "Add overlay" picker. It maps
   1:1 onto scene.style.overlays in @os/schemas (type: sticker|shape|image|
   logo|emoji|text; shape ∈ rect|circle|triangle|star|arrow|line). Everything
   here is static/curated; the api/assets route serves it (and can later merge
   in user-uploaded stickers). Purely additive — nothing renders unless the
   editor actually places an overlay. */

const HERE = dirname(fileURLToPath(import.meta.url));
const REMOTION_PUBLIC = join(HERE, "..", "..", "remotion", "public");

/* The exact shape kinds the schema's overlay.shape enum accepts. Keeping this
   list here (rather than importing the zod enum) keeps the catalog a plain data
   module with no schema/runtime coupling. */
export type OverlayShape = "rect" | "circle" | "triangle" | "star" | "arrow" | "line";

export type EmojiAsset = { emoji: string; keyword: string };
export type ShapeAsset = { shape: OverlayShape; name: string };
export type LogoAsset = { src: string; name: string };

/* A curated emoji set covering the reactions/markers a faceless tech/builder
   video tends to want (status, emphasis, money, dev, motion). Each entry pairs
   the glyph with a search keyword for the picker. type: "emoji", content holds
   the glyph. */
export const EMOJI: EmojiAsset[] = [
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

/* The shape primitives the overlay renderer supports, matching the schema enum.
   type: "shape", shape names the geometry, color tints it. */
export const SHAPES: ShapeAsset[] = [
  { shape: "rect", name: "Rectangle" },
  { shape: "circle", name: "Circle" },
  { shape: "triangle", name: "Triangle" },
  { shape: "star", name: "Star" },
  { shape: "arrow", name: "Arrow" },
  { shape: "line", name: "Line" },
];

const IMAGE_EXT = [".png", ".svg", ".jpg", ".jpeg", ".webp", ".gif"];

/* Logos shipped under remotion public/logos — placed as type:"logo" overlays.
   `src` is the public-relative path Remotion's staticFile() expects. Scans the
   dir so dropping a new logo file in makes it appear in the picker; returns []
   if the dir is missing. */
export function listLogos(): LogoAsset[] {
  const dir = join(REMOTION_PUBLIC, "logos");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => IMAGE_EXT.includes(extname(f).toLowerCase()))
    .map((f) => ({
      src: `logos/${f}`,
      name: prettyName(basename(f, extname(f))),
    }));
}

/* Turn a file stem like "claude-labrato-icon" into "Claude Labrato Icon". */
function prettyName(stem: string): string {
  return stem
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export type OverlayCatalog = {
  emoji: EmojiAsset[];
  shapes: ShapeAsset[];
  logos: LogoAsset[];
};

/* The full overlay catalog the editor's "Add overlay" picker consumes. */
export function overlayCatalog(): OverlayCatalog {
  return { emoji: EMOJI, shapes: SHAPES, logos: listLogos() };
}

/* ─── SFX library ──────────────────────────────────────────────────────────
   Lists the SFX clips available to the mixer/editor. Scans remotion public/sfx
   (the same dir media.ts's synthSfx writes to) so any clip dropped in — or the
   procedural whoosh/impact/riser — shows up. `src` is public-relative
   ("sfx/<file>") to match SfxCue.src in ./types.ts. Returns [] if the dir
   doesn't exist yet. */
const SFX_EXT = [".wav", ".mp3", ".m4a", ".aac", ".ogg", ".flac"];

export type SfxAsset = { src: string; name: string };

export function listSfx(): SfxAsset[] {
  const dir = join(REMOTION_PUBLIC, "sfx");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => SFX_EXT.includes(extname(f).toLowerCase()))
    .sort()
    .map((f) => ({ src: `sfx/${f}`, name: prettyName(basename(f, extname(f))) }));
}
