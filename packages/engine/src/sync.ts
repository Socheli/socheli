import { spawn, spawnSync, execSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, unlinkSync, mkdirSync, openSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DATA_DIR } from "./store.ts";

/* The data-plane half of the fleet: control flows over MQTT (see fleet.ts /
   agent.ts), but the heavy rendered mp4s + run records flow up to the server by
   rsync. This module is the ONE place that runs that sync, used by:
     - the fleet device agent after each job (agent.ts)
     - the standalone `content sync` command (one-shot, from CLI / dashboard)
     - a launchd timer (com.socheli.sync) as the always-on safety net
       that catches renders made OUTSIDE the fleet (manual `content longform`,
       dev-mode dashboard generation, etc.). */

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..", "..");
const SYNC_SCRIPT = join(REPO, "scripts", "sync-to-server.sh");

const LABEL = "com.socheli.sync";
const PLIST_SRC = join(HERE, "..", "assets", `${LABEL}.plist`);
const PLIST_DEST = join(process.env.HOME ?? "", "Library", "LaunchAgents", `${LABEL}.plist`);
const LOG_FILE = join(DATA_DIR, "sync.log");

/* Run one rsync pass (data/ + final renders → server). Resolves the exit code;
   never rejects, so callers (agent loop, timer) keep going on a transient failure. */
export function runSync(onLog: (m: string) => void = (m) => console.log(m), args: string[] = []): Promise<number> {
  return new Promise((resolve) => {
    if (!existsSync(SYNC_SCRIPT)) {
      onLog(`sync script missing: ${SYNC_SCRIPT}`);
      return resolve(1);
    }
    const p = spawn("bash", [SYNC_SCRIPT, ...args], { cwd: REPO, env: process.env });
    p.stdout.on("data", (d) => onLog(String(d).trimEnd()));
    p.stderr.on("data", (d) => onLog(String(d).trimEnd()));
    p.on("close", (code) => {
      onLog(code === 0 ? "✓ sync complete" : `sync exited ${code}`);
      resolve(code ?? 1);
    });
    p.on("error", (e) => { onLog(`sync failed: ${e.message}`); resolve(1); });
  });
}

/* Fire-and-forget sync after a render finishes. Runs DETACHED so generation
   returns immediately, and — crucially — in the render process's own context,
   which can read the external renders volume (a launchd timer can't, without
   Full Disk Access; see macOS TCC). Skipped:
     - when nothing rendered (no videoPath),
     - inside the fleet agent (it runs its own awaited sync — avoid double),
     - when SOCHELI_NO_AUTOSYNC=1 (dev/preview opt-out). */
export function autoSyncAfterRender(item: { id: string; videoPath?: string }): void {
  if (!item.videoPath) return;
  autoSyncAfter("render");
}

/* Fire-and-forget detached up-sync after ANY important M4-side event (publish,
   DNA evolution, re-render, brand edit…). Pushes M4-authoritative data/ up so the
   online dashboard reflects it within seconds instead of waiting for the launchd
   timer. SERVER-OWNED state (concepts/plan/calendar — see sync-to-server.sh) is
   still pulled down + excluded from the push, so this never clobbers human gate
   decisions. Skipped inside the fleet agent (it runs its own awaited sync) and
   when SOCHELI_NO_AUTOSYNC=1 (dev/preview opt-out). */
export function autoSyncAfter(reason: string): void {
  if (process.env.SOCHELI_NO_AUTOSYNC === "1") return;
  if (process.env.SOCHELI_IN_AGENT === "1") return;
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    const out = openSync(LOG_FILE, "a");
    writeFileSync(LOG_FILE, `\n— auto-sync after: ${reason} —\n`, { flag: "a" });
    const child = spawn(process.execPath, ["--import", "tsx", join(REPO, "packages", "engine", "src", "cli.ts"), "sync"], {
      cwd: REPO,
      env: process.env,
      detached: true,
      stdio: ["ignore", out, out],
    });
    child.unref();
  } catch { /* best-effort; the launchd timer is the backstop */ }
}

/* ── launchd LaunchAgent management (mirrors scheduler.ts) ─────────────────── */
function renderPlist(): string {
  return readFileSync(PLIST_SRC, "utf8").replaceAll("__NODE__", process.execPath).replaceAll("__REPO__", REPO);
}

export function installSync(): string {
  mkdirSync(dirname(PLIST_DEST), { recursive: true });
  writeFileSync(PLIST_DEST, renderPlist());
  const uid = process.getuid?.() ?? 501;
  // modern bootstrap, with the legacy load -w as a fallback
  let r = spawnSync("launchctl", ["bootstrap", `gui/${uid}`, PLIST_DEST], { encoding: "utf8" });
  if (r.status !== 0) r = spawnSync("launchctl", ["load", "-w", PLIST_DEST], { encoding: "utf8" });
  return `installed → ${PLIST_DEST}\n${(r.stdout || r.stderr || "loaded").trim()}`;
}

export function uninstallSync(): string {
  const uid = process.getuid?.() ?? 501;
  spawnSync("launchctl", ["bootout", `gui/${uid}/${LABEL}`], { encoding: "utf8" });
  spawnSync("launchctl", ["unload", "-w", PLIST_DEST], { encoding: "utf8" });
  try { if (existsSync(PLIST_DEST)) unlinkSync(PLIST_DEST); } catch { /* ignore */ }
  return `uninstalled ${LABEL}`;
}

export function syncStatus(): { installed: boolean; loaded: boolean; host: string; logTail: string } {
  const installed = existsSync(PLIST_DEST);
  let loaded = false;
  try {
    loaded = execSync(`launchctl list 2>/dev/null | grep ${LABEL} || true`, { encoding: "utf8" }).includes(LABEL);
  } catch { /* ignore */ }
  const host = process.env.SOCHELI_HOST || "(SOCHELI_HOST not set)";
  let logTail = "";
  if (existsSync(LOG_FILE)) logTail = readFileSync(LOG_FILE, "utf8").trim().split("\n").slice(-25).join("\n");
  return { installed, loaded, host, logTail };
}
