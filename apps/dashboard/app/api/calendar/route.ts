import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { recordInWorkspace } from "@os/schemas";
import { currentWorkspaceId } from "../../../lib/tenancy";
import { loadPlanFor } from "../../../lib/content-plan";
import { loadSchedule } from "../../../lib/schedule";

/* Content-calendar data source. Merges three things into a single dated list:
   1. Already-published posts (from data/runs/*.json publish[].at)
   2. One-off scheduled drops (per-workspace schedule store oneOff[])
   3. Recurring cadence slots projected onto upcoming days (schedule channels[].slots)
   4. Algo-hacking content plan (data/content-plan.json)

   Every source is scoped to the caller's workspace (ctx.workspaceId): runs are
   filtered by their stamped workspaceId, the schedule is loaded per-workspace,
   and the plan via loadPlanFor. Returns a graceful empty list when nothing exists. */

export const dynamic = "force-dynamic";

const REPO_ROOT = join(process.cwd(), "..", "..");
const RUNS_DIR = join(REPO_ROOT, "data", "runs");

type PublishRec = { platform: string; at: string; status: string };
type Run = {
  id: string;
  channel: string;
  createdAt: string;
  workspaceId?: string;
  createdBy?: string;
  assignee?: string;
  seedIdea?: string;
  idea?: { topic?: string };
  pkg?: { title?: string };
  publish?: PublishRec[];
  status: string;
};

export type CalendarItem = {
  id: string;
  date: string; // YYYY-MM-DD
  time: string; // HH:MM (local-ish, best effort)
  title: string;
  channel: string;
  platforms: string[];
  kind: "published" | "scheduled" | "cadence" | "planned";
  itemId?: string;
  public?: boolean;
  // planned-only enrichments (algo-hacking plan)
  planStatus?: string;
  algoLever?: string;
  overall?: number;
  mood?: string;
  // team visibility — who the post is assigned to / authored by
  assignee?: string;
  createdBy?: string;
};

/* Runs scoped to the caller's workspace (unstamped legacy runs → DEFAULT_WORKSPACE). */
function listRuns(workspaceId: string): Run[] {
  if (!existsSync(RUNS_DIR)) return [];
  const out: Run[] = [];
  for (const f of readdirSync(RUNS_DIR)) {
    if (!f.endsWith(".json")) continue;
    try {
      const r = JSON.parse(readFileSync(join(RUNS_DIR, f), "utf8")) as Run;
      if (recordInWorkspace(r, workspaceId)) out.push(r);
    } catch {
      /* skip */
    }
  }
  return out;
}

function ymd(iso: string): string {
  return iso.slice(0, 10);
}
function hm(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export async function GET() {
  const workspaceId = await currentWorkspaceId();
  const runs = listRuns(workspaceId);
  const schedule = loadSchedule(workspaceId);
  const items: CalendarItem[] = [];

  // 1. Published posts — one entry per run, grouped by earliest publish time.
  const runById = new Map<string, Run>();
  for (const r of runs) runById.set(r.id, r);

  for (const r of runs) {
    const pubs = Array.isArray(r.publish) ? r.publish : [];
    if (!pubs.length) continue;
    const first = [...pubs].sort((a, b) => a.at.localeCompare(b.at))[0];
    items.push({
      id: `pub:${r.id}`,
      date: ymd(first.at),
      time: hm(first.at),
      title: r.pkg?.title ?? r.idea?.topic ?? r.seedIdea ?? r.id,
      channel: r.channel,
      platforms: [...new Set(pubs.map((p) => p.platform))],
      kind: "published",
      itemId: r.id,
      createdBy: r.createdBy,
      assignee: r.assignee,
    });
  }

  // 2. One-off scheduled drops (skip ones already published == has run with publish).
  for (const o of schedule.oneOff ?? []) {
    const run = runById.get(o.itemId);
    const alreadyPublished = !!run?.publish?.length;
    if (alreadyPublished) continue;
    items.push({
      id: `one:${o.itemId}:${o.at}`,
      date: ymd(o.at),
      time: hm(o.at),
      title: run?.pkg?.title ?? run?.idea?.topic ?? run?.seedIdea ?? o.itemId,
      channel: run?.channel ?? "",
      platforms: [],
      kind: "scheduled",
      itemId: o.itemId,
      public: o.public,
    });
  }

  // 3. Recurring cadence slots projected onto the next 28 days (autopilot plan).
  if (schedule.enabled) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    for (let d = 0; d < 28; d++) {
      const day = new Date(today.getTime() + d * 86_400_000);
      const dateStr = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
      for (const ch of schedule.channels ?? []) {
        if (!ch.enabled) continue;
        for (const slot of ch.slots) {
          items.push({
            id: `cad:${slot.channel}:${dateStr}:${slot.time}`,
            date: dateStr,
            time: slot.time,
            title: slot.seed?.trim() || "Autopilot drop",
            channel: slot.channel,
            platforms: [],
            kind: "cadence",
            public: slot.public,
          });
        }
      }
    }
  }

  // 4. Algo-hacking content plan — dated, brand/platform-aware ideas to fill the
  //    calendar. Dropped posts are hidden; everything else shows as "planned".
  //    Carries assignee/createdBy so the calendar can show + filter by teammate.
  for (const p of loadPlanFor(workspaceId)) {
    if (p.status === "dropped") continue;
    items.push({
      id: `plan:${p.id}`,
      date: p.date,
      time: p.time,
      title: p.topic,
      channel: p.channel,
      platforms: [p.platform],
      kind: "planned",
      itemId: p.id,
      planStatus: p.status,
      algoLever: p.algoLever,
      overall: p.overall,
      mood: p.mood,
      assignee: p.assignee,
      createdBy: p.createdBy,
    });
  }

  items.sort((a, b) => a.date.localeCompare(b.date) || a.time.localeCompare(b.time));

  return Response.json({
    hasData: items.length > 0,
    timezone: schedule.timezone ?? "local",
    scheduleEnabled: !!schedule.enabled,
    items,
  });
}
