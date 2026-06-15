"use client";

import { useRef } from "react";

// Pure draggable divider. Emits delta pixels as the user drags; the parent owns
// the actual size state and applies the delta (clamped via clampLayout bounds).
//  - orientation "vertical"   → a vertical bar; horizontal drag resizes width.
//  - orientation "horizontal" → a horizontal bar; vertical drag resizes height.
// No global state, no document listeners: uses pointer capture on the element.
export function Splitter({
  orientation,
  onResize,
  onResizeEnd,
}: {
  orientation: "vertical" | "horizontal";
  onResize: (deltaPx: number) => void;
  onResizeEnd?: () => void;
}) {
  const last = useRef<number | null>(null);
  const vertical = orientation === "vertical";

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    last.current = vertical ? e.clientX : e.clientY;
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (last.current == null) return;
    const pos = vertical ? e.clientX : e.clientY;
    const delta = pos - last.current;
    if (delta !== 0) {
      last.current = pos;
      onResize(delta);
    }
  };

  const end = (e: React.PointerEvent<HTMLDivElement>) => {
    if (last.current == null) return;
    last.current = null;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* pointer already released */
    }
    onResizeEnd?.();
  };

  return (
    <div
      className={`ws-splitter ws-splitter-${orientation}`}
      role="separator"
      aria-orientation={vertical ? "vertical" : "horizontal"}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={end}
      onPointerCancel={end}
      style={{
        flex: "0 0 auto",
        alignSelf: "stretch",
        cursor: vertical ? "col-resize" : "row-resize",
        touchAction: "none",
        userSelect: "none",
        background: "var(--border-subtle)",
        ...(vertical ? { width: 5 } : { height: 5 }),
      }}
    />
  );
}
