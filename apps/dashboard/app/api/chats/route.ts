import { ChatThread } from "@os/schemas";
import { currentContext } from "../../../lib/tenancy";
import { validateBlocks } from "../../../lib/agent/ui-spec";
import {
  deleteChatFolder,
  deleteChatThread,
  listChatFolders,
  listChatThreads,
  moveChatThread,
  pinChatThread,
  readChatThread,
  renameChatThread,
  upsertChatFolder,
  upsertChatThread,
} from "../../../lib/chats";

/* Soli conversation-history sync API (backs useAgent.ts's localStorage cache
   with data/chats/<workspaceId>/<threadId>.json).

   GET            → { threads: [{id,title,createdAt,updatedAt,pinned,folderId}…],
                    folders: [{id,name,createdAt}…] }  (metadata only, threads
                    newest-updated first)
   GET ?id=<id>   → { thread } (full transcript) | 404
   POST {op:"upsert", thread} | {op:"delete", id} | {op:"rename", id, title}
        | {op:"move", id, folderId:string|null} | {op:"pin", id, pinned:boolean}
        | {op:"folder-upsert", id, name} | {op:"folder-delete", id}

   TENANCY: same pattern as /api/ads — workspaceId/createdBy are stamped from
   the session context (currentContext) and NEVER trusted from the body, and
   reads only ever touch the caller's workspace directory. Chats are personal
   working state, so every role in the workspace (viewers included) may read
   and write its own workspace's threads — no permission gate.

   SAFETY: bodies over 256KB are rejected, and every persisted ui block group
   is stripped + re-validated server-side with the safe declarative validator
   (validateBlocks) so nothing renderable is stored unvalidated. */

export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 256 * 1024;

export async function GET(req: Request) {
  const ctx = await currentContext();
  const id = new URL(req.url).searchParams.get("id");
  if (id) {
    const thread = readChatThread(ctx.workspaceId, id);
    if (!thread) return Response.json({ error: "thread not found" }, { status: 404 });
    return Response.json({ thread });
  }
  return Response.json({
    threads: listChatThreads(ctx.workspaceId),
    folders: listChatFolders(ctx.workspaceId).map(({ id, name, createdAt }) => ({ id, name, createdAt })),
  });
}

export async function POST(req: Request) {
  const ctx = await currentContext();

  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) {
    return Response.json({ error: "body too large" }, { status: 413 });
  }
  let body: {
    op?: unknown;
    thread?: unknown;
    id?: unknown;
    title?: unknown;
    name?: unknown;
    folderId?: unknown;
    pinned?: unknown;
  };
  try {
    body = JSON.parse(raw) as typeof body;
  } catch {
    return Response.json({ error: "invalid JSON" }, { status: 400 });
  }

  const op = String(body?.op ?? "");

  if (op === "upsert") {
    const parsed = ChatThread.safeParse(body?.thread);
    if (!parsed.success) {
      return Response.json({ error: "invalid thread" }, { status: 400 });
    }
    const thread = parsed.data;
    // Strip + re-validate generative-UI blocks server-side: only blocks that
    // survive the safe declarative validator are ever persisted.
    for (const m of thread.messages) {
      if (!m.ui) continue;
      const groups = m.ui.map((g) => validateBlocks(g)).filter((g) => g.length > 0);
      if (groups.length) m.ui = groups;
      else delete m.ui;
    }
    // Never trust the client for tenancy — pin from the session context.
    thread.workspaceId = ctx.workspaceId;
    thread.createdBy = ctx.userId ?? undefined;
    const saved = upsertChatThread(ctx.workspaceId, thread);
    return Response.json({ ok: true, thread: { id: saved.id, updatedAt: saved.updatedAt } });
  }

  if (op === "delete") {
    const id = String(body?.id ?? "");
    if (!id) return Response.json({ error: "id is required" }, { status: 400 });
    deleteChatThread(ctx.workspaceId, id); // idempotent — absent is fine
    return Response.json({ ok: true });
  }

  if (op === "rename") {
    const id = String(body?.id ?? "");
    const title = String(body?.title ?? "").trim();
    if (!id || !title) return Response.json({ error: "id and title are required" }, { status: 400 });
    const renamed = renameChatThread(ctx.workspaceId, id, title);
    if (!renamed) return Response.json({ error: "thread not found" }, { status: 404 });
    return Response.json({ ok: true, thread: { id: renamed.id, updatedAt: renamed.updatedAt } });
  }

  if (op === "move") {
    const id = String(body?.id ?? "");
    if (!id) return Response.json({ error: "id is required" }, { status: 400 });
    // null/"" → unfile; any other string → the target folder id.
    const folderId = body?.folderId == null || body.folderId === "" ? null : String(body.folderId);
    const moved = moveChatThread(ctx.workspaceId, id, folderId);
    if (!moved) return Response.json({ error: "thread not found" }, { status: 404 });
    return Response.json({ ok: true, thread: { id: moved.id, updatedAt: moved.updatedAt } });
  }

  if (op === "pin") {
    const id = String(body?.id ?? "");
    if (!id) return Response.json({ error: "id is required" }, { status: 400 });
    const pinned = body?.pinned === true;
    const updated = pinChatThread(ctx.workspaceId, id, pinned);
    if (!updated) return Response.json({ error: "thread not found" }, { status: 404 });
    return Response.json({ ok: true, thread: { id: updated.id, updatedAt: updated.updatedAt } });
  }

  if (op === "folder-upsert") {
    const id = String(body?.id ?? "");
    const name = String(body?.name ?? "").trim();
    if (!id || !name) return Response.json({ error: "id and name are required" }, { status: 400 });
    // Stamp tenancy server-side; never trust the body for it.
    const folder = upsertChatFolder(ctx.workspaceId, {
      id,
      name: name.slice(0, 80),
      createdAt: Date.now(),
      workspaceId: ctx.workspaceId,
      createdBy: ctx.userId ?? undefined,
    });
    return Response.json({ ok: true, folder: { id: folder.id, name: folder.name } });
  }

  if (op === "folder-delete") {
    const id = String(body?.id ?? "");
    if (!id) return Response.json({ error: "id is required" }, { status: 400 });
    deleteChatFolder(ctx.workspaceId, id); // idempotent; unfiles its threads
    return Response.json({ ok: true });
  }

  return Response.json({ error: `unknown op: ${op}` }, { status: 400 });
}
