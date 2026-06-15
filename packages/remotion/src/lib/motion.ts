import { interpolate, Easing } from "remotion";

export const eOut = Easing.out(Easing.cubic);
export const eIn = Easing.in(Easing.cubic);
export const eBoth = Easing.bezier(0.4, 0, 0.2, 1);

export function fadeInOut(f: number, total: number, fade = 8) {
  return interpolate(f, [0, fade, total - fade, total], [0, 1, 1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
}

export function reveal(f: number, delay = 0, dur = 16) {
  return interpolate(Math.max(0, f - delay), [0, dur], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: eOut,
  });
}

export function slideUp(f: number, delay = 0, dist = 28, dur = 16) {
  return interpolate(Math.max(0, f - delay), [0, dur], [dist, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: eOut,
  });
}

export function counter(f: number, delay: number, dur: number, from: number, to: number) {
  const t = interpolate(Math.max(0, f - delay), [0, dur], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: eOut,
  });
  return from + (to - from) * t;
}

export function slamIn(f: number, delay: number, from = 2.6, dur = 9) {
  return interpolate(Math.max(0, f - delay), [0, dur * 0.6, dur], [from, 0.94, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: eOut,
  });
}

export function wipe(f: number, delay: number, dur: number) {
  return interpolate(Math.max(0, f - delay), [0, dur], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: eBoth,
  });
}

export function typewriter(f: number, delay: number, totalChars: number, cps = 0.9) {
  return Math.min(totalChars, Math.max(0, Math.floor((f - delay) * cps)));
}

export function deterministicRandom(seed: number): number {
  const x = Math.sin(seed * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

export function breathe(f: number, period = 90, amount = 0.04) {
  return 0.5 + Math.sin((f / period) * 2 * Math.PI) * amount * 2;
}

/* Overshoot reveal: 0 → 1 with a gentle settle past 1 (spring feel) for snappy,
   designed entrances. Returns progress where the peak can exceed 1. */
export function springy(f: number, delay = 0, dur = 14, overshoot = 1.08) {
  return interpolate(Math.max(0, f - delay), [0, dur * 0.55, dur * 0.8, dur], [0, overshoot, overshoot * 0.985, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: eOut,
  });
}

/* Left-to-right reveal as a clip-path inset string (mask wipe). p: 0 hidden → 1 shown. */
export function maskWipe(f: number, delay = 0, dur = 12): string {
  const p = reveal(f, delay, dur);
  return `inset(-12% ${Math.max(0, (1 - p) * 100)}% -12% 0)`;
}

/* Per-item stagger delay helper for word/line reveals. */
export const stagger = (i: number, step = 3, base = 2) => base + i * step;

/* ─── Motion design system tokens ───────────────────────────────────────────
   Named, reusable timing so every scene's entrances feel like one system rather
   than ad-hoc per-component magic numbers. Frame-pure (frame in → value out). */

/* Spring-like scale pop with overshoot then settle — the snappy "card lands"
   feel of premium product mograph. Returns a scale around 1. */
export function pop(f: number, delay = 0, dur = 16, from = 0.86, overshoot = 1.04) {
  return interpolate(
    Math.max(0, f - delay),
    [0, dur * 0.5, dur * 0.72, dur],
    [from, overshoot, overshoot * 0.99, 1],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: eOut },
  );
}

/* SVG stroke draw-on: returns a strokeDashoffset given the path length. */
export function drawDash(f: number, delay: number, dur: number, length: number) {
  return length * (1 - reveal(f, delay, dur));
}

/* Stagger presets (delay step in frames) for list/grid item entrances. */
export const STAGGER = { tight: 2, snappy: 4, calm: 7 } as const;

/* Layout grid + type rhythm tokens for mograph scenes (1080-wide canvas). */
export const grid = { gutter: 28, radius: 28, card: 24 } as const;
