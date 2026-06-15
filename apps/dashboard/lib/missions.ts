import "server-only";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Mission, recordInWorkspace } from "@os/schemas";
import type { Mission as MissionT } from "@os/schemas";
import { REPO_ROOT } from "./data";

/* The dashboard's READ view of the missions store (data/missions.json) — the
   same file the engine orchestrator (packages/engine/src/missions.ts) owns.
   Reads happen here directly (validated against the shared Mission schema, the
   lib/brands.ts pattern); every MUTATION goes through the engine module via a
   tsx driver (lib/engine-run.ts) so the orchestrator's invariants (cadence
   validation, log/queue caps, atomic writes) are never re-implemented. */

const MISSIONS_FILE = join(REPO_ROOT, "data", "missions.json");

function loadAll(): MissionT[] {
  if (!existsSync(MISSIONS_FILE)) return [];
  try {
    const raw = JSON.parse(readFileSync(MISSIONS_FILE, "utf8"));
    if (!Array.isArray(raw)) return [];
    // Per-entry tolerant parse: one malformed record never hides the rest.
    return raw
      .map((m) => Mission.safeParse(m))
      .filter((p): p is { success: true; data: MissionT } => p.success)
      .map((p) => p.data);
  } catch {
    return [];
  }
}

export function listMissionsFor(workspaceId: string): MissionT[] {
  return loadAll()
    .filter((m) => recordInWorkspace(m, workspaceId))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function getMissionFor(id: string, workspaceId: string): MissionT | null {
  const m = loadAll().find((x) => x.id === id);
  return m && recordInWorkspace(m, workspaceId) ? m : null;
}

/* USD spent by a mission's tasks today — mirror of the engine's budget
   accounting (missions.ts spentTodayUsd): finishedAt — or startedAt for a task
   that died mid-flight — falling on the current calendar day. */
export function spentTodayUsd(m: MissionT): number {
  const today = new Date().toISOString().slice(0, 10);
  return m.queue.reduce((sum, t) => {
    const day = (t.finishedAt ?? t.startedAt ?? "").slice(0, 10);
    return day === today ? sum + (t.usd ?? 0) : sum;
  }, 0);
}

/* Where a mission task's live agent events stream — mission task ids double as
   harness agent-task ids (engine harness/run.ts agentTaskLogPath). */
export function agentTaskLogPath(taskId: string): string {
  return join(REPO_ROOT, "data", "agent", `${taskId.replace(/[^a-zA-Z0-9_-]/g, "_")}.jsonl`);
}

/* ── Engine bridge for mutations ──────────────────────────────────────────
   Same shape as lib/dna.ts runDnaTool: the dashboard must NOT bundle the
   engine (node-only, tsx-run), so mutations spawn the canonical tool runner:
     node --import tsx packages/engine/src/tool.ts mission_create '{…}'
   The engine keeps every invariant; routes only add tenancy gating. */

export type ToolResult = { ok: boolean; data?: Record<string, unknown>; message?: string };

const MISSION_TOOLS = new Set([
  "mission_create",
  "mission_update",
  "mission_pause",
  "mission_resume",
  "mission_tick",
]);

export function runMissionTool(name: string, input: Record<string, unknown>): Promise<ToolResult> {
  if (!MISSION_TOOLS.has(name)) {
    return Promise.resolve({ ok: false, message: `not a mission tool: ${name}` });
  }
  const runner = join(REPO_ROOT, "packages", "engine", "src", "tool.ts");
  return new Promise((resolve) => {
    const child = spawn("node", ["--import", "tsx", runner, name, JSON.stringify(input)], {
      cwd: REPO_ROOT,
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", (e) => resolve({ ok: false, message: String(e) }));
    child.on("close", () => {
      // The runner prints a ToolResult on stdout even on failure (exit code
      // mirrors result.ok) — parse it regardless; fall back to stderr only
      // when stdout isn't valid JSON (e.g. tsx itself failed to boot).
      try {
        resolve(JSON.parse(stdout.trim()) as ToolResult);
      } catch {
        resolve({ ok: false, message: (stderr || stdout).trim().slice(0, 2000) || "engine produced no output" });
      }
    });
  });
}
