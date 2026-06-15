/**
 * dm-tools.ts — registry tools for Instagram Direct Messages (Phase 2 of
 * community management). Exposes the read/triage/draft/send loop to every
 * surface via the one registry.
 *
 *   dm_pull      (long)    fetch recent conversations + messages from the IG account
 *   dm_list      (read)    list open threads (last message inbound, no draft yet)
 *   dm_thread    (read)    full message history for one conversation
 *   dm_draft     (mutate)  attach a brand-voice reply DRAFT to a thread (local)
 *   dm_pending   (read)    drafted replies awaiting human approval
 *   dm_send      (long)    *** GATED *** send an approved DM reply (24h-window checked)
 *
 * Same gate as comments + publish: agent triages + drafts; a human sends. The
 * 24-hour messaging window is enforced in dm_send. Imports from the leaf
 * ./helpers.ts (no registry cycle).
 */

import { z } from "zod";

import { asyncResult, fail, ok, tool, type PipelineTool } from "./helpers.ts";
import {
  findThread,
  listOpenThreads,
  loadDmDrafts,
  loadThreads,
  pullConversations,
  saveDmDrafts,
  sendMessage,
  upsertDmDraft,
  upsertThread,
  windowOpen,
  type DmDraft,
} from "../dms.ts";

const channelArg = z.string().min(1).describe("channel/brand id (scopes the local DM store + drafts)");

export const dmTools: PipelineTool[] = [
  tool({
    name: "dm_pull",
    description:
      "Fetch recent Instagram Direct Message conversations and their messages from the connected account (Graph API) and store them. Needs IG_USER_ID + IG_ACCESS_TOKEN (token with instagram_manage_messages). Degrades to a clear needs-auth message if creds are missing.",
    kind: "long",
    schema: z.object({ channel: channelArg, limit: z.number().int().positive().optional().describe("max conversations to scan (default 10, max 25)") }).strict(),
    run: ({ channel, limit }) =>
      asyncResult(
        pullConversations(channel, { limit }).then((res) => {
          if (!res.ok) return fail(res.reason);
          for (const t of res.threads) upsertThread(channel, t);
          const open = listOpenThreads(channel).length;
          return ok(
            { channel, threads: res.threads.length, openNeedingReply: open, conversations: res.threads.map((t) => ({ conversationId: t.conversationId, username: t.participantUsername, messages: t.messages.length, lastInboundAt: t.lastInboundAt })) },
            `pulled ${res.threads.length} thread(s), ${open} need a reply`,
          );
        }),
      ),
  }),

  tool({
    name: "dm_list",
    description: "List open DM threads for a channel — conversations whose last message is from the user and have no drafted reply yet (the triage queue). Run dm_pull first.",
    kind: "read",
    schema: z.object({ channel: channelArg }).strict(),
    run: ({ channel }) => {
      const open = listOpenThreads(channel).map((t) => {
        const w = windowOpen(t);
        const last = t.messages[t.messages.length - 1];
        return { conversationId: t.conversationId, username: t.participantUsername, lastMessage: last?.text ?? "", windowOpen: w.open, hoursSinceInbound: w.hours };
      });
      return ok({ channel, count: open.length, threads: open });
    },
  }),

  tool({
    name: "dm_thread",
    description: "Read the full message history for one DM conversation, plus whether the 24h reply window is open.",
    kind: "read",
    schema: z.object({ channel: channelArg, conversationId: z.string().min(1) }).strict(),
    run: ({ channel, conversationId }) => {
      const t = findThread(channel, conversationId);
      if (!t) return fail(`thread ${conversationId} not found for ${channel} — run dm_pull first`);
      return ok({ channel, thread: t, window: windowOpen(t) });
    },
  }),

  tool({
    name: "dm_draft",
    description:
      "Draft a reply to a DM thread in the brand's voice — saved locally as PENDING, NOT sent. The thread must already be in the store (from dm_pull). Write the reply in the channel's Brand-Genome voice; check the 24h window first.",
    kind: "mutate",
    schema: z.object({ channel: channelArg, conversationId: z.string().min(1).describe("the conversation id (from dm_list)"), reply: z.string().min(1).describe("the proposed reply text, in brand voice") }).strict(),
    run: ({ channel, conversationId, reply }) => {
      const t = findThread(channel, conversationId);
      if (!t) return fail(`thread ${conversationId} not found for ${channel} — run dm_pull first`);
      const last = t.messages[t.messages.length - 1];
      const draft: DmDraft = { conversationId, recipientId: t.participantId, inReplyTo: last?.text ?? "", reply, draftedAt: new Date().toISOString(), status: "pending" };
      upsertDmDraft(channel, draft);
      const w = windowOpen(t);
      return ok({ channel, draft, window: w }, w.open ? "reply drafted (pending human approval — use dm_send)" : `reply drafted, but the 24h window looks closed (~${w.hours}h) — sending may be rejected`);
    },
  }),

  tool({
    name: "dm_pending",
    description: "List drafted DM replies awaiting human approval for a channel — the send queue.",
    kind: "read",
    schema: z.object({ channel: channelArg }).strict(),
    run: ({ channel }) => {
      const pending = loadDmDrafts(channel).filter((d) => d.status === "pending");
      return ok({ channel, count: pending.length, drafts: pending });
    },
  }),

  tool({
    name: "dm_send",
    description:
      "*** GATED, LIVE *** Send an approved DM reply to Instagram. By default sends the PENDING draft for the given conversation; pass `text` to override. Enforces the 24-hour messaging window. This is a human action — marks the draft sent on success.",
    kind: "long",
    schema: z.object({ channel: channelArg, conversationId: z.string().min(1), text: z.string().min(1).optional().describe("override text; if omitted, sends the stored pending draft") }).strict(),
    run: ({ channel, conversationId, text }) => {
      const drafts = loadDmDrafts(channel);
      const draft = drafts.find((d) => d.conversationId === conversationId);
      const t = findThread(channel, conversationId);
      const recipientId = draft?.recipientId ?? t?.participantId ?? "";
      const message = text ?? draft?.reply;
      if (!message) return fail(`no draft for conversation ${conversationId} and no text provided — draft one with dm_draft or pass text`);
      return asyncResult(
        sendMessage(channel, conversationId, recipientId, message).then((res) => {
          if (!res.ok) return fail(res.reason);
          if (draft) {
            draft.status = "sent";
            draft.sentId = res.id;
            draft.sentAt = new Date().toISOString();
            if (text) draft.reply = text;
            saveDmDrafts(channel, drafts);
          }
          return ok({ channel, conversationId, messageId: res.id }, "DM reply sent");
        }),
      );
    },
  }),
];
