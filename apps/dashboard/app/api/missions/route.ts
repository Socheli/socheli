import { currentContext, ctxCan, forbidden } from "../../../lib/tenancy";
import { audit } from "../../../lib/audit";
import { getBrand } from "../../../lib/brands";
import { listMissionsFor, spentTodayUsd, runMissionTool } from "../../../lib/missions";

/* Missions collection API (engine: packages/engine/src/missions.ts).
     GET  → the caller's workspace missions, each with today's budget burn.
     POST → create a mission (engine mission_create via the tool runner):
            { channel, goal, cadence?, approvalPolicy?, budget? }

   Tenancy: reads scope to ctx.workspaceId; create requires `schedule.manage`
   (a mission IS an autopilot cadence) and the target channel must be a brand
   inside the caller's workspace. The created mission is stamped with the
   workspace so listing stays scoped. */

export const dynamic = "force-dynamic";

const LOOPS = ["research", "plan", "generate", "analyze", "evolve"] as const;

export async function GET() {
  const ctx = await currentContext();
  const missions = listMissionsFor(ctx.workspaceId).map((m) => ({ ...m, spentToday: spentTodayUsd(m) }));
  return Response.json({ missions });
}

export async function POST(req: Request) {
  const ctx = await currentContext();
  if (!ctxCan(ctx, "schedule.manage")) return forbidden("schedule.manage");

  const body = await req.json().catch(() => null);
  const channel = String(body?.channel ?? "").trim();
  const goal = String(body?.goal ?? "").trim();
  if (!channel || !goal) return Response.json({ error: "channel and goal required" }, { status: 400 });
  // The mission's channel must be a brand the caller's workspace owns.
  if (!getBrand(channel, ctx.workspaceId)) return Response.json({ error: "brand not found" }, { status: 404 });

  // Sanitize nested fields to exactly what the engine tool's strict schema takes.
  const cadence: Record<string, string> = {};
  for (const loop of LOOPS) {
    const v = body?.cadence?.[loop];
    if (typeof v === "string" && v.trim()) cadence[loop] = v.trim();
  }
  const approvalPolicy: Record<string, string> = {};
  for (const k of ["publish", "dnaMutations"] as const) {
    const v = body?.approvalPolicy?.[k];
    if (v === "auto" || v === "gate") approvalPolicy[k] = v;
  }
  const budget: Record<string, number> = {};
  for (const k of ["usdPerDay", "postsPerDay"] as const) {
    const v = Number(body?.budget?.[k]);
    if (Number.isFinite(v) && v > 0) budget[k] = v;
  }

  const res = await runMissionTool("mission_create", {
    channel,
    goal,
    ...(Object.keys(cadence).length ? { cadence } : {}),
    ...(Object.keys(approvalPolicy).length ? { approvalPolicy } : {}),
    ...(Object.keys(budget).length ? { budget } : {}),
    workspaceId: ctx.workspaceId,
  });
  if (!res.ok) return Response.json({ error: res.message ?? "mission create failed" }, { status: 500 });

  audit(ctx, "mission.create", String(res.data?.id ?? channel), { channel, goal });
  return Response.json({ mission: res.data });
}
