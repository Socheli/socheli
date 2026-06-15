import React from "react";
import { AbsoluteFill } from "remotion";
import type { Theme, GradeParams } from "@os/tokens";
// Aliased: this module also exports a `ColorGrade` look-layer COMPONENT (below),
// so the schema's validated grade TYPE comes in as `ColorGradeT`.
import type { ColorGrade as ColorGradeT } from "@os/schemas";

const DEFAULT_GRADE: GradeParams = { shadow: "#0b141c", highlight: "rgba(255,226,188,0.5)", bloom: 0.5, edge: 0.34, contrast: 1 };

/* ─── Cinematic color grade ──────────────────────────────────────────────
   A filmic tone-split laid over the (monochrome) scenes: lifted shadows in the
   mood's shadow tint, soft highlight wash, gentle halation bloom. Subtle by
   design — it should read as "shot on film", never as a colored gel. */
export const ColorGrade: React.FC<{
  grade?: GradeParams;
  tint?: string; // per-DNA colour cast (else none)
  tintOpacity?: number; // capped upstream at 0.35
  tintBlend?: "soft-light" | "overlay";
  bloomHue?: string; // per-DNA halation colour (else the neutral warm default)
}> = ({ grade = DEFAULT_GRADE, tint, tintOpacity = 0, tintBlend = "soft-light", bloomHue }) => (
  <AbsoluteFill style={{ pointerEvents: "none" }}>
    {/* shadow lift (mood temperature) */}
    <AbsoluteFill style={{ background: `linear-gradient(180deg, ${grade.shadow} 0%, ${grade.shadow} 100%)`, mixBlendMode: "soft-light", opacity: 0.5 }} />
    {/* highlight wash, weighted to the upper-centre where the key light sits */}
    <AbsoluteFill style={{ background: `radial-gradient(1100px 1300px at 50% 32%, ${grade.highlight}, transparent 62%)`, mixBlendMode: "soft-light", opacity: 0.42 }} />
    {/* halation bloom — a faint screen-blend glow in the brights (per-DNA hue) */}
    <AbsoluteFill style={{ background: `radial-gradient(820px 900px at 50% 30%, ${bloomHue ?? "rgba(255,244,228,0.10)"}, transparent 60%)`, mixBlendMode: "screen", opacity: grade.bloom }} />
    {/* per-DNA colour cast — subtle, so the channel reads cool/warm/violet etc. */}
    {tint && tintOpacity > 0 && (
      <AbsoluteFill style={{ background: tint, mixBlendMode: tintBlend, opacity: tintOpacity }} />
    )}
    {/* crushed-black contrast floor at the edges */}
    <AbsoluteFill style={{ background: `radial-gradient(1400px 1700px at 50% 50%, transparent 55%, rgba(0,0,0,${grade.edge}) 100%)`, mixBlendMode: "multiply" }} />
  </AbsoluteFill>
);

/* True film grain — reseeds EVERY frame (not every other) so it shimmers like
   real emulsion. Two octaves for an organic, non-uniform texture. */
export const FilmGrain: React.FC<{ w: number; h: number; frame: number; opacity?: number }> = ({ w, h, frame, opacity = 0.06 }) => (
  <svg width={w} height={h} style={{ position: "absolute", inset: 0, opacity, mixBlendMode: "overlay", pointerEvents: "none" }}>
    <filter id={`filmgrain${frame}`}>
      <feTurbulence type="fractalNoise" baseFrequency="0.82" numOctaves="2" seed={frame} stitchTiles="stitch" />
      <feColorMatrix type="saturate" values="0" />
    </filter>
    <rect width={w} height={h} filter={`url(#filmgrain${frame})`} />
  </svg>
);

/* Sub-pixel gate weave — the gentle drift of film through a projector gate.
   Returns a transform string for a wrapper around the whole frame. */
export function gateWeave(frame: number): string {
  const x = Math.sin(frame * 0.21) * 0.8 + Math.sin(frame * 0.07) * 0.5;
  const y = Math.cos(frame * 0.17) * 0.7;
  return `translate(${x.toFixed(2)}px, ${y.toFixed(2)}px)`;
}

/* Pulse-driven light leak — a warm diagonal flare that blooms on beat peaks.
   amount 0..~1 (the decayed beat pulse). */
export const LightLeak: React.FC<{ amount: number; tint?: string }> = ({ amount, tint = "rgba(255,196,138,0.9)" }) => {
  if (amount <= 0.02) return null;
  return (
    <AbsoluteFill style={{ pointerEvents: "none", opacity: Math.min(0.5, amount * 0.5), mixBlendMode: "screen" }}>
      <AbsoluteFill style={{ background: `linear-gradient(118deg, transparent 40%, ${tint} 72%, transparent 86%)` }} />
      <AbsoluteFill style={{ background: "radial-gradient(600px 1200px at 88% 12%, rgba(255,214,170,0.6), transparent 70%)" }} />
    </AbsoluteFill>
  );
};

/* Chromatic-aberration filter def. Apply with CSS `filter: url(#chroma)` on a
   subtree; re-render each frame with a fresh `amount` (px) to animate. */
export const ChromaDefs: React.FC<{ amount: number }> = ({ amount }) => {
  const dx = amount.toFixed(2);
  return (
    <svg width={0} height={0} style={{ position: "absolute" }} aria-hidden>
      <defs>
        <filter id="chroma" x="-5%" y="-5%" width="110%" height="110%" colorInterpolationFilters="sRGB">
          <feColorMatrix type="matrix" values="1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0" result="r" />
          <feOffset in="r" dx={dx} dy="0" result="ro" />
          <feColorMatrix type="matrix" values="0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0" result="g" />
          <feColorMatrix type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0" result="b" in="SourceGraphic" />
          <feOffset in="b" dx={`-${dx}`} dy="0" result="bo" />
          <feBlend in="ro" in2="g" mode="screen" result="rg" />
          <feBlend in="rg" in2="bo" mode="screen" />
        </filter>
      </defs>
    </svg>
  );
};

/* ─── DaVinci spine §4.1 — real per-channel GRADE pipeline (M2) ───────────────
   `GradePipeline` renders an `@os/schemas` ColorGrade as a precise, GPU-friendly
   SVG <filter>. It is the REAL primary-colourist target the bridge writes to —
   distinct from the gradient-overlay `ColorGrade` "look" above (which stays as a
   filmic wash on top). The two compose: a scene/post is graded by this filter,
   then the look layer is laid over it.

   Pipeline order (per channel, in light → image order, matching a colourist desk):
     1. lift/gamma/gain   — feComponentTransfer per R/G/B channel
                            (linear slope=gain intercept=lift, then gamma exponent)
     2. saturation        — luma-weighted feColorMatrix (Rec.709 coeffs)
     3. temperature/tint  — warm/cool + magenta/green channel rebalance (feColorMatrix)
     4. contrast(pivot)   — feComponentTransfer linear about a pivot point
     5. curves            — feComponentTransfer type="table" (per-channel + master)

   NUMERICAL IDENTITY IS LOAD-BEARING: an empty/neutral grade MUST be visually a
   no-op. `gradeIsIdentity` detects that and `gradeToFilterId` returns "" → the
   caller emits NO filter, so a grade-less scene renders byte-identical (the M2
   legacy-fallback contract). Every value is read defensively and clamped to the
   schema band before it touches a filter primitive (bridge discipline: clamp,
   never throw, never NaN). */

const gclamp = (v: number, lo: number, hi: number): number => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : (lo + hi) / 2);
const gnum = (v: unknown, fallback: number): number => (typeof v === "number" && Number.isFinite(v) ? v : fallback);

// Schema bands (§4.1): lift ±, gamma/gain around 1, temp/tint ±1, sat 0..2,
// contrast 0..2, pivot 0..1. Channels normalised to {r,g,b} (schema rgbTriplet).
type Chan = { r: number; g: number; b: number };
const liftChan = (t: any): Chan => ({ r: gclamp(gnum(t?.r, 0), -0.5, 0.5), g: gclamp(gnum(t?.g, 0), -0.5, 0.5), b: gclamp(gnum(t?.b, 0), -0.5, 0.5) });
const mulChan = (t: any): Chan => ({ r: gclamp(gnum(t?.r, 1), 0.1, 4), g: gclamp(gnum(t?.g, 1), 0.1, 4), b: gclamp(gnum(t?.b, 1), 0.1, 4) });

// A fully-resolved grade: defaults already merged + clamped, ready to render.
type Resolved = {
  lift: Chan; gamma: Chan; gain: Chan;
  temperature: number; tint: number; saturation: number; contrast: number; pivot: number;
  curves?: ColorGradeT["curves"];
};

const resolveGrade = (grade: ColorGradeT): Resolved => ({
  lift: liftChan((grade as any).lift),
  gamma: mulChan((grade as any).gamma),
  gain: mulChan((grade as any).gain),
  temperature: gclamp(gnum((grade as any).temperature, 0), -1, 1),
  tint: gclamp(gnum((grade as any).tint, 0), -1, 1),
  saturation: gclamp(gnum((grade as any).saturation, 1), 0, 2),
  contrast: gclamp(gnum((grade as any).contrast, 1), 0, 2),
  pivot: gclamp(gnum((grade as any).pivot, 0.435), 0, 1),
  curves: (grade as any).curves,
});

const chanIsUnit = (c: Chan, unit: number): boolean => c.r === unit && c.g === unit && c.b === unit;
const curveIsIdentity = (cv: any): boolean => {
  const pts = cv?.points;
  if (!Array.isArray(pts) || !pts.length) return true;
  // identity only if every point lies on v == t
  return pts.every((p: any) => Math.abs(gnum(p?.v, 0) - gnum(p?.t, 0)) < 1e-4);
};
const curvesAreIdentity = (cv?: ColorGradeT["curves"]): boolean => {
  if (!cv) return true;
  return curveIsIdentity((cv as any).all) && curveIsIdentity((cv as any).r) && curveIsIdentity((cv as any).g) && curveIsIdentity((cv as any).b);
};

/* True when a grade is a perfect no-op — the gate for the legacy fallback. */
export const gradeIsIdentity = (grade?: ColorGradeT | null): boolean => {
  if (!grade || typeof grade !== "object") return true;
  const g = resolveGrade(grade);
  return (
    chanIsUnit(g.lift, 0) &&
    chanIsUnit(g.gamma, 1) &&
    chanIsUnit(g.gain, 1) &&
    g.temperature === 0 &&
    g.tint === 0 &&
    g.saturation === 1 &&
    g.contrast === 1 &&
    curvesAreIdentity(g.curves)
  );
};

// Stable, collision-resistant rounded hash of a grade so each DISTINCT grade
// defines its <filter> exactly once (a per-frame-stable id ⇒ no remount flicker).
const hashGrade = (g: Resolved): string => {
  const r2 = (n: number) => Math.round(n * 1000); // 3-dp precision is plenty for a filter
  const parts: number[] = [
    r2(g.lift.r), r2(g.lift.g), r2(g.lift.b),
    r2(g.gamma.r), r2(g.gamma.g), r2(g.gamma.b),
    r2(g.gain.r), r2(g.gain.g), r2(g.gain.b),
    r2(g.temperature), r2(g.tint), r2(g.saturation), r2(g.contrast), r2(g.pivot),
  ];
  // fold curves in (presence + sampled points) so different curves hash apart
  const sampleCurve = (cv: any): number[] => {
    const pts = cv?.points;
    if (!Array.isArray(pts)) return [];
    return pts.flatMap((p: any) => [r2(gnum(p?.t, 0)), r2(gnum(p?.v, 0))]);
  };
  if (g.curves) {
    parts.push(7, ...sampleCurve((g.curves as any).all), 8, ...sampleCurve((g.curves as any).r), 9, ...sampleCurve((g.curves as any).g), 10, ...sampleCurve((g.curves as any).b));
  }
  // djb2 over the integer stream → base36, prefixed for readability/uniqueness
  let h = 5381;
  for (const n of parts) h = ((h << 5) + h + (n & 0xffff)) >>> 0;
  return h.toString(36);
};

/**
 * Stable filter id for a grade under a namespace `key` (e.g. a scene id), OR ""
 * when the grade is identity (caller then emits NO filter → legacy byte-identity).
 * The returned string is the bare id; reference it as `url(#<id>)`.
 */
export const gradeToFilterId = (grade: ColorGradeT | undefined | null, key: string): string => {
  if (gradeIsIdentity(grade)) return "";
  return `grade_${key}_${hashGrade(resolveGrade(grade as ColorGradeT))}`;
};

/* Sample a ColorCurve's control points into N evenly-spaced tableValues for an
   SVG type="table" transfer (input 0..1 → output). Points are sorted by t and
   linearly interpolated; endpoints hold. Identity curve ⇒ a straight ramp. */
const curveToTable = (cv: any, n = 17): number[] => {
  const pts = (Array.isArray(cv?.points) ? cv.points : [])
    .map((p: any) => ({ t: gclamp(gnum(p?.t, 0), 0, 1), v: gclamp(gnum(p?.v, 0), 0, 1) }))
    .sort((a: any, b: any) => a.t - b.t);
  if (!pts.length) return Array.from({ length: n }, (_, i) => i / (n - 1));
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const x = i / (n - 1);
    if (x <= pts[0].t) { out.push(pts[0].v); continue; }
    if (x >= pts[pts.length - 1].t) { out.push(pts[pts.length - 1].v); continue; }
    let j = 0;
    while (j < pts.length - 1 && pts[j + 1].t < x) j++;
    const a = pts[j], b = pts[j + 1];
    const span = b.t - a.t;
    const f = span > 1e-6 ? (x - a.t) / span : 0;
    out.push(a.v + (b.v - a.v) * f);
  }
  return out;
};

// Rec.709 luma weights (matching the in-app FilmGrain/chroma sRGB convention).
const LR = 0.2126, LG = 0.7152, LB = 0.0722;

/* Build the 4×5 feColorMatrix for luma-weighted saturation (s=1 ⇒ identity). */
const saturationMatrix = (s: number): string => {
  const r = (LR * (1 - s)), g = (LG * (1 - s)), b = (LB * (1 - s));
  const m = [
    r + s, g,     b,     0, 0,
    r,     g + s, b,     0, 0,
    r,     g,     b + s, 0, 0,
    0,     0,     0,     1, 0,
  ];
  return m.map((v) => +v.toFixed(5)).join(" ");
};

/* White-balance as a channel-gain rebalance (energy-preserving-ish, identity at
   temp=tint=0). temperature warms (+R / −B), tint shifts magenta(+R+B)/green(+G).
   Kept gentle (±~12% at the extremes) so a graded scene never blows a channel. */
const whiteBalanceMatrix = (temperature: number, tint: number): string => {
  const t = gclamp(temperature, -1, 1);
  const ti = gclamp(tint, -1, 1);
  const rGain = 1 + t * 0.12 + ti * 0.06;
  const gGain = 1 - ti * 0.10;
  const bGain = 1 - t * 0.12 + ti * 0.06;
  const m = [
    rGain, 0,     0,     0, 0,
    0,     gGain, 0,     0, 0,
    0,     0,     bGain, 0, 0,
    0,     0,     0,     1, 0,
  ];
  return m.map((v) => +v.toFixed(5)).join(" ");
};

/* One <feComponentTransfer> stage with the SAME linear transform on R/G/B
   (slope, intercept) — used for contrast-about-pivot. */
const LinearTransfer: React.FC<{ slope: number; intercept: number }> = ({ slope, intercept }) => {
  const s = +slope.toFixed(5), i = +intercept.toFixed(5);
  return (
    <feComponentTransfer>
      <feFuncR type="linear" slope={s} intercept={i} />
      <feFuncG type="linear" slope={s} intercept={i} />
      <feFuncB type="linear" slope={s} intercept={i} />
    </feComponentTransfer>
  );
};

/**
 * `GradePipeline` — emit the SVG <filter> for `grade` under id `id`. Renders
 * NOTHING (and so contributes no filter) when the grade is identity, preserving
 * byte-identical legacy output. The `id` is what the caller references via
 * `url(#<id>)`; pass the value from `gradeToFilterId(grade, key)`.
 *
 * The filter is a defs-only <svg> (zero layout footprint), mounted once per
 * distinct grade hash. Stages run in colourist order; each stage that is a
 * no-op is omitted so the chain stays as short as possible.
 */
export const GradePipeline: React.FC<{ grade?: ColorGradeT | null; id: string }> = ({ grade, id }) => {
  if (!grade || gradeIsIdentity(grade) || !id) return null;
  const g = resolveGrade(grade);

  const stages: React.ReactNode[] = [];
  let k = 0;

  // 1. lift/gamma/gain — per channel. gain=slope, lift=intercept (linear), then
  //    gamma as a power curve. Skip the whole stage if it's identity.
  if (!chanIsUnit(g.gain, 1) || !chanIsUnit(g.lift, 0)) {
    stages.push(
      <feComponentTransfer key={`lg${k++}`}>
        <feFuncR type="linear" slope={+g.gain.r.toFixed(5)} intercept={+g.lift.r.toFixed(5)} />
        <feFuncG type="linear" slope={+g.gain.g.toFixed(5)} intercept={+g.lift.g.toFixed(5)} />
        <feFuncB type="linear" slope={+g.gain.b.toFixed(5)} intercept={+g.lift.b.toFixed(5)} />
      </feComponentTransfer>,
    );
  }
  if (!chanIsUnit(g.gamma, 1)) {
    stages.push(
      <feComponentTransfer key={`gm${k++}`}>
        <feFuncR type="gamma" amplitude={1} exponent={+(1 / g.gamma.r).toFixed(5)} offset={0} />
        <feFuncG type="gamma" amplitude={1} exponent={+(1 / g.gamma.g).toFixed(5)} offset={0} />
        <feFuncB type="gamma" amplitude={1} exponent={+(1 / g.gamma.b).toFixed(5)} offset={0} />
      </feComponentTransfer>,
    );
  }

  // 2. saturation (luma-weighted) — skip at s=1.
  if (g.saturation !== 1) {
    stages.push(<feColorMatrix key={`sat${k++}`} type="matrix" values={saturationMatrix(g.saturation)} />);
  }

  // 3. temperature / tint — skip at 0/0.
  if (g.temperature !== 0 || g.tint !== 0) {
    stages.push(<feColorMatrix key={`wb${k++}`} type="matrix" values={whiteBalanceMatrix(g.temperature, g.tint)} />);
  }

  // 4. contrast about pivot — out = (in − pivot) * c + pivot = c*in + pivot*(1−c). Skip at c=1.
  if (g.contrast !== 1) {
    stages.push(<LinearTransfer key={`con${k++}`} slope={g.contrast} intercept={g.pivot * (1 - g.contrast)} />);
  }

  // 5. curves — master (`all`) applied to every channel, then per-channel tables.
  if (!curvesAreIdentity(g.curves)) {
    const cv = g.curves as any;
    if (cv.all && !curveIsIdentity(cv.all)) {
      const tv = curveToTable(cv.all).map((v) => +v.toFixed(5)).join(" ");
      stages.push(
        <feComponentTransfer key={`cAll${k++}`}>
          <feFuncR type="table" tableValues={tv} />
          <feFuncG type="table" tableValues={tv} />
          <feFuncB type="table" tableValues={tv} />
        </feComponentTransfer>,
      );
    }
    const perChan = (cv.r || cv.g || cv.b);
    if (perChan) {
      const ramp = "0 1";
      const rv = cv.r && !curveIsIdentity(cv.r) ? curveToTable(cv.r).map((v) => +v.toFixed(5)).join(" ") : ramp;
      const gv = cv.g && !curveIsIdentity(cv.g) ? curveToTable(cv.g).map((v) => +v.toFixed(5)).join(" ") : ramp;
      const bv = cv.b && !curveIsIdentity(cv.b) ? curveToTable(cv.b).map((v) => +v.toFixed(5)).join(" ") : ramp;
      stages.push(
        <feComponentTransfer key={`cChan${k++}`}>
          <feFuncR type="table" tableValues={rv} />
          <feFuncG type="table" tableValues={gv} />
          <feFuncB type="table" tableValues={bv} />
        </feComponentTransfer>,
      );
    }
  }

  if (!stages.length) return null; // belt-and-braces: nothing to do ⇒ no filter

  return (
    <svg width={0} height={0} style={{ position: "absolute" }} aria-hidden>
      <defs>
        {/* sRGB interpolation matches the rest of the in-app filters (FilmGrain,
            #chroma); the colourist loop tunes to MEASURED scope targets, so the
            sRGB-vs-linear nuance (roadmap §4.1 risk) is absorbed by the targets. */}
        <filter id={id} x="0%" y="0%" width="100%" height="100%" colorInterpolationFilters="sRGB">
          {stages}
        </filter>
      </defs>
    </svg>
  );
};

/* CSS-filter fallback for the cases where a full SVG <filter> is overkill (e.g.
   a thumbnail, a non-Remotion preview surface). Approximates the grade with the
   three CSS primitives that map cleanly — brightness (master gain/exposure-ish),
   contrast, saturate — and returns "none" for an identity grade so it's a safe
   drop-in. NOT used by the main render (which uses the precise SVG filter); kept
   for the bridge/preview surfaces that asked for a one-liner. */
export const gradeToCss = (grade?: ColorGradeT | null): string => {
  if (gradeIsIdentity(grade)) return "none";
  const g = resolveGrade(grade as ColorGradeT);
  // master brightness ≈ mean channel gain plus the mean lift, biased to 1
  const meanGain = (g.gain.r + g.gain.g + g.gain.b) / 3;
  const meanLift = (g.lift.r + g.lift.g + g.lift.b) / 3;
  const brightness = +gclamp(meanGain + meanLift, 0.2, 2).toFixed(4);
  const contrast = +gclamp(g.contrast, 0.2, 3).toFixed(4);
  const saturate = +gclamp(g.saturation, 0, 3).toFixed(4);
  // temperature → a small hue/sepia bias so warm/cool reads in the CSS path
  const warm = g.temperature > 0 ? ` sepia(${(g.temperature * 0.18).toFixed(3)})` : "";
  const out: string[] = [];
  if (brightness !== 1) out.push(`brightness(${brightness})`);
  if (contrast !== 1) out.push(`contrast(${contrast})`);
  if (saturate !== 1) out.push(`saturate(${saturate})`);
  if (warm) out.push(warm.trim());
  return out.length ? out.join(" ") : "none";
};

/* Slow drifting gradient mesh — adds depth/parallax behind the flat fill. */
export const GradientMesh: React.FC<{ theme: Theme; frame: number }> = ({ theme, frame }) => {
  const a = theme.accent.brand;
  const bx = 30 + Math.sin(frame * 0.006) * 14;
  const by = 26 + Math.cos(frame * 0.008) * 12;
  const cx = 72 + Math.cos(frame * 0.005) * 16;
  const cy = 70 + Math.sin(frame * 0.007) * 14;
  return (
    <AbsoluteFill style={{ pointerEvents: "none" }}>
      <AbsoluteFill style={{ background: `radial-gradient(680px 680px at ${bx}% ${by}%, ${a}12, transparent 60%)` }} />
      <AbsoluteFill style={{ background: `radial-gradient(760px 760px at ${cx}% ${cy}%, rgba(255,255,255,0.04), transparent 62%)` }} />
      <AbsoluteFill style={{ background: `radial-gradient(900px 600px at 50% 108%, ${a}0e, transparent 65%)` }} />
    </AbsoluteFill>
  );
};
