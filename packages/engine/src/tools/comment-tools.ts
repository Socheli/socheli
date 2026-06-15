/**
 * comment-tools.ts — registry tools for Instagram comment management (Phase 1
 * of community management). Exposes the read/triage/draft/moderate/send loop to
 * every surface (CLI/API/MCP/SDK/copilot) via the one registry.
 *
 *   comments_pull     (long)    fetch recent media + comments from the IG account
 *   comments_list     (read)    list stored comments (filter to unanswered)
 *   comment_draft     (mutate)  attach a brand-voice reply DRAFT to a comment (local)
 *   comments_pending  (read)    list drafted replies awaiting human approval
 *   comment_send      (long)    *** GATED *** send an approved reply (live, human-run)
 *   comment_hide      (mutate)  hide/unhide a comment (spam moderation, live)
 *
 * THE GATE: comment_send is the only tool that puts brand voice out live. By
 * convention it is withheld from the autonomous community_manager role (see
 * harness/roles.ts) so an agent triages + drafts + hides spam, and a human sends
 * — same "gates are sacred" model as publish. Live calls degrade cleanly without
 * a token (needs-auth message), so the offline draft/store path is fully usable
 * and testable before any credential exists.
 *
 * Imports come from the leaf ./helpers.ts (no registry cycle).
 */

import { z } from "zod";

import { asyncResult, fail, ok, tool, type PipelineTool } from "./helpers.ts";
import {
  findComment,
  listStoredComments,
  loadDrafts,
  loadSnapshots,
  pullComments,
  saveDrafts,
  saveSnapshots,
  sendReply,
  setHidden,
  upsertDraft,
  type CommentSnapshot,
  type DraftReply,
} from "../comments.ts";

const channelArg = z.string().min(1).describe("channel/brand id (scopes the local comment store + drafts)");

/* Merge freshly pulled snapshots into the stored set, replacing by mediaId so a
   re-pull refreshes counts/hidden flags without losing other media. */
function mergeSnapshots(existing: CommentSnapshot[], fresh: CommentSnapshot[]): CommentSnapshot[] {
  const byId = new Map(existing.map((s) => [s.mediaId, s]));
  for (const s of fresh) byId.set(s.mediaId, s);
  return [...byId.values()];
}

export const commentTools: PipelineTool[] = [
  tool({
    name: "comments_pull",
    description:
      "Fetch the most recent posts and their comments from the connected Instagram account (Graph API) and store them for triage. Needs IG_USER_ID + IG_ACCESS_TOKEN (token with instagram_manage_comments). Returns a per-post summary; degrades to a clear needs-auth message if creds are missing.",
    kind: "long",
    schema: z.object({ channel: channelArg, limit: z.number().int().positive().optional().describe("max recent posts to scan (default 10, max 25)") }).strict(),
    run: ({ channel, limit }) =>
      asyncResult(
        pullComments(channel, { limit }).then((res) => {
          if (!res.ok) return fail(res.reason);
          const merged = mergeSnapshots(loadSnapshots(channel), res.snapshots);
          saveSnapshots(channel, merged);
          const total = res.snapshots.reduce((n, s) => n + s.comments.length, 0);
          return ok(
            { channel, postsScanned: res.snapshots.length, commentsPulled: total, posts: res.snapshots.map((s) => ({ mediaId: s.mediaId, comments: s.comments.length, permalink: s.permalink })) },
            `pulled ${total} comment(s) across ${res.snapshots.length} post(s)`,
          );
        }),
      ),
  }),

  tool({
    name: "comments_list",
    description:
      "List stored Instagram comments for a channel (run comments_pull first). Use unansweredOnly to see only comments that don't yet have a drafted reply — the triage queue.",
    kind: "read",
    schema: z
      .object({
        channel: channelArg,
        unansweredOnly: z.boolean().optional().describe("only comments without a drafted reply yet (default false)"),
        limit: z.number().int().positive().optional().describe("max comments to return (default 50)"),
      })
      .strict(),
    run: ({ channel, unansweredOnly, limit }) => {
      const all = listStoredComments(channel, { unansweredOnly: !!unansweredOnly });
      const rows = all.slice(0, Math.max(1, Math.min(200, limit ?? 50)));
      return ok({ channel, count: rows.length, totalStored: all.length, comments: rows });
    },
  }),

  tool({
    name: "comment_draft",
    description:
      "Draft a reply to a stored comment in the brand's voice — saved locally as PENDING, NOT sent. This is how an agent proposes community replies for human review. The comment must already be in the store (from comments_pull). Write the reply in the channel's Brand-Genome voice.",
    kind: "mutate",
    schema: z
      .object({
        channel: channelArg,
        commentId: z.string().min(1).describe("the comment id to reply to (from comments_list)"),
        reply: z.string().min(1).describe("the proposed reply text, in brand voice"),
      })
      .strict(),
    run: ({ channel, commentId, reply }) => {
      const c = findComment(channel, commentId);
      if (!c) return fail(`comment ${commentId} not found in store for ${channel} — run comments_pull first`);
      const draft: DraftReply = { commentId, mediaId: c.mediaId, username: c.username, inReplyTo: c.text, reply, draftedAt: new Date().toISOString(), status: "pending" };
      upsertDraft(channel, draft);
      return ok({ channel, draft }, "reply drafted (pending human approval — use comment_send to publish it)");
    },
  }),

  tool({
    name: "comments_pending",
    description: "List drafted replies awaiting human approval for a channel — the send queue. Review these, then comment_send the good ones.",
    kind: "read",
    schema: z.object({ channel: channelArg }).strict(),
    run: ({ channel }) => {
      const pending = loadDrafts(channel).filter((d) => d.status === "pending");
      return ok({ channel, count: pending.length, drafts: pending });
    },
  }),

  tool({
    name: "comment_send",
    description:
      "*** GATED, LIVE *** Send an approved reply to Instagram. By default sends the PENDING draft for the given comment; pass `text` to override. This is a human action — it puts brand voice out publicly. Marks the draft sent on success.",
    kind: "long",
    schema: z
      .object({
        channel: channelArg,
        commentId: z.string().min(1).describe("the comment id to reply to"),
        text: z.string().min(1).optional().describe("override text; if omitted, sends the stored pending draft"),
      })
      .strict(),
    run: ({ channel, commentId, text }) => {
      const drafts = loadDrafts(channel);
      const draft = drafts.find((d) => d.commentId === commentId);
      const message = text ?? draft?.reply;
      if (!message) return fail(`no draft for comment ${commentId} and no text provided — draft one with comment_draft or pass text`);
      return asyncResult(
        sendReply(channel, commentId, message).then((res) => {
          if (!res.ok) return fail(res.reason);
          if (draft) {
            draft.status = "sent";
            draft.sentId = res.id;
            draft.sentAt = new Date().toISOString();
            if (text) draft.reply = text;
            saveDrafts(channel, drafts);
          }
          return ok({ channel, commentId, replyId: res.id }, "reply sent");
        }),
      );
    },
  }),

  tool({
    name: "comment_hide",
    description:
      "Hide (or unhide) an Instagram comment — spam/abuse moderation. Live action, but lower-risk than replying (no brand voice goes out). Updates the local store's hidden flag on success.",
    kind: "mutate",
    schema: z
      .object({
        channel: channelArg,
        commentId: z.string().min(1).describe("the comment id to hide/unhide"),
        hide: z.boolean().optional().describe("true to hide (default), false to unhide"),
      })
      .strict(),
    run: ({ channel, commentId, hide }) => {
      const want = hide ?? true;
      return asyncResult(
        setHidden(channel, commentId, want).then((res) => {
          if (!res.ok) return fail(res.reason);
          const snaps = loadSnapshots(channel);
          for (const s of snaps) {
            const c = s.comments.find((x) => x.id === commentId);
            if (c) {
              c.hidden = want;
              saveSnapshots(channel, snaps);
              break;
            }
          }
          return ok({ channel, commentId, hidden: want }, want ? "comment hidden" : "comment unhidden");
        }),
      );
    },
  }),
];
