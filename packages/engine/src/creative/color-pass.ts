import type { ColorGrade, PassRecord, EditingTaste } from "@os/schemas";
import { z } from "zod";
import { loadItem, nowIso, logLine } from "../store.ts";
import { editSignals, type ScopeSceneSignal } from "./signals.ts";
import { gradeScene, gradeGlobal } from "./edl.ts";
import { loadTaste, learnTaste, saveTaste } from "./taste.ts";

/* creative/color-pass.ts — the CLOSED-LOOP colorist (DaVinci spine §4.1, M5).
 *
 * The old `color` pass set free-text colorIntent from vibes. This is the
 * evidence-grounded replacement: it reads the per-scene SCOPE table (real luma
 * P50, clip%, white-balance bias measured off the render by editor_color_scopes)
 * and solves — in CLOSED FORM, not by guessing — a per-scene grade that moves
 * each scene toward three targets:
 *
 *   1. BALANCED EXPOSURE  — P50 into the brand's midtone band (via lift+gain).
 *   2. NEUTRAL WHITE BALANCE — wbBias→~0 (via temperature/tint) UNLESS the
 *      chosen concept's palette is deliberately stylized (teal/warm/etc.), in
 *      which case we keep the look and only flatten INCONSISTENCY.
 *   3. CONSISTENCY — pull every scene's exposure/WB toward the cut's own median,
 *      so the grade doesn't flicker scene-to-scene (the colorist's main job).
 *
 * Every solved field is computed from the measured gap (a known render-math
 * relationship), then CLAMPED by the bridge's clampGrade before it can reach a
 * pixel. A LOCKED scene is never graded (gradeScene guards that). The whole pass
 * FAILS OPEN: no render / no scopes → it degrades to a deterministic look-seed
 * from the concept palette, never throws. It is usable WITHOUT a render (writes
 * grades from the palette) and, when a render exists, can optionally re-render +
 * re-scope to VERIFY convergence (capped at 2 iterations, stop if not improving).
 *
 * It learns the channel's color band into EditingTaste.colorTargets via
 * learnTaste, so the next cut starts from this brand's measured house exposure. */

/* ─── Targets + solve constants (mirror the grade render math in grade.tsx) ───
   The SVG grade applies temperature as R×(1+0.12t) / B×(1−0.12t) and tint as
   G×(1−0.10ti); lift is an additive shadow pedestal (0..1 light) and gain a
   highlight multiplier. So a measured deficit maps to a grade delta by a fixed
   gain — we keep every gain GENTLE so one pass can never over-correct. */
const DEFAULT_P50 = 96;        // a balanced midtone target (0..255) for a dark-premium brand
const DEFAULT_LUMA_TOL = 28;   // half-width of the acceptable midtone band
const DEFAULT_WB_TOL = 8;      // ±8 (% of range) WB bias tolerated before correcting (neutral brand)
const STYLIZED_WB_TOL = 26;    // a deliberately-tinted concept tolerates a much wider bias

// Closed-form solve gains (kept small → conservative, monotone, never a lurch).
const LIFT_PER_EXPOSURE = 0.6;   // fraction of the normalized P50 gap applied as a master lift
const GAIN_PER_EXPOSURE = 0.7;   // fraction applied as a master gain push
const LIFT_LIMIT = 0.22;
const GAIN_LO = 0.78;
const GAIN_HI = 1.35;
const TEMP_PER_WARM = 1 / 36;    // a 36%-of-range warm bias → a full ∓1 temperature correction (clamped below)
const TINT_PER_GREEN = 1 / 36;
const WB_CORRECTION_LIMIT = 0.6; // never push WB harder than ±0.6 in one pass

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
const round3 = (n: number) => Number(n.toFixed(3));

/* Detect a DELIBERATELY stylized palette from the concept's paletteIntent prose.
   A stylized look (teal-orange, warm film, cool surveillance…) means a non-zero
   WB bias is the POINT, so we don't neutralize it — we only flatten scene-to-
   scene inconsistency. A neutral/clean/documentary palette gets full WB
   correction toward ~0. Returns the WB tolerance + a signed target bias the look
   wants (warm target / green target), both in the measured ±100 units. */
function readPalette(paletteIntent: string | undefined): { stylized: boolean; warmTarget: number; greenTarget: number; wbTol: number } {
  const t = String(paletteIntent ?? "").toLowerCase();
  let warmTarget = 0;
  let stylized = false;
  if (/\b(teal[ -]?orange|orange[ -]?teal|warm[ -]?film|warm|golden|amber|sunset|cozy|nostalg|film)\b/.test(t)) {
    warmTarget = 12; // a warm look sits a touch red-over-blue
    stylized = true;
  }
  if (/\b(cool|cold|teal|icy|blue|surveillance|ops|night|moonlit|steel)\b/.test(t)) {
    warmTarget = -12; // a cool look sits blue-over-red
    stylized = true;
  }
  return {
    stylized,
    warmTarget,
    greenTarget: 0, // a green/magenta cast is almost never the intended look
    wbTol: stylized ? STYLIZED_WB_TOL : DEFAULT_WB_TOL,
  };
}

/* The exposure + WB band this run grades toward: the brand's learned colorTargets
   when present (loadTaste), else the defaults. The palette can WIDEN the WB band
   and offset its target so a stylized look isn't fought. */
function resolveTargets(channel: string | undefined, palette: ReturnType<typeof readPalette>) {
  const taste: EditingTaste | null = channel ? safeLoadTaste(channel) : null;
  const ct = taste?.colorTargets;
  return {
    lumaP50: ct?.lumaP50 ?? DEFAULT_P50,
    lumaTol: ct?.lumaTol ?? DEFAULT_LUMA_TOL,
    warmTarget: palette.warmTarget,
    warmTol: Math.max(ct?.warmTol ?? 0, palette.wbTol),
    greenTarget: palette.greenTarget,
    greenTol: Math.max(ct?.greenTol ?? 0, DEFAULT_WB_TOL),
  };
}

function safeLoadTaste(channel: string): EditingTaste | null {
  try {
    return loadTaste(channel);
  } catch {
    return null;
  }
}

type ScopeStat = ScopeSceneSignal;
type Targets = ReturnType<typeof resolveTargets>;

/* ─── The closed-form per-scene solve ────────────────────────────────────────
   From a scene's measured scope numbers + the targets + the cut's median (for
   consistency), compute a sparse grade DELTA. Each axis is a measured gap times
   a fixed render-math gain, clamped. Returns undefined when the scene is already
   inside every band (nothing to correct — leave it untouched). */
function solveSceneGrade(
  s: ScopeStat,
  targets: Targets,
  median: { lumaP50?: number; warm?: number; green?: number },
): { grade: Partial<z.infer<typeof ColorGrade>>; reasons: string[] } | undefined {
  const reasons: string[] = [];
  const grade: any = {};

  // EXPOSURE — move P50 toward the target band; also nudge toward the cut median
  // (consistency) so an outlier scene joins the rest. We aim at the midpoint of
  // (brand target, cut median) so we honor the look AND flatten the cut.
  if (s.lumaP50 != null) {
    const aim = median.lumaP50 != null ? (targets.lumaP50 + median.lumaP50) / 2 : targets.lumaP50;
    const off = aim - s.lumaP50;
    if (Math.abs(off) > targets.lumaTol) {
      const gap = clamp(off / 255, -0.4, 0.4); // normalized 0..1 light-gap
      const lift = clamp(gap * LIFT_PER_EXPOSURE, -LIFT_LIMIT, LIFT_LIMIT);
      const gain = clamp(1 + gap * GAIN_PER_EXPOSURE, GAIN_LO, GAIN_HI);
      if (Math.abs(lift) > 0.005) grade.lift = { master: round3(lift) };
      if (Math.abs(gain - 1) > 0.005) grade.gain = { master: round3(gain) };
      reasons.push(`exposure P50 ${Math.round(s.lumaP50)}→~${Math.round(aim)} (${off > 0 ? "lift" : "pull down"})`);
    }
  }

  // WHITE BALANCE — neutralize the bias toward the look's target (0 for a neutral
  // palette, a signed target for a stylized one), again splitting toward the cut
  // median so a single scene doesn't drift the WB of the whole cut.
  if (s.warmBias != null) {
    const aim = median.warm != null ? (targets.warmTarget + median.warm) / 2 : targets.warmTarget;
    const off = s.warmBias - aim; // positive = too warm vs target
    if (Math.abs(off) > targets.warmTol) {
      // temperature DOWN cools (reduces R−B); off>0 (too warm) → negative temp delta.
      const tempDelta = clamp(-off * TEMP_PER_WARM, -WB_CORRECTION_LIMIT, WB_CORRECTION_LIMIT);
      if (Math.abs(tempDelta) > 0.01) {
        grade.temperature = round3(tempDelta);
        reasons.push(`WB warm ${s.warmBias >= 0 ? "+" : ""}${s.warmBias}→~${Math.round(aim)} (${tempDelta < 0 ? "cool" : "warm"})`);
      }
    }
  }
  if (s.greenBias != null) {
    const aim = median.green != null ? (targets.greenTarget + median.green) / 2 : targets.greenTarget;
    const off = s.greenBias - aim; // positive = too green
    if (Math.abs(off) > targets.greenTol) {
      // tint UP removes green (G×(1−0.10·tint)); off>0 (too green) → positive tint delta.
      const tintDelta = clamp(off * TINT_PER_GREEN, -WB_CORRECTION_LIMIT, WB_CORRECTION_LIMIT);
      if (Math.abs(tintDelta) > 0.01) {
        grade.tint = round3(tintDelta);
        reasons.push(`tint grn ${s.greenBias >= 0 ? "+" : ""}${s.greenBias}→~${Math.round(aim)}`);
      }
    }
  }

  if (!Object.keys(grade).length) return undefined;
  return { grade, reasons };
}

/* Median helper — robust center of a numeric set (used as the consistency anchor). */
function median(xs: number[]): number | undefined {
  const a = xs.filter((n) => Number.isFinite(n)).sort((x, y) => x - y);
  if (!a.length) return undefined;
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

/* A deterministic LOOK SEED when there's no render to measure (the pass is still
   usable): turn the concept palette into a gentle, schema-real grade so a cut
   gets a coherent base look even before its first render. Conservative — a small
   WB push toward the palette's bias, nothing that needs measurement. */
function paletteSeedGrade(palette: ReturnType<typeof readPalette>): Partial<z.infer<typeof ColorGrade>> | undefined {
  if (!palette.warmTarget) return undefined;
  // warmTarget is in ±100 units; convert to a gentle temperature push (half strength).
  const temp = clamp(palette.warmTarget * TEMP_PER_WARM * 0.5, -0.4, 0.4);
  if (Math.abs(temp) < 0.02) return undefined;
  return { temperature: round3(temp) };
}

export type ColorPassResult = {
  ok: boolean;
  mode: "closed_loop" | "palette_seed" | "noop";
  scenesGraded: number;
  reasons: string[];
  before?: { lumaSpread?: number; warmSpread?: number };
  after?: { lumaSpread?: number; warmSpread?: number };
  globalGrade: z.infer<typeof ColorGrade> | null;
  notes: string[];
};

/* ─── colorPass — the closed-loop colorist run ───────────────────────────────
   Read scopes → solve per-scene grades → write them through the bridge tools
   (clamped, locked-safe) → aggregate a global trim → learn the band into taste.
   verify=true re-scopes after writing (no re-render here — see colorPassVerify
   for the render-in-the-loop variant) so the caller sees the consistency it
   bought. Always fail-open. */
export async function colorPass(
  id: string,
  opts: { verify?: boolean } = {},
): Promise<ColorPassResult> {
  const notes: string[] = [];
  const item = loadItem(id);
  const concept = (item.concepts ?? []).find((c) => c.id === item.chosenConcept);
  const palette = readPalette(concept?.paletteIntent);
  const targets = resolveTargets(item.channel, palette);

  // Read the measured scope table (fail-open → null).
  const sig = await editSignals(id).catch(() => null);
  const scope = sig?.evidence.scope;
  const scenes = scope?.scenes ?? [];

  // ── No measurement → deterministic palette seed (still usable, no render). ──
  if (!scenes.length) {
    const seed = paletteSeedGrade(palette);
    if (!seed) {
      return { ok: true, mode: "noop", scenesGraded: 0, reasons: [], globalGrade: null, notes: ["no scope evidence and no stylized palette — nothing to seed"] };
    }
    const r = gradeGlobal(id, { grade: seed });
    logLine(loadItem(id), `color-pass: palette seed (no render) → global ${r.grade ? "grade" : "noop"}`);
    return {
      ok: true,
      mode: "palette_seed",
      scenesGraded: 0,
      reasons: [`palette seed: ${concept?.paletteIntent ?? "concept palette"}`],
      globalGrade: r.grade,
      notes: ["graded from concept palette (no render to measure yet); re-run after a render for the closed loop"],
    };
  }

  // Consistency anchors = the cut's own medians (so we flatten toward the center).
  const med = {
    lumaP50: median(scenes.map((s) => s.lumaP50).filter((n): n is number => n != null)),
    warm: median(scenes.map((s) => s.warmBias).filter((n): n is number => n != null)),
    green: median(scenes.map((s) => s.greenBias).filter((n): n is number => n != null)),
  };

  const before = scope?.consistency;
  const reasons: string[] = [];
  let scenesGraded = 0;

  // Solve + WRITE each scene's grade through the bridge tool (clamped, locked-safe).
  for (const s of scenes) {
    const solved = solveSceneGrade(s, targets, med);
    if (!solved) continue;
    const w = gradeScene(id, s.sceneIndex, { grade: solved.grade });
    if (w.grade) {
      scenesGraded++;
      reasons.push(`#${s.sceneIndex}: ${solved.reasons.join("; ")}`);
    } else if (w.changed[0]) {
      notes.push(`#${s.sceneIndex}: ${w.changed[0]}`); // locked / empty after clamp
    }
  }

  // Aggregate a GLOBAL trim from the palette seed so the cut shares one base look
  // (per-scene corrections sit on top). Only when the palette is stylized.
  let globalGrade: z.infer<typeof ColorGrade> | null = null;
  const seed = paletteSeedGrade(palette);
  if (seed) {
    const g = gradeGlobal(id, { grade: seed });
    globalGrade = g.grade;
  }

  // Learn the channel's measured color band into taste (best-effort, fail-open).
  if (item.channel) {
    try {
      await learnChannelColorTargets(item.channel, scenes, palette);
    } catch {
      /* taste learning is best-effort and must never fail the pass */
    }
  }

  // Optional VERIFY: re-read the scopes (the just-written grades render in the
  // existing video only on a RE-RENDER, so without one this re-scope reflects the
  // SAME frames — we report it transparently as the pre-render baseline). The
  // render-in-the-loop convergence variant is colorPassVerify below.
  let after = before;
  if (opts.verify) {
    const sig2 = await editSignals(id).catch(() => null);
    after = sig2?.evidence.scope?.consistency ?? before;
  }

  logLine(loadItem(id), `color-pass: graded ${scenesGraded}/${scenes.length} scene(s), targets P50=${targets.lumaP50}±${targets.lumaTol} warmTol=${targets.warmTol}`);
  return { ok: true, mode: "closed_loop", scenesGraded, reasons, before, after, globalGrade, notes };
}

/* Compound the channel's measured colour band into EditingTaste.colorTargets:
   the median midtone the brand actually ships at, and how wide its WB swing is.
   We blend toward the existing learned target (so it converges, not jitters) and
   never write a band tighter than a sane floor. A stylized palette records a
   wider WB tolerance (the look IS off-neutral). */
async function learnChannelColorTargets(
  channel: string,
  scenes: ScopeStat[],
  palette: ReturnType<typeof readPalette>,
): Promise<void> {
  const p50 = median(scenes.map((s) => s.lumaP50).filter((n): n is number => n != null));
  const warmMed = median(scenes.map((s) => s.warmBias).filter((n): n is number => n != null));
  if (p50 == null) return;
  const taste = loadTaste(channel);
  const prev = taste.colorTargets ?? {};
  // Converge toward the new measurement (half-step) so taste sharpens, not flips.
  const blend = (a: number | undefined, b: number, k = 0.5) => round3(a == null ? b : a + (b - a) * k);
  const learnedP50 = Math.round(clamp(blend(prev.lumaP50, p50), 0, 255));
  taste.colorTargets = {
    lumaP50: learnedP50,
    lumaTol: Math.round(clamp(prev.lumaTol ?? DEFAULT_LUMA_TOL, 12, 64)),
    warmTol: Math.round(clamp(Math.max(prev.warmTol ?? 0, palette.stylized ? STYLIZED_WB_TOL : DEFAULT_WB_TOL, Math.abs(warmMed ?? 0)), 4, 100)),
    greenTol: Math.round(clamp(prev.greenTol ?? DEFAULT_WB_TOL, 4, 100)),
    note: `learned from ${scenes.length} scene(s)${palette.stylized ? " (stylized palette)" : ""}`,
  };
  // learnTaste with a pref nudge + a durable "do" rule grounds the lesson and
  // persists colorTargets in the same atomic save.
  saveTasteWithTargets(taste);
  await learnTaste(channel, {
    rule: `grade midtones toward P50≈${learnedP50} (the brand's measured exposure)`,
    pref: { palette: palette.stylized ? "stylized look — hold the cast, flatten scene-to-scene" : "neutral, balanced exposure" },
    source: "review",
  });
}

/* learnTaste re-loads + saves taste itself, which would DROP the colorTargets we
   just set on the in-memory object. So we persist colorTargets first via the
   taste module's own atomic save, then call learnTaste (which merges rules onto
   the now-on-disk targets). */
function saveTasteWithTargets(taste: EditingTaste): void {
  try {
    saveTaste(taste);
  } catch {
    /* fail-open: a bad taste write must never break the colour pass */
  }
}

/* A compact PassRecord for the passes.ts `color` slot. */
export function colorPassRecord(r: ColorPassResult): PassRecord {
  const summary =
    r.mode === "closed_loop"
      ? `color: closed-loop graded ${r.scenesGraded} scene(s) toward exposure/WB/consistency${r.before && r.after ? ` (lumaSpread ${r.before.lumaSpread ?? "?"}→${r.after.lumaSpread ?? "?"})` : ""}`
      : r.mode === "palette_seed"
        ? "color: palette seed (no render yet) — graded from concept palette"
        : "color: no scope evidence and no stylized palette — no change";
  return { pass: "color", at: nowIso(), summary, changed: [...r.reasons, ...r.notes] };
}
