import type { Mix } from "./lib";
import { Slider, Toggle } from "./ui";

export function InspectorSubtitles({
  subtitleSettings, accent, patchSubtitles,
}: {
  subtitleSettings: NonNullable<Mix["subtitles"]> & {
    enabled: boolean; mode: "karaoke" | "lines"; preset: "pop" | "bounce" | "phrase" | "hormozi" | "glow"; position: "bottom" | "middle" | "top";
    fontScale: number; letterSpacing: number; lineHeight: number; background: boolean; backgroundOpacity: number; highlightColor: string; inactiveOpacity: number; maxWords: number;
  };
  accent: string;
  patchSubtitles: (p: Partial<NonNullable<Mix["subtitles"]>>) => void;
}) {
  return (
    <div className="ed-pane">
      <div className="ed-row"><span className="ed-stype">Subtitle sync</span><Toggle on={subtitleSettings.enabled !== false} onClick={() => patchSubtitles({ enabled: subtitleSettings.enabled === false })} label={subtitleSettings.enabled === false ? "off" : "on"} /></div>
      <div className="fld">
        <label>Mode</label>
        <div className="tool-row">
          {(["karaoke", "lines"] as const).map((m) => <button key={m} className={`tg${subtitleSettings.mode === m ? " tg-on" : ""}`} onClick={() => patchSubtitles({ mode: m })}>{m}</button>)}
        </div>
      </div>
      <div className="fld">
        <label>Karaoke preset</label>
        <div className="tool-row">
          {(["pop", "bounce", "phrase", "hormozi", "glow"] as const).map((p) => <button key={p} className={`tg${subtitleSettings.preset === p ? " tg-on" : ""}`} onClick={() => patchSubtitles({ preset: p })}>{p}</button>)}
        </div>
      </div>
      <div className="fld">
        <label>Keyword emphasis</label>
        <input
          className="input"
          placeholder="comma-separated, e.g. free, now, secret"
          value={(subtitleSettings.keywords ?? []).join(", ")}
          onChange={(e) => patchSubtitles({ keywords: e.target.value.split(",").map((k) => k.trim()).filter(Boolean) })}
        />
      </div>
      <div className="fld">
        <label>Position</label>
        <div className="tool-row">
          {(["bottom", "middle", "top"] as const).map((p) => <button key={p} className={`tg${subtitleSettings.position === p ? " tg-on" : ""}`} onClick={() => patchSubtitles({ position: p })}>{p}</button>)}
        </div>
      </div>
      <Slider label="Subtitle size" value={subtitleSettings.fontScale ?? 1} min={0.6} max={1.8} step={0.05} onChange={(v: number) => patchSubtitles({ fontScale: v })} fmt={(v: number) => `${Math.round(v * 100)}%`} />
      <Slider label="Letter spacing" value={subtitleSettings.letterSpacing ?? -0.01} min={-0.08} max={0.2} step={0.005} onChange={(v: number) => patchSubtitles({ letterSpacing: v })} fmt={(v: number) => `${v.toFixed(3)}em`} />
      <Slider label="Line height" value={subtitleSettings.lineHeight ?? 1.12} min={0.8} max={1.8} step={0.02} onChange={(v: number) => patchSubtitles({ lineHeight: v })} fmt={(v: number) => v.toFixed(2)} />
      <Slider label="Words/group" value={subtitleSettings.maxWords ?? 4} min={1} max={8} step={1} onChange={(v: number) => patchSubtitles({ maxWords: v })} fmt={(v: number) => `${Math.round(v)}`} />
      <Slider label="Inactive opacity" value={subtitleSettings.inactiveOpacity ?? 0.32} min={0.1} max={0.8} step={0.05} onChange={(v: number) => patchSubtitles({ inactiveOpacity: v })} fmt={(v: number) => `${Math.round(v * 100)}%`} />
      <div className="fld">
        <label>Highlight color</label>
        <div className="color-head">
          <label className="color-picker" title="Subtitle highlight">
            <input type="color" value={subtitleSettings.highlightColor || accent || "#ffffff"} onChange={(e) => patchSubtitles({ highlightColor: e.target.value })} />
            <span style={{ background: subtitleSettings.highlightColor || accent || "#ffffff" }} />
          </label>
          <input className="input color-hex" value={subtitleSettings.highlightColor || "scene accent"} onChange={(e) => patchSubtitles({ highlightColor: e.target.value === "scene accent" ? undefined : e.target.value })} />
        </div>
      </div>
      <div className="fld">
        <label style={{ display: "flex", justifyContent: "space-between" }}>Subtitle background<Toggle on={!!subtitleSettings.background} onClick={() => patchSubtitles({ background: !subtitleSettings.background })} label={subtitleSettings.background ? "on" : "off"} /></label>
        <Slider label="Background opacity" value={subtitleSettings.backgroundOpacity ?? 0.48} min={0} max={1} step={0.05} onChange={(v: number) => patchSubtitles({ backgroundOpacity: v })} fmt={(v: number) => `${Math.round(v * 100)}%`} />
      </div>
    </div>
  );
}
