"use client";
import type { ReactNode } from "react";

/* The floating card both composer palettes share: absolutely positioned above
   the composer (.cp-composer is position:relative), registration-tick corners
   in the blocks grammar (card ::before/::after take the top pair, .cmp-corners
   the bottom pair), and an inner scroll region so the ticks never clip.
   Focus stays in the textarea — rows preventDefault on mousedown — so the
   card never traps focus; Esc/blur in the composer dismisses it. */
export function PopCard({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="cmp-pop" role="listbox" aria-label={label}>
      <span className="cmp-corners" aria-hidden="true" />
      <div className="cmp-pop-label">{label}</div>
      <div className="cmp-pop-scroll">{children}</div>
    </div>
  );
}

/* One keyboard-navigable row. Mousedown is swallowed so the textarea keeps
   focus (no trap); hover moves the active index so keys and mouse agree. */
export function PopRow({
  active,
  onPick,
  onHover,
  children,
}: {
  active: boolean;
  onPick: () => void;
  onHover: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={active}
      className={`cmp-row${active ? " active" : ""}`}
      tabIndex={-1}
      onMouseDown={(e) => e.preventDefault()}
      onMouseEnter={onHover}
      onClick={onPick}
    >
      {children}
    </button>
  );
}
