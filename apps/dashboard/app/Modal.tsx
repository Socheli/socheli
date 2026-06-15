"use client";
import { useEffect, type ReactNode } from "react";
import { createPortal } from "react-dom";

/* Custom dialog shell — portal + backdrop, themed to the platform. Replaces
   Clerk's modals so every dialog is consistent. */
export function Modal({ open, onClose, title, subtitle, children, width = 460, className }: { open: boolean; onClose: () => void; title?: string; subtitle?: string; children: ReactNode; width?: number; className?: string }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => { document.removeEventListener("keydown", onKey); document.body.style.overflow = ""; };
  }, [open, onClose]);

  if (!open || typeof document === "undefined") return null;
  return createPortal(
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className={`modal-card${className ? ` ${className}` : ""}`} style={{ width }} onMouseDown={(e) => e.stopPropagation()}>
        {(title || subtitle) && (
          <div className="modal-head">
            <div>
              {title && <div className="modal-title">{title}</div>}
              {subtitle && <div className="sub" style={{ marginTop: 4 }}>{subtitle}</div>}
            </div>
            <button className="modal-x" onClick={onClose} aria-label="Close">✕</button>
          </div>
        )}
        <div className="modal-body">{children}</div>
      </div>
    </div>,
    document.body,
  );
}

/* A labelled form field. */
export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label style={{ display: "block", marginBottom: 14 }}>
      <span style={{ display: "block", fontSize: 11.5, fontWeight: 600, letterSpacing: "0.02em", color: "var(--text-secondary)", marginBottom: 6 }}>{label}</span>
      {children}
      {hint && <span className="sub" style={{ fontSize: 11.5, display: "block", marginTop: 5 }}>{hint}</span>}
    </label>
  );
}

/* Inline error/notice line. */
export function Notice({ kind = "error", children }: { kind?: "error" | "ok"; children: ReactNode }) {
  if (!children) return null;
  return <div style={{ fontSize: 12.5, margin: "2px 0 12px", color: kind === "ok" ? "var(--success)" : "var(--error)" }}>{children}</div>;
}
