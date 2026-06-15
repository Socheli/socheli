"use client";
import type { CSSProperties } from "react";
import type { UIInsightsChart } from "../../../lib/agent/ui-spec";
import { BlockFrame } from "./BlockFrame";
import { CountUp, fmtDelta, STEP_MS } from "./anim";

/* Compact horizontal bar chart — pure CSS divs in bone ink, values mono.
   No chart lib; bars scale to the series max. Optional per-point `delta`
   (signed % vs the previous period) renders as a tinted ▲/▼ after the value.

   Sketch-deep: rows cascade in (.blk-in), each bar GROWS from 0 (CSS scaleX,
   staggered via --i) and its mono value counts up alongside (shared CountUp
   in ./anim). prefers-reduced-motion: bars full, values final, no counting. */

export function InsightsChartView({ b }: { b: UIInsightsChart }) {
  const max = Math.max(...b.series.map((s) => s.value), 0);
  return (
    <BlockFrame eyebrow={b.title ?? "insights"} href={b.href}>
      <div className="blk-ic">
        {b.series.map((s, i) => (
          <div className="blk-ic-row blk-in" key={i} style={{ "--i": i } as CSSProperties}>
            <span className="blk-ic-label" title={s.label}>
              {s.label}
            </span>
            <span className="blk-ic-track">
              <span
                className="blk-ic-bar"
                style={{ width: max > 0 ? `${Math.max(1.5, (s.value / max) * 100)}%` : "1.5%" }}
              />
            </span>
            <span className="blk-ic-value">
              <CountUp value={s.value} delayMs={i * STEP_MS} />
              {b.unit ? <span className="blk-ic-unit"> {b.unit}</span> : null}
              {typeof s.delta === "number" && s.delta !== 0 ? (
                <span className={`blk-ic-delta ${s.delta > 0 ? "up" : "down"}`}>
                  {s.delta > 0 ? "▲" : "▼"}{fmtDelta(s.delta)}
                </span>
              ) : null}
            </span>
          </div>
        ))}
      </div>
    </BlockFrame>
  );
}
