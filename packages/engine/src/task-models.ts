import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR, nowIso } from "./store.ts";

/* The AI pipeline broken into named, granular tasks — one per LLM call site in
   the engine (see brain.ts `think()`). Each task has a default tier; the user can
   override the MODEL and/or TIER per task (persisted in data/ai-tasks.json), and
   `think(schema, prompt, tier, retries, taskId)` resolves that override at call
   time. This is the registry the per-task model picker + the ai_task_model tool
   read, so every surface (UI / CLI / MCP / SDK / Soli) selects models per task. */

export type AiTaskTier = "cheap" | "smart" | "best";
export type AiTask = { id: string; label: string; description: string; stage: string; defaultTier: AiTaskTier };

export const AI_STAGES = ["ideation", "scripting", "storyboard", "qa", "research", "analysis", "carousel", "publish"] as const;

export const AI_TASKS: AiTask[] = [
  { id: "idea_refine", label: "Refine Idea", description: "Sharpen the operator seed into one specific on-brand idea (topic/angle/format/mood).", stage: "ideation", defaultTier: "smart" },
  { id: "concept_propose", label: "Propose Concepts", description: "Generate a ranked slate of distinct concepts, self-score, and pick the strongest.", stage: "ideation", defaultTier: "best" },
  { id: "brainstorm", label: "Brainstorm Day Ideas", description: "Generate N concrete on-brand calendar-day ideas from an operator prompt.", stage: "ideation", defaultTier: "smart" },
  { id: "hook_pick", label: "Pick Best Hook", description: "Write 5 opening hooks, score for scroll-stopping power, select the best.", stage: "scripting", defaultTier: "best" },
  { id: "script_write", label: "Write Short Script", description: "Write a tight ~40s vertical short script (beats/narration/CTA) from the hook.", stage: "scripting", defaultTier: "smart" },
  { id: "longform_narration", label: "Write Chapter Narration", description: "Write spoken narration for one long-form chapter, grounded in research.", stage: "scripting", defaultTier: "smart" },
  { id: "abtest_hook_variants", label: "Generate Hook Variants", description: "Generate N alternative opening-hook variants to A/B test retention.", stage: "scripting", defaultTier: "smart" },
  { id: "storyboard_build", label: "Build Storyboard", description: "Convert a script/narration into a deterministic, mood-aware storyboard.", stage: "storyboard", defaultTier: "best" },
  { id: "storyboard_revise", label: "Revise Storyboard", description: "Rebuild an improved storyboard addressing QA + fact-check feedback.", stage: "storyboard", defaultTier: "best" },
  { id: "qa_review", label: "QA Review", description: "Harshly score finished content and return a pass/revise/kill verdict.", stage: "qa", defaultTier: "best" },
  { id: "factcheck", label: "Fact-Check", description: "Fact-check every claim in the script + storyboard against live web sources.", stage: "qa", defaultTier: "smart" },
  { id: "trend_scan", label: "Scan Trends", description: "Surface currently-resonating angles, trending sounds, and winner formats.", stage: "research", defaultTier: "smart" },
  { id: "research_plan", label: "Plan Research", description: "Break a research question into N focused, facet-diverse sub-queries.", stage: "research", defaultTier: "cheap" },
  { id: "research_extract", label: "Extract Findings", description: "Extract atomic factual findings from one fetched source.", stage: "research", defaultTier: "cheap" },
  { id: "research_verify", label: "Verify Claims", description: "Adversarially adjudicate candidate findings into verified/disputed claims.", stage: "research", defaultTier: "smart" },
  { id: "research_synthesize", label: "Synthesize Report", description: "Write the final cited, decision-ready markdown report.", stage: "research", defaultTier: "best" },
  { id: "platform_playbook", label: "Platform Playbook", description: "Reverse-engineer a platform's algorithm into ranking signals + levers.", stage: "research", defaultTier: "smart" },
  { id: "channel_brief", label: "Channel Strategy Brief", description: "Build a deep strategy brief (audience, niche, gaps, positioning).", stage: "research", defaultTier: "best" },
  { id: "subject_playbook", label: "Subject Playbook", description: "Design the subject playbook of winning hooks/captions/CTAs/tactics.", stage: "research", defaultTier: "best" },
  { id: "cluster_cadence", label: "Cluster Cadence", description: "Recommend per-cluster posting cadence, best platforms, and post type.", stage: "research", defaultTier: "smart" },
  { id: "dna_evolve", label: "Evolve Brand Genome", description: "Propose small, evidence-backed Brand Genome mutations.", stage: "analysis", defaultTier: "smart" },
  { id: "observation_analyze", label: "Analyze Frames", description: "Extract creative intelligence from sampled video frames (vision fallback).", stage: "analysis", defaultTier: "smart" },
  { id: "carousel_write", label: "Design Carousel", description: "Design the full Instagram CarouselSpec from a seed idea.", stage: "carousel", defaultTier: "best" },
  { id: "package_post", label: "Package Post", description: "Produce the post package + per-platform titles/captions/hashtags.", stage: "publish", defaultTier: "smart" },
  { id: "title_hashtag_suggest", label: "Suggest Titles & Hashtags", description: "Generate platform-native titles + sized hashtag mixes for a short.", stage: "publish", defaultTier: "smart" },
];

const TASK_IDS = new Set(AI_TASKS.map((t) => t.id));
export const isAiTask = (id: string): boolean => TASK_IDS.has(id);

/* Per-task override: a tier and/or an explicit model slug (provider-appropriate —
   an OpenRouter/Anthropic/OpenAI model id). Either may be set independently. */
export type TaskOverride = { tier?: AiTaskTier; model?: string };
const FILE = join(DATA_DIR, "ai-tasks.json");

function load(): Record<string, TaskOverride> {
  try {
    if (existsSync(FILE)) {
      const j = JSON.parse(readFileSync(FILE, "utf8")) as { overrides?: Record<string, TaskOverride> };
      if (j?.overrides && typeof j.overrides === "object") return j.overrides;
    }
  } catch {
    /* ignore */
  }
  return {};
}
function save(overrides: Record<string, TaskOverride>) {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(FILE, JSON.stringify({ overrides, updatedAt: nowIso() }, null, 2));
}

export function listTaskOverrides(): Record<string, TaskOverride> {
  return load();
}
export function getTaskOverride(id?: string): TaskOverride | null {
  if (!id) return null;
  return load()[id] ?? null;
}
export function setTaskModel(id: string, ov: TaskOverride): TaskOverride {
  if (!isAiTask(id)) throw new Error(`unknown ai task: ${id}`);
  const all = load();
  const next: TaskOverride = {};
  if (ov.tier) next.tier = ov.tier;
  if (ov.model && ov.model.trim()) next.model = ov.model.trim();
  if (!next.tier && !next.model) delete all[id];
  else all[id] = next;
  save(all);
  return next;
}
export function clearTaskModel(id: string): void {
  const all = load();
  if (all[id]) { delete all[id]; save(all); }
}

/* The full manifest the UI/tool renders: every task with its default + any
   active override resolved in. */
export function taskManifest(): Array<AiTask & { tier: AiTaskTier; model?: string; overridden: boolean }> {
  const ov = load();
  return AI_TASKS.map((t) => {
    const o = ov[t.id];
    return { ...t, tier: o?.tier ?? t.defaultTier, model: o?.model, overridden: !!(o?.tier || o?.model) };
  });
}
