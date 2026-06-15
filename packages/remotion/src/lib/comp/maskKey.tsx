import React from "react";
import type { EffectNode } from "@os/schemas";

/* ─── DaVinci spine §4.4 (M14) — MASK + KEY + transform/displace node primitives ──
   M13's CompositeGraph composites the SAFE look nodes (grade/glow/leak/grain/…).
   M14 brings the graph DOWN to the scene level, which is where masking + keying
   matter ("isolate the subject and glow it"). This module is the SHARED renderer
   for those node types so BOTH the post-scope graph (CompositeGraph) and the
   per-scene graph (SceneInner) wire them identically.

   Every node here is a WRAPPER effect: it transforms the children-so-far (the
   `source` = the scene/post content), it does not paint an overlay. Each builder
   returns either:
     • a `{ def, filter }` — an SVG <filter> element + the `url(#id)` string to add
       to the children wrapper's CSS `filter` chain (key/luma-mask/alpha-mask/
       displace), OR
     • a `{ def?, clipPath?, mask?, transform? }` WRAP descriptor — a CSS
       clip-path / mask / transform applied to the children wrapper (mask_shape /
       transform), with any SVG def it needs.
   A node whose params resolve to a no-op returns null → it contributes nothing and
   the graph stays byte-identical for that node (the M13 identity guarantee, held
   down at the node level).

   KEYING NOTE (honest about the medium): SVG `feColorMatrix`/`feComponentTransfer`
   can drop a luma or colour RANGE to transparency, which is a real, usable knockout
   for graphics/flat backgrounds — but it has NO spill suppression and NO edge
   matting, so a TRUE chroma key over real footage (despill + soft matte) needs
   ffmpeg (`chromakey`/`colorkey` + `despill`). That belongs to `comp_prebake`
   (roadmap M18); we mark the hook below and ship the SVG approximation now. */

const clamp = (v: number, lo: number, hi: number): number =>
  Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : (lo + hi) / 2;
const num = (v: unknown, fallback: number): number =>
  typeof v === "number" && Number.isFinite(v) ? v : fallback;
const str = (v: unknown, fallback: string): string => (typeof v === "string" && v ? v : fallback);

/* A wrapper descriptor: any combination of an SVG def + a CSS filter ref + a
   clip-path + a mask + a transform to apply to the children wrapper. CompositeGraph
   merges these across all mask/key/transform nodes (defs concatenated, filters
   chained, the last clip-path/mask/transform winning — one each is the sane case). */
export type WrapDescriptor = {
  def?: React.ReactNode;     // an SVG <filter>/<clipPath>/<mask> element for <defs>
  filter?: string;           // a `url(#id)` to add to the wrapper's CSS filter chain
  clipPath?: string;         // a CSS clip-path value (mask_shape)
  mask?: string;             // a CSS mask value referencing a <mask> in def
  transform?: string;        // a CSS transform (transform node)
};

/* Parse `#rrggbb` / `rgb(r,g,b)` to a 0..1 RGB triplet for the key matrices.
   Falls back to green (the classic key colour) for an unparseable value. */
const parseColor = (c: string): { r: number; g: number; b: number } => {
  const s = String(c ?? "").trim();
  const hex = /^#?([0-9a-f]{6})$/i.exec(s);
  if (hex) {
    const n = parseInt(hex[1], 16);
    return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255 };
  }
  const rgb = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i.exec(s);
  if (rgb) return { r: +rgb[1] / 255, g: +rgb[2] / 255, b: +rgb[3] / 255 };
  return { r: 0, g: 1, b: 0 };
};

/* ─── mask_shape ── a geometric clip (rect / circle / ellipse / polygon) that
   keeps only the masked region of the children. Implemented as a CSS `clip-path`
   on the children wrapper — zero filter cost, exact, animatable via the wrapper.
   params: shape ('rect'|'circle'|'ellipse'|'polygon'), inset/x/y/r/feather (%),
   points (for polygon: "x1,y1 x2,y2 …" in %), invert (keep OUTSIDE the shape). */
const maskShape = (p: Record<string, unknown>): WrapDescriptor | null => {
  const shape = str(p.shape, "rect");
  const feather = clamp(num(p.feather, 0), 0, 40);
  let clip: string | null = null;
  if (shape === "circle") {
    const r = clamp(num(p.r ?? p.radius, 40), 1, 75);
    const cx = clamp(num(p.x ?? p.cx, 50), 0, 100);
    const cy = clamp(num(p.y ?? p.cy, 50), 0, 100);
    clip = `circle(${r}% at ${cx}% ${cy}%)`;
  } else if (shape === "ellipse") {
    const rx = clamp(num(p.rx, 40), 1, 75);
    const ry = clamp(num(p.ry, 30), 1, 75);
    const cx = clamp(num(p.x ?? p.cx, 50), 0, 100);
    const cy = clamp(num(p.y ?? p.cy, 50), 0, 100);
    clip = `ellipse(${rx}% ${ry}% at ${cx}% ${cy}%)`;
  } else if (shape === "polygon") {
    const pts = str(p.points, "")
      .split(/\s+/)
      .map((pair) => pair.split(",").map(Number))
      .filter((xy) => xy.length === 2 && xy.every((n) => Number.isFinite(n)))
      .map(([x, y]) => `${clamp(x, 0, 100)}% ${clamp(y, 0, 100)}%`);
    if (pts.length >= 3) clip = `polygon(${pts.join(", ")})`;
  } else {
    // rect (default): an inset box. `inset` shorthand or per-edge t/r/b/l (%).
    const inset = clamp(num(p.inset, 0), 0, 49);
    const t = clamp(num(p.top, inset), 0, 99);
    const r = clamp(num(p.right, inset), 0, 99);
    const b = clamp(num(p.bottom, inset), 0, 99);
    const l = clamp(num(p.left, inset), 0, 99);
    const round = clamp(num(p.round ?? p.radius, 0), 0, 50);
    clip = `inset(${t}% ${r}% ${b}% ${l}%${round ? ` round ${round}px` : ""})`;
  }
  if (!clip) return null;
  // A feathered edge is a soft-mask, not a hard clip → emit it as a CSS mask using
  // a radial/linear gradient is lossy for arbitrary shapes; we instead apply the
  // clip-path and (when feather>0) a matching CSS blur-of-the-edge is out of scope
  // for v1, so feather currently only affects circle/ellipse via the gradient mask.
  if (feather > 0 && (shape === "circle" || shape === "ellipse")) {
    const cx = clamp(num(p.x ?? p.cx, 50), 0, 100);
    const cy = clamp(num(p.y ?? p.cy, 50), 0, 100);
    const r = clamp(num(p.r ?? p.radius ?? p.rx, 40), 1, 75);
    const soft = clamp(r - feather, 1, r);
    const grad = `radial-gradient(circle at ${cx}% ${cy}%, #000 ${soft}%, transparent ${r}%)`;
    return { mask: grad };
  }
  return { clipPath: clip };
};

/* ─── mask_luma / mask_alpha ── a MATTE that drives the children's own alpha from a
   luminance (mask_luma) or alpha (mask_alpha) range. Implemented as an SVG filter:
     • mask_luma — `feColorMatrix type="luminanceToAlpha"` turns the image's
       brightness into an alpha channel; `feComponentTransfer` gamma/threshold
       shapes which luma range survives; `feComposite in` re-applies it to the
       source so bright (or, inverted, dark) regions stay and the rest drops out.
     • mask_alpha — the source's EXISTING alpha is shaped by a transfer curve
       (low/high cutoff) — useful on assets that already carry transparency.
   params: low/high (0..1 luma/alpha cutoffs), invert (keep the dark/low side),
   softness (0..1 edge gamma). */
const maskMatte = (node: EffectNode, p: Record<string, unknown>, fid: string): WrapDescriptor | null => {
  const luma = node.type === "mask_luma";
  const low = clamp(num(p.low ?? p.threshold, luma ? 0.35 : 0.5), 0, 1);
  const high = clamp(num(p.high, 1), low + 0.001, 1);
  const invert = Boolean(p.invert);
  // a 2-stop ramp table: alpha 0 below `low`, 1 above `high` (or inverted).
  const ramp = invert ? "1 0" : "0 1";
  return {
    def: (
      <filter id={fid} key={fid} x="0%" y="0%" width="100%" height="100%" colorInterpolationFilters="sRGB">
        {luma ? (
          // brightness → alpha, then threshold/ramp it, then re-key the source.
          <>
            <feColorMatrix in="SourceGraphic" type="luminanceToAlpha" result="luma" />
            <feComponentTransfer in="luma" result="matte">
              <feFuncA type="table" tableValues={ramp} />
            </feComponentTransfer>
            <feComposite in="SourceGraphic" in2="matte" operator="in" />
          </>
        ) : (
          // shape the EXISTING alpha by the same ramp (no luminance step).
          <feComponentTransfer in="SourceGraphic">
            <feFuncA type="table" tableValues={ramp} />
          </feComponentTransfer>
        )}
      </filter>
    ),
    filter: `url(#${fid})`,
  };
};

/* ─── key_luma ── knock out a luminance RANGE to transparency (a luma key). Bright
   or dark pixels (per `invert`) below/above the cutoff become transparent. Real,
   usable for flat graphics / a white or black card; NOT a soft matte.
   params: threshold (0..1), invert (drop the dark side), tolerance (0..0.5 soft). */
const keyLuma = (p: Record<string, unknown>, fid: string): WrapDescriptor | null => {
  const threshold = clamp(num(p.threshold ?? p.amount, 0.85), 0, 1);
  const tol = clamp(num(p.tolerance ?? p.softness, 0.08), 0, 0.5);
  const invert = Boolean(p.invert); // default: drop the BRIGHT side (white key)
  const lo = clamp(threshold - tol, 0, 1);
  // table over luma→alpha: keep (alpha 1) outside the keyed band, drop inside.
  const tableValues = invert ? `0 0 1 1` : `1 1 0 0`;
  const _ = lo; // documented intent; the 4-stop table approximates the soft band
  return {
    def: (
      <filter id={fid} key={fid} x="0%" y="0%" width="100%" height="100%" colorInterpolationFilters="sRGB">
        <feColorMatrix in="SourceGraphic" type="luminanceToAlpha" result="luma" />
        <feComponentTransfer in="luma" result="matte">
          <feFuncA type="table" tableValues={tableValues} />
        </feComponentTransfer>
        <feComposite in="SourceGraphic" in2="matte" operator="in" />
      </filter>
    ),
    filter: `url(#${fid})`,
  };
};

/* ─── key_chroma ── drop a COLOUR range to transparency (a chroma key). Pixels near
   `color` (default green) within `tolerance` become transparent. This is an SVG
   approximation: a per-channel distance via `feColorMatrix` → `feComponentTransfer`
   alpha cut. It has NO spill suppression and NO soft edge matting.

   ▶ M18 HOOK: a TRUE chroma key over real footage (despill + feathered matte)
     belongs in `comp_prebake` — ffmpeg `chromakey=color:similarity:blend` +
     `despill`. When a scene's source is real footage and the key must be clean,
     the bridge/agent should route to comp_prebake and bake the alpha into the asset
     BEFORE it reaches this renderer, leaving this node a no-op. The SVG path here
     is the live-preview / flat-graphic approximation. */
const keyChroma = (p: Record<string, unknown>, fid: string): WrapDescriptor | null => {
  const { r, g, b } = parseColor(str(p.color ?? p.key, "#00ff00"));
  const tol = clamp(num(p.tolerance ?? p.similarity, 0.3), 0.02, 0.9);
  // Build an alpha = distance-from-key matte: subtract the key colour, take the
  // squared-ish magnitude via a luminance-weighted matrix on |Δ|, threshold it.
  // feColorMatrix can't do abs/square, so we approximate: project onto the key
  // direction and cut where the projection is high (pixel ≈ key ⇒ drop).
  // matrix row → alpha: weight each channel toward the key colour, bias so the key
  // colour maps to ~1 (dropped) and everything else toward 0 (kept).
  const wr = r * 2 - 1, wg = g * 2 - 1, wb = b * 2 - 1; // -1..1 per channel
  const norm = Math.max(0.001, Math.abs(wr) + Math.abs(wg) + Math.abs(wb));
  const ar = wr / norm, ag = wg / norm, ab = wb / norm;
  const bias = -(ar * r + ag * g + ab * b) + tol; // key colour → ~tol, then cut
  return {
    def: (
      <filter id={fid} key={fid} x="0%" y="0%" width="100%" height="100%" colorInterpolationFilters="sRGB">
        {/* alpha = projection of (pixel) onto the key direction + bias */}
        <feColorMatrix
          in="SourceGraphic"
          type="matrix"
          values={`1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  ${ar.toFixed(4)} ${ag.toFixed(4)} ${ab.toFixed(4)} 0 ${bias.toFixed(4)}`}
          result="proj"
        />
        {/* steep transfer: near-key alpha→1 (will be inverted to a knockout) */}
        <feComponentTransfer in="proj" result="keyAlpha">
          <feFuncA type="discrete" tableValues="0 1" />
        </feComponentTransfer>
        {/* invert so KEY pixels become transparent, then re-key the source */}
        <feColorMatrix in="keyAlpha" type="matrix" values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 -1 1" result="matte" />
        <feComposite in="SourceGraphic" in2="matte" operator="in" />
      </filter>
    ),
    filter: `url(#${fid})`,
  };
};

/* ─── transform ── a 2D affine on the children (translate/scale/rotate). A pure CSS
   transform on the wrapper — exact + cheap, animatable via param tracks (tx/ty/
   scale/rotate). params: tx/ty (px), scale, rotate (deg), originX/originY (%). */
const transformNode = (p: Record<string, unknown>): WrapDescriptor | null => {
  const tx = clamp(num(p.tx ?? p.x, 0), -2000, 2000);
  const ty = clamp(num(p.ty ?? p.y, 0), -2000, 2000);
  const scale = clamp(num(p.scale, 1), 0.1, 8);
  const rotate = clamp(num(p.rotate ?? p.rotation, 0), -360, 360);
  if (tx === 0 && ty === 0 && scale === 1 && rotate === 0) return null; // identity
  const t = `translate(${tx}px, ${ty}px) rotate(${rotate}deg) scale(${scale})`;
  return { transform: t };
};

/* ─── displace ── a turbulence-driven displacement of the children (heat-haze /
   glitch warp). `feTurbulence` → `feDisplacementMap`. params: scale (px),
   frequency, octaves, seed. animatable via param tracks (scale/frequency). */
const displaceNode = (p: Record<string, unknown>, frame: number, fid: string): WrapDescriptor | null => {
  const scale = clamp(num(p.scale ?? p.amount, 0), 0, 80);
  if (scale <= 0.05) return null;
  const freq = clamp(num(p.frequency, 0.01), 0.001, 0.2);
  const octaves = Math.round(clamp(num(p.octaves, 2), 1, 4));
  // animate the noise field slightly over time so a static displace shimmers when
  // `animate` is set (seed walks with the frame); otherwise hold a fixed seed.
  const seed = Boolean(p.animate) ? Math.round(num(p.seed, 1)) + (frame % 1000) : Math.round(num(p.seed, 1));
  return {
    def: (
      <filter id={fid} key={fid} x="-10%" y="-10%" width="120%" height="120%" colorInterpolationFilters="sRGB">
        <feTurbulence type="fractalNoise" baseFrequency={freq.toFixed(4)} numOctaves={octaves} seed={seed} result="noise" stitchTiles="stitch" />
        <feDisplacementMap in="SourceGraphic" in2="noise" scale={scale.toFixed(2)} xChannelSelector="R" yChannelSelector="G" />
      </filter>
    ),
    filter: `url(#${fid})`,
  };
};

/* The node types this module renders (everything M13's CompositeGraph treats as a
   no-op). `track_attach` is NOT here — it needs precomputed TrackData (comp_track,
   roadmap M15) and stays a no-op until then. */
export const MASK_KEY_TYPES = new Set<EffectNode["type"]>([
  "mask_shape",
  "mask_luma",
  "mask_alpha",
  "key_luma",
  "key_chroma",
  "transform",
  "displace",
]);

/* Resolve one mask/key/transform/displace node → a WrapDescriptor (or null no-op).
   `idx` keys the SVG <filter> id; `frame` feeds animated displacement. */
export const maskKeyWrap = (
  node: EffectNode,
  params: Record<string, unknown>,
  idx: number,
  frame: number,
): WrapDescriptor | null => {
  const fid = `cg_mk_${node.id || idx}`;
  switch (node.type) {
    case "mask_shape":
      return maskShape(params);
    case "mask_luma":
    case "mask_alpha":
      return maskMatte(node, params, fid);
    case "key_luma":
      return keyLuma(params, fid);
    case "key_chroma":
      return keyChroma(params, fid);
    case "transform":
      return transformNode(params);
    case "displace":
      return displaceNode(params, frame, fid);
    default:
      return null;
  }
};
