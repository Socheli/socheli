import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import mqtt from "mqtt";
import { TOPICS, brokerConfig, type Job, type Presence, type JobResult } from "./fleet.ts";
import { DATA_DIR, ensureDir } from "./store.ts";

/* Server-side fleet bridge. Subscribes to the control plane and projects it into
   two file-based views the dashboard reads (everything in Socheli is file-based):
     data/fleet.json — devices + live presence
     data/jobs.json  — dispatched jobs, their progress tail and result
   Run as a systemd service on the server (`content bridge`). */

const FLEET = join(DATA_DIR, "fleet.json");
const JOBS = join(DATA_DIR, "jobs.json");
const MAX_JOBS = 60;
const MAX_PROGRESS = 40;

type FleetFile = { devices: Record<string, Presence>; updatedAt: string };
type JobRow = Job & { status: "dispatched" | "running" | "done" | "error"; device?: string; itemId?: string; message?: string; warnings?: JobResult["warnings"]; progress: { at: string; line: string }[]; updatedAt: string };
type JobsFile = { jobs: JobRow[]; updatedAt: string };

const loadFleet = (): FleetFile => (existsSync(FLEET) ? safe(FLEET, { devices: {}, updatedAt: "" }) : { devices: {}, updatedAt: "" });
const loadJobs = (): JobsFile => (existsSync(JOBS) ? safe(JOBS, { jobs: [], updatedAt: "" }) : { jobs: [], updatedAt: "" });
function safe<T>(p: string, d: T): T {
  try {
    return JSON.parse(readFileSync(p, "utf8")) as T;
  } catch {
    return d;
  }
}
const save = (p: string, v: unknown) => writeFileSync(p, JSON.stringify(v, null, 2));
const now = () => new Date().toISOString();

export function startBridge(): void {
  ensureDir(DATA_DIR);
  const { url, username, password } = brokerConfig();
  const log = (m: string) => console.log(`[bridge ${now()}] ${m}`);
  const client = mqtt.connect(url, { username, password, reconnectPeriod: 5000 });

  client.on("connect", () => {
    log(`connected to ${url}`);
    for (const t of [TOPICS.jobs, TOPICS.resultWild, TOPICS.progressWild, TOPICS.presenceWild]) client.subscribe(t, { qos: 1 });
    log("subscribed: jobs, results, progress, presence");
  });
  client.on("error", (e) => log(`mqtt error: ${e.message}`));

  client.on("message", (topic, payload) => {
    const text = payload.toString();
    try {
      if (topic === TOPICS.jobs) onJob(JSON.parse(text));
      else if (topic.endsWith("/presence")) onPresence(JSON.parse(text));
      else if (topic.endsWith("/result")) onResult(JSON.parse(text));
      else if (topic.endsWith("/progress")) onProgress(topic.split("/")[2], JSON.parse(text));
    } catch (e: any) {
      log(`bad message on ${topic}: ${e?.message ?? e}`);
    }
  });

  function onPresence(p: Presence) {
    const f = loadFleet();
    f.devices[p.device] = p;
    f.updatedAt = now();
    save(FLEET, f);
    // NOTE: we deliberately do NOT reap a device's jobs when it reports offline.
    // A long job (esp. longform) makes blocking native calls (LLM/ffmpeg/musicgen)
    // that stall the agent's event loop → MQTT keepalive lapses → the broker fires
    // the "offline" will, even though the agent reconnects seconds later and is
    // still rendering. Reaping on that blip falsely errors a live job. Genuine
    // death is caught by the time-based sweepStale backstop below, and a live job
    // self-heals the instant its next progress line arrives (see onProgress).
  }

  // Backstop sweep: a healthy job emits progress (incl. a ≤30s heartbeat) often,
  // so one with no update for STALE_RUNNING_MS is genuinely dead (device killed,
  // lost broker). If the sweep ever fires early during a long blocking stretch,
  // the job's next progress line restores it to running (onProgress). `dispatched`
  // jobs get a longer grace window so one queued behind a long render isn't reaped.
  const STALE_RUNNING_MS = 12 * 60_000;
  const STALE_DISPATCHED_MS = 25 * 60_000;
  // The final-render SYNC stage rsyncs big mp4s (a long-form is ~280MB) over the
  // M4's slow uplink and emits no per-byte progress, so it can legitimately run
  // far longer than a render step without a fresh line — give it a wide grace so
  // we don't false-error a job that's just uploading.
  const STALE_SYNCING_MS = 90 * 60_000;
  function sweepStale() {
    const f = loadJobs();
    const t = Date.parse(now());
    let changed = false;
    for (const j of f.jobs) {
      const age = t - Date.parse(j.updatedAt);
      const syncing = /sync/i.test(j.progress[j.progress.length - 1]?.line ?? "");
      const limit = j.status === "running" ? (syncing ? STALE_SYNCING_MS : STALE_RUNNING_MS) : j.status === "dispatched" ? STALE_DISPATCHED_MS : 0;
      if (limit && age > limit) {
        j.status = "error";
        j.message = `stale — no progress for ${Math.round(age / 60_000)}m`;
        j.updatedAt = now();
        changed = true;
      }
    }
    if (changed) { f.updatedAt = now(); save(JOBS, f); log("swept stale jobs → error"); }
  }
  setInterval(sweepStale, 60_000);

  function onJob(job: Job) {
    const f = loadJobs();
    if (f.jobs.find((j) => j.id === job.id)) return;
    // spread the whole job so its tenancy (workspaceId/createdBy) + dispatch
    // metadata travel into the row and survive the rest of the lifecycle — but
    // drop the heavy `item` payload that render jobs carry (it'd bloat jobs.json).
    const { item, ...rest } = job as Job & { item?: unknown };
    void item;
    f.jobs.unshift({ ...rest, status: "dispatched", progress: [], updatedAt: now() });
    f.jobs = f.jobs.slice(0, MAX_JOBS);
    f.updatedAt = now();
    save(JOBS, f);
    log(`job ${job.id} (${job.type}) dispatched`);
  }

  function onResult(r: JobResult) {
    const f = loadJobs();
    const j = f.jobs.find((x) => x.id === r.jobId);
    if (!j) return;
    j.device = r.device;
    if (r.status === "ack") j.status = "running";
    else if (r.status === "done") { j.status = "done"; j.itemId = r.itemId; j.warnings = r.warnings; }
    else if (r.status === "error") { j.status = "error"; j.message = r.message; }
    j.updatedAt = now();
    f.updatedAt = now();
    save(JOBS, f);
  }

  function onProgress(jobId: string, p: { at: string; line: string }) {
    const f = loadJobs();
    let j = f.jobs.find((x) => x.id === jobId);
    if (!j) {
      // A job we never saw dispatched — e.g. a DIRECT device-targeted dispatch
      // (socheli/device/<id>/jobs) that skipped the shared queue the bridge tracks.
      // Create a minimal row from the progress so its live % still shows on /queue.
      j = { id: jobId, type: "render", channel: "", createdAt: now(), by: "device", status: "running", progress: [], updatedAt: now() };
      f.jobs.unshift(j);
      f.jobs = f.jobs.slice(0, MAX_JOBS);
    }
    // A progress line proves the device is alive and working this job — so recover
    // it from a dispatched-but-unacked state OR a false reap (transient offline
    // blip / early stale sweep). Terminal "done" is owned by onResult, not here.
    if (j.status === "dispatched" || j.status === "error") { j.status = "running"; j.message = undefined; }
    j.progress.push(p);
    if (j.progress.length > MAX_PROGRESS) j.progress = j.progress.slice(-MAX_PROGRESS);
    j.updatedAt = now();
    save(JOBS, f);
  }
}
