import type { OpenAITool } from "./tools";
import { createJob, appendEvent } from "./jobs";
import { runTeam, runWorkflow, runJob } from "./run-job";
import { UI_TOOLS, uiToolHandler } from "./ui-spec";
import { GUIDE_TOOL, guideToolHandler } from "./guide-spec";
import { EDIT_TOOLS, editToolHandlers } from "./edit-tools";
import type { TenantContext } from "@os/schemas";

/* LOCAL agent tools — orchestration primitives the lead agent can call to spawn
   teams, run workflows, and enqueue background jobs. These are NOT engine tools:
   they execute in-process here rather than via the spawned engine runner.

   Each handler receives an AgentToolCtx carrying the CURRENT job's id / rootId /
   depth, so children attach under the right node of the task tree. When the
   agent runs outside any job (a plain single-turn copilot chat), ctx.jobId is
   undefined; in that case we create a fresh root job to host the orchestration
   so the work is still tracked and streamable. */

export type AgentToolCtx = {
  jobId?: string;
  rootId?: string;
  depth: number;
  model?: string;
  /* The resolved tenant context for the caller. Scopes every tool call to one
     workspace and gates mutations by role. Undefined only in legacy/system paths
     (treated as the default workspace + owner). */
  tenant?: TenantContext;
};

type LocalToolHandler = (args: Record<string, unknown>, ctx: AgentToolCtx) => Promise<unknown>;

/* Ensure we have a parent job to attach children to. If the agent is already
   running inside a job, use it; otherwise mint a root job on the fly. */
function ensureParent(ctx: AgentToolCtx, kind: "team" | "workflow", title: string): string {
  if (ctx.jobId) return ctx.jobId;
  // Mint the root under the caller's tenant so the whole tree inherits its
  // workspace + role (children inherit the root's tenant at createJob time).
  const root = createJob({ kind, title, status: "running", model: ctx.model, tenant: ctx.tenant });
  return root.id;
}

export const LOCAL_TOOLS: OpenAITool[] = [
  {
    type: "function",
    function: {
      name: "team_run",
      description:
        "Spawn a TEAM of sub-agents that work in PARALLEL on a shared objective, then collect their results. Use when a task naturally splits into independent roles (e.g. researcher + writer + reviewer). Blocks until all members finish and returns each member's result.",
      parameters: {
        type: "object",
        properties: {
          objective: { type: "string", description: "The overall goal the team is working toward." },
          members: {
            type: "array",
            description: "The sub-agents to run in parallel.",
            items: {
              type: "object",
              properties: {
                role: { type: "string", description: "Short label for this sub-agent (e.g. 'researcher')." },
                task: { type: "string", description: "The specific task/prompt for this sub-agent." },
              },
              required: ["role", "task"],
            },
          },
        },
        required: ["objective", "members"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "workflow_run",
      description:
        "Run a multi-step WORKFLOW as a sequence of sub-agents, passing each step's result forward to the next. Use for ordered, dependent work (plan -> draft -> refine). Blocks until the workflow finishes and returns each step's result.",
      parameters: {
        type: "object",
        properties: {
          objective: { type: "string", description: "The overall goal of the workflow." },
          steps: {
            type: "array",
            description: "Ordered step prompts; each runs after the previous and sees its result.",
            items: { type: "string" },
          },
        },
        required: ["objective", "steps"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "queue_enqueue",
      description:
        "Enqueue a background agent JOB and return its id IMMEDIATELY without waiting for it to finish. Use for fire-and-forget work the user can check on later. Does NOT block.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "Short human-readable title for the job." },
          prompt: { type: "string", description: "The full instruction the background agent should carry out." },
        },
        required: ["title", "prompt"],
      },
    },
  },
  ...UI_TOOLS,
  GUIDE_TOOL,
  // Editor Frame-Control (Phase C): intent-level chat-to-edit composers. They
  // READ the frame surface and PROPOSE frame-exact edits (approve-before-apply);
  // they never mutate, so they're viewer-safe like the read tools.
  ...EDIT_TOOLS,
];

export const localToolHandlers: Record<string, LocalToolHandler> = {
  ui_render: async (args) => uiToolHandler(args),
  ui_guide: async (args) => guideToolHandler(args),
  // Editor Frame-Control intent composers (edit-tools.ts).
  ...editToolHandlers,

  team_run: async (args, ctx) => {
    const objective = String(args.objective ?? "");
    const rawMembers = Array.isArray(args.members) ? args.members : [];
    const members = rawMembers
      .map((m) => {
        const o = (m ?? {}) as Record<string, unknown>;
        return { role: String(o.role ?? "member"), task: String(o.task ?? "") };
      })
      .filter((m) => m.task);
    if (!members.length) return { ok: false, error: "team_run requires at least one member with a task" };

    const parentId = ensureParent(ctx, "team", objective || "Team run");
    appendEvent(parentId, { type: "log", message: `team_run: ${members.length} members — ${objective}` });
    const results = await runTeam(parentId, members, { model: ctx.model });
    return { ok: true, objective, members: results };
  },

  workflow_run: async (args, ctx) => {
    const objective = String(args.objective ?? "");
    const steps = (Array.isArray(args.steps) ? args.steps : [])
      .map((s) => String(s ?? ""))
      .filter(Boolean);
    if (!steps.length) return { ok: false, error: "workflow_run requires at least one step" };

    const parentId = ensureParent(ctx, "workflow", objective || "Workflow run");
    appendEvent(parentId, { type: "log", message: `workflow_run: ${steps.length} steps — ${objective}` });
    const results = await runWorkflow(parentId, steps, { model: ctx.model, objective });
    return { ok: true, objective, steps: results };
  },

  queue_enqueue: async (args, ctx) => {
    const title = String(args.title ?? "Background job");
    const prompt = String(args.prompt ?? "");
    if (!prompt) return { ok: false, error: "queue_enqueue requires a prompt" };

    // Always a fresh ROOT job (background work runs independently of the caller),
    // but pinned to the caller's tenant so it acts in the same workspace/role.
    const job = createJob({ kind: "agent", title, prompt, model: ctx.model, status: "queued", tenant: ctx.tenant });
    // Fire-and-forget; the caller gets the id back immediately.
    void runJob(job.id).catch(() => {});
    return { ok: true, jobId: job.id, title, status: "queued" };
  },
};

export function isLocalTool(name: string): boolean {
  return name in localToolHandlers;
}
