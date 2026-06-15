import type { MouseEvent, PointerEvent, RefObject } from "react";
import { Zap } from "lucide-react";
import type { Scene } from "./lib";
import { TYPE_COLOR, FPS } from "./lib";

type HoverCut = { i: number; ratio: number } | null;
type TrimLive = { i: number; durationSec: number } | null;

export function Timeline({
  scenes, sel, tool, id, drag, hoverCut, trimLive, beatFrames, snapBeat, totalF, playFrac,
  trackRef,
  setDrag, reorder, setHoverCut, ratioFromEvent, clickSceneBlock, inspectScene, contextForScene,
  beginTrim, moveTrim, endTrim, scrubPlayhead, seekTimeline,
}: {
  scenes: Scene[];
  sel: number;
  tool: "select" | "razor" | "stitch" | "text";
  id: string;
  drag: number | null;
  hoverCut: HoverCut;
  trimLive: TrimLive;
  beatFrames: number[];
  snapBeat: boolean;
  totalF: number;
  playFrac: number;
  trackRef: RefObject<HTMLDivElement | null>;
  setDrag: (i: number | null) => void;
  reorder: (from: number, to: number) => void;
  setHoverCut: (h: HoverCut) => void;
  ratioFromEvent: (e: MouseEvent<HTMLElement>) => number;
  clickSceneBlock: (e: MouseEvent<HTMLElement>, i: number) => void;
  inspectScene: (i: number) => void;
  contextForScene: (e: MouseEvent, i: number) => void;
  beginTrim: (e: PointerEvent<HTMLElement>, i: number) => void;
  moveTrim: (e: PointerEvent<HTMLElement>) => void;
  endTrim: (e: PointerEvent<HTMLElement>) => void;
  scrubPlayhead: (e: PointerEvent<HTMLDivElement>) => void;
  seekTimeline: (clientX: number) => void;
}) {
  return (
    <div className="ed-track" ref={trackRef}>
      {scenes.map((sc, i) => (
        <div key={sc.id ?? i} draggable onDragStart={() => setDrag(i)} onDragOver={(e) => e.preventDefault()} onDrop={() => { if (drag !== null) reorder(drag, i); setDrag(null); }}
          onMouseMove={(e) => (tool === "razor" || tool === "stitch") && setHoverCut({ i, ratio: ratioFromEvent(e) })}
          onMouseLeave={() => hoverCut?.i === i && setHoverCut(null)}
          onClick={(e) => clickSceneBlock(e, i)} onDoubleClick={(e) => { e.preventDefault(); inspectScene(i); }} onContextMenu={(e) => contextForScene(e, i)} className={`tlb${i === sel ? " tlb-sel" : ""}${tool === "razor" ? " tlb-razor" : ""}${tool === "stitch" ? " tlb-stitch" : ""}${tool === "text" ? " tlb-text" : ""}`}
          style={{ flexGrow: sc.durationSec || 1, borderColor: i === sel ? TYPE_COLOR[sc.type] : "var(--border-subtle)", backgroundImage: `url(/api/scenethumb/${id}/${i})` }}>
          <div className="tlb-ov" />
          {hoverCut?.i === i && (tool === "razor" || tool === "stitch") && <span className="tool-cursor" style={{ left: `${hoverCut.ratio * 100}%` }}>{tool === "razor" ? "RZ" : "ST"}</span>}
          <div className="tlb-head"><span className="tl-dot" style={{ background: TYPE_COLOR[sc.type] }} /><span className="tlb-n">{i + 1}</span>{sc.emphasis && <span className="peak-mark" title="beat peak"><Zap size={11} strokeWidth={2.5} /></span>}</div>
          <div className="tlb-foot"><span className="tlb-type">{sc.type.replace("_", " ")}</span><span>{(sc.speed ?? 1).toFixed(2)}x / {(sc.durationSec || 0).toFixed(1)}s</span></div>
          {/* C1: tail trim handle — drag to change duration (min 2s / max 14s) */}
          <span
            className="tlb-trim"
            title="Drag to trim duration"
            onPointerDown={(e) => beginTrim(e, i)}
            onPointerMove={moveTrim}
            onPointerUp={endTrim}
            onPointerCancel={endTrim}
            onClick={(e) => e.stopPropagation()}
            onDoubleClick={(e) => e.stopPropagation()}
          />
          {trimLive?.i === i && (
            <span className="tlb-trim-read">{trimLive.durationSec.toFixed(1)}s · {Math.round(trimLive.durationSec * FPS)}f</span>
          )}
        </div>
      ))}
      <div className="ed-outro" title="outro card" style={{ flexGrow: 3.3 }}><div className="tlb-ov" /><div className="tlb-head"><span className="tlb-n">END</span></div><div className="tlb-foot"><span className="tlb-type">outro</span></div></div>
      {/* C7: beat tick marks along the ruler */}
      {totalF > 0 && beatFrames.map((bf, k) => (
        <span key={`beat-${k}`} className={`beat-tick${snapBeat ? " on" : ""}`} style={{ left: `${(bf / totalF) * 100}%` }} title={`beat @ ${(bf / FPS).toFixed(2)}s`} />
      ))}
      <div
        className="ed-playhead"
        style={{ left: `${playFrac * 100}%` }}
        title="Drag to scrub the video"
        onPointerDown={scrubPlayhead}
        onPointerMove={(e) => e.currentTarget.hasPointerCapture(e.pointerId) && seekTimeline(e.clientX)}
      />
    </div>
  );
}
