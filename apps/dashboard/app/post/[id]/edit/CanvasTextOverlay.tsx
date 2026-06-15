import type { CSSProperties, PointerEvent, RefObject } from "react";
import { RotateCw, RotateCcw, AArrowDown, AArrowUp, AlignLeft, AlignCenter, Maximize2, RefreshCw } from "lucide-react";
import type { Scene } from "./lib";
import { Ico } from "./ui";

export function CanvasTextOverlay({
  liveProps, tool, textPopover, frameBox, boxRef, textDragRef,
  canvasTextStyle, canvasTextRef, sel, s, selectedText,
  canvasFontPx, canvasFontWeight, canvasLineHeight, anchor, safeZones,
  setTool, setTextPopover, beginTextDrag, moveTextDrag, endTextDrag,
  beginBoxDrag, moveBoxDrag, endBoxDrag, patchSelectedText, patchStyle,
  resetTextTransform, setSafeZones,
}: {
  liveProps: any;
  tool: "select" | "razor" | "stitch" | "text";
  textPopover: { x: number; y: number } | null;
  frameBox: { w: number; h: number };
  boxRef: RefObject<any>;
  textDragRef: RefObject<any>;
  canvasTextStyle: CSSProperties;
  canvasTextRef: RefObject<HTMLTextAreaElement | null>;
  sel: number;
  s: Scene;
  selectedText: string;
  canvasFontPx: number;
  canvasFontWeight: number;
  canvasLineHeight: number;
  anchor: { v: "top" | "center" | "bottom"; h: "left" | "center" };
  safeZones: boolean;
  setTool: (t: "select" | "razor" | "stitch" | "text") => void;
  setTextPopover: (p: { x: number; y: number } | null) => void;
  beginTextDrag: (e: PointerEvent<HTMLElement>) => void;
  moveTextDrag: (e: PointerEvent<HTMLElement>) => void;
  endTextDrag: () => void;
  beginBoxDrag: (e: PointerEvent<HTMLElement>, mode: "scale" | "rotate", corner: string) => void;
  moveBoxDrag: (e: PointerEvent<HTMLElement>) => void;
  endBoxDrag: (e: PointerEvent<HTMLElement>) => void;
  patchSelectedText: (value: string) => void;
  patchStyle: (i: number, p: any) => void;
  resetTextTransform: () => void;
  setSafeZones: (fn: (v: boolean) => boolean) => void;
}) {
  return (
    <>
      {liveProps && (tool === "text" || textPopover) && frameBox.w > 0 && (
        <div
          className="canvas-text-select"
          style={canvasTextStyle}
          onClick={(e) => { e.stopPropagation(); setTool("text"); setTextPopover({ x: 18, y: 18 }); }}
        >
          <div
            className="canvas-text-move"
            onPointerDown={beginTextDrag}
            onPointerMove={moveTextDrag}
            onPointerUp={endTextDrag}
            onPointerCancel={endTextDrag}
            title="Drag to move text on the frame"
          >
            <Ico c="MV" />
            <span>Scene {sel + 1} · {s.type?.replace("_", " ")}</span>
          </div>
          <textarea
            ref={canvasTextRef}
            className="canvas-text-input"
            value={selectedText}
            rows={Math.max(1, Math.min(7, selectedText.split("\n").length || 1))}
            style={{
              fontSize: canvasFontPx,
              fontWeight: canvasFontWeight,
              lineHeight: canvasLineHeight,
              letterSpacing: `${s.style?.letterSpacing ?? 0}em`,
              textAlign: anchor.h === "left" ? "left" : "center",
              color: s.style?.accent || "#f5f5f5",
              textTransform: s.style?.textCase === "upper" ? "uppercase" : s.style?.textCase === "lower" ? "lowercase" : s.style?.textCase === "title" ? "capitalize" : "none",
            }}
            onChange={(e) => patchSelectedText(e.target.value)}
            onClick={(e) => e.stopPropagation()}
            onDoubleClick={(e) => e.stopPropagation()}
          />
          {/* C5: 8 resize handles (corners + edges) → scale via fontScale */}
          {(["nw", "n", "ne", "e", "se", "s", "sw", "w"] as const).map((h) => (
            <span
              key={h}
              className={`box-handle box-${h}`}
              onPointerDown={(e) => beginBoxDrag(e, "scale", h)}
              onPointerMove={moveBoxDrag}
              onPointerUp={endBoxDrag}
              onPointerCancel={endBoxDrag}
              onClick={(e) => e.stopPropagation()}
            />
          ))}
          {/* C5: rotation handle (15deg snap with Shift) */}
          <span
            className="box-rotate"
            title="Drag to rotate (Shift = 15° snap)"
            onPointerDown={(e) => beginBoxDrag(e, "rotate", "rot")}
            onPointerMove={moveBoxDrag}
            onPointerUp={endBoxDrag}
            onPointerCancel={endBoxDrag}
            onClick={(e) => e.stopPropagation()}
          >
            <RotateCw size={11} strokeWidth={2} />
          </span>
          <div className="canvas-text-tools" onClick={(e) => e.stopPropagation()}>
            <button title="Smaller" onClick={() => { const fs = s.style?.fontScale ?? 1; const step = Math.max(0.05, fs * 0.08); patchStyle(sel, { fontScale: Math.max(0.6, Number((fs - step).toFixed(2))) }); }}><AArrowDown size={15} strokeWidth={2} /></button>
            <button title="Larger" onClick={() => { const fs = s.style?.fontScale ?? 1; const step = Math.max(0.05, fs * 0.08); patchStyle(sel, { fontScale: Math.min(1.6, Number((fs + step).toFixed(2))) }); }}><AArrowUp size={15} strokeWidth={2} /></button>
            <button title="Rotate left" onClick={() => patchStyle(sel, { rotation: Math.max(-45, Number(((s.style?.rotation ?? 0) - 2).toFixed(1))) })}><RotateCcw size={14} strokeWidth={2} /></button>
            <button title="Rotate right" onClick={() => patchStyle(sel, { rotation: Math.min(45, Number(((s.style?.rotation ?? 0) + 2).toFixed(1))) })}><RotateCw size={14} strokeWidth={2} /></button>
            <button title="Toggle align" onClick={() => patchStyle(sel, { align: s.style?.align === "left" ? "center" : "left" })}>{s.style?.align === "left" ? <AlignCenter size={14} strokeWidth={2} /> : <AlignLeft size={14} strokeWidth={2} />}</button>
            <button className={safeZones ? "on" : ""} title="Toggle safe-zone overlay" onClick={() => setSafeZones((v) => !v)}><Maximize2 size={14} strokeWidth={2} /></button>
            <button title="Reset" onClick={resetTextTransform}><RefreshCw size={14} strokeWidth={2} /></button>
          </div>
        </div>
      )}
      {/* C5: live alignment guides — appear while moving/scaling/rotating the box */}
      {liveProps && (tool === "text" || textPopover) && frameBox.w > 0 && (boxRef.current || textDragRef.current) && (
        <div className="align-guides" aria-hidden>
          {Math.abs(Number(s.style?.x ?? 0)) < 8 && <span className="guide-v" />}
          {Math.abs(Number(s.style?.y ?? 0)) < 8 && <span className="guide-h" />}
        </div>
      )}
      {/* C5: TikTok/Reels/Shorts safe-zone overlay (top/bottom unsafe bands) */}
      {liveProps && safeZones && frameBox.w > 0 && (
        <div className="safe-zones" aria-hidden>
          <div className="safe-band safe-top"><span>unsafe · top UI</span></div>
          <div className="safe-band safe-bottom"><span>unsafe · captions / UI</span></div>
        </div>
      )}
    </>
  );
}
