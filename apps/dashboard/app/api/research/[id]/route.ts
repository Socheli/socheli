import { loadResearchRun } from "../../../../lib/research";
import { currentContext } from "../../../../lib/tenancy";

/* One research run by id — the polling target for the run page. Returns the
   full live run (steps grow while the detached worker runs; sources, claims
   and the cited report land as milestones persist). 404 covers both "no such
   run" and "not in your workspace" so existence never leaks across tenants —
   and also the short boot window before the freshly-spawned worker writes its
   first milestone, which the run page treats as "starting". */

export const dynamic = "force-dynamic";

export async function GET(_req: Request, route: { params: Promise<{ id: string }> }) {
  const { id } = await route.params;
  const ctx = await currentContext();
  const run = loadResearchRun(String(id ?? ""), ctx.workspaceId);
  if (!run) return Response.json({ error: "not found", id }, { status: 404 });
  return Response.json({ run });
}
