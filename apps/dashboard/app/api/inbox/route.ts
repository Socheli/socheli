import { currentContext, ctxCan, forbidden } from "../../../lib/tenancy";
import { audit } from "../../../lib/audit";
import { getBrand } from "../../../lib/brands";
import { commentsFor, dmsFor, runInboxTool } from "../../../lib/inbox";

/* Community inbox API (engine: comments.ts / dms.ts).
     GET  ?channel=  → triage + pending queues for one channel (comments + DMs).
     POST            → an inbox action: { action, channel, ... }.

   Tenancy: the channel must be a brand in the caller's workspace. Reads + most
   mutations need content.edit.any; SENDING a reply (comment_send / dm_send) is
   the gate — it requires content.publish, mirroring the publish gate. */

export const dynamic = "force-dynamic";

const SEND_ACTIONS = new Set(["comment_send", "dm_send"]);
const EDIT_ACTIONS = new Set(["comments_pull", "dm_pull", "comment_draft", "dm_draft", "comment_hide"]);

export async function GET(req: Request) {
  const ctx = await currentContext();
  const channel = new URL(req.url).searchParams.get("channel")?.trim() ?? "";
  if (!channel || !getBrand(channel, ctx.workspaceId)) return Response.json({ error: "brand not found" }, { status: 404 });
  const comments = commentsFor(channel);
  const dms = dmsFor(channel);
  return Response.json({ channel, comments, dms });
}

export async function POST(req: Request) {
  const ctx = await currentContext();
  const body = await req.json().catch(() => null);
  const action = String(body?.action ?? "");
  const channel = String(body?.channel ?? "").trim();

  if (!action || (!SEND_ACTIONS.has(action) && !EDIT_ACTIONS.has(action))) return Response.json({ error: `unknown action: ${action}` }, { status: 400 });
  if (!channel || !getBrand(channel, ctx.workspaceId)) return Response.json({ error: "brand not found" }, { status: 404 });

  // The gate: sending a reply is a publish-class action.
  if (SEND_ACTIONS.has(action)) {
    if (!ctxCan(ctx, "content.publish")) return forbidden("content.publish");
  } else if (!ctxCan(ctx, "content.edit.any")) {
    return forbidden("content.edit.any");
  }

  // Forward only the fields each tool's strict schema accepts.
  const input: Record<string, unknown> = { channel };
  for (const k of ["commentId", "conversationId", "reply", "text", "hide", "limit"] as const) {
    if (body?.[k] !== undefined) input[k] = body[k];
  }

  const res = await runInboxTool(action, input);
  if (!res.ok) return Response.json({ error: res.message ?? `${action} failed` }, { status: 400 });

  audit(ctx, `inbox.${action}`, channel, { commentId: body?.commentId, conversationId: body?.conversationId });
  return Response.json({ ok: true, data: res.data });
}
