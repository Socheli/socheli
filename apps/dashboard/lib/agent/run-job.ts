import {
  getJob,
  setStatus,
  appendEvent,
  jobSignal,
  createJob,
  type Job,
} from "./jobs";
import { streamAgent, type AgentJobCtx } from "./graph";

/* Job runners: drive streamAgent for a single job, and orchestrate teams
   (parallel sub-agents) and workflows (sequential sub-agents). All runners are
   fire-and-forget from the caller's perspective; they mutate the job registry
   and emit events that SSE subscribers replay/stream.

   Children created here carry the same rootId and depth+1, so the whole run
   forms one task tree. streamAgent receives an AgentJobCtx so any local
   orchestration tools the model calls (team_run / workflow_run / queue_enqueue)
   attach their children under the correct node. */

const RESULT_SUMMARY_LIMIT = 4000;
/* Cap on simultaneous heavy sub-agent runs (each can spawn the engine runner
   subprocess + an OpenRouter stream). Bounds load on the single Node server even
   when a team has many members or teams nest. */
const TEAM_CONCURRENCY = 4;

/* Minimal concurrency pool: run tasks with at most `limit` in flight. */
async function pooled<T>(items: (() => Promise<T>)[], limit: number): Promise<T[]> {
  const results: T[] = new Array(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      const i = next++;
      results[i] = await items[i]();
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

/* Build the ctx threaded into streamAgent for a given job. Carries the job's
   tenant so every tool the job calls is scoped to its workspace and gated by its
   role (children inherit the parent's tenant at createJob time). */
function ctxFor(job: Job): AgentJobCtx {
  return { jobId: job.id, rootId: job.rootId, depth: job.depth, tenant: job.tenant };
}

/* Run one agent/subagent job to completion. Fire-and-forget: do NOT await from
   request handlers (await is fine inside team/workflow orchestration where we
   need the result). Returns the final assistant text. */
export async function runJob(jobId: string): Promise<string> {
  const job = getJob(jobId);
  if (!job) throw new Error(`job not found: ${jobId}`);

  // If this job was already canceled (e.g. cancel() flipped a queued child to
  // 'canceled' just before its runner started), do NOT flip it back to running.
  if (job.status === "canceled" || jobSignal(jobId)?.aborted) {
    if (job.status !== "canceled") setStatus(jobId, "canceled");
    return job.result ?? "";
  }

  setStatus(jobId, "running");
  const signal = jobSignal(jobId);
  let finalText = "";

  try {
    for await (const ev of streamAgent({
      messages: [{ role: "user", content: job.prompt ?? job.title }],
      context: undefined,
      model: job.model,
      signal,
      ctx: ctxFor(job),
    })) {
      if (signal?.aborted) break;
      switch (ev.type) {
        case "token":
          finalText += ev.text;
          appendEvent(jobId, { type: "token", text: ev.text });
          break;
        case "tool_call":
          appendEvent(jobId, { type: "tool_call", id: ev.id, name: ev.name, args: ev.args });
          break;
        case "tool_result":
          appendEvent(jobId, {
            type: "tool_result",
            id: ev.id,
            name: ev.name,
            ok: ev.ok,
            result: ev.result,
          });
          break;
        case "error":
          appendEvent(jobId, { type: "log", message: ev.message });
          break;
        case "done":
          break;
      }
    }

    if (signal?.aborted) {
      setStatus(jobId, "canceled");
      return finalText;
    }

    const result = finalText.trim();
    setStatus(jobId, "succeeded", { result });
    return result;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (signal?.aborted) {
      setStatus(jobId, "canceled", { error: message });
      return finalText;
    }
    setStatus(jobId, "failed", { error: message });
    return finalText;
  }
}

export type TeamMember = { role: string; task: string };

/* Run a TEAM: one child subagent per member, all in PARALLEL under parentJobId.
   Emits a spawn event on the parent for each child, waits for all, and returns a
   combined summary of every member's result. */
export async function runTeam(
  parentJobId: string,
  members: TeamMember[],
  opts?: { model?: string },
): Promise<{ role: string; childId: string; status: string; result: string }[]> {
  const parent = getJob(parentJobId);
  if (!parent) throw new Error(`parent job not found: ${parentJobId}`);

  const spawned: { member: TeamMember; child: Job }[] = [];
  for (const m of members) {
    // Stop spawning if the tree was canceled while we were minting children.
    if (jobSignal(parentJobId)?.aborted) break;
    let child: Job;
    try {
      child = createJob({
        kind: "subagent",
        title: m.role,
        parentId: parentJobId,
        prompt: m.task,
        model: opts?.model ?? parent.model,
        status: "queued",
      });
    } catch {
      // Hit a cap (depth / per-root / canceled root) — stop spawning more.
      break;
    }
    appendEvent(parentJobId, { type: "spawn", childId: child.id, role: m.role, name: m.role });
    spawned.push({ member: m, child });
  }

  const results = await pooled(
    spawned.map(({ member, child }) => async () => {
      const result = await runJob(child.id);
      const final = getJob(child.id);
      return {
        role: member.role,
        childId: child.id,
        status: final?.status ?? "failed",
        result: (result || final?.result || "").slice(0, RESULT_SUMMARY_LIMIT),
      };
    }),
    TEAM_CONCURRENCY,
  );

  return results;
}

/* Run a WORKFLOW: sequential child subagents, each step prompted with the prior
   step's result so context flows forward. Returns each step's result. */
export async function runWorkflow(
  parentJobId: string,
  steps: string[],
  opts?: { model?: string; objective?: string },
): Promise<{ step: number; childId: string; status: string; result: string }[]> {
  const parent = getJob(parentJobId);
  if (!parent) throw new Error(`parent job not found: ${parentJobId}`);

  const out: { step: number; childId: string; status: string; result: string }[] = [];
  let prior = "";

  for (let i = 0; i < steps.length; i++) {
    const signal = jobSignal(parentJobId);
    if (signal?.aborted) break;

    const stepText = steps[i];
    const prompt = [
      opts?.objective ? `Objective: ${opts.objective}` : "",
      `Step ${i + 1} of ${steps.length}: ${stepText}`,
      prior ? `\nResult of the previous step:\n${prior}` : "",
    ]
      .filter(Boolean)
      .join("\n");

    let child: Job;
    try {
      child = createJob({
        kind: "subagent",
        title: `Step ${i + 1}: ${stepText}`.slice(0, 120),
        parentId: parentJobId,
        prompt,
        model: opts?.model ?? parent.model,
        status: "queued",
      });
    } catch {
      break; // cap hit or root canceled — stop the chain
    }
    appendEvent(parentJobId, {
      type: "spawn",
      childId: child.id,
      role: `step-${i + 1}`,
      name: stepText.slice(0, 80),
    });

    const result = await runJob(child.id);
    const final = getJob(child.id);
    prior = result || final?.result || "";
    out.push({
      step: i + 1,
      childId: child.id,
      status: final?.status ?? "failed",
      result: prior.slice(0, RESULT_SUMMARY_LIMIT),
    });

    if (final?.status !== "succeeded") break; // stop the chain on failure/cancel
  }

  return out;
}
