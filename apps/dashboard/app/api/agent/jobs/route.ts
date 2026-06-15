import { DEFAULT_WORKSPACE } from "@os/schemas";
import { listRoots, jobTree, createJob, type Job, type JobKind } from "../../../../lib/agent/jobs";
import { runJob } from "../../../../lib/agent/run-job";
import { currentContext, assertCan, forbidden } from "../../../../lib/tenancy";
import { audit } from "../../../../lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/* Agent job queue API. Every read is scoped to the caller's workspace and the
   create is gated by role, so a member only ever sees/queues work in their own
   workspace and a viewer cannot start an acting agent.
   GET  -> the task tree (this workspace): every root job plus its descendants.
   POST { title, prompt, kind? } -> create a root job pinned to the caller's
   tenant, kick runJob (fire-and-forget), and return the created job. */

/* A job belongs to the workspace stamped on its tenant; jobs predating tenancy
   (no tenant) fall to the default workspace, matching the data migration. */
function jobWorkspace(job: Job): string {
  return job.tenant?.workspaceId || DEFAULT_WORKSPACE;
}

export async function GET(): Promise<Response> {
  const ctx = await currentContext();
  const roots = listRoots().filter((root) => jobWorkspace(root) === ctx.workspaceId);
  const trees = roots.map((root) => ({ root, jobs: jobTree(root.id) }));
  return Response.json({ roots, trees });
}

export async function POST(req: Request): Promise<Response> {
  const ctx = await currentContext();
  // Enqueuing an agent job lets it act on the user's behalf, so require the
  // baseline create permission (blocks viewers).
  try {
    assertCan(ctx, "content.create");
  } catch {
    return forbidden("content.create");
  }

  const body = (await req.json().catch(() => ({}))) as {
    title?: string;
    prompt?: string;
    kind?: JobKind;
    model?: string;
  };
  const prompt = String(body.prompt ?? "").trim();
  if (!prompt) return Response.json({ error: "prompt required" }, { status: 400 });
  const title = String(body.title ?? prompt.slice(0, 80));
  const kind: JobKind = body.kind ?? "agent";

  // Pin the job to the caller's tenant so it (and its sub-agents) run scoped to
  // this workspace and gated by this role.
  const job = createJob({ kind, title, prompt, model: body.model, status: "queued", tenant: ctx });
  audit(ctx, "agent.job.create", job.id, { kind, title });
  // Fire-and-forget: the persistent Node server runs this in-process.
  void runJob(job.id).catch(() => {});

  return Response.json({ job }, { status: 201 });
}
