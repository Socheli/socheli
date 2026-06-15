"use client";

import type { ReactNode } from "react";
import { Ico } from "./ui";

// Panel chrome: a titled header with an optional dismiss button and a scrollable
// body. Pure / props-driven — the parent decides visibility and supplies content.
export function DockPanel({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose?: () => void;
  children: ReactNode;
}) {
  return (
    <div className="dock-panel" style={{ display: "flex", flexDirection: "column", minHeight: 0, minWidth: 0, flex: 1 }}>
      <div
        className="dock-head"
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
          padding: "6px 10px",
          borderBottom: "1px solid var(--border-subtle)",
          flex: "0 0 auto",
        }}
      >
        <span className="dock-title" style={{ fontSize: 11, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--text-muted)" }}>{title}</span>
        {onClose && (
          <button className="lnk-btn" onClick={onClose} title={`Close ${title}`} aria-label={`Close ${title}`}>
            <Ico c="CL" size={13} />
          </button>
        )}
      </div>
      <div className="dock-body" style={{ flex: 1, minHeight: 0, minWidth: 0, overflow: "auto" }}>
        {children}
      </div>
    </div>
  );
}
