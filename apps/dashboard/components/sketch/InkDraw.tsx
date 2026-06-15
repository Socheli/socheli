"use client";
import type { CSSProperties, ReactNode } from "react";

/* Draw-in wrapper: any stroked SVG child (with pathLength="1" strokes) animates
   from invisible to drawn via the .ink-drawable rules in globals.css.
   Reduced-motion users get the finished drawing instantly. */
export function InkDraw({
  children,
  durationMs = 900,
  delayMs = 0,
  className,
}: {
  children: ReactNode;
  durationMs?: number;
  delayMs?: number;
  className?: string;
}) {
  return (
    <span
      className={`ink-drawable ${className ?? ""}`}
      style={{ "--ink-dur": `${durationMs}ms`, "--ink-delay": `${delayMs}ms` } as CSSProperties}
    >
      {children}
    </span>
  );
}
