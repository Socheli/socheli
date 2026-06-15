import type { Scene } from "./lib";
import { COLOR_PRESETS, TRANSITIONS, TRANSITION_EASES, FX, TR, FPS, hslColor } from "./lib";
import { Slider, LockedFieldset } from "./ui";

export function InspectorStyle({
  s, sel, scenes, accent, hue, saturation, lightness,
  patchStyle, patchEffect, setScenes,
}: {
  s: Scene;
  sel: number;
  scenes: Scene[];
  accent: string;
  hue: number;
  saturation: number;
  lightness: number;
  patchStyle: (i: number, p: any) => void;
  patchEffect: (i: number, key: string, value: any) => void;
  setScenes: (ss: Scene[]) => void;
}) {
  return (
    <div className="ed-pane">
      <LockedFieldset locked={!!s.locked}>
      <div className="fld">
        <label>Color settings</label>
        <div className="color-head">
          <label className="color-picker" title="Pick any color">
            <input type="color" value={accent || "#ffffff"} onChange={(e) => patchStyle(sel, { accent: e.target.value })} />
            <span style={{ background: accent || "transparent" }} />
          </label>
          <input className="input color-hex" value={accent || "theme"} onChange={(e) => patchStyle(sel, { accent: e.target.value === "theme" ? undefined : e.target.value })} />
        </div>
        <div className="preset-grid">
          {COLOR_PRESETS.map((p) => (
            <button key={p.name} className={`preset${accent === p.color ? " on" : ""}`} onClick={() => patchStyle(sel, { accent: p.color || undefined })} title={p.name}>
              <span style={{ background: p.color || "linear-gradient(135deg, #ffffff 0%, #737373 100%)" }} />
              <em>{p.name}</em>
            </button>
          ))}
        </div>
      </div>
      <Slider label="Hue" value={hue} min={0} max={360} step={1} onChange={(v: number) => patchStyle(sel, { hue: v, accent: hslColor(v, saturation, lightness) })} fmt={(v: number) => Math.round(v) + "deg"} />
      <Slider label="Saturation" value={saturation} min={0} max={100} step={1} onChange={(v: number) => patchStyle(sel, { saturation: v, accent: hslColor(hue, v, lightness) })} fmt={(v: number) => Math.round(v) + "%"} />
      <Slider label="Lightness" value={lightness} min={0} max={100} step={1} onChange={(v: number) => patchStyle(sel, { lightness: v, accent: hslColor(hue, saturation, v) })} fmt={(v: number) => Math.round(v) + "%"} />
      <Slider label="Brightness" value={s.style?.brightness ?? 1} min={0.4} max={1.8} step={0.05} onChange={(v: number) => patchStyle(sel, { brightness: v === 1 ? undefined : v })} fmt={(v: number) => Math.round(v * 100) + "%"} />
      <Slider label="Contrast" value={s.style?.contrast ?? 1} min={0.4} max={2} step={0.05} onChange={(v: number) => patchStyle(sel, { contrast: v === 1 ? undefined : v })} fmt={(v: number) => Math.round(v * 100) + "%"} />
      <Slider label="Opacity" value={s.style?.opacity ?? 1} min={0.2} max={1} step={0.05} onChange={(v: number) => patchStyle(sel, { opacity: v === 1 ? undefined : v })} fmt={(v: number) => Math.round(v * 100) + "%"} />
      <div className="fld">
        <label>Entry transition</label>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {TRANSITIONS.map((tr) => (
            <button key={tr} className={`tg${s.style?.transition === tr ? " tg-on" : ""}`} onClick={() => patchStyle(sel, { transition: s.style?.transition === tr ? undefined : tr })}>{tr}</button>
          ))}
        </div>
      </div>
      <Slider label="Transition dur" value={s.style?.transitionDuration ?? (TR / FPS)} min={0.1} max={1.5} step={0.05} onChange={(v: number) => patchStyle(sel, { transitionDuration: v })} fmt={(v: number) => v.toFixed(2) + "s"} />
      <div className="fld">
        <label>Transition ease</label>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {TRANSITION_EASES.map((ez) => (
            <button key={ez} className={`tg${(s.style?.transitionEase ?? "easeInOut") === ez ? " tg-on" : ""}`} onClick={() => patchStyle(sel, { transitionEase: ez === "easeInOut" ? undefined : ez })}>{ez}</button>
          ))}
        </div>
      </div>
      <div className="fld">
        <label>Effects</label>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {FX.map((fx) => (
            <button key={fx} className={`tg${s.effects?.[fx] ? " tg-on" : ""}`} onClick={() => patchEffect(sel, fx, !s.effects?.[fx])}>{fx}</button>
          ))}
        </div>
        <Slider label="Effect intensity" value={s.style?.effectIntensity ?? 1} min={0} max={1} step={0.05} onChange={(v: number) => patchStyle(sel, { effectIntensity: v === 1 ? undefined : v })} fmt={(v: number) => `${Math.round(v * 100)}%`} />
      </div>
      <Slider label="Text size" value={s.style?.fontScale ?? 1} min={0.7} max={1.5} step={0.05} onChange={(v: number) => patchStyle(sel, { fontScale: v === 1 ? undefined : v })} fmt={(v: number) => Math.round(v * 100) + "%"} />
      <Slider label="Letter spacing" value={s.style?.letterSpacing ?? 0} min={-0.08} max={0.2} step={0.005} onChange={(v: number) => patchStyle(sel, { letterSpacing: v === 0 ? undefined : v })} fmt={(v: number) => `${v.toFixed(3)}em`} />
      <Slider label="Line height" value={s.style?.lineHeight ?? 1.12} min={0.8} max={1.8} step={0.02} onChange={(v: number) => patchStyle(sel, { lineHeight: v === 1.12 ? undefined : v })} fmt={(v: number) => v.toFixed(2)} />
      <Slider label="Paragraph gap" value={s.style?.paragraphSpacing ?? 0} min={0} max={80} step={1} onChange={(v: number) => patchStyle(sel, { paragraphSpacing: v || undefined })} fmt={(v: number) => `${Math.round(v)}px`} />
      <Slider label="Text X" value={s.style?.x ?? 0} min={-420} max={420} step={5} onChange={(v: number) => patchStyle(sel, { x: v || undefined })} fmt={(v: number) => `${Math.round(v)}px`} />
      <Slider label="Text Y" value={s.style?.y ?? 0} min={-720} max={720} step={5} onChange={(v: number) => patchStyle(sel, { y: v || undefined })} fmt={(v: number) => `${Math.round(v)}px`} />
      <Slider label="Rotation" value={s.style?.rotation ?? 0} min={-45} max={45} step={1} onChange={(v: number) => patchStyle(sel, { rotation: v || undefined })} fmt={(v: number) => `${Math.round(v)}deg`} />
      <div className="fld">
        <label>Paragraph settings</label>
        <div className="tool-row">
          {(["none", "upper", "lower", "title"] as const).map((c) => <button key={c} className={`tg${(s.style?.textCase ?? "none") === c ? " tg-on" : ""}`} onClick={() => patchStyle(sel, { textCase: c === "none" ? undefined : c })}>{c}</button>)}
          {(["center", "left"] as const).map((a) => <button key={a} className={`tg${(s.style?.align ?? "center") === a ? " tg-on" : ""}`} onClick={() => patchStyle(sel, { align: a === "center" ? undefined : a })}>{a}</button>)}
        </div>
      </div>
      {/* Text outline (stroke) — color + width. width 0 = no stroke (unset). */}
      <div className="fld">
        <label>Text stroke</label>
        <div className="color-head">
          <label className="color-picker" title="Stroke color">
            <input
              type="color"
              value={s.style?.stroke?.color || "#000000"}
              onChange={(e) => patchStyle(sel, { stroke: { color: e.target.value, width: s.style?.stroke?.width ?? 4 } })}
            />
            <span style={{ background: s.style?.stroke?.color || "#000000" }} />
          </label>
          <input
            className="input color-hex"
            value={s.style?.stroke?.color || "#000000"}
            onChange={(e) => patchStyle(sel, { stroke: { color: e.target.value, width: s.style?.stroke?.width ?? 4 } })}
          />
        </div>
      </div>
      <Slider
        label="Stroke width"
        value={s.style?.stroke?.width ?? 0}
        min={0} max={20} step={0.5}
        onChange={(v: number) => patchStyle(sel, { stroke: v === 0 ? undefined : { color: s.style?.stroke?.color || "#000000", width: v } })}
        fmt={(v: number) => `${v}px`}
      />
      {/* Text drop shadow — color + blur + offset. blur=0 & x=0 & y=0 keeps it
          on; clear via the Clear button below. */}
      <div className="fld">
        <label>Text shadow</label>
        <div className="color-head">
          <label className="color-picker" title="Shadow color">
            <input
              type="color"
              value={s.style?.shadow?.color || "#000000"}
              onChange={(e) => patchStyle(sel, { shadow: { color: e.target.value, blur: s.style?.shadow?.blur ?? 12, x: s.style?.shadow?.x ?? 0, y: s.style?.shadow?.y ?? 4 } })}
            />
            <span style={{ background: s.style?.shadow?.color || "#000000" }} />
          </label>
          <input
            className="input color-hex"
            value={s.style?.shadow?.color || "#000000"}
            onChange={(e) => patchStyle(sel, { shadow: { color: e.target.value, blur: s.style?.shadow?.blur ?? 12, x: s.style?.shadow?.x ?? 0, y: s.style?.shadow?.y ?? 4 } })}
          />
        </div>
      </div>
      <Slider label="Shadow blur" value={s.style?.shadow?.blur ?? 0} min={0} max={60} step={1} onChange={(v: number) => patchStyle(sel, { shadow: { color: s.style?.shadow?.color || "#000000", blur: v, x: s.style?.shadow?.x ?? 0, y: s.style?.shadow?.y ?? 0 } })} fmt={(v: number) => `${Math.round(v)}px`} />
      <Slider label="Shadow X" value={s.style?.shadow?.x ?? 0} min={-40} max={40} step={1} onChange={(v: number) => patchStyle(sel, { shadow: { color: s.style?.shadow?.color || "#000000", blur: s.style?.shadow?.blur ?? 0, x: v, y: s.style?.shadow?.y ?? 0 } })} fmt={(v: number) => `${Math.round(v)}px`} />
      <Slider label="Shadow Y" value={s.style?.shadow?.y ?? 0} min={-40} max={40} step={1} onChange={(v: number) => patchStyle(sel, { shadow: { color: s.style?.shadow?.color || "#000000", blur: s.style?.shadow?.blur ?? 0, x: s.style?.shadow?.x ?? 0, y: v } })} fmt={(v: number) => `${Math.round(v)}px`} />
      <div className="fld">
        <label>Clear text effects</label>
        <div className="tool-row">
          <button className="btn" onClick={() => patchStyle(sel, { stroke: undefined })}>Clear stroke</button>
          <button className="btn" onClick={() => patchStyle(sel, { shadow: undefined })}>Clear shadow</button>
        </div>
      </div>
      <div className="fld">
        <label>Apply to</label>
        <div className="tool-row">
          <button className="btn" onClick={() => setScenes(scenes.map((x) => x.locked ? x : ({ ...x, style: { ...(x.style ?? {}), ...(s.style ?? {}) } })))}>All scenes</button>
          <button className="btn" onClick={() => setScenes(scenes.map((x) => x.locked ? x : ({ ...x, effects: { ...(x.effects ?? {}), ...(s.effects ?? {}) } })))}>All effects</button>
        </div>
      </div>
      </LockedFieldset>
    </div>
  );
}
