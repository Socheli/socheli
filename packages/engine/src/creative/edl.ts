import { z } from "zod";
import {
  EdlDecision,
  ColorGrade,
  GlobalGrade,
  EffectGraph,
  type EffectNode,
  type Edl,
  type ContentItem,
  type Scene,
  type SceneFunction,
} from "@os/schemas";
import { gradeToColorGrade, GRADE_PRESET_IDS, type GradePresetId } from "@os/tokens";
import { loadItem, saveItem, nowIso, logLine } from "../store.ts";
import { think } from "../brain.ts";
import { genomeContextSafe } from "../dna.ts";
import { chooseConcept } from "./concepts.ts";

/* creative/edl.ts — the editorial SPINE + the BRIDGE.

   The renderer is static: it turns storyboard scene params into pixels. This
   module adds the editorial-judgement layer on top WITHOUT changing the render
   target. An Edl is a list of per-scene EdlDecisions that record INTENT
   (function, pacing, transition, b-roll, mix, color, caption, motion). The
   bridge (applyEdlToStoryboard) deterministically translates that intent into
   concrete, schema-clamped scene/mix params so the cut still renders through
   Remotion. Decisions are kept intact and re-runnable — the bridge is a pure
   projection from intent → params, never the source of truth.

   Determinism + safety first: every numeric maps through a clamp, a locked
   scene is never touched, and one bad decision is skipped (with a note) rather
   than throwing — a partial bridge is always better than a broken render. */

/* ─── Schema range constants (mirror @os/schemas; keep the bridge honest) ─── */
const SCENE_MIN_SEC = 2; // RULES.minSceneDuration
const SCENE_MAX_SEC = 14; // RULES.maxSceneDuration
const TOTAL_MIN_SEC = 12; // RULES.minTotalDuration
const TOTAL_MAX_SEC = 75; // RULES.maxTotalDuration

const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n));
const round2 = (n: number) => Number(n.toFixed(2));
const round3 = (n: number) => Number(n.toFixed(3));

/* ─── ColorGrade schema bands (mirror @os/schemas gradeShape; keep grades honest)
   The schema ColorGrade is INTENTIONALLY narrower than the tokens
   `ColorGradeShape`: temperature/tint are ±1 (NOT ±100), saturation/contrast are
   0..2 (NOT 0..3), lift channels ±1, gamma/gain 0..2, and there is NO `exposure`
   field. So whenever we reuse a tokens preset (gradeToColorGrade) we MUST rescale
   temp/tint by /100, clamp sat/contrast into [0,2], and drop exposure — otherwise
   ColorGrade.parse would reject the result. clampGrade is the single edge every
   grade (preset, prose-derived, or brain-emitted) passes through. */
const GRADE_LIFT = [-1, 1] as const;     // additive shadow pedestal per channel
const GRADE_MUL = [0, 2] as const;       // gamma / gain multiplier per channel (1 = neutral)
const GRADE_TEMP = [-1, 1] as const;     // schema white-balance band (warm + / cool −)
const GRADE_SAT = [0, 2] as const;       // 1 = neutral
const GRADE_CONTRAST = [0, 2] as const;  // 1 = neutral about pivot
const GRADE_PIVOT = [0, 1] as const;

/* Internal authoring shape for a grade DELTA: like the schema ColorGrade but each
   triplet may also carry a `master` (all-channel) push. `master` is the natural
   unit for prose/preset mapping ("crush the blacks" = a master lift down); it is
   FOLDED into r/g/b at the clampGrade edge (the schema rgbTriplet is RGB-only).
   Everything in this module reasons in GradeDelta; only the persisted result is a
   schema ColorGrade. */
type ChannelDelta = { r?: number; g?: number; b?: number; master?: number };
type GradeDelta = {
  lift?: ChannelDelta;
  gamma?: ChannelDelta;
  gain?: ChannelDelta;
  temperature?: number;
  tint?: number;
  saturation?: number;
  contrast?: number;
  pivot?: number;
  curves?: z.infer<typeof ColorGrade>["curves"];
};

/* Clamp an arbitrary {r,g,b,master} triplet into a band → a schema-real {r,g,b}.
   The SCHEMA rgbTriplet is RGB-ONLY (no `master` channel), but the internal
   mappers/presets reason in terms of a master (all-channel) push — so we FOLD any
   `master` into r/g/b here (a master lift of +0.05 ⇒ +0.05 on each channel that
   the grade touches, or on all three when only master was set). This is the one
   boundary that reconciles the master-based authoring math with the RGB-only
   on-disk schema. Absent keys stay absent so a sparse delta stays sparse. For a
   multiplier band (gamma/gain, neutral=1) master combines multiplicatively. */
function clampTriplet(t: any, lo: number, hi: number, neutral: number): Record<string, number> | undefined {
  if (!t || typeof t !== "object") return undefined;
  const isMul = neutral === 1; // gamma/gain are multiplicative (neutral 1); lift is additive (neutral 0)
  const master = typeof t.master === "number" && Number.isFinite(t.master) ? t.master : undefined;
  const out: Record<string, number> = {};
  const channels = ["r", "g", "b"] as const;
  // Which channels are explicitly set? If none and only master is present, master
  // applies to ALL THREE so a master-only push survives the fold to RGB.
  const explicit = channels.filter((k) => typeof t[k] === "number" && Number.isFinite(t[k]));
  const targets = explicit.length ? explicit : master != null ? [...channels] : [];
  for (const k of targets) {
    let v = typeof t[k] === "number" && Number.isFinite(t[k]) ? t[k] : neutral;
    if (master != null) v = isMul ? v * master : v + master; // fold master into the channel
    out[k] = round3(clamp(v, lo, hi));
  }
  return Object.keys(out).length ? out : undefined;
}

/* Clamp a (possibly partial) grade to the schema ColorGrade band and re-parse,
   so an out-of-band number from a preset/prose/brain can never reach the render.
   Returns undefined when nothing survives (an empty grade is not written). */
function clampGrade(g: any): z.infer<typeof ColorGrade> | undefined {
  if (!g || typeof g !== "object") return undefined;
  const out: Record<string, any> = {};
  const lift = clampTriplet(g.lift, GRADE_LIFT[0], GRADE_LIFT[1], 0);
  const gamma = clampTriplet(g.gamma, GRADE_MUL[0], GRADE_MUL[1], 1);
  const gain = clampTriplet(g.gain, GRADE_MUL[0], GRADE_MUL[1], 1);
  if (lift) out.lift = lift;
  if (gamma) out.gamma = gamma;
  if (gain) out.gain = gain;
  if (typeof g.temperature === "number" && Number.isFinite(g.temperature)) out.temperature = round3(clamp(g.temperature, GRADE_TEMP[0], GRADE_TEMP[1]));
  if (typeof g.tint === "number" && Number.isFinite(g.tint)) out.tint = round3(clamp(g.tint, GRADE_TEMP[0], GRADE_TEMP[1]));
  if (typeof g.saturation === "number" && Number.isFinite(g.saturation)) out.saturation = round3(clamp(g.saturation, GRADE_SAT[0], GRADE_SAT[1]));
  if (typeof g.contrast === "number" && Number.isFinite(g.contrast)) out.contrast = round3(clamp(g.contrast, GRADE_CONTRAST[0], GRADE_CONTRAST[1]));
  if (typeof g.pivot === "number" && Number.isFinite(g.pivot)) out.pivot = round3(clamp(g.pivot, GRADE_PIVOT[0], GRADE_PIVOT[1]));
  if (g.curves && typeof g.curves === "object") out.curves = g.curves; // shape-validated by parse below
  if (!Object.keys(out).length) return undefined;
  try {
    return ColorGrade.parse(out);
  } catch {
    return undefined; // never let a malformed grade throw out of the bridge
  }
}

/* Convert a tokens `ColorGradeShape` (temp/tint ±100, sat/contrast 0..3, +exposure)
   into a schema-band grade: rescale white-balance /100, fold `exposure` into a
   master gain push (the schema has no exposure field), then clampGrade. This is
   how a NAMED preset becomes a real, parseable ColorGrade. */
function presetToSchemaGrade(p: ReturnType<typeof gradeToColorGrade>): any {
  const gain = { ...p.gain };
  // exposure is ±2 stops → a gentle master-gain multiplier (2^(exposure/2)),
  // so a named look that leans on exposure still reads in the schema model.
  if (typeof p.exposure === "number" && p.exposure !== 0) {
    gain.master = (gain.master ?? 1) * Math.pow(2, p.exposure / 2);
  }
  return {
    lift: p.lift,
    gamma: p.gamma,
    gain,
    temperature: p.temperature / 100,
    tint: p.tint / 100,
    saturation: p.saturation,
    contrast: p.contrast,
    pivot: p.pivot,
  };
}

/* Merge grade `b` over grade `a` (b's stated fields win; triplets merge per
   channel). Used to layer a prose delta over a named-preset base, and to
   aggregate per-scene grades into a common global trim. */
function mergeGrade(a: any, b: any): any {
  const out: any = { ...(a ?? {}) };
  if (!b) return out;
  for (const ch of ["lift", "gamma", "gain"] as const) {
    if (b[ch]) out[ch] = { ...(a?.[ch] ?? {}), ...b[ch] };
  }
  for (const k of ["temperature", "tint", "saturation", "contrast", "pivot", "curves"] as const) {
    if (b[k] != null) out[k] = b[k];
  }
  return out;
}

/* Derive the GLOBAL trim shared by a set of per-scene grades: the average of the
   directions the MAJORITY of graded scenes agree on. A scalar field (temp/tint/
   sat/contrast) is promoted only when >half the grades push it the same way; its
   value is the mean of those. Triplet channels likewise average where most agree.
   Returns undefined when there's no consistent look — so an inconsistent cut
   leaves storyboard.grade untouched (per-scene grades still render). */
function commonGrade(grades: Array<z.infer<typeof ColorGrade>>): z.infer<typeof ColorGrade> | undefined {
  const n = grades.length;
  if (n < 2) return undefined;
  const need = Math.ceil(n / 2); // a simple majority must agree on a direction
  const out: any = {};

  // Scalar fields with a neutral identity: a value counts as "pushed" when it
  // departs from neutral, and agreement is same-sign departure.
  const scalars: Array<[string, number]> = [["temperature", 0], ["tint", 0], ["saturation", 1], ["contrast", 1], ["pivot", 0.435]];
  for (const [key, neutral] of scalars) {
    const vals = grades.map((g) => (g as any)[key]).filter((v) => typeof v === "number") as number[];
    if (vals.length < need) continue;
    const pos = vals.filter((v) => v > neutral).length;
    const neg = vals.filter((v) => v < neutral).length;
    const dir = pos >= need ? vals.filter((v) => v > neutral) : neg >= need ? vals.filter((v) => v < neutral) : null;
    if (dir && dir.length) out[key] = round3(dir.reduce((a, b) => a + b, 0) / dir.length);
  }

  // Triplet channels: average a channel across the grades that set it, when most do.
  for (const ch of ["lift", "gamma", "gain"] as const) {
    const neutral = ch === "lift" ? 0 : 1;
    const merged: Record<string, number> = {};
    for (const k of ["r", "g", "b", "master"] as const) {
      const vals = grades.map((g) => (g as any)[ch]?.[k]).filter((v) => typeof v === "number") as number[];
      if (vals.length < need) continue;
      const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
      if (Math.abs(mean - neutral) > 0.001) merged[k] = round3(mean);
    }
    if (Object.keys(merged).length) out[ch] = merged;
  }

  // Halve the global trim's strength so the project trim is a SUBTLE common base,
  // not a doubling of the per-scene grades on top of it (those still render).
  const softened = softenGrade(out);
  return clampGrade(softened);
}

/* Pull a grade toward neutral by `k` (0..1) — used to make the aggregated global
   trim a gentle common base rather than a full re-application of the per-scene look. */
function softenGrade(g: any, k = 0.5): any {
  if (!g) return g;
  const out: any = {};
  const lerp = (v: number, neutral: number) => round3(neutral + (v - neutral) * k);
  for (const ch of ["lift", "gamma", "gain"] as const) {
    const neutral = ch === "lift" ? 0 : 1;
    if (g[ch]) {
      const c: Record<string, number> = {};
      for (const key of ["r", "g", "b", "master"] as const) if (typeof g[ch][key] === "number") c[key] = lerp(g[ch][key], neutral);
      out[ch] = c;
    }
  }
  if (typeof g.temperature === "number") out.temperature = lerp(g.temperature, 0);
  if (typeof g.tint === "number") out.tint = lerp(g.tint, 0);
  if (typeof g.saturation === "number") out.saturation = lerp(g.saturation, 1);
  if (typeof g.contrast === "number") out.contrast = lerp(g.contrast, 1);
  if (typeof g.pivot === "number") out.pivot = g.pivot; // pivot is a reference, not a strength
  return out;
}

/* Valid per-scene entry transitions (the only tokens the renderer understands). */
const VALID_TRANSITIONS = ["slide", "fade", "wipe", "slamzoom", "zoom", "push", "cover", "spin", "glitch"] as const;
type ValidTransition = (typeof VALID_TRANSITIONS)[number];

/* Valid subtitle presets on item.mix.subtitles.preset. */
const VALID_SUB_PRESETS = ["pop", "bounce", "phrase", "hormozi", "glow"] as const;

/* ─── Transition token → valid enum ─────────────────────────────────────────
   The brain (and briefs) speak free editorial vocabulary ("cut", "whip pan",
   "punch in"). Map each to the nearest renderable transition + a sensible
   duration, so intent survives the bridge instead of being dropped. A "cut" is
   the absence of a flashy transition → a very short fade reads as a hard cut. */
function mapTransition(token: string | undefined): { transition: ValidTransition; durationSec: number; ease: "linear" | "easeIn" | "easeOut" | "easeInOut" } | null {
  if (!token) return null;
  const t = token.toLowerCase().trim();
  // Already a valid enum value — pass through with a default duration.
  if ((VALID_TRANSITIONS as readonly string[]).includes(t)) {
    return { transition: t as ValidTransition, durationSec: 0.4, ease: "easeInOut" };
  }
  // Hard cut: shortest possible fade reads as an instant cut.
  if (/\b(cut|hard|none|straight)\b/.test(t)) return { transition: "fade", durationSec: 0.1, ease: "linear" };
  // Whip / whoosh / swipe → wipe.
  if (/\b(whip|whoosh|swipe|swish|pan)\b/.test(t)) return { transition: "wipe", durationSec: 0.35, ease: "easeInOut" };
  // Punch / impact / hit → slamzoom.
  if (/\b(punch|impact|hit|slam|snap|smash)\b/.test(t)) return { transition: "slamzoom", durationSec: 0.3, ease: "easeOut" };
  // Zoom / push-in / dolly → zoom.
  if (/\b(zoom|push|dolly|in)\b/.test(t)) return { transition: "zoom", durationSec: 0.5, ease: "easeInOut" };
  // Dissolve / blend / soft → fade.
  if (/\b(dissolve|blend|soft|cross)\b/.test(t)) return { transition: "fade", durationSec: 0.5, ease: "easeInOut" };
  // Glitch / digital → glitch.
  if (/\b(glitch|digital|datamosh|rgb)\b/.test(t)) return { transition: "glitch", durationSec: 0.3, ease: "easeOut" };
  // Spin / roll → spin.
  if (/\b(spin|roll|rotate)\b/.test(t)) return { transition: "spin", durationSec: 0.4, ease: "easeInOut" };
  // Slide / cover are direct.
  if (/\bslide\b/.test(t)) return { transition: "slide", durationSec: 0.4, ease: "easeInOut" };
  if (/\bcover\b/.test(t)) return { transition: "cover", durationSec: 0.4, ease: "easeInOut" };
  // Unknown vocabulary — fall back to a gentle fade rather than dropping intent.
  return { transition: "fade", durationSec: 0.4, ease: "easeInOut" };
}

/* ─── Baseline function tagging ──────────────────────────────────────────────
   A heuristic story map for a storyboard that has no Edl yet: scene 0 is the
   hook, an explicit cta scene (or the last scene) is the cta, b-roll-bearing
   scenes are b_roll, and the middle is spread across the standard arc beats.
   The brain refines these in buildEdl — this is just a sane, deterministic
   floor so edlFromStoryboard alone produces a usable cut. */
const MIDDLE_ARC: SceneFunction[] = ["context", "problem", "idea", "proof", "example", "tension", "resolution"];

function baselineFn(scene: Scene, index: number, count: number): SceneFunction {
  if (index === 0) return "hook";
  const type = String((scene as any).type ?? "");
  if (type === "cta") return "cta";
  if (index === count - 1) return type === "cta" ? "cta" : "resolution";
  // A scene that exists mostly to show footage reads as b-roll.
  if ((scene as any).broll && !sceneHasText(scene)) return "b_roll";
  // Spread the remaining middle scenes across the arc, proportional to position.
  const middleCount = Math.max(1, count - 2);
  const pos = index - 1; // 0-based within the middle
  const idx = Math.min(MIDDLE_ARC.length - 1, Math.floor((pos / middleCount) * MIDDLE_ARC.length));
  return MIDDLE_ARC[idx];
}

/* Does this scene carry meaningful on-screen text? (drives b_roll tagging) */
function sceneHasText(scene: Scene): boolean {
  const s = scene as any;
  return Boolean(s.text || s.caption || s.title || s.code || (Array.isArray(s.lines) && s.lines.length));
}

/* A short, human description of a scene for the baseline intent + the prompt. */
function sceneSummary(scene: Scene): string {
  const s = scene as any;
  const text =
    s.text ||
    s.caption ||
    s.title ||
    s.value ||
    (Array.isArray(s.lines) ? s.lines.map((l: any) => (typeof l === "string" ? l : l?.text)).filter(Boolean).join(" / ") : "") ||
    s.say ||
    "";
  return `${s.type} — ${String(text).slice(0, 90)}`.trim();
}

/* ─── edlFromStoryboard ──────────────────────────────────────────────────────
   Build a baseline Edl from the storyboard AS IT IS: one decision per scene,
   seeded from the scene's CURRENT params (so applying this baseline is a no-op
   on the render). This is the deterministic spine buildEdl then refines. */
export function edlFromStoryboard(item: ContentItem): Edl {
  const scenes: Scene[] = (item.storyboard?.scenes ?? []) as Scene[];
  const count = scenes.length;
  const decisions = scenes.map((scene, index) => {
    const fn = baselineFn(scene, index, count);
    const transitionIn = (scene as any).style?.transition as string | undefined;
    return EdlDecision.parse({
      sceneId: (scene as any).id,
      sceneIndex: index,
      fn,
      intent: `${fn}: ${sceneSummary(scene)}`,
      pacingSec: round2((scene as any).durationSec ?? SCENE_MIN_SEC),
      emphasis: Boolean((scene as any).emphasis),
      keep: !(scene as any).hidden, // a hidden scene is trimmed from the cut
      ...(transitionIn ? { transitionIn } : {}),
      ...(((scene as any).broll?.query) ? { brollIntent: (scene as any).broll.query } : {}),
    });
  });
  return {
    concept: item.chosenConcept,
    decisions,
    passLog: [],
    updatedAt: nowIso(),
  };
}

/* ─── buildEdl ───────────────────────────────────────────────────────────────
   The editorial spine: ensure a brief + chosen concept exist, start from the
   deterministic baseline, then ask the smart brain to assign each scene a
   precise function + intent + concrete intents (pacing / emphasis / transition /
   b-roll / mix / color / caption / motion) that EXPRESS the chosen concept and
   serve the brief. The model's decisions are realigned to the existing scenes
   (same length, order, sceneId, sceneIndex) so the bridge stays 1:1. */
export async function buildEdl(id: string, opts: { conceptId?: string } = {}): Promise<Edl> {
  const item = loadItem(id);
  const scenes: Scene[] = (item.storyboard?.scenes ?? []) as Scene[];
  if (!scenes.length) {
    // No storyboard yet — persist an empty spine rather than throwing, so the
    // creative loop can run brief/concepts first and re-enter.
    const empty: Edl = { concept: item.chosenConcept, decisions: [], passLog: [], updatedAt: nowIso() };
    item.edl = empty;
    saveItem(item);
    return empty;
  }

  // Ensure a chosen concept (chooseConcept auto-picks the best overall when the
  // id is omitted and concepts already exist). Fail-open: if concepts haven't
  // been generated yet, we still build a baseline-grounded Edl.
  let conceptId = opts.conceptId ?? item.chosenConcept;
  let concept = (item.concepts ?? []).find((c) => c.id === conceptId);
  if (!concept) {
    try {
      concept = chooseConcept(id, opts.conceptId);
      conceptId = concept.id;
    } catch {
      /* no concepts available — proceed with brief-only grounding */
    }
  }

  const baseline = edlFromStoryboard(item);

  // Compact, model-readable context: brief + chosen concept + the brand genome
  // (grounds the cut in what the brand has learned) + a numbered scene table.
  const brief = item.brief;
  const genome = genomeContextSafe(item.channel);
  const sceneTable = scenes
    .map((s, i) => `${i}. [id=${(s as any).id}] ${sceneSummary(s)} (now ${round2((s as any).durationSec ?? 0)}s${(s as any).emphasis ? ", emphasis" : ""})`)
    .join("\n");

  const prompt = [
    "You are a senior video editor authoring an Edit Decision List (EDL). For EACH",
    "scene below, assign its narrative FUNCTION in the cut and the concrete editorial",
    "intents that express the chosen creative concept and serve the brief.",
    "",
    brief ? `BRIEF:\n${JSON.stringify(brief)}` : "BRIEF: (none — infer a tasteful default from the scenes)",
    "",
    concept
      ? `CHOSEN CONCEPT:\n${JSON.stringify({ name: concept.name, style: concept.style, summary: concept.summary, pacing: concept.pacing, paletteIntent: concept.paletteIntent, typographyIntent: concept.typographyIntent, transitionIntent: concept.transitionIntent, soundIntent: concept.soundIntent })}`
      : "CHOSEN CONCEPT: (none — choose a coherent direction and hold it across every scene)",
    "",
    genome ? `${genome}\n` : "",
    "SCENES (keep decisions in THIS order, one per scene, same sceneId/sceneIndex):",
    sceneTable,
    "",
    "RULES:",
    `- fn ∈ hook|context|problem|tension|idea|proof|example|resolution|cta|b_roll|transition. Scene 0 is the hook; the last/cta scene is the cta.`,
    `- pacingSec is the editorial duration target in seconds (${SCENE_MIN_SEC}-${SCENE_MAX_SEC}); keep the cut tight and varied, faster on transitions, longer where text must be read.`,
    `- emphasis=true ONLY on the 1-2 emotional PEAK beats (they punch on the beat).`,
    `- transitionIn: an entry-transition token (cut|fade|wipe|slamzoom|zoom|push|cover|spin|glitch|whip|punch). Hard cuts are fine and usually best.`,
    `- brollIntent: what footage should show (only where b-roll fits). mixIntent: e.g. "duck music hard under VO", "let silence breathe".`,
    `- colorIntent: grade direction. captionIntent: caption style + which words to accent. motionIntent: e.g. "slow ken-burns push in".`,
    `- keep=false trims a scene from the cut. Every intent must EXPRESS the concept; do not contradict its palette/typography/transition/sound intents.`,
    "",
    `Return ONLY JSON: {"decisions":[{"sceneId","sceneIndex","fn","intent","pacingSec","emphasis","keep","transitionIn","brollIntent","mixIntent","colorIntent","captionIntent","motionIntent","rationale"}]}`,
  ]
    .filter(Boolean)
    .join("\n");

  let proposed: z.infer<typeof EdlDecision>[] = [];
  try {
    const { data } = await think(z.object({ decisions: z.array(EdlDecision) }), prompt, "smart", 2, "edit_edl");
    proposed = data.decisions;
  } catch {
    // Brain unavailable/failed — the baseline IS a valid Edl; ship it rather
    // than failing the whole creative pass.
    proposed = [];
  }

  // Realign the model output to the real scenes: index proposals by sceneIndex
  // (falling back to sceneId), then for each scene take the matching proposal
  // but FORCE the structural fields (sceneId/sceneIndex) to the truth, so a
  // hallucinated id/length can never desync the bridge.
  const byIndex = new Map<number, z.infer<typeof EdlDecision>>();
  const byId = new Map<string, z.infer<typeof EdlDecision>>();
  for (const d of proposed) {
    if (Number.isInteger(d.sceneIndex)) byIndex.set(d.sceneIndex, d);
    if (d.sceneId) byId.set(d.sceneId, d);
  }
  const decisions = baseline.decisions.map((base) => {
    const p = byIndex.get(base.sceneIndex) ?? byId.get(base.sceneId);
    if (!p) return base; // model skipped this scene — keep the deterministic baseline
    return EdlDecision.parse({
      ...base, // baseline supplies safe defaults for anything the model omitted
      ...p,
      sceneId: base.sceneId, // structural fields are NON-negotiable
      sceneIndex: base.sceneIndex,
      // Clamp the one free numeric so a wild pacingSec can't poison the bridge.
      ...(p.pacingSec != null ? { pacingSec: round2(clamp(p.pacingSec, SCENE_MIN_SEC, SCENE_MAX_SEC)) } : {}),
    });
  });

  const edl: Edl = {
    concept: conceptId ?? baseline.concept,
    decisions,
    passLog: item.edl?.passLog ?? [], // preserve any prior pass history
    updatedAt: nowIso(),
  };
  item.edl = edl;
  if (conceptId) item.chosenConcept = conceptId;
  logLine(item, `edl: built ${decisions.length} decision(s)${conceptId ? ` for concept ${conceptId}` : ""}`);
  saveItem(item);
  return edl;
}

/* ─── applyEdlToStoryboard — THE BRIDGE ──────────────────────────────────────
   Project the editorial Edl onto concrete storyboard scene/mix params. Every
   mapping is deterministic and clamped to the schema; a locked scene is never
   mutated; one bad decision is skipped with a note instead of throwing. The
   decision layer is left intact, so this is fully re-runnable. */
export function applyEdlToStoryboard(id: string): { changed: string[] } {
  const item = loadItem(id);
  const changed: string[] = [];
  const edl = item.edl;
  const scenes: any[] = (item.storyboard?.scenes ?? []) as any[];
  if (!edl || !scenes.length) return { changed };

  // Pacing is clamped per-scene, then the cut's TOTAL is kept within the
  // storyboard's duration bounds: if applying every pacing target would push
  // the visible total out of [12,75]s, scale the visible scenes proportionally.
  // Computed up front so each per-scene write is already total-aware.
  const pacingTargets = new Map<number, number>();
  for (const d of edl.decisions) {
    const scene = scenes[d.sceneIndex];
    if (!scene || scene.locked) continue;
    if (d.keep === false) continue; // hidden scenes don't count toward the total
    if (d.pacingSec != null) pacingTargets.set(d.sceneIndex, clamp(d.pacingSec, SCENE_MIN_SEC, SCENE_MAX_SEC));
  }
  const visibleTotal = scenes.reduce((sum, s, i) => {
    if (s.hidden) return sum;
    return sum + (pacingTargets.get(i) ?? Number(s.durationSec ?? SCENE_MIN_SEC));
  }, 0);
  let pacingScale = 1;
  if (visibleTotal > TOTAL_MAX_SEC) pacingScale = TOTAL_MAX_SEC / visibleTotal;
  else if (visibleTotal > 0 && visibleTotal < TOTAL_MIN_SEC) pacingScale = TOTAL_MIN_SEC / visibleTotal;

  // Caption + mix intents are GLOBAL (item.mix), aggregated across decisions so
  // the strongest signal wins rather than the last-write. Collected here, applied
  // once after the per-scene loop.
  let captionPreset: (typeof VALID_SUB_PRESETS)[number] | null = null;
  const captionKeywords = new Set<string>();
  let wantSubtitles = false;
  let duckIntent: { amount: number; attack: number; release: number } | null = null;
  let musicVolIntent: number | null = null;
  let voiceVolIntent: number | null = null;
  // M8: the VOICE channel-strip (EQ/comp/de-ess) aggregated across decisions —
  // strongest/last decisive value wins (a strip applies to the whole VO track, so
  // it's global like duck/vol). Applied once after the loop onto mix.tracks[voice].
  let voiceEq: EqBand[] | null = null;
  let voiceComp: CompParams | null = null;
  let voiceDeess: DeEssParams | null = null;
  // M8: per-scene "breathe" dips — a music gain dip scoped to one scene's window.
  // Collected here as mix.clips[] (the bridge owns the [startSec,durSec) window
  // computed from the resolved scene durations after pacing is applied).
  const breatheDips: Array<{ sceneIndex: number; depth: number }> = [];
  // Per-scene grades collected this pass — used to derive a GLOBAL trim onto
  // storyboard.grade when a look is consistent across the cut (§4.1).
  const sceneGrades: Array<z.infer<typeof ColorGrade>> = [];

  for (const d of edl.decisions) {
    const scene = scenes[d.sceneIndex];
    // Skip a missing or LOCKED scene — never mutate locked work.
    if (!scene) continue;
    if (scene.id !== d.sceneId && scenes.find((s) => s.id === d.sceneId)) continue; // index/id desync → skip rather than mutate the wrong scene
    if (scene.locked) {
      changed.push(`scene ${d.sceneIndex}: locked — skipped`);
      continue;
    }
    // One bad decision must never abort the whole bridge.
    try {
      // keep===false → hide (never delete; the scene + its work survive).
      if (d.keep === false) {
        if (!scene.hidden) {
          scene.hidden = true;
          changed.push(`scene ${d.sceneIndex}: trimmed from cut (hidden)`);
        }
      } else if (scene.hidden) {
        // A decision that re-includes a previously trimmed scene.
        scene.hidden = false;
        changed.push(`scene ${d.sceneIndex}: re-included in cut`);
      }

      // pacingSec → durationSec (clamped, then total-scaled, re-clamped).
      if (d.pacingSec != null) {
        const target = clamp(round2(clamp(d.pacingSec, SCENE_MIN_SEC, SCENE_MAX_SEC) * pacingScale), SCENE_MIN_SEC, SCENE_MAX_SEC);
        if (Math.abs(target - Number(scene.durationSec ?? 0)) > 0.01) {
          scene.durationSec = round2(target);
          changed.push(`scene ${d.sceneIndex}: duration → ${scene.durationSec}s`);
        }
      }

      // emphasis → scene.emphasis (peak beats only).
      if (d.emphasis != null && Boolean(scene.emphasis) !== d.emphasis) {
        scene.emphasis = d.emphasis;
        changed.push(`scene ${d.sceneIndex}: emphasis ${d.emphasis ? "on" : "off"}`);
      }

      // transitionIn → scene.style.transition (+ duration + ease) via token map.
      const tr = mapTransition(d.transitionIn);
      if (tr) {
        scene.style = { ...(scene.style ?? {}) };
        if (scene.style.transition !== tr.transition) {
          scene.style.transition = tr.transition;
          changed.push(`scene ${d.sceneIndex}: transition → ${tr.transition}`);
        }
        scene.style.transitionDuration = clamp(tr.durationSec, 0.1, 1.5);
        scene.style.transitionEase = tr.ease;
      }

      // motionIntent → a subtle keyframe track (ken-burns push, or a pan).
      if (d.motionIntent) applyMotionIntent(scene, d.motionIntent, d.sceneIndex, changed);

      // brollIntent → scene.broll.query (keep its kind; only where broll fits).
      if (d.brollIntent && supportsBroll(scene)) {
        const query = d.brollIntent.slice(0, 80);
        const prevKind = scene.broll?.kind ?? "concrete";
        if (scene.broll?.query !== query) {
          scene.broll = { query, kind: prevKind };
          changed.push(`scene ${d.sceneIndex}: b-roll → "${query}"`);
        }
      }

      // colorIntent (+ structured decision.grade) → a REAL, schema-clamped
      // per-scene grade on scene.style.grade (§4.1), plus schema-real typography.
      // Returns the grade so the bridge can aggregate a global trim below.
      const sg = applyColorAndType(scene, d, d.sceneIndex, changed);
      if (sg) sceneGrades.push(sg);

      // visualIntent (+ colorIntent) → a per-scene COMPOSITING graph on
      // scene.style.comp (§4.4). Only written when the intent clearly calls for
      // compositing (mask/key/glow/grain/leak/glitch); reuses the per-scene grade
      // (sg) as the ONE grade node where the look leans on contrast/colour.
      if (d.visualIntent || d.colorIntent) {
        const comp = buildCompFromIntents(d, sg);
        if (comp) {
          scene.style = { ...(scene.style ?? {}), comp };
          changed.push(`scene ${d.sceneIndex}: comp graph (${comp.nodes.length} node${comp.nodes.length === 1 ? "" : "s"})`);
        }
      }

      // captionIntent → aggregate into the GLOBAL subtitle settings.
      if (d.captionIntent) {
        wantSubtitles = true;
        const preset = captionPresetFor(d.captionIntent);
        if (preset && !captionPreset) captionPreset = preset; // first decisive preset wins
        for (const kw of emphasisKeywords(d.captionIntent)) captionKeywords.add(kw);
      }

      // mixIntent → aggregate into GLOBAL duck/volume + the VOICE channel-strip,
      // plus a per-scene "breathe" dip scoped to THIS scene's window (M8).
      if (d.mixIntent) {
        const mi = parseMixIntent(d.mixIntent);
        if (mi.duck) duckIntent = mi.duck;
        if (mi.musicVol != null) musicVolIntent = mi.musicVol;
        if (mi.voiceVol != null) voiceVolIntent = mi.voiceVol;
        if (mi.eq) voiceEq = mi.eq;             // a strip is global to the VO track
        if (mi.comp) voiceComp = mi.comp;
        if (mi.deess) voiceDeess = mi.deess;
        if (mi.breathe) breatheDips.push({ sceneIndex: d.sceneIndex, depth: mi.breathe.depth });
      }
    } catch (e) {
      changed.push(`scene ${d.sceneIndex}: skipped (${e instanceof Error ? e.message : String(e)})`);
    }
  }

  // ── Apply the aggregated GLOBAL mix/caption intents once. ──
  if (wantSubtitles || captionPreset || captionKeywords.size) {
    const sub = { ...(item.mix?.subtitles ?? {}) } as any;
    sub.enabled = true;
    if (captionPreset) sub.preset = captionPreset;
    if (captionKeywords.size) sub.keywords = [...new Set([...(sub.keywords ?? []), ...captionKeywords])].slice(0, 12);
    item.mix = { ...(item.mix ?? {}), subtitles: sub };
    changed.push(`mix: subtitles ${captionPreset ?? "on"}${captionKeywords.size ? ` (accent: ${[...captionKeywords].slice(0, 4).join(", ")})` : ""}`);
  }
  if (duckIntent) {
    item.mix = {
      ...(item.mix ?? {}),
      duck: {
        enabled: true,
        amount: clamp(duckIntent.amount, 0, 1),
        attack: clamp(duckIntent.attack, 0, 2),
        release: clamp(duckIntent.release, 0, 3),
      },
    };
    changed.push(`mix: duck music under VO (amount ${clamp(duckIntent.amount, 0, 1).toFixed(2)})`);
  }
  if (musicVolIntent != null) {
    item.mix = { ...(item.mix ?? {}), musicVol: clamp(musicVolIntent, 0, 2) };
    changed.push(`mix: music volume → ${clamp(musicVolIntent, 0, 2).toFixed(2)}`);
  }
  if (voiceVolIntent != null) {
    item.mix = { ...(item.mix ?? {}), voiceVol: clamp(voiceVolIntent, 0, 2) };
    changed.push(`mix: voice volume → ${clamp(voiceVolIntent, 0, 2).toFixed(2)}`);
  }

  // ── M8: apply the VOICE channel-strip (EQ/comp/de-ess) onto mix.tracks[voice].
  //    Merged over any existing voice track so other track fields (vol/fades) and a
  //    `locked` track are respected — a locked voice track is left untouched. ──
  if (voiceEq || voiceComp || voiceDeess) {
    const tracks = Array.isArray(item.mix?.tracks) ? [...item.mix!.tracks!] : [];
    const vi = tracks.findIndex((t: any) => t?.id === "voice");
    const existing: any = vi >= 0 ? tracks[vi] : { id: "voice" };
    if (existing.locked) {
      changed.push("mix: voice track locked — channel-strip skipped");
    } else {
      const next: any = { ...existing };
      const bits: string[] = [];
      if (voiceEq) { next.eq = voiceEq; bits.push(`${voiceEq.length}-band EQ`); }
      if (voiceComp) { next.comp = voiceComp; bits.push("comp"); }
      if (voiceDeess) { next.deess = voiceDeess; bits.push("de-ess"); }
      if (vi >= 0) tracks[vi] = next; else tracks.push(next);
      item.mix = { ...(item.mix ?? {}), tracks };
      changed.push(`mix: voice strip → ${bits.join(" + ")}`);
    }
  }

  // ── M8: per-scene "breathe" dips → mix.clips[] music gain automation. Compute
  //    each scene's start/length in seconds from the RESOLVED durations (after the
  //    pacing scale this bridge just applied), then drop a V-shaped gain dip on the
  //    music track scoped to that scene's window. Clamped, additive. ──
  if (breatheDips.length) {
    // Resolved scene seconds: a hidden scene contributes 0; a visible scene uses its
    // (now-updated) durationSec. This is the same per-scene-sequential timing Post.tsx
    // lays clips on — close enough for a "breathe" region, and always in-bounds.
    const startSecOf = (idx: number) => {
      let acc = 0;
      for (let i = 0; i < idx && i < scenes.length; i++) {
        const s: any = scenes[i];
        if (s?.hidden) continue;
        acc += Number(s?.durationSec ?? SCENE_MIN_SEC);
      }
      return round2(acc);
    };
    const clips = Array.isArray(item.mix?.clips) ? [...item.mix!.clips!] : [];
    let added = 0;
    for (const dip of breatheDips) {
      const scene: any = scenes[dip.sceneIndex];
      if (!scene || scene.hidden) continue;
      const startSec = startSecOf(dip.sceneIndex);
      const durSec = round2(Math.max(SCENE_MIN_SEC, Number(scene.durationSec ?? SCENE_MIN_SEC)));
      const floor = clamp(1 - dip.depth, 0, 1); // bed level at the dip's bottom
      // A V-curve: full → floor at mid → full, so the music breathes then returns.
      const gain = {
        points: [{ t: 0, v: 1 }, { t: 0.5, v: round3(floor) }, { t: 1, v: 1 }],
        easing: "easeInOut" as const,
      };
      // De-dupe: replace any existing breathe clip on the same music window.
      const exIdx = clips.findIndex((c: any) => c?.trackId === "music" && Math.abs(Number(c?.startSec ?? -1) - startSec) < 0.01);
      const clip = { trackId: "music", startSec, durSec, gain };
      if (exIdx >= 0) clips[exIdx] = clip; else clips.push(clip);
      added++;
    }
    if (added) {
      item.mix = { ...(item.mix ?? {}), clips };
      changed.push(`mix: ${added} breathe dip(s) on the music bed`);
    }
  }

  // ── GLOBAL grade aggregation (§4.1) ── when a look is CONSISTENT across the cut
  // (most graded scenes share the same trim direction), promote the common trim
  // to storyboard.grade — mirroring how captionPreset/duckIntent aggregate to the
  // global mix. The per-scene grades stay as deltas; the global trim is the look
  // every scene shares. Only written when the signal is strong enough (≥2 graded
  // scenes that agree), so a single stylized beat never recolors the whole cut.
  if (item.storyboard && sceneGrades.length >= 2) {
    const common = commonGrade(sceneGrades);
    if (common) {
      item.storyboard.grade = common;
      changed.push(`grade: global trim aggregated from ${sceneGrades.length} graded scene(s)`);
    }
  }

  if (changed.length) {
    logLine(item, `edl-bridge: applied ${changed.length} change(s) to storyboard`);
    saveItem(item);
  }
  return { changed };
}

/* ─── Direct grade write tools (the colorist's hands) ─────────────────────────
   gradeScene / gradeGlobal are the imperative siblings of the bridge: they write
   a grade onto one scene / the whole storyboard NOW, from either a structured
   grade or a prose intent — for the creative_grade_* tools and the color pass.
   They reuse the EXACT bridge discipline: clamp to the schema band, never touch a
   locked scene, skip-not-throw. They DON'T re-run the whole Edl bridge (that would
   re-derive every other axis from the Edl); they merge the new grade over any
   existing one and persist, leaving all other scene params intact. */

/** Write a grade onto one scene (by index). Accepts a structured ColorGrade
 *  delta and/or a prose intent (intent is mapped, then merged UNDER the explicit
 *  grade so explicit numbers win). Returns the resolved grade, or null when the
 *  scene is missing/locked or nothing survives clamping. */
export function gradeScene(
  id: string,
  sceneIndex: number,
  opts: { grade?: Partial<z.infer<typeof ColorGrade>>; intent?: string },
): { id: string; sceneIndex: number; grade: z.infer<typeof ColorGrade> | null; changed: string[] } {
  const item = loadItem(id);
  const scenes: any[] = (item.storyboard?.scenes ?? []) as any[];
  const changed: string[] = [];
  const scene = scenes[sceneIndex];
  if (!scene) return { id, sceneIndex, grade: null, changed: [`scene ${sceneIndex}: missing — skipped`] };
  if (scene.locked) return { id, sceneIndex, grade: null, changed: [`scene ${sceneIndex}: locked — skipped`] };

  // prose → grade first (a base), then the explicit structured grade wins on top.
  const fromIntent = opts.intent ? colorIntentToGrade(opts.intent) : undefined;
  const merged = mergeGrade(mergeGrade(scene.style?.grade, fromIntent), opts.grade);
  const grade = clampGrade(merged);
  if (!grade) return { id, sceneIndex, grade: null, changed: [`scene ${sceneIndex}: empty grade — nothing written`] };

  scene.style = { ...(scene.style ?? {}), grade };
  if (opts.intent) (scene.advisory ??= {}).colorGrade = opts.intent;
  changed.push(`scene ${sceneIndex}: grade written`);
  logLine(item, `grade: scene ${sceneIndex} graded directly`);
  saveItem(item);
  return { id, sceneIndex, grade, changed };
}

/** Write the GLOBAL trim onto storyboard.grade from a structured grade and/or a
 *  prose intent (merged over any existing global grade). Locked-safe by nature —
 *  the global trim is not a scene. Returns the resolved global grade or null. */
export function gradeGlobal(
  id: string,
  opts: { grade?: Partial<z.infer<typeof GlobalGrade>>; intent?: string },
): { id: string; grade: z.infer<typeof GlobalGrade> | null; changed: string[] } {
  const item = loadItem(id);
  if (!item.storyboard) return { id, grade: null, changed: ["no storyboard — skipped"] };
  const fromIntent = opts.intent ? colorIntentToGrade(opts.intent) : undefined;
  const merged = mergeGrade(mergeGrade(item.storyboard.grade, fromIntent), opts.grade);
  const grade = clampGrade(merged); // ColorGrade == GlobalGrade shape; one clamp serves both
  if (!grade) return { id, grade: null, changed: ["empty global grade — nothing written"] };
  item.storyboard.grade = grade;
  logLine(item, `grade: global trim written directly`);
  saveItem(item);
  return { id, grade, changed: ["storyboard: global grade written"] };
}

/* ─── Bridge helpers (deterministic intent → param mappers) ───────────────── */

/* Which scene types meaningfully render b-roll behind them. Setting a b-roll
   query on a dense terminal/code scene would be wasted, so gate it. */
function supportsBroll(scene: any): boolean {
  const t = String(scene.type ?? "");
  // Either it already has a b-roll slot, or it's a full-bleed visual scene.
  if (scene.broll) return true;
  return ["hook_text", "kinetic_text", "image_focus", "quote", "big_number", "warning", "cta"].includes(t);
}

/* motionIntent → a subtle keyframe track. We only add motion when the intent
   clearly calls for it, and we keep amplitudes gentle (≤8% scale, ≤40px pan) so
   "ken burns" stays premium, never a lurch. Existing keyframes are preserved;
   we only add a track for a prop that has none. */
function applyMotionIntent(scene: any, intent: string, index: number, changed: string[]) {
  const t = intent.toLowerCase();
  const wantsPush = /\b(ken.?burns|push.?in|zoom.?in|dolly.?in|move.?in|creep)\b/.test(t);
  const wantsPull = /\b(pull.?out|zoom.?out|dolly.?out|reveal.?wide)\b/.test(t);
  const wantsPanR = /\b(pan.?right|track.?right|slide.?right)\b/.test(t);
  const wantsPanL = /\b(pan.?left|track.?left|slide.?left)\b/.test(t);
  if (!wantsPush && !wantsPull && !wantsPanR && !wantsPanL) return;

  scene.style = { ...(scene.style ?? {}) };
  const tracks: any[] = Array.isArray(scene.style.keyframes) ? [...scene.style.keyframes] : [];
  const hasProp = (p: string) => tracks.some((k) => k.prop === p);

  if ((wantsPush || wantsPull) && !hasProp("scale")) {
    const [from, to] = wantsPush ? [1, 1.08] : [1.08, 1];
    tracks.push({ prop: "scale", points: [{ t: 0, v: from, ease: "easeInOut" }, { t: 1, v: to, ease: "easeInOut" }] });
    changed.push(`scene ${index}: motion ${wantsPush ? "ken-burns push" : "pull-out"}`);
  }
  if ((wantsPanR || wantsPanL) && !hasProp("x")) {
    const to = wantsPanR ? 40 : -40;
    tracks.push({ prop: "x", points: [{ t: 0, v: 0, ease: "easeInOut" }, { t: 1, v: to, ease: "easeInOut" }] });
    changed.push(`scene ${index}: motion pan ${wantsPanR ? "right" : "left"}`);
  }
  if (tracks.length) scene.style.keyframes = tracks;
}

/* ─── colorIntentToGrade — the deterministic prose → grade mapper (§4.1) ──────
   Turn free editorial colour vocabulary into a real, schema-band `ColorGrade`
   delta. Two layers, in order:
     1. NAMED LOOK detection — if the prose names a preset look ("teal orange",
        "warm film", "cool crush", "muted/cinematic", "high contrast"), seed from
        the tokens `gradeToColorGrade` preset (rescaled to the schema band) so the
        brand's restrained primaries are reused, not re-invented.
     2. PROSE DELTAS — independent cues layer on top (crushed blacks → lift down;
        lifted/raised shadows → lift up; cool/teal → temperature down; warm →
        temperature up; high contrast → contrast up; muted/desaturated → sat
        down; vibrant → sat up; filmic/soft → gentle contrast + small lift).
   Every cue is ADDITIVE over a sparse delta, so "cool, crushed blacks, filmic"
   composes. The result is clamped to the schema band by the caller (clampGrade);
   "neutral" snaps everything back to identity. Deterministic + skip-not-throw:
   an unrecognised intent simply returns an empty delta (no grade written). */
export function colorIntentToGrade(intent: string): GradeDelta {
  const t = String(intent ?? "").toLowerCase();
  if (!t.trim()) return {};

  // Explicit neutral request → identity grade (clears stylization).
  if (/\b(neutral|natural|flat|untouched|reset (the )?grade|no grade)\b/.test(t)) {
    return { lift: { master: 0 }, gamma: { master: 1 }, gain: { master: 1 }, temperature: 0, tint: 0, saturation: 1, contrast: 1 };
  }

  // 1) Named-look seed (reuse the token presets where a look is detected). The
  //    keys map common prose to a `GradePresetId`; first match wins as the base.
  const NAMED: Array<[RegExp, GradePresetId]> = [
    [/\b(teal[ -]?orange|orange[ -]?teal|complementary|blockbuster)\b/, "teal_orange"],
    [/\b(cool[ -]?crush|crushed.*(cool|cold)|surveillance|ops[ -]?look|cold.*(crush|blacks))\b/, "cool_crush"],
    [/\b(warm[ -]?film|warm.*filmic|film.*warm|golden.*film|nostalg)\b/, "warm_film"],
    [/\b(high[ -]?contrast|punchy.*contrast|contrasty|gritty.*punch)\b/, "high_contrast"],
    [/\b(muted.*cinematic|cinematic.*muted|desat.*cinematic|flat.*filmic|calm.*filmic)\b/, "muted_cinematic"],
  ];
  let grade: any = {};
  for (const [re, id] of NAMED) {
    if (re.test(t) && GRADE_PRESET_IDS.includes(id)) {
      grade = presetToSchemaGrade(gradeToColorGrade(id));
      break;
    }
  }

  // 2) Independent prose deltas — each cue nudges the (possibly preset-seeded)
  //    grade further. Authored small + restrained (brand is dark/cinematic).
  const lift = { ...(grade.lift ?? {}) };
  const gain = { ...(grade.gain ?? {}) };

  // Blacks: crush/deepen vs lift/raise.
  if (/\b(crush(ed)? (the )?blacks|deep blacks|deepen.*blacks|inky|crush(ed)?)\b/.test(t)) {
    lift.master = (lift.master ?? 0) - 0.05;
    grade.contrast = (grade.contrast ?? 1) * 1.1;
  }
  if (/\b(lift(ed)? (the )?(shadows|blacks)|raise.*(shadows|blacks)|open (up )?(the )?shadows|milky|faded)\b/.test(t)) {
    lift.master = (lift.master ?? 0) + 0.06;
  }

  // White balance: cool/teal vs warm/golden.
  if (/\b(cool|cold|teal|icy|blue(r)?|chilly)\b/.test(t)) {
    grade.temperature = (grade.temperature ?? 0) - 0.18;
    lift.b = (lift.b ?? 0) + 0.02; // a touch of teal in the shadows
  }
  if (/\b(warm(er)?|golden|amber|cozy|sunny|orange (push|grade))\b/.test(t)) {
    grade.temperature = (grade.temperature ?? 0) + 0.18;
    gain.r = (gain.r ?? 1) * 1.02; // warm the highlights gently
  }

  // Contrast / punch.
  if (/\b(high[ -]?contrast|contrasty|punch(y)?|bold|gritty|harsh)\b/.test(t)) {
    grade.contrast = (grade.contrast ?? 1) * 1.15;
  }
  if (/\b(low[ -]?contrast|soft contrast|flat|gentle)\b/.test(t) && !/\bhigh/.test(t)) {
    grade.contrast = (grade.contrast ?? 1) * 0.92;
  }

  // Saturation.
  if (/\b(muted|desatur|washed|de[ -]?sat|low sat|drained)\b/.test(t)) {
    grade.saturation = (grade.saturation ?? 1) * 0.7;
  }
  if (/\b(vivid|vibrant|saturated|punch.*colou?r|rich colou?r|pop(ping)? colou?r)\b/.test(t)) {
    grade.saturation = (grade.saturation ?? 1) * 1.2;
  }

  // Filmic / soft / dreamy → soft-curve feel: small lifted blacks + a touch less
  // contrast + slightly reduced sat (the "filmic" soft-curve look in primaries).
  if (/\b(filmic|film look|soft|dreamy|cinematic|moody|matte)\b/.test(t)) {
    lift.master = (lift.master ?? 0) + 0.025;
    grade.contrast = (grade.contrast ?? 1) * 0.97;
    grade.saturation = (grade.saturation ?? 1) * 0.95;
  }

  if (Object.keys(lift).length) grade.lift = lift;
  if (Object.keys(gain).length) grade.gain = gain;
  return grade;
}

/* colorIntent + typographyIntent → a REAL per-scene grade + schema-real type
   fields. The colour DIRECTION now writes scene.style.grade (a validated
   ColorGrade): prefer a structured `decision.grade` from the brain, else map the
   free-text colorIntent through colorIntentToGrade. Every grade is clamped to the
   schema band (clampGrade) and a locked scene is never reached here (the bridge
   guards that). Legibility stroke/shadow are now SECONDARY (only when the prose
   asks for punch/softness), and the literal prose is still recorded as advisory.
   Per-scene fontScale clamps to 0.6-1.6. */
function applyColorAndType(scene: any, d: any, index: number, changed: string[]): z.infer<typeof ColorGrade> | undefined {
  const color = String(d.colorIntent ?? "").toLowerCase();
  const typo = String((d as any).typographyIntent ?? "").toLowerCase(); // decisions rarely carry this; harmless if absent
  scene.style = { ...(scene.style ?? {}) };

  // ── REAL GRADE (§4.1) ── prefer a structured grade the brain emitted; else map
  // the free-text colorIntent deterministically. Clamp to the schema band and
  // write it onto scene.style.grade so the GradePipeline renders it.
  const rawGrade = d.grade ?? (color ? colorIntentToGrade(d.colorIntent) : undefined);
  const grade = clampGrade(rawGrade);
  if (grade) {
    scene.style.grade = grade;
    changed.push(`scene ${index}: grade applied${d.grade ? " (structured)" : ` ("${String(d.colorIntent).slice(0, 40)}")`}`);
  }

  // ── Legibility proxies are now SECONDARY ── only nudge stroke/shadow when the
  // prose explicitly asks for punch/softness; the real look lives in the grade.
  if (/\b(high.?contrast|punch|bold|gritty|harsh)\b/.test(color)) {
    scene.style.effectIntensity = clamp(Math.max(scene.style.effectIntensity ?? 0.5, 0.7), 0, 1);
    if (!scene.style.stroke) {
      scene.style.stroke = { color: "#000000", width: 2 };
      changed.push(`scene ${index}: legibility stroke (contrast intent)`);
    }
  }
  if (/\b(soft|dreamy|gentle|cinematic|muted|moody)\b/.test(color)) {
    scene.style.effectIntensity = clamp(Math.min(scene.style.effectIntensity ?? 0.5, 0.4), 0, 1);
    if (!scene.style.shadow) scene.style.shadow = { color: "#000000", blur: 24, x: 0, y: 6 };
  }
  // Typography direction (when present) → case + tracking, both schema-real.
  if (/\b(all.?caps|uppercase)\b/.test(typo)) { scene.style.textCase = "upper"; changed.push(`scene ${index}: type uppercase`); }
  if (/\b(wide|airy|tracked)\b/.test(typo)) scene.style.letterSpacing = clamp(0.08, -0.08, 0.2);
  if (/\b(tight|condensed)\b/.test(typo)) scene.style.letterSpacing = clamp(-0.04, -0.08, 0.2);

  // Record the literal prose as advisory metadata — never lost (a human / LUT
  // finishing pass can still read the original direction).
  if (color) (scene.advisory ??= {}).colorGrade = d.colorIntent;

  // Hand the per-scene grade back so the bridge can aggregate a global trim.
  return grade;
}

/* ─── buildCompFromIntents — the deterministic COMPOSITING intent → graph (§4.4) ─
   Turn a decision's free-text `visualIntent` (+ `colorIntent` + `emphasis`) into a
   small, schema-real `EffectGraph` written onto scene.style.comp — the compositor's
   sibling to colorIntentToGrade. It is the SAME bridge contract as every other
   compiler here: deterministic, every param clamped to a safe band, a locked scene
   never reached (the caller guards), and an unrecognised intent simply returns
   undefined (NO comp written) so a scene without a clear compositing call renders
   through the legacy path BYTE-IDENTICAL.

   The graph is always rooted at a single `source` node (the scene content); the
   look/mask/key nodes wire FROM it via `inputs`, in the order they stack. We map a
   handful of recognisable looks (the 90% an editor actually asks for):
     • "isolate/separate the subject", "pop the subject", "key out the …"  →
       a luma/chroma key (or a centre vignette-mask) + a glow on what survives.
     • "vintage/old film", "super-8", "retro"  →  grain + vignette + light_leak.
     • "punchy", "make it pop", "hit"  →  bloom + a touch of contrast (via a grade
       node reusing the per-scene grade direction).
     • "dreamy/soft glow", "ethereal"  →  glow + a soft bloom.
     • "glitch/datamosh", "vhs", "distort"  →  chroma_ab + displace.
     • "tunnel/spotlight/frame", "circle on …"  →  mask_shape (circle) + vignette.
   `reuseGrade` (the per-scene grade applied by applyColorAndType) is folded in as a
   `grade` node where the intent leans on contrast/colour, so we never invent a
   second grade — the §4.1 grade is the ONE grade, exposed here as a node (decision
   #8 in the roadmap's open-decisions). Returns a parsed EffectGraph or undefined.
   Node ids are DETERMINISTIC (type + position), so re-running the bridge on the
   same intent yields the identical graph — a re-bridge is idempotent. */
export function buildCompFromIntents(
  d: { visualIntent?: string; colorIntent?: string; emphasis?: boolean },
  reuseGrade?: z.infer<typeof ColorGrade>,
): z.infer<typeof EffectGraph> | undefined {
  const t = `${String(d.visualIntent ?? "")} ${String(d.colorIntent ?? "")}`.toLowerCase();
  if (!t.trim()) return undefined;

  const src: EffectNode = { id: "src", type: "source", inputs: [] };
  const nodes: EffectNode[] = [src];
  let last = src.id; // the id every new node chains from (a linear look stack)
  const push = (type: EffectNode["type"], params: Record<string, unknown>) => {
    // deterministic id: type + its position in the stack (unique within the graph).
    const node: EffectNode = { id: `${type}_${nodes.length}`, type, params, inputs: [last] };
    nodes.push(node);
    last = node.id;
  };

  // 1) SUBJECT ISOLATION — "isolate / separate / pop the subject", "key out …".
  //    A green/colour key when the prose names a key colour, else a luma key on a
  //    bright/dark card; then a glow on what survives so the subject lifts.
  if (/\b(isolate|separate|cut.?out|knock.?out|key (out|the)|pop the subject|subject.*(pop|glow|isolat)|isolate.*subject)\b/.test(t)) {
    if (/\b(green|chroma|green.?screen)\b/.test(t)) {
      push("key_chroma", { color: "#00ff00", tolerance: 0.35 });
    } else if (/\b(white|bright)\b/.test(t)) {
      push("key_luma", { threshold: 0.82, tolerance: 0.1, invert: false });
    } else if (/\b(black|dark)\b/.test(t)) {
      push("key_luma", { threshold: 0.18, tolerance: 0.1, invert: true });
    } else {
      // no card named → a centre soft circle-mask reads as "isolate the middle"
      push("mask_shape", { shape: "circle", r: 46, x: 50, y: 46, feather: 14 });
    }
    push("glow", { amount: 0.42, radius: 18 });
  }

  // 2) SPOTLIGHT / FRAME — "spotlight", "circle on", "vignette frame", "tunnel".
  if (!nodes.some((n) => n.type === "mask_shape") && /\b(spotlight|tunnel|circle (on|around)|frame the|porthole|vignette frame)\b/.test(t)) {
    push("mask_shape", { shape: "circle", r: 52, x: 50, y: 48, feather: 18 });
    push("vignette", { amount: 0.4 });
  }

  // 3) VINTAGE / OLD-FILM — grain + vignette + a warm light leak.
  if (/\b(vintage|old.?film|super.?8|retro|nostalg|grainy film|film burn|aged)\b/.test(t)) {
    push("grain", { amount: 0.1, frequency: 0.85 });
    push("vignette", { amount: 0.34 });
    push("light_leak", { amount: 0.4 });
  }

  // 4) GLITCH / VHS — chromatic aberration + a small displacement warp.
  if (/\b(glitch|datamosh|vhs|distort|corrupt|signal.?break|warp)\b/.test(t)) {
    push("chroma_ab", { amount: 3 });
    push("displace", { scale: 6, frequency: 0.012, animate: true });
  }

  // 5) DREAMY / SOFT GLOW — a soft glow + bloom (ethereal, no key).
  if (/\b(dreamy|ethereal|soft glow|halo|heavenly|glow(y)?|bloom(y)?)\b/.test(t) && !nodes.some((n) => n.type === "glow")) {
    push("glow", { amount: 0.38, radius: 20 });
    push("bloom", { amount: 0.3 });
  }

  // 6) PUNCHY — a bloom + reuse the per-scene grade direction as a grade node so
  //    "punchy" deepens contrast through the ONE grade, not a second one.
  if (/\b(punch(y)?|make it pop|pop|hit hard|impact|bold look)\b/.test(t) && !nodes.some((n) => n.type === "bloom")) {
    push("bloom", { amount: d.emphasis ? 0.4 : 0.28 });
    if (reuseGrade) push("grade", { grade: reuseGrade });
  }

  // No recognisable compositing call → write NOTHING (legacy render path).
  if (nodes.length <= 1) return undefined;

  // Clamp the node count to the schema budget and re-parse so a malformed graph can
  // never reach the render (skip-not-throw: undefined on a parse failure).
  const trimmed = nodes.slice(0, 24);
  try {
    return EffectGraph.parse({ nodes: trimmed, output: trimmed[trimmed.length - 1].id });
  } catch {
    return undefined;
  }
}

/* captionIntent → a subtitle preset. Phrase/poetic captions read as one line at
   a time; punchy/hormozi captions pop word-by-word. */
function captionPresetFor(intent: string): (typeof VALID_SUB_PRESETS)[number] | null {
  const t = intent.toLowerCase();
  if (/\b(phrase|poetic|line|elegant|minimal|clean)\b/.test(t)) return "phrase";
  if (/\b(hormozi|aggressive|bold.?word|word.?by.?word)\b/.test(t)) return "hormozi";
  if (/\b(pop|punch|punchy|snappy|kinetic)\b/.test(t)) return "pop";
  if (/\b(bounce|playful|fun)\b/.test(t)) return "bounce";
  if (/\b(glow|neon|premium|cinematic)\b/.test(t)) return "glow";
  return null;
}

/* Pull QUOTED or "key word: X" emphasis words out of a caption intent, so the
   accented words come straight from the editor's intent. Falls back to the
   capitalized salient words. */
function emphasisKeywords(intent: string): string[] {
  const quoted = [...intent.matchAll(/["“']([^"”']{2,30})["”']/g)].map((m) => m[1].trim());
  if (quoted.length) return quoted.slice(0, 6);
  const afterColon = /(?:accent|emphasi[sz]e|highlight|key ?word[s]?)[:\s]+([a-z0-9 ,]+)/i.exec(intent);
  if (afterColon) return afterColon[1].split(/[,\s]+/).map((w) => w.trim()).filter((w) => w.length > 2).slice(0, 6);
  return [];
}

/* mixIntent → concrete duck/volume targets. Detects ducking, "let silence
   breathe" (lower music), and "music up/forward" cues. Defaults to a clean,
   broadcast-style duck when ducking is requested without numbers. */
/* M8 channel-strip clamp bands (mirror @os/schemas; keep the bridge honest). The
   AI can never emit an unsafe EQ/comp/de-ess — every value maps through these. */
const EQ_GAIN_MIN = -24, EQ_GAIN_MAX = 24;
const EQ_Q_MIN = 0.1, EQ_Q_MAX = 10;
const COMP_THRESH_MIN = -60, COMP_THRESH_MAX = 0;
const COMP_RATIO_MIN = 1, COMP_RATIO_MAX = 20;
const DEESS_FREQ_MIN = 2000, DEESS_FREQ_MAX = 12000;

type EqBand = { freq: number; gain: number; q: number; type: "peak" | "lowshelf" | "highshelf" | "lowpass" | "highpass" | "notch" };
type CompParams = { threshold: number; ratio: number; attack: number; release: number; makeup?: number };
type DeEssParams = { freq: number; amount: number };
type MixIntent = {
  duck?: { amount: number; attack: number; release: number };
  musicVol?: number;
  voiceVol?: number;
  // M8: a channel-strip for the VOICE track, parsed from prose. Every param already
  // clamped to its schema band here so the bridge can apply it directly.
  eq?: EqBand[];
  comp?: CompParams;
  deess?: DeEssParams;
  // M8: a per-scene "breathe" — a gain dip authored as a clip on the MUSIC track
  // scoped to this scene's frame span. The bridge owns the window (it knows
  // durations); we only flag intent + the dip depth.
  breathe?: { depth: number };
};

/* parseMixIntent — prose → a coarse global mix (duck/vol) AND a per-decision
   channel-strip (EQ/comp/de-ess) + a "breathe" dip request. Every numeric is
   clamped to its schema band right here, so a decision can never produce an
   out-of-range EQ boost, comp ratio, de-ess band, or dip depth. */
function parseMixIntent(intent: string): MixIntent {
  const t = intent.toLowerCase();
  const out: MixIntent = {};
  if (/\b(duck|under (the )?(vo|voice|narration)|sidechain)\b/.test(t)) {
    const hard = /\b(hard|heavy|deep|strong)\b/.test(t);
    out.duck = { amount: hard ? 0.8 : 0.55, attack: 0.12, release: hard ? 0.45 : 0.6 };
  }
  if (/\b(pull.?back music|drop the music|quiet(er)? (the )?music)\b/.test(t)) {
    out.musicVol = 0.5;
  }
  if (/\b(music (up|forward|loud)|drive(s)? the (energy|cut)|big music)\b/.test(t)) {
    out.musicVol = 1.2;
  }
  if (/\b(voice (up|forward|clear)|narration up|lift (the )?vo)\b/.test(t)) {
    out.voiceVol = 1.15;
  }

  // ── VOICE channel-strip (EQ / comp / de-ess) ──
  const eq: EqBand[] = [];
  // "warm up the VO" / "warmer" → a gentle low-shelf lift (body without mud).
  if (/\b(warm(er)?( up)?|fuller|add body|more body)\b/.test(t)) {
    eq.push({ freq: 180, gain: clamp(2.5, EQ_GAIN_MIN, EQ_GAIN_MAX), q: clamp(0.7, EQ_Q_MIN, EQ_Q_MAX), type: "lowshelf" });
  }
  // "muddy" / "boxy" → cut the low-mids, add presence (the roadmap's EDL bridge).
  if (/\b(muddy|boxy|mud|cloudy)\b/.test(t)) {
    eq.push({ freq: 250, gain: clamp(-2.5, EQ_GAIN_MIN, EQ_GAIN_MAX), q: clamp(1.2, EQ_Q_MIN, EQ_Q_MAX), type: "peak" });
    eq.push({ freq: 3500, gain: clamp(3, EQ_GAIN_MIN, EQ_GAIN_MAX), q: clamp(1, EQ_Q_MIN, EQ_Q_MAX), type: "peak" });
  }
  // "brighten" / "crisp" / "presence" → a presence/air lift.
  if (/\b(bright(er|en)?|crisp(er)?|presence|airy|more air)\b/.test(t)) {
    eq.push({ freq: 8000, gain: clamp(2.5, EQ_GAIN_MIN, EQ_GAIN_MAX), q: clamp(0.7, EQ_Q_MIN, EQ_Q_MAX), type: "highshelf" });
  }
  // "thin" → a low-shelf to thicken (inverse of de-thinning); kept subtle.
  if (/\b(thin|tinny|small)\b/.test(t)) {
    eq.push({ freq: 150, gain: clamp(2, EQ_GAIN_MIN, EQ_GAIN_MAX), q: clamp(0.8, EQ_Q_MIN, EQ_Q_MAX), type: "lowshelf" });
  }
  if (eq.length) out.eq = eq.slice(0, 4); // schema-safe count; never an EQ wall

  // "even out the VO" / "punchy" / "control(led)" → a downward compressor.
  if (/\b(even (it |the vo |out)|control(led)?|tighten the vo|punch(y|ier)|glu(e|ed)|consistent level|level(led)? out)\b/.test(t)) {
    const heavy = /\b(heav(y|ier)|hard|strong|aggressive)\b/.test(t);
    out.comp = {
      threshold: clamp(heavy ? -22 : -18, COMP_THRESH_MIN, COMP_THRESH_MAX),
      ratio: clamp(heavy ? 4 : 3, COMP_RATIO_MIN, COMP_RATIO_MAX),
      attack: clamp(15, 0, 500),
      release: clamp(160, 0, 2000),
      makeup: clamp(heavy ? 3 : 2, 0, 24),
    };
  }

  // "harsh S" / "essy" / "sibilant" / "de-ess" → a de-esser on the sibilance band.
  if (/\b(harsh|ess(y)?|sibilan(t|ce)|de-?ess|sharp s\b|sss)\b/.test(t)) {
    const strong = /\b(very|really|too|heav(y|ier)|strong)\b/.test(t);
    out.deess = { freq: clamp(6500, DEESS_FREQ_MIN, DEESS_FREQ_MAX), amount: clamp(strong ? 0.6 : 0.4, 0, 1) };
  }

  // "let it breathe" / "let silence breathe" / "pause here" → a music gain dip on
  // THIS scene's region (the bridge windows it to the scene's frames).
  if (/\b(let (it|silence|that)? ?breathe|breathing room|pause here|let silence|space to breathe|give it air)\b/.test(t)) {
    const deep = /\b(fully|all the way|silence|deep)\b/.test(t);
    out.breathe = { depth: clamp(deep ? 0.85 : 0.6, 0, 1) }; // how far the bed drops at the dip floor
  }

  return out;
}
