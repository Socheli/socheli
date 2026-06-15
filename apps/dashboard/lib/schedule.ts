import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";
import { DEFAULT_WORKSPACE } from "@os/schemas";
import { REPO_ROOT } from "./data";

/* Dashboard-side mirror of the engine schedule store and a read-only view of
   launchd + platform-connection status. Self-contained so the dashboard doesn't
   depend on the engine package — same pattern as lib/data.ts.

   Each workspace has its OWN cadence: schedules live at data/schedules/<ws>.json.
   The default workspace keeps reading/writing the original data/schedule.json so
   the engine scheduler (which still drives that file) keeps firing unchanged. */

const LEGACY_FILE = join(REPO_ROOT, "data", "schedule.json");
const SCHED_DIR = join(REPO_ROOT, "data", "schedules");
const safeWs = (workspaceId: string) => workspaceId.replace(/[^a-zA-Z0-9_-]/g, "_");
const scheduleFile = (workspaceId: string) =>
  workspaceId === DEFAULT_WORKSPACE ? LEGACY_FILE : join(SCHED_DIR, `${safeWs(workspaceId)}.json`);
const ENV_FILE = join(REPO_ROOT, ".env");
const LOG_FILE = join(REPO_ROOT, "data", "scheduler.log");
const LABEL = "com.socheli.scheduler";
const PLIST = join(process.env.HOME ?? "", "Library", "LaunchAgents", `${LABEL}.plist`);

export type Slot = { time: string; channel: string; mood?: string; seed?: string; public: boolean };
export type Cadence = { channel: string; enabled: boolean; slots: Slot[] };
export type Schedule = {
  workspaceId?: string; // owning org/person (absent on legacy → DEFAULT_WORKSPACE)
  enabled: boolean;
  timezone: string;
  graceMinutes: number;
  channels: Cadence[];
  oneOff: { itemId: string; at: string; public: boolean; firedAt?: string }[];
  state: Record<string, { lastFiredDate: string; lastItemId?: string; lastResult?: string }>;
  updatedAt: string;
};

/* The channels the autopilot can target (kept in sync with engine channels.ts). */
export const KNOWN_CHANNELS: { id: string; name: string }[] = [
  { id: "labrinox", name: "Labrinox" },
  { id: "claude_code_lab", name: "Code Labrinox" },
  { id: "agentic_builder", name: "Agentic Builder" },
  { id: "moltjobs", name: "MoltJobs" },
  { id: "cognitivx", name: "iCog by CognitivX" },
];

const DEFAULT: Schedule = {
  enabled: false,
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
  graceMinutes: 10,
  channels: [],
  oneOff: [],
  state: {},
  updatedAt: "",
};

/* Load a workspace's cadence. Defaults to the default workspace so legacy callers
   (and the engine scheduler's data/schedule.json) keep working unchanged. */
export function loadSchedule(workspaceId: string = DEFAULT_WORKSPACE): Schedule {
  const file = scheduleFile(workspaceId);
  if (!existsSync(file)) return { ...DEFAULT, workspaceId };
  try {
    return { ...DEFAULT, ...(JSON.parse(readFileSync(file, "utf8")) as Schedule), workspaceId };
  } catch {
    return { ...DEFAULT, workspaceId };
  }
}

export function saveSchedule(s: Schedule, workspaceId: string = DEFAULT_WORKSPACE): Schedule {
  s.workspaceId = workspaceId; // stamp ownership; the file path is per-workspace
  s.updatedAt = new Date().toISOString();
  const file = scheduleFile(workspaceId);
  if (file !== LEGACY_FILE) mkdirSync(SCHED_DIR, { recursive: true });
  writeFileSync(file, JSON.stringify(s, null, 2));
  return s;
}

/* Read .env key presence without leaking values — for the Connections card. */
function envKeys(): Set<string> {
  const set = new Set<string>(Object.keys(process.env));
  if (existsSync(ENV_FILE)) {
    for (const line of readFileSync(ENV_FILE, "utf8").split("\n")) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.+)\s*$/.exec(line);
      if (m && m[2].trim()) set.add(m[1]);
    }
  }
  return set;
}

export function platformStatus(): { youtube: boolean; instagram: boolean; tiktok: boolean; host: boolean } {
  const k = envKeys();
  const host =
    (k.has("HOST_LOCAL_DIR") && k.has("HOST_PUBLIC_BASE")) ||
    (k.has("HOST_S3_BUCKET") && k.has("HOST_S3_PUBLIC_BASE")) ||
    (k.has("HOST_UPLOAD_URL") && k.has("HOST_PUBLIC_BASE"));
  return {
    youtube: k.has("YOUTUBE_CLIENT_ID") && k.has("YOUTUBE_CLIENT_SECRET") && k.has("YOUTUBE_REFRESH_TOKEN"),
    instagram: k.has("IG_USER_ID") && k.has("IG_ACCESS_TOKEN") && host,
    tiktok: k.has("TIKTOK_ACCESS_TOKEN") && host,
    host,
  };
}

function nextDue(s: Schedule): { channel: string; time: string; at: string } | null {
  if (!s.enabled) return null;
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: s.timezone, hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(now);
  const hh = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  const mm = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
  const nowMin = (hh % 24) * 60 + mm;
  let best: { channel: string; time: string; delta: number } | null = null;
  for (const ch of s.channels) {
    if (!ch.enabled) continue;
    for (const slot of ch.slots) {
      const [h, m] = slot.time.split(":").map(Number);
      const start = h * 60 + m;
      const delta = start >= nowMin ? start - nowMin : start - nowMin + 1440;
      if (!best || delta < best.delta) best = { channel: slot.channel, time: slot.time, delta };
    }
  }
  if (!best) return null;
  return { channel: best.channel, time: best.time, at: new Date(now.getTime() + best.delta * 60_000).toISOString() };
}

/* launchd install/load + connections are host-level; `next` is per-workspace
   (computed from that workspace's own cadence). */
export function schedulerStatus(workspaceId: string = DEFAULT_WORKSPACE) {
  const installed = existsSync(PLIST);
  let loaded = false;
  try {
    loaded = execSync(`launchctl list 2>/dev/null | grep ${LABEL} || true`, { encoding: "utf8" }).includes(LABEL);
  } catch { /* ignore */ }
  let logTail = "";
  if (existsSync(LOG_FILE)) logTail = readFileSync(LOG_FILE, "utf8").trim().split("\n").slice(-25).join("\n");
  return { installed, loaded, platforms: platformStatus(), next: nextDue(loadSchedule(workspaceId)), logTail, installCmd: "pnpm content scheduler install" };
}
