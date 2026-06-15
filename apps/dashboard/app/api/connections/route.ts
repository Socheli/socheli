import { currentContext, ctxCan, forbidden } from "../../../lib/tenancy";
import { audit } from "../../../lib/audit";
import { getBrand } from "../../../lib/brands";
import { connectionFor, runConnectionTool } from "../../../lib/connections";

/* Per-brand Meta connection API (engine: connections.ts).
     GET  ?channel=  → token-free connection status for one brand.
     POST            → a connection action: { action, channel, ... }.

   Tenancy: the channel must be a brand in the caller's workspace. Every
   connection mutation is a PUBLISH-class action (connecting/verifying/
   refreshing/disconnecting/subscribing a live brand account) — it requires
   content.publish, mirroring the publish gate. The token is POSTed once on
   connect_paste and forwarded straight to the engine; it is NEVER echoed in a
   response and NEVER written to the audit meta. */

export const dynamic = "force-dynamic";

/* Public action → engine tool. All are publish-class. `verify` maps to a live
   status re-check (connection_status). */
const ACTION_TOOL: Record<string, string> = {
  connect_start: "connect_start",
  connect_callback: "connect_callback",
  connect_paste: "connect_paste",
  verify: "connection_status",
  refresh: "connection_refresh",
  disconnect: "connection_disconnect",
  subscribe: "connection_subscribe",
  insights_pull: "insights_pull", // live account-level metric pull (InsightsCard)
  // Instagram-Login flow (NO Facebook Page) — siblings of connect_start/_callback.
  connect_ig_start: "connect_ig_start",
  connect_ig_callback: "connect_ig_callback",
  refresh_ig: "connection_ig_refresh",
};

export async function GET(req: Request) {
  const ctx = await currentContext();
  const channel = new URL(req.url).searchParams.get("channel")?.trim() ?? "";
  if (!channel || !getBrand(channel, ctx.workspaceId)) return Response.json({ error: "brand not found" }, { status: 404 });
  return Response.json({ channel, connection: connectionFor(channel) });
}

// Only these connect actions accept a workspaceId (their engine schemas do) —
// threading it makes the OAuth flow use the workspace's OWN Meta app (BYO).
const APP_AWARE = new Set(["connect_start", "connect_callback", "refresh", "connect_ig_start", "connect_ig_callback", "refresh_ig"]);

export async function POST(req: Request) {
  const ctx = await currentContext();
  const body = await req.json().catch(() => null);
  const action = String(body?.action ?? "");

  // ── Bring-Your-Own Meta app (workspace-scoped, no channel) ──────────────────
  if (action === "meta_app_set" || action === "meta_app_clear" || action === "meta_app_status") {
    if (action !== "meta_app_status" && !ctxCan(ctx, "content.publish")) return forbidden("content.publish");
    const input: Record<string, unknown> = { workspaceId: ctx.workspaceId };
    if (action === "meta_app_set") {
      if (body?.appId !== undefined) input.appId = body.appId;
      if (body?.appSecret !== undefined) input.appSecret = body.appSecret; // never logged/returned
    }
    const res = await runConnectionTool(action, input);
    if (!res.ok) return Response.json({ error: res.message ?? `${action} failed` }, { status: 400 });
    audit(ctx, `connection.${action}`, ctx.workspaceId, {}); // no secret in audit
    return Response.json({ ok: true, data: res.data });
  }

  // ── Bring-Your-Own Instagram app (Instagram-Login flow; workspace-scoped, no
  //    channel). Sibling of the meta_app_* branch above. The Instagram App ID/
  //    Secret are DISTINCT from the Meta ones. ──────────────────────────────────
  if (action === "ig_app_set" || action === "ig_app_clear" || action === "ig_app_status") {
    if (action !== "ig_app_status" && !ctxCan(ctx, "content.publish")) return forbidden("content.publish");
    const input: Record<string, unknown> = { workspaceId: ctx.workspaceId };
    if (action === "ig_app_set") {
      if (body?.appId !== undefined) input.appId = body.appId;
      if (body?.appSecret !== undefined) input.appSecret = body.appSecret; // never logged/returned
    }
    const res = await runConnectionTool(action, input);
    if (!res.ok) return Response.json({ error: res.message ?? `${action} failed` }, { status: 400 });
    audit(ctx, `connection.${action}`, ctx.workspaceId, {}); // no secret in audit
    return Response.json({ ok: true, data: res.data });
  }

  const channel = String(body?.channel ?? "").trim();
  const tool = ACTION_TOOL[action];
  if (!tool) return Response.json({ error: `unknown action: ${action}` }, { status: 400 });
  if (!channel || !getBrand(channel, ctx.workspaceId)) return Response.json({ error: "brand not found" }, { status: 404 });

  // The gate: every connection mutation is a publish-class action.
  if (!ctxCan(ctx, "content.publish")) return forbidden("content.publish");

  // Forward ONLY the whitelisted fields each tool's strict schema accepts.
  // token / code are forwarded to the engine but never logged or returned.
  const input: Record<string, unknown> = { channel };
  if (APP_AWARE.has(action)) input.workspaceId = ctx.workspaceId; // use the workspace's own app
  for (const k of ["token", "igUserId", "code", "state", "limit", "period"] as const) {
    if (body?.[k] !== undefined) input[k] = body[k];
  }

  const res = await runConnectionTool(tool, input);
  if (!res.ok) return Response.json({ error: res.message ?? `${action} failed` }, { status: 400 });

  audit(ctx, `connection.${action}`, channel, {}); // no token/code in meta
  return Response.json({ ok: true, data: res.data });
}
