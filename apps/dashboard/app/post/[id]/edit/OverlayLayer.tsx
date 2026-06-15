import type { PointerEvent } from "react";
import { Plus, RotateCw, Trash2 } from "lucide-react";
import type { Overlay, Scene } from "./lib";
import { OVERLAY_PRESETS, OVERLAY_EMOJI } from "./lib";

// Free-form overlay layer: a small "Add overlay" toolbar plus selectable,
// draggable overlay boxes rendered ON the measured frame (same geometry as
// CanvasTextOverlay). Position x/y are 1080-space offsets from the frame
// centre. All authoring logic lives in page.tsx; this is presentational.
export function OverlayLayer({
  s, sel, overlays, frameBox, locked,
  selectedOverlay, addOpen, emojiOpen,
  setAddOpen, setEmojiOpen, addOverlay, addEmoji,
  selectOverlay, patchOverlay, deleteOverlay,
  beginOverlayDrag, moveOverlayDrag, endOverlayDrag,
  beginOverlayBox, moveOverlayBox, endOverlayBox,
}: {
  s: Scene;
  sel: number;
  overlays: Overlay[];
  frameBox: { w: number; h: number };
  locked: boolean;
  selectedOverlay: string | null;
  addOpen: boolean;
  emojiOpen: boolean;
  setAddOpen: (v: boolean) => void;
  setEmojiOpen: (v: boolean) => void;
  addOverlay: (make: () => Omit<Overlay, "id" | "x" | "y">) => void;
  addEmoji: (emoji: string) => void;
  selectOverlay: (id: string | null) => void;
  patchOverlay: (id: string, p: Partial<Overlay>) => void;
  deleteOverlay: (id: string) => void;
  beginOverlayDrag: (e: PointerEvent<HTMLElement>, id: string) => void;
  moveOverlayDrag: (e: PointerEvent<HTMLElement>) => void;
  endOverlayDrag: (e: PointerEvent<HTMLElement>) => void;
  beginOverlayBox: (e: PointerEvent<HTMLElement>, id: string, mode: "scale" | "rotate") => void;
  moveOverlayBox: (e: PointerEvent<HTMLElement>) => void;
  endOverlayBox: (e: PointerEvent<HTMLElement>) => void;
}) {
  if (frameBox.w <= 0) return null;
  const pxPer = frameBox.w / 1080;

  return (
    <>
      {/* Add-overlay toolbar — a small canvas toolbar pinned top-right of the frame */}
      <div className="ovl-toolbar" onClick={(e) => e.stopPropagation()}>
        <button
          className={`ovl-add-btn${addOpen ? " on" : ""}`}
          title="Add overlay element"
          onClick={() => { setAddOpen(!addOpen); setEmojiOpen(false); }}
          disabled={locked}
        >
          <Plus size={13} strokeWidth={2.2} /> Overlay
        </button>
        {addOpen && !locked && (
          <div className="ovl-menu">
            {OVERLAY_PRESETS.map((p) => (
              <button
                key={p.key}
                onClick={() => { if (p.key === "emoji") { setEmojiOpen(true); setAddOpen(false); } else addOverlay(p.make); }}
              >
                {p.label}
              </button>
            ))}
          </div>
        )}
        {emojiOpen && !locked && (
          <div className="ovl-menu ovl-emoji">
            {OVERLAY_EMOJI.map((em) => (
              <button key={em} className="ovl-emoji-cell" onClick={() => addEmoji(em)}>{em}</button>
            ))}
          </div>
        )}
      </div>

      {/* Overlay elements on the frame */}
      {overlays.map((o) => {
        const left = frameBox.w / 2 + (o.x ?? 0) * pxPer;
        const top = frameBox.h / 2 + (o.y ?? 0) * pxPer;
        const isSel = o.id === selectedOverlay;
        const base = 120 * pxPer; // 1080-space base box size → screen px
        return (
          <div
            key={o.id}
            className={`ovl-item${isSel ? " ovl-sel" : ""}`}
            style={{
              left,
              top,
              width: base,
              height: base,
              transform: `translate(-50%, -50%) rotate(${o.rotation ?? 0}deg) scale(${o.scale ?? 1})`,
              opacity: o.opacity ?? 1,
            }}
            onPointerDown={(e) => { if (!locked) beginOverlayDrag(e, o.id); }}
            onPointerMove={moveOverlayDrag}
            onPointerUp={endOverlayDrag}
            onPointerCancel={endOverlayDrag}
            onClick={(e) => { e.stopPropagation(); selectOverlay(o.id); }}
          >
            <OverlayContent o={o} />
            {isSel && !locked && (
              <>
                <span
                  className="box-handle box-se ovl-handle"
                  title="Drag to scale"
                  onPointerDown={(e) => beginOverlayBox(e, o.id, "scale")}
                  onPointerMove={moveOverlayBox}
                  onPointerUp={endOverlayBox}
                  onPointerCancel={endOverlayBox}
                  onClick={(e) => e.stopPropagation()}
                />
                <span
                  className="box-rotate ovl-rotate"
                  title="Drag to rotate (Shift = 15° snap)"
                  onPointerDown={(e) => beginOverlayBox(e, o.id, "rotate")}
                  onPointerMove={moveOverlayBox}
                  onPointerUp={endOverlayBox}
                  onPointerCancel={endOverlayBox}
                  onClick={(e) => e.stopPropagation()}
                >
                  <RotateCw size={11} strokeWidth={2} />
                </span>
                <button
                  className="ovl-del"
                  title="Delete overlay"
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => { e.stopPropagation(); deleteOverlay(o.id); }}
                >
                  <Trash2 size={12} strokeWidth={2} />
                </button>
              </>
            )}
          </div>
        );
      })}
    </>
  );
}

function OverlayContent({ o }: { o: Overlay }) {
  if (o.type === "emoji") return <span className="ovl-emoji-glyph">{o.content || "✨"}</span>;
  if (o.type === "text") return <span className="ovl-text" style={{ color: o.color || "#ffffff" }}>{o.content || "Label"}</span>;
  if (o.type === "logo") return <span className="ovl-logo">LOGO</span>;
  if (o.type === "image") return o.src ? <img className="ovl-img" src={o.src} alt="" /> : <span className="ovl-logo">image</span>;
  // shape
  const color = o.color || "#ffffff";
  if (o.shape === "circle") return <span className="ovl-shape" style={{ background: color, borderRadius: "50%" }} />;
  if (o.shape === "line") return <span className="ovl-shape" style={{ background: color, height: "10%", alignSelf: "center" }} />;
  if (o.shape === "triangle" || o.shape === "star" || o.shape === "arrow") {
    return (
      <svg viewBox="0 0 100 100" className="ovl-shape-svg" aria-hidden>
        {o.shape === "triangle" && <polygon points="50,8 92,92 8,92" fill={color} />}
        {o.shape === "arrow" && <path d="M8 42 H64 V24 L92 50 L64 76 V58 H8 Z" fill={color} />}
        {o.shape === "star" && <polygon points="50,6 61,38 95,38 67,58 78,92 50,70 22,92 33,58 5,38 39,38" fill={color} />}
      </svg>
    );
  }
  return <span className="ovl-shape" style={{ background: color, borderRadius: 6 }} />;
}
