import { getJobFor } from "../../../../lib/fleet";
import { currentContext, assertCan, forbidden } from "../../../../lib/tenancy";
import { audit } from "../../../../lib/audit";
import mqtt from "mqtt";

export const dynamic = "force-dynamic";

/* Single fleet job, scoped to the caller's workspace.
   GET    -> the job row (404 if it isn't in this workspace).
   DELETE -> request a cooperative cancel of a running job (gated queue.cancel). */

export async function GET(_req: Request, ctxp: { params: Promise<{ id: string }> }): Promise<Response> {
  const ctx = await currentContext();
  const { id } = await ctxp.params;
  const job = getJobFor(id, ctx.workspaceId);
  if (!job) return Response.json({ error: "job not found" }, { status: 404 });
  return Response.json({ job });
}

export async function DELETE(_req: Request, ctxp: { params: Promise<{ id: string }> }): Promise<Response> {
  const ctx = await currentContext();
  const { id } = await ctxp.params;
  // resolve in-workspace first so a cross-workspace id is indistinguishable from missing.
  const job = getJobFor(id, ctx.workspaceId);
  if (!job) return Response.json({ error: "job not found" }, { status: 404 });
  try {
    assertCan(ctx, "queue.cancel");
  } catch {
    return forbidden("queue.cancel");
  }

  const url = process.env.SOCHELI_BROKER_URL || "mqtt://127.0.0.1:1883";
  try {
    const c = await mqtt.connectAsync(url, {
      username: process.env.SOCHELI_MQTT_USER || undefined,
      password: process.env.SOCHELI_MQTT_PASS || undefined,
    });
    await c.publishAsync(`socheli/jobs/${id}/cancel`, JSON.stringify({ at: new Date().toISOString(), by: "dashboard" }), { qos: 1 });
    await c.endAsync();
    audit(ctx, "queue.cancel", id);
    return Response.json({ canceled: true, id });
  } catch (e: any) {
    return Response.json({ error: `broker unreachable: ${e?.message ?? e}` }, { status: 502 });
  }
}
