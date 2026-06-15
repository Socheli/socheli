"use client";
import { useEffect, useId, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";

/* Custom dark-themed time picker — twin HH / MM wheels in a portal, matching the
   Select component's styling. Replaces the native <input type="time"> (whose
   dropdown ignores our theme). Value + onChange are "HH:MM" strings. */

const pad = (n: number) => String(n).padStart(2, "0");

export function TimePicker({
  value,
  onChange,
  minuteStep = 5,
  width = 104,
  ariaLabel = "Time",
}: {
  value: string;
  onChange: (v: string) => void;
  minuteStep?: number;
  width?: number | string;
  ariaLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const hourRef = useRef<HTMLButtonElement>(null);
  const minRef = useRef<HTMLButtonElement>(null);
  const id = useId();

  const m = /^(\d{1,2}):(\d{1,2})$/.exec(value || "");
  const hh = m ? Math.min(23, Number(m[1])) : 9;
  const mm = m ? Math.min(59, Number(m[2])) : 0;

  const hours = Array.from({ length: 24 }, (_, i) => i);
  const minutes = Array.from({ length: Math.ceil(60 / minuteStep) }, (_, i) => i * minuteStep);
  if (!minutes.includes(mm)) minutes.push(mm); // keep an off-step existing value visible
  minutes.sort((a, b) => a - b);

  const place = () => triggerRef.current && setRect(triggerRef.current.getBoundingClientRect());
  const toggle = () => { if (!open) place(); setOpen((o) => !o); };

  useEffect(() => {
    if (!open) return;
    // center the selected cells once the menu has mounted
    const t = setTimeout(() => {
      hourRef.current?.scrollIntoView({ block: "center" });
      minRef.current?.scrollIntoView({ block: "center" });
    }, 0);
    const onDoc = (e: MouseEvent) => {
      if (triggerRef.current?.contains(e.target as Node) || menuRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    const onScrollResize = () => place();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDoc);
    window.addEventListener("resize", onScrollResize);
    document.addEventListener("keydown", onKey);
    return () => {
      clearTimeout(t);
      document.removeEventListener("mousedown", onDoc);
      window.removeEventListener("resize", onScrollResize);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const setH = (h: number) => onChange(`${pad(h)}:${pad(mm)}`);
  const setM = (mi: number) => onChange(`${pad(hh)}:${pad(mi)}`);

  const menuStyle: CSSProperties = rect
    ? { position: "fixed", top: rect.bottom + 6, left: rect.left, zIndex: 1300 }
    : { display: "none" };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={ariaLabel}
        onClick={toggle}
        className="select-trigger"
        style={{ width }}
      >
        <span style={{ fontFamily: "var(--font-mono)", letterSpacing: "0.02em" }}>{pad(hh)}:{pad(mm)}</span>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" style={{ flexShrink: 0, opacity: 0.6 }}>
          <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" />
          <path d="M12 7v5l3 2" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && typeof document !== "undefined" && createPortal(
        <div ref={menuRef} id={id} role="dialog" className="tp-menu" style={menuStyle}>
          <div className="tp-col" role="listbox" aria-label="Hour">
            <div className="tp-col-head">hr</div>
            {hours.map((h) => (
              <button
                key={h}
                ref={h === hh ? hourRef : undefined}
                type="button"
                role="option"
                aria-selected={h === hh}
                onClick={() => setH(h)}
                className={`tp-cell${h === hh ? " sel" : ""}`}
              >
                {pad(h)}
              </button>
            ))}
          </div>
          <div className="tp-col" role="listbox" aria-label="Minute">
            <div className="tp-col-head">min</div>
            {minutes.map((mi) => (
              <button
                key={mi}
                ref={mi === mm ? minRef : undefined}
                type="button"
                role="option"
                aria-selected={mi === mm}
                onClick={() => setM(mi)}
                className={`tp-cell${mi === mm ? " sel" : ""}`}
              >
                {pad(mi)}
              </button>
            ))}
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
