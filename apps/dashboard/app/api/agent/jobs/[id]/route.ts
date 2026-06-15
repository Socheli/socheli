import { DEFAULT_WORKSPACE } from "@os/schemas";
import { getJob, jobTree, cancel, type Job } from "../../../../../lib/agent/jobs";
import { currentContext, assertCan, forbidden } from "../../../../../lib/tenancy";
import { audit } from "../../../../../lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/* Single job API — scoped to the caller's workspace (a job in another workspace
   reads as 404, never leaks).
   GET    -> the job plus its full subtree.
   DELETE -> cancel the job (and any in-flight children); requires queue.cancel. */

function jobWorkspace(job: Job): string {
  return job.tenant?.workspaceId || DEFAULT_WORKSPACE;
}

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const tenant = await currentContext();
  const { id } = await ctx.params;
  const job = getJob(id);
  if (!job || jobWorkspace(job) !== tenant.workspaceId) {
    return Response.json({ error: "job not found" }, { status: 404 });
  }
  return Response.json({ job, tree: jobTree(job.rootId) });
}

export async function DELETE(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const tenant = await currentContext();
  const { id } = await ctx.params;
  const existing = getJob(id);
  // 404 first so we never reveal that a job exists in another workspace.
  if (!existing || jobWorkspace(existing) !== tenant.workspaceId) {
    return Response.json({ error: "job not found" }, { status: 404 });
  }
  try {
    assertCan(tenant, "queue.cancel");
  } catch {
    return forbidden("queue.cancel");
  }
  const job = cancel(id);
  if (!job) return Response.json({ error: "job not found" }, { status: 404 });
  audit(tenant, "agent.job.cancel", id);
  return Response.json({ job });
}
