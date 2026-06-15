import React from "react";
import { AbsoluteFill } from "remotion";
import type { EffectGraph, EffectNode, ColorGrade as ColorGradeT } from "@os/schemas";
import { GradePipeline, gradeToFilterId, gradeIsIdentity } from "./lib/grade.tsx";
import { resolveParamTracks } from "./lib/keyframes.ts";
import { MASK_KEY_TYPES, maskKeyWrap, type WrapDescriptor } from "./lib/comp/maskKey.tsx";

/* ─── DaVinci spine §4.4 (M13) — post-scope EFFECT NODE GRAPH renderer ────────
   `CompositeGraph` renders an `@os/schemas` EffectGraph as layered compositing
   OVER its children (the rendered post). It is the composable replacement for the
   flat global look-stack (the gradient `ColorGrade` + grain/leak/chroma): instead
   of a fixed chain, the agent wires a DAG of effect nodes (grade → glow → leak →
   blend …), each animatable per-param over the composition's frames.

   SCOPE / SAFETY: this is the POST-SCOPE renderer (over the whole composition,
   OUTSIDE the scene sequencer) — so heavy SVG filters never multiply per-scene
   and we dodge any residual TransitionSeries-class render risk (roadmap §4.4 risk
   "ship post-scope graphs first").

   IDENTITY GUARANTEE (load-bearing): an EMPTY or ABSENT graph renders the children
   UNCHANGED — `CompositeGraph` returns `<>{children}</>` with no wrapper, no
   filter, no overlay. Post.tsx only mounts this when `storyboard.comp` is present,
   and even then a graph whose every node resolves to a no-op is the identity.

   TOPO-SORT: nodes wire by id via `inputs`. We order them by a Kahn topological
   sort so a node is composited after the nodes it depends on. A `source` node is
   the children (the rendered post); every other supported node is a LOOK applied
   over what came before. Cycles or dangling inputs degrade gracefully (the node is
   appended in declared order / treated as a leaf) — never throw, never block the
   render (bridge discipline: clamp/skip, never crash). */

// The node types this renderer composites. M13 shipped the look set below; M14
// adds the mask/key/transform/displace set (MASK_KEY_TYPES from lib/comp/maskKey),
// which apply as WRAPPER effects on the source (children). `track_attach` remains a
// no-op until M15 (it needs precomputed TrackData). A graph that references an
// unsupported type simply skips it, staying identity for that part.
const LOOK_TYPES = new Set<EffectNode["type"]>([
  "source",
  "grade",
  "glow",
  "bloom",
  "light_leak",
  "chroma_ab",
  "grain",
  "vignette",
  "blur",
  "sharpen",
  "blend",
]);
const SAFE_TYPES = new Set<EffectNode["type"]>([...LOOK_TYPES, ...MASK_KEY_TYPES]);

const clamp = (v: number, lo: number, hi: number): number =>
  Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : (lo + hi) / 2;
const num = (v: unknown, fallback: number): number =>
  typeof v === "number" && Number.isFinite(v) ? v : fallback;
const str = (v: unknown, fallback: string): string => (typeof v === "string" && v ? v : fallback);

/* Resolve a node's effective params at `frame`: static `params` overlaid with any
   keyframe-track values (resolveParamTracks). A track-less node returns its static
   params verbatim, so it's byte-identical to a non-animated authoring. */
const resolveNodeParams = (node: EffectNode, frame: number, durF: number): Record<string, unknown> => {
  const base: Record<string, unknown> = { ...((node.params as Record<string, unknown>) ?? {}) };
  const animated = resolveParamTracks(node.keyframes as any, frame, durF);
  if (animated) for (const k of Object.keys(animated)) base[k] = animated[k];
  return base;
};

/* Kahn topological sort over the node DAG by `inputs`. Returns nodes in an order
   where every node follows the nodes it depends on. Unsupported / cyclic / dangling
   refs never break the order — remaining nodes are appended in declared order. */
const topoSort = (nodes: EffectNode[]): EffectNode[] => {
  const byId = new Map<string, EffectNode>();
  for (const n of nodes) if (n?.id) byId.set(n.id, n);
  const indeg = new Map<string, number>();
  for (const n of nodes) {
    if (!n?.id) continue;
    // only count inputs that actually resolve to a node in this graph (dangling
    // refs are ignored so a missing source/upstream never deadlocks the sort)
    const deps = (n.inputs ?? []).filter((i) => byId.has(i));
    indeg.set(n.id, deps.length);
  }
  const queue: string[] = [];
  for (const n of nodes) if (n?.id && (indeg.get(n.id) ?? 0) === 0) queue.push(n.id);
  const order: EffectNode[] = [];
  const seen = new Set<string>();
  while (queue.length) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const n = byId.get(id);
    if (n) order.push(n);
    // decrement dependents that list `id` as an input
    for (const m of nodes) {
      if (!m?.id || seen.has(m.id)) continue;
      if ((m.inputs ?? []).includes(id)) {
        const d = (indeg.get(m.id) ?? 1) - 1;
        indeg.set(m.id, d);
        if (d <= 0) queue.push(m.id);
      }
    }
  }
  // append anything left (cycle members) in declared order so nothing is dropped
  for (const n of nodes) if (n?.id && !seen.has(n.id)) order.push(n);
  return order;
};

/* ─── Node renderers — each is an AbsoluteFill LOOK over the children below ────
   They composite via mixBlendMode / SVG <filter> on a wrapper, mirroring the
   in-app primitives (grade.tsx, FilmGrain, #chroma) so the look matches the
   existing global stack. Each returns null when its resolved params are a no-op,
   so an identity node contributes nothing. */

// glow / bloom — a screen-blended blurred bright wash. `amount` 0..1 sets opacity,
// `radius` (px) the blur. bloom = a softer, wider, warmer variant of glow.
const GlowNode: React.FC<{ p: Record<string, unknown>; id: string; bloom?: boolean }> = ({ p, id, bloom }) => {
  const amount = clamp(num(p.amount ?? p.intensity, bloom ? 0.4 : 0.5), 0, 1);
  if (amount <= 0.01) return null;
  const radius = clamp(num(p.radius ?? p.blur, bloom ? 26 : 16), 0, 60);
  const color = str(p.color, bloom ? "rgba(255,244,228,0.9)" : "rgba(255,255,255,0.9)");
  const fid = `cg_glow_${id}`;
  return (
    <AbsoluteFill style={{ pointerEvents: "none", mixBlendMode: "screen", opacity: amount }} aria-hidden>
      <svg width={0} height={0} style={{ position: "absolute" }}>
        <defs>
          <filter id={fid} x="-20%" y="-20%" width="140%" height="140%" colorInterpolationFilters="sRGB">
            <feGaussianBlur stdDeviation={radius.toFixed(2)} />
          </filter>
        </defs>
      </svg>
      {/* a soft colour wash standing in for the blurred-highlights bloom */}
      <AbsoluteFill
        style={{
          background: bloom
            ? `radial-gradient(70% 60% at 50% 38%, ${color}, transparent 72%)`
            : `radial-gradient(60% 55% at 50% 42%, ${color}, transparent 68%)`,
          filter: `url(#${fid})`,
        }}
      />
    </AbsoluteFill>
  );
};

// light_leak — a warm diagonal flare overlay (screen-blended), with optional
// animated position (leakX/leakY) and angle. Mirrors lib/grade LightLeak.
const LightLeakNode: React.FC<{ p: Record<string, unknown> }> = ({ p }) => {
  const amount = clamp(num(p.amount ?? p.intensity, 0.4), 0, 1);
  if (amount <= 0.01) return null;
  const tint = str(p.color ?? p.tint, "rgba(255,196,138,0.9)");
  const angle = clamp(num(p.angle, 118), 0, 360);
  const x = clamp(num(p.leakX ?? p.x, 88), 0, 100);
  const y = clamp(num(p.leakY ?? p.y, 12), 0, 100);
  return (
    <AbsoluteFill style={{ pointerEvents: "none", opacity: Math.min(0.55, amount * 0.55), mixBlendMode: "screen" }} aria-hidden>
      <AbsoluteFill style={{ background: `linear-gradient(${angle}deg, transparent 40%, ${tint} 72%, transparent 86%)` }} />
      <AbsoluteFill style={{ background: `radial-gradient(600px 1200px at ${x}% ${y}%, rgba(255,214,170,0.6), transparent 70%)` }} />
    </AbsoluteFill>
  );
};

// grain — animated film-grain noise (reseeds per frame so it shimmers). Mirrors
// lib/grade FilmGrain but as a graph node (overlay-blended).
const GrainNode: React.FC<{ p: Record<string, unknown>; frame: number; w: number; h: number }> = ({ p, frame, w, h }) => {
  const opacity = clamp(num(p.amount ?? p.opacity, 0.06), 0, 0.5);
  if (opacity <= 0.002) return null;
  const freq = clamp(num(p.frequency, 0.82), 0.1, 1.5);
  const fid = `cg_grain_${frame}`;
  return (
    <svg width={w} height={h} style={{ position: "absolute", inset: 0, opacity, mixBlendMode: "overlay", pointerEvents: "none" }} aria-hidden>
      <filter id={fid}>
        <feTurbulence type="fractalNoise" baseFrequency={freq.toFixed(3)} numOctaves={2} seed={frame} stitchTiles="stitch" />
        <feColorMatrix type="saturate" values="0" />
      </filter>
      <rect width={w} height={h} filter={`url(#${fid})`} />
    </svg>
  );
};

// vignette — a radial darken at the edges (multiply). `amount` 0..1 sets depth.
const VignetteNode: React.FC<{ p: Record<string, unknown> }> = ({ p }) => {
  const amount = clamp(num(p.amount ?? p.intensity, 0.34), 0, 1);
  if (amount <= 0.01) return null;
  const start = clamp(num(p.feather ?? p.start, 55), 20, 90);
  return (
    <AbsoluteFill
      style={{
        pointerEvents: "none",
        mixBlendMode: "multiply",
        background: `radial-gradient(1400px 1700px at 50% 50%, transparent ${start}%, rgba(0,0,0,${amount.toFixed(3)}) 100%)`,
      }}
      aria-hidden
    />
  );
};

/* The wrapper-filter look nodes (chroma_ab / blur / sharpen) don't paint an
   overlay — they apply an SVG <filter> to the children-so-far. We collect them as
   filter strings on the composite wrapper rather than as overlay layers. Each
   returns its `<defs>` filter element + the `url(#id)` string to add to the stack
   filter. */
const wrapperFilterDefs = (
  node: EffectNode,
  params: Record<string, unknown>,
  idx: number,
): { def: React.ReactNode; filter: string } | null => {
  const fid = `cg_wf_${node.id || idx}`;
  if (node.type === "blur") {
    const px = clamp(num(params.amount ?? params.radius ?? params.px, 4), 0, 40);
    if (px <= 0.05) return null;
    return {
      def: (
        <filter key={fid} id={fid} x="-10%" y="-10%" width="120%" height="120%" colorInterpolationFilters="sRGB">
          <feGaussianBlur stdDeviation={px.toFixed(2)} />
        </filter>
      ),
      filter: `url(#${fid})`,
    };
  }
  if (node.type === "sharpen") {
    const amt = clamp(num(params.amount ?? params.intensity, 0.6), 0, 3);
    if (amt <= 0.02) return null;
    // 3×3 unsharp convolution; centre = 1 + 4*amt, neighbours = -amt (divisor 1).
    const a = +amt.toFixed(3);
    const c = +(1 + 4 * amt).toFixed(3);
    const kernel = `0 ${-a} 0  ${-a} ${c} ${-a}  0 ${-a} 0`;
    return {
      def: (
        <filter key={fid} id={fid} x="-5%" y="-5%" width="110%" height="110%" colorInterpolationFilters="sRGB">
          <feConvolveMatrix order="3" preserveAlpha="true" kernelMatrix={kernel} />
        </filter>
      ),
      filter: `url(#${fid})`,
    };
  }
  if (node.type === "chroma_ab") {
    const dx = clamp(num(params.amount ?? params.offset ?? params.px, 2), 0, 16).toFixed(2);
    if (Number(dx) <= 0.02) return null;
    // RGB-split: R offset +dx, B offset -dx, screen-recombined (mirrors #chroma).
    return {
      def: (
        <filter key={fid} id={fid} x="-5%" y="-5%" width="110%" height="110%" colorInterpolationFilters="sRGB">
          <feColorMatrix type="matrix" values="1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0" result="r" />
          <feOffset in="r" dx={dx} dy="0" result="ro" />
          <feColorMatrix in="SourceGraphic" type="matrix" values="0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0" result="g" />
          <feColorMatrix in="SourceGraphic" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0" result="b" />
          <feOffset in="b" dx={`-${dx}`} dy="0" result="bo" />
          <feBlend in="ro" in2="g" mode="screen" result="rg" />
          <feBlend in="rg" in2="bo" mode="screen" />
        </filter>
      ),
      filter: `url(#${fid})`,
    };
  }
  return null;
};

/* CSS mixBlendMode for a `blend` node — sets how the NEXT overlay composites.
   Pulled from params.mode; defaults to "screen". An unknown mode is ignored. */
const BLEND_MODES = new Set([
  "normal", "multiply", "screen", "overlay", "darken", "lighten", "color-dodge",
  "color-burn", "hard-light", "soft-light", "difference", "exclusion", "hue",
  "saturation", "color", "luminosity",
]);

export const CompositeGraph: React.FC<{
  graph?: EffectGraph | null;
  w: number;
  h: number;
  frame: number;
  durF: number;
  children: React.ReactNode;
}> = ({ graph, w, h, frame, durF, children }) => {
  const nodes = Array.isArray(graph?.nodes) ? (graph!.nodes as EffectNode[]) : [];

  // IDENTITY: no graph / no nodes ⇒ render children verbatim, no wrapper at all.
  // This is the byte-identical legacy path the caller relies on.
  if (!nodes.length) return <>{children}</>;

  const ordered = topoSort(nodes);

  // Pass 1: collect wrapper filters (blur/sharpen/chroma_ab + M14 mask/key/displace)
  // that apply TO the children, plus a clip-path/mask/transform from the M14
  // mask_shape/transform nodes; resolve each look node's params. `blend` nodes set
  // the blend mode applied to the subsequent overlay.
  const filterDefs: React.ReactNode[] = [];
  const filterRefs: string[] = [];
  const overlays: React.ReactNode[] = [];
  // M14: a CSS clip-path / mask / transform from mask_shape + transform nodes,
  // applied to the children wrapper. The last of each wins (one of each is the
  // sane authoring; multiple shape masks would need a real matte stack → M16).
  let wrapClipPath: string | undefined;
  let wrapMask: string | undefined;
  let wrapTransform: string | undefined;
  let nextBlend: string | undefined;

  ordered.forEach((node, idx) => {
    if (!node || !SAFE_TYPES.has(node.type)) return; // skip unsupported → identity for it
    const p = resolveNodeParams(node, frame, durF);

    if (node.type === "source") return; // the children ARE the source; nothing to paint

    if (node.type === "blend") {
      const mode = str(p.mode, "screen");
      nextBlend = BLEND_MODES.has(mode) ? mode : undefined;
      return;
    }

    // M14 mask / key / transform / displace nodes — wrapper effects on the source.
    if (MASK_KEY_TYPES.has(node.type)) {
      const w: WrapDescriptor | null = maskKeyWrap(node, p, idx, frame);
      if (w) {
        if (w.def) filterDefs.push(<React.Fragment key={`mkdef${idx}`}>{w.def}</React.Fragment>);
        if (w.filter) filterRefs.push(w.filter);
        if (w.clipPath) wrapClipPath = w.clipPath;
        if (w.mask) wrapMask = w.mask;
        // chain transforms so a transform after a transform composes (rare but safe)
        if (w.transform) wrapTransform = wrapTransform ? `${wrapTransform} ${w.transform}` : w.transform;
      }
      return;
    }

    // wrapper-filter nodes affect the underlying image, not an overlay
    const wf = wrapperFilterDefs(node, p, idx);
    if (wf) {
      filterDefs.push(<React.Fragment key={`wfdef${idx}`}>{wf.def}</React.Fragment>);
      filterRefs.push(wf.filter);
      return;
    }

    // overlay look nodes
    let overlay: React.ReactNode = null;
    const nodeKey = `cgn${idx}`;
    switch (node.type) {
      case "grade": {
        // The grade node IS the §4.1 ColorGrade field, rendered as a wrapper filter
        // over the children (unified: ONE grade implementation, exposed as a node).
        const g = (p as any).grade ?? p; // accept either {grade:{…}} or the grade inline
        const fid = gradeToFilterId(g as ColorGradeT, `cgnode_${node.id || idx}`);
        if (fid && !gradeIsIdentity(g as ColorGradeT)) {
          filterDefs.push(<GradePipeline key={`grade${idx}`} grade={g as ColorGradeT} id={fid} />);
          filterRefs.push(`url(#${fid})`);
        }
        return;
      }
      case "glow":
        overlay = <GlowNode key={nodeKey} p={p} id={node.id || String(idx)} />;
        break;
      case "bloom":
        overlay = <GlowNode key={nodeKey} p={p} id={node.id || String(idx)} bloom />;
        break;
      case "light_leak":
        overlay = <LightLeakNode key={nodeKey} p={p} />;
        break;
      case "grain":
        overlay = <GrainNode key={nodeKey} p={p} frame={frame} w={w} h={h} />;
        break;
      case "vignette":
        overlay = <VignetteNode key={nodeKey} p={p} />;
        break;
      default:
        overlay = null;
    }
    if (overlay) {
      // apply a pending blend mode (from a preceding `blend` node) to this overlay
      if (nextBlend) {
        overlay = (
          <AbsoluteFill key={`bl${idx}`} style={{ mixBlendMode: nextBlend as any, pointerEvents: "none" }}>
            {overlay}
          </AbsoluteFill>
        );
        nextBlend = undefined;
      }
      overlays.push(overlay);
    }
  });

  // If nothing resolved to an actual look (every node was a no-op / unsupported),
  // fall back to identity so an inert graph is still byte-identical.
  if (!filterDefs.length && !overlays.length && !filterRefs.length && !wrapClipPath && !wrapMask && !wrapTransform) {
    return <>{children}</>;
  }

  const stackFilter = filterRefs.length ? filterRefs.join(" ") : undefined;
  // Build the children-wrapper style: CSS filter (blur/sharpen/chroma/grade/key/
  // mask-matte/displace) + clip-path (mask_shape) + mask (feathered/luma) +
  // transform (transform node). Each is undefined when no node set it → identity.
  const wrapStyle: React.CSSProperties = {};
  if (stackFilter) wrapStyle.filter = stackFilter;
  if (wrapClipPath) wrapStyle.clipPath = wrapClipPath;
  if (wrapMask) {
    wrapStyle.maskImage = wrapMask;
    (wrapStyle as any).WebkitMaskImage = wrapMask;
  }
  if (wrapTransform) wrapStyle.transform = wrapTransform;

  return (
    <AbsoluteFill>
      {/* SVG <filter>/<mask> defs for grade / blur / sharpen / chroma_ab / mask /
          key / displace (zero layout). */}
      {filterDefs.length > 0 && (
        <svg width={0} height={0} style={{ position: "absolute" }} aria-hidden>
          <defs>{filterDefs}</defs>
        </svg>
      )}
      {/* the children (the rendered post = the `source`), with wrapper effects. */}
      <AbsoluteFill style={Object.keys(wrapStyle).length ? wrapStyle : undefined}>{children}</AbsoluteFill>
      {/* the overlay look nodes, composited on top in topo order. */}
      {overlays}
    </AbsoluteFill>
  );
};
