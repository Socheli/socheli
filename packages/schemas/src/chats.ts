import { z } from "zod";
import { TenantFields } from "./tenancy.ts";

/* ─── Soli copilot conversation history ─────────────────────────────────────
   The persisted shape of one copilot chat thread. The client (useAgent.ts)
   keeps localStorage as its fast cache; the dashboard syncs threads to
   data/chats/<workspaceId>/<threadId>.json through /api/chats so history
   follows the user across devices.

   SECURITY BY DESIGN: tool args/results and generative-UI blocks are stored
   as opaque JSON here (z.unknown()) — the dashboard re-validates every ui
   block with the safe declarative validator (validateBlocks) BOTH when a
   thread is written through the API and when the client hydrates, so nothing
   renderable ever round-trips unvalidated. Timestamps are epoch milliseconds
   (the client's native representation). */

/* One tool invocation surfaced in the transcript (timeline chip). */
export const ChatToolEvent = z.object({
  id: z.string(),
  name: z.string(),
  args: z.unknown().optional(),
  result: z.unknown().optional(),
  ok: z.boolean().optional(),
  // "running" can legitimately persist: an interrupted stream leaves the chip.
  status: z.enum(["running", "done", "error"]),
});
export type ChatToolEvent = z.infer<typeof ChatToolEvent>;

/* One chat turn. `ui` is an array of block GROUPS (one group per ui_render
   call) — kept opaque here and re-validated at every boundary. */
export const ChatMessage = z.object({
  id: z.string(),
  role: z.enum(["user", "assistant"]),
  content: z.string(),
  tools: z.array(ChatToolEvent).optional(),
  ui: z.array(z.array(z.unknown())).optional(),
});
export type ChatMessage = z.infer<typeof ChatMessage>;

/* One conversation. Persisted at data/chats/<workspaceId>/<threadId>.json.
   workspaceId/createdBy are stamped SERVER-SIDE from the session context —
   the API never trusts tenancy fields arriving in a request body. */
export const ChatThread = z.object({
  ...TenantFields, // workspaceId + createdBy — the owning org/person
  id: z.string().min(1),
  title: z.string().max(200).default(""),
  createdAt: z.number(), // epoch ms
  updatedAt: z.number(), // epoch ms — last-write-wins merge key across devices
  messages: z.array(ChatMessage).default([]),
  // Organisation state for the inline history rail. `pinned` lifts a thread into
  // the PINNED group; `folderId` files it under a ChatFolder (null/absent = the
  // unfiled "recent" bucket). Both default off so legacy threads migrate cleanly.
  pinned: z.boolean().optional(),
  folderId: z.string().nullable().optional(),
});
export type ChatThread = z.infer<typeof ChatThread>;

/* A user-made folder grouping threads in the history rail. Persisted once per
   workspace at data/chats/<workspaceId>/_folders.json. Deleting a folder only
   unfiles its threads (folderId→null) — it never deletes conversations. */
export const ChatFolder = z.object({
  ...TenantFields, // workspaceId + createdBy
  id: z.string().min(1),
  name: z.string().min(1).max(80),
  createdAt: z.number(), // epoch ms
});
export type ChatFolder = z.infer<typeof ChatFolder>;

/* The list shape: metadata only (the rail never needs full transcripts). The
   organisation flags ride along so the rail can group/pin without fetching
   transcripts. */
export const ChatThreadMeta = ChatThread.pick({
  id: true,
  title: true,
  createdAt: true,
  updatedAt: true,
  pinned: true,
  folderId: true,
});
export type ChatThreadMeta = z.infer<typeof ChatThreadMeta>;
