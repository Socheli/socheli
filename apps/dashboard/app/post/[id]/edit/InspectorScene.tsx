import type { RefObject } from "react";
import { ZoomIn, ZoomOut, Diamond } from "lucide-react";
import { getTracks, keyframeCount, hasTrack, KF_PROPS, type KfProp } from "../../../../lib/keyframes";
import type { Scene } from "./lib";
import { TYPE_COLOR, primaryText, setPrimaryText } from "./lib";
import { Slider, Toggle, Ico, Key, LockedFieldset } from "./ui";

export function InspectorScene({
  s, sel, scenes, textRef,
  patch, setSceneSpeed, splitAt, setScenes,
  sceneKfTime, clearMotion, applyKenBurns, addKeyAtPlayhead,
}: {
  s: Scene;
  sel: number;
  scenes: Scene[];
  textRef: RefObject<HTMLTextAreaElement | null>;
  patch: (i: number, p: Partial<Scene>) => void;
  setSceneSpeed: (i: number, speed: number) => void;
  splitAt: (i: number, ratio?: number) => void;
  setScenes: (ss: Scene[]) => void;
  sceneKfTime: () => number;
  clearMotion: () => void;
  applyKenBurns: (dir: "in" | "out") => void;
  addKeyAtPlayhead: (prop: KfProp) => void;
}) {
  return (
    <div className="ed-pane">
      <LockedFieldset locked={!!s.locked}>
      <div className="ed-row"><span className="ed-stype" style={{ color: TYPE_COLOR[s.type] }}>{s.type.replace("_", " ")}</span><Toggle on={!!s.emphasis} onClick={() => patch(sel, { emphasis: !s.emphasis })} label="beat peak" /></div>
      <Slider label="Duration" value={s.durationSec || 2} min={2} max={14} step={0.5} onChange={(v: number) => patch(sel, { durationSec: v })} fmt={(v: number) => v.toFixed(1) + "s"} />
      <Slider label="Speed" value={s.speed ?? 1} min={0.25} max={3} step={0.05} onChange={(v: number) => setSceneSpeed(sel, v)} fmt={(v: number) => v.toFixed(2) + "x"} />
      <div className="tool-row">
        <button className="btn" onClick={() => splitAt(sel)}><Ico c="RZ" />Split <Key>S</Key></button>
        <button className="btn" onClick={() => setSceneSpeed(sel, 1.25)}><Ico c="SP" />Fast</button>
        <button className="btn" onClick={() => setSceneSpeed(sel, 0.75)}><Ico c="SL" />Slow</button>
      </div>
      {(() => {
        const tracks = getTracks(s.style);
        const kfN = keyframeCount(tracks);
        const tNow = sceneKfTime();
        return (
          <div className="fld">
            <label style={{ display: "flex", justifyContent: "space-between" }}>
              <span>Motion / keyframes{kfN ? ` · ${kfN}` : ""}</span>
              {kfN > 0 && <button className="lnk-btn" onClick={clearMotion} title="Clear all motion">clear</button>}
            </label>
            <div className="tool-row">
              <button className="btn" onClick={() => applyKenBurns("in")} title="Ken Burns zoom in"><ZoomIn size={14} strokeWidth={2} />Zoom in</button>
              <button className="btn" onClick={() => applyKenBurns("out")} title="Ken Burns zoom out"><ZoomOut size={14} strokeWidth={2} />Zoom out</button>
            </div>
            <div className="kf-grid">
              {KF_PROPS.map((prop) => (
                <button
                  key={prop}
                  className={`kf-prop${hasTrack(tracks, prop) ? " on" : ""}`}
                  onClick={() => addKeyAtPlayhead(prop)}
                  title={`Add ${prop} keyframe at playhead`}
                >
                  <Diamond size={11} strokeWidth={2} />
                  {prop}
                </button>
              ))}
            </div>
            {kfN > 0 && (
              <div className="kf-lane" title="Keyframes across this scene">
                <span className="kf-playhead" style={{ left: `${tNow * 100}%` }} />
                {tracks.flatMap((tr) => tr.points.map((p, i) => (
                  <span key={`${tr.prop}-${i}`} className="kf-dot" style={{ left: `${p.t * 100}%` }} title={`${tr.prop} @ ${(p.t * 100).toFixed(0)}% = ${p.v}`} />
                )))}
              </div>
            )}
          </div>
        );
      })()}
      <div className="fld"><label>Narration (spoken)</label><textarea className="input" rows={2} value={s.say ?? ""} onChange={(e) => patch(sel, { say: e.target.value })} /></div>
      <div className="fld"><label>On-screen text</label><textarea ref={textRef} className="input" rows={s.type === "code_block" ? 4 : 2} value={primaryText(s)} onChange={(e) => setScenes(scenes.map((x, j) => (j === sel ? setPrimaryText(x, e.target.value) : x)))} /></div>
      <div className="fld">
        <label>Text animation timeline</label>
        <div className="anim-strip">
          <span className="anim-in" style={{ width: `${Math.min(45, ((s.textAnim?.inSec ?? 0.35) / Math.max(1, s.durationSec || 2)) * 100)}%` }}>IN</span>
          <span className="anim-hold">HOLD</span>
          <span className="anim-out" style={{ width: `${Math.min(45, ((s.textAnim?.outSec ?? 0.35) / Math.max(1, s.durationSec || 2)) * 100)}%` }}>OUT</span>
        </div>
        <Slider label="In" value={s.textAnim?.inSec ?? 0.35} min={0} max={2} step={0.05} onChange={(v: number) => patch(sel, { textAnim: { ...(s.textAnim ?? {}), inSec: v } })} fmt={(v: number) => v.toFixed(2) + "s"} />
        <Slider label="Out" value={s.textAnim?.outSec ?? 0.35} min={0} max={2} step={0.05} onChange={(v: number) => patch(sel, { textAnim: { ...(s.textAnim ?? {}), outSec: v } })} fmt={(v: number) => v.toFixed(2) + "s"} />
        <div className="tool-row">
          {["fade", "slide", "scale", "type"].map((a) => (
            <button key={a} className={`tg${(s.textAnim?.preset ?? "fade") === a ? " tg-on" : ""}`} onClick={() => patch(sel, { textAnim: { ...(s.textAnim ?? {}), preset: a } })}>{a}</button>
          ))}
        </div>
      </div>
      <div className="fld">
        <label style={{ display: "flex", justifyContent: "space-between" }}>B-roll layer<Toggle on={!!s.broll} onClick={() => patch(sel, { broll: s.broll ? undefined : { query: s.say?.slice(0, 40) || "abstract dark", kind: "concrete" } })} label={s.broll ? "on" : "off"} /></label>
        {s.broll && (
          <div style={{ display: "flex", gap: 8 }}>
            <input className="input" value={s.broll.query} onChange={(e) => patch(sel, { broll: { ...s.broll, query: e.target.value } })} placeholder="visual query" />
            <select className="input" style={{ width: 110 }} value={s.broll.kind} onChange={(e) => patch(sel, { broll: { ...s.broll, kind: e.target.value } })}><option value="concrete">stock</option><option value="abstract">AI</option></select>
          </div>
        )}
      </div>
      </LockedFieldset>
    </div>
  );
}
