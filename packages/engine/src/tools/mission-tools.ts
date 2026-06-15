import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";

import { type PipelineTool, ok, fail, spawnCli, tool } from "./helpers.ts";
import {
  createMission,
  getMission,
  listMissions,
  loopOfTask,
  pauseMission,
  resumeMission,
  updateMission,
} from "../missions.ts";
import { agentTaskLogPath } from "../harness/run.ts";

/* TDZ note: scheduler.ts → missions.ts → harness → roles → registry.ts →
   THIS file can all be mid-evaluation in one cycle, so this module must not
   read missions.ts CONST bindings at module-eval time (function bindings used
   inside run() closures are fine — they resolve at call time). Keep the loop
   list as a local literal, mirrored from missions.ts MISSION_LOOPS. */
const LOOPS = ["research", "plan", "generate", "analyze", "evolve"] as const;

/**
 * mission-tools.ts — the Missions orchestrator tool surface (spec §4), spread
 * into the canonical registry (registry.ts pipelineTools) so MCP / HTTP / CLI /
 * SDK / the dashboard copilot all get it for free.
 *
 * Shape note: the ok/fail/spawnCli/tool helpers come straight from registry.ts
 * so this surface stays byte-identical to every other registry tool. That
 * import is circular-import-safe (hoisted `function` bindings, fully
 * initialized before either module body runs).
 */

// ---------------------------------------------------------------------------
// Shared input fragments
// ---------------------------------------------------------------------------

const missionId = z.string().min(1).describe("mission id (e.g. mission_m1abc2_x7y8z9)");
const cadenceField = z
  .string()
  .optional()
  .describe('cadence: "hourly" | "daily" | "weekly" | "every N hours|days|weeks"');

const cadenceInput = z
  .object({
    research: cadenceField,
    plan: cadenceField,
    generate: cadenceField,
    analyze: cadenceField,
    evolve: cadenceField,
  })
  .optional()
  .describe(`which loops run and how often (loops: ${LOOPS.join(", ")})`);

const approvalInput = z
  .object({
    publish: z.enum(["auto", "gate"]).optional().describe("publish gate — generate tasks never auto-publish either way"),
    dnaMutations: z.enum(["auto", "gate"]).optional().describe("gate = dna_evolve queues all mutations for approval"),
  })
  .optional();

const budgetInput = z
  .object({
    usdPerDay: z.number().optional().describe("hard USD cap per calendar day across the mission's tasks"),
    postsPerDay: z.number().optional().describe("max posts generated per day for the channel"),
  })
  .optional();

const missionSummary = (m: ReturnType<typeof getMission>) => ({
  id: m.id,
  channel: m.channel,
  goal: m.goal,
  status: m.status,
  cadence: m.cadence,
  approvalPolicy: m.approvalPolicy,
  budget: m.budget,
  queued: m.queue.filter((t) => t.status === "queued").length,
  running: m.queue.filter((t) => t.status === "running").length,
  lastEvents: m.log.slice(0, 3).map((l) => l.event),
  updatedAt: m.updatedAt,
});

// ---------------------------------------------------------------------------
// The 8 mission_* tools (spec §4)
// ---------------------------------------------------------------------------

export const missionTools: PipelineTool[] = [
  tool({
    name: "mission_create",
    description:
      "Create a mission: a standing goal for a channel that the system advances autonomously on a cadence (the social-media-manager loop: research → plan → generate → analyze → evolve). Each loop enqueues an agent task when due; the scheduler executes at most one per tick. Publish stays human-gated; DNA mutations follow approvalPolicy.dnaMutations. Omitting cadence enables the full default loop (research/plan/evolve weekly, generate/analyze daily).",
    kind: "mutate",
    schema: z
      .object({
        channel: z.string().min(1).describe("channel/brand id (e.g. labrinox)"),
        goal: z.string().min(1).describe('the standing goal, e.g. "grow IG to 10k with daily premium reels"'),
        cadence: cadenceInput,
        approvalPolicy: approvalInput,
        budget: budgetInput,
        workspaceId: z.string().optional(),
      })
      .strict(),
    run: ({ channel, goal, cadence, approvalPolicy, budget, workspaceId }) => {
      const m = createMission({ channel, goal, cadence, approvalPolicy, budget, workspaceId });
      return ok(missionSummary(m) as unknown as Record<string, unknown>, `mission ${m.id} created (active)`);
    },
  }),
  tool({
    name: "mission_list",
    description:
      "List missions (id, channel, goal, status, cadence, budget, queue counts, last events). Filter by status and/or workspace.",
    kind: "read",
    schema: z
      .object({
        status: z.enum(["active", "paused", "done"]).optional(),
        workspaceId: z.string().optional(),
      })
      .strict(),
    run: ({ status, workspaceId }) => {
      const missions = listMissions({ status, workspaceId }).map(missionSummary);
      return ok({ missions }, `${missions.length} mission(s)`);
    },
  }),
  tool({
    name: "mission_get",
    description:
      "Get one mission in full: goal, cadence, approval policy, budget, the task queue (last 100 tasks with status/usd/result summaries), the event log (last 200) and per-loop lastRun state.",
    kind: "read",
    schema: z.object({ id: missionId }).strict(),
    run: ({ id }) => ok(getMission(id) as unknown as Record<string, unknown>),
  }),
  tool({
    name: "mission_update",
    description:
      "Update a mission's goal, cadence (per-loop, merged — set a loop to update it, omit to keep), approval policy, budget or status. Queue and history are untouched.",
    kind: "mutate",
    schema: z
      .object({
        id: missionId,
        goal: z.string().optional(),
        cadence: cadenceInput,
        approvalPolicy: approvalInput,
        budget: budgetInput,
        status: z.enum(["active", "paused", "done"]).optional(),
      })
      .strict(),
    run: ({ id, goal, cadence, approvalPolicy, budget, status }) => {
      const m = updateMission(id, {
        ...(goal !== undefined ? { goal } : {}),
        ...(cadence !== undefined ? { cadence } : {}),
        ...(approvalPolicy !== undefined ? { approvalPolicy } : {}),
        ...(budget !== undefined ? { budget } : {}),
        ...(status !== undefined ? { status } : {}),
      });
      return ok(missionSummary(m) as unknown as Record<string, unknown>, `mission ${m.id} updated`);
    },
  }),
  tool({
    name: "mission_pause",
    description: "Pause a mission: no new tasks are enqueued and queued tasks stop executing until resumed.",
    kind: "mutate",
    schema: z.object({ id: missionId }).strict(),
    run: ({ id }) => {
      const m = pauseMission(id);
      return ok({ id: m.id, status: m.status }, `mission ${m.id} paused`);
    },
  }),
  tool({
    name: "mission_resume",
    description: "Resume a paused mission: cadence loops enqueue again and queued tasks become executable.",
    kind: "mutate",
    schema: z.object({ id: missionId }).strict(),
    run: ({ id }) => {
      const m = resumeMission(id);
      return ok({ id: m.id, status: m.status }, `mission ${m.id} resumed`);
    },
  }),
  tool({
    name: "mission_tick",
    description:
      "Run one mission orchestrator pass NOW instead of waiting for the scheduler's minute tick: enqueues due loop tasks across all active missions and executes at most one queued task via the agent harness. Long-running: starts a background job and returns its pid + log path; inspect outcomes with mission_get / mission_task_log. Pass dry=true to only compute and log what WOULD run (no enqueue, no execution, no spend).",
    kind: "long",
    schema: z
      .object({
        dry: z.boolean().default(false).describe("report due tasks without enqueueing or executing"),
      })
      .strict(),
    run: ({ dry }) => {
      const args = ["mission", "tick"];
      if (dry) args.push("--dry");
      const job = spawnCli(args, "tool-mission-tick.log");
      return ok({ status: "started", ...job, dry }, dry ? "mission dry tick started" : "mission tick started");
    },
  }),
  tool({
    name: "mission_task_log",
    description:
      "Read the live event log of one mission task. Mission task ids double as harness agent-task ids, so this returns the task's queue record (status/usd/result) plus the last N JSONL agent events (tool_call/tool_result/step/done/error) from data/agent/<taskId>.jsonl.",
    kind: "read",
    schema: z
      .object({
        missionId: missionId,
        taskId: z.string().min(1).describe("task id from the mission's queue (e.g. generate_m1abc2_x7y8z9)"),
        tail: z.number().int().min(1).max(500).default(50).describe("how many trailing events to return"),
      })
      .strict(),
    run: ({ missionId: mid, taskId, tail }) => {
      const m = getMission(mid);
      const task = m.queue.find((t) => t.id === taskId);
      if (!task) return fail(`task ${taskId} not found on mission ${mid}`);
      const path = agentTaskLogPath(taskId);
      let events: unknown[] = [];
      let totalEvents = 0;
      if (existsSync(path)) {
        const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
        totalEvents = lines.length;
        events = lines.slice(-tail).map((l) => {
          try {
            return JSON.parse(l);
          } catch {
            return { type: "raw", line: l };
          }
        });
      }
      return ok(
        { missionId: mid, task, loop: loopOfTask(taskId), events, totalEvents, eventsPath: path },
        `${task.status} — ${totalEvents} event(s)`,
      );
    },
  }),
];
