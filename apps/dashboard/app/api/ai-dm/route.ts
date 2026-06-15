import { currentContext, ctxCan, forbidden } from "../../../lib/tenancy";
import { audit } from "../../../lib/audit";
import { getBrand } from "../../../lib/brands";
import { messagesFor, runAiDmTool, threadsFor } from "../../../lib/ai-dm";

/* AI DM console API (engine: ai-dm.ts).
     GET  ?channel=[&conversationId=]  → thread list, or one thread's messages.
     POST                              → an action: { action, channel, ... }.

   Tenancy: channel must be a brand in the caller's workspace. SENDING (a live
   reply, enabling AUTO on a thread, or an auto-sweep) is the gate — it requires
   content.publish, since it puts brand voice out / lets the AI do so. Drafting
   and pulling are edit-class (content.edit.any). The engine's sendMessage also
   enforces the workspace kill-switch + 24h window regardless of this gate. */

export const dynamic = "force-dynamic";

const ACTION_TOOL: Record<string, string> = {
  pull: "aidm_pull",
  draft: "aidm_reply", // AI draft (send:false)
  send_ai: "aidm_reply", // AI generate + send live
  send_manual: "dm_send", // human-typed send
  set_auto: "aidm_set_auto",
  sweep: "aidm_auto_sweep",
};
// Actions that put brand voice out live (or let the AI do so) → publish-gated.
const PUBLISH_ACTIONS = new Set(["send_ai", "send_manual", "sweep", "set_auto"]);

export async function GET(req: Request) {
  const ctx = await currentContext();
  const url = new URL(req.url);
  const channel = url.searchParams.get("channel")?.trim() ?? "";
  const conversationId = url.searchParams.get("conversationId")?.trim() ?? "";
  if (!channel || !getBrand(channel, ctx.workspaceId)) return Response.json({ error: "brand not found" }, { status: 404 });
  if (conversationId) return Response.json({ channel, conversationId, messages: messagesFor(channel, conversationId) });
  return Response.json({ channel, threads: threadsFor(channel) });
}

export async function POST(req: Request) {
  const ctx = await currentContext();
  const body = await req.json().catch(() => null);
  const action = String(body?.action ?? "");
  const channel = String(body?.channel ?? "").trim();

  const tool = ACTION_TOOL[action];
  if (!tool) return Response.json({ error: `unknown action: ${action}` }, { status: 400 });
  if (!channel || !getBrand(channel, ctx.workspaceId)) return Response.json({ error: "brand not found" }, { status: 404 });

  if (PUBLISH_ACTIONS.has(action)) {
    if (!ctxCan(ctx, "content.publish")) return forbidden("content.publish");
  } else if (!ctxCan(ctx, "content.edit.any")) {
    return forbidden("content.edit.any");
  }

  // Map each action to its engine tool's exact input shape.
  const input: Record<string, unknown> = { channel };
  if (action === "pull" || action === "sweep") {
    // channel only
  } else if (action === "draft") {
    input.conversationId = body?.conversationId;
    input.send = false;
  } else if (action === "send_ai") {
    input.conversationId = body?.conversationId;
    input.send = true;
  } else if (action === "send_manual") {
    input.conversationId = body?.conversationId;
    if (body?.text !== undefined) input.text = body.text;
  } else if (action === "set_auto") {
    input.conversationId = body?.conversationId;
    input.auto = body?.auto === true;
  }

  const res = await runAiDmTool(tool, input);
  if (!res.ok) return Response.json({ error: res.message ?? `${action} failed` }, { status: 400 });

  audit(ctx, `aidm.${action}`, channel, { conversationId: body?.conversationId });
  return Response.json({ ok: true, data: res.data });
}
