/* ─── P5 — BEAT-SYNC (owns the SHARED downbeat snapper) ──────────────────────
   WORLD-CLASS-EDITING §3 "Beat-sync". After the music bed is set (edit-music →
   item.musicSrc) and beats are derived, snap the V1 montage/tighten clip START
   boundaries — and the punch-ins pillar's zoom "final frame" — to the nearest
   musical DOWNBEAT, 1–2 frames BEFORE the beat (anticipation lead). A pure,
   schema-respecting POST-PASS over an already-built footage timeline: each clip's
   SOURCE window [inSec,outSec) is PRESERVED so render.ts sourceToTimelineSec
   re-anchors every caption word automatically (zero caption-pillar changes).

   THIS module is the SOLE owner of the shared downbeat grid (roadmap §3 Conflict
   B): `snapFrameToDownbeat` / `resolveDownbeats` / `ANTICIPATION_FRAMES`. The
   punch-ins pillar (emphasis-zoom.ts) and the pacing governor IMPORT these so
   cuts and zoom peaks share ONE grid and ONE 2-frame anticipation lead. FAIL-OPEN
   throughout: no detectable beat ⇒ the cut is left unchanged. */

import type { Clip, ContentItem, Timeline } from "@os/schemas";
import { loadItem, nowIso, saveItem, warn } from "../store.ts";
import { musicBeatFrames } from "../media.ts";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REMOTION_PUBLIC = join(HERE, "..", "..", "..", "remotion", "public");
const SCRIPTS = join(HERE, "..", "..", "scripts");
const VENV_PY = join(HERE, "..", "..", "..", "..", ".venv-music", "bin", "python");
const round2 = (n: number) => Math.round(n * 100) / 100;

export const ANTICIPATION_FRAMES = 2; // §3: place the cut/zoom 1–2 frames BEFORE the beat
export const MIN_CLIP_FRAMES = (fps: number) => Math.round(0.6 * fps); // mirror montage perClipMinSec

/** §3 BPM→cut-density gate. Returns how many beats between cuts + a target sec/cut. */
export function cutDensityFor(bpm: number | undefined, fps = 30): { beatsPerCut: number; targetSecPerCut: number } {
  const b = bpm && bpm >= 60 && bpm <= 180 ? bpm : 0;
  const fpb = b ? (fps * 60) / b : 0;
  let beatsPerCut = 4; // <100 or unknown ⇒ snap to downbeats only
  if (b >= 140) beatsPerCut = 1;
  else if (b >= 120) beatsPerCut = 2;
  else if (b >= 100) beatsPerCut = 2;
  const targetSecPerCut = fpb ? round2((fpb * beatsPerCut) / fps) : 4;
  return { beatsPerCut, targetSecPerCut };
}

export function gradeCutDensity(
  clipDursSec: number[],
  bpm: number | undefined,
  fps = 30,
): { grade: "undercut" | "on-target" | "overcut"; note: string } {
  const n = clipDursSec.length;
  if (!n) return { grade: "on-target", note: "no clips" };
  const mean = clipDursSec.reduce((s, d) => s + d, 0) / n;
  const { targetSecPerCut } = cutDensityFor(bpm, fps);
  // §3: hard-fail static >8s; ceiling 7 changes/10s ≈ >0.7s mean is fine.
  if (mean > 8 || mean > targetSecPerCut * 2.5)
    return { grade: "undercut", note: `mean clip ${round2(mean)}s vs target ${targetSecPerCut}s — too slow` };
  if (mean < Math.max(0.7, targetSecPerCut * 0.4))
    return { grade: "overcut", note: `mean clip ${round2(mean)}s — strobing, ease off` };
  return { grade: "on-target", note: `mean clip ${round2(mean)}s vs target ${targetSecPerCut}s` };
}

/** Resolve the DOWNBEAT grid (frames) of the run's playing bed. Fail-open ⇒ []. */
export function resolveDownbeats(item: ContentItem, fps = 30): { downbeats: number[]; bpm?: number } {
  const musicSrc = (item as { musicSrc?: string }).musicSrc;
  let beatF: number[] = [];
  let bpm: number | undefined;
  if (musicSrc && existsSync(join(REMOTION_PUBLIC, musicSrc))) {
    beatF = musicBeatFrames(musicSrc, fps); // FRAMES, from beat-times.py
    bpm = beatTimesBpm(join(REMOTION_PUBLIC, musicSrc));
  }
  if (!beatF.length) {
    const mb = item.understanding?.music?.beats ?? [];
    beatF = mb.map((s) => Math.round(s * fps));
    bpm = bpm ?? item.understanding?.music?.tempoBpm;
  }
  if (!beatF.length) return { downbeats: [] };
  const { beatsPerCut } = cutDensityFor(bpm, fps);
  const downbeats: number[] = [];
  for (let i = 0; i < beatF.length; i += beatsPerCut) downbeats.push(beatF[i]);
  return { downbeats, bpm };
}

function beatTimesBpm(abs: string): number | undefined {
  if (!existsSync(VENV_PY)) return undefined;
  const r = spawnSync(VENV_PY, [join(SCRIPTS, "beat-times.py"), abs], { encoding: "utf8", timeout: 60000 });
  if (r.status !== 0) return undefined;
  try {
    const b = (JSON.parse(r.stdout) as { bpm?: number }).bpm;
    return b && b > 0 ? b : undefined;
  } catch {
    return undefined;
  }
}

/** THE SHARED SNAPPER — used by THIS pillar AND the punch-ins/governor pillars.
 *  Returns the nearest downbeat frame to `frame` within ±0.5 bar, MINUS the
 *  anticipation lead (so the event lands just BEFORE the beat). Out of window ⇒
 *  the input frame. Idempotency guard (roadmap §3 Conflict E): the anticipation
 *  lead is only applied when the snap actually MOVES the frame by more than the
 *  lead, so re-running on an already-snapped frame doesn't creep 2 frames/run. */
export function snapFrameToDownbeat(frame: number, downbeats: number[], fps = 30, bpm?: number): number {
  if (!downbeats.length) return frame;
  const fpb = bpm && bpm >= 60 && bpm <= 180 ? (fps * 60) / bpm : 0;
  const { beatsPerCut } = cutDensityFor(bpm, fps);
  const win = fpb ? fpb * beatsPerCut * 0.5 : Infinity; // half a bar
  let best = frame;
  let bestD = Infinity;
  for (const d of downbeats) {
    const dd = Math.abs(d - frame);
    if (dd < bestD) {
      bestD = dd;
      best = d;
    }
  }
  if (bestD > win) return frame; // too far ⇒ keep the editorial position
  // Idempotency guard: only apply the lead when we'd move more than the lead.
  // If `frame` is already at (downbeat - lead), bestD === ANTICIPATION_FRAMES and
  // we leave it put — so repeated passes don't drift earlier each run.
  if (bestD <= ANTICIPATION_FRAMES) return frame;
  return Math.max(0, best - ANTICIPATION_FRAMES);
}

export const snapSecToDownbeat = (sec: number, downbeats: number[], fps = 30, bpm?: number): number =>
  snapFrameToDownbeat(Math.round(sec * fps), downbeats, fps, bpm) / fps;

/** Snap the V1 cut boundaries of an already-built footage timeline to downbeats.
 *  Source windows are PRESERVED (captions remap at render); only the PREVIOUS
 *  clip's played length (durationSec) is adjusted so the NEXT clip lands on the
 *  anticipated downbeat, then startSecs are recomputed cumulatively. Fail-open. */
export function beatSyncTimeline(id: string): {
  timeline: Timeline;
  snapped: number;
  bpm?: number;
  grade: ReturnType<typeof gradeCutDensity>;
} {
  const item = loadItem(id);
  const tl = item.timeline;
  const fps = tl?.fps ?? item.source?.probe?.video?.fps ?? 30;
  const v1 = tl?.tracks.find((t) => t.id === "V1" && t.kind === "video");
  if (!tl || tl.seededFrom !== "footage" || !v1 || (v1.clips?.length ?? 0) < 2) {
    const grade = gradeCutDensity(
      (v1?.clips ?? []).map((c) => c.durationSec ?? 0),
      item.understanding?.music?.tempoBpm,
      fps,
    );
    return { timeline: tl ?? { tracks: [], markers: [] }, snapped: 0, grade };
  }
  const { downbeats, bpm } = resolveDownbeats(item, fps);
  const clips = [...v1.clips].sort((a, b) => (a.startSec ?? 0) - (b.startSec ?? 0));
  if (!downbeats.length) {
    warn(item, "beatsync", "no_beats", "no detectable downbeats — cut left unchanged");
    return { timeline: tl, snapped: 0, grade: gradeCutDensity(clips.map((c) => c.durationSec ?? 0), bpm, fps) };
  }
  const minF = MIN_CLIP_FRAMES(fps);
  let cursorF = 0;
  let snapped = 0;
  const out: Clip[] = [];
  for (let i = 0; i < clips.length; i++) {
    const c = { ...clips[i] };
    if (i === 0) {
      c.startSec = 0;
      cursorF = Math.round((c.durationSec ?? 0) * fps);
      out.push(c);
      continue;
    }
    if (c.locked) {
      c.startSec = round2(cursorF / fps);
      cursorF += Math.round((c.durationSec ?? 0) * fps);
      out.push(c);
      continue;
    }
    // snap WHERE this clip begins → adjust the PREVIOUS clip's tail.
    const desiredStartF = snapFrameToDownbeat(cursorF, downbeats, fps, bpm);
    if (desiredStartF !== cursorF) {
      const prev = out[out.length - 1];
      const prevDurF = Math.round((prev.durationSec ?? 0) * fps);
      const newPrevDurF = prevDurF + (desiredStartF - cursorF);
      const srcRoomF = Math.round((((prev.outSec ?? Infinity) - (prev.inSec ?? 0)) / (prev.speed ?? 1)) * fps);
      if (newPrevDurF >= minF && newPrevDurF <= srcRoomF) {
        prev.durationSec = round2(newPrevDurF / fps);
        if (prev.outSec != null) prev.outSec = round2((prev.inSec ?? 0) + (newPrevDurF / fps) * (prev.speed ?? 1));
        cursorF = desiredStartF;
        snapped++;
      }
    }
    c.startSec = round2(cursorF / fps);
    cursorF += Math.round((c.durationSec ?? 0) * fps);
    out.push(c);
  }
  v1.clips = out;
  // A1 audio + CAP1 are remapped at RENDER from V1 (render.ts sourceToTimelineSec),
  // so we only rewrite V1 here. But if an A1 mirror track exists (montage builds one),
  // realign its clip startSecs to the snapped V1 so the mux stays in lockstep.
  realignAudioToV1(tl, out);
  tl.compiledAt = nowIso();
  item.timeline = tl;
  item.updatedAt = nowIso();
  saveItem(item);
  const grade = gradeCutDensity(out.map((c) => c.durationSec ?? 0), bpm, fps);
  warn(
    item,
    "beatsync",
    "ok",
    `snapped ${snapped} cut(s) to ${bpm ? bpm + "bpm" : "unknown-bpm"} downbeats — ${grade.note}`,
  );
  return { timeline: tl, snapped, bpm, grade };
}

function realignAudioToV1(tl: Timeline, v1: Clip[]): void {
  const a1 = tl.tracks.find((t) => t.kind === "audio");
  if (!a1 || a1.clips.length !== v1.length) return; // only the montage 1:1 mirror
  a1.clips = a1.clips.map((a, i) => ({ ...a, startSec: v1[i].startSec, outSec: v1[i].outSec, durationSec: v1[i].durationSec }));
}
