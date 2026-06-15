import { loadSchedule, saveSchedule, type Schedule } from "../../../../lib/schedule";
import { currentContext, assertCan, forbidden } from "../../../../lib/tenancy";
import { audit } from "../../../../lib/audit";

export const dynamic = "force-dynamic";

/* PATCH /api/schedule/reschedule — move a single scheduled item to a new
   date/time, without touching the rest of the schedule or its fire-state.
   Scoped to the caller's workspace; gated on schedule.manage.

   Two shapes are accepted:
   1. One-off reschedule:   { itemId: string, newAt: string }
        → updates schedule.oneOff[i].at for the matching item.
   2. Cadence-slot retime:  { channel: string, oldTime: string, newTime: string }
        → updates the matching slot's time in schedule.channels[].slots.

   Returns the updated schedule on success. */

function isHHMM(t: unknown): t is string {
  return typeof t === "string" && /^\d{2}:\d{2}$/.test(t);
}

export async function PATCH(req: Request) {
  const ctx = await currentContext();
  try {
    assertCan(ctx, "schedule.manage");
  } catch {
    return forbidden("schedule.manage");
  }
  const body = (await req.json().catch(() => null)) as
    | { itemId?: string; newAt?: string; channel?: string; oldTime?: string; newTime?: string }
    | null;
  if (!body || typeof body !== "object") {
    return Response.json({ error: "bad request" }, { status: 400 });
  }

  const s = loadSchedule(ctx.workspaceId);

  // ── One-off reschedule ──────────────────────────────────────────────────
  if (typeof body.itemId === "string" && typeof body.newAt === "string") {
    const at = new Date(body.newAt);
    if (Number.isNaN(at.getTime())) return Response.json({ error: "invalid newAt" }, { status: 400 });
    const idx = s.oneOff.findIndex((o) => o.itemId === body.itemId);
    if (idx === -1) return Response.json({ error: "item not scheduled" }, { status: 404 });
    // preserve every other field (public flag, firedAt) — only move the time.
    s.oneOff[idx] = { ...s.oneOff[idx], at: at.toISOString() };
    const next: Schedule = saveSchedule(s, ctx.workspaceId);
    audit(ctx, "schedule.reschedule", body.itemId, { kind: "oneOff", at: at.toISOString() });
    return Response.json({ ok: true, kind: "oneOff", schedule: next });
  }

  // ── Cadence-slot retime ─────────────────────────────────────────────────
  if (typeof body.channel === "string" && isHHMM(body.oldTime) && isHHMM(body.newTime)) {
    const ch = s.channels.find((c) => c.slots.some((sl) => sl.channel === body.channel && sl.time === body.oldTime));
    if (!ch) return Response.json({ error: "cadence slot not found" }, { status: 404 });
    const slot = ch.slots.find((sl) => sl.channel === body.channel && sl.time === body.oldTime);
    if (!slot) return Response.json({ error: "cadence slot not found" }, { status: 404 });
    slot.time = body.newTime;
    const next: Schedule = saveSchedule(s, ctx.workspaceId);
    audit(ctx, "schedule.reschedule", body.channel, { kind: "cadence", oldTime: body.oldTime, newTime: body.newTime });
    return Response.json({ ok: true, kind: "cadence", schedule: next });
  }

  return Response.json({ error: "expected { itemId, newAt } or { channel, oldTime, newTime }" }, { status: 400 });
}
