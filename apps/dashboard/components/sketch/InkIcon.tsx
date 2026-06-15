"use client";

/* Ink icon set — the landing manual's hand-set marks (apps/landing/index.html
   <defs> symbols), ported verbatim as standalone components so the dashboard
   shares the same sketch identity. Static (no animation here — wrap in
   <InkDraw> for the draw-in). Color always comes from the usage site via
   currentColor; never hardcode an ink color in here. Zero deps, no lucide. */

export type InkIconName = "star-clean" | "star-rough" | "glyph" | "spark";

/* viewBox dimensions per mark (they are not all square — height follows). */
const VB: Record<InkIconName, { w: number; h: number }> = {
  "star-clean": { w: 110, h: 100 },
  "star-rough": { w: 112, h: 102 },
  glyph: { w: 100, h: 100 },
  spark: { w: 16, h: 10 },
};

export function InkIcon({
  name,
  size = 16,
  className,
  title,
}: {
  name: InkIconName;
  size?: number;
  className?: string;
  title?: string;
}) {
  const vb = VB[name];
  const props = {
    width: size,
    height: Math.round((size * vb.h) / vb.w),
    viewBox: `0 0 ${vb.w} ${vb.h}`,
    className,
    ...(title ? { role: "img" as const } : { "aria-hidden": true as const }),
  };
  const titleEl = title ? <title>{title}</title> : null;

  switch (name) {
    // clean geometric mark: star w/ chevron-cut arm + breakaway spark (mk-clean)
    case "star-clean":
      return (
        <svg {...props}>
          {titleEl}
          <path
            fill="currentColor"
            d="M50 3 C55 32.5 66 44 86 47 L78.5 50 L86 53 C66 56 55 67.5 50 97 C45 67.5 32.5 55 3 50 C32.5 45 45 32.5 50 3 Z"
          />
          <path fill="currentColor" d="M91 50 L99 45.6 L107 50 L99 54.4 Z" />
        </svg>
      );
    // two-pass rough display star + spark (mk-rough) — drawable strokes
    case "star-rough":
      return (
        <svg {...props}>
          {titleEl}
          <g fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
            <path
              pathLength={1}
              d="M50.4 4.2 C55 32.1 66.3 44.4 85.7 47.2 L78.9 50.1 L85.9 52.9 C66.1 56.2 55.2 67.4 50.1 95.7 C45.2 67.6 32.5 55.3 4.4 50.2 C32.7 44.8 45.1 32.4 50.4 4.2 Z"
            />
            <path
              pathLength={1}
              opacity={0.55}
              d="M49.7 4.9 C54.6 32.6 65.8 44.9 85.2 47.6 L78.2 50 L85.4 52.4 C65.9 55.7 54.7 67.7 49.9 95.2 C45 67.1 32.8 54.7 4.9 49.8 C32.2 45.3 44.7 32 49.7 4.9 Z"
            />
            <path pathLength={1} d="M91.4 50.2 L99.1 45.7 L106.8 50 L99.3 54.4 Z" />
            <path pathLength={1} opacity={0.5} d="M91.8 49.8 L99.3 45.9 L106.4 50.2 L99.1 54 Z" />
          </g>
        </svg>
      );
    // single-pass rough small star (mk-glyph) — eyebrows, bullets, separators
    case "glyph":
      return (
        <svg {...props}>
          {titleEl}
          <path
            fill="currentColor"
            d="M50.6 5.2 C54.8 31.7 67.2 44.6 94.8 49.6 C67.6 55.1 55.3 67 50.2 94.6 C45.4 67.4 32.6 55.2 5.6 50.4 C32.9 44.9 45.2 32.2 50.6 5.2 Z"
          />
        </svg>
      );
    // spark alone (mk-spark) — the footnote glyph
    case "spark":
      return (
        <svg {...props}>
          {titleEl}
          <path fill="currentColor" d="M0 5 L8 .6 L16 5 L8 9.4 Z" />
        </svg>
      );
  }
}
