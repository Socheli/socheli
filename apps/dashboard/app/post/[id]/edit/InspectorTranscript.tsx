import { useMemo, useState } from "react";
import { GripVertical, Trash2, Lock, Replace, Mic } from "lucide-react";
import type { Scene } from "./lib";
import { TYPE_COLOR, primaryText, setPrimaryText } from "./lib";

type WordCue = { word: string; fromF: number; toF: number };

// ── Transcript-based editing (Descript-style) ──────────────────────────────
// One SEGMENT per scene. Each segment exposes the spoken line (scene.say) and
// the on-screen text (primaryText) as editable fields, plus click-to-seek,
// drag-to-reorder, and ripple-delete. A Find & Replace bar rewrites both the
// spoken line and the on-screen text across every (unlocked) scene in a single
// undoable action. When a render exists, the spoken line also renders as
// clickable words that seek to that word's start frame.
//
// Our edge over Descript: editing the spoken text here regenerates the actual
// voiceover from the corrected words on the next Save & Render — Descript can
// only re-cut/overdub existing audio, it can't truly re-synthesize the take.
export function InspectorTranscript({
  scenes, sel, words,
  patch, setScenes, setSel, delAt, reorder, seekToFrame, sceneStartFrame,
}: {
  scenes: Scene[];
  sel: number;
  words: WordCue[] | undefined;
  patch: (i: number, p: Partial<Scene>) => void;
  setScenes: (updater: (ss: Scene[]) => Scene[]) => void;
  setSel: (i: number) => void;
  delAt: (i: number) => void;
  reorder: (from: number, to: number) => void;
  seekToFrame: (frame: number) => void;
  sceneStartFrame: (i: number) => number;
}) {
  const [query, setQuery] = useState("");
  const [repl, setRepl] = useState("");
  const [drag, setDrag] = useState<number | null>(null);
  const [over, setOver] = useState<number | null>(null);

  // Map the flat WordCue[] onto scenes by FRAME RANGE. Each cue's absolute
  // start frame (fromF) is bucketed into the scene whose [start,end) it falls
  // in. This is drift-proof: media.ts builds per-word frames with the same
  // `cur += dur - TR` recurrence as sceneStart(), so frame ranges always line
  // up regardless of whisper-vs-say word-count mismatches (contractions,
  // numbers, punctuation). A scene with no cues in its range maps to null and
  // word-click falls back to the scene start.
  const wordsByScene = useMemo<(WordCue[] | null)[]>(() => {
    if (!words || !words.length) return scenes.map(() => null);
    return scenes.map((_sc, i) => {
      const start = sceneStartFrame(i);
      const end = i + 1 < scenes.length ? sceneStartFrame(i + 1) : Infinity;
      const slice = words.filter((w) => w.fromF >= start && w.fromF < end);
      return slice.length ? slice : null;
    });
  }, [words, scenes, sceneStartFrame]);

  // count of matches across say + on-screen text (case-insensitive)
  const matchCount = useMemo(() => {
    if (!query) return 0;
    const q = query.toLowerCase();
    const tally = (txt: string) => {
      if (!txt) return 0;
      let c = 0, i = 0;
      const hay = txt.toLowerCase();
      while ((i = hay.indexOf(q, i)) !== -1) { c++; i += q.length; }
      return c;
    };
    return scenes.reduce((acc, sc) => sc.locked ? acc : acc + tally(String(sc.say ?? "")) + tally(primaryText(sc)), 0);
  }, [query, scenes]);

  const replaceAll = () => {
    if (!query) return;
    const rx = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
    setScenes((ss) => ss.map((sc) => {
      if (sc.locked) return sc; // skip locked scenes
      let next = { ...sc };
      if (next.say) next.say = String(next.say).replace(rx, repl);
      // No stateful rx.test() guard: replace() is a no-op when there's no
      // match, and a global rx's lastIndex is stateful across .test()/.replace()
      // calls — testing here would inconsistently skip scenes. Only re-derive
      // the scene when the on-screen text actually changed.
      const t = primaryText(sc);
      if (t) { const rt = t.replace(rx, repl); if (rt !== t) next = setPrimaryText(next, rt); }
      return next;
    }));
  };

  const onDrop = (to: number) => {
    if (drag !== null && drag !== to) reorder(drag, to);
    setDrag(null); setOver(null);
  };

  const seekScene = (i: number) => { setSel(i); seekToFrame(sceneStartFrame(i)); };

  return (
    <div className="ed-pane tr-pane">
      {/* FIND & REPLACE — one undoable rewrite across all scenes */}
      <div className="tr-find">
        <div className="tr-find-row">
          <input className="input tr-in" placeholder="Find in transcript…" value={query} onChange={(e) => setQuery(e.target.value)} />
          <input className="input tr-in" placeholder="Replace with…" value={repl} onChange={(e) => setRepl(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") replaceAll(); }} />
          <button className="btn tr-rep" onClick={replaceAll} disabled={!query || matchCount === 0} title="Replace across all scenes (one undo step)"><Replace size={14} strokeWidth={2} />Replace all</button>
        </div>
        <div className="tr-find-meta">{query ? `${matchCount} match${matchCount === 1 ? "" : "es"}` : "spoken + on-screen text"}</div>
      </div>

      {/* SEGMENTS — one per scene */}
      <div className="tr-list">
        {scenes.map((sc, i) => {
          const cues = wordsByScene[i];
          const locked = !!sc.locked;
          return (
            <div
              key={sc.id ?? i}
              className={`tr-seg${i === sel ? " on" : ""}${locked ? " locked" : ""}${over === i ? " over" : ""}`}
              draggable={!locked}
              onDragStart={() => !locked && setDrag(i)}
              onDragOver={(e) => { e.preventDefault(); setOver(i); }}
              onDragLeave={() => setOver((o) => (o === i ? null : o))}
              onDrop={(e) => { e.preventDefault(); onDrop(i); }}
              onDragEnd={() => { setDrag(null); setOver(null); }}
              onClick={() => seekScene(i)}
            >
              <div className="tr-seg-head">
                <span className="tr-grip" title={locked ? "locked" : "drag to reorder"}>
                  {locked ? <Lock size={12} strokeWidth={2} /> : <GripVertical size={14} strokeWidth={2} />}
                </span>
                <span className="tr-seg-n">{i + 1}</span>
                <span className="tr-seg-type" style={{ color: TYPE_COLOR[sc.type] }}>{String(sc.type ?? "").replace(/_/g, " ")}</span>
                <span className="tr-seg-spacer" />
                <button
                  className="tr-del"
                  disabled={locked || scenes.length <= 2}
                  title={locked ? "Locked scene" : scenes.length <= 2 ? "A video needs at least 2 scenes" : "Delete scene (ripple)"}
                  onClick={(e) => { e.stopPropagation(); if (!locked) delAt(i); }}
                ><Trash2 size={13} strokeWidth={2} /></button>
              </div>

              {/* spoken line: clickable words when cues exist, else seek scene start */}
              {cues && (
                <div className="tr-words" onClick={(e) => e.stopPropagation()}>
                  {cues.map((w, wi) => (
                    <button key={wi} className="tr-word" title={`seek to "${w.word}"`} onClick={() => seekToFrame(w.fromF)}>{w.word}</button>
                  ))}
                </div>
              )}

              <textarea
                className="input tr-say"
                rows={2}
                placeholder="Spoken line (voiceover)…"
                value={sc.say ?? ""}
                readOnly={locked}
                disabled={locked}
                onClick={(e) => e.stopPropagation()}
                onChange={(e) => { if (!locked) patch(i, { say: e.target.value }); }}
              />
              <textarea
                className="input tr-text"
                rows={1}
                placeholder="On-screen text…"
                value={primaryText(sc)}
                readOnly={locked}
                disabled={locked}
                onClick={(e) => e.stopPropagation()}
                onChange={(e) => { if (locked) return; setScenes((ss) => ss.map((x, j) => (j === i ? setPrimaryText(x, e.target.value) : x))); }}
              />
            </div>
          );
        })}
      </div>

      <div className="tr-hint">
        <Mic size={13} strokeWidth={2} />
        <span>Edit the spoken text, then <b>Save &amp; Render</b> — we regenerate the voiceover from your corrected words. (Descript can only re-cut existing audio.)</span>
      </div>
    </div>
  );
}
