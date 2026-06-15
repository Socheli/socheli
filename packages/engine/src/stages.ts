import { z } from "zod";
import {
  Idea,
  Script,
  Storyboard,
  QAReport,
  PostPackage,
  RULES,
  SCENE_TYPES,
  QA_DIMENSIONS,
  type ChannelDNA,
  type Storyboard as StoryboardT,
} from "@os/schemas";
import { think, type BrainResult } from "./brain.ts";
import { searchContext } from "./websearch.ts";
import { findFresh } from "./research/store.ts";
import { runResearch } from "./research/orchestrator.ts";
import { getMood } from "@os/tokens";
import { channelMoods } from "./channels.ts";
import { SPEAKABLE, brollGuidance } from "./prompt-shared.ts";

/* The channel's content clusters (moods) with each cluster's topic focus, for the
   idea/concept agents to choose among. Restricts mood to what the channel offers. */
const moodMenu = (c: ChannelDNA) =>
  channelMoods(c).map((m) => `- ${m.id}: ${getMood(m.id).blurb}${m.domain ? ` — TOPIC FOCUS: ${m.domain}` : ""}`).join("\n");
const moodDirectives = (moodId?: string) => {
  const m = getMood(moodId);
  return `MOOD: ${m.name}. Write in this register: ${m.tone}${m.quotes ? `\nWeave in ONE short, REAL, correctly-attributed quote from a well-known motivational speaker or leader that fits the topic. NEVER fabricate or misattribute a quote — if you are not certain it is real, omit it.` : ""}`;
};

const STYLE = `STYLE RULES (critical):
- NEVER use em dashes (—) or en dashes (–). Use commas, periods, or rephrase. This is the #1 tell of AI writing.
- Avoid AI-cliché phrasing: no "It's not X, it's Y", "Let's dive in", "In a world where", "game-changer", "unlock", "supercharge".
- Write like a sharp, specific human. Short, punchy sentences.`;

const ALL_FORMATS = ["mistake_fix", "terminal_tip", "before_after", "architecture_warning"];
const fmts = (c: ChannelDNA) => (c.formats && c.formats.length ? c.formats : ALL_FORMATS).join(" | ");

const dna = (c: ChannelDNA) =>
  `CHANNEL: ${c.name}
audience: ${c.audience}${c.domain ? `\nDOMAIN (every idea MUST be in this subject area, and ONLY this): ${c.domain}` : ""}
tone: ${c.tone}
visual style: ${c.visualStyle}${c.archetype ? `\nEDITORIAL ARCHETYPE (how this channel conceives a video — obey it when shaping ideas and storyboards): ${c.archetype}` : ""}
banned (never produce): ${c.bannedPatterns.join(", ")}
preferred hook shapes: ${c.preferredHooks.join(" | ")}`;

export const ideate = (c: ChannelDNA, seed: string, context = ""): Promise<BrainResult<Idea>> =>
  think(
    Idea,
    `You are the Content Strategist for ${c.name}, a faceless premium video channel.
${dna(c)}

Seed direction from the operator: "${seed}"
${context ? `\nPERFORMANCE + TREND CONTEXT (weight your idea toward this):\n${context}\n` : ""}
Turn this into ONE sharp, specific, non-generic content idea that fits this channel's DOMAIN.
Pick the strongest format from: ${fmts(c)}.
Be concrete and real. No hype. No fluff.

Also choose the single best-fit MOOD cluster for this idea from THIS CHANNEL's clusters
(each is a content cluster with its own topic focus + register):
${moodMenu(c)}
Return its id as "mood".

Return ONLY JSON: {"topic","angle","format","rationale","mood"}`,
    "smart",
    2,
    "idea_refine",
  );

/* ─── Concept selection ───────────────────────────────────────────────────
   The decision of WHAT to make. Propose a slate of candidate concepts, self-score
   each on the levers that actually drive short-form performance, and surface a
   ranked board. The operator (or autopilot) takes the top pick. This is the
   upstream of ideate(): ideate refines ONE idea; this chooses AMONG many. */
const ConceptScore = z.object({
  hook_potential: z.number().min(0).max(10),
  trend_fit: z.number().min(0).max(10),
  novelty: z.number().min(0).max(10),
  channel_fit: z.number().min(0).max(10),
  retention: z.number().min(0).max(10),
});
export const Concept = z.object({
  topic: z.string().min(3),
  angle: z.string(),
  format: Idea.shape.format,
  rationale: z.string(),
  scores: ConceptScore,
  overall: z.number().min(0).max(10),
  mood: z.string().optional(),
});
export type Concept = z.infer<typeof Concept>;
// A lenient Concept for the slate: cheaper models occasionally slip a mood into
// `format`, an out-of-range `overall`, or a missing score on a large slate.
// Coerce those back into range instead of failing the WHOLE parse (which would
// degrade the entire ideation to baseline stubs).
const VALID_FORMATS = ["mistake_fix", "terminal_tip", "before_after", "architecture_warning"] as const;
const clamp10 = z.preprocess((v) => Math.max(0, Math.min(10, Number(v) || 0)), z.number());
/* Robust 0–10 score coercion. Cheap models (gemini-flash, gpt-4o-mini) often wrap
   a score in an object ({"value":8} / {"score":8,"reason":…}) or a string — which
   a bare z.number() REJECTS, failing the whole stage. Pull the number out of any
   common shape, clamp to 0–10, never throw. */
const scoreNum = z.preprocess((v) => {
  if (typeof v === "number") return Math.max(0, Math.min(10, v));
  if (typeof v === "string") { const n = parseFloat(v); return Number.isFinite(n) ? Math.max(0, Math.min(10, n)) : 0; }
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    for (const k of ["value", "score", "rating", "overall", "number", "n"]) {
      const n = Number(o[k]); if (Number.isFinite(n)) return Math.max(0, Math.min(10, n));
    }
    for (const x of Object.values(o)) { const n = Number(x); if (Number.isFinite(n)) return Math.max(0, Math.min(10, n)); }
  }
  return 0;
}, z.number().min(0).max(10).catch(5));
const LenientConcept = Concept.extend({
  format: z.preprocess((v) => ((VALID_FORMATS as readonly string[]).includes(v as string) ? v : "before_after"), Idea.shape.format),
  overall: clamp10,
  scores: z.object({ hook_potential: clamp10, trend_fit: clamp10, novelty: clamp10, channel_fit: clamp10, retention: clamp10 }).partial().transform((s) => ({
    hook_potential: s.hook_potential ?? 5, trend_fit: s.trend_fit ?? 5, novelty: s.novelty ?? 5, channel_fit: s.channel_fit ?? 5, retention: s.retention ?? 5,
  })),
});
const ConceptBoard = z
  .object({
    concepts: z.array(LenientConcept).min(1),
    // index of the strongest concept — tolerant: some models return it as an array
    // (or a non-number) on a large slate; unwrap/default to 0 rather than fail.
    pick: z.preprocess((v) => (Array.isArray(v) ? Number(v[0]) : v), z.number().int().min(0).catch(0)),
  })
  // clamp pick into a valid index (models sometimes return concepts.length)
  .transform((b) => ({ ...b, pick: Math.max(0, Math.min(b.pick, b.concepts.length - 1)) }));
export const proposeConcepts = (
  c: ChannelDNA,
  context = "",
  n = 5,
  // Topics/angles the user has already seen — many REJECTED. Fed back so the
  // model stops re-proposing dismissed ideas (the #1 concept-board complaint).
  avoid: string[] = [],
): Promise<BrainResult<{ concepts: Concept[]; pick: number }>> =>
  think(
    ConceptBoard,
    `You are the Head of Content for ${c.name}, deciding what to publish next. ${dna(c)}
${context ? `\nPERFORMANCE + TREND CONTEXT (weight concepts toward this):\n${context}\n` : ""}
This channel publishes across these CONTENT CLUSTERS (moods), each with its own topic focus:
${moodMenu(c)}
${avoid.length ? `\nALREADY SHOWN — the user has reviewed these exact concepts and REJECTED or already queued them. Do NOT propose any of these again, and do NOT lightly reword or re-angle them. Bring genuinely different subjects:\n${avoid.map((a) => `- ${a}`).join("\n")}\n` : ""}
Propose ${n} DISTINCT, specific, non-overlapping content concepts SPREAD across these clusters.
Each concept MUST fit the TOPIC FOCUS of the cluster you assign it to (tag it with that cluster's
mood id as "mood"). Each must be concrete and specific (no generic "intro to X"). Pick the strongest
format per concept from: ${fmts(c)}.

Score each concept 0-10 on FIVE levers that drive short-form performance:
- hook_potential: can the first 1.5s stop a scroll?
- trend_fit: does it ride current attention/relevance?
- novelty: is the angle fresh vs. what everyone else posts?
- channel_fit: does it match this channel's audience + tone?
- retention: will it hold attention to the end?
overall = your honest weighted judgement (NOT a naive average; hook_potential and retention matter most).
Then set "pick" to the array index of the single best concept.

Tag each concept with the cluster mood it belongs to as "mood".
${STYLE}

Return ONLY JSON: {"concepts":[{"topic","angle","format","rationale","scores":{"hook_potential","trend_fit","novelty","channel_fit","retention"},"overall","mood"}],"pick":<index>}`,
    "best",
    2,
    "concept_propose",
  );

/* Trend-aware: surface currently-relevant angles in this channel's domain. */
const TrendSet = z.object({ angles: z.array(z.string()).min(2) });
export const scanTrends = async (c: ChannelDNA): Promise<BrainResult<{ angles: string[] }>> => {
  // §2 research harness: reuse a fresh cached trend run (≤24h) or kick a quick
  // verified run. The cache key ("<domain ?? name> trends" + channel) matches
  // dna.ts evolveGenome's freshResearch lookup EXACTLY so evolution reuses the
  // same entries. Legacy raw searchContext stays as the fallback path.
  let web = "";
  try {
    const q = `${c.domain ?? c.name} trends`;
    const run = findFresh("trend", q, 24, c.id) ?? (await runResearch({ kind: "trend", query: q, channel: c.id, depth: "quick" }));
    web = (run.report ?? "").slice(0, 4000);
  } catch {
    web = searchContext(`${c.domain ?? c.audience} trending discussions 2026`, 6);
  }
  return think(
    TrendSet,
    `You track what is currently resonating for ${c.name}. ${dna(c)}
${web ? `\nLIVE WEB SEARCH (ground your angles in these real, current results):\n${web}\n` : ""}
List 4-6 specific, timely angles/topics getting attention RIGHT NOW, STRICTLY within this channel's
DOMAIN above (do not stray into other subjects). Be concrete, not evergreen-generic.
Return ONLY JSON: {"angles":[short specific strings]}`,
    "smart",
    2,
    "trend_scan",
  );
};

/* Fact-check: catch wrong/dubious technical claims before they ship. */
const FactReport = z.object({ ok: z.boolean(), issues: z.array(z.string()) });
export const factCheck = (c: ChannelDNA, script: Script, sb: Storyboard): Promise<BrainResult<{ ok: boolean; issues: string[] }>> => {
  const web = searchContext(`${sb.topic} facts evidence`, 6);
  return think(
    FactReport,
    `You are a rigorous fact-checker for ${c.name}. Review every factual/technical claim in this
script and storyboard. Flag anything false, misleading, outdated, or unverifiable.
${web ? `\nLIVE WEB SEARCH (check claims against these real sources):\n${web}\n` : ""}
script=${JSON.stringify(script)}
storyboard=${JSON.stringify(sb)}
ok=true only if there are NO material problems.
Return ONLY JSON: {"ok":true|false,"issues":[specific problems, empty if ok]}`,
    "smart",
    2,
    "factcheck",
  );
};

/* Self-revision: rebuild a better storyboard given QA + fact-check feedback. */
export const reviseStoryboard = (
  c: ChannelDNA,
  idea: Idea,
  script: Script,
  sb: Storyboard,
  feedback: string[],
): Promise<BrainResult<Storyboard>> =>
  think<StoryboardT>(
    Storyboard,
    `You are the Storyboard Agent revising a storyboard that did not pass review. Fix the
problems while keeping the same channel/theme/format and the scene vocabulary + shapes.
FEEDBACK TO ADDRESS:
${feedback.map((f) => `- ${f}`).join("\n")}

CURRENT STORYBOARD: ${JSON.stringify(sb)}
idea=${JSON.stringify(idea)} script=${JSON.stringify(script)}
Keep every scene's "say", "broll" and "emphasis" fields. channel MUST be "${c.id}", theme "${c.theme}".
Return ONLY the full improved Storyboard JSON.`,
    "best",
    2,
    "storyboard_revise",
  );

/* Hook engineering: generate several distinct hooks, self-score for scroll-stopping
   power, keep the best. The first 1.5s decides retention, so this is worth a call. */
const HookSet = z.object({
  hooks: z.array(z.object({ text: z.string(), score: scoreNum, why: z.string() })).min(4),
  best: z.string(),
});
export const pickHook = (c: ChannelDNA, idea: Idea, moodId?: string): Promise<BrainResult<{ best: string }>> =>
  think(
    HookSet,
    `You are a viral short-form hook writer for ${c.name}. ${dna(c)}

IDEA: ${JSON.stringify(idea)}
${moodDirectives(moodId)}

Write 5 DISTINCT opening hooks (the first spoken+on-screen line). Each <= ${RULES.maxTitleWords} words.
Score each 0-10 on: scroll-stopping power, curiosity gap, specificity, and fit to this channel's tone.
Then pick the single best. No generic openers, no "in this video", no hype, no clichés.
${STYLE}

Return ONLY JSON: {"hooks":[{"text","score","why"}...],"best":"<the winning hook text>"}`,
    "best",
    2,
    "hook_pick",
  ).then((r) => ({ data: { best: r.data.best }, usd: r.usd }));

export const writeScript = (c: ChannelDNA, idea: Idea, fixedHook: string, moodId?: string, guidance = ""): Promise<BrainResult<Script>> =>
  think(
    Script,
    `You are the Script Agent for ${c.name}. ${dna(c)}

IDEA: ${JSON.stringify(idea)}
${moodDirectives(moodId)}
The HOOK is already chosen and FIXED. Use it verbatim as "hook": "${fixedHook}"

Write a tight script for a ~40s vertical short, building from that exact hook.
RULES:
- hook: return EXACTLY "${fixedHook}" (do not change it).
- beats: 2-6 short content beats (the spine of the video).
- narration: 2-6 short spoken lines (natural, serious, no "in this video").
- cta: one light call to action.
Every line must be specific and technically true. Kill generic filler.
${guidance ? `\nEXTRA DIRECTION FROM THE OPERATOR (obey this): ${guidance}\n` : ""}${STYLE}

Return ONLY JSON: {"hook","beats":[...],"narration":[...],"cta"}`,
    "smart",
    2,
    "script_write",
  );

const SHAPE_LINES: Record<string, string> = {
  hook_text: `- hook_text:   {id,type:"hook_text",durationSec,text(<=${RULES.maxTitleWords} words),motion:"slam_in"|"fade_in_up"}`,
  terminal: `- terminal:    {id,type:"terminal",durationSec,path,status:"ok"|"error",lines:[{kind:"user"|"assistant"|"tool"|"file"|"error"|"warning"|"ok"|"blank",text}]}`,
  before_after: `- before_after:{id,type:"before_after",durationSec,caption?,left:{title,text,bad:true},right:{title,text,bad:false}}`,
  code_block: `- code_block:  {id,type:"code_block",durationSec,language,title?,code,focusLines:[ints]}`,
  kinetic_text: `- kinetic_text:{id,type:"kinetic_text",durationSec,lines:[1-4 short lines],highlight:[exact substrings to color]}`,
  warning: `- warning:     {id,type:"warning",durationSec,level:"info"|"warning"|"danger",text}`,
  cta: `- cta:         {id,type:"cta",durationSec,text,handle?}`,
  big_number: `- big_number:  {id,type:"big_number",durationSec,value:"80ms"|"1890"|"3x"|"90%",label:"short caption"}  — a giant stat/number for a punchy data moment`,
  quote: `- quote:       {id,type:"quote",durationSec,text:"the quote (<=18 words)",author?:"name"}  — a full-screen quote moment`,
  image_focus: `- image_focus: {id,type:"image_focus",durationSec,caption:"one short line"}  — lets the b-roll breathe full-bleed with a single lower-third caption`,
  grid: `- grid:        {id,type:"grid",durationSec,layout:"rows"|"cols",cells:[{title,text,query}]x2-3}  — the FRAME splits into 2-3 full-bleed sections (rows or cols), each with its own background; give every cell a 2-5 word visual "query" (like broll). Great for comparing or step-by-step.`,
  chart: `- chart:       {id,type:"chart",durationSec,title?,unit?:"%"|"ms"|"k",bars:[{label,value:number}]x2-5}  — animated vertical bar chart; bars grow from 0 and values count up. Use to compare 2-5 quantities.`,
  diagram: `- diagram:     {id,type:"diagram",durationSec,direction:"vertical"|"horizontal",nodes:[{label}]x2-4}  — node-flow diagram; rounded cards appear staggered with connector arrows drawing in between them. Great for a "how it works" / step-by-step pipeline.`,
  timeline: `- timeline:    {id,type:"timeline",durationSec,events:[{time?,label}]x2-4}  — chronological timeline; a vertical axis draws down with event dots + time eyebrow + label appearing staggered top to bottom. Calm, sequential. Great for history, a sequence of steps, or "how it evolved".`,
  map: `- map:         {id,type:"map",durationSec,caption?,points:[{label}]x1-3}  — stylized abstract location moment (NOT a real map); a dark dotted field, a glowing accent route that draws in, and pulsing pin markers each with a label. Great for "where", places, regions, or a journey between locations.`,
  device_mockup: `- device_mockup:{id,type:"device_mockup",durationSec,device:"browser"|"phone"|"window",app?:"url or app name",headline?:"one short line",rows:[{text,value?,accent?:true}]x1-6}  — an animated product UI inside a device frame; rows slide in staggered, mark ONE row accent:true as the primary action/metric. Pure motion graphics, no footage. Great for showing a product, dashboard, app flow, or feature.`,
  bento: `- bento:       {id,type:"bento",durationSec,heading?,cards:[{title,text?}]x2-6}  — a bento grid of feature/benefit cards that pop in staggered (first card emphasized). Pure motion graphics. Great for "what you get", features, or a set of benefits.`,
  stats: `- stats:       {id,type:"stats",durationSec,heading?,stats:[{value:"10x"|"92%"|"3.2s",label}]x2-4}  — a row of 2-4 BIG metrics that count up together. Pure motion graphics. Great for a punchy set of results/numbers.`,
  compare: `- compare:     {id,type:"compare",durationSec,a:"hero label",b:"alternative label",rows:[{feature,a:true|false,b:true|false}]x2-5}  — an "us vs them" feature checklist; rows tick in with ✓/✗ across two columns (a=hero/accent). Pure motion graphics. Great for "why us" / before-vs-after capability.`,
  dialogue: `- dialogue:    {id,type:"dialogue",durationSec,title?:"SEGMENT HEADER",subtitle?:"context line",lines:[{role:"OPERATOR"|"COMMANDER"|"ANALYST"|"REPORTER"|custom,text:"one line of spoken analysis"}]x1-6}  — intelligence-briefing format; each line types in sequentially with a colored role prefix (OPERATOR=teal, COMMANDER=red). Dark tactical background with grid overlay. Use for ops_room/war_economy moods: OPERATOR delivers the intel, COMMANDER responds. Max 6 lines, each under 15 words.`,
};

export const buildStoryboard = (c: ChannelDNA, idea: Idea, script: Script, moodId?: string, guidance = ""): Promise<BrainResult<Storyboard>> => {
  const mood = getMood(moodId);
  // Per-channel allowlist: e.g. general channels exclude the dev terminal/code_block visuals.
  // Pure motion-graphics moods (noBroll) override the channel vocabulary with the
  // footage-FREE mograph set — enabling device_mockup/bento/stats/compare and
  // dropping footage-dependent scenes (image_focus/grid/map) that would render empty.
  const MOGRAPH_TYPES = ["hook_text", "kinetic_text", "big_number", "quote", "before_after", "warning", "chart", "diagram", "timeline", "device_mockup", "bento", "stats", "compare", "cta"] as const;
  const allowed = (
    mood.noBroll
      ? MOGRAPH_TYPES.filter((t) => !c.sceneTypes?.length || c.sceneTypes!.includes(t) || ["device_mockup", "bento", "stats", "compare", "chart", "diagram", "timeline"].includes(t))
      : c.sceneTypes?.length
        ? SCENE_TYPES.filter((t) => c.sceneTypes!.includes(t))
        : SCENE_TYPES
  ) as readonly string[];
  const has = (t: string) => allowed.includes(t);
  const shapes = allowed.map((t) => SHAPE_LINES[t]).filter(Boolean).join("\n");
  const visualMenu = allowed.filter((t) => ["terminal", "code_block", "before_after", "warning", "kinetic_text", "big_number", "quote", "image_focus", "device_mockup", "bento", "stats", "compare", "dialogue"].includes(t)).join(", ");
  // This mood's preferred components (intersected with what the channel allows).
  const preferred = mood.components.filter((t) => allowed.includes(t));

  return think<StoryboardT>(
    Storyboard,
    `You are the Storyboard Agent. Convert the script into a deterministic storyboard the
renderer can execute. You may ONLY use these scene types: ${allowed.join(", ")}.${has("terminal") || has("code_block") ? "" : `
This is a general-audience channel: NEVER use terminal, code, command-line, or developer visuals.`}

EVERY scene MUST include a "say" field: ONE punchy spoken sentence (max ~16 words) that
is narrated WHILE that scene is on screen. The "say" must describe/echo what is visible
in that scene so audio and visuals stay in sync. Keep on-screen text minimal; let "say"
carry the explanation. Energetic, high-tempo delivery, short sentences, forward momentum.
${SPEAKABLE}

${mood.noBroll
  ? (mood.id === "ops_room" || mood.id === "war_economy")
    ? `THIS IS A PURE MOTION-GRAPHICS video with a NATIVE ANIMATED BACKGROUND — no stock footage needed. Do NOT include a "broll" field on any scene.
Scenes render on a self-generated tactical/newsroom animated bg. Use: dialogue (1-2 max, for key intel reveals), map, chart, timeline, big_number, kinetic_text, before_after, warning. Lead with hard data on every scene.`
    : `THIS IS A PURE MOTION-GRAPHICS video: do NOT use any stock footage. OMIT the "broll" field entirely.
The whole story is told with animated graphics — favour device_mockup (show the product/UI), bento
(features/benefits), big_number (stats), chart (comparisons), diagram (how it works), kinetic_text and
before_after. Make at least HALF the scenes device_mockup or bento so it feels like a premium product explainer.`
  : `EVERY scene MUST also include "broll": {"query","kind"} for the moody background footage:
- query: 2-5 vivid VISUAL words for cinematic stock/imagery (e.g. "slow motion storm clouds",
  "neurons firing blue", "lone figure city night", "data center server lights"). Concrete nouns,
  not abstractions. Describe a SHOT, not the topic.
- kind: "concrete" if a real camera could film it (places, objects, nature, people-from-behind)
  → uses stock footage. "abstract" if it's conceptual/impossible → uses a generated image.
${brollGuidance(`${idea.topic}:${moodId ?? ""}`, mood.footageStyle)}`}

EMPHASIS: set "emphasis": true on the 1-2 scenes that are the EMOTIONAL PEAKS of the script
(the hook's payoff, the key reveal, or the punchline). Those scenes get a beat-synced punch
for a "high". Every other scene MUST be "emphasis": false (calm "lows"). Default false.

SCENE SHAPES (use exactly these fields, plus "say"):
${shapes}

CONSTRAINTS:
- 5 to ${RULES.maxScenes} scenes for a snappy, high-tempo edit. Each durationSec ${RULES.minSceneDuration}-6 (short!). Total ${RULES.minTotalDuration}-${RULES.maxTotalDuration}s.
- Open with hook_text. Close with cta. One idea per scene.${has("terminal") ? "\n- Use a terminal scene if the topic touches the CLI." : ""}
- MOOD: ${mood.name}. FAVOUR these components for this mood (use a varied MIX, don't repeat one type): ${preferred.join(", ") || visualMenu}.
- VARY THE STRUCTURE: do NOT make every video the same skeleton. Mix component TYPES across the
  middle scenes — e.g. a big_number for a stat, a quote for a punch, an image_focus to breathe,
  before_after for contrast. Avoid using the same scene type back-to-back. Surprise the viewer.
- Use big_number whenever the script has a number/stat. Use quote for a memorable line or a real
  attributed quote. Use image_focus for an emotional/visual beat that needs no card. Use chart for
  comparisons of magnitudes, diagram for how-it-works flows, timeline for chronology, map for "where".${has("dialogue") ? `
- DIALOGUE SCENES (ops_room / war_economy): use dialogue for the 1-2 most dramatic information-reveals.
  OPERATOR delivers the intel fact; COMMANDER challenges, qualifies, or asks. Each line ≤15 words.
  Set the title to match the episode/segment header (e.g. "OPERATIONS ROOM — EP.${Math.floor(Math.random() * 50) + 100}").
  Do NOT over-use dialogue — 1-2 per video max; the rest should be map/image_focus/chart/kinetic_text.` : ""}
- PACE BY ARC: snap the hook (shortest durationSec, ${RULES.minSceneDuration}-3s), build through the
  middle, let the KEY REVEAL / emphasis scene BREATHE (longest, 5-6s), then keep momentum to the cta.
  Do NOT give every scene the same duration.
- LESS TEXT, MORE GRAPHICS: the karaoke captions carry the narration, so keep on-screen text
  minimal. Prefer visual scenes (${visualMenu}). hook_text <= 6 words.
  kinetic_text: max 3 lines, each <= 4 words. Never put a full sentence on screen.
  IMPORTANT: domain names (e.g. "moltjobs.io", "socheli.com", any "name.tld") must NEVER be split across lines — they must appear as a single atomic token on ONE line.
- theme MUST be "${c.theme}". channel MUST be "${c.id}".
${STYLE}

${guidance ? `EXTRA DIRECTION FROM THE OPERATOR (obey this): ${guidance}\n` : ""}CONTEXT:
idea=${JSON.stringify(idea)}
script=${JSON.stringify(script)}

Return ONLY JSON for the full Storyboard:
{"channel":"${c.id}","theme":"${c.theme}","topic":"${idea.topic}","format":"${idea.format}","hook":"${script.hook}","fps":30,"width":1080,"height":1920,"scenes":[...],"cta":"${script.cta}"}`,
    "best",
    2,
    "storyboard_build",
  );
};

export const runQA = (c: ChannelDNA, sb: Storyboard, script: Script): Promise<BrainResult<QAReport>> =>
  think(
    QAReport,
    `You are the QA Council for ${c.name}, a premium faceless tech channel. Be a harsh,
fair critic. Score this content 0-10 on each dimension. Punish AI-slop, generic claims,
hype, and anything that feels mass-produced. Reward specificity and real technical insight.
${dna(c)}

DIMENSIONS: ${QA_DIMENSIONS.join(", ")}
script=${JSON.stringify(script)}
storyboard=${JSON.stringify(sb)}

verdict: "pass" if it is genuinely publication-grade (overall >= 7 and no dimension < 5),
"revise" if fixable, "kill" if hopeless.

Return ONLY JSON: {"scores":{${QA_DIMENSIONS.map((d) => `"${d}":n`).join(",")}},"overall":n,"verdict":"pass"|"revise"|"kill","notes":[short strings]}`,
    "smart",
    2,
    "qa_review",
  );

export const packagePost = (c: ChannelDNA, sb: Storyboard, script: Script, context = ""): Promise<BrainResult<PostPackage>> => {
  const platforms = (c.socials ?? ["Instagram", "X"]).map((s) => s.toLowerCase()).join(", ");
  return think(
    PostPackage,
    `You are the Publisher + SEO/discovery strategist for ${c.name}. ${dna(c)}
This video will be posted on: ${platforms}.
${context ? `\nCurrent trend/performance context (use for timely, relevant tags):\n${context}\n` : ""}
storyboard=${JSON.stringify(sb)}
script=${JSON.stringify(script)}

Produce a base package AND a tailored "platforms" entry for EACH platform above, following each
platform's real conventions and a deliberate hashtag SIZE-MIX (rank in small/niche tags while
reaching via big ones). Relevant tags only — never spammy, generic, or banned tags.
- youtube: title <= 80 chars, keyword-front-loaded + curiosity. caption: 2-3 lines, value first,
  then EXACTLY 3 hashtags. "keywords": 10-15 SEO search terms people would type.
- instagram: caption = hook + 1-2 value lines + soft CTA. hashtags: 10-15 mixed —
  ~3 broad, ~5 medium niche, ~4 small specific, + 1 branded.
- tiktok: caption = 1-2 punchy lines leading with the hook. hashtags: 4-6 (1-2 broad, rest niche).
- x: caption <= 270 chars, conversational. hashtags: max 1-2.
Only include platforms in the posted-on list. Lowercase hashtags, no leading '#'.
${STYLE}

Return ONLY JSON: {"title","caption","hashtags":[6-10],"altText","platforms":[{"platform","title?","caption","hashtags":[...],"keywords?":[...]}]}`,
    "smart",
    2,
    "package_post",
  );
};
