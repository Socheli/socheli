"use client";

import { Sparkles, Loader2 } from "lucide-react";
import type { Understanding } from "./types";

/* The content-aware ANALYSIS panel — the Odysser "it understands your video".
   Renders item.understanding: a compact stat strip, the shot strip, the
   segment-timed transcript, and the dead-air / filler flags. When nothing is
   built yet it shows the "Understand" action (which triggers editor_understand
   on the parent), and while the detached worker runs it shows a quiet job line.
   Read-only — no editing happens here; chat drives every change. */

const fmt = (s: number) => {
  if (!isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, "0")}`;
};

export function UnderstandingPanel({
  understanding,
  built,
  summary,
  building,
  canEdit,
  onUnderstand,
}: {
  understanding: Understanding | null;
  built: boolean;
  summary?: string;
  building: boolean;
  canEdit: boolean;
  onUnderstand: () => void;
}) {
  return (
    <div className="st-analysis">
      <div className="st-section-head" style={{ margin: 0 }}>
        <span className="st-section-title">Content analysis</span>
        {!built && !building && canEdit && (
          <button className="btn" style={{ padding: "6px 12px", fontSize: 12 }} onClick={onUnderstand}>
            <Sparkles size={13} /> Understand
          </button>
        )}
      </div>

      {/* Not built yet — invite the deep pipeline (or show it running). */}
      {!built && !building && (
        <div className="sub" style={{ fontSize: 12.5 }}>
          {canEdit
            ? "Run understanding to transcribe the audio, segment shots, and flag dead-air, filler and highlights — the grounding the chat editor edits against."
            : "This video hasn't been analyzed yet."}
        </div>
      )}
      {building && (
        <div className="st-job">
          <Loader2 size={13} className="spin" style={{ animation: "st-spin .8s linear infinite" }} />
          Understanding this video — transcribing, segmenting shots, scoring highlights…
        </div>
      )}

      {built && understanding && (
        <>
          {summary && <div className="st-an-summary">{summary}</div>}

          <div className="st-an-stats">
            <Stat n={fmt(understanding.durationSec)} l="length" />
            <Stat n={understanding.shots.length} l="shots" />
            <Stat n={understanding.highlights.length} l="highlights" />
            <Stat n={understanding.deadAir.length} l="dead air" warn={understanding.deadAir.length > 0} />
            <Stat n={understanding.filler.length} l="filler" warn={understanding.filler.length > 0} />
          </div>

          {/* shot strip — markers, not thumbnails (v1; thumbnail extraction later) */}
          {understanding.shots.length > 0 && (
            <div>
              <div className="st-an-block-title">Shots</div>
              <div className="st-shots">
                {understanding.shots.map((sh) => (
                  <div key={sh.id} className="st-shot" title={`${fmt(sh.inSec)}–${fmt(sh.outSec)} · ${sh.source}`}>
                    <div className="st-shot-i">#{sh.index + 1}</div>
                    <div className="st-shot-d">{Math.round(sh.durationSec)}s</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* transcript — scrollable, segment-timed */}
          {understanding.transcript?.segments?.length > 0 && (
            <div>
              <div className="st-an-block-title">Transcript</div>
              <div className="st-transcript">
                {understanding.transcript.segments.map((seg) => (
                  <div key={seg.index} className="st-tseg">
                    <span className="st-tseg-t">{fmt(seg.startSec)}</span>
                    <span className="st-tseg-x">{seg.text.trim()}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* editorial flags — what the editor can ripple out */}
          {(understanding.deadAir.length > 0 || understanding.filler.length > 0) && (
            <div>
              <div className="st-an-block-title">Flags</div>
              <div className="st-flags">
                {understanding.deadAir.map((d, i) => (
                  <div className="st-flag-row" key={`d${i}`}>
                    <span className="t">dead air</span>
                    <span className="x">{fmt(d.startSec)}–{fmt(d.endSec)}{d.reason ? ` · ${d.reason}` : ""}</span>
                  </div>
                ))}
                {understanding.filler.slice(0, 12).map((f, i) => (
                  <div className="st-flag-row" key={`f${i}`}>
                    <span className="t">{f.kind === "long_pause" ? "long pause" : "filler"}</span>
                    <span className="x">{fmt(f.atSec)} · &ldquo;{f.word}&rdquo;</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {understanding.notes?.length > 0 && (
            <div className="sub" style={{ fontSize: 11 }}>{understanding.notes.join(" · ")}</div>
          )}
        </>
      )}
    </div>
  );
}

function Stat({ n, l, warn }: { n: string | number; l: string; warn?: boolean }) {
  return (
    <div className={`st-stat${warn ? " warn" : ""}`}>
      <span className="st-stat-n">{n}</span>
      <span className="st-stat-l">{l}</span>
    </div>
  );
}
