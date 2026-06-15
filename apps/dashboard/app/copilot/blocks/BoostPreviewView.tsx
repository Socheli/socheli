"use client";
import type { CSSProperties } from "react";
import type { UIBoostPreview } from "../../../lib/agent/ui-spec";
import { BlockFrame } from "./BlockFrame";

/* The ads dry-run preview as a block: budget line, gate reasons with little
   ink x-marks, planned API calls as a mono list. INTENTIONALLY no launch
   button — approval and launch happen on /ads or via the explicit confirmed
   chat flow (gates are sacred). */

function InkX() {
  return (
    <svg className="blk-bp-x" viewBox="0 0 10 10" width={9} height={9} aria-hidden="true">
      <g fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round">
        <path d="M1.4 1.8 C3 3.4 6.4 6.6 8.7 8.4" />
        <path d="M8.5 1.5 C6.6 3.5 3.2 6.5 1.6 8.6" />
      </g>
    </svg>
  );
}

export function BoostPreviewView({ b }: { b: UIBoostPreview }) {
  const total = b.dailyBudgetUsd * b.durationDays;
  return (
    <BlockFrame
      eyebrow="boost · dry run"
      href={b.href}
      meta={<span className="blk-pill">{b.status}</span>}
    >
      <div className="blk-bp">
        <div className="blk-bp-budget">
          ${b.dailyBudgetUsd}/day × {b.durationDays}d{total > 0 ? <span className="blk-bp-total"> = ${total}</span> : null}
          <span className="blk-bp-id">{b.adId}</span>
        </div>
        {b.gateReasons.length ? (
          <ul className="blk-bp-gates">
            {b.gateReasons.map((r, i) => (
              <li className="blk-in" key={i} style={{ "--i": i } as CSSProperties}>
                <InkX />
                <span>{r}</span>
              </li>
            ))}
          </ul>
        ) : (
          <div className="blk-bp-clear">no blocking gates</div>
        )}
        {b.calls && b.calls.length ? (
          <ol className="blk-bp-calls">
            {b.calls.map((c, i) => (
              <li key={i}>
                <span className="blk-bp-step">{c.step}</span>
                <span className="blk-bp-path">{c.path}</span>
              </li>
            ))}
          </ol>
        ) : null}
        <div className="blk-bp-note">approval &amp; launch on /ads</div>
      </div>
    </BlockFrame>
  );
}
