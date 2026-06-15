import {
  ArrowLeft, Keyboard, Undo2, Redo2, Save, Clapperboard, Scissors, FastForward, Rewind,
  Type as TypeIcon, Pencil, Wand2, Maximize2, Move, Plus, Copy, Trash2,
  MousePointer2, X, Maximize, ToggleLeft, ToggleRight, Lock,
} from "lucide-react";

// Map the legacy 2-letter glyph codes to proper Lucide icons.
export const ICONS: Record<string, any> = {
  BK: ArrowLeft, KY: Keyboard, UN: Undo2, RE: Redo2, SV: Save, RD: Clapperboard,
  RZ: Scissors, SP: FastForward, SL: Rewind, TX: TypeIcon, ED: Pencil, AN: Wand2,
  SZ: Maximize2, MV: Move, AD: Plus, CP: Copy, DL: Trash2, SE: MousePointer2, CL: X, FS: Maximize,
};
export const Ico = ({ c, size = 14 }: { c: string; size?: number }) => {
  const C = ICONS[c];
  return C ? <C size={size} strokeWidth={2} /> : <span className="ico">{c}</span>;
};

export const Slider = ({ label, value, min, max, step, onChange, fmt }: any) => (
  <div className="mix-row">
    <span className="mix-label">{label}</span>
    <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(parseFloat(e.target.value))} className="slider" />
    <span className="mix-val">{fmt ? fmt(value) : value}</span>
  </div>
);
export const Toggle = ({ on, onClick, label }: any) => (
  <button onClick={onClick} className={`tg${on ? " tg-on" : ""}`}>{on ? <ToggleRight size={16} strokeWidth={2} /> : <ToggleLeft size={16} strokeWidth={2} />}{label}</button>
);
export const Key = ({ children }: { children: string }) => <kbd className="key">{children}</kbd>;

/* Wraps an inspector pane's controls so a locked scene reads as read-only:
   a banner up top + a native <fieldset disabled> that greys out and blocks
   every nested input/button (matching the handler-level lock guard). */
export const LockedFieldset = ({ locked, children }: { locked: boolean; children: React.ReactNode }) => (
  <>
    {locked && (
      <div className="locked-banner" style={{ display: "flex", alignItems: "center", gap: 7, padding: "7px 10px", marginBottom: 10, borderRadius: 8, border: "1px solid var(--border-subtle)", background: "var(--bg-surface)", color: "var(--text-muted)", fontSize: 12 }}>
        <Lock size={13} strokeWidth={2} />
        <span>Scene locked — unlock it in the Layers panel to edit.</span>
      </div>
    )}
    <fieldset disabled={locked} style={{ border: "none", margin: 0, padding: 0, opacity: locked ? 0.5 : 1, minWidth: 0 }}>
      {children}
    </fieldset>
  </>
);
