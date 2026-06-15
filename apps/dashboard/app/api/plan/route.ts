import { loadPlanFor, getPost, postsForDate, updatePost, removePost, type PlannedPost } from "../../../lib/content-plan";
import { currentContext, assertCan, forbidden } from "../../../lib/tenancy";
import { audit } from "../../../lib/audit";

/* CRUD for the algo-hacking content plan (data/content-plan.json).
   GET    → the full plan (optionally filtered by ?channel=); ?id= one full post;
            ?date=YYYY-MM-DD all posts for a day (the comprehensive day dialog).
   PATCH  → update one planned post (reschedule date/time, change status, edit fields,
            assign to a teammate via { assignee }).
   DELETE → drop a planned post (?id=). Archive = PATCH { status:"archived" }.

   Every read scopes to ctx.workspaceId (404 for a post outside it); mutations
   gate on `calendar.edit` and audit. */

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const ctx = await currentContext();
  const url = new URL(req.url);
  const id = url.searchParams.get("id");
  if (id) {
    const post = getPost(id, ctx.workspaceId);
    return post ? Response.json({ post }) : Response.json({ error: "not found" }, { status: 404 });
  }
  const date = url.searchParams.get("date");
  if (date) return Response.json({ date, posts: postsForDate(date, ctx.workspaceId) });
  const channel = url.searchParams.get("channel");
  let posts = loadPlanFor(ctx.workspaceId);
  if (channel) posts = posts.filter((p) => p.channel === channel);
  return Response.json({ posts });
}

export async function PATCH(req: Request) {
  const ctx = await currentContext();
  try {
    assertCan(ctx, "calendar.edit");
  } catch {
    return forbidden("calendar.edit");
  }
  const body = (await req.json().catch(() => ({}))) as { id?: string } & Partial<PlannedPost>;
  if (!body.id) return Response.json({ error: "id required" }, { status: 400 });
  const { id, ...patch } = body;
  const updated = updatePost(id, patch, ctx.workspaceId);
  if (!updated) return Response.json({ error: "not found" }, { status: 404 });
  audit(ctx, "plan.post.update", id, { fields: Object.keys(patch) });
  return Response.json({ ok: true, post: updated });
}

export async function DELETE(req: Request) {
  const ctx = await currentContext();
  try {
    assertCan(ctx, "calendar.edit");
  } catch {
    return forbidden("calendar.edit");
  }
  const url = new URL(req.url);
  const id = url.searchParams.get("id");
  if (!id) return Response.json({ error: "id required" }, { status: 400 });
  const ok = removePost(id, ctx.workspaceId);
  if (ok) audit(ctx, "plan.post.remove", id);
  return Response.json({ ok }, { status: ok ? 200 : 404 });
}
