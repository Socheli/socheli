import { spawn } from "node:child_process";
import { writeFileSync, mkdirSync, appendFileSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import mqtt from "mqtt";
import { TOPICS, brokerConfig, probeCapabilities, type Job, type Presence, type JobResult } from "./fleet.ts";
import type { RunWarning } from "@os/schemas";
import { generate } from "./run.ts";
import { generateLongform } from "./longform-run.ts";
import { autopilot } from "./autopilot.ts";
import { runSync } from "./sync.ts";
import { verifyInboundJob, minimalRenderEnv, localPublicOptIn } from "./job-verify.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..", "..");

/* Read the warnings a just-finished run recorded (non-fatal degradations), to
   ride along on the job's terminal result. Best-effort: a parse miss must never
   turn a successful render into a reported failure. */
function readItemWarnings(itemId: string): RunWarning[] | undefined {
  try {
    const p = join(REPO, "data", "runs", `${itemId}.json`);
    if (!existsSync(p)) return undefined;
    const w = (JSON.parse(readFileSync(p, "utf8")) as { warnings?: RunWarning[] }).warnings;
    return Array.isArray(w) && w.length ? w : undefined;
  } catch {
    return undefined;
  }
}

/* A render device. Connects to the broker, advertises presence, and pulls jobs
   from the shared queue one at a time (serial — rendering is heavy). After a job
   it rsyncs data/ up so the online dashboard + media host reflect the new post. */
export function startAgent(deviceId: string): void {
  // The agent runs its OWN awaited sync after each job (below), so suppress the
  // per-render auto-sync hook in generate()/generateLongform() to avoid doubling.
  process.env.SOCHELI_IN_AGENT = "1";
  const { url, username, password } = brokerConfig();
  const { caps, profile } = probeCapabilities();
  const presenceTopic = TOPICS.presence(deviceId);
  const now = () => new Date().toISOString();
  const log = (m: string) => console.log(`[agent ${deviceId} ${now()}] ${m}`);

  const client = mqtt.connect(url, {
    username,
    password,
    reconnectPeriod: 5000,
    // keepalive: 0 disables client PINGREQ. Rendering makes long SYNCHRONOUS calls
    // (musicgen/whisper/ffmpeg/brain via spawnSync can block the event loop for
    // minutes), during which the lib can't send keepalive pings → the broker would
    // drop us mid-render, firing the "offline" will (false "device went offline")
    // and dropping live progress. With keepalive off the broker won't time out an
    // idle-looking-but-alive connection; a genuinely dead socket still reconnects.
    keepalive: 0,
    will: { topic: presenceTopic, qos: 1, retain: true, payload: JSON.stringify({ device: deviceId, status: "offline", lastSeen: now() } satisfies Presence) },
  });

  let current: string | null = null;
  const queue: Job[] = [];
  let draining = false;

  let lastStatus: Presence["status"] = "idle";
  const presence = (status: Presence["status"]) => {
    lastStatus = status;
    // NOTE: never publish the machine hostname — it's a retained beacon on a
    // cloud-readable broker (deanonymization vector). Identity is the codename
    // deviceId only.
    client.publish(presenceTopic, JSON.stringify({ device: deviceId, status, caps, profile, currentJob: current, lastSeen: now() } satisfies Presence), { qos: 1, retain: true });
  };
  // heartbeat: refresh presence so the server (and `content jobs`) can tell a live
  // device from a dead one + see it promptly after subscribing (10s keeps the
  // consolidated views fresh without spamming the broker).
  setInterval(() => { if (client.connected) presence(lastStatus); }, 10_000);

  // Live progress: every emitted line bumps progressAt; onLog lines also set the
  // coarse `phase`. A 30s heartbeat fills the quiet stretches (render, slow brain
  // calls) so the server/dashboard see steady movement and a job never "feels
  // stopped". renderMedia is async (doesn't block the loop) so the timer fires.
  let phase = "";
  let progressAt = Date.now();
  let jobStartedAt = Date.now();
  const emitProgress = (jobId: string, line: string) => {
    progressAt = Date.now();
    client.publish(TOPICS.progress(jobId), JSON.stringify({ at: now(), line }), { qos: 0 });
  };
  const progress = (jobId: string, line: string) => { phase = line.slice(0, 90); emitProgress(jobId, line); };
  const result = (r: JobResult) => client.publish(TOPICS.result(r.jobId), JSON.stringify(r), { qos: 1 });

  setInterval(() => {
    if (!current || !client.connected) return;
    if (Date.now() - progressAt < 25_000) return; // real progress already flowing
    const elapsed = Math.round((Date.now() - jobStartedAt) / 1000);
    emitProgress(current, `⏳ still working${phase ? " — " + phase : ""} (${elapsed}s elapsed)`);
  }, 30_000);

  client.on("connect", () => {
    log(`connected to ${url} — caps: ${caps.join(", ")} · ${profile.arch}/${profile.ramGb}GB/${profile.gpu}`);
    presence("idle");
    // direct dispatch from the central scheduler (capability-routed) + the shared
    // queue (used by `content dispatch` and any unrouted publisher).
    client.subscribe([TOPICS.device(deviceId), TOPICS.jobsShared], { qos: 1 }, (err) => log(err ? `subscribe failed: ${err.message}` : "subscribed (direct + shared)"));
  });
  client.on("reconnect", () => log("reconnecting…"));
  client.on("error", (e) => log(`mqtt error: ${e.message}`));

  client.on("message", (_topic, payload) => {
    // Zero-trust intake: every inbound message is treated as hostile. Strict
    // schema-bounding always; signature + target + TTL + nonce when a job-signing
    // key is pinned (cloud-paired). See job-verify.ts / HYBRID-ARCHITECTURE §4.
    let raw: unknown;
    try {
      raw = JSON.parse(payload.toString());
    } catch {
      return log("dropped malformed job (bad JSON)");
    }
    const v = verifyInboundJob(raw, deviceId);
    if (!v.ok) return log(`rejected job: ${v.reason}`);
    queue.push(v.job);
    log(`queued ${v.job.id} (${v.job.type}) — ${queue.length} pending`);
    void drain();
  });

  async function drain() {
    if (draining) return;
    draining = true;
    while (queue.length) {
      const job = queue.shift()!;
      current = job.id;
      jobStartedAt = Date.now();
      phase = "";
      presence("busy");
      result({ jobId: job.id, device: deviceId, status: "ack", at: now() });
      progress(job.id, `▶ picked up on ${deviceId} — ${job.type}${job.channel ? " · " + job.channel : ""}`);
      try {
        const itemId = await runJob(job);
        // Surface non-fatal render degradations (caption/voice/music fallbacks)
        // on the terminal result + a closing progress line, so a "done" job that
        // quietly degraded is still reported as such — not a clean success.
        const warnings = itemId ? readItemWarnings(itemId) : undefined;
        if (warnings?.length) progress(job.id, `⚠ done with ${warnings.length} warning(s): ${warnings.map((w) => w.message).join(" · ").slice(0, 200)}`);
        result({ jobId: job.id, device: deviceId, status: "done", itemId, ...(warnings?.length ? { warnings } : {}), at: now() });
        log(`done ${job.id}${itemId ? ` → ${itemId}` : ""}${warnings?.length ? ` (${warnings.length} warning(s))` : ""}`);
      } catch (e: any) {
        result({ jobId: job.id, device: deviceId, status: "error", message: String(e?.message ?? e), at: now() });
        log(`error ${job.id}: ${e?.message ?? e}`);
      }
      current = null;
      presence("idle");
    }
    draining = false;
  }

  async function runJob(job: Job): Promise<string | undefined> {
    const onLog = (m: string) => progress(job.id, m);
    if (job.type === "ping") {
      onLog("pong");
      return undefined;
    }
    if (job.type === "render") return finalizeDraft(job, onLog);
    const channel = job.channel || "labrinox";
    let itemId: string | undefined;
    if (job.type === "auto") {
      // High-consequence safety gate: a job's public:true posts to the user's REAL
      // social accounts. The cloud can REQUEST public, but only a LOCAL device-side
      // opt-in can grant it — a compromised cloud can never post under the user's
      // identity. (SOCHELI_ALLOW_AUTO_PUBLIC=1 or ~/.socheli/auto-public.)
      const allowPublic = !!job.public && localPublicOptIn();
      if (job.public && !allowPublic) onLog("⚠ public posting requested but not locally opted in → kept private");
      const { item } = await autopilot(channel, { seed: job.seed, voice: job.voice, public: allowPublic, publish: true, onLog });
      itemId = item.id;
    } else if (job.type === "longform") {
      // 16:9 multi-chapter YouTube video — seed carries the topic.
      const item = await generateLongform(job.seed ?? "", channel, { mood: job.mood, onLog });
      itemId = item.id;
    } else {
      const item = await generate(job.seed ?? "", channel, { voice: job.voice, mood: job.mood, aspect: job.aspect, width: job.width, height: job.height, research: job.research, onLog });
      itemId = item.id;
    }
    // push the freshly-rendered data/ up to the server (control done, data follows)
    onLog("syncing renders → server…");
    await runSync(onLog);
    return itemId;
  }

  /* Finalize + render a draft built on the control plane. The draft doesn't live
     on this device, so write the carried payload locally, then spawn rerender.ts
     (media + render, no LLM) and stream its output as live progress. */
  async function finalizeDraft(job: Job, onLog: (m: string) => void): Promise<string | undefined> {
    const id = job.itemId;
    if (!id) throw new Error("render job missing itemId");
    if (job.item) {
      mkdirSync(join(REPO, "data", "runs"), { recursive: true });
      writeFileSync(join(REPO, "data", "runs", `${id}.json`), JSON.stringify(job.item));
      onLog(`received draft ${id} — finalizing on ${deviceId}`);
    }
    // capture the child's FULL stdout/stderr to a per-render log on the device —
    // job progress in jobs.json is trimmed (MAX_PROGRESS), so when media falls back
    // (music → procedural bed, whisper → 0 words) the real error is only here.
    const logDir = join(REPO, "data", "logs");
    mkdirSync(logDir, { recursive: true });
    const logPath = join(logDir, `render-${id}.log`);
    // Header carries NO execPath/PATH — both leak /Users/<name>/… home paths and
    // this log is rsynced to the server.
    writeFileSync(logPath, `[render ${id} @ ${now()}]\n\n`);
    await new Promise<void>((resolve, reject) => {
      // use this agent's own node (process.execPath) — under launchd, bare "node"
      // isn't on PATH (ENOENT). cwd=REPO so rerender resolves data/ + render dirs.
      // Least-privilege env: only PATH/HOME + media/render keys — never the publish
      // tokens, broker creds, or SSH paths a render child has no need for.
      const child = spawn(process.execPath, ["--import", "tsx", join(HERE, "rerender.ts"), id, "--voice", "--music", "--broll"], { cwd: REPO, env: minimalRenderEnv() });
      const pipe = (b: Buffer) => {
        const s = String(b);
        try { appendFileSync(logPath, s); } catch {}
        s.split("\n").map((l) => l.trim()).filter(Boolean).forEach((l) => onLog(l));
      };
      child.stdout.on("data", pipe);
      child.stderr.on("data", pipe);
      child.on("error", reject);
      child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`rerender exited ${code}`))));
    });
    onLog("syncing render → server…");
    await runSync(onLog);
    return id;
  }

  const shutdown = () => {
    log("shutting down");
    presence("offline");
    client.end(false, {}, () => process.exit(0));
    setTimeout(() => process.exit(0), 1500);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
