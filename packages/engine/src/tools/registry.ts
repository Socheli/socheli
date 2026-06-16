/**
 * registry.ts — the single canonical tool registry for Socheli.
 *
 * This is the one source of truth that every surface (MCP, HTTP API, CLI, SDK)
 * consumes. It unifies:
 *   - the ~30 EDITOR tools (already defined in ../editor-tools.ts), and
 *   - every PIPELINE / GENERATION / PUBLISH / GROW / ANALYTICS / ASSETS /
 *     CHANNELS / SCHEDULER capability that previously lived only in cli.ts and
 *     the engine modules.
 *
 * Each pipeline tool reuses the EditorTool shape (name/description/inputSchema/run)
 * so the surfaces stay uniform, but additionally carries:
 *   - a zod `schema` (validated by callTool before the handler runs), and
 *   - a `kind` ("read" | "mutate" | "long") describing its cost/effect.
 *
 * Long-running tools (generate, longform, autopilot, publish, render, board,
 * variant generation, analytics ingest) do NOT block the caller: their handler
 * spawns a detached engine process (the same node --import tsx pattern the
 * dashboard API uses) and returns a started/job result immediately, mirroring
 * the existing `editor_start_rerender` tool.
 *
 * HARD CONSTRAINT: additive & non-breaking. editorTools, callEditorTool and
 * toolManifest in ../editor-tools.ts keep working untouched.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import { spawnSync } from "node:child_process";
import { z } from "zod";

import {
  type EditorTool,
  type ToolResult,
  callEditorTool,
  editorTools,
} from "../editor-tools.ts";

// Engine capability modules. These are node-only (fs/child_process) and tsx-run;
// importing them here is fine because this file only ever runs inside the engine
// tool runner — never inside a Next bundle.
import {
  CHANNELS,
  channelIds,
  channelMoods,
  resolveChannel,
  resolveVoiceSettings,
} from "../channels.ts";
import { listItems, loadItem, saveItem } from "../store.ts";
import mqtt from "mqtt";
import { brokerConfig, TOPICS, newJobId, type Job } from "../fleet.ts";
import { pullStats, platformStatus, exportBundle } from "../publisher.ts";
import { selectConcept } from "../selection.ts";
import {
  factCheck,
  packagePost,
  pickHook,
  reviseStoryboard,
  runQA,
} from "../stages.ts";
import { webSearch, searchContext, searchProviders } from "../websearch.ts";
import { curatedBed, ensureMusic, synthVoiceSceneSynced } from "../media.ts";
import { resolveBroll, brollSources } from "../broll.ts";
import { listMoods, resolveStudio, MOOD_BLENDS, moods } from "@os/tokens";
import { renderCover, coverBg } from "../render.ts";
import { imageBackend } from "../thumbnail.ts";
import { saveSchedule } from "../schedule.ts";
import {
  COMPETITOR_INTEL,
  OUR_STRATEGIC_EDGE,
  UNMET_JOBS,
  competitorOpportunityScores,
  getTrendIntel,
  strategicRoadmap,
  suggestTitlesAndHashtags,
} from "../competitive-intel.ts";
import {
  addComment as conceptAddComment,
  getConcept,
  listConcepts,
  setStatus as conceptSetStatus,
} from "../concept-board.ts";
import {
  allScorecards,
  channelScorecard,
  getLearnings,
  ingestAnalytics,
  listAnalytics,
  loadAnalytics,
  recordAvoid,
  recordWin,
} from "../learnings.ts";
import { decideWinner, generateVariants, listABTests, loadABTest } from "../abtest.ts";
import { overlayCatalog, listLogos, listSfx } from "../assets.ts";
import { makeAspects, makeThumbnail, availableAspects } from "../derivatives.ts";
import { agentStatus, installAgent, uninstallAgent } from "../scheduler.ts";
import { dueSlots, loadSchedule, nextDue } from "../schedule.ts";
import { draftIdeas, draftSetIdea, draftScript, draftSetScript, draftStoryboard, draftSetStoryboard, draftGet } from "../draft.ts";
import { getCopilotModel, setCopilotModel, COPILOT_MODEL_PRESETS } from "../copilot-model.ts";
import { taskManifest, setTaskModel, clearTaskModel, isAiTask, AI_STAGES, type AiTaskTier } from "../task-models.ts";
import { PROVIDERS } from "../providers.ts";
import { setProviderKeyOnly, clearProviderKey, getProviderApiKey, setActiveProvider, getActiveProviderId, setProviderDisabled, isProviderDisabled, addProviderAccount, removeProviderAccount, setActiveAccount, listProviderAccounts } from "../ai-providers.ts";
import { modelCatalog } from "../model-catalog.ts";
import {
  loadPlan as loadContentPlan,
  appendPlan,
  getPost as getPlanPost,
  postsForDate as planPostsForDate,
  updatePost as updatePlanPost,
  movePost as movePlanPost,
  archivePost as archivePlanPost,
  removePost as removePlanPost,
  loadStrategy,
} from "../content-plan.ts";
import type { PlannedPost, PlatformKey } from "../algo-research.ts";
// Agent Harness v2 tool surfaces (docs/AGENT-HARNESS.md). These modules import
// `zodToJsonSchema` back from this file — that cycle is safe because it is a
// hoisted `export function` (do not convert it to an arrow/const export).
import { dnaTools } from "./dna-tools.ts";
import { deepResearchTools } from "./research-tools.ts";
import { harnessTools } from "./harness-tools.ts";
import { missionTools } from "./mission-tools.ts";
import { memoryTools } from "./memory-tools.ts";
import { commentTools } from "./comment-tools.ts";
import { dmTools } from "./dm-tools.ts";
import { connectionTools } from "./connection-tools.ts";
import { igConnectionTools } from "./ig-connection-tools.ts";
import { commentTriggerTools } from "./comment-trigger-tools.ts";
import { responderTools } from "./responder-tools.ts";
import { insightsTools } from "./insights-tools.ts";
import { adminTools } from "./admin-tools.ts";
import { calendarAdminTools } from "./calendar-admin-tools.ts";
import { aiDmTools } from "./ai-dm-tools.ts";
import { imageTools } from "./image-tools.ts";
import { fleetTools } from "./fleet-tools.ts";
import { observationTools } from "./observation-tools.ts";
import { adsTools } from "./ads-tools.ts";
import { creativeTools } from "./creative-tools.ts";
import { timelineTools } from "./timeline-tools.ts";
import { mixTools } from "./mix-tools.ts";
import { compTools } from "./comp-tools.ts";
import { timelineEditTools } from "./timeline-edit-tools.ts";
import { ingestSeedTools } from "./ingest-seed-tools.ts";
import { understandingTools } from "./understanding-tools.ts";
import { ingestTools } from "./ingest-tools.ts";

// Shared helpers live in the leaf ./helpers.ts (see the re-export block below for
// why). Imported here for registry.ts's OWN tool definitions; the re-export keeps
// `from "./registry.ts"` import sites working for back-compat.
import {
  ROOT,
  DATA_DIR,
  ENGINE_SRC,
  ok,
  fail,
  spawnEngine,
  spawnCli,
  tool,
  asyncResult,
  isPending,
  PENDING,
  type ToolKind,
  type PipelineTool,
} from "./helpers.ts";

// ---------------------------------------------------------------------------
// Shared helpers — re-exported from the leaf ./helpers.ts module.
// ---------------------------------------------------------------------------
//
// These live in ./helpers.ts (a leaf with no back-edge to this file) and are
// re-exported here so existing `from "./registry.ts"` import sites keep working.
// They MUST NOT be defined here: registry.ts imports the tool arrays from
// dna/research/mission/harness-tools.ts, and those files import these helpers,
// which would form a cycle. Under tsx (esbuild keepNames) a cyclic import of a
// helper that wraps an arrow in the `__name` var throws "__name is not a
// function" at load, because `__name` isn't initialized yet when the imported
// tool file runs its top-level tool() calls. The leaf module breaks the cycle.
export { ROOT, DATA_DIR, ENGINE_SRC, ok, fail, spawnEngine, spawnCli, tool };
export type { ToolKind, PipelineTool };
export { zodToJsonSchema } from "./helpers.ts";

const empty = z.object({}).strict();

// ---------------------------------------------------------------------------
// PIPELINE / GENERATION (long-running → spawn & return started)
// ---------------------------------------------------------------------------

const generationTools: PipelineTool[] = [
  tool({
    name: "pipeline_generate_post",
    description:
      "Generate a complete vertical (9:16) post end-to-end from one idea (idea → script → storyboard → voice/music/broll → render → package). Long-running: starts a background job and returns its pid + log path.",
    kind: "long",
    schema: z
      .object({
        seed: z.string().min(1).describe("the one-line idea/topic to build from"),
        channel: z.string().default("labrinox"),
        mood: z.string().optional(),
        aspect: z.enum(["9:16", "1:1", "16:9"]).optional().describe("output shape (default 9:16 vertical); a custom width+height overrides this"),
        width: z.number().int().positive().optional().describe("custom canvas width in px (requires height; overrides aspect)"),
        height: z.number().int().positive().optional().describe("custom canvas height in px (requires width; overrides aspect)"),
        voice: z.boolean().default(false),
        music: z.boolean().default(true),
        broll: z.boolean().default(true),
        preview: z.boolean().default(false),
        abStoryboard: z.boolean().default(true).describe("generate two storyboard variants and pick the higher-scoring one (skip in preview to save cost)"),
        maxQaPasses: z.number().int().min(1).max(5).default(3).describe("max iterative QA+revision passes before render (stops early when score ≥ 8)"),
      })
      .strict(),
    run: ({ seed, channel, mood, aspect, width, height, voice, music, broll, preview, abStoryboard, maxQaPasses }) => {
      const args = ["new", seed, "--channel", channel];
      if (mood) args.push("--mood", mood);
      if (width && height) args.push("--size", `${width}x${height}`);
      else if (aspect) args.push("--aspect", aspect);
      if (voice) args.push("--voice");
      if (!music) args.push("--no-music");
      if (!broll) args.push("--no-broll");
      if (preview) args.push("--preview");
      if (!abStoryboard) args.push("--no-ab");
      if (maxQaPasses !== 3) args.push("--qa-passes", String(maxQaPasses));
      const job = spawnCli(args, "tool-generate.log");
      return ok({ status: "started", ...job, channel, seed }, "generation started");
    },
  }),
  tool({
    name: "pipeline_generate_longform",
    description:
      "Generate a long-form 16:9 multi-chapter YouTube video (chapter-first pipeline with shared research cache, render-per-chapter + concat). Long-running: starts a background job.",
    kind: "long",
    schema: z
      .object({
        topic: z.string().min(1),
        channel: z.string().default("labrinox"),
        mood: z.string().optional(),
      })
      .strict(),
    run: ({ topic, channel, mood }) => {
      const args = ["longform", topic, "--channel", channel];
      if (mood) args.push("--mood", mood);
      const job = spawnCli(args, "tool-longform.log");
      return ok({ status: "started", ...job, channel, topic }, "longform generation started");
    },
  }),
  tool({
    name: "pipeline_autopilot",
    description:
      "Full autopilot for a channel: select the best concept (or use a seed) → generate → publish. Long-running: starts a background job.",
    kind: "long",
    schema: z
      .object({
        channel: z.string().default("labrinox"),
        seed: z.string().optional().describe("optional seed; empty = system auto-selects a concept"),
        voice: z.boolean().default(false),
        music: z.boolean().default(true),
        broll: z.boolean().default(true),
        publish: z.boolean().default(true),
        public: z.boolean().default(false),
      })
      .strict(),
    run: ({ channel, seed, voice, music, broll, publish, public: pub }) => {
      const args = ["auto"];
      if (seed) args.push(seed);
      args.push("--channel", channel);
      if (voice) args.push("--voice");
      if (!music) args.push("--no-music");
      if (!broll) args.push("--no-broll");
      if (!publish) args.push("--no-publish");
      if (pub) args.push("--public");
      const job = spawnCli(args, "tool-autopilot.log");
      return ok({ status: "started", ...job, channel }, "autopilot started");
    },
  }),
  tool({
    name: "pipeline_rerender",
    description:
      "Re-render an existing run after edits (optionally re-doing voice / music / broll / procedural assets). Long-running: starts a background job.",
    kind: "long",
    schema: z
      .object({
        id: z.string().min(1),
        voice: z.boolean().default(false),
        music: z.boolean().default(false),
        broll: z.boolean().default(false),
        procedural: z.boolean().default(false),
      })
      .strict(),
    run: ({ id, voice, music, broll, procedural }) => {
      const args = [id];
      if (voice) args.push("--voice");
      if (music) args.push("--music");
      if (broll) args.push("--broll");
      if (procedural) args.push("--procedural");
      const job = spawnEngine("rerender.ts", args, "tool-rerender.log");
      return ok({ status: "started", ...job, id }, "rerender started");
    },
  }),
  tool({
    name: "tools_batch_rerender",
    description:
      "Re-render several runs in one call (each spawns its own detached rerender job, mirroring pipeline_rerender). Utility for agents working a content backlog. Returns one started job descriptor per id.",
    kind: "long",
    schema: z
      .object({
        ids: z.array(z.string().min(1)).min(1),
        voice: z.boolean().default(false),
        music: z.boolean().default(false),
        broll: z.boolean().default(false),
        procedural: z.boolean().default(false),
      })
      .strict(),
    run: ({ ids, voice, music, broll, procedural }) => {
      const jobs = ids.map((id: string) => {
        const args = [id];
        if (voice) args.push("--voice");
        if (music) args.push("--music");
        if (broll) args.push("--broll");
        if (procedural) args.push("--procedural");
        const job = spawnEngine("rerender.ts", args, `tool-rerender-${id}.log`);
        return { id, status: "started", ...job };
      });
      return ok({ jobs }, `started ${jobs.length} rerender job(s)`);
    },
  }),
  tool({
    name: "tools_estimate_cost",
    description:
      "Estimate the USD spend for a run: the actual cost already spent (from the run's cost ledger, broken down by stage) plus a rough estimate for redoing a phase. Helps agents make spend-aware decisions before kicking off an LLM/render job.",
    kind: "read",
    schema: z
      .object({
        id: z.string().min(1),
        phase: z.enum(["rerender", "package", "qa", "factcheck", "revise", "hook", "variants", "publish"]).optional(),
      })
      .strict(),
    run: ({ id, phase }) => {
      const it = loadItem(id);
      const ledger = it.ledger ?? { entries: [], totalUsd: 0 };
      const byStage: Record<string, number> = {};
      for (const e of ledger.entries ?? []) byStage[e.stage] = (byStage[e.stage] ?? 0) + e.usd;
      // Coarse per-phase estimates (USD) based on tier/model usage in the pipeline.
      const PHASE_EST: Record<string, number> = {
        rerender: 0, // media/ffmpeg + Remotion are local/free; cost is time not USD
        package: 0.01,
        qa: 0.01,
        factcheck: 0.012,
        revise: 0.02,
        hook: 0.015,
        variants: 0.03,
        publish: 0, // network upload only
      };
      return ok({
        id,
        spentUsd: ledger.totalUsd ?? 0,
        byStage,
        ...(phase ? { phase, estimatedPhaseUsd: PHASE_EST[phase] ?? null } : {}),
      });
    },
  }),
];

// ---------------------------------------------------------------------------
// CONCEPTS / IDEATION (board reads + cheap mutations; selection is read-but-LLM)
// ---------------------------------------------------------------------------

const conceptTools: PipelineTool[] = [
  tool({
    name: "concept_select",
    description:
      "Score a fresh concept board for a channel (trend + learning aware) and return the winning idea plus all candidates. Calls the LLM synchronously; expect a short wait and a small USD cost in the result.",
    kind: "long",
    schema: z.object({ channel: z.string().default("labrinox"), count: z.number().int().min(1).max(12).default(5) }).strict(),
    run: ({ channel, count }) =>
      asyncResult(selectConcept(resolveChannel(channel), count).then((sel) => ok(sel, "concept board scored"))),
  }),
  tool({
    name: "concept_board_list",
    description: "List all saved board concepts (most recent first), including scores, status and comments.",
    kind: "read",
    schema: empty,
    run: () => ok(listConcepts()),
  }),
  tool({
    name: "concept_board_get",
    description: "Get one saved board concept by id.",
    kind: "read",
    schema: z.object({ id: z.string().min(1) }).strict(),
    run: ({ id }) => {
      const c = getConcept(id);
      return c ? ok(c) : fail(`concept not found: ${id}`);
    },
  }),
  tool({
    name: "concept_board_comment",
    description: "Append a comment to a saved board concept.",
    kind: "mutate",
    schema: z.object({ id: z.string().min(1), text: z.string().min(1) }).strict(),
    run: ({ id, text }) => {
      const c = conceptAddComment(id, text);
      return c ? ok(c, "comment added") : fail(`concept not found: ${id}`);
    },
  }),
  tool({
    name: "concept_board_set_status",
    description: "Set the status of a saved board concept (new | approved | rejected | generated).",
    kind: "mutate",
    schema: z.object({ id: z.string().min(1), status: z.enum(["new", "approved", "rejected", "generated"]) }).strict(),
    run: ({ id, status }) => {
      const c = conceptSetStatus(id, status);
      return c ? ok(c, "status updated") : fail(`concept not found: ${id}`);
    },
  }),
  tool({
    name: "concept_board_generate",
    description:
      "Generate and persist a fresh scored concept board for a channel (trend + learning aware). Long-running: starts a background job.",
    kind: "long",
    schema: z.object({ channel: z.string().default("labrinox"), n: z.number().int().min(1).max(12).default(5) }).strict(),
    run: ({ channel, n }) => {
      const job = spawnCli(["board", "--channel", channel, "--n", String(n)], "tool-board.log");
      return ok({ status: "started", ...job, channel }, "board generation started");
    },
  }),
];

// ---------------------------------------------------------------------------
// RUNS / ITEMS (read + validate)
// ---------------------------------------------------------------------------

const runTools: PipelineTool[] = [
  tool({
    name: "runs_list",
    description: "List every generated content run with status, cost and topic.",
    kind: "read",
    schema: empty,
    run: () =>
      ok(
        listItems().map((it) => ({
          id: it.id,
          status: it.status,
          channel: it.channel,
          topic: it.idea?.topic ?? it.seedIdea,
          totalUsd: it.ledger?.totalUsd,
          videoPath: it.videoPath,
          createdAt: it.createdAt,
          updatedAt: it.updatedAt,
        })),
      ),
  }),
  tool({
    name: "runs_get",
    description: "Get the full ContentItem JSON for one run.",
    kind: "read",
    schema: z.object({ id: z.string().min(1) }).strict(),
    run: ({ id }) => ok(loadItem(id) as unknown as Record<string, unknown>),
  }),
];

// ---------------------------------------------------------------------------
// PUBLISH (long → spawn) + status/bundle (read)
// ---------------------------------------------------------------------------

const publishTools: PipelineTool[] = [
  tool({
    name: "publish_item",
    description:
      "Publish a finished run to all configured platforms (YouTube + IG Reels + TikTok) and write a shareable bundle. Long-running: starts a background job.",
    kind: "long",
    schema: z.object({ id: z.string().min(1), public: z.boolean().default(false), aigc: z.boolean().default(true) }).strict(),
    run: ({ id, public: pub, aigc }) => {
      const args = ["publish", id];
      if (pub) args.push("--public");
      if (!aigc) args.push("--no-aigc");
      const job = spawnCli(args, "tool-publish.log");
      return ok({ status: "started", ...job, id }, "publish started");
    },
  }),
  tool({
    name: "publish_platform_status",
    description: "Report which publishing platforms are currently configured/live (youtube, instagram, tiktok, host). Pass a channel to check that brand's per-account connection; omit for the global env-fallback.",
    kind: "read",
    schema: z.object({ channel: z.string().optional() }).strict(),
    run: ({ channel }) => ok(platformStatus(channel)),
  }),
  tool({
    name: "publish_export_bundle",
    description: "Export a self-contained share/upload bundle for a run and return the bundle directory path.",
    kind: "mutate",
    schema: z.object({ id: z.string().min(1) }).strict(),
    run: ({ id }) => ok({ bundleDir: exportBundle(loadItem(id)) }, "bundle exported"),
  }),
  tool({
    name: "publish_pull_stats",
    description: "Pull cached platform stats (views/likes) for a published run.",
    kind: "read",
    schema: z.object({ id: z.string().min(1) }).strict(),
    run: ({ id }) => ok(pullStats(loadItem(id)) ?? { views: null, likes: null }),
  }),
];

// ---------------------------------------------------------------------------
// DERIVATIVES (aspect crops + thumbnail). ffmpeg work — kept synchronous but
// marked mutate; callers can background at the surface level if desired.
// ---------------------------------------------------------------------------

const derivativeTools: PipelineTool[] = [
  tool({
    name: "derivatives_make_thumbnail",
    description: "Extract a thumbnail JPG from a run's rendered master at a given timestamp.",
    kind: "mutate",
    schema: z.object({ id: z.string().min(1), atSec: z.number().min(0).default(2.5) }).strict(),
    run: ({ id, atSec }) => {
      const it = loadItem(id);
      if (!it.videoPath) return fail("run has no rendered video");
      const out = makeThumbnail(id, it.videoPath, atSec);
      return out ? ok({ thumbPath: out }, "thumbnail created") : fail("thumbnail extraction failed");
    },
  }),
  tool({
    name: "derivatives_make_aspects",
    description: "Produce 1:1 (square) and 16:9 (wide) derivatives from a run's 9:16 master.",
    kind: "mutate",
    schema: z.object({ id: z.string().min(1) }).strict(),
    run: ({ id }) => {
      const it = loadItem(id);
      if (!it.videoPath) return fail("run has no rendered video");
      return ok(makeAspects(id, it.videoPath), "aspect derivatives created");
    },
  }),
  tool({
    name: "derivatives_available_aspects",
    description: "List which aspect ratios are available for a run (master + any derivatives).",
    kind: "read",
    schema: z.object({ id: z.string().min(1) }).strict(),
    run: ({ id }) => {
      const it = loadItem(id) as Record<string, any>;
      return ok(availableAspects(it.videoPath, it.derivatives));
    },
  }),
];

// ---------------------------------------------------------------------------
// A/B TESTING
// ---------------------------------------------------------------------------

const abtestTools: PipelineTool[] = [
  tool({
    name: "abtest_list",
    description: "List all A/B hook tests.",
    kind: "read",
    schema: empty,
    run: () => ok(listABTests()),
  }),
  tool({
    name: "abtest_get",
    description: "Get one A/B test by base item id.",
    kind: "read",
    schema: z.object({ id: z.string().min(1) }).strict(),
    run: ({ id }) => {
      const t = loadABTest(id);
      return t ? ok(t) : fail(`abtest not found: ${id}`);
    },
  }),
  tool({
    name: "abtest_generate_variants",
    description:
      "Generate N hook/first-scene variants for a run for A/B testing (LLM). Synchronous; returns the saved test and its USD cost.",
    kind: "long",
    schema: z.object({ id: z.string().min(1), count: z.number().int().min(1).max(6).default(3) }).strict(),
    run: ({ id, count }) => asyncResult(generateVariants(loadItem(id), count).then((r) => ok(r, "variants generated"))),
  }),
  tool({
    name: "abtest_decide_winner",
    description: "Decide the winning A/B variant for a run from recorded publication metrics.",
    kind: "read",
    schema: z.object({ id: z.string().min(1) }).strict(),
    run: ({ id }) => {
      const w = decideWinner(id);
      return w ? ok(w) : ok(null, "no winner decidable yet");
    },
  }),
];

// ---------------------------------------------------------------------------
// ANALYTICS / LEARNINGS (grow loop)
// ---------------------------------------------------------------------------

const analyticsTools: PipelineTool[] = [
  tool({
    name: "analytics_ingest",
    description:
      "Fetch live platform analytics for one published run and fold the result into the learnings/scorecards (network/token gated). Synchronous; returns the snapshot.",
    kind: "long",
    schema: z.object({ id: z.string().min(1) }).strict(),
    run: ({ id }) =>
      asyncResult(
        (async () => {
          const item = loadItem(id);
          const snap = await ingestAnalytics(item);
          if (snap) return ok(snap, "analytics ingested");
          // Explain WHY it's empty so agents can relay the real story instead of "no data".
          const published = (item.publish ?? []).filter((p: any) => p?.status === "published");
          const withIds = published.filter((p: any) => p?.id);
          const reason = !published.length
            ? "run is not published to any platform yet"
            : !withIds.length
              ? "run was published outside the official API (e.g. via phone) — no platform media id exists, so platform analytics cannot be fetched; publish through the connected account to get metrics"
              : "platform returned no metrics (token missing/expired, or metrics not yet available)";
          return ok(null, `no analytics available: ${reason}`);
        })(),
      ),
  }),
  tool({
    name: "analytics_get",
    description: "Get the cached analytics snapshot for one run.",
    kind: "read",
    schema: z.object({ id: z.string().min(1) }).strict(),
    run: ({ id }) => {
      const a = loadAnalytics(id);
      return a ? ok(a) : ok(null, "no analytics snapshot yet");
    },
  }),
  tool({
    name: "analytics_list",
    description: "List all cached analytics snapshots.",
    kind: "read",
    schema: empty,
    run: () => ok(listAnalytics()),
  }),
  tool({
    name: "analytics_scorecard",
    description: "Get the performance scorecard for one channel (aggregated from snapshots).",
    kind: "read",
    schema: z.object({ channel: z.string().min(1) }).strict(),
    run: ({ channel }) => ok(channelScorecard(channel)),
  }),
  tool({
    name: "analytics_all_scorecards",
    description: "Get performance scorecards for every channel.",
    kind: "read",
    schema: empty,
    run: () => ok(allScorecards()),
  }),
  tool({
    name: "learnings_get",
    description: "Get the accumulated learnings text for a channel (feeds future ideation).",
    kind: "read",
    schema: z.object({ channel: z.string().min(1) }).strict(),
    run: ({ channel }) => ok({ channel, learnings: getLearnings(channel) }),
  }),
  tool({
    name: "learnings_record_win",
    description: "Record a 'what worked' note for a channel to bias future ideation.",
    kind: "mutate",
    schema: z.object({ channel: z.string().min(1), note: z.string().min(1) }).strict(),
    run: ({ channel, note }) => {
      recordWin(channel, note);
      return ok({ channel, note }, "win recorded");
    },
  }),
  tool({
    name: "learnings_record_avoid",
    description: "Record a 'what to avoid' note for a channel to bias future ideation.",
    kind: "mutate",
    schema: z.object({ channel: z.string().min(1), note: z.string().min(1) }).strict(),
    run: ({ channel, note }) => {
      recordAvoid(channel, note);
      return ok({ channel, note }, "avoid recorded");
    },
  }),
];

// ---------------------------------------------------------------------------
// COMPETITIVE / TREND INTEL (grow loop, LLM where noted)
// ---------------------------------------------------------------------------

const intelTools: PipelineTool[] = [
  tool({
    name: "intel_competitor_landscape",
    description:
      "Return the static competitor intel landscape: competitors, our strategic edge, unmet jobs, opportunity scores, and the strategic roadmap.",
    kind: "read",
    schema: empty,
    run: () =>
      ok({
        competitors: COMPETITOR_INTEL,
        strategicEdge: OUR_STRATEGIC_EDGE,
        unmetJobs: UNMET_JOBS,
        opportunityScores: competitorOpportunityScores(),
        roadmap: strategicRoadmap(),
      }),
  }),
  tool({
    name: "intel_trend",
    description:
      "Fetch live trend intel (trending sounds + viral formats) for a topic/niche/platform via web search + LLM. Synchronous LLM call; returns the intel and its USD cost.",
    kind: "long",
    schema: z
      .object({
        topic: z.string().min(1),
        niche: z.string().optional(),
        platform: z.enum(["tiktok", "instagram", "youtube"]).default("tiktok"),
        tier: z.enum(["cheap", "smart", "best"]).default("smart"),
      })
      .strict(),
    run: ({ topic, niche, platform, tier }) =>
      asyncResult(getTrendIntel({ topic, niche, platform }, tier).then((r) => ok(r))),
  }),
  tool({
    name: "intel_suggest_titles_hashtags",
    description:
      "Suggest platform-tuned titles and hashtags for a topic (LLM). Synchronous; returns suggestions and USD cost.",
    kind: "long",
    schema: z
      .object({
        topic: z.string().min(1),
        hook: z.string().optional(),
        cta: z.string().optional(),
        narration: z.array(z.string()).optional(),
        platforms: z.array(z.string()).optional(),
        tier: z.enum(["cheap", "smart", "best"]).default("smart"),
      })
      .strict(),
    run: ({ topic, hook, cta, narration, platforms, tier }) =>
      asyncResult(suggestTitlesAndHashtags({ topic, hook, cta, narration, platforms }, tier).then((r) => ok(r))),
  }),
  tool({
    name: "intel_topic_overview",
    description:
      "One-shot strategic intel package for a topic: live trend intel (sounds + formats) + the competitor landscape + unmet jobs + opportunity scores. Lets an agent understand strategic context before ideation. LLM + web search; returns the package + USD cost.",
    kind: "long",
    schema: z
      .object({
        topic: z.string().min(1),
        platform: z.enum(["tiktok", "instagram", "youtube"]).default("tiktok"),
        niche: z.string().optional(),
        tier: z.enum(["cheap", "smart", "best"]).default("smart"),
      })
      .strict(),
    run: ({ topic, platform, niche, tier }) =>
      asyncResult(
        getTrendIntel({ topic, niche, platform }, tier).then((trend) =>
          ok({
            topic,
            trends: trend.data,
            competitors: COMPETITOR_INTEL,
            unmetJobs: UNMET_JOBS,
            opportunityScores: competitorOpportunityScores(),
            strategicEdge: OUR_STRATEGIC_EDGE,
            usd: trend.usd,
          }),
        ),
      ),
  }),
];

// ---------------------------------------------------------------------------
// EDIT-LOOP (QA / revise / fact-check / package / hook) — the refine loop an
// agent runs between initial generation and final render/publish, WITHOUT
// paying for a full re-render. All LLM-backed → kind "long" via asyncResult.
// Each loads the run, resolves its ChannelDNA, and runs the real stages.ts fn.
// ---------------------------------------------------------------------------

const editLoopTools: PipelineTool[] = [
  tool({
    name: "tools_qa_storyboard",
    description:
      "Run the QA Council on a run's existing storyboard + script (no render). Returns 0-10 dimension scores, an overall, a verdict (pass|revise|kill) and notes. Lets agents get publication-grade feedback before committing to a render. LLM; returns scores + USD cost.",
    kind: "long",
    schema: z.object({ id: z.string().min(1) }).strict(),
    run: ({ id }) => {
      const it = loadItem(id);
      if (!it.storyboard || !it.script) return fail("run has no storyboard/script yet");
      const c = resolveChannel(it.channel);
      return asyncResult(runQA(c, it.storyboard as any, it.script as any).then((r) => ok(r.data, `qa: ${(r.data as any).verdict}`)));
    },
  }),
  tool({
    name: "tools_revise_storyboard",
    description:
      "LLM-driven whole-board revision of a run's storyboard from free-text feedback (complements the scene-by-scene editor_* tools). Persists the revised storyboard back onto the run. LLM; returns the new storyboard + USD cost.",
    kind: "long",
    schema: z.object({ id: z.string().min(1), feedback: z.string().min(1).describe("what to fix, in plain language") }).strict(),
    run: ({ id, feedback }) => {
      const it = loadItem(id);
      if (!it.storyboard || !it.script || !it.idea) return fail("run needs idea + script + storyboard first");
      const c = resolveChannel(it.channel);
      const notes = String(feedback).split(/\n+/).map((s: string) => s.trim()).filter(Boolean);
      return asyncResult(
        reviseStoryboard(c, it.idea as any, it.script as any, it.storyboard as any, notes.length ? notes : [feedback]).then((r) => {
          const fresh = loadItem(id);
          fresh.storyboard = r.data as any;
          fresh.updatedAt = new Date().toISOString();
          saveItem(fresh);
          return ok(r.data, "storyboard revised");
        }),
      );
    },
  }),
  tool({
    name: "tools_fact_check",
    description:
      "Fact-check a run's script + storyboard against live web sources (pre-render validation). Returns { ok, issues }. Critical for reducing QA failures before an expensive render. LLM + web search; returns result + USD cost.",
    kind: "long",
    schema: z.object({ id: z.string().min(1) }).strict(),
    run: ({ id }) => {
      const it = loadItem(id);
      if (!it.storyboard || !it.script) return fail("run has no storyboard/script yet");
      const c = resolveChannel(it.channel);
      return asyncResult(factCheck(c, it.script as any, it.storyboard as any).then((r) => ok(r.data, r.data.ok ? "no material issues" : `${r.data.issues.length} issue(s)`)));
    },
  }),
  tool({
    name: "tools_generate_package",
    description:
      "Generate platform-specific title / hashtags / captions for a run WITHOUT re-rendering the video. Persists the package onto the run (skips if already packaged unless force=true). LLM; returns the package + USD cost.",
    kind: "long",
    schema: z.object({ id: z.string().min(1), force: z.boolean().default(false) }).strict(),
    run: ({ id, force }) => {
      const it = loadItem(id);
      if (!it.storyboard || !it.script) return fail("run has no storyboard/script yet");
      if (it.pkg && !force) return ok(it.pkg, "already packaged (pass force=true to regenerate)");
      const c = resolveChannel(it.channel);
      return asyncResult(
        packagePost(c, it.storyboard as any, it.script as any).then((r) => {
          const fresh = loadItem(id);
          fresh.pkg = r.data as any;
          fresh.updatedAt = new Date().toISOString();
          saveItem(fresh);
          return ok(r.data, "package generated");
        }),
      );
    },
  }),
  tool({
    name: "tools_optimize_hook",
    description:
      "Generate scroll-stopping hook variants for a run's idea and return the best (the first 1.5s decides retention). Use to refine the opening line post-generation. LLM; returns the chosen hook + USD cost.",
    kind: "long",
    schema: z.object({ id: z.string().min(1) }).strict(),
    run: ({ id }) => {
      const it = loadItem(id);
      if (!it.idea) return fail("run has no idea yet");
      const c = resolveChannel(it.channel);
      return asyncResult(pickHook(c, it.idea as any, it.mood).then((r) => ok(r.data, `best hook: ${r.data.best}`)));
    },
  }),
];

// ---------------------------------------------------------------------------
// PREVIEW (cheap iteration on voice / music / b-roll before a full render)
// ---------------------------------------------------------------------------

const previewTools: PipelineTool[] = [
  tool({
    name: "tools_preview_voice",
    description:
      "Synthesize scene-synced TTS narration for a run (optionally just one scene index) so agents can iterate on voice/pacing without a full render. Returns the generated audio src + per-scene durations + word/subtitle cues.",
    kind: "long",
    schema: z.object({ id: z.string().min(1), scene: z.number().int().min(0).optional().describe("0-based scene index; omit for whole run") }).strict(),
    run: ({ id, scene }) => {
      const it = loadItem(id);
      const board = it.storyboard as any;
      if (!board?.scenes?.length) return fail("run has no storyboard scenes yet");
      const c = resolveChannel(it.channel);
      const vs = resolveVoiceSettings(c, it.mood);
      const scenes =
        scene === undefined
          ? board.scenes
          : board.scenes[scene]
            ? [board.scenes[scene]]
            : null;
      if (!scenes) return fail(`scene ${scene} out of range (0..${board.scenes.length - 1})`);
      const v = synthVoiceSceneSynced(`${id}_preview`, scenes, 30, c.voice, vs.kokoroSpeed, c.elevenVoice, vs);
      return v ? ok(v, "voice preview synthesized") : fail("voice synthesis produced nothing (no spoken lines or no TTS toolchain)");
    },
  }),
  tool({
    name: "tools_select_music",
    description:
      "Select / preview a music bed for a run before a full render. Tries MusicGen → curated loop → procedural pad → safety bed (guaranteed when ffmpeg is present). Returns the chosen track src + which source produced it. Lets agents iterate on theme (lab/dark/builder/concept) cheaply.",
    kind: "long",
    schema: z
      .object({
        id: z.string().min(1),
        theme: z.string().optional().describe("override the channel theme bed (e.g. lab, dark, builder, concept)"),
        curatedOnly: z.boolean().default(false).describe("only use a curated loop (no MusicGen / generated pads)"),
      })
      .strict(),
    run: ({ id, theme, curatedOnly }) => {
      const it = loadItem(id);
      const board = it.storyboard as any;
      const durationSec = board?.scenes?.length
        ? board.scenes.reduce((a: number, s: any) => a + (s.durationSec ?? 0), 0)
        : 30;
      const c = resolveChannel(it.channel);
      const bedTheme = theme ?? c.theme;
      if (curatedOnly) {
        const src = curatedBed(`${id}_preview`, durationSec, bedTheme);
        return src ? ok({ src, source: "curated", theme: bedTheme, durationSec }, "curated bed selected") : fail("no curated bed available for that theme (or ffmpeg missing)");
      }
      const m = ensureMusic(`${id}_preview`, durationSec, bedTheme, `${bedTheme} ambient bed for ${it.idea?.topic ?? it.seedIdea}`, { moodId: it.mood });
      return m ? ok({ ...m, theme: bedTheme, durationSec }, `music selected (${m.source})`) : fail("no music produced (ffmpeg missing)");
    },
  }),
  tool({
    name: "tools_search_broll",
    description:
      "Search + resolve a single b-roll asset (stock video via Pexels, falling back to a generated image) for a query, so agents can discover/preview footage before a render. Returns the asset src + type (video|image), or null if nothing on-topic was found.",
    kind: "long",
    schema: z
      .object({
        query: z.string().min(1),
        kind: z.enum(["concrete", "abstract"]).default("concrete").describe("concrete=literal stock footage, abstract=mood/texture"),
      })
      .strict(),
    run: ({ query, kind }) => asyncResult(resolveBroll(query, kind).then((a) => ok(a, a ? `${a.type} resolved` : "nothing on-topic found"))),
  }),
  tool({
    name: "tools_broll_sources",
    description:
      "Report which b-roll / AI-video providers are currently active (API keys present) and which fallbacks are configured. Use this to understand what b-roll quality to expect before running a generation — and to diagnose missing footage.",
    kind: "read",
    schema: z.object({}).strict(),
    run: () => {
      const s = brollSources();
      return ok(s, `${s.sources.length} source(s) active, ${s.fallbacks.length} fallback(s)`);
    },
  }),
  tool({
    name: "tools_moods_list",
    description:
      "List all available mood presets with their visual properties (bgVariant, transitions, fonts, noBroll flag, accent colour, blurb). Use before generating to pick the right mood, or to explain to users what each mood looks like.",
    kind: "read",
    schema: z.object({ includeBlends: z.boolean().default(true).describe("include named blend shortcuts (saas, founder, docu…)") }).strict(),
    run: ({ includeBlends }) => {
      const base = listMoods();
      const result = base.map((m) => {
        const mood = moods[m.id];
        if (!mood) return m;
        const studio = resolveStudio("default", mood, mood.accent);
        return {
          ...m,
          accent: mood.accent,
          bgVariant: studio.bgVariant,
          transitions: mood.transitions ?? [],
          noBroll: mood.noBroll ?? false,
          bpm: mood.bpm,
          tone: mood.tone.slice(0, 120),
        };
      });
      const blends = includeBlends
        ? Object.entries(MOOD_BLENDS).map(([id, spec]) => ({ id, blend: spec, name: id, blurb: `Named blend: ${spec}` }))
        : [];
      return ok({ moods: result, blends, total: result.length + blends.length }, `${result.length} moods + ${blends.length} named blends`);
    },
  }),
  tool({
    name: "tools_render_cover",
    description:
      "Render a designed cover / thumbnail still (the real Cover composition) for a run — usable as a social thumbnail or long-form chapter card. Uses the run's first b-roll as background when available. Returns the cover image path.",
    kind: "long",
    schema: z
      .object({
        id: z.string().min(1),
        title: z.string().min(1),
        eyebrow: z.string().optional(),
        theme: z.string().optional().describe("themeName override (defaults to the run's channel theme)"),
        highlight: z.string().optional().describe("accent/highlight colour"),
        logo: z.string().optional(),
      })
      .strict(),
    run: ({ id, title, eyebrow, theme, highlight, logo }) => {
      const it = loadItem(id) as Record<string, any>;
      const props = {
        title,
        eyebrow,
        themeName: theme ?? resolveChannel(it.channel).theme,
        mood: it.mood,
        highlight,
        logo: logo ?? it.channelLogo,
        handle: it.channelHandle,
        bg: coverBg(id, it.brolls),
      };
      return asyncResult(renderCover(id, props as any).then((p) => (p ? ok({ coverPath: p }, "cover rendered") : fail("cover render failed"))));
    },
  }),
  tool({
    name: "tools_generate_image",
    description:
      "Generate a premium AI image from a text prompt — via Codex CLI `$imagegen` (uses the ChatGPT/Codex subscription, no API key) or gpt-image-1 if OPENAI_API_KEY is set. Saved into the render bundle (public/gen) so it can be used as a scene/cover background. Long-running: starts a background job; the image lands at the returned src.",
    kind: "long",
    schema: z
      .object({
        prompt: z.string().min(3),
        aspect: z.enum(["16:9", "9:16", "1:1"]).default("16:9"),
        name: z.string().optional().describe("filename stem (defaults to a timestamp)"),
      })
      .strict(),
    run: ({ prompt, aspect, name }) => {
      if (imageBackend() === "none") return fail("no image backend — install Codex CLI (logged in) or set OPENAI_API_KEY");
      const stem = (name || `gen_${Date.now()}`).replace(/[^a-z0-9._-]/gi, "_").slice(0, 64);
      const job = spawnCli(["genimage", prompt, "--aspect", aspect, "--name", stem], "tool-genimage.log");
      return ok({ status: "started", ...job, src: `gen/${stem}.png`, backend: imageBackend() }, "image generation started");
    },
  }),
  tool({
    name: "tools_generate_thumbnail",
    description:
      "Regenerate a premium AI thumbnail for a run: an AI key visual (Codex $imagegen / gpt-image-1) composited under the designed Cover (title, eyebrow, brand). Long-running: starts a background job; the result is saved as the run's thumbPath.",
    kind: "long",
    schema: z.object({ id: z.string().min(1) }).strict(),
    run: ({ id }) => {
      if (imageBackend() === "none") return fail("no image backend — install Codex CLI (logged in) or set OPENAI_API_KEY");
      const job = spawnCli(["thumbnail", id], "tool-thumbnail.log");
      return ok({ status: "started", ...job, id }, "thumbnail generation started");
    },
  }),
];

// ---------------------------------------------------------------------------
// WEB SEARCH (generic research for agents)
// ---------------------------------------------------------------------------

const researchTools: PipelineTool[] = [
  tool({
    name: "tools_web_search",
    description:
      "Generic web search for agents researching topics, trends or facts. Cascades through configured providers — Tavily → Brave → SerpAPI → a keyless local scraper — and returns a list of { title, url, description } results plus a compact text context block. Returns [] on any failure so it never blocks. Configure provider keys with the Web Search providers card in the dashboard, or call tools_search_providers to see what's active.",
    kind: "read",
    schema: z.object({ query: z.string().min(1), limit: z.number().int().min(1).max(20).default(5) }).strict(),
    run: ({ query, limit }) => {
      const results = webSearch(query, limit);
      return ok({ query, results, context: searchContext(query, limit) });
    },
  }),
  tool({
    name: "tools_search_providers",
    description:
      "List the web-search providers and which are usable right now (key present via env or the workspace store, or keyless). Use to diagnose why research/web_search returns nothing — if only the keyless scraper is configured and its local server isn't running, results will be empty.",
    kind: "read",
    schema: empty,
    run: () => {
      const providers = searchProviders();
      const active = providers.filter((p) => p.configured);
      return ok({ providers, activeCount: active.length }, `${active.length}/${providers.length} provider(s) usable`);
    },
  }),
];

// ---------------------------------------------------------------------------
// ASSETS (overlays / logos / sfx catalog)
// ---------------------------------------------------------------------------

const assetTools: PipelineTool[] = [
  tool({
    name: "assets_overlay_catalog",
    description: "Get the overlay asset catalog: emoji, shapes and logos available to the renderer.",
    kind: "read",
    schema: empty,
    run: () => ok(overlayCatalog()),
  }),
  tool({
    name: "assets_list_logos",
    description: "List available logo assets.",
    kind: "read",
    schema: empty,
    run: () => ok(listLogos()),
  }),
  tool({
    name: "assets_list_sfx",
    description: "List available sound-effect assets.",
    kind: "read",
    schema: empty,
    run: () => ok(listSfx()),
  }),
];

// ---------------------------------------------------------------------------
// CHANNELS
// ---------------------------------------------------------------------------

const channelTools: PipelineTool[] = [
  tool({
    name: "channels_list",
    description: "List all channels (DNA): id, name, tone, default mood.",
    kind: "read",
    schema: empty,
    run: () =>
      ok(
        Object.values(CHANNELS).map((c) => ({
          id: c.id,
          name: c.name,
          tone: c.tone,
          moods: channelMoods(c).map((m) => m.id),
        })),
      ),
  }),
  tool({
    name: "channels_get",
    description: "Get the full channel DNA for one channel id.",
    kind: "read",
    schema: z.object({ id: z.string().min(1) }).strict(),
    run: ({ id }) => {
      if (!channelIds().includes(id as any)) return fail(`unknown channel: ${id}`);
      return ok(resolveChannel(id) as unknown as Record<string, unknown>);
    },
  }),
];

// ---------------------------------------------------------------------------
// SCHEDULER / AUTOPILOT AGENT
// ---------------------------------------------------------------------------

const schedulerTools: PipelineTool[] = [
  tool({
    name: "scheduler_status",
    description:
      "Report autopilot agent status: launchd install/load state, next due slot, live posting platforms, and a log tail.",
    kind: "read",
    schema: empty,
    run: () => ok(agentStatus() as unknown as Record<string, unknown>),
  }),
  tool({
    name: "scheduler_install",
    description: "Install the launchd autopilot agent (per-minute scheduler tick).",
    kind: "mutate",
    schema: empty,
    run: () => ok({ message: installAgent() }, "agent installed"),
  }),
  tool({
    name: "scheduler_uninstall",
    description: "Uninstall the launchd autopilot agent.",
    kind: "mutate",
    schema: empty,
    run: () => ok({ message: uninstallAgent() }, "agent uninstalled"),
  }),
  tool({
    name: "scheduler_get_schedule",
    description: "Get the posting schedule (slots, one-offs) and what is due now / next.",
    kind: "read",
    schema: empty,
    run: () => {
      const s = loadSchedule();
      return ok({ schedule: s, due: dueSlots(s), next: nextDue(s) });
    },
  }),
  tool({
    name: "scheduler_tick",
    description:
      "Run one scheduler pass now (the same thing launchd invokes each minute: fire due slots/one-offs). Long-running: starts a background job.",
    kind: "long",
    schema: empty,
    run: () => {
      const job = spawnCli(["tick"], "tool-tick.log");
      return ok({ status: "started", ...job }, "scheduler tick started");
    },
  }),
  tool({
    name: "tools_schedule_update",
    description:
      "Add, modify, or remove a posting-schedule slot for a channel (write counterpart to scheduler_get_schedule). Upserts a slot at HH:MM; pass enabled=false to remove that slot. Optionally toggles the channel cadence on. Returns the updated schedule.",
    kind: "mutate",
    schema: z
      .object({
        channel: z.string().min(1),
        time: z.string().regex(/^\d{2}:\d{2}$/).describe("local HH:MM slot time"),
        enabled: z.boolean().default(true).describe("true=add/keep the slot, false=remove it"),
        seed: z.string().optional().describe("optional seed idea; empty = autopilot selects the concept"),
        mood: z.string().optional(),
        public: z.boolean().default(false),
        channelEnabled: z.boolean().optional().describe("set the whole channel cadence on/off"),
      })
      .strict(),
    run: ({ channel, time, enabled, seed, mood, public: pub, channelEnabled }) => {
      const s = loadSchedule();
      let cadence = s.channels.find((c) => c.channel === channel);
      if (!cadence) {
        cadence = { channel, enabled: channelEnabled ?? true, slots: [] };
        s.channels.push(cadence);
      }
      if (channelEnabled !== undefined) cadence.enabled = channelEnabled;
      cadence.slots = cadence.slots.filter((slot) => slot.time !== time);
      if (enabled) {
        cadence.slots.push({ time, channel, mood, seed, public: pub });
        cadence.slots.sort((a, b) => a.time.localeCompare(b.time));
      }
      saveSchedule(s);
      return ok({ schedule: s }, enabled ? `slot ${channel}@${time} upserted` : `slot ${channel}@${time} removed`);
    },
  }),
];

// ---------------------------------------------------------------------------
// CONTENT PLAN / CALENDAR — the canonical CRUD an agent uses to read and curate
// the dated content plan (data/content-plan.json) the algo planner produces and
// the calendar UI renders. Mirrors apps/dashboard/lib/content-plan.ts so MCP /
// SDK / CLI / HTTP all share one implementation. plan_run kicks the planner.
// ---------------------------------------------------------------------------

const PLAN_PLATFORMS = ["youtube", "instagram", "tiktok", "x", "linkedin", "telegram"] as const;
const planPlatform = z.enum(PLAN_PLATFORMS);
const planStatus = z.enum(["idea", "approved", "scheduled", "generated", "dropped", "archived"]);
const YMD = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD");
const HM = z.string().regex(/^\d{2}:\d{2}$/, "time must be HH:MM");

/** Patch fields a human/agent may edit on a planned post (kept in sync with content-plan.ts EDITABLE). */
const planPatch = z
  .object({
    date: YMD.optional(),
    time: HM.optional(),
    status: planStatus.optional(),
    platform: planPlatform.optional(),
    mood: z.string().optional(),
    topic: z.string().optional(),
    angle: z.string().optional(),
    format: z.string().optional(),
    hook: z.string().optional(),
    rationale: z.string().optional(),
    algoLever: z.string().optional(),
  })
  .strict();

const planTools: PipelineTool[] = [
  tool({
    name: "plan_list",
    description:
      "List planned content posts from the calendar plan (data/content-plan.json), newest plan-run first. Optionally filter by channel and/or status, and by default hides archived posts (pass includeArchived=true to show them). Each post has id, date, time, channel, platform, topic, angle, format, hook, rationale, algoLever, scores, overall and status.",
    kind: "read",
    schema: z
      .object({
        channel: z.string().optional(),
        status: planStatus.optional(),
        includeArchived: z.boolean().default(false),
      })
      .strict(),
    run: ({ channel, status, includeArchived }) => {
      let list = loadContentPlan();
      if (channel) list = list.filter((p) => p.channel === channel);
      if (status) list = list.filter((p) => p.status === status);
      else if (!includeArchived) list = list.filter((p) => p.status !== "archived");
      return ok(list, `${list.length} planned post(s)`);
    },
  }),
  tool({
    name: "plan_get",
    description: "Get one planned post by id (full record).",
    kind: "read",
    schema: z.object({ id: z.string().min(1) }).strict(),
    run: ({ id }) => {
      const p = getPlanPost(id);
      return p ? ok(p) : fail(`planned post not found: ${id}`);
    },
  }),
  tool({
    name: "plan_day",
    description:
      "Get every planned post for a single date (YYYY-MM-DD), sorted by time — the data behind the calendar's day view. By default hides archived; pass includeArchived=true to include them.",
    kind: "read",
    schema: z.object({ date: YMD, includeArchived: z.boolean().default(false) }).strict(),
    run: ({ date, includeArchived }) => {
      let list = planPostsForDate(date);
      if (!includeArchived) list = list.filter((p) => p.status !== "archived");
      return ok({ date, posts: list }, `${list.length} post(s) on ${date}`);
    },
  }),
  tool({
    name: "plan_create",
    description:
      "Manually add a single planned post to the calendar (the hand-authored counterpart to the algo planner). Requires channel, date, time, platform and topic; angle/format/mood/hook/rationale/algoLever are optional. Returns the created post with its generated id.",
    kind: "mutate",
    schema: z
      .object({
        channel: z.string().min(1),
        date: YMD,
        time: HM.default("09:00"),
        platform: planPlatform,
        topic: z.string().min(1),
        angle: z.string().default(""),
        format: z.string().default("short"),
        mood: z.string().optional(),
        hook: z.string().optional(),
        rationale: z.string().default("manually added"),
        algoLever: z.string().optional(),
        status: planStatus.default("idea"),
      })
      .strict(),
    run: (input) => {
      const now = new Date().toISOString();
      const id = `man_${now.replace(/[^0-9]/g, "").slice(0, 14)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
      const post: PlannedPost = {
        id,
        date: input.date,
        time: input.time,
        channel: input.channel,
        platform: input.platform as PlatformKey,
        topic: input.topic,
        angle: input.angle,
        format: input.format,
        mood: input.mood,
        hook: input.hook,
        rationale: input.rationale,
        algoLever: input.algoLever,
        status: input.status,
        planRunId: `manual_${now}`,
        createdAt: now,
      };
      appendPlan([post]);
      return ok(post, "planned post created");
    },
  }),
  tool({
    name: "plan_update",
    description:
      "Edit fields on a planned post (date, time, status, platform, mood, topic, angle, format, hook, rationale, algoLever). Only the provided fields change. Returns the updated post.",
    kind: "mutate",
    schema: z.object({ id: z.string().min(1), patch: planPatch }).strict(),
    run: ({ id, patch }) => {
      const p = updatePlanPost(id, patch as Partial<PlannedPost>);
      return p ? ok(p, "planned post updated") : fail(`planned post not found: ${id}`);
    },
  }),
  tool({
    name: "plan_move",
    description:
      "Move (reschedule) a planned post to a new date (YYYY-MM-DD) and optionally a new time (HH:MM) — the API behind the calendar's drag-and-drop. Returns the moved post.",
    kind: "mutate",
    schema: z.object({ id: z.string().min(1), date: YMD, time: HM.optional() }).strict(),
    run: ({ id, date, time }) => {
      const p = movePlanPost(id, date, time);
      return p ? ok(p, `moved to ${date}${time ? " " + time : ""}`) : fail(`planned post not found: ${id}`);
    },
  }),
  tool({
    name: "plan_archive",
    description:
      "Archive a planned post (soft-hide from the active plan without deleting it — sets status to 'archived'). Returns the archived post. Reversible via plan_update status.",
    kind: "mutate",
    schema: z.object({ id: z.string().min(1) }).strict(),
    run: ({ id }) => {
      const p = archivePlanPost(id);
      return p ? ok(p, "planned post archived") : fail(`planned post not found: ${id}`);
    },
  }),
  tool({
    name: "plan_delete",
    description: "Permanently delete a planned post from the calendar plan by id. Use plan_archive for a reversible hide.",
    kind: "mutate",
    schema: z.object({ id: z.string().min(1) }).strict(),
    run: ({ id }) => {
      const removed = removePlanPost(id);
      return removed ? ok({ id }, "planned post deleted") : fail(`planned post not found: ${id}`);
    },
  }),
  tool({
    name: "plan_strategy",
    description:
      "Get the saved strategy brief for a channel (the deep research the planner produced: channel brief, subject playbook, per-cluster cadence). Returns null if no plan has been run for that channel yet.",
    kind: "read",
    schema: z.object({ channel: z.string().min(1) }).strict(),
    run: ({ channel }) => {
      const s = loadStrategy(channel);
      return ok(s ?? null, s ? "strategy loaded" : "no strategy yet for this channel");
    },
  }),
  tool({
    name: "plan_run",
    description:
      "Run the algorithm-hacking planner for a channel: deep channel/subject research + per-platform algorithm playbooks → a dated content plan dripped across the next N days, appended to the calendar. Long-running: starts a background job (watch with plan_list).",
    kind: "long",
    schema: z
      .object({
        channel: z.string().min(1),
        days: z.number().int().min(1).max(90).default(14),
        platforms: z.array(planPlatform).optional().describe("limit to these platforms; omit to use the channel's socials"),
        time: HM.optional().describe("default post time for the plan"),
      })
      .strict(),
    run: ({ channel, days, platforms, time }) => {
      const args = ["algo-plan", "--channel", channel, "--days", String(days)];
      if (platforms?.length) args.push("--platforms", platforms.join(","));
      if (time) args.push("--time", time);
      const job = spawnCli(args, "tool-algo-plan.log");
      return ok({ status: "started", ...job, channel, days }, "planner started");
    },
  }),
];

// ---------------------------------------------------------------------------
// Async bridge: some capabilities are inherently promise-returning but `run`
// has a synchronous ToolResult contract. Such tools wrap their promise with
// asyncResult() (a "pending" marker); callTool() detects it via isPending() and
// awaits the underlying promise. Both helpers live in the leaf ./helpers.ts so
// other tool files (e.g. memory-tools.ts) can use the SAME PENDING symbol.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Canonical exports
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// DRAFT — stepwise, human/agent-in-the-loop post creation. Each tool runs ONE
// stage on a persisted draft (data/runs/<id>.json) and returns the result so a
// user (or agent) can review, hand-edit, regenerate-with-guidance, and approve
// before the next stage — the manual counterpart to pipeline_generate_post.
// ---------------------------------------------------------------------------
const draftTools: PipelineTool[] = [
  tool({
    name: "draft_ideas",
    description:
      "STEP 1 — propose N distinct idea options (topic/angle/format/rationale/mood) for a brand, optionally focused on the operator's direction. Returns options to show the user; nothing is saved yet. Pick one and call draft_set_idea.",
    kind: "read",
    schema: z.object({ channel: z.string().default("labrinox"), seed: z.string().default(""), n: z.number().int().min(1).max(6).default(3) }).strict(),
    run: ({ channel, seed, n }) => asyncResult(draftIdeas(channel, seed, n).then((r) => ok(r, `${r.ideas.length} idea options`))),
  }),
  tool({
    name: "draft_set_idea",
    description:
      "STEP 2 — lock in the chosen (or user-edited) idea and CREATE the draft post. Pass `idea` {topic,angle,format,rationale,mood?}. Optionally set the output format with `kind` (short|longform|static_image|carousel) plus `layoutVariant` (static image) / `slideCount` (carousel). Omit `id` to create a new draft; pass `id` to replace the idea on an existing one. Returns the draft (with its id) to carry into the next steps.",
    kind: "mutate",
    schema: z.object({
      id: z.string().optional(),
      channel: z.string().default("labrinox"),
      seed: z.string().optional(),
      mood: z.string().optional(),
      idea: z.record(z.any()),
      kind: z.enum(["short", "longform", "static_image", "carousel"]).optional(),
      layoutVariant: z.string().optional(),
      slideCount: z.number().int().optional(),
      aspect: z.enum(["9:16", "1:1", "16:9"]).optional().describe("output shape (default 9:16 vertical); a custom width+height overrides this"),
      width: z.number().int().positive().optional().describe("custom canvas width in px (requires height; overrides aspect)"),
      height: z.number().int().positive().optional().describe("custom canvas height in px (requires width; overrides aspect)"),
    }).strict(),
    run: ({ id, channel, seed, mood, idea, kind, layoutVariant, slideCount, aspect, width, height }) =>
      ok(draftSetIdea({ id, channel, seed, mood, idea, kind, layoutVariant, slideCount, aspect, width, height }), "idea set"),
  }),
  tool({
    name: "draft_script",
    description:
      "STEP 3 — write the script (hook → beats → narration → cta) for the draft. Optional `guidance` steers the AI (e.g. 'make the hook a question', 'punchier beats'). Returns the draft with its script for review; edit with draft_set_script.",
    kind: "mutate",
    schema: z.object({ id: z.string().min(1), guidance: z.string().default("") }).strict(),
    run: ({ id, guidance }) => asyncResult(draftScript(id, guidance).then((it) => ok({ id: it.id, status: it.status, script: it.script }, "script written"))),
  }),
  tool({
    name: "draft_set_script",
    description: "STEP 3 (edit) — replace the draft's script with a hand-edited one. Pass `script` {hook,beats[],narration[],cta}.",
    kind: "mutate",
    schema: z.object({ id: z.string().min(1), script: z.record(z.any()) }).strict(),
    run: ({ id, script }) => { const it = draftSetScript(id, script); return ok({ id: it.id, status: it.status, script: it.script }, "script updated"); },
  }),
  tool({
    name: "draft_storyboard",
    description:
      "STEP 4 — build the storyboard (the scene-by-scene plan) from the draft's script. Optional `guidance` steers the AI (e.g. 'more charts', 'open on a big number'). Returns the draft with its storyboard scenes for review; edit with draft_set_storyboard.",
    kind: "mutate",
    schema: z.object({ id: z.string().min(1), guidance: z.string().default("") }).strict(),
    run: ({ id, guidance }) => asyncResult(draftStoryboard(id, guidance).then((it) => ok({ id: it.id, status: it.status, storyboard: it.storyboard }, "storyboard built"))),
  }),
  tool({
    name: "draft_set_storyboard",
    description: "STEP 4 (edit) — replace the draft's storyboard with a hand-edited one (the full Storyboard object with its scenes[]).",
    kind: "mutate",
    schema: z.object({ id: z.string().min(1), storyboard: z.record(z.any()) }).strict(),
    run: ({ id, storyboard }) => { const it = draftSetStoryboard(id, storyboard); return ok({ id: it.id, status: it.status, storyboard: it.storyboard }, "storyboard updated"); },
  }),
  tool({
    name: "draft_get",
    description: "Read a draft's current full state (idea, script, storyboard, status, ledger) by id.",
    kind: "read",
    schema: z.object({ id: z.string().min(1) }).strict(),
    run: ({ id }) => ok(draftGet(id), "draft"),
  }),
  tool({
    name: "draft_render",
    description:
      "STEP 5 — render the approved draft into a video (uses its stored storyboard + script). Toggle voice / music / broll. Long-running: starts a background job and returns its pid + log path. Watch the run via runs_get.",
    kind: "long",
    schema: z.object({ id: z.string().min(1), voice: z.boolean().default(true), music: z.boolean().default(true), broll: z.boolean().default(true), procedural: z.boolean().default(false) }).strict(),
    run: ({ id, voice, music, broll, procedural }) => {
      // The control plane (server) can't render — dispatch to the render fleet,
      // carrying the draft so the device (which doesn't have it on disk) writes +
      // finalizes it. Render devices leave SOCHELI_DISPATCH_RENDERS unset → local.
      if (process.env.SOCHELI_DISPATCH_RENDERS) {
        return asyncResult((async () => {
          const item = loadItem(id);
          const { url, username, password } = brokerConfig();
          const job: Job = { id: newJobId(), type: "render", itemId: id, item, voice, createdAt: new Date().toISOString(), by: "draft" };
          const c = await mqtt.connectAsync(url, { username, password });
          await c.publishAsync(TOPICS.jobs, JSON.stringify(job), { qos: 1 });
          await c.endAsync();
          return ok({ status: "dispatched", jobId: job.id, id }, "render dispatched to the fleet — watch the run for live progress");
        })());
      }
      const args = [id];
      if (voice) args.push("--voice");
      if (music) args.push("--music");
      if (broll) args.push("--broll");
      if (procedural) args.push("--procedural");
      const job = spawnEngine("rerender.ts", args, "tool-draft-render.log");
      return ok({ status: "started", ...job, id }, "render started");
    },
  }),
];

/* Soli's own model — switch what powers the in-app copilot (chat). Exposed on
   every surface (CLI, MCP, SDK, the dashboard, and Soli itself) so you can ask
   Soli "switch to Claude" or set it from the picker / CLI. */
const copilotTools: PipelineTool[] = [
  tool({
    name: "copilot_model",
    description:
      "Get or switch the model that powers Soli (the in-app copilot/chat). action='get' returns the current model + the available presets; action='set' with `model` switches it (e.g. model='anthropic/claude-sonnet-4.6' to run Soli on Claude). Any OpenRouter model slug is accepted. Takes effect on the next message — no restart.",
    kind: "mutate",
    schema: z.object({ action: z.enum(["get", "set"]).default("get"), model: z.string().optional() }).strict(),
    run: ({ action, model }) => {
      if (action === "set") {
        if (!model) return fail("`model` is required for action=set (e.g. 'anthropic/claude-sonnet-4.6')");
        return ok({ model: setCopilotModel(model), presets: COPILOT_MODEL_PRESETS }, `Soli now runs on ${model}`);
      }
      return ok({ model: getCopilotModel(), presets: COPILOT_MODEL_PRESETS }, "current copilot model");
    },
  }),
];

/* Per-task model selection — the AI pipeline is broken into named tasks (one per
   LLM call site, see task-models.ts); the user can pick a model/tier per task.
   Exposed on every surface so the picker UI, the CLI, and Soli all set it. */
const taskModelTools: PipelineTool[] = [
  tool({
    name: "ai_tasks",
    description:
      "List the AI pipeline's named tasks (one per granular LLM call), grouped into stages, each with its default tier and any active per-task model/tier override. Use this to see what's selectable before setting a model with ai_task_model.",
    kind: "read",
    schema: empty,
    run: () => ok({ stages: AI_STAGES, tasks: taskManifest() }, "AI task manifest"),
  }),
  tool({
    name: "ai_task_model",
    description:
      "Set or clear the model/tier for ONE named AI task (e.g. taskId='qa_review'). action='set' with `model` (a provider-appropriate slug) and/or `tier` (cheap|smart|best) overrides that task's LLM; action='clear' reverts to the default. Takes effect on the next pipeline run. List tasks with ai_tasks.",
    kind: "mutate",
    schema: z.object({
      action: z.enum(["set", "clear"]).default("set"),
      taskId: z.string().min(1),
      model: z.string().optional(),
      tier: z.enum(["cheap", "smart", "best"]).optional(),
    }).strict(),
    run: ({ action, taskId, model, tier }) => {
      if (!isAiTask(taskId)) return fail(`unknown ai task: ${taskId} (list with ai_tasks)`);
      if (action === "clear") { clearTaskModel(taskId); return ok({ taskId, cleared: true, tasks: taskManifest() }, `reset ${taskId} to default`); }
      if (!model && !tier) return fail("set requires `model` and/or `tier`");
      const ov = setTaskModel(taskId, { model, tier: tier as AiTaskTier | undefined });
      return ok({ taskId, override: ov, tasks: taskManifest() }, `set ${taskId}`);
    },
  }),
  tool({
    name: "ai_providers",
    description:
      "List every supported LLM provider (OpenAI, Anthropic, Gemini, Groq, DeepSeek, Mistral, xAI, Together, Fireworks, Cerebras, OpenRouter, Ollama/local, …) with its kind, example models, and whether it's connected (an API key is present, or it's a keyless local/CLI provider). Used to populate the per-task model picker — selectable models are grouped by connected provider.",
    kind: "read",
    schema: empty,
    run: () => {
      const ws = process.env.SOCHELI_WORKSPACE_ID;
      const active = getActiveProviderId(ws) ?? (process.env.BRAIN_PROVIDER || "claude").toLowerCase();
      return ok({
        defaultProvider: active,
        providers: PROVIDERS.map((p) => {
          const disabled = isProviderDisabled(ws, p.id);
          const present = p.kind === "cli" || p.auth === "none" || !!getProviderApiKey(ws, p.id) || !!(p.apiKeyEnv && process.env[p.apiKeyEnv]);
          return {
            id: p.id,
            label: p.label,
            kind: p.kind,
            apiKeyEnv: p.apiKeyEnv,
            needsKey: p.kind !== "cli" && p.auth !== "none",
            exampleModels: p.exampleModels,
            connected: present && !disabled,
            disabled,
            revocable: true, // every connection can be revoked (CLI/env/key)
            // where the key came from, for the UI (env keys aren't editable here)
            source: getProviderApiKey(ws, p.id) ? "stored" : p.apiKeyEnv && process.env[p.apiKeyEnv] ? "env" : p.kind === "cli" ? "cli" : p.auth === "none" ? "local" : "none",
            isDefault: p.id === active && !disabled,
            accounts: listProviderAccounts(ws, p.id), // [{id,label,kind,active,addedAt}] — no secrets
          };
        }),
      });
    },
  }),
  tool({
    name: "model_catalog",
    description:
      "The FULL model catalog (~330 models across every provider via OpenRouter, plus connected native providers' own models) with context window, $/M pricing, modality (vision), an approximate community rating, and whether each is available (its provider connected). Feeds the per-task model picker dialog (search / filter / sort / ratings). Cached 24h.",
    kind: "read",
    schema: empty,
    run: () => asyncResult(modelCatalog().then((c) => ok(c, `${c.total} models`))),
  }),
  tool({
    name: "provider_account",
    description:
      "Manage MULTIPLE named credentials on one provider (e.g. two Claude Code OAuth logins, or several API keys). action='add' with id + label + secret (kind 'key' for an API key, 'oauth' for a CLI/OAuth token); action='activate' with accountId picks which is used; action='remove' deletes one. The active account's credential is what the provider uses. Secrets are stored 0600 and never returned.",
    kind: "mutate",
    schema: z.object({
      action: z.enum(["add", "remove", "activate"]).default("add"),
      id: z.string().min(1),
      accountId: z.string().optional(),
      label: z.string().optional(),
      secret: z.string().optional(),
      kind: z.enum(["key", "oauth"]).default("key"),
    }).strict(),
    run: ({ action, id, accountId, label, secret, kind }) => {
      if (!PROVIDERS.some((p) => p.id === id)) return fail(`unknown provider: ${id}`);
      const ws = process.env.SOCHELI_WORKSPACE_ID || "ws_default";
      if (action === "add") {
        if (!secret || !secret.trim()) return fail("add requires `secret` (an API key or OAuth token)");
        const aid = addProviderAccount(ws, id, label || "", secret, kind);
        return ok({ id, accountId: aid, accounts: listProviderAccounts(ws, id) }, `added account to ${id}`);
      }
      if (!accountId) return fail(`${action} requires accountId`);
      if (action === "activate") setActiveAccount(ws, id, accountId);
      else removeProviderAccount(ws, id, accountId);
      return ok({ id, accounts: listProviderAccounts(ws, id) }, `${action} ${id}`);
    },
  }),
  tool({
    name: "provider_revoke",
    description:
      "Revoke (disable) or restore ANY provider connection — local CLI logins, env-keyed, or stored-key. action='revoke' makes the provider unavailable even if a key/CLI login exists; action='restore' re-enables it. For a stored API key, prefer provider_key clear to actually delete it.",
    kind: "mutate",
    schema: z.object({ action: z.enum(["revoke", "restore"]).default("revoke"), id: z.string().min(1) }).strict(),
    run: ({ action, id }) => {
      if (!PROVIDERS.some((p) => p.id === id)) return fail(`unknown provider: ${id}`);
      setProviderDisabled(process.env.SOCHELI_WORKSPACE_ID || "ws_default", id, action === "revoke");
      return ok({ id, disabled: action === "revoke" }, action === "revoke" ? `revoked ${id}` : `restored ${id}`);
    },
  }),
  tool({
    name: "provider_default",
    description:
      "Make a provider the DEFAULT brain — the model family used for any task that has no per-task override. Pass id (e.g. 'anthropic', 'openrouter', 'groq', 'claude'). Keeps every stored key; just flips which provider is active.",
    kind: "mutate",
    schema: z.object({ id: z.string().min(1) }).strict(),
    run: ({ id }) => {
      if (!PROVIDERS.some((p) => p.id === id)) return fail(`unknown provider: ${id}`);
      setActiveProvider(process.env.SOCHELI_WORKSPACE_ID || "ws_default", id);
      return ok({ defaultProvider: id }, `default brain → ${id}`);
    },
  }),
  tool({
    name: "provider_key",
    description:
      "Connect a provider by storing its API key (action='set' with id + apiKey), or disconnect it (action='clear'). Stored 0600 server-side; setting a key does NOT change which provider is the default brain — it just makes that provider available for per-task model selection. Never returns the key.",
    kind: "mutate",
    schema: z.object({ action: z.enum(["set", "clear"]).default("set"), id: z.string().min(1), apiKey: z.string().optional() }).strict(),
    run: ({ action, id, apiKey }) => {
      const ws = process.env.SOCHELI_WORKSPACE_ID || "ws_default";
      if (!PROVIDERS.some((p) => p.id === id)) return fail(`unknown provider: ${id}`);
      if (action === "clear") { clearProviderKey(ws, id); return ok({ id, connected: false }, `disconnected ${id}`); }
      if (!apiKey || !apiKey.trim()) return fail("set requires apiKey");
      setProviderKeyOnly(ws, id, apiKey.trim());
      return ok({ id, connected: true }, `connected ${id}`);
    },
  }),
];

/* Soli self-access: read this instance's OWN source + data so the agent can
   ground answers/actions in how the system actually works. Read-only and
   confined to the repo, with secrets (env, credentials, tokens) denied. */
const REPO_DENY = /(^|\/)(\.git|node_modules|\.next|renders|hf-cache)\/|\.env|credentials|\.pem$|\.key$|claude-oauth|\/data\/ai-providers\//i;
function safeRepoPath(rel: string): string | null {
  const abs = resolvePath(ROOT, rel || ".");
  if (abs !== ROOT && !abs.startsWith(ROOT + "/")) return null; // no traversal outside the repo
  if (REPO_DENY.test(abs)) return null;
  return abs;
}
const repoTools: PipelineTool[] = [
  tool({
    name: "repo_list",
    description: "List a directory inside Socheli's OWN repo (relative to the repo root). Use to explore the codebase structure before reading files.",
    kind: "read",
    schema: z.object({ path: z.string().default(".") }).strict(),
    run: ({ path }) => {
      const abs = safeRepoPath(path);
      if (!abs || !existsSync(abs)) return fail("path not found or blocked");
      const entries = readdirSync(abs, { withFileTypes: true })
        .filter((e) => !REPO_DENY.test(join(abs, e.name)))
        .map((e) => ({ name: e.name, type: e.isDirectory() ? "dir" : "file" }))
        .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1));
      return ok({ path, entries });
    },
  }),
  tool({
    name: "repo_read",
    description: "Read a file from Socheli's OWN repo (source or data) so Soli can ground answers + actions in how the system actually works. Path is relative to the repo root; secrets are blocked.",
    kind: "read",
    schema: z.object({ path: z.string().min(1), maxBytes: z.number().int().min(1).max(200000).default(60000) }).strict(),
    run: ({ path, maxBytes }) => {
      const abs = safeRepoPath(path);
      if (!abs || !existsSync(abs) || !statSync(abs).isFile()) return fail("file not found or blocked");
      const content = readFileSync(abs, "utf8");
      return ok({ path, bytes: content.length, truncated: content.length > maxBytes, content: content.slice(0, maxBytes) });
    },
  }),
  tool({
    name: "repo_search",
    description: "Search Socheli's OWN repo for a string/regex (ripgrep-style) and return matching files + lines. Use to locate where a feature/tool/symbol lives before reading it.",
    kind: "read",
    schema: z.object({ query: z.string().min(1), path: z.string().default("."), max: z.number().int().min(1).max(200).default(60) }).strict(),
    run: ({ query, path, max }) => {
      const abs = safeRepoPath(path);
      if (!abs || !existsSync(abs)) return fail("path not found or blocked");
      const r = spawnSync("grep", ["-rinI", "--exclude-dir=.git", "--exclude-dir=node_modules", "--exclude-dir=.next", "-e", query, abs], { encoding: "utf8", maxBuffer: 8_000_000, timeout: 15000 });
      const lines = (r.stdout || "").split("\n").filter(Boolean)
        .filter((l) => !REPO_DENY.test(l.split(":")[0]))
        .slice(0, max)
        .map((l) => l.replace(ROOT + "/", ""));
      return ok({ query, matches: lines.length, lines });
    },
  }),
];

export const pipelineTools: PipelineTool[] = [
  ...generationTools,
  ...draftTools,
  ...copilotTools,
  ...taskModelTools,
  ...repoTools,
  ...conceptTools,
  ...runTools,
  ...publishTools,
  ...derivativeTools,
  ...abtestTools,
  ...analyticsTools,
  ...intelTools,
  ...editLoopTools,
  ...previewTools,
  ...researchTools,
  ...deepResearchTools,
  ...assetTools,
  ...channelTools,
  ...schedulerTools,
  ...planTools,
  ...dnaTools,
  ...missionTools,
  ...harnessTools,
  ...memoryTools,
  ...commentTools,
  ...dmTools,
  ...connectionTools,
  ...igConnectionTools,
  ...commentTriggerTools,
  ...responderTools,
  ...insightsTools,
  ...adminTools,
  ...calendarAdminTools,
  ...aiDmTools,
  ...imageTools,
  ...fleetTools,
  ...observationTools,
  ...adsTools,
  ...creativeTools,
  ...timelineTools,
  ...mixTools,
  ...compTools,
  ...timelineEditTools,
  ...ingestSeedTools,
  ...understandingTools,
  ...ingestTools,
];

/** Every capability in one list: editor tools + pipeline tools. */
export const allTools: EditorTool[] = [...editorTools, ...pipelineTools];

/** Map for O(1) lookup (pipeline tools carry kind + zod schema). */
const pipelineByName = new Map(pipelineTools.map((t) => [t.name, t]));

/**
 * Call any tool by name. editor_* names are delegated to callEditorTool.
 * Pipeline tools validate their input against the tool's zod schema first,
 * then run. Tools whose work is async resolve their promise here.
 */
export async function callTool(name: string, input: any = {}): Promise<ToolResult> {
  // editor_*-prefixed names route to the legacy editor-tools dispatcher — UNLESS the
  // name is a registered pipeline tool (e.g. understanding's editor_understand* incl.
  // editor_understand_dense_vision). Those carry zod schemas + the detached-spawn
  // contract and must go through the pipeline path, not callEditorTool (which only
  // knows the legacy editorTools and would 404 them).
  if (name.startsWith("editor_") && !pipelineByName.has(name)) return callEditorTool(name, input);

  const t = pipelineByName.get(name);
  if (!t) return { ok: false, message: `unknown tool: ${name}` };

  let parsed = t.schema.safeParse(input ?? {});
  if (!parsed.success && input && typeof input === "object") {
    // Callers (dashboard copilot / API) pin tenancy onto every call via
    // scopeArgs (workspaceId/createdBy). Most tool schemas are .strict() and
    // don't declare those fields — strip the pins and retry so tenancy-
    // agnostic tools keep working; tools that DO declare them (ads_*) parse
    // on the first attempt and keep the values.
    const onlyTenantKeys = parsed.error.issues.every(
      (i) => i.code === "unrecognized_keys" && (i as { keys?: string[] }).keys?.every((k) => k === "workspaceId" || k === "createdBy"),
    );
    if (onlyTenantKeys) {
      const { workspaceId: _ws, createdBy: _cb, ...rest } = input as Record<string, unknown>;
      parsed = t.schema.safeParse(rest);
    }
  }
  if (!parsed.success) {
    return {
      ok: false,
      message: `invalid input for ${name}: ${parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}`,
    };
  }

  const result = t.run(parsed.data);
  if (isPending(result)) {
    try {
      return await (result as any)[PENDING];
    } catch (e) {
      return fail(e);
    }
  }
  return result;
}

/**
 * Single canonical manifest for every surface: name + description + kind +
 * jsonschema for every tool. Editor tools default to kind "mutate" (they read
 * and write run files); the few pure readers are tagged accordingly.
 */
export function toolsManifest(): { name: string; description: string; kind: ToolKind; inputSchema: Record<string, unknown> }[] {
  const editorReadOnly = new Set([
    "editor_list_items",
    "editor_get_state",
    "editor_get_scene",
    "editor_validate",
    "editor_watch_video",
    "editor_extract_frame",
    "editor_scan_entire_video",
    "editor_analyze_av",
    "editor_video_evidence",
    "editor_competitive_deep_review",
    "editor_competitive_intel",
    "editor_compare_renders",
    "editor_readability_review",
    "editor_visual_readability_review",
    "editor_ocr_review",
    "editor_competitive_suite",
  ]);
  const editorLong = new Set(["editor_start_rerender"]);

  const editorEntries = editorTools.map((t) => ({
    name: t.name,
    description: t.description,
    kind: (editorLong.has(t.name) ? "long" : editorReadOnly.has(t.name) ? "read" : "mutate") as ToolKind,
    inputSchema: t.inputSchema,
  }));

  const pipelineEntries = pipelineTools.map((t) => ({
    name: t.name,
    description: t.description,
    kind: t.kind,
    inputSchema: t.inputSchema,
  }));

  return [...editorEntries, ...pipelineEntries];
}

// zodToJsonSchema lives in ./helpers.ts (leaf, cycle-free) and is re-exported
// from the shared-helpers block near the top of this file.
