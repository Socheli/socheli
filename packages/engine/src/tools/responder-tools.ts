/**
 * responder-tools.ts — registry tools for the per-brand custom responder agent.
 * Exposes config / templates / test / run to every surface via the one registry.
 *
 *   responder_get    (read)    the brand's responder config (rules, default, tone)
 *   responder_set    (mutate)  persist the brand's responder config
 *   responder_test   (long)    DRY-RUN over the stored inbox — what each rule WOULD do
 *   responder_run    (long)    *** GATED *** LIVE run: auto_send replies, draft, flag
 *   template_list    (read)    saved canned replies for the brand
 *   template_save    (mutate)  upsert a canned reply (generates an id if absent)
 *   template_delete  (mutate)  remove a canned reply by id
 *
 * THE GATE: responder_run is the only tool that can send live brand voice — it is
 * withheld from the autonomous community_manager role (orchestrator wires the
 * allowlist), exactly like comment_send/dm_send. responder_test is the safe
 * preview a human inspects before enabling. Imports only from the leaf ./helpers.ts.
 */

import { z } from "zod";

import {
  ResponderAction,
  ResponderChannelKind,
  ResponderSentiment,
} from "@os/schemas";

import { asyncResult, fail, ok, tool, type PipelineTool } from "./helpers.ts";
import {
  deleteTemplate,
  loadResponderConfig,
  loadTemplates,
  runResponder,
  saveResponderConfig,
  upsertTemplate,
} from "../responder.ts";

const channelArg = z.string().min(1).describe("brand/channel id (scopes the responder config + templates)");

// ResponderRule shape WITHOUT tenant fields, accepted by responder_set.
const ruleInput = z
  .object({
    id: z.string().describe("stable rule id (any unique string)"),
    name: z.string().describe("human label for the rule"),
    enabled: z.boolean().default(true).describe("disabled rules are skipped during matching"),
    match: z
      .object({
        keywords: z.array(z.string()).optional().describe("case-insensitive substrings; ANY match qualifies"),
        topicHint: z.string().optional().describe("free-text topic the classifier maps against"),
        sentiment: z.array(ResponderSentiment).optional().describe("inbound sentiments this rule matches"),
        channel: ResponderChannelKind.default("any").describe("which surface: comment | dm | any"),
      })
      .strict(),
    action: ResponderAction.describe("auto_send | draft | flag when this rule matches"),
    templateId: z.string().optional().describe("if set, replies use this template's body"),
  })
  .strict();

export const responderTools: PipelineTool[] = [
  tool({
    name: "responder_get",
    description:
      "Read the brand's custom-responder config: the master enabled switch, ordered rules, the default action for unmatched items, tone notes, the 24h-DM-window setting and the never-auto sentiment floor. Seeds a safe disabled default on first read.",
    kind: "read",
    schema: z.object({ channel: channelArg, workspaceId: z.string().optional().describe("tenant workspace id (optional)") }).strict(),
    run: ({ channel, workspaceId }) => ok({ channel, config: loadResponderConfig(channel, workspaceId) }),
  }),

  tool({
    name: "responder_set",
    description:
      "Persist the brand's responder config. Accepts the full config minus tenant fields (workspaceId/createdBy are stamped server-side). defaultAction ships as auto_send — toggle to draft in one switch. complaint/risky can never auto_send regardless of rules (guardrail floor).",
    kind: "mutate",
    schema: z
      .object({
        channel: channelArg,
        enabled: z.boolean().default(false).describe("master switch; false = responder dormant for this brand"),
        rules: z.array(ruleInput).default([]).describe("ordered rules; first enabled match wins"),
        defaultAction: ResponderAction.default("auto_send").describe("action for items no rule matched"),
        toneNotes: z.string().optional().describe("extra voice guidance layered on the Brand Genome"),
        respectDmWindow: z.boolean().default(true).describe("DM auto_send only inside the 24h window"),
        neverAutoSentiments: z
          .array(ResponderSentiment)
          .default(["complaint", "risky"])
          .describe("guardrail: these sentiments can never auto_send"),
        workspaceId: z.string().optional().describe("tenant workspace id (optional)"),
      })
      .strict(),
    run: ({ channel, enabled, rules, defaultAction, toneNotes, respectDmWindow, neverAutoSentiments, workspaceId }) => {
      const saved = saveResponderConfig({
        channel,
        enabled,
        rules,
        defaultAction,
        toneNotes,
        respectDmWindow,
        neverAutoSentiments,
        ...(workspaceId ? { workspaceId } : {}),
      });
      return ok({ channel, config: saved }, "responder config saved");
    },
  }),

  tool({
    name: "responder_test",
    description:
      "DRY-RUN the responder over the brand's STORED inbox (no live pull, NO sends, NO drafts written) and return per-item decisions with would_send / would_draft / would_flag outcomes — the preview of what each rule WOULD do before you enable auto-send.",
    kind: "long",
    schema: z
      .object({
        channel: channelArg,
        scope: z.enum(["comment", "dm", "both"]).default("both").describe("which surfaces to test"),
        limit: z.number().int().positive().optional().describe("max items to evaluate (default 25)"),
        workspaceId: z.string().optional(),
      })
      .strict(),
    run: ({ channel, scope, limit, workspaceId }) =>
      asyncResult(
        runResponder(channel, { dryRun: true, scope, limit, workspaceId }).then((res) =>
          res.ok
            ? ok({ channel, dryRun: true, summary: res.summary, decisions: res.decisions }, `dry-run: ${res.summary.total} item(s) — ${res.summary.wouldSend} send, ${res.summary.wouldDraft} draft, ${res.summary.wouldFlag} flag`)
            : fail(res.reason),
        ),
      ),
  }),

  tool({
    name: "responder_run",
    description:
      "*** GATED, LIVE *** Run the responder over the brand's STORED inbox and ACT: auto_send replies go out via the existing gated send (24h window + complaint/risky guardrails still enforced), draft items are queued in /inbox, flagged items are recorded only. This is a human/operator action — withheld from the autonomous community_manager role.",
    kind: "long",
    schema: z
      .object({
        channel: channelArg,
        scope: z.enum(["comment", "dm", "both"]).default("both"),
        limit: z.number().int().positive().optional().describe("max items to process (default 25)"),
        workspaceId: z.string().optional(),
      })
      .strict(),
    run: ({ channel, scope, limit, workspaceId }) =>
      asyncResult(
        runResponder(channel, { dryRun: false, scope, limit, workspaceId }).then((res) =>
          res.ok
            ? ok({ channel, dryRun: false, summary: res.summary, decisions: res.decisions }, `responded: ${res.summary.sent} sent, ${res.summary.drafted} drafted, ${res.summary.flagged} flagged`)
            : fail(res.reason),
        ),
      ),
  }),

  tool({
    name: "template_list",
    description: "List the brand's saved canned replies (reply templates) — id, name, body and tags.",
    kind: "read",
    schema: z.object({ channel: channelArg }).strict(),
    run: ({ channel }) => {
      const templates = loadTemplates(channel);
      return ok({ channel, count: templates.length, templates });
    },
  }),

  tool({
    name: "template_save",
    description: "Upsert a saved canned reply for the brand. Omit `id` to create a new template (an id is generated); pass an existing `id` to update it in place.",
    kind: "mutate",
    schema: z
      .object({
        channel: channelArg,
        id: z.string().optional().describe("existing template id to update; omit to create"),
        name: z.string().min(1).describe("human label for the template"),
        body: z.string().min(1).describe("the canned reply text"),
        tags: z.array(z.string()).default([]).describe("optional tags for grouping"),
        workspaceId: z.string().optional(),
      })
      .strict(),
    run: ({ channel, id, name, body, tags, workspaceId }) => {
      const saved = upsertTemplate(channel, {
        id: id ?? "",
        channel,
        name,
        body,
        tags,
        ...(workspaceId ? { workspaceId } : {}),
      });
      return ok({ channel, template: saved }, id ? "template updated" : "template created");
    },
  }),

  tool({
    name: "template_delete",
    description: "Delete a brand's saved canned reply by id.",
    kind: "mutate",
    schema: z.object({ channel: channelArg, id: z.string().min(1).describe("template id to delete") }).strict(),
    run: ({ channel, id }) => {
      const removed = deleteTemplate(channel, id);
      return removed ? ok({ channel, id, removed: true }, "template deleted") : fail(`template ${id} not found for ${channel}`);
    },
  }),
];
