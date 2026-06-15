import type { Mix, AudioTrack } from "./lib";
import { Slider, Toggle, Ico } from "./ui";

type Menu = { x: number; y: number; i: number; kind: "scene" | "audio" };

export function InspectorMix({
  mix, audioTracks, selTrack, selectedTrack, withVoice, withBroll,
  setMix, setSelTrack, setMenu, updateTrack, splitAudioAtPlayhead, setWithVoice, setWithBroll,
}: {
  mix: Mix;
  audioTracks: AudioTrack[];
  selTrack: string;
  selectedTrack: AudioTrack;
  withVoice: boolean;
  withBroll: boolean;
  setMix: (m: Mix) => void;
  setSelTrack: (id: string) => void;
  setMenu: (m: Menu | null) => void;
  updateTrack: (id: string, p: Partial<AudioTrack>) => void;
  splitAudioAtPlayhead: (id: string) => void;
  setWithVoice: (v: boolean) => void;
  setWithBroll: (v: boolean) => void;
}) {
  return (
    <div className="ed-pane">
      <Slider label="Music" value={mix.musicVol ?? 1} min={0} max={2} step={0.05} onChange={(v: number) => setMix({ ...mix, musicVol: v })} fmt={(v: number) => Math.round(v * 100) + "%"} />
      <Slider label="Voice" value={mix.voiceVol ?? 1} min={0} max={2} step={0.05} onChange={(v: number) => setMix({ ...mix, voiceVol: v })} fmt={(v: number) => Math.round(v * 100) + "%"} />
      <Slider label="SFX" value={mix.sfxVol ?? 1} min={0} max={2} step={0.05} onChange={(v: number) => setMix({ ...mix, sfxVol: v })} fmt={(v: number) => Math.round(v * 100) + "%"} />
      <Slider label="Beat" value={mix.beatIntensity ?? 1} min={0} max={2} step={0.1} onChange={(v: number) => setMix({ ...mix, beatIntensity: v })} fmt={(v: number) => v.toFixed(1) + "x"} />
      <div className="audio-mixer">
        {audioTracks.map((tr) => (
          <button key={tr.id} className={`audio-track${selTrack === tr.id ? " on" : ""}`} onClick={() => setSelTrack(tr.id)} onContextMenu={(e) => { e.preventDefault(); setSelTrack(tr.id); setMenu({ x: e.clientX, y: e.clientY, i: 0, kind: "audio" }); }}>
            <span>{tr.name}</span>
            <span>{tr.disabled ? "deleted" : tr.mute ? "muted" : `${Math.round((tr.vol ?? 1) * 100)}%`}</span>
          </button>
        ))}
      </div>
      {selectedTrack && (
        <div className="audio-editor">
          <div className="ed-row"><span className="ed-stype">{selectedTrack.name} track</span><Toggle on={!selectedTrack.mute && !selectedTrack.disabled} onClick={() => updateTrack(selectedTrack.id, { mute: !selectedTrack.mute, disabled: false })} label={selectedTrack.disabled ? "deleted" : selectedTrack.mute ? "muted" : "on"} /></div>
          <Slider label="Track vol" value={selectedTrack.vol ?? 1} min={0} max={2} step={0.05} onChange={(v: number) => updateTrack(selectedTrack.id, { vol: v })} fmt={(v: number) => Math.round(v * 100) + "%"} />
          <Slider label="Speed" value={selectedTrack.speed ?? 1} min={0.5} max={2} step={0.05} onChange={(v: number) => updateTrack(selectedTrack.id, { speed: v })} fmt={(v: number) => v.toFixed(2) + "x"} />
          <Slider label="Pan" value={selectedTrack.pan ?? 0} min={-1} max={1} step={0.05} onChange={(v: number) => updateTrack(selectedTrack.id, { pan: v })} fmt={(v: number) => v.toFixed(2)} />
          <Slider label="Fade in" value={selectedTrack.fadeIn ?? 0} min={0} max={3} step={0.1} onChange={(v: number) => updateTrack(selectedTrack.id, { fadeIn: v })} fmt={(v: number) => v.toFixed(1) + "s"} />
          <Slider label="Fade out" value={selectedTrack.fadeOut ?? 0} min={0} max={3} step={0.1} onChange={(v: number) => updateTrack(selectedTrack.id, { fadeOut: v })} fmt={(v: number) => v.toFixed(1) + "s"} />
          <div className="tool-row">
            <button className="btn" onClick={() => splitAudioAtPlayhead(selectedTrack.id)}><Ico c="RZ" />Split audio</button>
            <button className="btn" onClick={() => updateTrack(selectedTrack.id, { disabled: true, mute: true })}><Ico c="DL" />Delete audio</button>
          </div>
        </div>
      )}
      <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
        <Toggle on={!mix.muteMusic} onClick={() => setMix({ ...mix, muteMusic: !mix.muteMusic })} label="music" />
        <Toggle on={!mix.muteVoice} onClick={() => setMix({ ...mix, muteVoice: !mix.muteVoice })} label="voice" />
        <Toggle on={!mix.muteSfx} onClick={() => setMix({ ...mix, muteSfx: !mix.muteSfx })} label="sfx" />
      </div>
      <div className="fld" style={{ marginTop: 16 }}>
        <label style={{ display: "flex", justifyContent: "space-between" }}>Auto-duck music under voice<Toggle on={mix.duck?.enabled !== false} onClick={() => setMix({ ...mix, duck: { ...(mix.duck ?? {}), enabled: mix.duck?.enabled === false } })} label={mix.duck?.enabled === false ? "off" : "on"} /></label>
        {mix.duck?.enabled !== false && (
          <>
            <Slider label="Duck amount" value={mix.duck?.amount ?? 0.7} min={0} max={1} step={0.05} onChange={(v: number) => setMix({ ...mix, duck: { ...(mix.duck ?? {}), amount: v } })} fmt={(v: number) => Math.round(v * 100) + "%"} />
            <Slider label="Attack" value={mix.duck?.attack ?? 0.15} min={0} max={2} step={0.05} onChange={(v: number) => setMix({ ...mix, duck: { ...(mix.duck ?? {}), attack: v } })} fmt={(v: number) => v.toFixed(2) + "s"} />
            <Slider label="Release" value={mix.duck?.release ?? 0.4} min={0} max={3} step={0.05} onChange={(v: number) => setMix({ ...mix, duck: { ...(mix.duck ?? {}), release: v } })} fmt={(v: number) => v.toFixed(2) + "s"} />
          </>
        )}
      </div>
      <div className="fld" style={{ marginTop: 20 }}>
        <label>Re-render with</label>
        <div style={{ display: "flex", gap: 8 }}><Toggle on={withVoice} onClick={() => setWithVoice(!withVoice)} label="voice" /><Toggle on={withBroll} onClick={() => setWithBroll(!withBroll)} label="b-roll" /></div>
      </div>
    </div>
  );
}
