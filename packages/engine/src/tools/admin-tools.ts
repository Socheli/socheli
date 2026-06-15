import { z } from "zod";

import { type PipelineTool, ok, fail, tool } from "./helpers.ts";
import {
  adminApprovals,
  adminHealth,
  adminOverview,
  channelsForWorkspace,
  loadAdminControl,
  setBrandBudgetCap,
  setBrandPaused,
  setKillSwitch,
} from "../admin.ts";
import { listMissions, pauseMission, resumeMission, updateMission } from "../missions.ts";
import { loadSchedule, saveSchedule } from "../schedule.ts";

/**
 * admin-tools.ts — the SMM-Admin cockpit tool surface, spread into the canonical
 * registry (registry.ts pipelineTools) so MCP / HTTP / CLI / SDK / dashboard
 * copilot all get it for free.
 *
 * These AGGREGATE existing subsystems (missions / schedule / responder /
 * connections / comments / dms / dna) via admin.ts and apply cross-brand
 * CONTROLS (pause/resume, workspace kill-switch, budget caps). The engine trusts
 * its caller; the dashboard gates these on schedule.manage (admin/owner). Every
 * mutation runs IN-PROCESS (local flat-JSON), so there are no long/spawn tools
 * here. The HARD kill-switch is ENFORCED at the 4 send/post paths by
 * admin.isSendingHalted — these tools only flip the durable flag.
 *
 * TDZ note (mirror mission-tools.ts): function bindings from missions.ts/
 * schedule.ts/admin.ts are used inside run() closures (resolved at call time),
 * never at module-eval time, so this file is import-cycle-safe.
 */

const workspaceId = z.string().min(1).describe("workspace id (e.g. ws_default | org_… | user_…)");

/* Flip a channel's autopilot cadence on/off in the single global schedule store,
   in-process. There is no dedicated channel-enabled helper in schedule.ts, so we
   load → set the matching ChannelCadence.enabled → save (atomic). Best-effort:
   absent channel entry is a no-op (nothing scheduled for that brand yet). */
function setChannelScheduleEnabled(channel: string, enabled: boolean): void {
  const s = loadSchedule();
  const c = s.channels.find((x) => x.channel === channel);
  if (!c) return;
  c.enabled = enabled;
  saveSchedule(s);
}

/* Apply a control op (pause/resume) to every active/paused mission of a channel,
   in-process. Best-effort: a failed sub-op never aborts the admin flag write. */
function applyMissionState(ws: string, channel: string, action: "pause" | "resume"): void {
  for (const m of listMissions({ workspaceId: ws })) {
    if (m.channel !== channel) continue;
    try {
      if (action === "pause" && m.status === "active") pauseMission(m.id);
      if (action === "resume" && m.status === "paused") resumeMission(m.id);
    } catch {
      /* best-effort — keep going */
    }
  }
}

export const adminTools: PipelineTool[] = [
  tool({
    name: "admin_overview",
    description:
      "Cross-brand SMM state rollup for a workspace: per brand → mission status + today's spend/posts vs budget, autopilot on/off + next due, responder enabled + default action, connection status (token-free, expiry only), inbox backlog (unanswered comments/DMs + pending drafts), admin pause flag + budget cap, last activity. Read-only aggregation.",
    kind: "read",
    schema: z.object({ workspaceId }).strict(),
    run: ({ workspaceId: ws }) => {
      try {
        return ok({ brands: adminOverview(ws), killSwitch: loadAdminControl(ws).killSwitch });
      } catch (e) {
        return fail(e);
      }
    },
  }),

  tool({
    name: "admin_approvals",
    description:
      "Unified approvals hub: one feed merging every human gate across the workspace — pending DNA mutations, render-verified gated publishes, pending comment reply drafts, pending DM reply drafts (with 24h-window flag), and responder 'going live' (brands set to auto_send). Read-only.",
    kind: "read",
    schema: z
      .object({ workspaceId, limit: z.number().int().min(1).max(50).default(12) })
      .strict(),
    run: ({ workspaceId: ws, limit }) => {
      try {
        return ok(adminApprovals(ws, limit));
      } catch (e) {
        return fail(e);
      }
    },
  }),

  tool({
    name: "admin_health",
    description:
      "Health/alerts across the workspace: tokens expiring soon (<7d), DMs with a closed 24h window holding a pending reply, missions over their daily budget or with a failed last task, and disconnected accounts on active missions. Read-only.",
    kind: "read",
    schema: z.object({ workspaceId }).strict(),
    run: ({ workspaceId: ws }) => {
      try {
        return ok({ alerts: adminHealth(ws) });
      } catch (e) {
        return fail(e);
      }
    },
  }),

  tool({
    name: "admin_pause",
    description:
      "Admin pause: halt autonomous activity for a brand (or every brand when channel is omitted). Sets the admin pause flag (enforced by the kill-switch resolver on the 4 send/post paths), pauses that channel's active missions, and disables its autopilot cadence. In-process, best-effort.",
    kind: "mutate",
    schema: z
      .object({
        workspaceId,
        channel: z
          .string()
          .min(1)
          .optional()
          .describe("omit = pause every brand in the workspace"),
      })
      .strict(),
    run: ({ workspaceId: ws, channel }) => {
      try {
        const targets = channel ? [channel] : channelsForWorkspace(ws);
        for (const ch of targets) {
          setBrandPaused(ws, ch, true); // admin flag write succeeds first
          applyMissionState(ws, ch, "pause");
          try {
            setChannelScheduleEnabled(ch, false);
          } catch {
            /* best-effort */
          }
        }
        return ok(loadAdminControl(ws), channel ? `paused ${channel}` : "paused every brand");
      } catch (e) {
        return fail(e);
      }
    },
  }),

  tool({
    name: "admin_resume",
    description:
      "Admin resume: lift the admin pause for a brand (or every brand when channel is omitted). Clears the pause flag, resumes paused missions, and re-enables the autopilot cadence. In-process, best-effort. (Does NOT override the workspace kill-switch — turn that off separately.)",
    kind: "mutate",
    schema: z
      .object({
        workspaceId,
        channel: z
          .string()
          .min(1)
          .optional()
          .describe("omit = resume every brand in the workspace"),
      })
      .strict(),
    run: ({ workspaceId: ws, channel }) => {
      try {
        const targets = channel ? [channel] : channelsForWorkspace(ws);
        for (const ch of targets) {
          setBrandPaused(ws, ch, false);
          applyMissionState(ws, ch, "resume");
          try {
            setChannelScheduleEnabled(ch, true);
          } catch {
            /* best-effort */
          }
        }
        return ok(loadAdminControl(ws), channel ? `resumed ${channel}` : "resumed every brand");
      } catch (e) {
        return fail(e);
      }
    },
  }),

  tool({
    name: "admin_kill_switch",
    description:
      "Workspace KILL-SWITCH: hard-halt ALL autonomous sending/posting for the workspace. When ON, comment replies, DM sends, publishes, and autopilot all return a halted/skipped shape (enforced at the 4 paths by isSendingHalted — durable, survives restarts). Flip OFF to restore. Does not fan out per-brand pauses.",
    kind: "mutate",
    schema: z
      .object({
        workspaceId,
        on: z.boolean(),
        reason: z.string().optional(),
        by: z.string().optional().describe("Clerk user id (or 'system') who flipped it"),
      })
      .strict(),
    run: ({ workspaceId: ws, on, reason, by }) => {
      try {
        setKillSwitch(ws, on, reason, by);
        return ok(
          loadAdminControl(ws),
          on
            ? "kill-switch ON — all autonomous sending/posting halted"
            : "kill-switch OFF",
        );
      } catch (e) {
        return fail(e);
      }
    },
  }),

  tool({
    name: "admin_set_budget_cap",
    description:
      "Set a brand's advisory budget cap (USD/day and/or posts/day) in the admin cockpit store AND bind it as the enforcer by pushing it into that channel's active mission budget (missionTickInner enforces it). In-process.",
    kind: "mutate",
    schema: z
      .object({
        workspaceId,
        channel: z.string().min(1),
        usdPerDay: z.number().optional(),
        postsPerDay: z.number().optional(),
      })
      .strict(),
    run: ({ workspaceId: ws, channel, usdPerDay, postsPerDay }) => {
      try {
        const cap = { usdPerDay, postsPerDay };
        setBrandBudgetCap(ws, channel, cap);
        // Make the cap BIND: push it into the channel's active mission(s) so the
        // orchestrator's per-day budget gate actually enforces it.
        for (const m of listMissions({ workspaceId: ws, status: "active" })) {
          if (m.channel !== channel) continue;
          try {
            updateMission(m.id, { budget: { usdPerDay, postsPerDay } });
          } catch {
            /* best-effort — admin store already recorded the cap */
          }
        }
        return ok(loadAdminControl(ws), `budget cap set for ${channel}`);
      } catch (e) {
        return fail(e);
      }
    },
  }),
];
