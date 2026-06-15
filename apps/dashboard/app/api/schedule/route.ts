import { loadSchedule, saveSchedule, type Schedule } from "../../../lib/schedule";
import { currentContext, assertCan, forbidden } from "../../../lib/tenancy";
import { audit } from "../../../lib/audit";

export const dynamic = "force-dynamic";

/* Autopilot cadence for the caller's workspace.
   GET  → this workspace's schedule.
   POST → save it (schedule.manage only). */

export async function GET() {
  const ctx = await currentContext();
  return Response.json(loadSchedule(ctx.workspaceId));
}

export async function POST(req: Request) {
  const ctx = await currentContext();
  try {
    assertCan(ctx, "schedule.manage");
  } catch {
    return forbidden("schedule.manage");
  }
  const body = (await req.json().catch(() => null)) as Partial<Schedule> | null;
  if (!body || typeof body !== "object") return Response.json({ error: "bad request" }, { status: 400 });
  const cur = loadSchedule(ctx.workspaceId);
  // merge only the editable fields; preserve fire-state so a save doesn't reset it
  const next: Schedule = {
    ...cur,
    enabled: !!body.enabled,
    timezone: body.timezone || cur.timezone,
    graceMinutes: typeof body.graceMinutes === "number" ? body.graceMinutes : cur.graceMinutes,
    channels: Array.isArray(body.channels) ? body.channels : cur.channels,
    oneOff: Array.isArray(body.oneOff) ? body.oneOff : cur.oneOff,
  };
  saveSchedule(next, ctx.workspaceId);
  audit(ctx, "schedule.save", undefined, { enabled: next.enabled, channels: next.channels?.length ?? 0 });
  return Response.json({ ok: true, schedule: next });
}
