"use client";
import type { CSSProperties } from "react";
import type { UITimeline } from "../../../lib/agent/ui-spec";
import { BlockFrame } from "./BlockFrame";
import { InkIcon } from "../../../components/sketch";

/* Vertical ink timeline for histories, mission progress and dated plans:
   star-glyph nodes on a hand-wobbled connector line (preserveAspectRatio=
   "none" stretches one wobbly path between nodes), mono timestamps, title +
   optional detail per event. Ink stays sparse — one glyph per node.

   Sketch-deep: events cascade in (.blk-in) while each node star STAMPS in
   sequence down the rail (.blk-stamp — a quick scale/opacity press, like a
   chop hitting paper) and each connector segment draws in after its node
   (pathLength=1 + the shared .ink-drawable draw-in). */

export function TimelineView({ b }: { b: UITimeline }) {
  return (
    <BlockFrame eyebrow="timeline" href={b.href}>
      <div className="blk-tl">
        {b.events.map((e, i) => (
          <div className="blk-tl-ev blk-in" key={i} style={{ "--i": i } as CSSProperties}>
            <div className="blk-tl-rail">
              <InkIcon name="glyph" size={11} className="blk-tl-node blk-stamp" />
              {i < b.events.length - 1 ? (
                <svg
                  className="blk-tl-line ink-drawable"
                  viewBox="0 0 8 40"
                  preserveAspectRatio="none"
                  style={{ "--ink-delay": `${260 + i * 160}ms`, "--ink-dur": "320ms" } as CSSProperties}
                  aria-hidden
                >
                  <path
                    d="M4 1 C 4.9 8.2, 3.2 15.8, 4.1 23.6 C 4.7 30.4, 3.5 35.6, 4 39"
                    pathLength={1}
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.2"
                    strokeLinecap="round"
                  />
                </svg>
              ) : null}
            </div>
            <div className="blk-tl-main">
              <div className="blk-tl-head">
                <span className="blk-tl-at">{e.at}</span>
                {e.kind ? <span className="blk-pill">{e.kind}</span> : null}
              </div>
              <div className="blk-tl-title">{e.title}</div>
              {e.detail ? <div className="blk-tl-detail">{e.detail}</div> : null}
            </div>
          </div>
        ))}
      </div>
    </BlockFrame>
  );
}
