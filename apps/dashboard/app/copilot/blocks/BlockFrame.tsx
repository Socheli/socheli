"use client";
import Link from "next/link";
import type { CSSProperties, ReactNode } from "react";
import { InkIcon } from "../../../components/sketch";
import { useInView } from "./anim";

/* Shared chrome for the copilot's DOMAIN blocks: a mono eyebrow with the small
   ink glyph, and the block's deep-link rendered as a quiet "open →" corner
   link (the callback pattern: block = inline glance, link = zoomed-in page).
   Ink stays sparse — one glyph per block header, nothing more.

   v3 — the block draws itself like ink, 9-slice style: instead of ONE rect
   path stretched with preserveAspectRatio="none" (whose wobble amplitude
   scaled with the block — sloppy on tall calendars, and brittle against any
   CSS that resizes the svg), the frame is EIGHT tiny absolutely-positioned
   svgs: four edges that stretch on exactly one axis (their wobble lives on
   the fixed cross axis, so it stays a believable ±0.7px at any block size)
   and four fixed-size corner arcs. All pieces sit in a pointer-events:none
   inset-0 layer (.blk-ink) and NEVER contribute layout height. Each path is
   pathLength=1 and sequenced via --ink-delay/--ink-dur so the shared
   .ink-drawable stroke-dashoffset animation traces the box clockwise from
   the top-left, like a hand closing a frame; prefers-reduced-motion renders
   it fully drawn (existing .ink-drawable rule). Endpoints meet the corner
   arcs (corner inset 7px, stroke center ~2.5px into each 5px edge band). */

type Piece = { cls: string; vb: string; d: string; delay: number; dur: number };

const PIECES: Piece[] = [
  // top edge, drawn left → right
  {
    cls: "blk-ink-t",
    vb: "0 0 200 5",
    d: "M0 2.6 C 30 1.9, 62 3.2, 96 2.4 C 130 1.8, 165 3.1, 200 2.4",
    delay: 0,
    dur: 170,
  },
  // top-right corner: in from the top edge, curling down to the right edge
  { cls: "blk-ink-tr", vb: "0 0 7 7", d: "M0 2.4 C 3.2 2.3, 4.4 3.4, 4.5 7", delay: 170, dur: 60 },
  // right edge, drawn top → bottom
  {
    cls: "blk-ink-r",
    vb: "0 0 5 200",
    d: "M2.5 0 C 1.8 35, 3.1 80, 2.3 120 C 1.9 155, 3 180, 2.6 200",
    delay: 230,
    dur: 130,
  },
  // bottom-right corner
  { cls: "blk-ink-br", vb: "0 0 7 7", d: "M4.6 0 C 4.7 3.3, 3.5 4.4, 0 4.5", delay: 360, dur: 60 },
  // bottom edge, drawn right → left
  {
    cls: "blk-ink-b",
    vb: "0 0 200 5",
    d: "M200 2.5 C 168 3.2, 135 1.9, 100 2.6 C 66 3.2, 32 1.9, 0 2.5",
    delay: 420,
    dur: 170,
  },
  // bottom-left corner
  { cls: "blk-ink-bl", vb: "0 0 7 7", d: "M7 4.5 C 3.6 4.4, 2.7 3.3, 2.6 0", delay: 590, dur: 60 },
  // left edge, drawn bottom → top
  {
    cls: "blk-ink-l",
    vb: "0 0 5 200",
    d: "M2.6 200 C 1.9 165, 3.2 120, 2.4 85 C 2 50, 3 25, 2.5 0",
    delay: 650,
    dur: 130,
  },
  // top-left corner closes the box back onto the top edge's start
  { cls: "blk-ink-tl", vb: "0 0 7 7", d: "M2.5 7 C 2.4 3.5, 3.5 2.5, 7 2.6", delay: 780, dur: 60 },
];

function InkFrame() {
  return (
    <span className="blk-ink" aria-hidden>
      {PIECES.map((p) => (
        <svg
          key={p.cls}
          className={`blk-ink-p ${p.cls} ink-drawable`}
          viewBox={p.vb}
          preserveAspectRatio="none"
          style={{ "--ink-delay": `${p.delay}ms`, "--ink-dur": `${p.dur}ms` } as CSSProperties}
          aria-hidden
        >
          <path
            d={p.d}
            pathLength={1}
            fill="none"
            stroke="currentColor"
            strokeWidth={1}
            strokeLinecap="round"
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          />
        </svg>
      ))}
    </span>
  );
}

export function BlockFrame({
  eyebrow,
  href,
  meta,
  hug,
  children,
}: {
  eyebrow: string;
  href?: string;
  meta?: ReactNode;
  /* When true, the frame hugs its content width instead of stretching to fill
     the chat column — for SPARSE widgets (one device, one metric, a short
     verdict) whose content is far narrower than the column, so the ink frame
     wraps the content rather than leaving a huge empty right side. Wide
     data blocks (calendars, charts, tables) leave this off and span full width.
     Has no effect inside a board cell (that layer forces fill + equal height). */
  hug?: boolean;
  children: ReactNode;
}) {
  // Unified entrance: hold the frame ink + every child animation in their PRE
  // state (blk-anim) until the block scrolls into view (blk-reveal), and replay
  // on re-entry. See useInView / the .blk-anim CSS section.
  const { ref, inView } = useInView<HTMLDivElement>();
  return (
    <div
      ref={ref}
      className={`blk blk-inked blk-anim${hug ? " blk-hug" : ""}${inView ? " blk-reveal" : ""}`}
    >
      <InkFrame />
      <div className="blk-head">
        <InkIcon name="glyph" size={10} className="blk-glyph" />
        <span className="blk-eyebrow">{eyebrow}</span>
        {meta ? <span className="blk-meta">{meta}</span> : null}
        {href ? (
          <Link className="blk-open" href={href}>
            open →
          </Link>
        ) : null}
      </div>
      {children}
    </div>
  );
}
