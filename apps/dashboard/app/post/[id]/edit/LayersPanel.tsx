import { Layers, X, Eye, EyeOff, Lock, Unlock } from "lucide-react";
import type { Scene } from "./lib";
import { TYPE_COLOR, primaryText } from "./lib";

export function LayersPanel({
  scenes, sel, setLayersOpen, setSel, seekToSceneStart, toggleHidden, toggleLock, embedded = false,
}: {
  scenes: Scene[];
  sel: number;
  setLayersOpen: (v: boolean) => void;
  setSel: (i: number) => void;
  seekToSceneStart: (i: number) => void;
  toggleHidden: (i: number) => void;
  toggleLock: (i: number) => void;
  // When docked inside a DockPanel the floating chrome (fixed position + header)
  // is dropped — the dock provides its own header/close. Behavior is otherwise
  // identical, preserving the original floating panel when embedded is false.
  embedded?: boolean;
}) {
  return (
    <div className={embedded ? "layers-panel layers-embedded" : "layers-panel"} onClick={(e) => e.stopPropagation()}>
      {!embedded && (
        <div className="layers-head">
          <span><Layers size={13} strokeWidth={2} /> Layers</span>
          <button className="lnk-btn" onClick={() => setLayersOpen(false)} title="Close"><X size={13} strokeWidth={2} /></button>
        </div>
      )}
      <div className="layers-list">
        {scenes.map((sc, i) => {
          const snippet = (primaryText(sc) || "").replace(/\n/g, " ").trim().slice(0, 38);
          return (
            <div
              key={sc.id ?? i}
              className={`layer-row${i === sel ? " on" : ""}${sc.hidden ? " hidden" : ""}${sc.locked ? " locked" : ""}`}
              onClick={() => { setSel(i); seekToSceneStart(i); }}
            >
              <span className="layer-n">{i + 1}</span>
              <span className="tl-dot" style={{ background: TYPE_COLOR[sc.type] }} />
              <span className="layer-body">
                <span className="layer-type">{sc.type.replace("_", " ")}</span>
                <span className="layer-snippet">{snippet || "—"}</span>
              </span>
              <button
                className={`layer-tg${sc.hidden ? " active" : ""}`}
                title={sc.hidden ? "Show scene" : "Hide scene"}
                onClick={(e) => { e.stopPropagation(); toggleHidden(i); }}
              >{sc.hidden ? <EyeOff size={13} strokeWidth={2} /> : <Eye size={13} strokeWidth={2} />}</button>
              <button
                className={`layer-tg${sc.locked ? " active" : ""}`}
                title={sc.locked ? "Unlock scene" : "Lock scene"}
                onClick={(e) => { e.stopPropagation(); toggleLock(i); }}
              >{sc.locked ? <Lock size={13} strokeWidth={2} /> : <Unlock size={13} strokeWidth={2} />}</button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
