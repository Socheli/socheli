"use client";
import type { CSSProperties } from "react";
import type { UIScorecard, ScoreVerdict } from "../../../lib/agent/ui-spec";
import { BlockFrame } from "./BlockFrame";

/* Designed verdict table for analysis results (strengths & risks): a verdict
   dot tinted success/warning/error, the label column, the verdict word in
   mono, and an optional note. Replaces the markdown tables Soli used to
   hand-build for "score this" questions.

   Sketch-deep: rows cascade in (.blk-in) and each verdict dot gets a tiny
   wobbled ink circle that draws itself around the verdict, one row after the
   other (pathLength=1 + the shared .ink-drawable draw-in). */

const VERDICT_LABEL: Record<ScoreVerdict, string> = {
  strong: "strong",
  variable: "variable",
  weak: "weak",
};

/* Baked wobbled ring, slightly open where the hand lifts off. */
const INK_RING =
  "M8 2.6 C 11.6 1.6, 14.6 4.4, 14.4 8 C 14.2 11.8, 11.4 14.5, 7.8 14.3 " +
  "C 4.2 14.1, 1.6 11.4, 1.8 7.7 C 2 4.3, 4.6 2.1, 7.4 2.3";

export function ScorecardView({ b }: { b: UIScorecard }) {
  return (
    <BlockFrame eyebrow={b.title ?? "scorecard"} href={b.href}>
      <div className="blk-sc">
        {b.rows.map((r, i) => (
          <div className="blk-sc-row blk-in" key={i} style={{ "--i": i } as CSSProperties}>
            <span className="blk-sc-mark">
              <span className={`blk-sc-dot v-${r.verdict}`} />
              <svg
                className={`blk-sc-ring ink-drawable v-${r.verdict}`}
                viewBox="0 0 16 16"
                style={{ "--ink-delay": `${300 + i * 140}ms`, "--ink-dur": "420ms" } as CSSProperties}
                aria-hidden
              >
                <path
                  d={INK_RING}
                  pathLength={1}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={1.1}
                  strokeLinecap="round"
                />
              </svg>
            </span>
            <span className="blk-sc-label">{r.label}</span>
            <span className={`blk-sc-verdict v-${r.verdict}`}>{VERDICT_LABEL[r.verdict]}</span>
            {r.note ? <span className="blk-sc-note">{r.note}</span> : null}
          </div>
        ))}
      </div>
    </BlockFrame>
  );
}
