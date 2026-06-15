"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { InkChevronIcon, InkXIcon } from "../components/sketch";
import { GUIDE_TARGETS, type GuideMark, type GuideSpec } from "../lib/agent/guide-spec";

/* Soli's on-screen guide: listens for `soli:guide` events (dispatched by
   useAgent when the agent calls ui_guide), then walks the user through one or
   more steps. Each step navigates (optionally), finds the target control
   (any element stamped with data-guide="<id>"), and hand-sketches a marker
   around it — an ink circle, underline, arrow, or corner-brackets — with a
   short handwritten margin note tied to the mark by a small leader stroke. An
   optional spotlight dims the rest of the page so the control pops.

   All ink lives in ONE full-viewport SVG in absolute screen coordinates, so
   leaders and arrows can span freely from a note to a control. The overlay
   never intercepts pointer events except on the tour control bar, so the marked
   control stays fully clickable: on a single pointer any click dismisses; on a
   multi-step tour clicking the marked control (or Next) advances, and Esc quits.
   The overlay is mounted in AppShell, so a tour survives route changes. */

const SEEK_MS = 6000; // a freshly-pushed route may still be mounting
const HOLD_MS = 12000; // single-pointer auto-dismiss
const PAD = 9; // breathing room between the control and the stroke

/* Deterministic per-seed wobble so the same step draws the same mark. */
function seedFrom(s: string): () => number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return () => {
    h = Math.imul(h ^ (h >>> 15), 2246822519);
    h = Math.imul(h ^ (h >>> 13), 3266489917);
    return ((h ^= h >>> 16) >>> 0) / 4294967296;
  };
}

type Pt = [number, number];

/* Smooth a hand-jittered point list through quadratic midpoints — the wobble
   without the kinks. */
function smooth(pts: Pt[]): string {
  if (pts.length < 2) return "";
  let d = `M ${pts[0][0].toFixed(1)} ${pts[0][1].toFixed(1)}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const mx = (pts[i][0] + pts[i + 1][0]) / 2;
    const my = (pts[i][1] + pts[i + 1][1]) / 2;
    d += ` Q ${pts[i][0].toFixed(1)} ${pts[i][1].toFixed(1)} ${mx.toFixed(1)} ${my.toFixed(1)}`;
  }
  const last = pts[pts.length - 1];
  d += ` L ${last[0].toFixed(1)} ${last[1].toFixed(1)}`;
  return d;
}

type Box = { x: number; y: number; w: number; h: number };

/* ~1.6 laps around the box with radius drift and jitter — the lap overlap is
   what reads as "circled by hand". */
function inkCircle(b: Box, seed: string): string {
  const rand = seedFrom(seed);
  const cx = b.x + b.w / 2;
  const cy = b.y + b.h / 2;
  const rx = b.w / 2;
  const ry = b.h / 2;
  const turns = 1.55 + rand() * 0.15;
  const steps = Math.round(26 * turns);
  const a0 = -Math.PI * (0.55 + rand() * 0.3);
  const pts: Pt[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const a = a0 + t * turns * 2 * Math.PI;
    const drift = 1 + 0.035 * Math.sin(t * Math.PI * 2.7) + t * 0.05;
    pts.push([cx + Math.cos(a) * rx * drift + (rand() - 0.5) * 3, cy + Math.sin(a) * ry * drift + (rand() - 0.5) * 3]);
  }
  return smooth(pts);
}

/* A confident wobbled stroke under the box, with a short back-retrace for
   emphasis — the annotate underline, around real chrome. */
function inkUnderline(b: Box, seed: string): string {
  const rand = seedFrom(seed);
  const y = b.y + b.h - 2;
  const x0 = b.x + 2;
  const x1 = b.x + b.w - 2;
  const n = Math.max(6, Math.round((x1 - x0) / 24));
  const pts: Pt[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    pts.push([x0 + (x1 - x0) * t, y + (rand() - 0.5) * 2 + Math.sin(t * Math.PI) * -1.2]);
  }
  // retrace the last third slightly lower for a doubled, hand-pressed feel
  for (let i = n; i >= Math.round(n * 0.6); i--) {
    const t = i / n;
    pts.push([x0 + (x1 - x0) * t, y + 2.6 + (rand() - 0.5) * 1.8]);
  }
  return smooth(pts);
}

/* Four corner L-strokes framing the box — a viewfinder/crop bracket. */
function inkBracket(b: Box, seed: string): string {
  const rand = seedFrom(seed);
  const a = Math.min(b.w, b.h) * 0.3;
  const j = () => (rand() - 0.5) * 2.4;
  const { x, y, w, h } = b;
  return [
    [[x, y + a + j()], [x + j(), y + j()], [x + a, y + j()]],
    [[x + w - a, y + j()], [x + w + j(), y + j()], [x + w + j(), y + a + j()]],
    [[x + w - a, y + h + j()], [x + w + j(), y + h + j()], [x + w + j(), y + h - a + j()]],
    [[x + j(), y + h - a + j()], [x + j(), y + h + j()], [x + a, y + h + j()]],
  ]
    .map((c) => smooth(c as Pt[]))
    .join(" ");
}

/* A bowed shaft from (sx,sy) toward (tx,ty) with two barbs at the tip. */
function inkArrowPath(sx: number, sy: number, tx: number, ty: number, seed: string): string {
  const rand = seedFrom(seed);
  const mx = (sx + tx) / 2 + (rand() - 0.5) * 14;
  const my = (sy + ty) / 2 + (rand() - 0.5) * 14;
  const ang = Math.atan2(ty - my, tx - mx);
  const bl = 11;
  const b1: Pt = [tx - Math.cos(ang - 0.45) * bl, ty - Math.sin(ang - 0.45) * bl];
  const b2: Pt = [tx - Math.cos(ang + 0.45) * bl, ty - Math.sin(ang + 0.45) * bl];
  return (
    `M ${sx.toFixed(1)} ${sy.toFixed(1)} Q ${mx.toFixed(1)} ${my.toFixed(1)} ${tx.toFixed(1)} ${ty.toFixed(1)} ` +
    `M ${b1[0].toFixed(1)} ${b1[1].toFixed(1)} L ${tx.toFixed(1)} ${ty.toFixed(1)} L ${b2[0].toFixed(1)} ${b2[1].toFixed(1)}`
  );
}

/* A short wobbled connector from a note anchor toward the box edge. */
function inkLeader(sx: number, sy: number, tx: number, ty: number, seed: string): string {
  const rand = seedFrom(seed);
  const mx = (sx + tx) / 2 + (rand() - 0.5) * 8;
  const my = (sy + ty) / 2 + (rand() - 0.5) * 8;
  return `M ${sx.toFixed(1)} ${sy.toFixed(1)} Q ${mx.toFixed(1)} ${my.toFixed(1)} ${tx.toFixed(1)} ${ty.toFixed(1)}`;
}

type NotePos = { left: number; top: number; side: "right" | "below" | "left" | "above"; anchor: Pt };

/* Place the note in whichever margin has room, and return the anchor point on
   the note that the leader/arrow should originate from. */
function placeNote(b: Box, vw: number, vh: number): NotePos {
  const NOTE_W = 230;
  const gap = 16;
  if (b.x + b.w + gap + NOTE_W < vw) {
    return { left: b.x + b.w + gap, top: b.y + b.h / 2, side: "right", anchor: [b.x + b.w + gap, b.y + b.h / 2] };
  }
  if (b.x - gap - NOTE_W > 0) {
    return { left: b.x - gap - NOTE_W, top: b.y + b.h / 2, side: "left", anchor: [b.x - gap, b.y + b.h / 2] };
  }
  if (b.y + b.h + gap + 64 < vh) {
    const left = Math.max(12, Math.min(b.x, vw - NOTE_W - 12));
    return { left, top: b.y + b.h + gap, side: "below", anchor: [left + 18, b.y + b.h + gap] };
  }
  const left = Math.max(12, Math.min(b.x, vw - NOTE_W - 12));
  return { left, top: Math.max(12, b.y - gap - 56), side: "above", anchor: [left + 18, b.y - gap] };
}

/* Nearest point on the box edge to an external anchor (for leader/arrow tips). */
function edgePoint(b: Box, from: Pt): Pt {
  const cx = Math.max(b.x, Math.min(from[0], b.x + b.w));
  const cy = Math.max(b.y, Math.min(from[1], b.y + b.h));
  // push onto the boundary
  const dl = Math.abs(cx - b.x);
  const dr = Math.abs(cx - (b.x + b.w));
  const dt = Math.abs(cy - b.y);
  const db = Math.abs(cy - (b.y + b.h));
  const m = Math.min(dl, dr, dt, db);
  if (m === dl) return [b.x, cy];
  if (m === dr) return [b.x + b.w, cy];
  if (m === dt) return [cx, b.y];
  return [cx, b.y + b.h];
}

type Active = { stepIdx: number; box: Box; el: Element };

export function GuideOverlay({ onReveal }: { onReveal?: (spec: GuideSpec) => void }) {
  const router = useRouter();
  const pathname = usePathname();
  const [tour, setTour] = useState<GuideSpec | null>(null);
  const [active, setActive] = useState<Active | null>(null);
  const [vp, setVp] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
  const timers = useRef<{ seek?: ReturnType<typeof setInterval>; hold?: ReturnType<typeof setTimeout>; raf?: number }>({});
  const pathnameRef = useRef(pathname);
  pathnameRef.current = pathname;

  const clearTimers = useCallback(() => {
    if (timers.current.seek) clearInterval(timers.current.seek);
    if (timers.current.hold) clearTimeout(timers.current.hold);
    if (timers.current.raf) cancelAnimationFrame(timers.current.raf);
    timers.current = {};
  }, []);

  const dismiss = useCallback(() => {
    clearTimers();
    setTour(null);
    setActive(null);
  }, [clearTimers]);

  // Enter a step: navigate, then poll for the target element and lock onto it.
  const enterStep = useCallback(
    (spec: GuideSpec, idx: number) => {
      clearTimers();
      setActive(null);
      const step = spec.steps[idx];
      if (!step) return;
      setVp({ w: window.innerWidth, h: window.innerHeight });
      if (step.page && step.page !== pathnameRef.current) router.push(step.page);
      if (!step.target) return; // pure navigation step — nothing to mark

      const started = Date.now();
      const sel = `[data-guide="${CSS.escape(step.target)}"]`;
      timers.current.seek = setInterval(() => {
        onReveal?.(spec); // idempotent: keep the target's surface (mobile drawer) open
        const el = document.querySelector(sel);
        const r = el?.getBoundingClientRect();
        if (el && r && r.width > 0 && r.height > 0) {
          clearInterval(timers.current.seek!);
          timers.current.seek = undefined;
          el.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
          const rr = el.getBoundingClientRect();
          setActive({ stepIdx: idx, el, box: { x: rr.left - PAD, y: rr.top - PAD, w: rr.width + PAD * 2, h: rr.height + PAD * 2 } });
          // single-pointer guides fade on their own; tours wait for the user
          if (spec.steps.length === 1) timers.current.hold = setTimeout(dismiss, HOLD_MS);
        } else if (Date.now() - started > SEEK_MS) {
          clearInterval(timers.current.seek!);
          timers.current.seek = undefined;
        }
      }, 130);
    },
    [router, onReveal, clearTimers, dismiss],
  );

  // Listen for guide requests (from the stream, or a chip replay).
  useEffect(() => {
    const onGuide = (e: Event) => {
      const spec = (e as CustomEvent<GuideSpec>).detail;
      if (!spec?.steps?.length) return;
      setTour(spec);
      enterStep(spec, 0);
    };
    window.addEventListener("soli:guide", onGuide);
    return () => {
      window.removeEventListener("soli:guide", onGuide);
      clearTimers();
    };
  }, [enterStep, clearTimers]);

  const next = useCallback(() => {
    if (!tour || !active) return;
    const n = active.stepIdx + 1;
    if (n >= tour.steps.length) dismiss();
    else enterStep(tour, n);
  }, [tour, active, enterStep, dismiss]);

  const prev = useCallback(() => {
    if (!tour || !active || active.stepIdx === 0) return;
    enterStep(tour, active.stepIdx - 1);
  }, [tour, active, enterStep]);

  // Follow the element (scroll/resize/layout), advance/dismiss on interaction.
  useEffect(() => {
    if (!active) return;
    const isTour = (tour?.steps.length ?? 1) > 1;
    const follow = () => {
      const r = active.el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) {
        dismiss();
        return;
      }
      const nb = { x: r.left - PAD, y: r.top - PAD, w: r.width + PAD * 2, h: r.height + PAD * 2 };
      setActive((a) => (a && (Math.abs(a.box.x - nb.x) > 0.5 || Math.abs(a.box.y - nb.y) > 0.5) ? { ...a, box: nb } : a));
      setVp((v) => (v.w !== window.innerWidth || v.h !== window.innerHeight ? { w: window.innerWidth, h: window.innerHeight } : v));
      timers.current.raf = requestAnimationFrame(follow);
    };
    timers.current.raf = requestAnimationFrame(follow);
    // Clicking the marked control advances a tour (and naturally navigates if it
    // is a link); on a single pointer, any click dismisses.
    const onDown = (e: PointerEvent) => {
      const onMark = active.el.contains(e.target as Node);
      const onBar = (e.target as Element)?.closest?.(".guide-bar");
      if (onBar) return;
      if (isTour) {
        if (onMark) next();
      } else {
        dismiss();
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") dismiss();
      else if (isTour && (e.key === "ArrowRight" || e.key === "Enter")) next();
      else if (isTour && e.key === "ArrowLeft") prev();
    };
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey);
    return () => {
      if (timers.current.raf) cancelAnimationFrame(timers.current.raf);
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [active?.el, tour, dismiss, next, prev]); // eslint-disable-line react-hooks/exhaustive-deps

  const layout = useMemo(() => {
    if (!active || !tour) return null;
    const step = tour.steps[active.stepIdx];
    const b = active.box;
    const seed = `${step.target}:${active.stepIdx}`;
    const note = placeNote(b, vp.w, vp.h);
    let markPath = "";
    let connector = "";
    if (step.mark === "circle") markPath = inkCircle(b, seed);
    else if (step.mark === "underline") markPath = inkUnderline(b, seed);
    else if (step.mark === "bracket") markPath = inkBracket(b, seed);
    else if (step.mark === "arrow") {
      const tip = edgePoint(b, note.anchor);
      markPath = inkArrowPath(note.anchor[0], note.anchor[1], tip[0], tip[1], seed);
    }
    // leader ties the note to the mark for non-arrow styles when there is a gap
    if (step.note && step.mark !== "arrow") {
      const tip = edgePoint(b, note.anchor);
      const dist = Math.hypot(tip[0] - note.anchor[0], tip[1] - note.anchor[1]);
      if (dist > 10) connector = inkLeader(note.anchor[0], note.anchor[1], tip[0], tip[1], `${seed}:lead`);
    }
    return { step, b, note, markPath, connector };
  }, [active, tour, vp]);

  if (!active || !tour || !layout) return null;
  const { step, b, note, markPath, connector } = layout;
  const isTour = tour.steps.length > 1;
  const last = active.stepIdx === tour.steps.length - 1;

  return (
    <div className="guide-overlay" aria-hidden="true">
      {tour.spotlight && (
        <svg className="guide-spot" width={vp.w} height={vp.h} viewBox={`0 0 ${vp.w} ${vp.h}`}>
          <defs>
            <mask id="guide-hole">
              <rect x={0} y={0} width={vp.w} height={vp.h} fill="white" />
              <rect x={b.x - 4} y={b.y - 4} width={b.w + 8} height={b.h + 8} rx={12} fill="black" />
            </mask>
          </defs>
          <rect x={0} y={0} width={vp.w} height={vp.h} fill="rgba(6,6,6,0.55)" mask="url(#guide-hole)" />
        </svg>
      )}
      <svg className="guide-ink" width={vp.w} height={vp.h} viewBox={`0 0 ${vp.w} ${vp.h}`} fill="none" stroke="currentColor">
        {connector && (
          <path className="guide-lead" d={connector} pathLength={1} strokeWidth={1.2} strokeLinecap="round" strokeDasharray={1} strokeDashoffset={1} />
        )}
        <path className="guide-stroke" d={markPath} pathLength={1} strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" strokeDasharray={1} strokeDashoffset={1} />
      </svg>
      {step.note && (
        <div className="guide-note" data-side={note.side} style={{ left: note.left, top: note.top }}>
          {step.note}
        </div>
      )}
      {isTour && (
        <div className="guide-bar" role="group" aria-label="Guided tour controls">
          <span className="guide-count">{active.stepIdx + 1} / {tour.steps.length}</span>
          {active.stepIdx > 0 && (
            <button className="guide-btn" type="button" onClick={prev} title="Previous step" aria-label="Previous step">
              <InkChevronIcon size={12} className="guide-prev" />
            </button>
          )}
          <button className="guide-btn guide-next" type="button" onClick={next} title={last ? "Done" : "Next step"}>
            <span>{last ? "Done" : "Next"}</span>
            {!last && <InkChevronIcon size={12} />}
          </button>
          <button className="guide-btn guide-close" type="button" onClick={dismiss} title="End tour" aria-label="End tour">
            <InkXIcon size={11} />
          </button>
        </div>
      )}
    </div>
  );
}
