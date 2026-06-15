/**
 * calendar-admin-tools.ts — registry tools backing the Calendar Admin cockpit.
 * Pure thin wrappers over ../calendar-admin.ts (which AGGREGATES the existing
 * content-plan / channels / posting-times stores). Imports ONLY from ./helpers.ts
 * + the engine logic module — no cyclic registry import.
 *
 * Every tool takes an optional `workspaceId` (the dashboard passes
 * currentWorkspaceId(); CLI omits it → spans the default workspace). Reads are
 * kind:"read"; the four mutations are kind:"mutate" (none long).
 */

import { z } from "zod";
import { tool, ok, fail, type PipelineTool } from "./helpers.ts";
import {
  overview,
  conflicts,
  loadPolicy,
  savePolicy,
  bulkOp,
  setApproval,
  CalendarPolicy,
} from "../calendar-admin.ts";

const cadenceSchema = z.object({
  perWeek: z.record(z.string(), z.number()).optional(),
  perDayMax: z.number().int().min(0).optional(),
}).optional();

const bestTimesSchema = z.object({
  enabled: z.boolean().default(true),
  perPlatform: z.record(
    z.string(),
    z.array(z.object({
      time: z.string().regex(/^\d{2}:\d{2}$/),
      days: z.array(z.number().int().min(0).max(6)).default([]),
    })),
  ).default({}),
}).optional();

const blackoutSchema = z.array(z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  startTime: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  endTime: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  reason: z.string().optional(),
})).optional();

export const calendarAdminTools: PipelineTool[] = [
  tool({
    name: "caladmin_overview",
    description:
      "Cross-brand calendar oversight: per-brand rollup (planned / pending-approval / scheduled / blackout-hits / next date) + a unified timeline of every brand's planned posts in a window, each enriched with brand name, approval status and blackout flag.",
    kind: "read",
    schema: z.object({
      workspaceId: z.string().optional(),
      from: z.string().optional(),
      to: z.string().optional(),
      includeArchived: z.boolean().default(false),
    }).strict(),
    run: (i) => ok(overview(i)),
  }),

  tool({
    name: "caladmin_conflicts",
    description:
      "Detect calendar conflicts across all brands: overlapping slots (same channel+platform+date+time), over-capacity days (vs policy perDayMax), brand collisions (same platform+date+time across brands) and blackout violations.",
    kind: "read",
    schema: z.object({
      workspaceId: z.string().optional(),
      from: z.string().optional(),
      to: z.string().optional(),
    }).strict(),
    run: (i) => ok(conflicts(i)),
  }),

  tool({
    name: "caladmin_policy_get",
    description:
      "Read a channel's posting policy (cadence caps, best-times, blackout windows). Returns a safe disabled-empty default if none is stored yet.",
    kind: "read",
    schema: z.object({
      channel: z.string().min(1),
      workspaceId: z.string().optional(),
    }).strict(),
    run: (i) => ok(loadPolicy(i.channel, i.workspaceId)),
  }),

  tool({
    name: "caladmin_policy_set",
    description:
      "Update a channel's posting policy. Merges the supplied cadence / bestTimes / blackout partials onto the stored policy and persists it. Rejects any blackout window whose from > to.",
    kind: "mutate",
    schema: z.object({
      channel: z.string().min(1),
      workspaceId: z.string().optional(),
      cadence: cadenceSchema,
      bestTimes: bestTimesSchema,
      blackout: blackoutSchema,
    }).strict(),
    run: (i) => {
      if (i.blackout) {
        for (const b of i.blackout) {
          if (b.to && b.from > b.to) return fail(`blackout window from (${b.from}) is after to (${b.to})`);
        }
      }
      const current = loadPolicy(i.channel, i.workspaceId);
      const merged = CalendarPolicy.parse({
        ...current,
        channel: i.channel,
        ...(i.cadence !== undefined ? { cadence: i.cadence } : {}),
        ...(i.bestTimes !== undefined ? { bestTimes: i.bestTimes } : {}),
        ...(i.blackout !== undefined ? { blackout: i.blackout } : {}),
      });
      return ok(savePolicy(merged, i.workspaceId), "policy updated");
    },
  }),

  tool({
    name: "caladmin_bulk",
    description:
      "Bulk operation over multiple planned posts: reschedule (date/time), assign (to a teammate), approve or reject. Cross-tenant or unknown ids are skipped, never errored.",
    kind: "mutate",
    schema: z.object({
      ids: z.array(z.string().min(1)).min(1),
      op: z.enum(["reschedule", "assign", "approve", "reject"]),
      date: z.string().optional(),
      time: z.string().optional(),
      assignee: z.string().optional(),
      by: z.string().optional(),
      workspaceId: z.string().optional(),
    }).strict(),
    run: (i) => {
      const { workspaceId, ...op } = i;
      return ok(bulkOp(op, workspaceId));
    },
  }),

  tool({
    name: "caladmin_approve",
    description:
      "Admin sign-off on a planned post — clears it for scheduling (flips an idea/approved post to status 'approved', sets approval={status:'approved',...}). Promotion to the autopilot queue stays a separate explicit step.",
    kind: "mutate",
    schema: z.object({
      id: z.string().min(1),
      by: z.string().min(1),
      workspaceId: z.string().optional(),
    }).strict(),
    run: (i) => {
      const p = setApproval(i.id, "approved", i.by, i.workspaceId);
      return p ? ok(p, "approved — cleared for scheduling") : fail("post not found");
    },
  }),

  tool({
    name: "caladmin_reject",
    description:
      "Admin rejection of a planned post — sets approval={status:'rejected',...}; leaves the post status untouched so it stays out of the autopilot queue.",
    kind: "mutate",
    schema: z.object({
      id: z.string().min(1),
      by: z.string().min(1),
      reason: z.string().optional(),
      workspaceId: z.string().optional(),
    }).strict(),
    run: (i) => {
      const p = setApproval(i.id, "rejected", i.by, i.workspaceId);
      return p ? ok(p, "rejected") : fail("post not found");
    },
  }),
];
