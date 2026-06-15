import { fleet } from "../../../lib/fleet";
import { currentContext, assertCan, forbidden } from "../../../lib/tenancy";
import { audit } from "../../../lib/audit";
import mqtt from "mqtt";

export const dynamic = "force-dynamic";

const apiBase = () => (process.env.SOCHELI_API_URL || "http://127.0.0.1:8787").replace(/\/$/, "");
const newJobId = () => `job_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

export async function GET() {
  const ctx = await currentContext();
  return Response.json(fleet(ctx.workspaceId));
}

/* Dispatch a fleet job. Three kinds, three paths:
   - ping → a no-op round-trip test; published straight to the shared job queue
            (no seed, no generation) so a device acks + we see the result.
   - auto → select+build+publish; seed optional (blank = auto-select a concept).
   - new  → build a specific idea; seed REQUIRED.
   auto/new route through the Socheli API's central scheduler (capability-matched). */
export async function POST(req: Request) {
  const ctx = await currentContext();
  try {
    assertCan(ctx, "queue.dispatch");
  } catch {
    return forbidden("queue.dispatch");
  }

  const body = await req.json().catch(() => ({}));
  const type: "auto" | "new" | "ping" | "longform" = body.type === "auto" ? "auto" : body.type === "ping" ? "ping" : body.type === "longform" ? "longform" : "new";
  const channel = body.channel ? String(body.channel) : "labrinox";
  const seed = String(body.seed ?? "").trim();

  if (type === "ping") {
    const url = process.env.SOCHELI_BROKER_URL || "mqtt://127.0.0.1:1883";
    // stamp tenancy so the bridge files the job under this workspace.
    const job = { id: newJobId(), type: "ping", channel, createdAt: new Date().toISOString(), by: "dashboard", workspaceId: ctx.workspaceId, createdBy: ctx.userId ?? undefined };
    try {
      const c = await mqtt.connectAsync(url, {
        username: process.env.SOCHELI_MQTT_USER || undefined,
        password: process.env.SOCHELI_MQTT_PASS || undefined,
      });
      await c.publishAsync("socheli/jobs", JSON.stringify(job), { qos: 1 });
      await c.endAsync();
      audit(ctx, "queue.dispatch", job.id, { type, channel });
      return Response.json({ dispatched: true, job });
    } catch (e: any) {
      return Response.json({ error: `broker unreachable: ${e?.message ?? e}` }, { status: 502 });
    }
  }

  if ((type === "new" || type === "longform") && !seed) return Response.json({ error: `seed required for a '${type}' build` }, { status: 400 });

  try {
    const r = await fetch(`${apiBase()}/v1/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.SOCHELI_API_KEY ?? ""}` },
      // pass tenancy through so the API/engine stamps the job + item to this workspace.
      body: JSON.stringify({ seed: seed || undefined, channel, type, mood: body.mood, aspect: body.aspect, width: body.width, height: body.height, voice: body.voice, workspaceId: ctx.workspaceId, createdBy: ctx.userId ?? undefined }),
    });
    const data = await r.json().catch(() => ({}));
    if (r.ok) audit(ctx, "queue.dispatch", data?.job?.id ?? data?.id, { type, channel, seed: seed || undefined });
    return Response.json(data, { status: r.status });
  } catch (e: any) {
    return Response.json({ error: `api unreachable: ${e?.message ?? e}` }, { status: 502 });
  }
}
