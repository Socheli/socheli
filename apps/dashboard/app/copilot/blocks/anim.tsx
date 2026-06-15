"use client";
import { useEffect, useRef, useState, type CSSProperties } from "react";

/* ---------- unified entrance orchestration ----------
   ONE mechanism drives every block's entrance: an IntersectionObserver toggles
   a reveal flag when the block enters/leaves the viewport. BlockFrame (and the
   frame-less AnnotateView) put a `blk-anim` marker on the block root and add
   `blk-reveal` while in view. The CSS holds all child animations (.blk-in
   cascades, .ink-drawable draw-ins, bar grows, stamps, arc sweeps) in their
   PRE state until `blk-reveal` is present, then lets them run — and because the
   reveal class is REMOVED on exit and re-added on re-entry, the whole entrance
   REPLAYS each time the block scrolls back into view (like the landing's
   reversible reveals). One timing system (frame ink → children cascade via --i
   → spark micro-motion) lives entirely in CSS; this hook only flips the flag.

   Reveal reverses only on exit BELOW the viewport (scrolling back up), matching
   the landing grammar — exits ABOVE keep the block drawn so scrolling down a
   long transcript never "un-draws" what you've passed. SSR / no-IO / reduced
   data: defaults to revealed so content is never stuck hidden. */
export function useInView<T extends HTMLElement>(): { ref: React.RefObject<T | null>; inView: boolean } {
  const ref = useRef<T | null>(null);
  // Start revealed for SSR + the no-IntersectionObserver fallback; the observer
  // (when present) immediately corrects it to the real visibility on mount.
  const [inView, setInView] = useState(true);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) setInView(true);
          // Only un-reveal when the block has scrolled off the BOTTOM (its top
          // is below the viewport) — exits off the top stay drawn.
          else if (e.boundingClientRect.top > 0) setInView(false);
        }
      },
      { threshold: 0.12, rootMargin: "0px 0px -8% 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return { ref, inView };
}

/* Shared animation + formatting grammar for the .blk- widget views.

   CountUp: a mono number counting up from 0 in sync with its growing bar /
   drawing stroke (one rAF loop per value — block payloads are capped small,
   so this stays cheap). SSR/first paint shows the final value; reduced
   motion skips the count entirely. */

export function fmt(n: number): string {
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (Math.abs(n) >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  return String(Math.round(n) === n ? n : Number(n.toFixed(1)));
}

export function fmtDelta(d: number): string {
  const a = Math.abs(d);
  const s = a >= 100 ? String(Math.round(a)) : a.toFixed(1).replace(/\.0$/, "");
  return `${s}%`;
}

export const COUNT_MS = 620; // matches the blk-grow duration in CSS
export const STEP_MS = 55; // matches the .blk-in stagger step

export function CountUp({
  value,
  delayMs,
  decimals = 0,
  format = true,
}: {
  value: number;
  delayMs: number;
  decimals?: number;
  format?: boolean;
}) {
  const [shown, setShown] = useState<number | null>(null);
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setShown(value);
      return;
    }
    let raf = 0;
    let start: number | null = null;
    const tick = (t: number) => {
      if (start === null) start = t;
      const el = t - start - delayMs;
      if (el <= 0) {
        setShown(0);
        raf = requestAnimationFrame(tick);
        return;
      }
      const p = Math.min(1, el / COUNT_MS);
      const eased = 1 - Math.pow(1 - p, 3);
      setShown(value * eased);
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value, delayMs]);
  const v = shown ?? value;
  if (format) return <>{fmt(Math.round(v))}</>;
  return <>{v.toFixed(decimals)}</>;
}

/* One baked wobbled stroke that draws itself in: pathLength=1 + the shared
   .ink-drawable stroke-dashoffset animation, sequenced via --ink-delay/--ink-dur,
   stretched to its box (preserveAspectRatio="none") with a true-px stroke
   (vector-effect). The building block of every widget's hand-drawn marks. */
export function InkStroke({
  d,
  viewBox,
  className,
  delayMs = 0,
  durMs = 520,
  width = 1.3,
}: {
  d: string;
  viewBox: string;
  className: string;
  delayMs?: number;
  durMs?: number;
  width?: number;
}) {
  return (
    <svg
      className={`${className} ink-drawable`}
      viewBox={viewBox}
      preserveAspectRatio="none"
      style={{ "--ink-delay": `${delayMs}ms`, "--ink-dur": `${durMs}ms` } as CSSProperties}
      aria-hidden
    >
      <path
        d={d}
        pathLength={1}
        fill="none"
        stroke="currentColor"
        strokeWidth={width}
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

/* Tiny deterministic PRNG (mulberry32 over a string hash) — used to
   synthesize stable pseudo-waveforms when a voice_track has no bars. */
export function seeded(seed: string): () => number {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let a = h >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
