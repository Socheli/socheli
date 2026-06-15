/**
 * ai-dm-tools.ts — registry tools for the live "AI DM" console: a conversational
 * surface where an AI answers Instagram DMs per-thread (reusing the responder's
 * brand-voice generation + the dm_* send/window/kill-switch gates).
 *
 *   aidm_threads   (read)    thread list with last message, window state, AUTO flag
 *   aidm_thread    (read)    one conversation's full history + window + AUTO flag
 *   aidm_pull      (long)    refresh conversations from Instagram (Graph API)
 *   aidm_reply     (long)    AI-generate a brand-voice reply to a thread; draft or send
 *   aidm_set_auto  (mutate)  toggle a thread to AI auto-handle
 *   aidm_auto_sweep(long)    pull + auto-reply every AUTO thread that needs a reply
 *
 * Sending inherits the responder guardrails: aidm_reply with send routes through
 * dms.sendMessage (kill-switch + 24h window), and AUTO never sends to a never-auto
 * sentiment (it drafts instead). Imports from the leaf ./helpers.ts (no cycle).
 */

import { z } from "zod";

import { asyncResult, fail, ok, tool, type PipelineTool } from "./helpers.ts";
import { aiReplyForThread, autoSweep, listThreadViews, setAuto, threadDetail } from "../ai-dm.ts";
import { pullConversations, upsertThread } from "../dms.ts";

const channelArg = z.string().min(1).describe("channel/brand id");

export const aiDmTools: PipelineTool[] = [
  tool({
    name: "aidm_threads",
    description: "List DM conversations for the AI console — each with the last message, who it's from, the 24h-window state, the AI auto-handle flag, and whether it needs a reply. Threads needing a reply sort first.",
    kind: "read",
    schema: z.object({ channel: channelArg }).strict(),
    run: ({ channel }) => {
      const threads = listThreadViews(channel);
      return ok({ channel, count: threads.length, needReply: threads.filter((t) => t.needsReply).length, threads });
    },
  }),

  tool({
    name: "aidm_thread",
    description: "Read one DM conversation's full message history (for the chat view), plus the 24h-window state and whether the AI is auto-handling it.",
    kind: "read",
    schema: z.object({ channel: channelArg, conversationId: z.string().min(1) }).strict(),
    run: ({ channel, conversationId }) => {
      const d = threadDetail(channel, conversationId);
      return d ? ok({ channel, ...d }) : fail(`thread ${conversationId} not found for ${channel} — run aidm_pull first`);
    },
  }),

  tool({
    name: "aidm_pull",
    description: "Refresh DM conversations + messages from the connected Instagram account (Graph API) into the store. Needs a per-brand connection (or IG_* fallback) with instagram_manage_messages.",
    kind: "long",
    schema: z.object({ channel: channelArg, limit: z.number().int().positive().optional() }).strict(),
    run: ({ channel, limit }) =>
      asyncResult(
        pullConversations(channel, { limit }).then((res) => {
          if (!res.ok) return fail(res.reason);
          for (const t of res.threads) upsertThread(channel, t);
          return ok({ channel, threads: res.threads.length }, `pulled ${res.threads.length} thread(s)`);
        }),
      ),
  }),

  tool({
    name: "aidm_reply",
    description:
      "Have the AI generate a brand-voice reply to a thread's latest inbound message. With send=false (default) it stores a PENDING draft for review; with send=true it sends live (gated by the kill-switch + 24h window). The reply is grounded in the Brand Genome + memory + the responder's tone/templates.",
    kind: "long",
    schema: z.object({ channel: channelArg, conversationId: z.string().min(1), send: z.boolean().optional().describe("true = send live; false/omitted = save a draft") }).strict(),
    run: ({ channel, conversationId, send }) =>
      asyncResult(
        aiReplyForThread(channel, conversationId, { send: !!send }).then((r) =>
          r.ok ? ok({ channel, conversationId, outcome: r.outcome, reply: r.reply, sentiment: r.sentiment, messageId: r.messageId, reason: r.reason }, `AI ${r.outcome}`) : fail(r.reason),
        ),
      ),
  }),

  tool({
    name: "aidm_set_auto",
    description: "Toggle a thread to AI auto-handle. When ON, an auto-sweep (or the live console) auto-replies to new inbound messages — still respecting the kill-switch, 24h window, and the never-auto sentiment guardrail (complaint/risky are drafted, not sent).",
    kind: "mutate",
    schema: z.object({ channel: channelArg, conversationId: z.string().min(1), auto: z.boolean().describe("true = let the AI handle this thread; false = manual") }).strict(),
    run: ({ channel, conversationId, auto }) => {
      setAuto(channel, conversationId, auto);
      return ok({ channel, conversationId, auto }, auto ? "thread handed to the AI" : "thread set to manual");
    },
  }),

  tool({
    name: "aidm_auto_sweep",
    description: "Pull the latest DMs and auto-reply to every AUTO-flagged thread that has an unanswered inbound message. Respects the kill-switch + 24h window + never-auto guardrail (risky items are drafted). The console calls this on its poll; a cron/webhook can call it too.",
    kind: "long",
    schema: z.object({ channel: channelArg }).strict(),
    run: ({ channel }) =>
      asyncResult(autoSweep(channel).then((r) => ok({ channel, ...r }, `auto-handled ${r.handled.length} thread(s)`))),
  }),
];
