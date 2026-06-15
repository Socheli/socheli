import { z } from "zod";
import { TenantFields } from "./tenancy.ts";

/* ════════════════════════════════════════════════════════════════════════
   RESPONDER — per-brand custom responder agent: rules, brand config,
   templates, classification + decision rows.

   Each brand configures an ordered list of RULES (match condition → action of
   auto_send / draft / flag) plus a brand-level DEFAULT action for unmatched
   items. The responder drafts in Brand-Genome voice; auto_send still respects
   the 24h DM window; complaint/risky inbound can never auto_send (guardrail
   floor). A test/dry-run returns ResponderDecision rows with would_* outcomes
   so the operator sees what each rule WOULD do before enabling.

   Mirrors memory.ts: tiny, .strict(), const + z.infer pair, TenantFields where
   owned. The responder ENGINE (classify, match, draft, send) lives engine-side;
   these zod schemas are the data that persists / crosses the wire.
   ════════════════════════════════════════════════════════════════════════ */

/* The action a rule (or the brand default) resolves to.
   auto_send = reply live (gated, window/guardrail-respecting); draft = queue for
   human review in /inbox; flag = record only, never reply. */
export const ResponderAction = z.enum(["auto_send", "draft", "flag"]);
export type ResponderAction = z.infer<typeof ResponderAction>;

/* Classifier-assigned sentiment. complaint/risky are the guardrail floor — they can
   never auto_send regardless of rule. */
export const ResponderSentiment = z.enum([
  "positive",
  "neutral",
  "question",
  "negative",
  "complaint",
  "risky",
]);
export type ResponderSentiment = z.infer<typeof ResponderSentiment>;

/* Which surface a rule applies to. */
export const ResponderChannelKind = z.enum(["comment", "dm", "any"]);
export type ResponderChannelKind = z.infer<typeof ResponderChannelKind>;

/* A rule's match condition. ANY keyword substring (case-insensitive) OR sentiment
   membership OR topic-hint mapping qualifies; channel narrows to comment/dm. */
export const ResponderMatch = z
  .object({
    keywords: z
      .array(z.string())
      .optional()
      .describe("case-insensitive substrings; ANY match qualifies"),
    topicHint: z.string().optional().describe("free-text topic the classifier maps against"),
    sentiment: z.array(ResponderSentiment).optional(),
    channel: ResponderChannelKind.default("any"),
  })
  .strict();
export type ResponderMatch = z.infer<typeof ResponderMatch>;

/* One ordered rule. First enabled rule whose match qualifies wins. */
export const ResponderRule = z
  .object({
    id: z.string(),
    name: z.string(),
    enabled: z.boolean().default(true),
    match: ResponderMatch,
    action: ResponderAction,
    templateId: z.string().optional().describe("if set, reply uses this template body"),
  })
  .strict();
export type ResponderRule = z.infer<typeof ResponderRule>;

/* Per-brand responder configuration. Owned by a workspace (TenantFields). */
export const ResponderConfig = z
  .object({
    ...TenantFields,
    channel: z.string().describe("brand/channel id"),
    enabled: z
      .boolean()
      .default(false)
      .describe("master switch; false = subsystem dormant for this brand"),
    rules: z.array(ResponderRule).default([]),
    defaultAction: ResponderAction.default("auto_send").describe(
      "action for items no rule matched; ships auto_send, toggle to draft in one switch",
    ),
    toneNotes: z.string().optional().describe("extra voice guidance layered on Brand Genome"),
    respectDmWindow: z
      .boolean()
      .default(true)
      .describe("DM auto_send only inside the 24h window"),
    neverAutoSentiments: z
      .array(ResponderSentiment)
      .default(["complaint", "risky"])
      .describe("guardrail: these can never auto_send regardless of rule"),
    updatedAt: z.string().optional(),
  })
  .strict();
export type ResponderConfig = z.infer<typeof ResponderConfig>;

/* A saved canned reply (ReplyTemplate). Owned by a workspace. */
export const ResponderTemplate = z
  .object({
    ...TenantFields,
    id: z.string(),
    channel: z.string().describe("brand/channel id"),
    name: z.string(),
    body: z.string(),
    tags: z.array(z.string()).default([]),
    createdAt: z.string().optional(),
  })
  .strict();
export type ResponderTemplate = z.infer<typeof ResponderTemplate>;

/* The brain.think<T> classifier output schema. */
export const ResponderClassification = z
  .object({
    sentiment: ResponderSentiment,
    priority: z.enum(["low", "normal", "high", "urgent"]),
    topic: z.string().optional(),
  })
  .strict();
export type ResponderClassification = z.infer<typeof ResponderClassification>;

/* One decision row from a responder run (live or dry-run). The dry-run test returns
   these with would_* outcomes; a live run returns sent/drafted/flagged/skipped. */
export const ResponderDecision = z
  .object({
    itemId: z.string(),
    kind: z.enum(["comment", "dm"]),
    text: z.string().describe("inbound text being responded to"),
    username: z.string().optional(),
    classification: ResponderClassification,
    matchedRuleId: z.string().optional(),
    action: ResponderAction.describe("resolved action AFTER guardrails"),
    originalAction: ResponderAction.optional().describe(
      "rule/default action before a guardrail downgraded it",
    ),
    reply: z.string().optional().describe("drafted/sent reply body; absent for flag"),
    templateId: z.string().optional(),
    outcome: z.enum([
      "would_send",
      "would_draft",
      "would_flag",
      "sent",
      "drafted",
      "flagged",
      "skipped",
    ]),
    reason: z.string().optional(),
  })
  .strict();
export type ResponderDecision = z.infer<typeof ResponderDecision>;
