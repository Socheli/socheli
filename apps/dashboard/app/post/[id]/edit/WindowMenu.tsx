"use client";

import { useEffect, useRef, useState } from "react";
import { PanelsTopLeft, Check } from "lucide-react";

// Add-panel dropdown: a checklist of panels with show/hide toggles. Pure — the
// parent owns panel visibility and supplies the list; toggling delegates out.
export function WindowMenu({
  panels,
  onToggle,
}: {
  panels: { id: string; title: string; visible: boolean }[];
  onToggle: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onEsc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onEsc);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onEsc);
    };
  }, [open]);

  return (
    <div className="window-menu-wrap" ref={ref} style={{ position: "relative" }}>
      <button className={`btn${open ? " btn-active" : ""}`} onClick={() => setOpen((v) => !v)} title="Panels">
        <PanelsTopLeft size={14} strokeWidth={2} />
        Window
      </button>
      {open && (
        <div className="ctx-menu window-dropdown" style={{ position: "absolute", top: "calc(100% + 6px)", right: 0, minWidth: 200, zIndex: 50 }} onClick={(e) => e.stopPropagation()}>
          <div className="ctx-title">Panels</div>
          {panels.map((p) => (
            <button key={p.id} onClick={() => onToggle(p.id)} style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <Check size={13} strokeWidth={2} style={{ opacity: p.visible ? 1 : 0 }} />
              {p.title}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
