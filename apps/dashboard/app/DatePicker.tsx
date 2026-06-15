"use client";
import { useEffect, useId, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";

/* Custom dark-themed date picker — a month calendar in a portal, matching the
   TimePicker / Select styling. Replaces the native <input type="date"> (whose
   calendar ignores our theme). Value + onChange are "YYYY-MM-DD" strings. */

const pad = (n: number) => String(n).padStart(2, "0");
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DOW = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];

const fmt = (y: number, m: number, d: number) => `${y}-${pad(m + 1)}-${pad(d)}`;
function parse(v: string): { y: number; m: number; d: number } {
  const x = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(v || "");
  const now = new Date();
  if (!x) return { y: now.getFullYear(), m: now.getMonth(), d: now.getDate() };
  return { y: Number(x[1]), m: Math.min(11, Math.max(0, Number(x[2]) - 1)), d: Number(x[3]) };
}

export function DatePicker({
  value,
  onChange,
  width = 150,
  ariaLabel = "Date",
}: {
  value: string;
  onChange: (v: string) => void;
  width?: number | string;
  ariaLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const id = useId();

  const sel = parse(value);
  const [view, setView] = useState({ y: sel.y, m: sel.m });
  // keep the visible month in sync when the value changes (e.g. dialog reloads)
  useEffect(() => { setView({ y: sel.y, m: sel.m }); }, [value]); // eslint-disable-line react-hooks/exhaustive-deps

  const today = new Date();
  // place below the trigger, but flip ABOVE when there isn't room (e.g. the Move
  // row low in the day dialog); clamp horizontally to the viewport.
  const place = () => {
    const t = triggerRef.current;
    if (!t) return;
    const r = t.getBoundingClientRect();
    const h = menuRef.current?.offsetHeight || 318;
    const w = menuRef.current?.offsetWidth || 250;
    const below = window.innerHeight - r.bottom;
    const top = below >= h + 12 ? r.bottom + 6 : Math.max(8, r.top - h - 6);
    const left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8));
    setPos({ top, left });
  };
  const toggle = () => { if (!open) { place(); setView({ y: sel.y, m: sel.m }); } setOpen((o) => !o); };

  useEffect(() => {
    if (!open) return;
    place(); // re-measure now that the menu is mounted (so flip uses real height)
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
      document.removeEventListener("mousedown", onDoc);
      window.removeEventListener("resize", onScrollResize);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const step = (delta: number) => {
    let m = view.m + delta, y = view.y;
    if (m < 0) { m = 11; y--; } else if (m > 11) { m = 0; y++; }
    setView({ y, m });
  };
  const pick = (d: number, monthDelta = 0) => {
    let m = view.m + monthDelta, y = view.y;
    if (m < 0) { m = 11; y--; } else if (m > 11) { m = 0; y++; }
    onChange(fmt(y, m, d));
    setOpen(false);
  };

  // build a 6×7 grid of day cells (leading/trailing days belong to adjacent months)
  const firstDow = new Date(view.y, view.m, 1).getDay();
  const daysThis = new Date(view.y, view.m + 1, 0).getDate();
  const daysPrev = new Date(view.y, view.m, 0).getDate();
  const cells: { d: number; delta: number }[] = [];
  for (let i = 0; i < 42; i++) {
    const dayNum = i - firstDow + 1;
    if (dayNum < 1) cells.push({ d: daysPrev + dayNum, delta: -1 });
    else if (dayNum > daysThis) cells.push({ d: dayNum - daysThis, delta: 1 });
    else cells.push({ d: dayNum, delta: 0 });
  }

  const label = `${MON[sel.m]} ${sel.d}, ${sel.y}`;
  const menuStyle: CSSProperties = pos ? { position: "fixed", top: pos.top, left: pos.left, zIndex: 1300 } : { position: "fixed", visibility: "hidden" };

  return (
    <>
      <button ref={triggerRef} type="button" aria-haspopup="dialog" aria-expanded={open} aria-label={ariaLabel} onClick={toggle} className="select-trigger" style={{ width }}>
        <span style={{ fontFamily: "var(--font-mono)", letterSpacing: "0.02em" }}>{label}</span>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" style={{ flexShrink: 0, opacity: 0.6 }}>
          <rect x="3" y="5" width="18" height="16" rx="2" stroke="currentColor" strokeWidth="2" />
          <path d="M3 9h18M8 3v4M16 3v4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
      </button>
      {open && typeof document !== "undefined" && createPortal(
        <div ref={menuRef} id={id} role="dialog" aria-label={ariaLabel} className="dp-menu" style={menuStyle}>
          <div className="dp-head">
            <button type="button" className="dp-nav" aria-label="Previous month" onClick={() => step(-1)}>‹</button>
            <div className="dp-title">{MONTHS[view.m]} {view.y}</div>
            <button type="button" className="dp-nav" aria-label="Next month" onClick={() => step(1)}>›</button>
          </div>
          <div className="dp-grid">
            {DOW.map((d) => <div key={d} className="dp-dow">{d}</div>)}
            {cells.map((c, i) => {
              const isSel = c.delta === 0 && c.d === sel.d && view.m === sel.m && view.y === sel.y;
              const isToday = c.delta === 0 && c.d === today.getDate() && view.m === today.getMonth() && view.y === today.getFullYear();
              return (
                <button
                  key={i}
                  type="button"
                  role="option"
                  aria-selected={isSel}
                  className={`dp-day${c.delta !== 0 ? " muted" : ""}${isSel ? " sel" : ""}${isToday ? " today" : ""}`}
                  onClick={() => pick(c.d, c.delta)}
                >
                  {c.d}
                </button>
              );
            })}
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
