/**
 * insights-tools.ts — registry tools for per-brand account-level IG insights.
 *
 *   insights_pull       (long)   fetch + persist a fresh account-insight snapshot
 *   insights_get        (read)   the latest stored snapshot for a brand (or null)
 *   insights_scorecard  (read)   follower/reach deltas + engagement over snapshots
 *
 * Account-level metrics (reach / engagement / followers) for the brand's CONNECTED
 * Instagram account — distinct from per-post media analytics. Read tools never hit
 * the network; insights_pull is token-gated (via resolveIgCreds inside ../insights.ts)
 * and degrades cleanly when a brand isn't connected.
 *
 * Imports come from the LEAF ./helpers.ts (asyncResult/ok/fail/tool) — NOT
 * registry.ts — so there is no import cycle (see helpers.ts header). The integrator
 * spreads `insightsTools` into `pipelineTools`.
 */

import { z } from "zod";

import { asyncResult, fail, ok, tool, type PipelineTool } from "./helpers.ts";
import { insightScorecard, latestInsight, pullAccountInsights } from "../insights.ts";

const channelArg = z.string().min(1).describe("brand/channel id whose connected IG account to read");

export const insightsTools: PipelineTool[] = [
  tool({
    name: "insights_pull",
    description:
      "Fetch a fresh account-level Instagram insight snapshot (reach, impressions, profile views, accounts engaged, total interactions, followers) for a brand's CONNECTED account and store it. Token-gated: returns a clear reason when the brand has no connection. Distinct from per-post analytics.",
    kind: "long",
    schema: z
      .object({
        channel: channelArg,
        period: z.enum(["day", "week", "days_28"]).optional().describe("insight aggregation window (default day)"),
      })
      .strict(),
    run: ({ channel, period }) =>
      asyncResult(
        pullAccountInsights(channel, { period }).then((res) =>
          "ok" in res && res.ok === false ? fail(res.reason) : ok(res),
        ),
      ),
  }),

  tool({
    name: "insights_get",
    description:
      "Return the most recent stored account-level insight snapshot for a brand (reach/engagement/followers), or null if none has been captured yet. Pure read — no network.",
    kind: "read",
    schema: z.object({ channel: channelArg }).strict(),
    run: ({ channel }) => ok(latestInsight(channel)),
  }),

  tool({
    name: "insights_scorecard",
    description:
      "Roll up a brand's stored account-insight snapshots into a scorecard: latest metrics, follower delta, reach delta, engagement rate, sample count and the captured window. Pure read — no network.",
    kind: "read",
    schema: z.object({ channel: channelArg }).strict(),
    run: ({ channel }) => ok(insightScorecard(channel)),
  }),
];
