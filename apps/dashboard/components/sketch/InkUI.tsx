"use client";
import type { CSSProperties, ReactNode } from "react";

/* Small hand-drawn UI glyphs in the house single-stroke grammar (see InkIcon /
   ChatCore's InkMicIcon): currentColor, 1.5 stroke, round caps/joins, a little
   baked wobble in every line, pathLength=1 + .ink-drawable so each glyph draws
   itself in on mount. These replace lucide marks inside Soli's chrome — the
   history rail, the threads menu, the composer send/stop, the MCP card.
   Zero deps, no lucide. */

function G({ size, children, className }: { size: number; children: ReactNode; className?: string }) {
  return (
    <svg
      className={`ink-drawable${className ? ` ${className}` : ""}`}
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

/* Clock circle swept from an open start + rewind corner — conversation history. */
export function InkHistoryIcon({ size = 15, className }: { size?: number; className?: string }) {
  return (
    <G size={size} className={className}>
      <path
        pathLength={1}
        d="M5.4 7.4 C7.1 4.9 9.6 3.6 12.3 3.7 C16.8 3.9 20.3 7.5 20.2 12.1 C20.1 16.6 16.5 20.2 12 20.1 C7.9 20 4.5 17 3.9 13"
      />
      <path pathLength={1} d="M5.1 3.6 C5.2 5 5.3 6.3 5.4 7.7 C6.8 7.7 8.1 7.65 9.5 7.55" />
      <path pathLength={1} d="M11.95 7.9 C11.95 9.3 11.95 10.7 12 12.1 C13.2 12.85 14.4 13.6 15.6 14.3" />
    </G>
  );
}

/* Square + pencil sweeping out of it — new chat / compose. */
export function InkPenIcon({ size = 15, className }: { size?: number; className?: string }) {
  return (
    <G size={size} className={className}>
      <path
        pathLength={1}
        d="M11.1 4.7 C9.3 4.7 7.5 4.75 5.8 4.85 C5.1 4.9 4.65 5.35 4.6 6.05 C4.45 9.9 4.45 14 4.6 17.85 C4.65 18.55 5.1 19 5.8 19.05 C9.65 19.2 13.75 19.2 17.6 19.05 C18.3 19 18.75 18.55 18.8 17.85 C18.9 16.3 18.95 14.7 18.95 13.1"
      />
      <path
        pathLength={1}
        d="M9.9 12.2 C12.6 9.45 15.3 6.75 18.05 4.15 C18.7 3.55 19.6 3.6 20.2 4.25 C20.8 4.9 20.8 5.8 20.2 6.45 C17.55 9.15 14.85 11.85 12.1 14.45 C11.2 14.8 10.3 15.1 9.4 15.35 C9.55 14.3 9.7 13.25 9.9 12.2 Z"
      />
    </G>
  );
}

/* Bin with a lifted lid line — delete. */
export function InkTrashIcon({ size = 13, className }: { size?: number; className?: string }) {
  return (
    <G size={size} className={className}>
      <path pathLength={1} d="M4.7 6.5 C9.55 6.3 14.45 6.3 19.3 6.5" />
      <path pathLength={1} d="M9.6 6.2 C9.65 5.3 10.2 4.75 11.1 4.7 C11.7 4.65 12.3 4.65 12.9 4.7 C13.8 4.75 14.35 5.3 14.4 6.2" />
      <path
        pathLength={1}
        d="M6.3 8.8 C6.5 12.35 6.8 15.85 7.2 19.3 C7.3 20 7.75 20.4 8.45 20.45 C10.8 20.6 13.2 20.6 15.55 20.45 C16.25 20.4 16.7 20 16.8 19.3 C17.2 15.85 17.5 12.35 17.7 8.8"
      />
      <path pathLength={1} d="M10.25 10.7 C10.3 12.95 10.4 15.2 10.55 17.4" />
      <path pathLength={1} d="M13.75 10.7 C13.7 12.95 13.6 15.2 13.45 17.4" />
    </G>
  );
}

/* Hand-drawn plus — add / context. */
export function InkPlusIcon({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <G size={size} className={className}>
      <path pathLength={1} d="M12.05 5.4 C11.95 9.7 11.95 14.2 12.05 18.6" />
      <path pathLength={1} d="M5.5 12.05 C9.8 11.9 14.2 11.9 18.5 12.05" />
    </G>
  );
}

/* Up arrow — send. */
export function InkSendIcon({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <G size={size} className={className}>
      <path pathLength={1} d="M12 19.3 C11.9 14.7 11.95 9.7 12.05 5.1" />
      <path pathLength={1} d="M6.7 10.5 C8.5 8.6 10.3 6.7 12 4.8 C13.7 6.6 15.5 8.5 17.3 10.4" />
    </G>
  );
}

/* Wobbled square — stop. */
export function InkStopIcon({ size = 14, className }: { size?: number; className?: string }) {
  return (
    <G size={size} className={className}>
      <path
        pathLength={1}
        d="M8.2 7.4 C10.75 7.3 13.3 7.3 15.85 7.4 C16.45 7.45 16.85 7.85 16.9 8.45 C17 10.8 17 13.2 16.9 15.55 C16.85 16.15 16.45 16.55 15.85 16.6 C13.3 16.7 10.75 16.7 8.2 16.6 C7.6 16.55 7.2 16.15 7.15 15.55 C7.05 13.2 7.05 10.8 7.15 8.45 C7.2 7.85 7.6 7.45 8.2 7.4 Z"
      />
    </G>
  );
}

/* Small right-pointing chevron — disclosure. Rotated open via CSS. */
export function InkChevronIcon({ size = 12, className }: { size?: number; className?: string }) {
  return (
    <G size={size} className={className}>
      <path pathLength={1} d="M9.2 5.6 C11.3 7.7 13.4 9.8 15.4 12 C13.3 14.1 11.2 16.2 9 18.2" />
    </G>
  );
}

/* Hand-drawn spanner — a tool being used. */
export function InkToolIcon({ size = 13, className }: { size?: number; className?: string }) {
  return (
    <G size={size} className={className}>
      <path
        pathLength={1}
        d="M13.6 8.9 C12.6 7.5 12.6 5.9 13.7 4.6 C14.6 3.5 15.9 3.1 17.3 3.4 C16.6 4.2 15.9 5 15.3 5.8 C15.6 6.6 16.4 7.4 17.3 7.6 C18.1 6.9 18.9 6.2 19.7 5.4 C20.2 6.9 19.8 8.3 18.6 9.3 C17.4 10.3 15.9 10.4 14.5 9.7 C11.7 12.7 8.9 15.7 6.2 18.8 C5.6 19.4 4.8 19.4 4.2 18.8 C3.6 18.2 3.6 17.4 4.2 16.7 C7.3 14.1 10.4 11.5 13.6 8.9 Z"
      />
    </G>
  );
}

/* Two overlapping wobbled squares — copy to clipboard. */
export function InkCopyIcon({ size = 13, className }: { size?: number; className?: string }) {
  return (
    <G size={size} className={className}>
      <path
        pathLength={1}
        d="M9.4 9.5 C9.45 8.95 9.85 8.55 10.4 8.5 C12.75 8.4 15.15 8.4 17.5 8.5 C18.05 8.55 18.45 8.95 18.5 9.5 C18.6 11.85 18.6 14.25 18.5 16.6 C18.45 17.15 18.05 17.55 17.5 17.6 C15.15 17.7 12.75 17.7 10.4 17.6 C9.85 17.55 9.45 17.15 9.4 16.6 C9.3 14.25 9.3 11.85 9.4 9.5 Z"
      />
      <path
        pathLength={1}
        d="M6.5 14.7 C6 14.65 5.6 14.25 5.55 13.6 C5.45 11.25 5.45 8.85 5.55 6.5 C5.6 5.95 6 5.55 6.55 5.5 C8.9 5.4 11.3 5.4 13.65 5.5 C14.2 5.55 14.55 5.9 14.6 6.4"
      />
    </G>
  );
}

/* Quick hand check — done. */
export function InkCheckIcon({ size = 12, className }: { size?: number; className?: string }) {
  return (
    <G size={size} className={className}>
      <path pathLength={1} d="M5.3 12.6 C6.8 14 8.2 15.5 9.6 17.1 C12 13.1 14.8 9.4 18.6 6" />
    </G>
  );
}

/* Two crossing strokes — the small ink x-mark (blocked / unavailable). */
export function InkXIcon({ size = 12, className }: { size?: number; className?: string }) {
  return (
    <G size={size} className={className}>
      <path pathLength={1} d="M6.6 6.9 C8.4 8.5 10.2 10.3 12 12.1 C13.7 13.8 15.4 15.6 17.1 17.4" />
      <path pathLength={1} d="M17.3 6.7 C15.5 8.4 13.7 10.1 12 11.9 C10.3 13.6 8.6 15.4 6.9 17.2" />
    </G>
  );
}

/* Tiny wobbled ring, slightly open where the hand lifts off — drawn around
   status dots (the scorecard verdict-ring grammar). Position it absolutely
   over a 7px dot via the usage-site class. */
const INK_RING =
  "M8 2.6 C 11.6 1.6, 14.6 4.4, 14.4 8 C 14.2 11.8, 11.4 14.5, 7.8 14.3 " +
  "C 4.2 14.1, 1.6 11.4, 1.8 7.7 C 2 4.3, 4.6 2.1, 7.4 2.3";

export function InkRing({ className, style }: { className?: string; style?: CSSProperties }) {
  return (
    <svg className={`ink-drawable${className ? ` ${className}` : ""}`} viewBox="0 0 16 16" style={style} aria-hidden="true" focusable="false">
      <path d={INK_RING} pathLength={1} fill="none" stroke="currentColor" strokeWidth={1.1} strokeLinecap="round" />
    </svg>
  );
}

/* One continuous hand-traced rect (the BlockFrame wobble), stretched to its
   container — the hand-drawn border for option tiles. Drop it as the first
   child of a position:relative box with an inset/sizing class. */
const INK_RECT =
  "M7.2 3.4 C 68 1.9, 148 4.5, 232.6 3 " +
  "C 235.2 2.9, 236.6 4.1, 236.7 6.4 " +
  "C 235.8 35.5, 237.4 65.5, 236.4 93.4 " +
  "C 236.3 95.7, 235 96.9, 232.4 96.8 " +
  "C 162 95.7, 76 97.9, 7.6 96.9 " +
  "C 5.1 96.9, 3.6 95.6, 3.7 93.2 " +
  "C 4.6 64.5, 3 34.5, 4 7.2 " +
  "C 4.1 4.7, 5 3.4, 7.8 3.3";

export function InkTileFrame({ className }: { className?: string }) {
  return (
    <svg
      className={`ink-drawable${className ? ` ${className}` : ""}`}
      viewBox="0 0 240 100"
      preserveAspectRatio="none"
      aria-hidden="true"
      focusable="false"
    >
      <path
        d={INK_RECT}
        pathLength={1}
        fill="none"
        stroke="currentColor"
        strokeWidth={1}
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}
