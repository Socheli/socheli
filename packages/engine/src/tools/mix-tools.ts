import { z } from "zod";

import { type PipelineTool, ok, tool } from "./helpers.ts";
import { loadItem, saveItem, logLine } from "../store.ts";

/**
 * mix-tools.ts — the Fairlight-grade mixing-desk tool surface (DaVinci spine
 * §4.3, M8). Spread into the canonical registry (registry.ts pipelineTools) so
 * MCP / HTTP / CLI / SDK / the dashboard copilot (Soli) all get the desk for free.
 *
 * M7 built the ffmpeg filtergraph (a track's eq/comp/deess/gate/denoise/pan are
 * pre-baked before the file reaches <Audio>). M8 makes the schema audio chain +
 * automation AUTHORABLE by hand: `mix_set_track` writes a named track's
 * channel-strip + gain/pan automation, `mix_clip_gain` drops a per-region gain
 * curve, `mix_duck` sets the sidechain duck, `mix_loudness` the master target.
 * The render then evaluates gain/pan automation in-frame (Post.tsx evalAutomation)
 * and bakes the spectral/dynamics chain in ffmpeg (media.ts buildAudioFiltergraph).
 *
 * Shape note: ok/tool come from the leaf helpers module (NOT registry.ts) so there
 * is no import cycle — mirrors timeline-tools.ts exactly. Every write is SYNCHRONOUS
 * (loadItem → mutate item.mix → saveItem), CLAMPED to the schema band, LOCKED-safe
 * (a track/clip marked `locked` is never mutated) and never throws (tool()'s own
 * try/catch maps any error to fail()).
 */

const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n));
const idArg = z.string().min(1).describe("ContentItem/run id (e.g. concept_20260610034331)");
const trackIdArg = z.enum(["music", "voice", "sfx"]).describe("which audio track to address");

// A keyframed automation curve (mirrors @os/schemas AutoCurve). Validated +
// clamped before persist: at least one point, t∈0..1, finite v.
const autoCurveArg = z
  .object({
    points: z.array(z.object({ t: z.number().min(0).max(1), v: z.number() })).min(1).max(32),
    easing: z.enum(["linear", "easeIn", "easeOut", "easeInOut", "hold"]).optional(),
  })
  .describe("keyframed curve: points[{t:0..1, v}] + optional easing");

// One parametric EQ band (clamped to the AudioBand schema band).
const bandArg = z.object({
  freq: z.number().min(20).max(20000),
  gain: z.number().min(-24).max(24),
  q: z.number().min(0.1).max(10).optional(),
  type: z.enum(["peak", "lowshelf", "highshelf", "lowpass", "highpass", "notch"]).optional(),
});

/** Normalize + clamp a curve before persist (sorts points, clamps t, drops NaN). */
function cleanCurve(c?: z.infer<typeof autoCurveArg>) {
  if (!c) return undefined;
  const points = [...c.points]
    .filter((p) => Number.isFinite(p.t) && Number.isFinite(p.v))
    .map((p) => ({ t: clamp(p.t, 0, 1), v: p.v }))
    .sort((a, b) => a.t - b.t);
  if (!points.length) return undefined;
  return { points, easing: c.easing ?? "easeInOut" };
}

/** Find (or create) a named track in item.mix.tracks. Returns null if the existing
 *  track is locked (locked-safe — the caller reports "skipped"). */
function trackSlot(mix: any, id: string): { tracks: any[]; idx: number; track: any } | null {
  const tracks = Array.isArray(mix.tracks) ? [...mix.tracks] : [];
  const idx = tracks.findIndex((t: any) => t?.id === id);
  if (idx >= 0 && tracks[idx]?.locked) return null;
  const track = idx >= 0 ? { ...tracks[idx] } : { id };
  return { tracks, idx, track };
}

export const mixTools: PipelineTool[] = [
  tool({
    name: "mix_set_track",
    description:
      "Set a named track's (music/voice/sfx) channel-strip + automation on item.mix.tracks[]. Any subset of: eq (parametric bands), comp (downward compressor), gate (noise gate), deess (sibilance), denoise (de-hiss), gain (keyframed track-gain AutoCurve), pan (keyframed pan AutoCurve, -1..1), plus the scalar vol/pan/fadeIn/fadeOut/mute. Each spectral/dynamics block is BAKED by the ffmpeg filtergraph (media.ts) before <Audio>; gain/pan automation is evaluated in-frame by the renderer. Every value is CLAMPED to its schema band; a LOCKED track is left untouched (returns skipped). Merges over the existing track — fields you omit are preserved. Returns the persisted track.",
    kind: "mutate",
    schema: z
      .object({
        id: idArg,
        track: trackIdArg,
        vol: z.number().min(0).max(3).optional(),
        pan: z.number().min(-1).max(1).optional(),
        mute: z.boolean().optional(),
        fadeIn: z.number().min(0).max(10).optional(),
        fadeOut: z.number().min(0).max(10).optional(),
        eq: z.array(bandArg).max(8).optional(),
        comp: z
          .object({
            threshold: z.number().min(-60).max(0).optional(),
            ratio: z.number().min(1).max(20).optional(),
            attack: z.number().min(0).max(500).optional(),
            release: z.number().min(0).max(2000).optional(),
            makeup: z.number().min(0).max(24).optional(),
          })
          .optional(),
        gate: z
          .object({
            threshold: z.number().min(-80).max(0).optional(),
            attack: z.number().min(0).max(500).optional(),
            release: z.number().min(0).max(2000).optional(),
          })
          .optional(),
        deess: z.object({ freq: z.number().min(2000).max(12000).optional(), amount: z.number().min(0).max(1).optional() }).optional(),
        denoise: z.object({ amount: z.number().min(0).max(1).optional() }).optional(),
        gain: autoCurveArg.optional(),
        pan_auto: autoCurveArg.optional().describe("keyframed pan automation (the panAuto curve)"),
      })
      .strict(),
    run: (a) => {
      const item = loadItem(a.id);
      const mix: any = { ...(item.mix ?? {}) };
      const slot = trackSlot(mix, a.track);
      if (!slot) return ok({ id: a.id, track: a.track, skipped: true }, `track ${a.track} is locked — skipped`);
      const t = slot.track;
      const set: string[] = [];

      if (a.vol != null) { t.vol = clamp(a.vol, 0, 3); set.push("vol"); }
      if (a.pan != null) { t.pan = clamp(a.pan, -1, 1); set.push("pan"); }
      if (a.mute != null) { t.mute = !!a.mute; set.push("mute"); }
      if (a.fadeIn != null) { t.fadeIn = clamp(a.fadeIn, 0, 10); set.push("fadeIn"); }
      if (a.fadeOut != null) { t.fadeOut = clamp(a.fadeOut, 0, 10); set.push("fadeOut"); }
      if (a.eq) {
        t.eq = a.eq.slice(0, 8).map((b: any) => ({
          freq: clamp(b.freq, 20, 20000),
          gain: clamp(b.gain, -24, 24),
          q: clamp(b.q ?? 1, 0.1, 10),
          type: b.type ?? "peak",
        }));
        set.push(`${t.eq.length}-band EQ`);
      }
      if (a.comp) {
        t.comp = {
          threshold: clamp(a.comp.threshold ?? -18, -60, 0),
          ratio: clamp(a.comp.ratio ?? 3, 1, 20),
          attack: clamp(a.comp.attack ?? 20, 0, 500),
          release: clamp(a.comp.release ?? 150, 0, 2000),
          ...(a.comp.makeup != null ? { makeup: clamp(a.comp.makeup, 0, 24) } : {}),
        };
        set.push("comp");
      }
      if (a.gate) {
        t.gate = {
          threshold: clamp(a.gate.threshold ?? -40, -80, 0),
          attack: clamp(a.gate.attack ?? 10, 0, 500),
          release: clamp(a.gate.release ?? 120, 0, 2000),
        };
        set.push("gate");
      }
      if (a.deess) { t.deess = { freq: clamp(a.deess.freq ?? 6500, 2000, 12000), amount: clamp(a.deess.amount ?? 0.4, 0, 1) }; set.push("de-ess"); }
      if (a.denoise) { t.denoise = { amount: clamp(a.denoise.amount ?? 0.3, 0, 1) }; set.push("denoise"); }
      const g = cleanCurve(a.gain); if (g) { t.gain = g; set.push("gain auto"); }
      const pa = cleanCurve(a.pan_auto); if (pa) { t.panAuto = { ...pa, points: pa.points.map((p: any) => ({ t: p.t, v: clamp(p.v, -1, 1) })) }; set.push("pan auto"); }

      if (!set.length) return ok({ id: a.id, track: a.track, changed: false }, "nothing to set");
      if (slot.idx >= 0) slot.tracks[slot.idx] = t; else slot.tracks.push(t);
      mix.tracks = slot.tracks;
      item.mix = mix;
      logLine(item, `mix: track ${a.track} ← ${set.join(", ")}`);
      saveItem(item);
      return ok({ id: a.id, track: t }, `track ${a.track}: ${set.join(", ")}`);
    },
  }),

  tool({
    name: "mix_clip_gain",
    description:
      "Drop a per-CLIP gain automation region on item.mix.clips[]: a keyframed gain AutoCurve scoped to one track over a [startSec, startSec+durSec) window (durSec omitted ⇒ runs to track end). This is how 'let it breathe HERE' becomes a real dip — the renderer (Post.tsx evalAutomation) multiplies the curve over that track's frames inside the window only. The curve's t∈0..1 maps over the window. CLAMPED + LOCKED-safe (a clip with locked:true at the same start is left untouched). Replaces an existing clip on the same track+start, else appends. Returns the clip.",
    kind: "mutate",
    schema: z
      .object({
        id: idArg,
        track: trackIdArg,
        startSec: z.number().min(0),
        durSec: z.number().min(0).optional(),
        gain: autoCurveArg,
      })
      .strict(),
    run: (a) => {
      const item = loadItem(a.id);
      const mix: any = { ...(item.mix ?? {}) };
      const gain = cleanCurve(a.gain);
      if (!gain) return ok({ id: a.id, changed: false }, "empty curve — nothing written");
      const clips = Array.isArray(mix.clips) ? [...mix.clips] : [];
      const startSec = Math.max(0, a.startSec);
      const exIdx = clips.findIndex((c: any) => c?.trackId === a.track && Math.abs(Number(c?.startSec ?? -1) - startSec) < 0.01);
      if (exIdx >= 0 && clips[exIdx]?.locked) return ok({ id: a.id, skipped: true }, "clip at that start is locked — skipped");
      const clip: any = { trackId: a.track, startSec, ...(a.durSec != null ? { durSec: Math.max(0, a.durSec) } : {}), gain };
      if (exIdx >= 0) clips[exIdx] = clip; else clips.push(clip);
      mix.clips = clips;
      item.mix = mix;
      logLine(item, `mix: clip gain on ${a.track} @ ${startSec}s (${gain.points.length} pt)`);
      saveItem(item);
      return ok({ id: a.id, clip }, `clip gain on ${a.track} @ ${startSec}s`);
    },
  }),

  tool({
    name: "mix_duck",
    description:
      "Set the music sidechain duck (item.mix.duck): drop the music bed while narration plays. amount 0..1 (how far to duck), attack/release in seconds. The shorts renderer ramps a word-accurate envelope in-frame; long-form bakes the SAME word-span envelope in ffmpeg (media.ts) — both paths share the duck-span module so they duck identically. Pass enabled:false to turn it off. CLAMPED. Returns the duck settings.",
    kind: "mutate",
    schema: z
      .object({
        id: idArg,
        enabled: z.boolean().optional(),
        amount: z.number().min(0).max(1).optional(),
        attack: z.number().min(0).max(2).optional(),
        release: z.number().min(0).max(3).optional(),
      })
      .strict(),
    run: (a) => {
      const item = loadItem(a.id);
      const mix: any = { ...(item.mix ?? {}) };
      const prev: any = mix.duck ?? {};
      const duck: any = {
        enabled: a.enabled != null ? !!a.enabled : prev.enabled ?? true,
        amount: clamp(a.amount ?? prev.amount ?? 0.6, 0, 1),
        attack: clamp(a.attack ?? prev.attack ?? 0.12, 0, 2),
        release: clamp(a.release ?? prev.release ?? 0.35, 0, 3),
      };
      mix.duck = duck;
      item.mix = mix;
      logLine(item, `mix: duck ${duck.enabled ? `on (amount ${duck.amount.toFixed(2)})` : "off"}`);
      saveItem(item);
      return ok({ id: a.id, duck }, `duck ${duck.enabled ? `on (amount ${duck.amount.toFixed(2)})` : "off"}`);
    },
  }),

  tool({
    name: "mix_loudness",
    description:
      "Set the integrated-LUFS master target (item.mix.loudnessTarget) the ffmpeg loudness master normalizes to (render.ts masterAudio / addMusicBed). Typical: -14 (YouTube/IG/TikTok), -16 (podcast/spoken), -23 (broadcast). CLAMPED to a sane -30..-6 LUFS band. Returns the target.",
    kind: "mutate",
    schema: z.object({ id: idArg, lufs: z.number() }).strict(),
    run: (a) => {
      const item = loadItem(a.id);
      const lufs = clamp(a.lufs, -30, -6);
      item.mix = { ...(item.mix ?? {}), loudnessTarget: lufs };
      logLine(item, `mix: loudness target → ${lufs} LUFS`);
      saveItem(item);
      return ok({ id: a.id, loudnessTarget: lufs }, `loudness target → ${lufs} LUFS`);
    },
  }),
];
