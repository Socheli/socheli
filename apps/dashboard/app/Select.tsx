"use client";
import { useEffect, useId, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";

/* Custom dark-themed dropdown. The menu is rendered in a portal to <body> and
   positioned from the trigger's rect, so it NEVER clips against a scroll
   container or card overflow (the bug with native <select> / Clerk popovers). */

export type Option = { value: string; label: string; hint?: string };

export function Select({
  value,
  onChange,
  options,
  placeholder = "Select…",
  width,
  ariaLabel,
  disabled = false,
}: {
  value: string;
  onChange: (v: string) => void;
  options: Option[];
  placeholder?: string;
  width?: number | string;
  ariaLabel?: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const [active, setActive] = useState(0);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const id = useId();
  const current = options.find((o) => o.value === value);

  const place = () => triggerRef.current && setRect(triggerRef.current.getBoundingClientRect());
  const toggle = () => { if (disabled) return; if (!open) { place(); setActive(Math.max(0, options.findIndex((o) => o.value === value))); } setOpen((o) => !o); };

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (triggerRef.current?.contains(e.target as Node) || menuRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    const onScrollResize = () => place();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
      else if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => Math.min(options.length - 1, a + 1)); }
      else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(0, a - 1)); }
      else if (e.key === "Enter") { e.preventDefault(); const o = options[active]; if (o) { onChange(o.value); setOpen(false); } }
    };
    document.addEventListener("mousedown", onDoc);
    window.addEventListener("scroll", onScrollResize, true);
    window.addEventListener("resize", onScrollResize);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      window.removeEventListener("scroll", onScrollResize, true);
      window.removeEventListener("resize", onScrollResize);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, options, active, value, onChange]);

  const menuStyle: CSSProperties = rect
    ? { position: "fixed", top: rect.bottom + 6, left: rect.left, width: rect.width, zIndex: 2000 }
    : { display: "none" };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        onClick={toggle}
        disabled={disabled}
        className="select-trigger"
        style={{ width, ...(disabled ? { opacity: 0.5, cursor: "not-allowed" } : null) }}
      >
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{current?.label ?? <span style={{ color: "var(--text-muted)" }}>{placeholder}</span>}</span>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" style={{ flexShrink: 0, opacity: 0.6, transform: open ? "rotate(180deg)" : "none", transition: "transform 120ms" }}><path d="M6 9l6 6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
      </button>
      {open && typeof document !== "undefined" && createPortal(
        <div ref={menuRef} role="listbox" id={id} className="select-menu" style={menuStyle}>
          {options.map((o, i) => (
            <button
              key={o.value}
              type="button"
              role="option"
              aria-selected={o.value === value}
              onMouseEnter={() => setActive(i)}
              onClick={() => { onChange(o.value); setOpen(false); }}
              className={`select-opt${i === active ? " active" : ""}${o.value === value ? " selected" : ""}`}
            >
              <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>{o.label}{o.hint && <span style={{ color: "var(--text-muted)", marginLeft: 6 }}>{o.hint}</span>}</span>
              {o.value === value && <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M20 6L9 17l-5-5" stroke="var(--accent)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" /></svg>}
            </button>
          ))}
        </div>,
        document.body,
      )}
    </>
  );
}
