import mqtt from "mqtt";
import { brokerConfig, TOPICS, type Presence } from "./fleet.ts";
import { parseProgress } from "./progress.ts";

/* Consolidated live progress view across the whole fleet (`content jobs`).
   Subscribes to the MQTT control plane — retained presence gives every device +
   its current job instantly; progress/result streams give the live percent. This
   is the cross-device source of truth (the bridge consolidates the same streams
   into jobs.json for the dashboard; this is the terminal-side mirror). */

type JobState = { device: string; lines: string[]; status: "running" | "done" | "error" | "dispatched"; updatedAt: number };

const BAR_W = 22;
function bar(pct: number | null, indeterminate: boolean): string {
  if (pct === null) return indeterminate ? "[" + "·".repeat(BAR_W) + "]" : "[" + " ".repeat(BAR_W) + "]";
  const fill = Math.round((pct / 100) * BAR_W);
  return "[" + "█".repeat(fill) + "░".repeat(BAR_W - fill) + "]";
}
const pad = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s.padEnd(n));

export async function jobsView(opts: { watch: boolean; once?: boolean } = { watch: false }): Promise<void> {
  const { url, username, password } = brokerConfig();
  const devices = new Map<string, Presence>();
  const jobs = new Map<string, JobState>();
  const client = await mqtt.connectAsync(url, { username, password });

  const touchJob = (id: string, device: string) => {
    let j = jobs.get(id);
    if (!j) { j = { device, lines: [], status: "running", updatedAt: Date.now() }; jobs.set(id, j); }
    if (device) j.device = device;
    return j;
  };

  // Register the handler BEFORE subscribing — retained presence flushes the instant
  // the SUBACK lands, so a handler attached after subscribeAsync misses them (the
  // whole fleet would look empty until the next live heartbeat).
  client.on("message", (topic, payload) => {
    const text = payload.toString();
    try {
      if (topic.endsWith("/presence")) {
        const p = JSON.parse(text) as Presence;
        devices.set(p.device, p);
        if (p.currentJob) touchJob(p.currentJob, p.device);
      } else if (topic.endsWith("/progress")) {
        const id = topic.split("/")[2];
        const { line } = JSON.parse(text) as { line: string };
        const j = touchJob(id, "");
        j.lines.push(line);
        if (j.lines.length > 20) j.lines = j.lines.slice(-20);
        j.status = "running";
        j.updatedAt = Date.now();
      } else if (topic.endsWith("/result")) {
        const r = JSON.parse(text) as { jobId: string; device: string; status: string };
        const j = touchJob(r.jobId, r.device);
        if (r.status === "ack") j.status = "running";
        else if (r.status === "done") j.status = "done";
        else if (r.status === "error") j.status = "error";
        j.updatedAt = Date.now();
      }
    } catch { /* ignore malformed */ }
  });
  await client.subscribeAsync([TOPICS.presenceWild, TOPICS.progressWild, TOPICS.resultWild], { qos: 1 });

  const render = () => {
    const now = Date.now();
    const lines: string[] = [];
    const devs = [...devices.values()].sort((a, b) => a.device.localeCompare(b.device));
    lines.push(`Socheli fleet — ${devs.filter((d) => d.status !== "offline").length}/${devs.length} online · ${new Date().toISOString().slice(11, 19)}`);
    lines.push("─".repeat(72));
    if (!devs.length) lines.push("  (no devices seen yet — waiting for presence…)");
    for (const d of devs) {
      const dot = d.status === "busy" ? "●" : d.status === "idle" ? "○" : d.status === "offline" ? "×" : "•";
      lines.push(`${dot} ${pad(d.device, 10)} ${pad(d.status, 8)} ${d.profile ? `${d.profile.arch}/${d.profile.gpu}` : ""}`);
      const j = d.currentJob ? jobs.get(d.currentJob) : undefined;
      if (j && j.status !== "done" && j.status !== "error") {
        const p = parseProgress(j.lines, j.status);
        const pctStr = p.pct != null ? `${String(p.pct).padStart(3)}%` : " ···";
        lines.push(`    ${bar(p.pct, p.indeterminate)} ${pctStr}  ${pad(d.currentJob!, 16)} ${p.label}`);
      } else if (d.status === "busy") {
        lines.push(`    (working — no progress stream yet)`);
      }
    }
    // any active jobs whose device we haven't matched via presence.currentJob
    const orphan = [...jobs.entries()].filter(([id, j]) => j.status === "running" && now - j.updatedAt < 60_000 && ![...devices.values()].some((d) => d.currentJob === id));
    if (orphan.length) {
      lines.push("  · other active jobs:");
      for (const [id, j] of orphan) {
        const p = parseProgress(j.lines, j.status);
        lines.push(`    ${bar(p.pct, p.indeterminate)} ${p.pct != null ? `${p.pct}%` : "···"}  ${pad(id, 16)} ${p.label} @${j.device || "?"}`);
      }
    }
    return lines.join("\n");
  };

  if (!opts.watch) {
    // snapshot: collect retained presence + a beat of live progress, print once.
    await new Promise((r) => setTimeout(r, opts.once === false ? 0 : 3500));
    console.log(render());
    await client.endAsync();
    return;
  }

  // watch: repaint the screen on a steady tick until Ctrl-C.
  const paint = () => { process.stdout.write("\x1b[2J\x1b[H" + render() + "\n"); };
  const timer = setInterval(paint, 1000);
  paint();
  await new Promise<void>((resolve) => {
    const stop = () => { clearInterval(timer); client.end(false, {}, () => resolve()); };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  });
}
