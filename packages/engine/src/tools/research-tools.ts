/**
 * research-tools.ts — registry tools for the §2 research harness.
 *
 * Exposes the deep-research loop (plan → sweep → fetch → extract → verify →
 * synthesize) to every surface via the unified registry:
 *
 *   research_run    (long)  start a verified research run (detached worker)
 *   research_get    (read)  full run by id: steps, sources, claims, report
 *   research_list   (read)  index rows, filterable by kind/channel
 *   research_fresh  (read)  TTL-cache lookup — the "do we already know this?" check
 *
 * Named `deepResearchTools` (not `researchTools`) because registry.ts already
 * has a local `researchTools` group holding the legacy raw web-search tool.
 * The integrator spreads this array into `pipelineTools` in registry.ts.
 *
 * NOTE ON IMPORTS: the shared helpers (ok/fail/spawnEngine/tool + the
 * PipelineTool type) come from the LEAF ./helpers.ts module, NOT registry.ts.
 * registry.ts imports this file (to spread the tools), so importing helpers
 * from registry.ts would form a cycle — and under tsx (esbuild keepNames) a
 * helper invoked across that cycle throws "__name is not a function" at load
 * because the per-module __name var isn't initialized yet. helpers.ts is a leaf
 * with no back-edge, so it is fully evaluated before any top-level tool() call.
 */

import { z } from "zod";

import { ok, fail, spawnEngine, tool, type PipelineTool } from "./helpers.ts";
import { findFresh, listRuns, loadRun, newResearchId } from "../research/store.ts";

// ---------------------------------------------------------------------------
// Shared input pieces
// ---------------------------------------------------------------------------

const kindEnum = z.enum(["trend", "algo", "topic", "competitor", "deep"]);
const depthEnum = z.enum(["quick", "standard", "deep"]);

// ---------------------------------------------------------------------------
// The tools
// ---------------------------------------------------------------------------

export const deepResearchTools: PipelineTool[] = [
  tool({
    name: "research_run",
    description:
      "Run a multi-step VERIFIED research pass (plan → web sweep → fetch sources → extract → cross-verify claims → cited markdown report). Long-running: starts a detached worker and returns the run id immediately — poll research_get with that id. Pass maxAgeH to transparently reuse a fresh cached run for the same question instead of paying for a new one.",
    kind: "long",
    schema: z
      .object({
        query: z.string().min(1).describe("the research question"),
        kind: kindEnum.default("topic").describe("what class of question this is (drives planning + cache TTL)"),
        depth: depthEnum.default("standard").describe("quick ≈3 queries/5 sources, standard ≈5/10, deep ≈8/20 (deep also synthesizes on the best tier)"),
        channel: z.string().optional().describe("channel/brand id this research is for (scopes the cache + steers the report)"),
        ttlHours: z.number().positive().optional().describe("override the cache freshness window written onto the run"),
        maxAgeH: z.number().positive().optional().describe("reuse a cached done run no older than this many hours instead of starting a new one"),
      })
      .strict(),
    run: ({ query, kind, depth, channel, ttlHours, maxAgeH }) => {
      // Cache short-circuit: identical question (stable hash of kind+channel+
      // normalized query) answered recently → return it, zero cost, zero wait.
      if (maxAgeH) {
        const cached = findFresh(kind, query, maxAgeH, channel);
        if (cached) return ok({ status: "cached", id: cached.id, run: cached }, `reused fresh run ${cached.id} (${kind}, <${maxAgeH}h old)`);
      }
      // Pre-allocate the id so the caller can poll research_get while the
      // detached worker is still planning/fetching.
      const id = newResearchId(kind);
      const args = [query, "--kind", kind, "--depth", depth, "--id", id];
      if (channel) args.push("--channel", channel);
      if (ttlHours) args.push("--ttl", String(ttlHours));
      const job = spawnEngine("research/run-cli.ts", args, `tool-research-${id}.log`);
      return ok({ status: "started", id, kind, depth, ...job }, `research started — poll research_get with id ${id}`);
    },
  }),

  tool({
    name: "research_get",
    description:
      "Get one research run by id: status (running/done/failed), live step log, sources, adjudicated claims (verified / single-source / disputed) and the final cited markdown report.",
    kind: "read",
    schema: z.object({ id: z.string().min(1) }).strict(),
    run: ({ id }) => {
      const run = loadRun(id);
      if (!run) return fail(`no research run: ${id}`);
      return ok(run as unknown as Record<string, unknown>);
    },
  }),

  tool({
    name: "research_list",
    description: "List research runs (newest first) from the index: id, kind, query, channel, age, ttl, status. Filter by kind and/or channel.",
    kind: "read",
    schema: z
      .object({
        kind: kindEnum.optional(),
        channel: z.string().optional(),
        limit: z.number().int().min(1).max(200).default(20),
      })
      .strict(),
    run: ({ kind, channel, limit }) => ok({ runs: listRuns({ kind, channel, limit }) }),
  }),

  tool({
    name: "research_fresh",
    description:
      "Cache lookup: return the freshest DONE research run answering this exact question (stable hash of kind + channel + normalized query) if it is younger than maxAgeH — or fresh:false. Call this before research_run to avoid paying for research the system already has.",
    kind: "read",
    schema: z
      .object({
        kind: kindEnum,
        query: z.string().min(1),
        maxAgeH: z.number().positive().default(24),
        channel: z.string().optional(),
      })
      .strict(),
    run: ({ kind, query, maxAgeH, channel }) => {
      const run = findFresh(kind, query, maxAgeH, channel);
      if (!run) return ok({ fresh: false }, `no fresh ${kind} run (<${maxAgeH}h) for that query`);
      return ok({ fresh: true, id: run.id, run: run as unknown as Record<string, unknown> });
    },
  }),

  tool({
    name: "trending_sounds",
    description:
      "Research currently viral/trending audio tracks on Instagram Reels and TikTok that fit a given niche or mood. Returns a ranked list of sound names, artists, usage counts, why each is trending, and which content niches it suits. Use this before generating a post to pick a music direction that rides an active audio trend — IG's algorithm boosts content using trending sounds. Results are cached for 6 hours per platform+niche combo.",
    kind: "read",
    schema: z
      .object({
        platform: z.enum(["instagram", "tiktok", "both"]).default("instagram"),
        niche: z.string().min(1).describe("content niche, e.g. 'psychology', 'motivation', 'business', 'neuroscience'"),
        mood: z.string().optional().describe("target mood/vibe, e.g. 'cinematic', 'motivational', 'calm'"),
        limit: z.number().int().min(1).max(20).default(8),
      })
      .strict(),
    run: ({ platform, niche, mood, limit }) => {
      // Check cache first (6h TTL)
      const cacheKey = `${platform}:${niche}:${mood ?? ""}`;
      const cached = findFresh("trend", `trending sounds ${niche} ${mood ?? ""} ${platform}`, 6);
      if (cached?.report) {
        try {
          const data = JSON.parse(cached.report);
          if (Array.isArray(data?.sounds)) return ok({ sounds: data.sounds.slice(0, limit), cached: true, runId: cached.id });
        } catch { /* fall through */ }
      }
      // Kick off a fresh research run
      const query = `Currently trending viral audio sounds on ${platform === "both" ? "Instagram Reels and TikTok" : platform === "instagram" ? "Instagram Reels" : "TikTok"} for ${niche} content${mood ? ` with a ${mood} mood/vibe` : ""}. List the top trending sounds right now: sound name, artist/creator, approximate usage count, why it's trending, which content niches it suits best, and whether it's still on the upswing or peaking. Focus on sounds that are CURRENTLY viral (last 2-4 weeks), not past trends.`;
      const id = newResearchId("trend");
      spawnEngine("cli.ts", ["research", "--id", id, "--kind", "trend", "--query", query, "--depth", "quick"], `research-${id}.log`);
      return ok({ started: true, runId: id, message: `Trending sounds research started (run id: ${id}). Poll research_get with this id — usually ready in 60-90s. Results will be cached 6h.` });
    },
  }),
];
