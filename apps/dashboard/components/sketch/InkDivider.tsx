"use client";
import { InkIcon } from "./InkIcon";

/* Wobbled hairline rule (the landing's rule-wob), optionally with the small
   rough star glyph centered — the manual's fleuron divider. Ink follows the
   usage site's currentColor; layout is self-contained (no page CSS needed). */

function Rule() {
  return (
    <svg viewBox="0 0 600 6" preserveAspectRatio="none" aria-hidden="true" style={{ flex: 1, height: 6, display: "block", minWidth: 0 }}>
      <path
        pathLength={1}
        fill="none"
        stroke="currentColor"
        strokeWidth={1}
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
        d="M2 3.4 C90 2.4 180 3.8 300 3 C410 2.3 520 3.6 598 2.8"
      />
    </svg>
  );
}

export function InkDivider({ withStar, className }: { withStar?: boolean; className?: string }) {
  return (
    <div className={className} role="separator" style={{ display: "flex", alignItems: "center", gap: 14, width: "100%" }}>
      <Rule />
      {withStar && <InkIcon name="glyph" size={11} />}
      {withStar && <Rule />}
    </div>
  );
}
