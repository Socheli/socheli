import type { PointerEvent } from "react";
import { Play, Pause, Volume2, VolumeX, Maximize } from "lucide-react";

export function Transport({
  playing, muted, playFrame, totalF, playFrac,
  togglePlay, toggleMute, fmtClock, seekFromEl, goFullscreen,
}: {
  playing: boolean;
  muted: boolean;
  playFrame: number;
  totalF: number;
  playFrac: number;
  togglePlay: () => void;
  toggleMute: () => void;
  fmtClock: (frame: number) => string;
  seekFromEl: (el: HTMLElement | null, clientX: number) => void;
  goFullscreen: () => void;
}) {
  return (
    <div className="ed-transport">
      <button className="ed-tp-btn ed-tp-play" onClick={togglePlay} title={playing ? "Pause (Space)" : "Play (Space)"}>{playing ? <Pause size={15} strokeWidth={2} /> : <Play size={15} strokeWidth={2} />}</button>
      <button className="ed-tp-btn" onClick={toggleMute} title={muted ? "Unmute" : "Mute"}>{muted ? <VolumeX size={15} strokeWidth={2} /> : <Volume2 size={15} strokeWidth={2} />}</button>
      <span className="ed-tp-time">{fmtClock(playFrame)} <span>/ {fmtClock(totalF)}</span></span>
      <div
        className="ed-tp-scrub"
        title="Click or drag to scrub"
        onPointerDown={(e: PointerEvent<HTMLDivElement>) => { e.currentTarget.setPointerCapture(e.pointerId); seekFromEl(e.currentTarget, e.clientX); }}
        onPointerMove={(e: PointerEvent<HTMLDivElement>) => e.currentTarget.hasPointerCapture(e.pointerId) && seekFromEl(e.currentTarget, e.clientX)}
      >
        <div className="ed-tp-fill" style={{ width: `${playFrac * 100}%` }} />
        <div className="ed-tp-knob" style={{ left: `${playFrac * 100}%` }} />
      </div>
      <button className="ed-tp-btn" onClick={goFullscreen} title="Fullscreen"><Maximize size={15} strokeWidth={2} /></button>
    </div>
  );
}
