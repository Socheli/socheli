import { currentContext, ctxCan, forbidden } from "../../../../lib/tenancy";
import { audit } from "../../../../lib/audit";
import { getMissionFor, spentTodayUsd, runMissionTool } from "../../../../lib/missions";

/* One mission.
     GET   → the full mission (queue, log, per-loop lastRun state) + today's burn.
     PATCH → { action: "pause" | "resume" }                  → engine pause/resume
             { goal? | cadence? | approvalPolicy? | budget? } → engine mission_update

   Tenancy: a mission outside the caller's workspace 404s (never leaks
   existence); mutations gate on `schedule.manage` and audit. */

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

const LOOPS = ["research", "plan", "generate", "analyze", "evolve"] as const;

export async function GET(_req: Request, ctxArg: Ctx) {
  const { id } = await ctxArg.params;
  const ctx = await currentContext();
  const m = getMissionFor(id, ctx.workspaceId);
  if (!m) return Response.json({ error: "not found" }, { status: 404 });
  return Response.json({ mission: { ...m, spentToday: spentTodayUsd(m) } });
}

export async function PATCH(req: Request, ctxArg: Ctx) {
  const { id } = await ctxArg.params;
  const ctx = await currentContext();
  if (!getMissionFor(id, ctx.workspaceId)) return Response.json({ error: "not found" }, { status: 404 });
  if (!ctxCan(ctx, "schedule.manage")) return forbidden("schedule.manage");

  const body = await req.json().catch(() => null);

  // Pause / resume are first-class engine actions (they log into the mission).
  if (body?.action === "pause" || body?.action === "resume") {
    const res = await runMissionTool(body.action === "pause" ? "mission_pause" : "mission_resume", { id });
    if (!res.ok) return Response.json({ error: res.message ?? `${body.action} failed` }, { status: 500 });
    audit(ctx, `mission.${body.action}`, id);
    return Response.json({ ok: true, mission: res.data });
  }

  // Field patch — sanitize to exactly what mission_update's strict schema takes.
  const patch: Record<string, unknown> = {};
  if (typeof body?.goal === "string" && body.goal.trim()) patch.goal = body.goal.trim();
  if (body?.status === "active" || body?.status === "paused" || body?.status === "done") patch.status = body.status;
  if (body?.cadence && typeof body.cadence === "object") {
    const cadence: Record<string, string> = {};
    for (const loop of LOOPS) {
      const v = body.cadence[loop];
      if (typeof v === "string" && v.trim()) cadence[loop] = v.trim();
    }
    if (Object.keys(cadence).length) patch.cadence = cadence;
  }
  if (body?.approvalPolicy && typeof body.approvalPolicy === "object") {
    const ap: Record<string, string> = {};
    for (const k of ["publish", "dnaMutations"] as const) {
      const v = body.approvalPolicy[k];
      if (v === "auto" || v === "gate") ap[k] = v;
    }
    if (Object.keys(ap).length) patch.approvalPolicy = ap;
  }
  if (body?.budget && typeof body.budget === "object") {
    const budget: Record<string, number> = {};
    for (const k of ["usdPerDay", "postsPerDay"] as const) {
      const v = Number(body.budget[k]);
      if (Number.isFinite(v) && v > 0) budget[k] = v;
    }
    if (Object.keys(budget).length) patch.budget = budget;
  }
  if (!Object.keys(patch).length) return Response.json({ error: "nothing to update" }, { status: 400 });

  const res = await runMissionTool("mission_update", { id, ...patch });
  if (!res.ok) return Response.json({ error: res.message ?? "update failed" }, { status: 500 });
  audit(ctx, "mission.update", id, { fields: Object.keys(patch) });
  return Response.json({ ok: true, mission: res.data });
}
