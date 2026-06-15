import { spawnSync, execSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, unlinkSync, statSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { autopilot } from "./autopilot.ts";
import { publishItem, platformStatus } from "./publisher.ts";
import { loadItem, saveItem, DATA_DIR } from "./store.ts";
import { loadSchedule, saveSchedule, dueSlots, dueOneOffs, markFired, markOneOffFired, nextDue } from "./schedule.ts";
import { proxyReachable } from "./http.ts";
import { missionTick } from "./missions.ts";
import { listConnections, refreshConnection } from "./connections.ts";
import type { Schedule } from "@os/schemas";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..", "..");
const LOCK = join(DATA_DIR, "scheduler.lock");
const LOCK_STALE_MS = 1000 * 60 * 45; // a generation+publish should never exceed this
const REFRESH_MARKER = join(DATA_DIR, ".connection-refresh-day"); // gitignored daily guard
const LABEL = "com.socheli.scheduler";
const PLIST_SRC = join(HERE, "..", "assets", `${LABEL}.plist`);
const PLIST_DEST = join(process.env.HOME ?? "", "Library", "LaunchAgents", `${LABEL}.plist`);

/* ── lockfile: a 1-minute launchd interval must never overlap a minutes-long
   generation. Holds pid+startedAt; reclaimed if stale or the pid is dead. ── */
function acquireLock(): boolean {
  if (existsSync(LOCK)) {
    try {
      const { pid } = JSON.parse(readFileSync(LOCK, "utf8")) as { pid: number };
      const fresh = Date.now() - statSync(LOCK).mtimeMs < LOCK_STALE_MS;
      let alive = false;
      try { process.kill(pid, 0); alive = true; } catch { alive = false; }
      if (fresh && alive) return false; // a tick is genuinely running
    } catch { /* corrupt lock → reclaim */ }
  }
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(LOCK, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
  return true;
}
const releaseLock = () => { try { if (existsSync(LOCK)) unlinkSync(LOCK); } catch { /* ignore */ } };

/* ── connection token refresh sweep (Meta long-lived tokens expire in ~60 days;
   Instagram-Login IG-user tokens also expire in 60 days and must be refreshed
   via graph.instagram.com/refresh_access_token — refreshConnection branches on
   the connection's authType internally, so this sweep covers BOTH flavors).

   Runs at most once per day via a YYYY-MM-DD marker file (gitignored). The whole
   body is wrapped so a failure can NEVER wedge the 60s launchd tick, and it
   fails OPEN on a corrupt/unreadable marker (run the sweep rather than wedge).
   refreshConnection returns a redacted ConnectionView (never a token); we only
   touch connections whose view reports needsRefresh (expiry < 7 days). ── */
function refreshRanToday(): boolean {
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
  try {
    if (!existsSync(REFRESH_MARKER)) return false;
    return readFileSync(REFRESH_MARKER, "utf8").trim() === today;
  } catch {
    return false; // fail-OPEN: corrupt marker → allow the sweep to run
  }
}

async function refreshDueConnections(log: (m: string) => void): Promise<void> {
  try {
    if (refreshRanToday()) return; // already swept today
    const due = listConnections().filter((v) => v.needsRefresh === true);
    if (due.length) {
      log(`token refresh: ${due.length} connection(s) near expiry`);
      for (const v of due) {
        const r = await refreshConnection(v.channelId, v.workspaceId).catch(() => null);
        if (!r) log(`  ${v.channelId}: refresh threw — left as-is`);
        else if (r.ok) log(`  ${v.channelId}: refreshed${r.view.expiresInDays != null ? ` (+${r.view.expiresInDays}d)` : ""}`);
        else log(`  ${v.channelId}: ${r.reason}`);
      }
    }
    // Record the sweep for today regardless of per-connection outcome so a single
    // persistently-failing connection can't make us re-sweep every minute.
    try {
      mkdirSync(DATA_DIR, { recursive: true });
      writeFileSync(REFRESH_MARKER, new Date().toISOString().slice(0, 10));
    } catch { /* marker write failed → next tick retries; harmless */ }
  } catch (e: any) {
    log(`token refresh sweep failed: ${e?.message ?? e}`);
  }
}

/* One scheduler tick: launchd runs this every 60s and waits for it — this
   process IS the worker (no detach). Processes at most ONE due slot per tick
   (renders are CPU/RAM heavy), then marks it fired so a QA-fail doesn't retry
   all day. One-offs (explicit per-post schedules) publish an already-built item.
   After slot logic (same lock — missions never run concurrently with a render
   slot), missionTick() advances the §4 mission loops: it always enqueues due
   tasks, and executes one only when no slot fired this tick. */
export async function tick(opts: { onLog?: (m: string) => void } = {}): Promise<void> {
  const log = opts.onLog ?? ((m: string) => console.log(`[tick ${new Date().toISOString()}] ${m}`));
  const s = loadSchedule();

  if (!acquireLock()) return log("another tick is running — skipping");
  try {
    // Lightweight daily token-refresh sweep (FB-Login + IG-Login). Runs before
    // slot/mission work, independent of the one-heavy-job budget — the daily
    // marker means it does real work at most once/day and never throws.
    await refreshDueConnections(log);

    let fired = false;
    if (s.enabled) fired = await fireDueSlots(s, log);
    else log("schedule disabled — slots skipped");

    // Missions (docs/AGENT-HARNESS.md §4) — guarded so a broken missions store
    // can never break slot firing or wedge the launchd tick.
    try {
      await missionTick({ onLog: (m) => log(`mission: ${m}`), execute: !fired });
    } catch (e: any) {
      log(`missionTick failed: ${e?.message ?? e}`);
    }
  } finally {
    releaseLock();
  }
}

/* The pre-missions tick body, verbatim: one-offs first, then cadence slots.
   Returns true when a heavy job (publish/generate) ran this tick. */
async function fireDueSlots(s: Schedule, log: (m: string) => void): Promise<boolean> {
  const ps = platformStatus();
  log(`live: youtube=${ps.youtube} instagram=${ps.instagram} tiktok=${ps.tiktok} host=${ps.host} · proxy=${proxyReachable()}`);

  // explicit per-post schedules first
  for (const o of dueOneOffs(s)) {
    try {
      log(`one-off publish ${o.itemId}${o.public ? " (public)" : ""}`);
      const item = loadItem(o.itemId);
      const r = await publishItem(item, { public: o.public });
      saveItem(item);
      markOneOffFired(s, o.itemId);
      saveSchedule(s);
      for (const x of r) log(`  ${x.platform}: ${x.status}${x.url ? ` → ${x.url}` : ""}`);
    } catch (e: any) {
      log(`  one-off ${o.itemId} failed: ${e?.message ?? e}`);
      markOneOffFired(s, o.itemId);
      saveSchedule(s);
    }
    return true; // one heavy job per tick
  }

  // cadence slots
  const due = dueSlots(s);
  if (!due.length) {
    log("no slots due");
    return false;
  }
  const slot = due[0];
  log(`slot due ${slot.channel}@${slot.time}${slot.public ? " (public)" : ""}${slot.seed ? ` seed="${slot.seed}"` : " (auto-select)"}`);
  // CONTRACT (Calendar Admin): plan-driven posts only enter this lane once
  // approval?.status === 'approved' AND status === 'scheduled' — enforced at the
  // caladmin promotion boundary (calendar-admin.ts setApproval). If a future
  // change makes fireDueSlots read content-plan.json, it MUST filter
  // p.approval?.status === 'approved' before publishing.
  try {
    const { item, published, reason } = await autopilot(slot.channel, {
      seed: slot.seed,
      public: slot.public,
      publish: true,
      onLog: (m) => log(`  ${m}`),
    });
    const result = published ? published.map((p) => `${p.platform}:${p.status}`).join(" ") : reason ?? "no publish";
    markFired(s, slot.channel, slot.time, item.id, result);
    saveSchedule(s);
    log(`done ${item.id} — ${item.status} — ${result}`);
  } catch (e: any) {
    log(`slot ${slot.channel}@${slot.time} failed: ${e?.message ?? e}`);
    markFired(s, slot.channel, slot.time, undefined, `error: ${e?.message ?? e}`);
    saveSchedule(s);
  }
  return true;
}

/* ── launchd LaunchAgent management ──────────────────────────────────────── */
function renderPlist(): string {
  return readFileSync(PLIST_SRC, "utf8").replaceAll("__NODE__", process.execPath).replaceAll("__REPO__", REPO);
}

export function installAgent(): string {
  mkdirSync(dirname(PLIST_DEST), { recursive: true });
  writeFileSync(PLIST_DEST, renderPlist());
  const uid = process.getuid?.() ?? 501;
  // modern bootstrap, with the legacy load -w as a fallback
  let r = spawnSync("launchctl", ["bootstrap", `gui/${uid}`, PLIST_DEST], { encoding: "utf8" });
  if (r.status !== 0) r = spawnSync("launchctl", ["load", "-w", PLIST_DEST], { encoding: "utf8" });
  return `installed → ${PLIST_DEST}\n${(r.stdout || r.stderr || "loaded").trim()}`;
}

export function uninstallAgent(): string {
  const uid = process.getuid?.() ?? 501;
  spawnSync("launchctl", ["bootout", `gui/${uid}/${LABEL}`], { encoding: "utf8" });
  spawnSync("launchctl", ["unload", "-w", PLIST_DEST], { encoding: "utf8" });
  try { if (existsSync(PLIST_DEST)) unlinkSync(PLIST_DEST); } catch { /* ignore */ }
  return `uninstalled ${LABEL}`;
}

export function agentStatus(): { installed: boolean; loaded: boolean; nextDue: ReturnType<typeof nextDue>; logTail: string; platforms: ReturnType<typeof platformStatus> } {
  const installed = existsSync(PLIST_DEST);
  let loaded = false;
  try {
    loaded = execSync(`launchctl list 2>/dev/null | grep ${LABEL} || true`, { encoding: "utf8" }).includes(LABEL);
  } catch { /* ignore */ }
  const s = loadSchedule();
  const logFile = join(DATA_DIR, "scheduler.log");
  let logTail = "";
  if (existsSync(logFile)) {
    const lines = readFileSync(logFile, "utf8").trim().split("\n");
    logTail = lines.slice(-25).join("\n");
  }
  return { installed, loaded, nextDue: nextDue(s), logTail, platforms: platformStatus() };
}
