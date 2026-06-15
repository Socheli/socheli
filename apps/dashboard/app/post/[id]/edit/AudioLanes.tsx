import type { MouseEvent } from "react";
import type { AudioTrack } from "./lib";

type Menu = { x: number; y: number; i: number; kind: "scene" | "audio" };

export function AudioLanes({
  audioTracks, selTrack, setSelTrack, setTab, setMenu,
}: {
  audioTracks: AudioTrack[];
  selTrack: string;
  setSelTrack: (id: string) => void;
  setTab: (t: "scene" | "style" | "subtitles" | "mix" | "transcript") => void;
  setMenu: (m: Menu | null) => void;
}) {
  return (
    <div className="audio-lanes">
      {audioTracks.map((tr) => (
        <div
          key={tr.id}
          className={`audio-lane${selTrack === tr.id ? " on" : ""}${tr.disabled ? " off" : ""}`}
          onClick={() => { setSelTrack(tr.id); setTab("mix"); }}
          onContextMenu={(e: MouseEvent) => { e.preventDefault(); setSelTrack(tr.id); setTab("mix"); setMenu({ x: e.clientX, y: e.clientY, i: 0, kind: "audio" }); }}
        >
          <span className="audio-lane-name">{tr.name}</span>
          <div className="audio-clip">
            {(tr.splits ?? []).map((x, idx) => <span key={`${tr.id}-${idx}-${x}`} className="audio-cut" style={{ left: `${x * 100}%` }} />)}
            <span className="audio-wave" />
          </div>
          <span className="audio-lane-meta">{tr.disabled ? "deleted" : `${(tr.speed ?? 1).toFixed(2)}x / ${Math.round((tr.vol ?? 1) * 100)}%`}</span>
        </div>
      ))}
    </div>
  );
}
