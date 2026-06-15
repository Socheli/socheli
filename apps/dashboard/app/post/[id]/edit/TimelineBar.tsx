import { Combine, Zap } from "lucide-react";
import { SCENE_TYPES, TYPE_COLOR } from "./lib";
import { Ico, Key } from "./ui";

export function TimelineBar({
  addOpen, scenes, tool, snapBeat, beatFrames,
  setAddOpen, addScene, dup, del, setTool, setTab, canvasTextRef, setSnapBeat,
}: {
  addOpen: boolean;
  scenes: any[];
  tool: "select" | "razor" | "stitch" | "text";
  snapBeat: boolean;
  beatFrames: number[];
  setAddOpen: (v: boolean) => void;
  addScene: (type: string) => void;
  dup: () => void;
  del: () => void;
  setTool: (t: "select" | "razor" | "stitch" | "text") => void;
  setTab: (t: "scene" | "style" | "subtitles" | "mix" | "transcript") => void;
  canvasTextRef: React.RefObject<HTMLTextAreaElement | null>;
  setSnapBeat: (fn: (v: boolean) => boolean) => void;
}) {
  return (
    <div className="ed-tl-bar">
      <div style={{ position: "relative" }}>
        <button className="btn" onClick={() => setAddOpen(!addOpen)}><Ico c="AD" />Add <Key>A</Key></button>
        {addOpen && (
          <div className="ed-menu">
            {SCENE_TYPES.map((t) => <button key={t} onClick={() => addScene(t)}><span className="tl-dot" style={{ background: TYPE_COLOR[t] }} />{t.replace("_", " ")}</button>)}
          </div>
        )}
      </div>
      <button className="btn" onClick={dup}><Ico c="CP" />Duplicate <Key>D</Key></button>
      <button className="btn" onClick={del} disabled={scenes.length <= 2}><Ico c="DL" />Delete <Key>Del</Key></button>
      <button className={`btn${tool === "razor" ? " btn-active" : ""}`} onClick={() => setTool(tool === "razor" ? "select" : "razor")}><Ico c="RZ" />Razor <Key>R</Key></button>
      <button className={`btn${tool === "stitch" ? " btn-active" : ""}`} onClick={() => setTool(tool === "stitch" ? "select" : "stitch")}><Combine size={14} strokeWidth={2} />Stitch <Key>J</Key></button>
      <button className={`btn${tool === "text" ? " btn-active" : ""}`} onClick={() => { setTool(tool === "text" ? "select" : "text"); setTab("scene"); requestAnimationFrame(() => canvasTextRef.current?.focus()); }}><Ico c="TX" />Text <Key>T</Key></button>
      <button className={`btn${snapBeat ? " btn-active" : ""}`} onClick={() => setSnapBeat((v) => !v)} title={beatFrames.length ? "Snap razor splits & trims to beats" : "No beats detected yet — render once to detect"}><Zap size={14} strokeWidth={2} />Snap beat</button>
      <span className="ed-meta" style={{ marginLeft: "auto" }}>drag scene tail to trim / razor split at cursor / stitch adjacent / Shift+Del ripple delete / snap beat aligns cuts</span>
    </div>
  );
}
