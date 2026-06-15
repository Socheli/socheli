import type { RefObject } from "react";
import { Palette } from "lucide-react";
import type { Scene } from "./lib";
import { Ico } from "./ui";

export function TextPopover({
  textPopover, sel, s, textRef, setTab, patch, patchStyle,
}: {
  textPopover: { x: number; y: number };
  sel: number;
  s: Scene;
  textRef: RefObject<HTMLTextAreaElement | null>;
  setTab: (t: "scene" | "style" | "subtitles" | "mix" | "transcript") => void;
  patch: (i: number, p: Partial<Scene>) => void;
  patchStyle: (i: number, p: any) => void;
}) {
  return (
    <div className="text-pop" style={{ left: textPopover.x, top: textPopover.y }} onClick={(e) => e.stopPropagation()}>
      <div className="text-pop-head"><Ico c="TX" /><span>Text tools</span></div>
      <div className="text-pop-sub">Scene {sel + 1} / {s.type?.replace("_", " ")}</div>
      <div className="text-pop-actions">
        <button onClick={() => { setTab("scene"); requestAnimationFrame(() => textRef.current?.focus()); }}><Ico c="ED" />Edit</button>
        <button onClick={() => { setTab("scene"); patch(sel, { textAnim: { ...(s.textAnim ?? {}), preset: s.textAnim?.preset ?? "fade" } }); }}><Ico c="AN" />Animate</button>
        <button onClick={() => setTab("style")}><Palette size={14} strokeWidth={2} />Style</button>
        <button onClick={() => patchStyle(sel, { fontScale: Number(((s.style?.fontScale ?? 1) + 0.05).toFixed(2)) })}><Ico c="SZ" />Size</button>
      </div>
      <div className="text-pop-grid">
        <label>X<input type="number" value={s.style?.x ?? 0} onChange={(e) => patchStyle(sel, { x: Number(e.target.value) })} /></label>
        <label>Y<input type="number" value={s.style?.y ?? 0} onChange={(e) => patchStyle(sel, { y: Number(e.target.value) })} /></label>
        <label>Rot<input type="number" value={s.style?.rotation ?? 0} onChange={(e) => patchStyle(sel, { rotation: Number(e.target.value) })} /></label>
        <label>Case<select value={s.style?.textCase ?? "none"} onChange={(e) => patchStyle(sel, { textCase: e.target.value === "none" ? undefined : e.target.value })}><option value="none">none</option><option value="upper">upper</option><option value="lower">lower</option><option value="title">title</option></select></label>
      </div>
    </div>
  );
}
