import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_WORKSPACE, recordInWorkspace } from "@os/schemas";
import type { Item, ItemSummary, JobRow, Device, FleetState, Schedule } from "@socheli/sdk";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
export const DATA_DIR = process.env.SOCHELI_DATA_DIR || join(ROOT, "data");
const RUNS = join(DATA_DIR, "runs");
const RENDERS = process.env.SOCHELI_RENDERS_DIR || join(DATA_DIR, "renders");
const MEDIA_BASE = (process.env.HOST_PUBLIC_BASE || "https://media.socheli.com").replace(/\/$/, "");

function readJson<T>(p: string, d: T): T {
  if (!existsSync(p)) return d;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as T;
  } catch {
    return d;
  }
}

function rawItems(): any[] {
  if (!existsSync(RUNS)) return [];
  return readdirSync(RUNS)
    .filter((f) => f.endsWith(".json"))
    .map((f) => readJson<any>(join(RUNS, f), null))
    .filter(Boolean)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

const title = (it: any): string => it.pkg?.title ?? it.idea?.topic ?? it.seedIdea ?? it.id;
const videoUrl = (it: any): string | undefined =>
  it.videoPath || existsSync(join(RENDERS, `${it.id}.mp4`)) ? `${MEDIA_BASE}/${it.id}.mp4` : undefined;

export function toSummary(it: any): ItemSummary {
  return {
    id: it.id,
    channel: it.channel,
    status: it.status,
    title: title(it),
    createdAt: it.createdAt,
    updatedAt: it.updatedAt,
    qa: it.qa?.overall,
    costUsd: it.ledger?.totalUsd,
    publish: it.publish,
  };
}

export function toItem(it: any): Item {
  return {
    ...toSummary(it),
    idea: it.idea && { topic: it.idea.topic, angle: it.idea.angle, format: it.idea.format },
    script: it.script && { hook: it.script.hook, narration: it.script.narration, cta: it.script.cta },
    storyboard: it.storyboard && {
      topic: it.storyboard.topic,
      format: it.storyboard.format,
      scenes: (it.storyboard.scenes ?? []).map((s: any) => ({ id: s.id, type: s.type, durationSec: s.durationSec })),
    },
    pkg: it.pkg && { title: it.pkg.title, caption: it.pkg.caption, hashtags: it.pkg.hashtags, altText: it.pkg.altText },
    videoUrl: videoUrl(it),
    warnings: Array.isArray(it.warnings) && it.warnings.length ? it.warnings : undefined,
  };
}

/* Reads are scoped to the caller's workspace. The migration stamped every run
   file with `workspaceId`; unstamped/legacy records resolve to DEFAULT_WORKSPACE
   (so they remain visible only inside the default workspace). */
export function listItems(opts: { limit?: number; channel?: string; workspaceId?: string } = {}): ItemSummary[] {
  const ws = opts.workspaceId ?? DEFAULT_WORKSPACE;
  let xs = rawItems().filter((x) => recordInWorkspace(x, ws));
  if (opts.channel) xs = xs.filter((x) => x.channel === opts.channel);
  if (opts.limit) xs = xs.slice(0, opts.limit);
  return xs.map(toSummary);
}

/* Returns null when the record is missing OR lives in another workspace (the
   handler turns that into a 404 so cross-tenant ids are indistinguishable). */
export function getItem(id: string, workspaceId: string = DEFAULT_WORKSPACE): Item | null {
  const p = join(RUNS, `${id}.json`);
  const raw = readJson<any>(p, null);
  if (!raw || !recordInWorkspace(raw, workspaceId)) return null;
  return toItem(raw);
}

/* Jobs carry an optional workspaceId (stamped on dispatch); unstamped jobs fall
   to the default workspace. */
export function getJobs(workspaceId: string = DEFAULT_WORKSPACE): JobRow[] {
  const all = readJson<{ jobs: JobRow[] }>(join(DATA_DIR, "jobs.json"), { jobs: [] }).jobs ?? [];
  return all.filter((j) => recordInWorkspace(j as any, workspaceId));
}

const STALE_MS = 70_000;
/* Devices are shared control-plane infrastructure (every workspace dispatches to
   the same fleet), but the jobs view is scoped to the caller's workspace. */
export function getFleet(workspaceId: string = DEFAULT_WORKSPACE): FleetState {
  const f = readJson<{ devices: Record<string, Device> }>(join(DATA_DIR, "fleet.json"), { devices: {} });
  const now = Date.now();
  const devices = Object.values(f.devices).map((d) => {
    const stale = now - new Date(d.lastSeen).getTime() > STALE_MS;
    return stale && d.status !== "offline" ? { ...d, status: "offline" as const } : d;
  });
  return { devices, jobs: getJobs(workspaceId).slice(0, 30), online: devices.filter((d) => d.status !== "offline").length };
}

/* The raw fleet devices (unscoped) — used by the dispatcher to pick a device. */
export function getDevices(): Device[] {
  return getFleet().devices;
}

/* The autopilot schedule is per-workspace. The on-disk schedule.json may carry a
   `workspaceId`; a record from another workspace reads as the empty default. */
const EMPTY_SCHEDULE: Schedule = { enabled: false, timezone: "UTC", graceMinutes: 10, channels: [] };
export function getSchedule(workspaceId: string = DEFAULT_WORKSPACE): Schedule {
  const s = readJson<Schedule>(join(DATA_DIR, "schedule.json"), EMPTY_SCHEDULE);
  return recordInWorkspace(s as any, workspaceId) ? s : { ...EMPTY_SCHEDULE };
}
