"use client";
import type { UIRenderProgress } from "../../../lib/agent/ui-spec";
import { BlockFrame } from "./BlockFrame";

/* Static render snapshot: stage label, thin ink progress bar, last log lines.
   Deliberately no polling — Soli re-renders the block for fresh numbers (the
   generic `progress` block with jobId/itemId is the live variant). */

export function RenderProgressView({ b }: { b: UIRenderProgress }) {
  const pct = b.status === "done" ? 100 : b.pct;
  return (
    <BlockFrame
      eyebrow="render"
      href={b.href}
      meta={<span className={`blk-pill rp-${b.status}`}>{b.status}</span>}
    >
      <div className="blk-rp">
        <div className="blk-rp-head">
          <span className="blk-rp-stage">{b.stage}</span>
          {pct != null ? <span className="blk-rp-pct">{pct}%</span> : null}
        </div>
        <div className="blk-rp-track">
          <div
            className={`blk-rp-fill rp-${b.status}`}
            style={{ width: `${pct ?? (b.status === "running" ? 0 : 100)}%` }}
          />
        </div>
        {b.log && b.log.length ? (
          <div className="blk-rp-log">
            {b.log.map((line, i) => (
              <div className="blk-rp-line" key={i}>
                {line}
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </BlockFrame>
  );
}
