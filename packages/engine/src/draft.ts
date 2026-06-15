/* Stepwise post creation. The whole-pipeline `generate()` runs idea → script →
   storyboard → render in one shot; this module exposes each stage as a discrete,
   reviewable step that operates on a persisted ContentItem (data/runs/<id>.json),
   so a human (the /new builder) OR an agent (the draft_* tools on MCP/SDK/CLI)
   can generate, inspect, hand-edit, regenerate-with-guidance, and approve each
   stage before moving on. State lives entirely in the saved item, so each step
   is a fresh, stateless call. */
import { z } from "zod";
import { ContentItem, Idea, Script, Storyboard, type ChannelId } from "@os/schemas";
import { think } from "./brain.ts";
import { resolveChannel, channelForMood, defaultMoodFor } from "./channels.ts";
import { pickHook, writeScript, buildStoryboard } from "./stages.ts";
import { saveItem, loadItem, newId, nowIso, charge } from "./store.ts";
import { cleanIdea, cleanScript, cleanStoryboard } from "./sanitize.ts";
import { resolveFormat } from "./format.ts";

type IdeaT = z.infer<typeof Idea>;

function newDraft(channelId: string, seed: string): ContentItem {
  const c = resolveChannel(channelId);
  return {
    id: newId(c.id),
    channel: c.id as ChannelId,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    status: "idea_proposed",
    seedIdea: seed,
    ledger: { entries: [], totalUsd: 0 },
    log: [],
  };
}

/* ─── 1. Idea options ──────────────────────────────────────────────────────
   N distinct angles on the operator's direction (or, with no seed, N fresh
   high-potential ideas for the channel). Pure — returns options, persists
   nothing; the caller picks/edits one and calls draftSetIdea. */
const IdeaOptions = z.object({ ideas: z.array(Idea).min(1) });
export async function draftIdeas(channelId: string, seed = "", n = 3): Promise<{ ideas: IdeaT[]; usd: number }> {
  const c = resolveChannel(channelId);
  const r = await think<{ ideas: IdeaT[] }>(
    IdeaOptions,
    `You are the Idea Agent for ${c.name}.
AUDIENCE: ${c.audience}${c.domain ? `\nDOMAIN (stay strictly inside this subject): ${c.domain}` : ""}
TONE: ${c.tone}
BANNED (never produce): ${c.bannedPatterns.join(", ")}
${seed.trim() ? `The operator's direction: "${seed.trim()}". Propose ${n} DISTINCT, specific angles ON THAT direction.` : `Propose ${n} DISTINCT, specific, high-potential ideas for this channel.`}
Each must be concrete (NO generic "intro to X"): a real topic, a sharp angle, the strongest format
from (mistake_fix | terminal_tip | before_after | architecture_warning), a one-line rationale, and a
suggested mood id (explainer | business | tech | motivational | mindfulness).

Return ONLY JSON: {"ideas":[{"topic","angle","format","rationale","mood"}]}`,
    "smart",
  );
  return { ideas: r.data.ideas.map(cleanIdea), usd: r.usd };
}

/* ─── 2. Set the chosen idea (create or update the draft) ──────────────────── */
export function draftSetIdea(input: {
  id?: string; channel?: string; seed?: string; idea: unknown; mood?: string;
  kind?: "short" | "longform" | "static_image" | "carousel"; layoutVariant?: string; slideCount?: number;
  aspect?: "9:16" | "1:1" | "16:9"; width?: number; height?: number;
}): ContentItem {
  const idea = cleanIdea(Idea.parse(input.idea));
  const item = input.id ? loadItem(input.id) : newDraft(input.channel ?? "labrinox", input.seed ?? idea.topic);
  item.idea = idea;
  item.mood = input.mood ?? idea.mood ?? defaultMoodFor(resolveChannel(item.channel));
  // Carry the chosen output format so later stages render the right thing.
  if (input.kind) item.kind = input.kind;
  if (input.layoutVariant) item.layoutVariant = input.layoutVariant;
  if (input.slideCount) item.slideCount = input.slideCount;
  // Carry the chosen output canvas (custom width+height overrides aspect); all
  // omitted = the 9:16 default. draftStoryboard stamps it onto the storyboard.
  if (input.aspect) item.aspect = input.aspect;
  if (input.width) item.width = input.width;
  if (input.height) item.height = input.height;
  item.status = "idea_proposed";
  item.updatedAt = nowIso();
  saveItem(item);
  return item;
}

/* ─── 3. Script (hook → beats → narration), with optional guidance ────────── */
export async function draftScript(id: string, guidance = ""): Promise<ContentItem> {
  const item = loadItem(id);
  if (!item.idea) throw new Error(`draft ${id} has no idea yet`);
  const ec = channelForMood(resolveChannel(item.channel), item.mood);
  const hook = await pickHook(ec, item.idea, item.mood);
  const sc = await writeScript(ec, item.idea, hook.data.best, item.mood, guidance);
  item.script = cleanScript(sc.data);
  item.status = "script_ready";
  charge(item.ledger, "draft-script", hook.usd + sc.usd);
  item.updatedAt = nowIso();
  saveItem(item);
  return item;
}

export function draftSetScript(id: string, script: unknown): ContentItem {
  const item = loadItem(id);
  item.script = cleanScript(Script.parse(script));
  item.status = "script_ready";
  item.updatedAt = nowIso();
  saveItem(item);
  return item;
}

/* ─── 4. Storyboard (scenes), with optional guidance ──────────────────────── */
export async function draftStoryboard(id: string, guidance = ""): Promise<ContentItem> {
  const item = loadItem(id);
  if (!item.idea || !item.script) throw new Error(`draft ${id} needs an idea + script first`);
  const c = resolveChannel(item.channel);
  const ec = channelForMood(c, item.mood);
  const sb = await buildStoryboard(ec, item.idea, item.script, item.mood, guidance);
  let board = cleanStoryboard(sb.data);
  board = { ...board, scenes: board.scenes.map((s) => (s.type === "cta" ? { ...s, handle: c.handle ?? (s as { handle?: string }).handle } : s)) };
  // Stamp the chosen output geometry onto the storyboard (same resolution the
  // whole-pipeline generate() applies). Custom width+height overrides aspect;
  // all omitted resolves to the 9:16 / 1080×1920 default — no regression.
  const fmt = resolveFormat({ aspect: item.aspect, width: item.width, height: item.height });
  board.width = fmt.width;
  board.height = fmt.height;
  board.aspect = fmt.aspect;
  item.storyboard = board;
  item.status = "storyboard_ready";
  charge(item.ledger, "draft-storyboard", sb.usd);
  item.updatedAt = nowIso();
  saveItem(item);
  return item;
}

export function draftSetStoryboard(id: string, storyboard: unknown): ContentItem {
  const item = loadItem(id);
  item.storyboard = cleanStoryboard(Storyboard.parse(storyboard));
  item.status = "storyboard_ready";
  item.updatedAt = nowIso();
  saveItem(item);
  return item;
}

/* ─── Read the current draft ───────────────────────────────────────────────── */
export function draftGet(id: string): ContentItem {
  return loadItem(id);
}
