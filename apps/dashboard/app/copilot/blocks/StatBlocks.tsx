"use client";
import type { CSSProperties } from "react";
import type {
  UIMetric,
  UIVerdict,
  UIChecklist,
  UIQuote,
  UIBadgeRow,
  UIRating,
} from "../../../lib/agent/ui-spec";
import { BlockFrame } from "./BlockFrame";
import { CountUp, fmtDelta, InkStroke } from "./anim";

/* Stat & emphasis widgets — one hero number, a stamped verdict, drawn
   checkmarks, a pull-quote, ink-outlined chips and ink stars. Same grammar
   everywhere: baked wobbled paths, pathLength=1 + .ink-drawable draw-in,
   .blk-in cascades, reduced-motion = fully drawn. */

/* Baked wobbled marquee ellipse (shared with annotate) + hand underline. */
const INK_CIRCLE =
  "M10 25 C 7 13, 28 4.6, 60 4.1 C 92 3.6, 114 9.8, 113.4 22 " +
  "C 112.8 34, 90 40.4, 57 39.9 C 30 39.5, 10.6 34.4, 9.4 26.5 " +
  "C 8.6 21, 14.5 15.2, 25 12.2";
const INK_UNDERLINE = "M3 6.4 C 28 3.9, 58 7.7, 89 5 C 100 4.2, 110.5 5.6, 117 4.7";

/* ---------- metric ---------- */

export function MetricView({ b }: { b: UIMetric }) {
  return (
    <BlockFrame eyebrow={b.label} href={b.href} hug>
      <div className="blk-mt">
        <span className="blk-mt-wrap">
          <span className="blk-mt-value">
            <CountUp value={b.value} delayMs={150} />
            {b.unit ? <span className="blk-mt-unit">{b.unit}</span> : null}
          </span>
          <InkStroke d={INK_UNDERLINE} viewBox="0 0 120 10" className="blk-mt-ink" delayMs={620} durMs={460} />
        </span>
        {typeof b.delta === "number" && b.delta !== 0 ? (
          <span className={`blk-mt-delta ${b.delta > 0 ? "up" : "down"}`}>
            {b.delta > 0 ? "▲" : "▼"} {fmtDelta(b.delta)}
          </span>
        ) : null}
      </div>
    </BlockFrame>
  );
}

/* ---------- verdict ---------- */

const VERDICT_WORD: Record<UIVerdict["verdict"], string> = { go: "GO", hold: "HOLD", kill: "KILL" };

export function VerdictView({ b }: { b: UIVerdict }) {
  return (
    <BlockFrame eyebrow="verdict" href={b.href} hug>
      <div className="blk-vd">
        <span className={`blk-vd-stamp v-${b.verdict}`}>
          <span className="blk-vd-word">{VERDICT_WORD[b.verdict]}</span>
          <InkStroke d={INK_CIRCLE} viewBox="0 0 120 44" className="blk-vd-ink" delayMs={260} durMs={560} width={1.6} />
        </span>
        <div className="blk-vd-main">
          <div className="blk-vd-title">{b.title}</div>
          {b.reason ? <div className="blk-vd-reason">{b.reason}</div> : null}
        </div>
      </div>
    </BlockFrame>
  );
}

/* ---------- checklist ---------- */

/* wobbled box + hand check, both drawable */
const INK_BOX = "M2.6 2.2 C 6.5 1.8, 10.4 2.5, 13.5 2.3 C 13.8 5.6, 13.4 9.6, 13.6 13.2 C 9.8 13.6, 5.6 13.3, 2.4 13.5 C 2.2 9.8, 2.7 6, 2.6 2.6";
const INK_CHECK = "M3.4 8.6 C 4.8 9.9, 5.9 11.4, 6.8 12.6 C 8.6 9.4, 11.2 5.2, 14.2 2.4";

export function ChecklistView({ b }: { b: UIChecklist }) {
  const done = b.items.filter((i) => i.done).length;
  return (
    <BlockFrame eyebrow={b.title ?? "checklist"} meta={`${done}/${b.items.length}`} href={b.href}>
      <ul className="blk-ck">
        {b.items.map((it, i) => (
          <li className={`blk-ck-row blk-in${it.done ? " done" : ""}`} key={i} style={{ "--i": i } as CSSProperties}>
            <span className="blk-ck-box">
              <InkStroke d={INK_BOX} viewBox="0 0 16 16" className="blk-ck-frame" delayMs={i * 70} durMs={300} width={1.2} />
              {it.done ? (
                <InkStroke d={INK_CHECK} viewBox="0 0 16 16" className="blk-ck-mark" delayMs={i * 70 + 260} durMs={280} width={1.6} />
              ) : null}
            </span>
            <span className="blk-ck-label">{it.label}</span>
          </li>
        ))}
      </ul>
    </BlockFrame>
  );
}

/* ---------- quote ---------- */

/* a hand-drawn double opening quote */
const INK_QUOTE =
  "M4.5 14.5 C 3.2 10.5, 5 5.5, 9.5 3.2 C 7.4 6.6, 6.8 9.4, 7.4 12.8 C 6.4 13.6, 5.4 14.2, 4.5 14.5 Z " +
  "M12.5 14.5 C 11.2 10.5, 13 5.5, 17.5 3.2 C 15.4 6.6, 14.8 9.4, 15.4 12.8 C 14.4 13.6, 13.4 14.2, 12.5 14.5 Z";

export function QuoteView({ b }: { b: UIQuote }) {
  return (
    <BlockFrame eyebrow="quote" href={b.href}>
      <figure className="blk-qt">
        <InkStroke d={INK_QUOTE} viewBox="0 0 21 17" className="blk-qt-mark" durMs={620} width={1.3} />
        <blockquote className="blk-qt-text blk-in">{b.text}</blockquote>
        {b.by ? <figcaption className="blk-qt-by blk-in" style={{ "--i": 2 } as CSSProperties}>— {b.by}</figcaption> : null}
      </figure>
    </BlockFrame>
  );
}

/* ---------- badge_row ---------- */

/* wobbled pill outline, stretched per chip */
const INK_PILL =
  "M16 2.6 C 36 1.9, 66 3.1, 86 2.4 C 95 2.2, 99.6 6.5, 99.4 13.8 C 99.2 21.4, 94 25.8, 85 25.5 " +
  "C 64 24.9, 36 26.2, 15.5 25.6 C 7 25.3, 2.6 21, 2.8 13.6 C 3 6.6, 8 2.9, 16.5 2.8";

export function BadgeRowView({ b }: { b: UIBadgeRow }) {
  return (
    <BlockFrame eyebrow={b.title ?? "tags"}>
      <div className="blk-bd">
        {b.badges.map((badge, i) => (
          <span
            className={`blk-bd-chip blk-in k-${badge.kind ?? "default"}`}
            key={i}
            style={{ "--i": i } as CSSProperties}
          >
            <InkStroke d={INK_PILL} viewBox="0 0 102 28" className="blk-bd-ink" delayMs={i * 90} durMs={420} width={1.1} />
            {badge.label}
          </span>
        ))}
      </div>
    </BlockFrame>
  );
}

/* ---------- rating ---------- */

/* the brand's four-pointed ink star, drawable */
const INK_STAR =
  "M8 1.4 C 8.8 5.4, 10.4 7.1, 14.5 8 C 10.4 8.9, 8.8 10.6, 8 14.6 C 7.2 10.6, 5.5 8.9, 1.5 8 C 5.5 7.1, 7.2 5.4, 8 1.4 Z";

export function RatingView({ b }: { b: UIRating }) {
  const full = Math.floor(b.value);
  const half = b.value - full >= 0.5;
  return (
    <BlockFrame eyebrow={b.label ?? "rating"} href={b.href} hug>
      <div className="blk-rt">
        <span className="blk-rt-stars">
          {Array.from({ length: 5 }, (_, i) => {
            const lit = i < full || (i === full && half);
            return (
              <span className={`blk-rt-star${lit ? " lit" : ""}${i === full && half ? " half" : ""}`} key={i}>
                <InkStroke d={INK_STAR} viewBox="0 0 16 16" className="blk-rt-ink" delayMs={i * 110} durMs={340} width={1.2} />
              </span>
            );
          })}
        </span>
        <span className="blk-rt-value">{b.value.toFixed(1).replace(/\.0$/, "")}/5</span>
      </div>
    </BlockFrame>
  );
}
