"use client";
import { useMemo, type CSSProperties } from "react";
import type { UISparkline, UIDonut, UIGauge, UIHeatmap, UIFunnel } from "../../../lib/agent/ui-spec";
import { BlockFrame } from "./BlockFrame";
import { CountUp, fmt, STEP_MS } from "./anim";

/* Chart widgets — pure SVG/CSS in the house ink grammar, no chart lib.
   Strokes draw themselves (pathLength=1 + .ink-drawable, or an animated
   stroke-dasharray sweep for arcs where the unit-dash rule would fight the
   arc math), values count up, rows cascade (.blk-in). All decorative motion
   is covered by the reduced-motion rules in globals.css. */

/* ---------- sparkline ---------- */

const SL_W = 200;
const SL_H = 44;
const SL_PAD = 4;

export function SparklineView({ b }: { b: UISparkline }) {
  const min = Math.min(...b.points);
  const max = Math.max(...b.points);
  const span = max - min || 1;
  const px = (i: number) => SL_PAD + (i / (b.points.length - 1)) * (SL_W - SL_PAD * 2);
  const py = (v: number) => SL_H - SL_PAD - ((v - min) / span) * (SL_H - SL_PAD * 2);
  const d = b.points.map((v, i) => `${i === 0 ? "M" : "L"}${px(i).toFixed(1)} ${py(v).toFixed(1)}`).join(" ");
  const last = b.points[b.points.length - 1];
  const first = b.points[0];
  const up = last >= first;
  return (
    <BlockFrame eyebrow={b.title ?? "trend"} href={b.href}>
      <div className="blk-sl">
        <div className="blk-sl-chart">
          <svg
            className="blk-sl-svg ink-drawable"
            viewBox={`0 0 ${SL_W} ${SL_H}`}
            preserveAspectRatio="none"
            style={{ "--ink-dur": "900ms" } as CSSProperties}
            aria-hidden
          >
            <path
              d={d}
              pathLength={1}
              fill="none"
              stroke="currentColor"
              strokeWidth={1.4}
              strokeLinecap="round"
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
            />
          </svg>
          <span className="blk-sl-dot" style={{ left: "100%", top: `${(py(last) / SL_H) * 100}%` }} />
          {(b.startLabel || b.endLabel) ? (
            <div className="blk-sl-range">
              <span>{b.startLabel ?? ""}</span>
              <span>{b.endLabel ?? ""}</span>
            </div>
          ) : null}
        </div>
        <div className="blk-sl-now">
          <span className={`blk-sl-value${up ? "" : " down"}`}>
            <CountUp value={last} delayMs={350} />
            {b.unit ? <span className="blk-ic-unit"> {b.unit}</span> : null}
          </span>
          <span className={`blk-sl-dir ${up ? "up" : "down"}`}>{up ? "▲" : "▼"}</span>
        </div>
      </div>
    </BlockFrame>
  );
}

/* ---------- donut ---------- */

/* Slice opacities walk down from full ink so the ring reads without color. */
const DONUT_ALPHA = [1, 0.66, 0.42, 0.27, 0.17, 0.1];

export function DonutView({ b }: { b: UIDonut }) {
  const total = b.slices.reduce((a, s) => a + s.value, 0) || 1;
  let acc = 0;
  return (
    <BlockFrame eyebrow={b.title ?? "share"} href={b.href}>
      <div className="blk-dn">
        <div className="blk-dn-ring">
          {/* arcs sweep in via the blk-arc dasharray animation (NOT
              .ink-drawable — the unit-dash rule would override the arc math) */}
          <svg viewBox="0 0 64 64" aria-hidden>
            <circle cx={32} cy={32} r={26} fill="none" stroke="var(--border-subtle)" strokeWidth={1} />
            {b.slices.map((s, i) => {
              const len = (s.value / total) * 100;
              const start = acc;
              acc += len;
              return (
                <circle
                  key={i}
                  className="blk-dn-arc"
                  cx={32}
                  cy={32}
                  r={26}
                  pathLength={100}
                  fill="none"
                  stroke="var(--accent)"
                  strokeOpacity={DONUT_ALPHA[i] ?? 0.1}
                  strokeWidth={7}
                  strokeDasharray={`${Math.max(0, len - 1.2)} 100`}
                  style={{
                    transform: `rotate(${start * 3.6 - 90}deg)`,
                    animationDelay: `${i * 140}ms`,
                  } as CSSProperties}
                />
              );
            })}
          </svg>
          <span className="blk-dn-total">
            <CountUp value={total} delayMs={200} />
            {b.unit ? <span className="blk-dn-unit">{b.unit}</span> : null}
          </span>
        </div>
        <ul className="blk-dn-legend">
          {b.slices.map((s, i) => (
            <li className="blk-in" key={i} style={{ "--i": i } as CSSProperties}>
              <span className="blk-dn-swatch" style={{ opacity: DONUT_ALPHA[i] ?? 0.1 }} />
              <span className="blk-dn-label" title={s.label}>{s.label}</span>
              <span className="blk-dn-val">
                {fmt(s.value)} <span className="blk-dn-pct">{Math.round((s.value / total) * 100)}%</span>
              </span>
            </li>
          ))}
        </ul>
      </div>
    </BlockFrame>
  );
}

/* ---------- gauge ---------- */

const GAUGE_ARC = "M12 56 A 48 48 0 0 1 108 56"; // semicircle, center (60,56)

export function GaugeView({ b }: { b: UIGauge }) {
  const angle = -90 + (b.value / 100) * 180;
  const targetAngle = b.target == null ? null : -90 + (b.target / 100) * 180;
  return (
    <BlockFrame eyebrow={b.label} href={b.href} hug>
      <div className="blk-gg">
        <svg viewBox="0 0 120 66" className="blk-gg-svg" aria-hidden>
          <path d={GAUGE_ARC} fill="none" stroke="var(--border-subtle)" strokeWidth={2} strokeLinecap="round" />
          <path
            className="blk-gg-fill"
            d={GAUGE_ARC}
            pathLength={100}
            fill="none"
            stroke="var(--accent)"
            strokeWidth={4}
            strokeLinecap="round"
            strokeDasharray={`${b.value} 100`}
          />
          {targetAngle != null ? (
            <line
              className="blk-gg-target"
              x1={60} y1={14} x2={60} y2={6}
              stroke="var(--text-muted)"
              strokeWidth={1.4}
              strokeLinecap="round"
              style={{ transform: `rotate(${targetAngle}deg)` } as CSSProperties}
            />
          ) : null}
          <line
            className="blk-gg-needle"
            x1={60} y1={56} x2={60} y2={18}
            stroke="var(--text-light)"
            strokeWidth={1.6}
            strokeLinecap="round"
            style={{ "--ga": `${angle}deg` } as CSSProperties}
          />
          <circle cx={60} cy={56} r={2.6} fill="var(--text-light)" />
        </svg>
        <div className="blk-gg-value">
          <CountUp value={b.value} delayMs={250} />
          <span className="blk-gg-unit">{b.unit ?? "%"}</span>
          {b.target != null ? <span className="blk-gg-tlabel">target {b.target}</span> : null}
        </div>
      </div>
    </BlockFrame>
  );
}

/* ---------- heatmap ---------- */

export function HeatmapView({ b }: { b: UIHeatmap }) {
  const cols = b.xLabels.length;
  // Cells fade in INTENSITY-ordered (hottest first), not reading order — the
  // grid "lights up" from its strongest cells outward. Rank every cell by value
  // descending and use that rank as its --i stagger index.
  const rank = useMemo(() => {
    const flat: { idx: number; v: number }[] = [];
    for (let yi = 0; yi < b.yLabels.length; yi++) {
      for (let xi = 0; xi < cols; xi++) flat.push({ idx: yi * cols + xi, v: b.cells[yi]?.[xi] ?? 0 });
    }
    flat.sort((a, c) => c.v - a.v);
    const r = new Map<number, number>();
    flat.forEach((c, order) => r.set(c.idx, order));
    return r;
  }, [b.cells, b.yLabels.length, cols]);
  return (
    <BlockFrame eyebrow={b.title ?? "heatmap"} href={b.href}>
      <div className="blk-hm" style={{ gridTemplateColumns: `auto repeat(${cols}, minmax(0, 1fr))` }}>
        <span className="blk-hm-corner" />
        {b.xLabels.map((x, i) => (
          <span className="blk-hm-x" key={`x${i}`} title={x}>{x}</span>
        ))}
        {b.yLabels.map((y, yi) => (
          <FragmentRow key={`y${yi}`} y={y} yi={yi} row={b.cells[yi]} cols={cols} rank={rank} />
        ))}
      </div>
    </BlockFrame>
  );
}

function FragmentRow({ y, yi, row, cols, rank }: { y: string; yi: number; row: number[]; cols: number; rank: Map<number, number> }) {
  return (
    <>
      <span className="blk-hm-y" title={y}>{y}</span>
      {Array.from({ length: cols }, (_, xi) => {
        const v = row?.[xi] ?? 0;
        const idx = yi * cols + xi;
        return (
          <span
            className="blk-hm-cell blk-in"
            key={xi}
            title={`${Math.round(v * 100)}%`}
            style={{ "--i": rank.get(idx) ?? idx, "--hv": v } as CSSProperties}
          />
        );
      })}
    </>
  );
}

/* ---------- funnel ---------- */

export function FunnelView({ b }: { b: UIFunnel }) {
  const max = Math.max(...b.stages.map((s) => s.value), 1);
  return (
    <BlockFrame eyebrow={b.title ?? "funnel"} href={b.href}>
      <div className="blk-fn">
        {b.stages.map((s, i) => {
          const prev = i > 0 ? b.stages[i - 1].value : null;
          const conv = prev != null && prev > 0 ? Math.round((s.value / prev) * 100) : null;
          return (
            <div className="blk-fn-stage blk-in" key={i} style={{ "--i": i } as CSSProperties}>
              {conv != null ? <span className="blk-fn-conv">↓ {conv}%</span> : null}
              <div className="blk-fn-row">
                <span className="blk-fn-label" title={s.label}>{s.label}</span>
                <span className="blk-fn-track">
                  <span
                    className="blk-fn-bar"
                    style={{ width: `${Math.max(2, (s.value / max) * 100)}%`, animationDelay: `${i * STEP_MS}ms` } as CSSProperties}
                  />
                </span>
                <span className="blk-fn-value">
                  <CountUp value={s.value} delayMs={i * STEP_MS} />
                  {b.unit ? <span className="blk-ic-unit"> {b.unit}</span> : null}
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </BlockFrame>
  );
}
