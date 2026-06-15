/* creative/concepts.ts — editorial DIRECTION exploration.
 *
 * A senior editor does not start cutting; they first imagine several valid ways
 * the same footage + brief could become a film (cinematic vs fast-ad vs doc vs
 * luxury-minimal…), grade each honestly against the brief, then commit to the
 * strongest. This module produces that fan-out (generateConcepts) and the
 * commitment (chooseConcept). Both persist onto the ContentItem so the EDL and
 * the passes downstream can ground themselves in the chosen direction.
 *
 * We deliberately keep editorial JUDGEMENT here and leave param translation to
 * the EDL bridge — a concept is intent, not storyboard mutation. */

import { z } from "zod";
import { EditConcept, type EditStyle, type TargetPlatform } from "@os/schemas";
import { loadItem, saveItem, logLine } from "../store.ts";
import { genomeContextSafe } from "../dna.ts";
import { think } from "../brain.ts";
import { tasteContext } from "./taste.ts";
import { inferBrief } from "./brief.ts";

/* The think() output schema — deliberately PERMISSIVE.
   Demanding a strict 10-field EditConcept (with nested 6-field ConceptScores) ×N
   in a single shot is brittle: models drop a field, rename one ("title" for
   "name"), or emit a style outside the enum, and the whole batch fails zod —
   burning the provider chain down to weak fallbacks. So we parse loosely here and
   NORMALIZE into a strict EditConcept afterwards (clamping enums, filling scores,
   defaulting prose). Robustness over trusting the model to nail a heavy schema. */
const num0to10 = z.coerce.number().min(0).max(10).catch(6);
const LooseConcepts = z.object({
  concepts: z
    .array(
      z.object({
        name: z.string().optional(),
        style: z.string().optional(),
        summary: z.string().optional(),
        pacing: z.string().optional(),
        paletteIntent: z.string().optional(),
        typographyIntent: z.string().optional(),
        transitionIntent: z.string().optional(),
        soundIntent: z.string().optional(),
        // scores REQUIRED — "explore options, pick the strongest" is the whole
        // point of the fan-out, so the chooser needs real differentiated grades,
        // not defaults. num0to10.catch(6) means a malformed single value degrades
        // to 6 without failing the batch, but an omitted scores object forces a
        // think() retry until the model actually grades each direction.
        scores: z.object({
          hook: num0to10,
          pacing: num0to10,
          emotion: num0to10,
          brandFit: num0to10,
          platformFit: num0to10,
          overall: num0to10,
        }),
        rationale: z.string().optional(),
      }),
    )
    .min(1)
    .max(8),
});

const STYLE_VALUES = ["cinematic", "fast_ad", "documentary", "luxury_minimal", "energetic_social", "educational", "custom"] as const;
const PACING_VALUES = ["slow", "measured", "brisk", "fast", "frenetic"] as const;

/* Coerce one loose model object into a strict, schema-valid EditConcept. Unknown
   styles fall back to "custom", unknown pacing to "measured", missing scores to a
   neutral 6, and overall (when absent) to the mean of the component scores so the
   chooser still has a meaningful ranking signal. */
function normalizeConcept(raw: any, fallbackStyle: EditStyle, fallbackPacing: string): EditConcept {
  const style = (STYLE_VALUES as readonly string[]).includes(String(raw?.style)) ? (raw.style as EditStyle) : fallbackStyle;
  const pacing = (PACING_VALUES as readonly string[]).includes(String(raw?.pacing)) ? raw.pacing : ((PACING_VALUES as readonly string[]).includes(fallbackPacing) ? fallbackPacing : "measured");
  const s = raw?.scores ?? {};
  const comp = ["hook", "pacing", "emotion", "brandFit", "platformFit"].map((k) => (typeof s[k] === "number" ? s[k] : 6));
  const overall = typeof s.overall === "number" ? s.overall : Math.round((comp.reduce((a, b) => a + b, 0) / comp.length) * 10) / 10;
  return EditConcept.parse({
    id: "",
    name: raw?.name || raw?.title || `${style.replace(/_/g, " ")} cut`,
    style,
    summary: raw?.summary || raw?.description || "",
    pacing: pacing as EditConcept["pacing"],
    paletteIntent: raw?.paletteIntent,
    typographyIntent: raw?.typographyIntent,
    transitionIntent: raw?.transitionIntent,
    soundIntent: raw?.soundIntent,
    scores: { hook: comp[0], pacing: comp[1], emotion: comp[2], brandFit: comp[3], platformFit: comp[4], overall },
    rationale: raw?.rationale || raw?.why || "",
  });
}

/* The editorial directions we *prefer* to spread across so the fan-out explores
   genuinely different films rather than four shades of the same cut. The model
   may diverge (e.g. "custom"), but we steer toward variety. Each carries a
   default pacing so the prompt can hint distinct rhythms per direction. */
const STYLE_PALETTE: { style: EditStyle; pacing: string }[] = [
  { style: "cinematic", pacing: "measured" },
  { style: "fast_ad", pacing: "fast" },
  { style: "documentary", pacing: "slow" },
  { style: "luxury_minimal", pacing: "slow" },
  { style: "energetic_social", pacing: "frenetic" },
  { style: "educational", pacing: "brisk" },
];

/* Slugify a style into a stable, collision-resistant concept id. When two
   concepts share a style (the model can repeat), we suffix an index so ids stay
   unique and downstream chosenConcept lookups never alias. */
function conceptId(style: string, seen: Set<string>): string {
  const base = `concept_${String(style).toLowerCase().replace(/[^a-z0-9]+/g, "_")}`;
  if (!seen.has(base)) {
    seen.add(base);
    return base;
  }
  let i = 2;
  while (seen.has(`${base}_${i}`)) i++;
  const id = `${base}_${i}`;
  seen.add(id);
  return id;
}

/* A compact, prompt-friendly digest of the storyboard so the model grades
   concepts against the *actual* cut, not an abstraction. Fail-open: a missing
   storyboard still yields a usable (if thinner) brief-only prompt. */
function storyboardSummary(item: ReturnType<typeof loadItem>): string {
  const sb = item.storyboard;
  if (!sb) return "(no storyboard yet — grade against the idea/brief only)";
  const lines = sb.scenes.map((s, i) => {
    const say = (s as any).say ? ` — “${String((s as any).say).slice(0, 80)}”` : "";
    return `${i + 1}. [${s.type}] ${s.durationSec}s${say}`;
  });
  const total = sb.scenes.reduce((a, s) => a + s.durationSec, 0);
  return [
    `hook: ${sb.hook}`,
    `topic: ${sb.topic} · format: ${sb.format} · ${total.toFixed(0)}s · ${sb.width}x${sb.height}`,
    `scenes (${sb.scenes.length}):`,
    ...lines,
    `cta: ${sb.cta}`,
  ].join("\n");
}

/**
 * Explore N distinct editorial concepts for an item and persist them.
 * Requires item.brief — infers it first if absent. Returns the concept array.
 */
export async function generateConcepts(
  id: string,
  opts: { n?: number } = {},
): Promise<EditConcept[]> {
  let item = loadItem(id);
  const n = Math.max(1, Math.min(8, opts.n ?? 4));

  // Strategy before exploration: a brief is mandatory grounding. Infer it once
  // and reload so we read the freshly-saved brief from disk.
  if (!item.brief) {
    await inferBrief(id);
    item = loadItem(id);
  }
  const brief = item.brief!;

  // Steer the fan-out toward `n` genuinely different directions, biasing the
  // first picks toward the platform's natural register but always forcing
  // variety across EditStyle + pacing.
  const styleHints = STYLE_PALETTE.slice(0, Math.max(n, 4))
    .map((p) => `- ${p.style} (${p.pacing})`)
    .join("\n");

  const prompt = [
    `You are a senior video editor exploring ${n} DISTINCT editorial directions for one cut.`,
    `Think like a director pitching options: each concept is a genuinely different FILM made from the same material — not a variation in degree but in kind.`,
    "",
    "EDITORIAL BRIEF:",
    JSON.stringify(brief, null, 2),
    "",
    "STORYBOARD:",
    storyboardSummary(item),
    "",
    "BRAND GENOME (content DNA — ground brandFit here):",
    genomeContextSafe(item.channel) || "(none)",
    "",
    "EDITING TASTE (learned editorial preferences + do-nots):",
    tasteContext(item.channel) || "(none)",
    "",
    `Produce EXACTLY ${n} concepts. Hard requirements:`,
    `- Force variety across EditStyle and pacing — do NOT return ${n} of the same style. Spread across e.g.:`,
    styleHints,
    "- Each concept commits to a coherent palette / typography / transition / sound intent that SERVES its style.",
    `- Grade ConceptScores (hook, pacing, emotion, brandFit, platformFit, overall) on 0-10 HONESTLY against THIS brief and platform (${brief.platform}). Do not flatter weak directions; a frenetic cut for a luxury brief should score low on brandFit.`,
    "- overall must reflect the real trade-offs, not an average — weight hook + platformFit for short-form, emotion + brandFit for brand films.",
    "- rationale: one tight paragraph on WHY this direction fits (or stretches) the brief.",
    "- Set id to empty string; it will be assigned.",
    "",
    `Return a JSON object of the form {"concepts": [ ...${n} concept objects... ]}.`,
  ].join("\n");

  // Concept generation is judgement-heavy but not the final cut — "smart" tier,
  // 2 retries for schema adherence. We parse permissively then normalize. If the
  // brain is wholly unavailable we DON'T fail the creative loop: we synthesize a
  // spread of palette-default directions so the EDL/passes still have a concept
  // to commit to (graceful degradation, like edl.ts/review.ts).
  let rawConcepts: any[];
  try {
    const { data } = await think(LooseConcepts, prompt, "smart", 2, "edit_concepts");
    rawConcepts = data.concepts;
  } catch (err) {
    logLine(item, `concepts: brain unavailable (${err instanceof Error ? err.message : String(err)}); using palette-default directions`);
    rawConcepts = STYLE_PALETTE.slice(0, n).map((p) => ({
      style: p.style,
      pacing: p.pacing,
      name: `${p.style.replace(/_/g, " ")} cut`,
      summary: `A ${p.style.replace(/_/g, " ")}, ${p.pacing}-paced take on ${brief.purpose}.`,
      rationale: "Palette-default direction (brain offline).",
    }));
  }

  // Normalize each loose model object into a strict EditConcept (enums clamped,
  // scores filled), using the style palette to backfill a sensible style/pacing
  // when the model omitted them. Then assign stable, unique ids keyed off style
  // (we own id assignment so chosenConcept lookups are reliable).
  const seen = new Set<string>();
  const concepts: EditConcept[] = rawConcepts.slice(0, n).map((c, i) => {
    const hint = STYLE_PALETTE[i % STYLE_PALETTE.length];
    const norm = normalizeConcept(c, hint.style, hint.pacing);
    return { ...norm, id: conceptId(norm.style, seen) };
  });

  item.concepts = concepts;
  // Re-choosing is a separate explicit step; clear any stale selection that no
  // longer points at a live concept so chooseConcept() isn't left dangling.
  if (item.chosenConcept && !concepts.some((c) => c.id === item.chosenConcept)) {
    item.chosenConcept = undefined;
  }
  logLine(item, `concepts: explored ${concepts.length} directions [${concepts.map((c) => c.style).join(", ")}]`);
  saveItem(item);
  return concepts;
}

/**
 * Commit to one concept. Picks by id, or — when omitted — the highest
 * scores.overall, tie-broken by brandFit then platformFit. Sets
 * item.chosenConcept and returns the chosen EditConcept.
 */
export function chooseConcept(id: string, conceptId?: string): EditConcept {
  const item = loadItem(id);
  const concepts = item.concepts ?? [];
  if (concepts.length === 0) {
    throw new Error(`no concepts to choose from for ${id} — run generateConcepts() first`);
  }

  let chosen: EditConcept | undefined;
  if (conceptId) {
    chosen = concepts.find((c) => c.id === conceptId);
    if (!chosen) {
      throw new Error(`concept "${conceptId}" not found on ${id} (have: ${concepts.map((c) => c.id).join(", ")})`);
    }
  } else {
    // Auto-pick the strongest: overall, then brandFit, then platformFit. A copy
    // sort keeps item.concepts in its explored order for the UI.
    chosen = [...concepts].sort((a, b) => {
      const s = b.scores;
      const t = a.scores;
      return (
        s.overall - t.overall ||
        s.brandFit - t.brandFit ||
        s.platformFit - t.platformFit
      );
    })[0];
  }

  item.chosenConcept = chosen.id;
  logLine(item, `concepts: chose "${chosen.name}" (${chosen.style}, overall ${chosen.scores.overall})`);
  saveItem(item);
  return chosen;
}
