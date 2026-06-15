import { z } from "zod";
import {
  ChapterBoard,
  SCENE_TYPES,
  type ChannelDNA,
  type ChapterOutline,
  type LongformOutline,
  type ChapterBoard as ChapterBoardT,
} from "@os/schemas";
import { think, type BrainResult } from "./brain.ts";
import { getMood, getSubMood } from "@os/tokens";
import { SPEAKABLE, brollGuidance } from "./prompt-shared.ts";

/* ════════════════════════════════════════════════════════════════════════
   LONG-FORM CHAPTER PIPELINE — one chapter outline → finished chapter.
   writeChapter() writes THIS chapter's spoken narration (grounded in the
   research cache + the video thesis). buildChapterBoard() turns that
   narration into a 16:9 ChapterBoard (chapter_title + scenes that deliver
   the lines). qaChapter() grades the result. Mirrors stages.ts conventions:
   the same scene SHAPES, the same "say"/"broll"/"emphasis" rules.
   ════════════════════════════════════════════════════════════════════════ */

const STYLE = `STYLE RULES (critical):
- NEVER use em dashes (—) or en dashes (–). Use commas, periods, or rephrase. This is the #1 tell of AI writing.
- Avoid AI-cliché phrasing: no "It's not X, it's Y", "Let's dive in", "In a world where", "game-changer", "unlock", "supercharge".
- Write like a sharp, specific human. Short, punchy sentences.`;

const dna = (c: ChannelDNA) =>
  `CHANNEL: ${c.name}
audience: ${c.audience}${c.domain ? `\nDOMAIN (stay strictly within this subject area): ${c.domain}` : ""}
tone: ${c.tone}
visual style: ${c.visualStyle}${c.archetype ? `\nEDITORIAL ARCHETYPE (the lens for how this video is conceived and structured — obey it): ${c.archetype}` : ""}
banned (never produce): ${c.bannedPatterns.join(", ")}`;

const moodDirectives = (moodId?: string) => {
  const m = getMood(moodId);
  return `MOOD: ${m.name}. Write in this register: ${m.tone}`;
};

/* Same scene-shape vocabulary the shorts storyboard agent uses, plus the two
   long-form anchor types (chapter_title, section_summary). */
const SHAPE_LINES: Record<string, string> = {
  hook_text: `- hook_text:   {id,type:"hook_text",durationSec,text(<=9 words),motion:"slam_in"|"fade_in_up"}`,
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
  chapter_title: `- chapter_title:{id,type:"chapter_title",durationSec,number,title,kicker?}  — the chapter's opening title card (number + title, optional small kicker label above).`,
  section_summary: `- section_summary:{id,type:"section_summary",durationSec,heading?,points:[1-4 short takeaways]}  — a short recap card listing this section's takeaways.`,
};

/* ─── 1. writeChapter — the spoken narration for THIS chapter only ───────── */
const ChapterNarration = z.object({ narration: z.array(z.string()).min(2) });

export const writeChapter = (
  c: ChannelDNA,
  mood: string,
  outline: LongformOutline,
  chapter: ChapterOutline,
  research: string,
): Promise<BrainResult<{ narration: string[] }>> =>
  think(
    ChapterNarration,
    `You are the Script Agent for ${c.name}, writing ONE chapter of a long-form video.
${dna(c)}
${moodDirectives(mood)}

VIDEO TITLE: ${outline.title}
VIDEO THESIS (the through-line every chapter must serve): ${outline.thesis}

THIS CHAPTER (chapter ${chapter.number}): "${chapter.title}"
sub-mood: ${chapter.subMood} — ${getSubMood(chapter.subMood).purpose}
purpose: ${chapter.purpose}
points this chapter MUST cover:
${chapter.points.map((p) => `- ${p}`).join("\n")}

RESEARCH CACHE (ground every claim in this; do not invent facts beyond it):
${research || "(no research provided — stay general and only state what you are certain is true)"}

Write the SPOKEN narration for THIS chapter ONLY. Natural, accurate, specific lines that
cover every point above, grounded in the research cache, and consistent with the THESIS.
Stay in the channel + mood register. 6-14 short spoken lines, in order.
NO "in this video", no meta narration, no AI clichés, no em dashes. Keep each line tight.
${SPEAKABLE}
${STYLE}

Return ONLY JSON: {"narration":[short spoken lines]}`,
    "smart",
    2,
    "longform_narration",
  );

/* ─── 2. buildChapterBoard — narration → 16:9 ChapterBoard ───────────────── */
export const buildChapterBoard = (
  c: ChannelDNA,
  mood: string,
  chapter: ChapterOutline,
  narration: string[],
): Promise<BrainResult<ChapterBoard>> => {
  // Per-channel allowlist (same as shorts), but always permit the long-form anchors.
  const base = (c.sceneTypes?.length ? SCENE_TYPES.filter((t) => c.sceneTypes!.includes(t)) : SCENE_TYPES) as readonly string[];
  const allowed = Array.from(new Set([...base, "chapter_title", "section_summary"]));
  const has = (t: string) => allowed.includes(t);
  const shapes = allowed.map((t) => SHAPE_LINES[t]).filter(Boolean).join("\n");
  const visualMenu = allowed
    .filter((t) => ["before_after", "warning", "kinetic_text", "big_number", "quote", "image_focus", "grid", "chart", "diagram", "timeline", "map"].includes(t))
    .join(", ");
  const sub = getSubMood(chapter.subMood);
  const baseMood = getMood(mood);
  // This sub-mood's preferred components, intersected with what the channel allows.
  const preferred = sub.components.filter((t) => allowed.includes(t));

  return think<ChapterBoardT>(
    ChapterBoard,
    `You are the Storyboard Agent building ONE chapter of a long-form 16:9 video for ${c.name}.
Convert the chapter's narration into a deterministic ChapterBoard the renderer can execute.
You may ONLY use these scene types: ${allowed.join(", ")}.${has("terminal") || has("code_block") ? "" : `
This is a general-audience channel: NEVER use terminal, code, command-line, or developer visuals.`}

THIS RENDERS AT 16:9 (1920x1080). Prefer FULL-BLEED / WIDE layouts (image_focus, grid, chart,
diagram, timeline, map). The sub-mood layout bias is "${sub.layout}". Compose for a wide frame.

CHAPTER ${chapter.number}: "${chapter.title}"  (sub-mood: ${sub.name} — ${sub.purpose})
${moodDirectives(mood)} Base visual mood: ${baseMood.name}.

NARRATION (deliver THIS, in order — one scene roughly per line, do not add facts):
${narration.map((n, i) => `${i + 1}. ${n}`).join("\n")}

REQUIRED STRUCTURE:
- The FIRST scene MUST be a chapter_title with number=${chapter.number} and title="${chapter.title}".
- Then 5-14 more scenes that DELIVER the narration above, in order.

EVERY scene MUST include a "say" field: ONE spoken sentence (max ~18 words), drawn from or
echoing the narration line that scene delivers. The "say" must describe/echo what is visible
in that scene so audio and visuals stay in sync. Keep on-screen text minimal; let "say" carry it.

EVERY scene MUST also include "broll": {"query","kind"} for the moody background footage:
- query: 2-5 vivid VISUAL words for cinematic stock/imagery (concrete nouns, describe a SHOT,
  not the topic — e.g. "slow motion storm clouds", "data center server lights", "lone figure city night").
- kind: "concrete" if a real camera could film it (places, objects, nature, people-from-behind)
  → stock footage. "abstract" if it's conceptual/impossible → a generated image.
${brollGuidance(chapter.id, baseMood.footageStyle)}

EMPHASIS: set "emphasis": true on EXACTLY ONE scene — the chapter's emotional PEAK (its key
reveal or payoff line). Every other scene MUST be "emphasis": false. Default false.

SCENE SHAPES (use exactly these fields, plus "say"):
${shapes}

CONSTRAINTS:
- 6 to 15 scenes total (including the opening chapter_title). One idea per scene.
- Target ~${sub.pace}s per scene (durationSec 2-14). Let the emphasis peak BREATHE (longest); keep momentum elsewhere. Do NOT give every scene the same duration.
- SUB-MOOD "${sub.name}": FAVOUR these components (use a varied MIX, do NOT repeat one type): ${preferred.join(", ") || visualMenu}.
- VARY SCENE TYPES: never use the same scene type back-to-back. Mix component TYPES across scenes
  (a big_number for a stat, a quote for a punch, image_focus to breathe, diagram/chart for how-it-works,
  before_after for contrast). Surprise the viewer.
- Use big_number whenever a line has a number/stat. Use quote for a memorable/attributed line.
  Use chart for magnitude comparisons, diagram for how-it-works flows, timeline for chronology, map for "where".
- LESS TEXT, MORE GRAPHICS: the karaoke captions carry the narration, so keep on-screen text minimal.
  kinetic_text: max 3 lines, each <= 4 words. Never put a full sentence on screen. chapter_title is the only big-text card.
${has("section_summary") ? "- You MAY end with a section_summary recap card if it earns its place." : ""}
${STYLE}

Return ONLY the full ChapterBoard JSON:
{"id":"${chapter.id}","number":${chapter.number},"title":"${chapter.title}","subMood":"${chapter.subMood}","narration":${JSON.stringify(narration)},"scenes":[...]}`,
    "best",
    2,
    "storyboard_build",
  );
};

/* ─── 3. qaChapter — grade the finished chapter ──────────────────────────── */
const ChapterQA = z.object({
  ok: z.boolean(),
  issues: z.array(z.string()),
  score: z.number(),
});

export const qaChapter = (
  c: ChannelDNA,
  chapter: ChapterOutline,
  narration: string[],
  board: ChapterBoard,
): Promise<BrainResult<{ ok: boolean; issues: string[]; score: number }>> =>
  think(
    ChapterQA,
    `You are the QA Council for ${c.name}, reviewing ONE chapter of a long-form video. Be a harsh,
fair critic. Punish AI-slop, generic claims, hype, and anything mass-produced. Reward specificity
and real insight.
${dna(c)}

THIS CHAPTER (chapter ${chapter.number}): "${chapter.title}"
purpose: ${chapter.purpose}
points it MUST cover:
${chapter.points.map((p) => `- ${p}`).join("\n")}

narration=${JSON.stringify(narration)}
board=${JSON.stringify(board)}

Score this chapter 0-10 on, and check for:
- FACTUAL ACCURACY: any wrong, misleading, or unverifiable claim.
- COVERAGE: does it actually cover every required point above?
- PACING + VARIETY: scene durations vary by arc; scene types vary (no same-type back-to-back); one clear emphasis peak; opens with a chapter_title.
- SLOP: em dashes, AI clichés, generic filler, on-screen text overload.
ok=true ONLY if score>=7 AND there are no material problems.

Return ONLY JSON: {"ok":true|false,"issues":[specific problems, empty if ok],"score":n}`,
    "smart",
    2,
    "qa_review",
  );
