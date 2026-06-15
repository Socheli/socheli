import { currentContext, ctxCan, forbidden } from "../../../../../lib/tenancy";
import { audit } from "../../../../../lib/audit";
import { getMissionFor, runMissionTool } from "../../../../../lib/missions";

/* "Tick now" — run one orchestrator pass immediately instead of waiting for
   the scheduler's minute tick. Engine mission_tick is a long tool: it starts a
   DETACHED background job (enqueue due loop tasks, execute at most one via the
   agent harness) and returns { pid, logPath } right away, so this route never
   blocks while an agent works a goal for minutes. The tick is orchestrator-
   wide by design (renders/agents stay serial on the device) — the mission id
   here is the button's context and the tenancy anchor. */

export const dynamic = "force-dynamic";

export async function POST(_req: Request, ctxArg: { params: Promise<{ id: string }> }) {
  const { id } = await ctxArg.params;
  const ctx = await currentContext();
  if (!getMissionFor(id, ctx.workspaceId)) return Response.json({ error: "not found" }, { status: 404 });
  if (!ctxCan(ctx, "schedule.manage")) return forbidden("schedule.manage");

  const res = await runMissionTool("mission_tick", { dry: false });
  if (!res.ok) return Response.json({ error: res.message ?? "tick failed" }, { status: 500 });

  audit(ctx, "mission.tick", id);
  return Response.json({ started: true, ...res.data });
}
