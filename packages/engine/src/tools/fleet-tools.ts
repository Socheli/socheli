import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import mqtt from "mqtt";

import { type PipelineTool, ok, fail, tool, asyncResult, DATA_DIR } from "./helpers.ts";
import { brokerConfig, TOPICS, newJobId } from "../fleet.ts";
import { parseProgress } from "../progress.ts";

/**
 * fleet-tools.ts — the render fleet's read + control surface, spread into the
 * canonical registry so the CLI / HTTP API / MCP / SDK / dashboard copilot (Soli)
 * all get it for free. This is how Soli answers "list my devices", "what's
 * rendering right now", "ping the M4".
 *
 * Data source: the bridge consolidates the MQTT control plane into
 * data/{fleet.json,jobs.json}. These tools READ those files (so they work
 * wherever the registry runs — notably the dashboard server, which hosts the
 * bridge), and fleet_ping WRITES one job onto the broker.
 */

const FLEET = join(DATA_DIR, "fleet.json");
const JOBS = join(DATA_DIR, "jobs.json");
const STALE_MS = 70_000; // no heartbeat in this long → treat as offline

function readJson<T>(p: string, fallback: T): T {
  try {
    return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as T) : fallback;
  } catch {
    return fallback;
  }
}

type Presence = { device: string; status: string; caps?: string[]; profile?: { arch: string; cpus: number; ramGb: number; gpu: string }; currentJob?: string | null; lastSeen: string };
type JobRow = { id: string; type: string; channel?: string; status: string; device?: string; itemId?: string; message?: string; progress: { at: string; line: string }[]; createdAt: string; updatedAt: string };

const ACTIVE = new Set(["running", "dispatched"]);

function devices(): Presence[] {
  const f = readJson<{ devices: Record<string, Presence> }>(FLEET, { devices: {} });
  const now = Date.now();
  return Object.values(f.devices ?? {})
    .map((d) => (now - new Date(d.lastSeen).getTime() > STALE_MS && d.status !== "offline" ? { ...d, status: "offline" } : d))
    .sort((a, b) => a.device.localeCompare(b.device));
}

function jobs(): JobRow[] {
  return readJson<{ jobs: JobRow[] }>(JOBS, { jobs: [] }).jobs ?? [];
}

export const fleetTools: PipelineTool[] = [
  tool({
    name: "fleet_devices",
    description:
      "List the render fleet: every device the control plane has seen, with its live status (busy/idle/offline), capabilities, hardware profile, the job it's currently running, and last-seen time. Use to answer 'list my devices' / 'what's online' / 'which device is rendering'. Read-only.",
    kind: "read",
    schema: z.object({}).describe("no input"),
    run: () => {
      const ds = devices();
      const online = ds.filter((d) => d.status !== "offline").length;
      return ok(
        {
          online,
          total: ds.length,
          devices: ds.map((d) => ({
            device: d.device,
            status: d.status,
            caps: d.caps ?? [],
            profile: d.profile ? `${d.profile.arch} · ${d.profile.ramGb}GB · ${d.profile.cpus} cores · ${d.profile.gpu}` : undefined,
            currentJob: d.currentJob ?? null,
            lastSeen: d.lastSeen,
          })),
        },
        ds.length ? `${online}/${ds.length} device(s) online` : "no devices have connected yet",
      );
    },
  }),

  tool({
    name: "fleet_jobs",
    description:
      "List render/generation jobs across the fleet with live progress: each job's type, status, the device running it, linked item, and a parsed PERCENT + phase (e.g. 'chapter 3/7 · 65%'). Use for 'what's rendering now', 'show current renders', 'how far along is the render'. Set active:true for only in-flight jobs. Read-only.",
    kind: "read",
    schema: z
      .object({
        active: z.boolean().optional().describe("only jobs that are running or dispatched (default false = recent too)"),
        device: z.string().optional().describe("filter to one device id"),
        limit: z.number().int().min(1).max(60).optional().describe("max jobs to return (default 20)"),
      })
      .describe("filters"),
    run: (input: { active?: boolean; device?: string; limit?: number }) => {
      let js = jobs();
      if (input.device) js = js.filter((j) => j.device === input.device);
      if (input.active) js = js.filter((j) => ACTIVE.has(j.status));
      const limit = input.limit ?? 20;
      const rows = js.slice(0, limit).map((j) => {
        const p = parseProgress((j.progress ?? []).map((x) => x.line), j.status);
        return {
          id: j.id,
          type: j.type,
          status: j.status,
          device: j.device ?? null,
          itemId: j.itemId ?? null,
          channel: j.channel ?? null,
          percent: p.pct,
          phase: p.label,
          message: j.message ?? null,
          updatedAt: j.updatedAt,
        };
      });
      const active = rows.filter((r) => ACTIVE.has(r.status));
      return ok({ jobs: rows, activeCount: active.length }, active.length ? `${active.length} job(s) in progress` : `${rows.length} recent job(s)`);
    },
  }),

  tool({
    name: "fleet_dispatch",
    description:
      "Generate a video ON the render fleet — publishes a real generate job to a worker and returns the job id to watch with fleet_jobs. type 'new' = a short vertical (9:16) post, 'longform' = a multi-chapter 16:9 YouTube video, 'auto' = engine picks. For a 'YouTube video' prefer type 'longform'. Pin the work to specific hardware with `device` (exact id) or `cap` (a capability or GPU kind, e.g. 'cuda' for the GPU render node) — use this to keep heavy renders off the laptop. `seed` is the idea/topic. To ground the video in verified research, set `research` ('deep' for the strongest): the worker runs a cited research pass on the seed FIRST, then generates from it — all in this one job, no need to call research_run separately (longform always researches internally). Returns jobId. After dispatching, ALWAYS call ui_render with a `progress` block keyed by that jobId (e.g. {type:'progress', label:'<type> · <seed>', value:0, jobId:'<jobId>'}) — that renders a LIVE bar in the chat that self-updates through research → render → done, so the user watches step-by-step progress without re-asking. Mutating — only call when the user asks to generate/render something.",
    kind: "mutate",
    schema: z
      .object({
        seed: z.string().min(2).describe("the idea/topic to generate, e.g. 'Coffee'"),
        type: z.enum(["new", "longform", "auto"]).optional().describe("new = 9:16 short (default); longform = 16:9 multi-chapter YouTube (pick this for a 'YouTube video'); auto = engine picks"),
        research: z.enum(["quick", "standard", "deep"]).optional().describe("run a cited research pass on the seed BEFORE generating, on the same worker (use 'deep' for 'after a deep research'). Applies to type 'new'; longform always researches internally."),
        channel: z.string().optional().describe("channel id (default 'labrinox')"),
        mood: z.string().optional().describe("optional mood preset id"),
        device: z.string().optional().describe("exact device id to run on (e.g. 'gpu-node-1')"),
        cap: z.string().optional().describe("route to an online device with this capability or GPU kind — 'cuda' = the GPU render node, 'metal' = the Mac, 'render', 'music:musicgen', etc."),
        public: z.boolean().optional().describe("publish publicly after render"),
      })
      .describe("what to generate and where"),
    run: (input: { seed: string; type?: "new" | "longform" | "auto"; research?: "quick" | "standard" | "deep"; channel?: string; mood?: string; device?: string; cap?: string; public?: boolean }) =>
      asyncResult(
        (async () => {
          const ds = devices();
          // Resolve a target device from an explicit id or a requested capability.
          let target = input.device;
          if (!target && input.cap) {
            const cap = input.cap.toLowerCase();
            const match = ds.find(
              (d) =>
                d.status !== "offline" &&
                ((d.caps ?? []).some((c) => c.toLowerCase() === cap || c.toLowerCase().startsWith(cap + ":")) || d.profile?.gpu?.toLowerCase() === cap),
            );
            if (!match) return fail(`no online device advertises '${input.cap}' — call fleet_devices to see what's available`);
            target = match.device;
          }
          if (target) {
            const d = ds.find((x) => x.device === target);
            if (!d) return fail(`unknown device '${target}' — call fleet_devices`);
            if (d.status === "offline") return fail(`device '${target}' is offline — call fleet_devices`);
          }
          const type = input.type ?? "new";
          const channel = input.channel ?? "labrinox";
          const { url, username, password } = brokerConfig();
          const job = {
            id: newJobId(),
            type,
            channel,
            seed: input.seed,
            ...(input.research ? { research: input.research } : {}),
            ...(input.mood ? { mood: input.mood } : {}),
            ...(input.public ? { public: true } : {}),
            ...(target ? { target } : {}),
            createdAt: new Date().toISOString(),
            by: "soli",
          };
          const topic = target ? TOPICS.device(target) : TOPICS.jobs;
          try {
            const c = await mqtt.connectAsync(url, { username, password });
            await c.publishAsync(topic, JSON.stringify(job), { qos: 1 });
            await c.endAsync();
            return ok(
              { jobId: job.id, type, channel, seed: input.seed, target: target ?? "shared queue" },
              `dispatched ${type} "${input.seed}" → ${target ?? "fleet"} (${job.id}) — track progress with fleet_jobs`,
            );
          } catch (e) {
            return fail(`broker unreachable: ${e instanceof Error ? e.message : String(e)}`);
          }
        })(),
      ),
  }),

  tool({
    name: "fleet_ping",
    description:
      "Ping the render fleet to check liveness — publishes a lightweight ping job to the broker that an online device acks. Optionally target one device. Returns the job id; follow up with fleet_jobs to see the ack. Use to verify a device is responsive.",
    kind: "mutate",
    schema: z
      .object({ device: z.string().optional().describe("device id to ping directly; omit to ping any online device via the shared queue") })
      .describe("optional target device"),
    run: (input: { device?: string }) =>
      asyncResult(
        (async () => {
          const { url, username, password } = brokerConfig();
          const job = { id: newJobId(), type: "ping", channel: "labrinox", createdAt: new Date().toISOString(), by: "tool" };
          const topic = input.device ? TOPICS.device(input.device) : TOPICS.jobs;
          try {
            const c = await mqtt.connectAsync(url, { username, password });
            await c.publishAsync(topic, JSON.stringify(job), { qos: 1 });
            await c.endAsync();
            return ok({ jobId: job.id, target: input.device ?? "shared queue" }, `ping dispatched (${job.id}) — call fleet_jobs to see the ack`);
          } catch (e) {
            return fail(`broker unreachable: ${e instanceof Error ? e.message : String(e)}`);
          }
        })(),
      ),
  }),
];
