import { readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ownsRecord } from "@os/schemas";
import { RUNS_DIR, REPO_ROOT, getItemFor } from "../../../../lib/data";
import { currentContext, ctxCan, forbidden } from "../../../../lib/tenancy";
import { audit } from "../../../../lib/audit";

export const dynamic = "force-dynamic";

function itemPath(id: string) {
  return join(RUNS_DIR, `${id}.json`);
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await currentContext();
  // Scope the read: a record outside the caller's workspace is invisible (404).
  const it = getItemFor(id, ctx.workspaceId);
  if (!it) return new Response("not found", { status: 404 });
  return Response.json(JSON.parse(readFileSync(itemPath(id), "utf8")));
}

/* Merge editor edits (scenes + mix) into the stored item. */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await currentContext();
  const scoped = getItemFor(id, ctx.workspaceId);
  if (!scoped) return new Response("not found", { status: 404 });
  // Editing requires content.edit.own (when the author) or content.edit.any.
  if (!ctxCan(ctx, "content.edit.any") && !ctxCan(ctx, "content.edit.own", { isOwnerOfRecord: ownsRecord(scoped, ctx) })) {
    return forbidden("content.edit.own");
  }
  const p = itemPath(id);
  const item = JSON.parse(readFileSync(p, "utf8"));
  const body = await req.json().catch(() => ({}));
  if (body.scenes && item.storyboard) item.storyboard.scenes = body.scenes;
  if (body.mix) item.mix = body.mix;
  // Persist per-platform packaging overrides onto pkg.overrides so the CLI publish
  // run (which reads item.pkg.overrides[platform]) picks them up. Non-destructive.
  if (body.overrides && item.pkg) item.pkg.overrides = body.overrides;
  // Persist the chosen output aspect/dimensions onto the storyboard, non-destructively.
  if (item.storyboard && (body.width || body.height || body.aspect)) {
    if (typeof body.width === "number") item.storyboard.width = body.width;
    if (typeof body.height === "number") item.storyboard.height = body.height;
    if (typeof body.aspect === "string") item.storyboard.aspect = body.aspect;
  }
  item.updatedAt = new Date().toISOString();
  writeFileSync(p, JSON.stringify(item, null, 2));
  audit(ctx, "content.edit", id);
  return Response.json({ ok: true });
}

/* Dismiss a run — removes it from the queue. Only deletes the run record (and its
   cached poster); the rendered MP4, if any, lives elsewhere and is left untouched. */
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // Guard against path traversal via a crafted id.
  if (!/^[A-Za-z0-9._-]+$/.test(id)) return new Response("bad id", { status: 400 });
  const ctx = await currentContext();
  const scoped = getItemFor(id, ctx.workspaceId);
  if (!scoped) return new Response("not found", { status: 404 });
  if (!ctxCan(ctx, "content.delete.any") && !ctxCan(ctx, "content.delete.own", { isOwnerOfRecord: ownsRecord(scoped, ctx) })) {
    return forbidden("content.delete.own");
  }
  const p = itemPath(id);
  rmSync(p, { force: true });
  rmSync(join(REPO_ROOT, "data", "thumbs", `${id}.jpg`), { force: true });
  audit(ctx, "content.delete", id);
  return Response.json({ ok: true });
}
