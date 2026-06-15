"use client";
import type { CSSProperties } from "react";
import type { UIInboxSummary } from "../../../lib/agent/ui-spec";
import { BlockFrame } from "./BlockFrame";

/* Compact community triage: counts row + up to five threads. Deep-links to
   the full /inbox console. Sketch-deep: counts then threads cascade in
   (.blk-in). */

export function InboxSummaryView({ b }: { b: UIInboxSummary }) {
  const counts: { label: string; n: number }[] = [];
  if (b.counts?.comments != null) counts.push({ label: "comments", n: b.counts.comments });
  if (b.counts?.dms != null) counts.push({ label: "dms", n: b.counts.dms });
  if (b.counts?.flagged != null) counts.push({ label: "flagged", n: b.counts.flagged });
  return (
    <BlockFrame eyebrow="inbox" href={b.href}>
      <div className="blk-ib">
        {counts.length ? (
          <div className="blk-ib-counts">
            {counts.map((c, i) => (
              <span className="blk-ib-count blk-in" key={i} style={{ "--i": i } as CSSProperties}>
                <span className="blk-ib-n">{c.n}</span> {c.label}
              </span>
            ))}
          </div>
        ) : null}
        {b.threads.length ? (
          <ul className="blk-ib-threads">
            {b.threads.map((t, i) => (
              <li className="blk-ib-thread blk-in" key={i} style={{ "--i": (counts.length ? 1 : 0) + i } as CSSProperties}>
                <span className="blk-ib-from">{t.from}</span>
                <span className="blk-ib-preview">{t.preview}</span>
                {t.kind ? <span className="blk-pill">{t.kind}</span> : null}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </BlockFrame>
  );
}
