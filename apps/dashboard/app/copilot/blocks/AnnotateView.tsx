"use client";
import type { CSSProperties } from "react";
import type { UIAnnotate, AnnotateEmphasis } from "../../../lib/agent/ui-spec";
import { useInView } from "./anim";

/* Hand-annotated statement: Soli's ink replacement for **bold**. The text is
   split around each emphasized phrase (first case-insensitive match, max 3,
   non-overlapping); matches are wrapped in a relative span carrying an
   absolutely-positioned SVG — a baked wobbled ellipse drawn AROUND the phrase
   (style "circle") or a baked hand underline drawn UNDER it ("underline").
   Strokes use pathLength=1 + the shared .ink-drawable stroke-dashoffset
   draw-in, staggered so marks land one after another; prefers-reduced-motion
   renders them fully drawn. An optional small mono margin note sits below. */

type Seg = { text: string; em?: AnnotateEmphasis };

/* Split `text` into plain/emphasized segments. Each phrase claims its first
   case-insensitive match inside a still-plain segment; already-marked
   segments are never re-split, so overlaps resolve in emphasis order. */
function segment(text: string, emphasis: AnnotateEmphasis[]): Seg[] {
  let segs: Seg[] = [{ text }];
  for (const em of emphasis) {
    const needle = em.phrase.toLowerCase();
    if (!needle) continue;
    let claimed = false;
    const next: Seg[] = [];
    for (const s of segs) {
      if (claimed || s.em) {
        next.push(s);
        continue;
      }
      const idx = s.text.toLowerCase().indexOf(needle);
      if (idx < 0) {
        next.push(s);
        continue;
      }
      claimed = true;
      if (idx > 0) next.push({ text: s.text.slice(0, idx) });
      next.push({ text: s.text.slice(idx, idx + em.phrase.length), em });
      const rest = s.text.slice(idx + em.phrase.length);
      if (rest) next.push({ text: rest });
    }
    segs = next;
  }
  return segs;
}

/* Baked wobbled marquee ellipse — open path, end overlapping the start the
   way a hand closes a circle. Stretched to the phrase box. */
const INK_CIRCLE =
  "M10 25 C 7 13, 28 4.6, 60 4.1 C 92 3.6, 114 9.8, 113.4 22 " +
  "C 112.8 34, 90 40.4, 57 39.9 C 30 39.5, 10.6 34.4, 9.4 26.5 " +
  "C 8.6 21, 14.5 15.2, 25 12.2";

/* Baked hand underline — one stroke with a light second-thought wave. */
const INK_UNDERLINE = "M3 6.4 C 28 3.9, 58 7.7, 89 5 C 100 4.2, 110.5 5.6, 117 4.7";

function InkMark({ style }: { style: AnnotateEmphasis["style"] }) {
  const circle = style === "circle";
  return (
    <svg
      className={`blk-an-ink ink-drawable ${circle ? "an-circle" : "an-underline"}`}
      viewBox={circle ? "0 0 120 44" : "0 0 120 10"}
      preserveAspectRatio="none"
      aria-hidden
    >
      <path
        d={circle ? INK_CIRCLE : INK_UNDERLINE}
        pathLength={1}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.4}
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

export function AnnotateView({ b }: { b: UIAnnotate }) {
  const segs = segment(b.text, b.emphasis);
  let markIdx = 0;
  // Frame-less block — carries the reveal markers itself so its ink marks join
  // the unified inview entrance (hold undrawn until scrolled in, replay on
  // re-entry) just like the framed blocks.
  const { ref, inView } = useInView<HTMLDivElement>();
  return (
    <div ref={ref} className={`blk-an blk-anim${inView ? " blk-reveal" : ""}`}>
      <p className="blk-an-text">
        {segs.map((s, i) => {
          if (!s.em) return <span key={i}>{s.text}</span>;
          const delay = 260 + markIdx++ * 340;
          return (
            <span
              className="blk-an-mark"
              key={i}
              style={{ "--ink-delay": `${delay}ms`, "--ink-dur": "520ms" } as CSSProperties}
            >
              {s.text}
              <InkMark style={s.em.style} />
            </span>
          );
        })}
      </p>
      {b.note ? <div className="blk-an-note">{b.note}</div> : null}
    </div>
  );
}
