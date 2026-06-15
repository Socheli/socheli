import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { RUNS_DIR, getItemFor } from "../../../../../lib/data";
import { currentContext, assertCan, forbidden } from "../../../../../lib/tenancy";
import { audit } from "../../../../../lib/audit";

/* PATCH /api/queue/assign/:id — hand a production-queue job to a teammate.

   Reassigning someone else's job is an admin action, so it gates on
   `content.edit.any`. The run is scoped to the caller's workspace (404 otherwise);
   `assignee` is the teammate's Clerk user id (empty string clears it). */

export const dynamic = "force-dynamic";

function itemPath(id: string) {
  return join(RUNS_DIR, `${id}.json`);
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // Guard against path traversal via a crafted id.
  if (!/^[A-Za-z0-9._-]+$/.test(id)) return new Response("bad id", { status: 400 });
  const ctx = await currentContext();
  // Only inside the caller's workspace.
  const scoped = getItemFor(id, ctx.workspaceId);
  if (!scoped) return new Response("not found", { status: 404 });
  try {
    assertCan(ctx, "content.edit.any");
  } catch {
    return forbidden("content.edit.any");
  }

  const body = (await req.json().catch(() => ({}))) as { assignee?: string };
  const assignee = typeof body.assignee === "string" ? body.assignee.trim() : "";

  const p = itemPath(id);
  if (!existsSync(p)) return new Response("not found", { status: 404 });
  const item = JSON.parse(readFileSync(p, "utf8"));
  if (assignee) item.assignee = assignee;
  else delete item.assignee;
  item.updatedAt = new Date().toISOString();
  writeFileSync(p, JSON.stringify(item, null, 2));
  audit(ctx, "queue.assign", id, { assignee: assignee || null });
  return Response.json({ ok: true, assignee: assignee || null });
}
