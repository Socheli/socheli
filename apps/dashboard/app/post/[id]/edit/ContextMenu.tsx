import type { Scene, AudioTrack } from "./lib";
import { cloneScene } from "./lib";

type Menu = { x: number; y: number; i: number; kind: "scene" | "audio" };

export function ContextMenu({
  menu, selectedTrack, scenes, selTrack,
  setMenu, splitAt, stitchAt, setScenes, setSel, setSceneSpeed, patchStyle, patchEffect, delAt,
  splitAudioAtPlayhead, updateTrack,
}: {
  menu: Menu;
  selectedTrack: AudioTrack;
  scenes: Scene[];
  selTrack: string;
  setMenu: (m: Menu | null) => void;
  splitAt: (i: number, ratio?: number) => void;
  stitchAt: (i: number, preferNext?: boolean) => void;
  setScenes: (ss: Scene[]) => void;
  setSel: (i: number) => void;
  setSceneSpeed: (i: number, speed: number) => void;
  patchStyle: (i: number, p: any) => void;
  patchEffect: (i: number, key: string, value: any) => void;
  delAt: (i: number) => void;
  splitAudioAtPlayhead: (id: string) => void;
  updateTrack: (id: string, p: Partial<AudioTrack>) => void;
}) {
  return (
    <div className="ctx-menu" style={{ left: menu.x, top: menu.y }} onClick={(e) => e.stopPropagation()}>
      <div className="ctx-title">{menu.kind === "scene" ? `Scene ${menu.i + 1}` : selectedTrack.name}</div>
      {menu.kind === "scene" && (
        <>
          <button onClick={() => { splitAt(menu.i); setMenu(null); }}>Razor split</button>
          <button onClick={() => { stitchAt(menu.i, false); setMenu(null); }} disabled={menu.i <= 0}>Stitch left</button>
          <button onClick={() => { stitchAt(menu.i, true); setMenu(null); }} disabled={menu.i >= scenes.length - 1}>Stitch right</button>
          <button onClick={() => { const ns = [...scenes]; ns.splice(menu.i + 1, 0, cloneScene(scenes[menu.i])); setScenes(ns); setSel(menu.i + 1); setMenu(null); }}>Duplicate</button>
          <button onClick={() => { setSceneSpeed(menu.i, 1.25); setMenu(null); }}>Speed up 125%</button>
          <button onClick={() => { setSceneSpeed(menu.i, 0.75); setMenu(null); }}>Slow down 75%</button>
          <button onClick={() => { patchStyle(menu.i, { accent: "#ffffff" }); setMenu(null); }}>Set white color</button>
          <button onClick={() => { patchEffect(menu.i, "grain", !(scenes[menu.i].effects?.grain)); setMenu(null); }}>Toggle grain</button>
          <button className="danger" disabled={scenes.length <= 2} onClick={() => { delAt(menu.i); setMenu(null); }}>Delete scene</button>
        </>
      )}
      {menu.kind === "audio" && (
        <>
          <button onClick={() => { splitAudioAtPlayhead(selTrack); setMenu(null); }}>Split at playhead</button>
          <button onClick={() => updateTrack(selTrack, { mute: !selectedTrack.mute, disabled: false })}>{selectedTrack.mute ? "Unmute" : "Mute"}</button>
          <button onClick={() => updateTrack(selTrack, { speed: 1.25 })}>Speed up 125%</button>
          <button onClick={() => updateTrack(selTrack, { speed: 0.75 })}>Slow down 75%</button>
          <button onClick={() => updateTrack(selTrack, { fadeIn: 0.5, fadeOut: 0.5 })}>Add fades</button>
          <button className="danger" onClick={() => { updateTrack(selTrack, { disabled: true, mute: true }); setMenu(null); }}>Delete track audio</button>
        </>
      )}
    </div>
  );
}
