import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { recordInWorkspace } from "@os/schemas";
import { REPO_ROOT } from "./data";

/* Dashboard-side reader for the fleet control plane state that the bridge writes
   (data/fleet.json + data/jobs.json). Self-contained, file-based — same pattern
   as lib/schedule.ts.

   Jobs belong to a workspace (the bridge stamps workspaceId/createdBy from the
   dispatcher), so fleet() is scoped to the caller's workspace. Devices are a
   SHARED resource — any workspace can render on any online device — so presence
   is not filtered; a device is tagged with the workspace of the job it's running. */

const FLEET = join(REPO_ROOT, "data", "fleet.json");
const JOBS = join(REPO_ROOT, "data", "jobs.json");

export type DeviceStatus = "online" | "idle" | "busy" | "offline";
export type DeviceProfile = { arch: string; platform: string; cpus: number; ramGb: number; gpu: string };
export type Presence = { device: string; status: DeviceStatus; host?: string; caps?: string[]; profile?: DeviceProfile; currentJob?: string | null; lastSeen: string };
export type JobRow = {
  id: string;
  type: "auto" | "new" | "ping";
  channel?: string;
  seed?: string;
  by?: string;
  workspaceId?: string; // owning org/person (absent on legacy → DEFAULT_WORKSPACE)
  createdBy?: string; // Clerk user id of the dispatcher
  createdAt: string;
  status: "dispatched" | "running" | "done" | "error";
  device?: string;
  itemId?: string;
  message?: string;
  progress: { at: string; line: string }[];
  updatedAt: string;
};

function read<T>(p: string, d: T): T {
  if (!existsSync(p)) return d;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as T;
  } catch {
    return d;
  }
}

/* A device is only "live" if its last heartbeat is recent — a stale retained
   presence (e.g. an agent that died without its Last-Will firing) reads offline. */
const STALE_MS = 70_000;

/* All jobs the bridge has recorded (newest first), unscoped. Internal helper +
   the basis for the workspace-scoped reads below. */
function allJobs(): JobRow[] {
  return read<{ jobs: JobRow[] }>(JOBS, { jobs: [] }).jobs ?? [];
}

/* Live device presence (shared across workspaces), newest-heartbeat aware. */
function allDevices(): Presence[] {
  const f = read<{ devices: Record<string, Presence> }>(FLEET, { devices: {} });
  const now = Date.now();
  return Object.values(f.devices)
    .map((d) => {
      const stale = now - new Date(d.lastSeen).getTime() > STALE_MS;
      return stale && d.status !== "offline" ? { ...d, status: "offline" as DeviceStatus } : d;
    })
    .sort((a, b) => a.device.localeCompare(b.device));
}

/* The fleet view for one workspace: shared devices + only that workspace's jobs.
   `workspaceId` omitted keeps the legacy unscoped behaviour (all jobs). */
export function fleet(workspaceId?: string): { devices: Presence[]; jobs: JobRow[]; online: number } {
  const devices = allDevices();
  const scoped = workspaceId ? allJobs().filter((j) => recordInWorkspace(j, workspaceId)) : allJobs();
  return {
    devices,
    jobs: scoped.slice(0, 30),
    online: devices.filter((d) => d.status !== "offline").length,
  };
}

/* A single job by id, scoped to a workspace (returns undefined cross-workspace so
   route handlers can answer 404). Omit workspaceId for an unscoped lookup. */
export function getJobFor(id: string, workspaceId?: string): JobRow | undefined {
  const job = allJobs().find((j) => j.id === id);
  if (!job) return undefined;
  if (workspaceId && !recordInWorkspace(job, workspaceId)) return undefined;
  return job;
}
