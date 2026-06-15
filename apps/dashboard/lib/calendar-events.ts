import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_WORKSPACE, recordInWorkspace } from "@os/schemas";
import { REPO_ROOT } from "./data";
import { loadPlanFor } from "./content-plan";
import { loadMetaFor } from "./calendar-meta";

/* Single source of truth for the content calendar's events. Consumed by both the
   public .ics feed (api/calendar/ics) and the Google Calendar push
   (lib/google-calendar.ts) so the two never drift.

   Workspace-aware: every event source is scoped to the given workspaceId
   (default DEFAULT_WORKSPACE), so a tenant's calendar/.ics only ever shows that
   tenant's posts, drops, history and reminders. */

const CHANNEL_NAMES: Record<string, string> = {
  labrinox: "Labrinox", claude_code_lab: "Code Labrinox", agentic_builder: "Agentic Builder", moltjobs: "MoltJobs", cognitivx: "iCog",
};
export const chName = (id: string) => CHANNEL_NAMES[id] ?? id;

export type VEvent = { uid: string; date: string; time: string; durationMin: number; summary: string; description: string; alarm?: boolean };

/* "YYYY-MM-DD" + "HH:MM" → naive local datetime "YYYY-MM-DDTHH:MM:SS" (no offset). */
export function isoLocal(date: string, time: string, addMinutes = 0): string {
  const [y, m, d] = date.split("-").map(Number);
  const [hh, mm] = (/^\d{2}:\d{2}$/.test(time) ? time : "09:00").split(":").map(Number);
  const dt = new Date(y, m - 1, d, hh, mm + addMinutes);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())}T${p(dt.getHours())}:${p(dt.getMinutes())}:00`;
}

export function gatherEvents(workspaceId = DEFAULT_WORKSPACE): VEvent[] {
  const events: VEvent[] = [];

  // Planned (algo lab) posts — scoped to the workspace.
  for (const p of loadPlanFor(workspaceId)) {
    if (p.status === "dropped") continue;
    events.push({
      uid: `plan-${p.id}@socheli`,
      date: p.date,
      time: p.time,
      durationMin: 30,
      summary: `[${chName(p.channel)} · ${p.platform}] ${p.topic}`,
      description: `${p.angle}${p.algoLever ? `\nAlgo lever: ${p.algoLever}` : ""}${p.overall ? `\nScore: ${p.overall}` : ""}`,
    });
  }

  // One-off scheduled drops — the schedule store is per-workspace.
  const schedFile = workspaceId === DEFAULT_WORKSPACE
    ? join(REPO_ROOT, "data", "schedule.json")
    : join(REPO_ROOT, "data", "schedules", `${workspaceId.replace(/[^a-zA-Z0-9_-]/g, "_")}.json`);
  if (existsSync(schedFile)) {
    try {
      const sched = JSON.parse(readFileSync(schedFile, "utf8")) as { oneOff?: { itemId: string; at: string }[] };
      for (const o of sched.oneOff ?? []) {
        const date = o.at.slice(0, 10);
        const time = o.at.slice(11, 16) || "09:00";
        events.push({ uid: `sched-${o.itemId}@socheli`, date, time, durationMin: 30, summary: `Scheduled post ${o.itemId}`, description: "Scheduled content drop." });
      }
    } catch {
      /* ignore */
    }
  }

  // Published posts (history) — earliest publish time per run, scoped to workspace.
  const runsDir = join(REPO_ROOT, "data", "runs");
  if (existsSync(runsDir)) {
    for (const f of readdirSync(runsDir)) {
      if (!f.endsWith(".json")) continue;
      try {
        const r = JSON.parse(readFileSync(join(runsDir, f), "utf8")) as { id: string; channel: string; workspaceId?: string; pkg?: { title?: string }; idea?: { topic?: string }; publish?: { at: string }[] };
        if (!recordInWorkspace(r, workspaceId)) continue;
        const pubs = r.publish ?? [];
        if (!pubs.length) continue;
        const first = [...pubs].sort((a, b) => a.at.localeCompare(b.at))[0];
        events.push({ uid: `pub-${r.id}@socheli`, date: first.at.slice(0, 10), time: first.at.slice(11, 16) || "09:00", durationMin: 30, summary: `✓ ${r.pkg?.title ?? r.idea?.topic ?? r.id} (${chName(r.channel)})`, description: "Published." });
      } catch {
        /* skip */
      }
    }
  }

  // Reminders — scoped to the workspace.
  for (const e of loadMetaFor(workspaceId)) {
    if (e.kind !== "reminder" || e.done) continue;
    events.push({ uid: `rem-${e.id}@socheli`, date: e.date, time: e.remindAt || "09:00", durationMin: 15, summary: `⏰ ${e.text}`, description: e.channel ? `Brand: ${chName(e.channel)}` : "Reminder", alarm: true });
  }

  return events;
}
