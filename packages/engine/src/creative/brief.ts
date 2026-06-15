import {
  EditBrief,
  type ContentItem,
  type TargetPlatform,
  type SceneFunction,
} from "@os/schemas";
import { loadItem, saveItem, nowIso, logLine } from "../store.ts";
import { think } from "../brain.ts";
import { genomeContextSafe } from "../dna.ts";
import { tasteContext, loadTaste } from "./taste.ts";

/* creative/brief.ts — infer the editorial BRIEF before any cutting.

   A strong editor decides what the cut is FOR before touching a single scene.
   This module reads everything we already know about a run — the seed idea, the
   written script (hook/narration/cta), the storyboard (topic/format/scenes), the
   channel's learned Brand Genome, and the channel's editing taste — and asks the
   smart brain to commit that into one grounded EditBrief: a concrete purpose,
   the audience, the desired feeling, a story arc tagged with SceneFunctions, the
   hard constraints (aspect, language), the taste guardrails, and a hook window.

   The brief becomes item.brief and grounds every later stage (concepts → EDL →
   passes → review). It is inferred, not invented: the prompt is fed only real
   signal from this run + brand, and the output is parsed at the boundary so a
   malformed direction never persists. */

/* Default platform from the run's kind. The brief's platform drives pacing,
   hook window and aspect downstream, so we pick a sensible vertical/horizontal
   default unless the caller overrides it. */
function defaultPlatform(item: ContentItem): TargetPlatform {
  // longform = the 16:9 multi-chapter YouTube pipeline; everything else is a
  // vertical short-form Reel by default (the most common path).
  return item.kind === "longform" ? "youtube" : "instagram_reel";
}

/* Compact, human-readable digest of the run's existing content for the prompt.
   We deliberately summarise rather than dump full JSON: the brain reasons better
   over a tight brief of intent than over the render contract, and it keeps the
   prompt cheap. Everything here is best-effort — a run with only a seed idea
   still produces a usable brief. */
function runDigest(item: ContentItem): string {
  const sb = item.storyboard;
  const sc = item.script;
  const lines: string[] = [];

  lines.push(`Seed idea: ${item.seedIdea}`);
  if (item.idea?.topic) lines.push(`Topic: ${item.idea.topic}`);
  if (item.idea?.format) lines.push(`Format: ${item.idea.format}`);
  if (item.mood) lines.push(`Mood preset: ${item.mood}`);
  lines.push(`Kind: ${item.kind ?? "short"}`);

  if (sc) {
    lines.push(`Hook line: "${sc.hook}"`);
    if (sc.beats?.length) lines.push(`Beats: ${sc.beats.join(" | ")}`);
    if (sc.narration?.length) lines.push(`Narration: ${sc.narration.join(" / ")}`);
    lines.push(`CTA: "${sc.cta}"`);
  } else if (sb) {
    // No script yet — fall back to the storyboard's own hook/cta.
    lines.push(`Hook: "${sb.hook}"`);
    lines.push(`CTA: "${sb.cta}"`);
  }

  if (sb) {
    lines.push(`Aspect: ${sb.aspect ?? `${sb.width}x${sb.height}`} (${sb.width}x${sb.height})`);
    lines.push(`Scene count: ${sb.scenes.length}`);
    // The on-screen lines per scene, in order — the raw material the arc maps onto.
    const beats = sb.scenes
      .map((s, i) => {
        const text = s.say || (s.type === "hook_text" ? "hook" : s.type);
        return `${i + 1}. [${s.type}] ${String(text).slice(0, 60)}`;
      })
      .join("\n");
    lines.push(`Scenes:\n${beats}`);
  }
  return lines.join("\n");
}

/* Derive hard constraints we KNOW are true (so the brain doesn't have to guess
   them and can't contradict them). Aspect comes straight off the storyboard
   geometry; everything else is left to the brain to infer from the digest. */
function knownConstraints(item: ContentItem): string[] {
  const out: string[] = [];
  const sb = item.storyboard;
  if (sb) {
    const aspect = sb.aspect ?? (sb.width > sb.height ? "16:9" : sb.width === sb.height ? "1:1" : "9:16");
    out.push(aspect);
  } else if (item.kind === "longform") {
    out.push("16:9");
  } else {
    out.push("9:16");
  }
  return out;
}

/* inferBrief — produce + persist the editorial brief for a run.

   Gathers run signal + brand genome + editing taste, asks the smart brain for a
   grounded EditBrief, then merges caller overrides last and saves it onto the
   item. The structureArc is constrained to valid SceneFunction values both by
   the prompt AND by the EditBrief zod parse at the boundary, so a bad arc is
   rejected loudly rather than persisted. */
export async function inferBrief(
  id: string,
  opts?: { platform?: TargetPlatform; overrides?: Partial<EditBrief> },
): Promise<EditBrief> {
  const item = loadItem(id);
  const platform = opts?.platform ?? defaultPlatform(item);
  // Social shorts must hook in ~3s; long-form YouTube can take longer to land
  // the promise, so a wider window is correct there.
  const isSocial = platform !== "youtube" && platform !== "brand_film";
  const hookWindowSec = isSocial ? 3 : 6;

  // Ground the prompt in the brand: learned genome + the channel's editing taste.
  // Both are fail-open — a missing genome file or taste record degrades to an
  // empty block rather than breaking brief inference.
  const genome = genomeContextSafe(item.channel);
  let taste = "";
  let tasteDoNots: string[] = [];
  try {
    taste = tasteContext(item.channel);
    tasteDoNots = loadTaste(item.channel).doNots.map((d) => d.rule);
  } catch {
    /* taste store unavailable — brief still infers from genome + run signal */
  }

  const validFns: SceneFunction[] = [
    "hook",
    "context",
    "problem",
    "tension",
    "idea",
    "proof",
    "example",
    "resolution",
    "cta",
    "b_roll",
    "transition",
  ];
  const sceneCount = item.storyboard?.scenes.length ?? 0;

  const prompt = [
    `You are the editorial DIRECTOR for a faceless premium ${item.kind === "longform" ? "long-form (16:9)" : "vertical (9:16)"} video.`,
    `Decide what this cut is FOR before any cutting begins. Be concrete and grounded ONLY in the signals below — do not invent facts.`,
    "",
    `TARGET PLATFORM: ${platform}`,
    "",
    "THIS RUN:",
    runDigest(item),
    "",
    genome ? `BRAND GENOME:\n${genome}` : "",
    taste ? `EDITING TASTE:\n${taste}` : "",
    "",
    "PRODUCE an EditBrief JSON with these fields:",
    `- purpose: ONE concrete sentence — what this video must achieve, for whom, on ${platform}.`,
    `- platform: "${platform}".`,
    `- audience: who this is for (specific, from the topic/brand).`,
    `- feeling: 2-4 emotional-register words the cut should evoke.`,
    `- structureArc: the intended story arc as an ordered array of beat FUNCTIONS.`,
    `    Use ONLY these values: ${validFns.join(", ")}.`,
    sceneCount
      ? `    Roughly ${sceneCount} entries (one per scene), opening with "hook" and usually closing on "cta".`
      : `    A tight arc that opens with "hook" and closes on "cta".`,
    `- constraints: HARD rules. MUST include the aspect (${knownConstraints(item).join(", ")}). Add language/length only if implied.`,
    `- doNots: taste guardrails (seed from the editing taste do-nots, add any obvious ones).`,
    `- references: 0-3 reference looks/brands ONLY if clearly implied; else [].`,
    `- hookWindowSec: ${hookWindowSec}.`,
    `- notes: optional one-line editorial steer.`,
    "",
    `Return ONLY the JSON object.`,
  ]
    .filter(Boolean)
    .join("\n");

  const { data } = await think(EditBrief, prompt, "smart", 2, "edit_brief");

  // Merge known-true facts the brain shouldn't be trusted to derive, then the
  // caller's explicit overrides last (overrides always win). We re-parse the
  // merged shape so the final brief is schema-valid even after the merge.
  const knownAspect = knownConstraints(item);
  const mergedConstraints = [...new Set([...knownAspect, ...(data.constraints ?? [])])];
  const mergedDoNots = [...new Set([...tasteDoNots, ...(data.doNots ?? [])])];

  const brief = EditBrief.parse({
    ...data,
    platform, // pin the resolved platform regardless of what the brain echoed
    constraints: mergedConstraints,
    doNots: mergedDoNots,
    hookWindowSec: data.hookWindowSec ?? hookWindowSec,
    ...(opts?.overrides ?? {}), // caller intent is authoritative
    updatedAt: nowIso(),
  });

  item.brief = brief;
  logLine(item, `brief: inferred editorial brief for ${platform} — "${brief.purpose.slice(0, 80)}"`);
  saveItem(item);
  return brief;
}
