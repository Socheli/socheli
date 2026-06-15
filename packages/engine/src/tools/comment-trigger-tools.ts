/**
 * comment-trigger-tools.ts — the "comment a keyword → get a DM" mechanic.
 *
 *   ctrigger_get   (read)    the channel's comment→DM trigger config
 *   ctrigger_set   (mutate)  set rules + the master enabled switch
 *   ctrigger_test  (long)    DRY-RUN over stored comments (no DMs sent)
 *   ctrigger_run   (long)    *** GATED *** live: DM matching commenters (private replies)
 *
 * A live run sends a private reply (DM) to each commenter whose comment matches a
 * rule — gated by the kill-switch, token-gated, deduped per comment + per user.
 * Imports from the leaf ./helpers.ts (no registry cycle).
 */

import { z } from "zod";

import { asyncResult, fail, ok, tool, type PipelineTool } from "./helpers.ts";
import { loadTriggerConfig, saveTriggerConfig, runCommentTriggers, TriggerRule } from "../comment-triggers.ts";

const channelArg = z.string().min(1).describe("channel/brand id");

export const commentTriggerTools: PipelineTool[] = [
  tool({
    name: "ctrigger_get",
    description: "Read a brand's comment→DM trigger config: the master switch and the keyword rules (each fires a DM to anyone who comments a matching keyword).",
    kind: "read",
    schema: z.object({ channel: channelArg }).strict(),
    run: ({ channel }) => ok({ channel, config: loadTriggerConfig(channel) }),
  }),

  tool({
    name: "ctrigger_set",
    description:
      "Set a brand's comment→DM triggers. Each rule: keywords (case-insensitive substrings; ANY match fires, or anyComment=true for all), dmMessage (the DM sent to the commenter — usually a link/CTA), optional publicReply (a public 'check your DMs' comment), oncePerUser (default true). The master `enabled` must be true for live runs to send.",
    kind: "mutate",
    schema: z
      .object({
        channel: channelArg,
        enabled: z.boolean().default(false),
        rules: z.array(TriggerRule).default([]),
      })
      .strict(),
    run: ({ channel, enabled, rules }) => {
      const saved = saveTriggerConfig({ channel, enabled, rules });
      return ok({ channel, config: saved }, `triggers saved (${saved.rules.length} rule(s), ${enabled ? "ENABLED" : "disabled"})`);
    },
  }),

  tool({
    name: "ctrigger_test",
    description: "DRY-RUN the comment→DM triggers over the brand's STORED comments (run comments_pull first). Shows which comments WOULD trigger a DM and via which rule — no DMs sent.",
    kind: "long",
    schema: z.object({ channel: channelArg, limit: z.number().int().positive().optional() }).strict(),
    run: ({ channel, limit }) =>
      asyncResult(
        runCommentTriggers(channel, { dryRun: true, limit }).then((r) =>
          r.ok ? ok({ channel, dryRun: true, summary: r.summary, decisions: r.decisions }, `${r.summary.wouldDm} comment(s) would trigger a DM`) : fail(r.reason),
        ),
      ),
  }),

  tool({
    name: "ctrigger_run",
    description:
      "*** GATED, LIVE *** Run the comment→DM triggers: send a private-reply DM to every commenter whose comment matches a rule (within the 7-day private-reply window). Honours the kill-switch; dedupes per comment + per user. A human/operator action.",
    kind: "long",
    schema: z.object({ channel: channelArg, limit: z.number().int().positive().optional() }).strict(),
    run: ({ channel, limit }) =>
      asyncResult(
        runCommentTriggers(channel, { dryRun: false, limit }).then((r) =>
          r.ok ? ok({ channel, summary: r.summary, decisions: r.decisions }, `DM'd ${r.summary.dmd} commenter(s)`) : fail(r.reason),
        ),
      ),
  }),
];
