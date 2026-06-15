import type { PassRecord, EditingTaste, EffectGraph, EffectNode, ContentItem } from "@os/schemas";
import { z } from "zod";

import { loadItem, saveItem, nowIso, logLine } from "../store.ts";
import { callEditorTool } from "../editor-tools.ts";
import { buildCompFromIntents } from "./edl.ts";
import { loadTaste, learnTaste } from "./taste.ts";
import { genomeContextSafe } from "../dna.ts";
import { EffectGraph as EffectGraphSchema } from "@os/schemas";

/* creative/compositing-pass.ts — the CLOSED-LOOP compositor (DaVinci spine §4.4, M15).
 *
 * Built to MIRROR the M5 color pass and M9 audio pass exactly, for COMPOSITING.
 * Where the colorist reads ffmpeg scopes and the mixer reads ebur128 meters, the
 * compositor PERCEIVES the cut through `editor_video_evidence` (dense frames +
 * per-frame pixel metrics + motion deltas + OCR) — the same perception substrate
 * the roadmap calls "the compositor's eyes". It then DIAGNOSES, per scene, where a
 * premium look is measurably lacking and PROPOSES a RESTRAINED EffectGraph onto
 * scene.style.comp (per-scene) / storyboard.comp (a global wash), clamped + locked-
 * safe, learning durable look prefs into EditingTaste.
 *
 * The four measured deficiencies it composites AGAINST (grounded, never blind — a
 * node is proposed only where the pixels show a deficiency):
 *
 *   1. FLAT / EMPTY FRAME — a scene with low edge activity AND a flat motion delta
 *      (nothing happening visually) reads as dead. A subtle BLOOM (+ a whisper of
 *      glow on a hero beat) gives it dimension. Low opacities only.
 *   2. BUSY BACKGROUND vs TEXT — a scene that carries on-screen text (OCR found
 *      lines) over a high-edge / bright background hurts caption legibility. A
 *      gentle VIGNETTE (+ a darkening scrim implied by the vignette) sits the text
 *      forward without touching the type itself (that's typography's job).
 *   3. HERO BEAT WANTS LIFT — an emphasis/peak scene that's visually inert wants a
 *      restrained LIGHT-LEAK accent (a single warm sweep), never on every beat.
 *   4. SUBJECT WANTS ISOLATION — a scene with strong central contrast against a
 *      busy/bright surround (subject lost in the frame) wants a soft centre mask +
 *      a low glow to lift the subject. CSS keying is approximate (flagged) — a true
 *      key routes to comp_prebake (M18), not here.
 *
 * RESTRAINT IS LOAD-BEARING. The brand is premium/minimal, so: DNA-/taste-biased
 * defaults, low opacities, a hard cap on how many scenes get touched per run, never
 * stacking a garish look. Every proposal is expressed as `visualIntent` prose run
 * through the DETERMINISTIC `buildCompFromIntents` compiler (the SAME schema-real,
 * clamped, locked-safe bridge the EDL uses) — so the pass cannot author a node the
 * bridge wouldn't, and a re-run is idempotent. The whole pass FAILS OPEN: no
 * evidence (no render / no ffmpeg) → a tasteful DNA-default global wash or a no-op,
 * never a throw.
 *
 * verify=true re-perceives the evidence after writing and ROLLS BACK any scene
 * whose measured deficiency got WORSE (skip-on-worsen), capped at a couple of
 * iterations — mirroring the audio pass. (Like color/audio, the written comp only
 * changes pixels on a RE-RENDER; without one the re-read reflects the same frames,
 * reported transparently.) */

/* ─── Restraint constants (the premium-minimal guardrails) ───────────────────
   These are the bands the compositor stays inside no matter what the evidence
   says — the roadmap's "over-authored graphs → muddy look" risk, mitigated by
   construction. Opacities are deliberately low; the touch budget keeps a cut from
   getting a look on every scene. */
const MAX_SCENES_TOUCHED = 4;        // never composite more than this many scenes/run (restraint)
const BLOOM_MAX = 0.34;              // a flat-frame bloom never goes garish
const GLOW_MAX = 0.42;
const VIGNETTE_MAX = 0.4;
const LEAK_MAX = 0.4;

// Deficiency thresholds read off the per-frame pixel metrics + motion deltas.
const FLAT_EDGE_PCT = 4.0;           // edgePct below this = a visually flat frame
const FLAT_MOTION = 0.012;           // motionDelta below this = little is moving
const BUSY_EDGE_PCT = 9.0;           // edgePct above this = a busy background (text legibility risk)
const BUSY_BRIGHT_PCT = 14.0;        // brightPct above this = a bright background under text
const SUBJECT_CONTRAST = 1.2;        // central contrastBalance above this = a strong subject present
const SUBJECT_SURROUND_EDGE = 8.0;   // with this much surrounding edge = subject competing with bg

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
const round3 = (n: number) => Number(n.toFixed(3));

function safeLoadTaste(channel: string): EditingTaste | null {
  try {
    return loadTaste(channel);
  } catch {
    return null;
  }
}

/* ─── The per-scene evidence the compositor judges ───────────────────────────
   Aggregated from the dense `editor_video_evidence` entries that fall inside a
   scene: the median edge/bright/dark/central-contrast pixel metrics, the average
   motion delta, and whether OCR found rendered text (→ this scene carries
   captions, so legibility matters). Every field fail-opens to a neutral value. */
type SceneVisual = {
  sceneIndex: number;
  emphasis: boolean;
  edgePct: number;
  brightPct: number;
  darkPct: number;
  contrastBalance: number;
  unsafeBrightPct: number;
  avgMotion: number;
  hasText: boolean;
  frames: number;
};

function median(xs: number[]): number {
  const a = xs.filter((n) => Number.isFinite(n)).sort((x, y) => x - y);
  if (!a.length) return NaN;
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

/* Read editor_video_evidence and fold its dense per-frame entries into a per-scene
   visual table. Fail-open: any failure → an empty list (the pass then degrades to
   a DNA default / no-op). Uses a coarse sampleFps + no transcription (we only need
   pixels/OCR, not audio) so the perception is cheap. */
function perceiveScenes(id: string, item: ContentItem): { scenes: SceneVisual[]; available: boolean; note: string } {
  let report: any = null;
  try {
    const res = callEditorTool("editor_video_evidence", {
      id,
      sampleFps: 1,
      width: 320,
      maxOcrFrames: 40,
      transcribe: false, // compositing needs frames + OCR, not the transcript
    });
    if (!res.ok) return { scenes: [], available: false, note: res.message ?? "no video evidence" };
    const data: any = res.data;
    report = data?.report ?? data;
  } catch (e) {
    return { scenes: [], available: false, note: e instanceof Error ? e.message : String(e) };
  }

  const entries: any[] = Array.isArray(report?.entries) ? report.entries : [];
  if (!entries.length) return { scenes: [], available: false, note: "no frame entries in evidence" };

  // Group entries by their scene index, then reduce to robust medians.
  const byScene = new Map<number, any[]>();
  for (const e of entries) {
    const idx = e?.scene?.index;
    if (!Number.isInteger(idx)) continue;
    let bucket = byScene.get(idx);
    if (!bucket) byScene.set(idx, (bucket = []));
    bucket.push(e);
  }

  const sbScenes: any[] = item.storyboard?.scenes ?? [];
  const scenes: SceneVisual[] = [];
  for (const [sceneIndex, es] of byScene) {
    const pm = (k: string) => median(es.map((e) => Number(e?.pixelMetrics?.[k])));
    const hasText = es.some((e) => {
      const ocr = e?.ocr;
      return ocr?.sampled && typeof ocr.text === "string" && ocr.text.trim().length > 1;
    });
    const avgMotion = median(es.map((e) => Number(e?.motionDelta)));
    scenes.push({
      sceneIndex,
      emphasis: !!sbScenes[sceneIndex]?.emphasis,
      edgePct: Number.isFinite(pm("edgePct")) ? pm("edgePct") : 6,
      brightPct: Number.isFinite(pm("brightPct")) ? pm("brightPct") : 6,
      darkPct: Number.isFinite(pm("darkPct")) ? pm("darkPct") : 6,
      contrastBalance: Number.isFinite(pm("contrastBalance")) ? pm("contrastBalance") : 0.5,
      unsafeBrightPct: Number.isFinite(pm("unsafeBrightPct")) ? pm("unsafeBrightPct") : 0,
      avgMotion: Number.isFinite(avgMotion) ? avgMotion : 0.05,
      hasText,
      frames: es.length,
    });
  }
  scenes.sort((a, b) => a.sceneIndex - b.sceneIndex);
  return { scenes, available: true, note: `${scenes.length} scene(s) perceived from ${entries.length} frame(s)` };
}

/* DNA/taste-biased restraint multiplier: a brand whose learned look leans
   "minimal / restrained / clean" composites EVEN gentler; a brand that learned a
   "cinematic / filmic / moody" look tolerates a touch more. Read from the channel's
   taste prefs (palette) + genome prose, clamped to a tight band so it can only nudge
   the defaults, never blow them out. Default 1.0 (the already-restrained baseline). */
function restraintBias(channel: string | undefined): { mul: number; lean: string } {
  if (!channel) return { mul: 1, lean: "default" };
  const taste = safeLoadTaste(channel);
  const palette = String(taste?.prefs?.palette ?? "").toLowerCase();
  const genome = (() => {
    try {
      return genomeContextSafe(channel).toLowerCase();
    } catch {
      return "";
    }
  })();
  const blob = `${palette} ${genome}`;
  if (/\b(minimal|restrained|clean|flat|understated|subtle)\b/.test(blob)) return { mul: 0.8, lean: "minimal — composite gentler" };
  if (/\b(cinematic|filmic|moody|dramatic|grainy|vintage|film burn)\b/.test(blob)) return { mul: 1.15, lean: "cinematic — a touch more allowed" };
  return { mul: 1, lean: "balanced" };
}

/* ─── diagnose → propose: the compositor's judgment per scene ─────────────────
   From a scene's measured visual + the restraint bias, decide the SINGLE most
   warranted compositing move (we never stack multiple looks on one scene — one
   premium touch, not a pile). Returns a `visualIntent` prose clause (compiled
   deterministically by buildCompFromIntents into a clamped graph) + the reason +
   the dominant deficiency name (used by the verify loop). undefined = the scene is
   visually fine; leave it untouched (identity). */
type SceneProposal = { sceneIndex: number; visualIntent: string; reason: string; deficiency: string };

function proposeForScene(s: SceneVisual, mul: number): SceneProposal | undefined {
  // 4) SUBJECT ISOLATION — strong centre subject lost against a busy/bright
  //    surround. Highest priority (it's the most expensive deficiency to a viewer).
  if (s.contrastBalance >= SUBJECT_CONTRAST && s.edgePct >= SUBJECT_SURROUND_EDGE && !s.hasText) {
    return {
      sceneIndex: s.sceneIndex,
      // soft centre isolate + low glow (CSS key is approximate — true key → comp_prebake)
      visualIntent: "isolate the subject with a soft centre and a low glow (CSS key approximate)",
      reason: `subject competing with a busy surround (central contrast ${round3(s.contrastBalance)}, edges ${round3(s.edgePct)}%) → soft isolate + glow`,
      deficiency: "subject_lost",
    };
  }

  // 2) BUSY BACKGROUND under TEXT — a legibility deficiency. A gentle vignette sits
  //    the captions forward without touching the type.
  if (s.hasText && (s.edgePct >= BUSY_EDGE_PCT || s.brightPct >= BUSY_BRIGHT_PCT)) {
    return {
      sceneIndex: s.sceneIndex,
      visualIntent: "vignette frame to sit the on-screen text forward against a busy background",
      reason: `text over a busy/bright bg (edges ${round3(s.edgePct)}%, bright ${round3(s.brightPct)}%) → vignette scrim for legibility`,
      deficiency: "text_legibility",
    };
  }

  // 3) HERO BEAT WANTS LIFT — an emphasis scene that's visually inert. A single warm
  //    light-leak accent (never on every beat — only the marked peak).
  if (s.emphasis && s.avgMotion < FLAT_MOTION * 1.5 && s.edgePct < BUSY_EDGE_PCT) {
    return {
      sceneIndex: s.sceneIndex,
      visualIntent: "dreamy soft glow with a gentle light-leak accent on this hero beat",
      reason: `hero/peak beat is visually inert (motion ${round3(s.avgMotion)}, edges ${round3(s.edgePct)}%) → glow + light-leak lift`,
      deficiency: "flat_hero",
    };
  }

  // 1) FLAT / EMPTY FRAME — low edges AND a flat motion delta. A subtle bloom gives
  //    it dimension. The gentlest, most common touch.
  if (s.edgePct < FLAT_EDGE_PCT && s.avgMotion < FLAT_MOTION) {
    return {
      sceneIndex: s.sceneIndex,
      visualIntent: "make it pop with a subtle bloom to give the flat frame dimension",
      reason: `flat, empty frame (edges ${round3(s.edgePct)}%, motion ${round3(s.avgMotion)}) → subtle bloom`,
      deficiency: "flat_frame",
    };
  }

  return undefined; // visually fine — leave it (identity)
}

/* A measured DEFICIENCY SCORE for a scene (higher = worse) on its dominant axis,
   used by the verify loop's skip-on-worsen guard. Each deficiency reads the metric
   that motivated the proposal so a re-perceive can tell better from worse. */
function deficiencyScore(s: SceneVisual, deficiency: string): number {
  switch (deficiency) {
    case "flat_frame":
      return (FLAT_EDGE_PCT - Math.min(s.edgePct, FLAT_EDGE_PCT)) + (FLAT_MOTION - Math.min(s.avgMotion, FLAT_MOTION)) * 100;
    case "flat_hero":
      return (BUSY_EDGE_PCT - Math.min(s.edgePct, BUSY_EDGE_PCT)) + (FLAT_MOTION * 1.5 - Math.min(s.avgMotion, FLAT_MOTION * 1.5)) * 100;
    case "text_legibility":
      return Math.max(s.edgePct - BUSY_EDGE_PCT, 0) + Math.max(s.brightPct - BUSY_BRIGHT_PCT, 0);
    case "subject_lost":
      return Math.max(s.edgePct - SUBJECT_SURROUND_EDGE, 0) + Math.max(s.contrastBalance - SUBJECT_CONTRAST, 0) * 5;
    default:
      return 0;
  }
}

/* Apply a proposal: compile it through buildCompFromIntents (deterministic, clamped,
   schema-real), then DOWN-SCALE every opacity-like param by the restraint bias and
   clamp to the premium-minimal maxima before writing scene.style.comp. Locked scene
   → skipped. Returns the persisted graph or null (nothing survived / locked). */
function applyProposal(id: string, p: SceneProposal, mul: number): { graph: z.infer<typeof EffectGraph> | null; note: string } {
  const item = loadItem(id);
  const scene: any = item.storyboard?.scenes?.[p.sceneIndex];
  if (!scene) return { graph: null, note: `scene ${p.sceneIndex} not found` };
  if (scene.locked) return { graph: null, note: `scene ${p.sceneIndex}: locked — skipped` };

  // Compile prose → graph via the ONE bridge (same compiler the EDL uses).
  const raw = buildCompFromIntents({ visualIntent: p.visualIntent, emphasis: scene.emphasis }, undefined);
  if (!raw || !raw.nodes.length) return { graph: null, note: `scene ${p.sceneIndex}: intent produced no graph` };

  // RESTRAINT: scale every opacity/amount param toward the minimal end + clamp to
  // the premium maxima, so the compiled look can never go garish on this brand.
  const restrained = restrainGraph(raw, mul);
  if (!restrained) return { graph: null, note: `scene ${p.sceneIndex}: restrained to identity` };

  scene.style = { ...(scene.style ?? {}), comp: restrained };
  logLine(item, `compositing: scene ${p.sceneIndex} ${p.deficiency} → ${restrained.nodes.length}-node graph`);
  saveItem(item);
  return { graph: restrained, note: p.reason };
}

/* Down-scale + clamp the amount-like params of a compiled graph to the premium-
   minimal band (the restraint guardrail). Re-parsed through EffectGraph so a
   malformed result is dropped (identity). */
function restrainGraph(graph: z.infer<typeof EffectGraph>, mul: number): z.infer<typeof EffectGraph> | undefined {
  const cap: Record<string, number> = { bloom: BLOOM_MAX, glow: GLOW_MAX, vignette: VIGNETTE_MAX, light_leak: LEAK_MAX };
  const nodes: EffectNode[] = graph.nodes.map((n) => {
    const params: Record<string, unknown> = { ...((n.params as Record<string, unknown>) ?? {}) };
    if (typeof params.amount === "number" && Number.isFinite(params.amount)) {
      const ceiling = cap[n.type] ?? 0.5;
      params.amount = round3(clamp((params.amount as number) * mul, 0, ceiling));
    }
    if (typeof params.intensity === "number" && Number.isFinite(params.intensity)) {
      const ceiling = cap[n.type] ?? 0.5;
      params.intensity = round3(clamp((params.intensity as number) * mul, 0, ceiling));
    }
    return { ...n, params };
  });
  try {
    return EffectGraphSchema.parse({ nodes, output: graph.output ?? nodes[nodes.length - 1].id });
  } catch {
    return undefined;
  }
}

/* A DNA-default GLOBAL wash when there's no scene evidence (the pass is still
   usable, fail-open, like color-pass's palette seed): a single whisper-light global
   bloom keyed off the brand's look lean — never a per-scene authored stack, just a
   coherent base. Returns undefined for a minimal brand (it wants NOTHING by
   default) so the pass is a clean no-op there. */
function dnaDefaultGlobal(channel: string | undefined, mul: number, lean: string): z.infer<typeof EffectGraph> | undefined {
  // A minimal brand gets nothing — restraint as the default.
  if (mul <= 0.85) return undefined;
  const amount = round3(clamp(0.18 * mul, 0, BLOOM_MAX));
  if (amount < 0.05) return undefined;
  const src: EffectNode = { id: "src", type: "source", inputs: [] };
  const bloom: EffectNode = { id: "bloom_1", type: "bloom", params: { amount }, inputs: ["src"] };
  try {
    return EffectGraphSchema.parse({ nodes: [src, bloom], output: bloom.id });
  } catch {
    return undefined;
  }
}

export type CompositingPassResult = {
  ok: boolean;
  mode: "closed_loop" | "dna_default" | "noop";
  scenesComposited: number;
  reasons: string[];
  reverted: string[];
  globalGraph: z.infer<typeof EffectGraph> | null;
  notes: string[];
};

/* ─── compositingPass — the closed-loop compositor run ────────────────────────
   Perceive → diagnose per scene → propose the single most-warranted restrained
   look → compile + write (clamped, locked-safe) → optionally re-perceive + roll
   back a worsened scene → learn durable look prefs. Always fail-open. */
export async function compositingPass(id: string, opts: { verify?: boolean } = {}): Promise<CompositingPassResult> {
  const notes: string[] = [];
  const item = loadItem(id);
  const { mul, lean } = restraintBias(item.channel);
  notes.push(`restraint: ${lean} (×${mul})`);

  // ── PERCEIVE. ──
  const perceived = perceiveScenes(id, item);

  // ── No evidence → a DNA-default global wash (or a clean no-op for a minimal
  //    brand). Still usable without a render, mirroring color-pass's palette seed. ──
  if (!perceived.available || !perceived.scenes.length) {
    const global = dnaDefaultGlobal(item.channel, mul, lean);
    if (!global) {
      return { ok: true, mode: "noop", scenesComposited: 0, reasons: [], reverted: [], globalGraph: null, notes: [...notes, `no evidence (${perceived.note}); minimal brand → no default look`] };
    }
    const it = loadItem(id);
    it.storyboard = { ...(it.storyboard ?? {}), comp: global } as any;
    logLine(it, `compositing: DNA-default global wash (no evidence)`);
    saveItem(it);
    return {
      ok: true,
      mode: "dna_default",
      scenesComposited: 0,
      reasons: [`DNA-default global bloom (${lean})`],
      reverted: [],
      globalGraph: global,
      notes: [...notes, `no scene evidence (${perceived.note}); applied a restrained global wash — re-run after a render for the per-scene closed loop`],
    };
  }

  // ── DIAGNOSE → PROPOSE per scene, then keep only the TOP few by deficiency
  //    severity (restraint: never composite more than MAX_SCENES_TOUCHED). ──
  const byIdx = new Map(perceived.scenes.map((s) => [s.sceneIndex, s]));
  const proposals = perceived.scenes
    .map((s) => {
      const p = proposeForScene(s, mul);
      return p ? { p, score: deficiencyScore(s, p.deficiency) } : null;
    })
    .filter((x): x is { p: SceneProposal; score: number } => !!x)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_SCENES_TOUCHED)
    .map((x) => x.p);

  if (!proposals.length) {
    return { ok: true, mode: "noop", scenesComposited: 0, reasons: [], reverted: [], globalGraph: null, notes: [...notes, "every scene reads visually fine — no compositing warranted"] };
  }

  // ── APPLY (clamped, locked-safe, restrained). ──
  const reasons: string[] = [];
  const applied: SceneProposal[] = [];
  for (const p of proposals) {
    const { graph, note } = applyProposal(id, p, mul);
    if (graph) {
      reasons.push(`#${p.sceneIndex}: ${note}`);
      applied.push(p);
    } else {
      notes.push(`#${p.sceneIndex}: ${note}`);
    }
  }

  // ── OPTIONAL VERIFY: re-perceive and ROLL BACK a scene whose deficiency got
  //    worse (skip-on-worsen). The written comp only changes pixels on a RE-RENDER,
  //    so without one this reflects the SAME frames — reported transparently, and a
  //    real regression (e.g. an edit between runs) still rolls back. Capped at one
  //    re-perceive pass (the audio-pass discipline). ──
  const reverted: string[] = [];
  if (opts.verify && applied.length) {
    const after = perceiveScenes(id, item);
    if (after.available && after.scenes.length) {
      const afterByIdx = new Map(after.scenes.map((s) => [s.sceneIndex, s]));
      for (const p of applied) {
        const before = byIdx.get(p.sceneIndex);
        const now = afterByIdx.get(p.sceneIndex);
        if (!before || !now) continue;
        if (deficiencyScore(now, p.deficiency) > deficiencyScore(before, p.deficiency) + 0.5) {
          // worsened → clear this scene's comp (back to identity / legacy path).
          clearSceneComp(id, p.sceneIndex);
          reverted.push(`#${p.sceneIndex}: ${p.deficiency} worsened — reverted`);
        }
      }
      if (!reverted.length) notes.push("verify: no scene regressed");
    } else {
      notes.push("verify: evidence unavailable on re-read (re-render to measure new frames)");
    }
  }

  const scenesComposited = applied.length - reverted.length;

  // ── LEARN durable look prefs into taste (best-effort, fail-open). ──
  if (item.channel && scenesComposited > 0) {
    try {
      await learnChannelLook(item.channel, applied, reverted, lean);
    } catch {
      /* taste learning is best-effort and must never fail the pass */
    }
  }

  logLine(loadItem(id), `compositing: ${scenesComposited}/${proposals.length} scene(s) composited (${lean})${reverted.length ? `, ${reverted.length} reverted` : ""}`);
  return {
    ok: true,
    mode: "closed_loop",
    scenesComposited,
    reasons,
    reverted,
    globalGraph: null,
    notes,
  };
}

/* Clear a scene's comp (back to the legacy render path / identity), locked-safe.
   Used by the verify roll-back. Fail-open. */
function clearSceneComp(id: string, sceneIndex: number): void {
  try {
    const item = loadItem(id);
    const scene: any = item.storyboard?.scenes?.[sceneIndex];
    if (!scene || scene.locked) return;
    if (scene.style) scene.style = { ...scene.style, comp: undefined };
    saveItem(item);
  } catch {
    /* fail-open */
  }
}

/* Compound the channel's durable LOOK preferences into EditingTaste: a "do" rule
   naming the restrained composite this brand's cuts earned, plus a palette pref
   nudge. We deliberately learn into the EXISTING taste rules/prefs (not a new
   schema field) so the lesson grounds the NEXT cut's restraintBias + the prose every
   downstream pass already injects via tasteContext. Mirrors color/audio learn. */
async function learnChannelLook(
  channel: string,
  applied: SceneProposal[],
  reverted: string[],
  lean: string,
): Promise<void> {
  // The dominant deficiency this cut composited against = the durable look lesson.
  const counts = new Map<string, number>();
  const keptDeficiencies = applied
    .filter((p) => !reverted.some((r) => r.includes(`#${p.sceneIndex}:`)))
    .map((p) => p.deficiency);
  for (const d of keptDeficiencies) counts.set(d, (counts.get(d) ?? 0) + 1);
  const dominant = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  if (!dominant) return;

  const ruleByDeficiency: Record<string, string> = {
    flat_frame: "lift flat, empty frames with a subtle bloom — restrained, never garish",
    flat_hero: "give a hero/peak beat a gentle glow + light-leak accent (only the marked peak)",
    text_legibility: "vignette behind on-screen text over a busy background for legibility",
    subject_lost: "softly isolate + glow a subject competing with a busy surround (approximate CSS key)",
  };
  const rule = ruleByDeficiency[dominant];
  if (!rule) return;

  await learnTaste(channel, {
    rule,
    pref: { palette: `premium minimal compositing — low-opacity looks only (${lean})` },
    source: "review",
  });
}

/* A compact PassRecord for the passes.ts `visual`/compositing slot. */
export function compositingPassRecord(r: CompositingPassResult): PassRecord {
  const summary =
    r.mode === "closed_loop"
      ? r.scenesComposited > 0
        ? `compositing: closed-loop composited ${r.scenesComposited} scene(s) against measured visual deficiencies${r.reverted.length ? ` (${r.reverted.length} reverted)` : ""}`
        : r.reverted.length
          ? `compositing: every proposed look reverted on verify — held the prior look`
          : `compositing: nothing warranted — no change`
      : r.mode === "dna_default"
        ? "compositing: DNA-default global wash (no evidence yet)"
        : "compositing: no visual deficiency found — no change";
  return { pass: "visual", at: nowIso(), summary, changed: [...r.reasons, ...r.reverted, ...r.notes] };
}
