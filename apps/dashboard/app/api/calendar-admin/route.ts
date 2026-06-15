import { currentContext, ctxCan, forbidden } from "../../../lib/tenancy";
import { audit } from "../../../lib/audit";
import {
  bulkAssign,
  bulkApprove,
  bulkMove,
  bulkReject,
  runCalendarAdminTool,
} from "../../../lib/calendar-admin";

/* Calendar Admin cockpit mutations (engine: caladmin_* tools).

   Every mutation is admin-class: it gates on `schedule.manage` — the strongest
   existing autonomous-ops permission (admin + owner) — EXCEPT reassignment,
   which is the lighter `calendar.edit` (handing a post to a teammate is an
   editor action, not an ops control). Reads live on the page (analytics.view).

   "Gates are sacred": approve/reject set the admin sign-off that lets a planned
   post enter the autopilot queue — they are admin-gated and the `by` is always
   the authenticated caller (ctx.userId), supplied here so the engine schema's
   required `by` is never spoofable from the client body.

   The dashboard never bundles the engine — each action forwards to the
   canonical tool runner (spawn tool.ts) via the lib bridge. */

export const dynamic = "force-dynamic";

const asIds = (body: Record<string, unknown>): string[] => {
  if (Array.isArray(body.ids)) return (body.ids as unknown[]).map(String).filter(Boolean);
  if (body.id) return [String(body.id)];
  return [];
};

export async function POST(req: Request) {
  const ctx = await currentContext();
  const ws = ctx.workspaceId;
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const action = String(body?.action ?? "");
  if (!body || !action) return Response.json({ error: "missing action" }, { status: 400 });

  // Reassignment is an editor action; everything else is an admin ops control.
  const gate = action === "assign" ? "calendar.edit" : "schedule.manage";
  if (!ctxCan(ctx, gate)) return forbidden(gate);

  const by = ctx.userId ?? "system";

  switch (action) {
    case "reschedule": {
      const ids = asIds(body);
      const date = String(body.date ?? "");
      const time = body.time ? String(body.time) : undefined;
      if (!ids.length || !date) return Response.json({ error: "ids + date required" }, { status: 400 });
      const res = await bulkMove(ids, date, time, ws);
      if (!res.ok) return Response.json({ error: res.message ?? "reschedule failed" }, { status: 400 });
      audit(ctx, "caladmin.reschedule", ids.join(","), { date, time });
      return Response.json({ ok: true, data: res.data });
    }

    case "assign": {
      const ids = asIds(body);
      const assignee = String(body.assignee ?? "");
      if (!ids.length || !assignee) return Response.json({ error: "ids + assignee required" }, { status: 400 });
      const res = await bulkAssign(ids, assignee, ws);
      if (!res.ok) return Response.json({ error: res.message ?? "assign failed" }, { status: 400 });
      audit(ctx, "caladmin.assign", ids.join(","), { assignee });
      return Response.json({ ok: true, data: res.data });
    }

    case "approve": {
      const ids = asIds(body);
      if (!ids.length) return Response.json({ error: "ids required" }, { status: 400 });
      const res = await bulkApprove(ids, by, ws);
      if (!res.ok) return Response.json({ error: res.message ?? "approve failed" }, { status: 400 });
      audit(ctx, "caladmin.approve", ids.join(","), { count: ids.length });
      return Response.json({ ok: true, data: res.data });
    }

    case "reject": {
      const ids = asIds(body);
      if (!ids.length) return Response.json({ error: "ids required" }, { status: 400 });
      const res = await bulkReject(ids, by, ws);
      if (!res.ok) return Response.json({ error: res.message ?? "reject failed" }, { status: 400 });
      audit(ctx, "caladmin.reject", ids.join(","), { count: ids.length });
      return Response.json({ ok: true, data: res.data });
    }

    case "policy_set": {
      const channel = String(body.channel ?? "");
      const policy = body.policy as Record<string, unknown> | undefined;
      if (!channel || !policy) return Response.json({ error: "channel + policy required" }, { status: 400 });
      // engine caladmin_policy_set takes FLAT {cadence, bestTimes, blackout}; the
      // editor sends a nested `policy` with `blackouts` (plural). Unwrap + rename.
      const input: Record<string, unknown> = { workspaceId: ws, channel };
      if (policy.cadence !== undefined) input.cadence = policy.cadence;
      if (policy.bestTimes !== undefined) input.bestTimes = policy.bestTimes;
      const blackout = (policy as { blackout?: unknown; blackouts?: unknown }).blackout ?? (policy as { blackouts?: unknown }).blackouts;
      if (blackout !== undefined) input.blackout = blackout;
      const res = await runCalendarAdminTool("caladmin_policy_set", input);
      if (!res.ok) return Response.json({ error: res.message ?? "policy_set failed" }, { status: 400 });
      audit(ctx, "caladmin.policy_set", channel);
      return Response.json({ ok: true, data: res.data });
    }

    default:
      return Response.json({ error: `unknown action: ${action}` }, { status: 400 });
  }
}
