import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

/* ─── Motion-graphics vector asset resolver (offline, optional) ─────────────
   The deep-research conclusion (2026-06-08): premium pure-mograph needs EDITABLE
   vector assets (SVG / Lottie), not pixel-diffusion video. The best open models
   — OmniSVG (text/image → editable SVG) and OmniLottie (text/image/video →
   editable Lottie, ~88% valid output vs ~12% for general LLMs) — are GPU models,
   so they belong in an OFFLINE asset-generation step (a cache), never the
   per-frame render loop.

   This module is that integration point, mirroring broll.ts's sdturbo pattern:
   a content-addressed cache + an env-gated Python backend that fails OPEN. With
   no backend configured it returns null, and callers fall back to the scene's
   native shapes / Lucide icons — so the pipeline never breaks. Flip it on by
   setting MOGRAPH_ASSET_PY to a python that can run scripts/omnisvg.py (a GPU box
   or a hosted endpoint wrapper).

   NOTE: not yet wired into a render path — Milestone 2. The device_mockup / bento
   scenes render premium with native shapes today; this lets a designer-grade SVG
   library drop in later without touching the scenes. */

const HERE = dirname(fileURLToPath(import.meta.url));
const REMOTION_PUBLIC = join(HERE, "..", "..", "remotion", "public");
const ASSET_DIR = join(REMOTION_PUBLIC, "mograph");
const SCRIPTS = join(HERE, "..", "scripts");

const hash = (s: string) => createHash("sha1").update(s).digest("hex").slice(0, 16);

export type VectorAsset = { src: string; type: "svg" | "lottie" }; // src relative to public/

/** The Python interpreter for the GPU asset backend (OmniSVG/OmniLottie wrapper).
    Unset → the backend is disabled and resolveVectorAsset returns null. */
const ASSET_PY = process.env.MOGRAPH_ASSET_PY;

export function mographAssetsConfigured(): boolean {
  return !!ASSET_PY && existsSync(ASSET_PY) && existsSync(join(SCRIPTS, "omnisvg.py"));
}

/**
 * Resolve one editable vector asset for a prompt. `kind` picks the model:
 *   "svg"    → OmniSVG (icons, illustrations, logos)
 *   "lottie" → OmniLottie (looping animated vector)
 * Content-addressed cache, so re-renders are instant and generation runs once.
 * Returns null when no backend is configured (caller falls back to native shapes).
 */
export function resolveVectorAsset(prompt: string, kind: "svg" | "lottie" = "svg"): VectorAsset | null {
  if (!prompt?.trim() || !mographAssetsConfigured()) return null;
  mkdirSync(ASSET_DIR, { recursive: true });
  const ext = kind === "lottie" ? "json" : "svg";
  const h = hash(`${kind}:${prompt}`);
  const rel = `mograph/${h}.${ext}`;
  const abs = join(ASSET_DIR, `${h}.${ext}`);
  if (existsSync(abs)) return { src: rel, type: kind };

  // The backend is heavy (GPU model load); give it a generous timeout and treat
  // any failure as "no asset" so the render proceeds with native graphics.
  const r = spawnSync(ASSET_PY!, [join(SCRIPTS, "omnisvg.py"), kind, prompt, abs], {
    encoding: "utf8",
    timeout: 1000 * 60 * 8,
  });
  return r.status === 0 && existsSync(abs) ? { src: rel, type: kind } : null;
}
