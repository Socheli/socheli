"use client";
import type { CSSProperties } from "react";

/* The hand-drawn "today" mark shared by the calendar blocks: a baked wobbled
   ellipse that draws itself around the day number in ~600ms (pathLength=1 +
   the shared .ink-drawable stroke-dashoffset draw-in; reduced motion renders
   it fully drawn). Usage: wrap the day number in a relative .blk-today span
   and drop <TodayInk /> next to it. */

const INK_ELLIPSE =
  "M9 14.5 C 7.4 8, 13.4 3.2, 20 3 C 26.8 2.8, 31.6 6.4, 31.2 12 " +
  "C 30.8 17.6, 25 21.4, 18.2 21.1 C 12 20.8, 8.4 17.8, 8.6 13.4 " +
  "C 8.8 10, 11.6 6.8, 15.4 5.6";

export function TodayInk({ delayMs = 200 }: { delayMs?: number }) {
  return (
    <svg
      className="blk-today-ink ink-drawable"
      viewBox="0 0 38 24"
      preserveAspectRatio="none"
      style={{ "--ink-delay": `${delayMs}ms`, "--ink-dur": "600ms" } as CSSProperties}
      aria-hidden
    >
      <path
        d={INK_ELLIPSE}
        pathLength={1}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.2}
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

/* Local YYYY-MM-DD for "is this cell today" checks. */
export function todayIso(): string {
  const n = new Date();
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, "0")}-${String(n.getDate()).padStart(2, "0")}`;
}
