import os from "node:os";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { RunWarning } from "@os/schemas";

/* Socheli Fleet — the MQTT control plane that links the always-on server (control
   plane) to render devices (M4 + any others). CONTROL travels over MQTT (jobs,
   presence, progress, results — all tiny); heavy DATA (rendered mp4s) never does
   — it rsyncs to the server and is served at media.socheli.com.

   Topic map:
     socheli/jobs                      — job dispatch (workers subscribe via the
                                          $share group so each job goes to ONE device)
     socheli/workers/<device>/presence — retained presence + Last-Will (online/idle/busy/offline)
     socheli/jobs/<jobId>/progress     — streamed log lines while a job runs
     socheli/jobs/<jobId>/result       — terminal result (done/error + item id)
*/

export const SHARE_GROUP = "render";

export const TOPICS = {
  jobs: "socheli/jobs",
  jobsShared: `$share/${SHARE_GROUP}/socheli/jobs`,
  device: (device: string) => `socheli/device/${device}/jobs`, // central-scheduler direct dispatch
  presence: (device: string) => `socheli/workers/${device}/presence`,
  presenceWild: "socheli/workers/+/presence",
  progress: (jobId: string) => `socheli/jobs/${jobId}/progress`,
  progressWild: "socheli/jobs/+/progress",
  result: (jobId: string) => `socheli/jobs/${jobId}/result`,
  resultWild: "socheli/jobs/+/result",
  cancel: (jobId: string) => `socheli/jobs/${jobId}/cancel`, // cooperative cancel request to the running device
  cancelWild: "socheli/jobs/+/cancel",
} as const;

/* Capability vocabulary — what a device can do. The agent advertises these; the
   server-side matcher (packages/api/src/match.ts) routes jobs by them. Keep the
   two in sync.
     render          — Remotion + ffmpeg available (any generation job needs this)
     voice:eleven    — ElevenLabs premium voice (key present)
     voice:kokoro    — local Kokoro voice (always available)
     music:musicgen  — local MusicGen (the .venv-music environment exists)
     broll:sdturbo   — local SD-Turbo image b-roll (venv + a GPU)
     broll:pexels    — Pexels stock b-roll (key present)                          */
export type DeviceProfile = {
  arch: string; // arm64 | x64 | …
  platform: string; // darwin | linux | …
  cpus: number;
  ramGb: number;
  gpu: string; // metal | cuda | none
};

export type JobType = "auto" | "new" | "ping" | "render" | "longform";

export type Job = {
  id: string;
  type: JobType;
  channel?: string;
  seed?: string;
  mood?: string;
  voice?: boolean;
  research?: "quick" | "standard" | "deep"; // run verified research on the seed before generating (type "new")
  public?: boolean; // publish publicly after render (auto)
  // For type "render" (finalize a draft built on the control plane): the existing
  // item id, and the full item payload so the render device — which doesn't have
  // the draft on disk — can write it locally before rendering.
  itemId?: string;
  item?: unknown;
  createdAt: string;
  by?: string; // who dispatched (clerk user / "dashboard")
  workspaceId?: string; // owning org/person (absent on legacy → DEFAULT_WORKSPACE)
  createdBy?: string; // Clerk user id of the dispatcher
  target?: string; // pin this job to one device (honoured even unsigned — see job-verify)
};

export type DeviceStatus = "online" | "idle" | "busy" | "offline";
export type Presence = {
  device: string;
  status: DeviceStatus;
  caps?: string[]; // capability vocabulary above
  profile?: DeviceProfile; // hardware/software profile
  currentJob?: string | null;
  lastSeen: string;
};

export type JobResult = {
  jobId: string;
  device: string;
  status: "ack" | "done" | "error";
  itemId?: string;
  message?: string;
  // Non-fatal degradations from the render (caption/music/voice fallbacks). A
  // job can be "done" AND carry warnings — the device reports "done, but the
  // captions degraded" rather than a clean success that hides the problem.
  warnings?: RunWarning[];
  at: string;
};

/* Connection config. Devices set SOCHELI_BROKER_URL=wss://mqtt.socheli.com + their
   own creds; the server's bridge/dashboard use mqtt://127.0.0.1:1883. */
export function brokerConfig(): { url: string; username?: string; password?: string } {
  return {
    url: process.env.SOCHELI_BROKER_URL || "mqtt://127.0.0.1:1883",
    username: process.env.SOCHELI_MQTT_USER || undefined,
    password: process.env.SOCHELI_MQTT_PASS || undefined,
  };
}

export const newJobId = (): string => `job_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

/* Probe what THIS device can actually do. Run once at agent startup; the result
   is advertised in presence so the central scheduler can route by capability. */
export function probeCapabilities(): { caps: string[]; profile: DeviceProfile } {
  // Cross-platform "is this binary on PATH?" — POSIX `command -v` does NOT exist in
  // native Windows cmd/PowerShell, so a Windows render node would otherwise probe
  // false for EVERY cap (no `render` → never routed any job). `where` is the Windows
  // equivalent. (Running the agent under WSL also works; this hardens the native path.)
  const has = (bin: string) => {
    const probe = process.platform === "win32"
      ? spawnSync("where", [bin], { shell: true, encoding: "utf8" })
      : spawnSync("command", ["-v", bin], { shell: true, encoding: "utf8" });
    return probe.status === 0;
  };
  const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  const profile: DeviceProfile = {
    arch: process.arch,
    platform: process.platform,
    cpus: os.cpus().length,
    ramGb: Math.round(os.totalmem() / 1e9),
    gpu: process.platform === "darwin" && process.arch === "arm64" ? "metal" : has("nvidia-smi") ? "cuda" : "none",
  };

  const caps: string[] = [];
  if (has("ffmpeg")) caps.push("render"); // Remotion render needs ffmpeg; chromium is auto-fetched
  caps.push("voice:kokoro"); // bundled (kokoro-js)
  if (process.env.ELEVENLABS_API_KEY) caps.push("voice:eleven");
  if (process.env.PEXELS_API_KEY) caps.push("broll:pexels");
  const venv = existsSync(join(repo, ".venv-music"));
  if (venv) caps.push("music:musicgen");
  if (venv && profile.gpu !== "none") caps.push("broll:sdturbo");

  return { caps, profile };
}
