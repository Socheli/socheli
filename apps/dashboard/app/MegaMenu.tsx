"use client";
import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { usePathname } from "next/navigation";
import Link from "next/link";
import type { MegaCategory } from "./nav";
import { InkDivider, InkIcon } from "../components/sketch";

/* The mega-menu flyout — a floating, house-styled card anchored to the right of
   the rail. One panel renders one category: an InkDivider header carrying the
   category name as a mono eyebrow, then the category's links as rich rows
   (lucide icon + label + desc subtitle) laid out in a 1- or 2-column grid.

   It is purely presentational + interactive — open/close orchestration (hover
   intent, sticky click, Esc/outside-click/route-change) lives in the Sidebar,
   which owns the trigger rows and tells this component which category is open
   and where to anchor it. The panel is position:fixed so it never pushes
   content (no layout shift), and draws itself in (opacity + slide; the ink
   header strokes draw via .ink-drawable). Reduced-motion = instant.

   Keyboard: on open, focus lands on the first item. Arrow keys move between
   items (wrapping), Esc closes and returns focus to the trigger. Active route
   gets the ink star + highlight; hover/focus sparks the row. */

export type MegaAnchor = { top: number; left: number };

function isActive(path: string, href: string) {
  return href === "/" ? path === "/" : path === href || path.startsWith(href + "/");
}

export function MegaMenu({
  category,
  anchor,
  onClose,
  onNavigate,
  onPanelEnter,
  onPanelLeave,
  triggerRef,
}: {
  category: MegaCategory;
  anchor: MegaAnchor;
  onClose: () => void;
  onNavigate?: () => void;
  onPanelEnter?: () => void;
  onPanelLeave?: () => void;
  triggerRef?: React.RefObject<HTMLElement | null>;
}) {
  const path = usePathname();
  const panelRef = useRef<HTMLDivElement | null>(null);
  const itemRefs = useRef<(HTMLAnchorElement | null)[]>([]);
  const labelId = useId();
  const [shifted, setShifted] = useState<CSSProperties>({});

  const links = category.columns.flatMap((c) => c.links);
  const multi = category.columns.length > 1 || links.length >= 4;

  // Focus the first item on open (focus management for keyboard users).
  useEffect(() => {
    const first = itemRefs.current.find(Boolean);
    first?.focus({ preventScroll: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [category.key]);

  // Keep the panel on-screen vertically: if it would overflow the viewport
  // bottom, nudge it up. Measured after paint; never pushes layout.
  useLayoutEffect(() => {
    const el = panelRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const overflow = r.bottom - (window.innerHeight - 12);
    if (overflow > 0) setShifted({ top: Math.max(12, anchor.top - overflow) });
    else setShifted({});
  }, [category.key, anchor.top]);

  const focusItem = (i: number) => {
    const n = links.length;
    const idx = ((i % n) + n) % n;
    itemRefs.current[idx]?.focus({ preventScroll: true });
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const active = document.activeElement;
    const cur = itemRefs.current.findIndex((el) => el === active);
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
      (triggerRef?.current as HTMLElement | null)?.focus();
    } else if (e.key === "ArrowDown" || (multi && e.key === "ArrowRight")) {
      e.preventDefault();
      focusItem(cur < 0 ? 0 : cur + 1);
    } else if (e.key === "ArrowUp" || (multi && e.key === "ArrowLeft")) {
      e.preventDefault();
      focusItem(cur < 0 ? 0 : cur - 1);
    } else if (e.key === "Home") {
      e.preventDefault();
      focusItem(0);
    } else if (e.key === "End") {
      e.preventDefault();
      focusItem(links.length - 1);
    }
  };

  let flat = -1; // running index across columns so arrow nav spans the whole panel
  return (
    <div
      ref={panelRef}
      className="mm-panel"
      role="menu"
      aria-labelledby={labelId}
      style={{ top: anchor.top, left: anchor.left, ...shifted }}
      onKeyDown={onKeyDown}
      onMouseEnter={onPanelEnter}
      onMouseLeave={onPanelLeave}
    >
      {/* registration-tick corners: card ::before/::after = top pair,
          .mm-corners overlay = bottom pair (the blocks survey-mark grammar) */}
      <span className="mm-corners" aria-hidden="true" />

      <div className="mm-head" id={labelId}>
        <InkDivider />
        <span className="mm-eyebrow">{category.label}</span>
        <InkDivider />
      </div>

      <div className={`mm-cols${multi ? " mm-cols-multi" : ""}`}>
        {category.columns.map((col, ci) => (
          <div className="mm-col" key={col.label ?? ci}>
            {col.label && <span className="mm-col-label">{col.label}</span>}
            <div className="mm-grid">
              {col.links.map((l) => {
                const Icon = l.icon;
                const active = isActive(path, l.href);
                const idx = (flat += 1);
                return (
                  <Link
                    key={l.href}
                    href={l.href}
                    role="menuitem"
                    ref={(el) => { itemRefs.current[idx] = el; }}
                    className={`mm-item${active ? " active" : ""}`}
                    onClick={() => { onNavigate?.(); onClose(); }}
                    data-guide={`nav:${l.href}`}
                  >
                    <span className="mm-item-ico" aria-hidden="true"><Icon size={16} strokeWidth={1.8} /></span>
                    <span className="mm-item-text">
                      <span className="mm-item-label">{l.label}</span>
                      {l.desc && <span className="mm-item-desc">{l.desc}</span>}
                    </span>
                    <span className="mm-item-spark" aria-hidden="true"><InkIcon name="glyph" size={11} /></span>
                  </Link>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
