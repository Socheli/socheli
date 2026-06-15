import { existsSync, readFileSync, writeFileSync, renameSync, unlinkSync, statSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
  Mission,
  MissionTask,
  systemContext,
  type Tenanted,
} from "@os/schemas";
import { DATA_DIR, ensureDir, nowIso, listItems } from "./store.ts";
import { resolveChannel } from "./channels.ts";
import { genomeContextSafe } from "./dna.ts";
import { runAgentTask } from "./harness/run.ts";
import { ROLE_PRESETS } from "./harness/roles.ts";
import type { AgentRole } from "./harness/types.ts";

/* Missions — the orchestrator (docs/AGENT-HARNESS.md §4).

   A mission is a STANDING goal for a channel ("grow IG to 10k with daily
   premium reels") that the system advances on a cadence: the autonomous
   social-media-manager loop. Each cadence loop (research/plan/generate/
   analyze/evolve) enqueues a MissionTask when due, and the scheduler's tick
   executes AT MOST ONE queued task per tick via the §3 harness
   (runAgentTask) — renders and agents stay serial on the device.

   Safety posture (per spec + HYBRID-ARCHITECTURE):
   - publish stays GATED: generate tasks run with publish_* stripped from the
     agent's tool allowlist AND an explicit do-not-publish instruction, so an
     autonomous creative can never jump the human publish gate.
   - DNA mutations route through dna_evolve's own policy (auto|gate), PINNED to
     the mission's approvalPolicy.dnaMutations (default 'gate'): the evolve loop
     tells the agent the exact policy value it must pass and never invites it to
     choose 'auto'. NOTE: this is instruction-level; for a hard server-side gate,
     dna_evolve in tools/dna-tools.ts should clamp policy to 'gate' when the
     caller is an autonomous agent (e.g. an env flag like SOCHELI_AGENT=1 set on
     the harness-spawned worker) — see the harness-tools owner.
   - budget.usdPerDay is enforced mission-wide per calendar day; tasks that
     would exceed it wait in the queue (budget resets at midnight).

   Imports note: pulling harness/run.ts (→ router → runtimes → registry) from
   here is cycle-safe by the same precedent as tools/harness-tools.ts — the
   registry only ever calls these bindings at run time, never during module
   evaluation. */

const MISSIONS_FILE = join(DATA_DIR, "missions.json");

/* ─── Cross-process tick lock ─────────────────────────────────────────────
   missionTick can be invoked from two places at once: the scheduler's 60s tick
   (which holds its OWN scheduler.lock) AND a detached `content mission tick`
   spawned by the mission_tick tool / dashboard. Without a dedicated lock those
   two would both pick up the same queued task and execute it twice = double
   spend. This is a SEPARATE lockfile from scheduler.lock (so the scheduler path
   also serializes through it) using the exact same pid+mtime-staleness reclaim
   primitive scheduler.ts uses — held only for the duration of one tick, so the
   scheduler's longer-lived scheduler.lock can never deadlock against it. */
const MISSIONS_LOCK = join(DATA_DIR, "missions.lock");
const MISSIONS_LOCK_STALE_MS = 1000 * 60 * 45; // a single mission task should never exceed this

function acquireMissionsLock(): boolean {
  if (existsSync(MISSIONS_LOCK)) {
    try {
      const { pid } = JSON.parse(readFileSync(MISSIONS_LOCK, "utf8")) as { pid: number };
      const fresh = Date.now() - statSync(MISSIONS_LOCK).mtimeMs < MISSIONS_LOCK_STALE_MS;
      let alive = false;
      try { process.kill(pid, 0); alive = true; } catch { alive = false; }
      if (fresh && alive) return false; // a tick is genuinely running
    } catch { /* corrupt lock → reclaim */ }
  }
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(MISSIONS_LOCK, JSON.stringify({ pid: process.pid, startedAt: nowIso() }));
  return true;
}

const releaseMissionsLock = () => {
  try { if (existsSync(MISSIONS_LOCK)) unlinkSync(MISSIONS_LOCK); } catch { /* ignore */ }
};

/* ─── Storage (atomic tmp + rename, same discipline as dna.ts) ───────────── */

function loadAll(): Mission[] {
  if (!existsSync(MISSIONS_FILE)) return [];
  try {
    return z.array(Mission).parse(JSON.parse(readFileSync(MISSIONS_FILE, "utf8")));
  } catch (e) {
    // Never silently clobber a corrupted missions store — queue history and
    // budget accounting live here. Surface the path so the operator can repair.
    throw new Error(
      `missions store invalid at ${MISSIONS_FILE}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

function saveAll(missions: Mission[]): void {
  ensureDir(DATA_DIR);
  const valid = z.array(Mission).parse(missions);
  const tmp = `${MISSIONS_FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify(valid, null, 2));
  renameSync(tmp, MISSIONS_FILE);
}

const newMissionId = () =>
  `mission_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

const newTaskId = (loop: MissionLoop) =>
  `${loop}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

/** Newest-first event log, capped at 200 per spec. */
function pushLog(m: Mission, event: string): void {
  m.log = [{ at: nowIso(), event }, ...m.log].slice(0, 200);
}

/* ─── The five loops ─────────────────────────────────────────────────────── */

export const MISSION_LOOPS = ["research", "plan", "generate", "analyze", "evolve"] as const;
export type MissionLoop = (typeof MISSION_LOOPS)[number];

/** Spec §4 role mapping: which worker persona runs each loop. */
export const LOOP_ROLES: Record<MissionLoop, AgentRole> = {
  research: "researcher",
  plan: "strategist",
  generate: "creative",
  analyze: "analyst",
  evolve: "analyst",
};

/** Task ids are `${loop}_…` so the loop survives queue round-trips. */
export function loopOfTask(taskId: string): MissionLoop | null {
  const head = taskId.split("_")[0] as MissionLoop;
  return (MISSION_LOOPS as readonly string[]).includes(head) ? head : null;
}

/* ─── Cadence parsing ──────────────────────────────────────────────────────
   Accepted forms: "hourly" | "daily" | "weekly" | "every N hours" |
   "every N days" | "every N weeks" (singular/plural, h/d/w shorthands).
   Returns the interval in ms, or null for an unparseable cadence. */

const HOUR_MS = 60 * 60 * 1000;

export function parseCadenceMs(cadence: string): number | null {
  const t = cadence.trim().toLowerCase();
  if (!t) return null;
  if (t === "hourly") return HOUR_MS;
  if (t === "daily") return 24 * HOUR_MS;
  if (t === "weekly") return 7 * 24 * HOUR_MS;
  const m = t.match(/^every\s+(\d+)\s*(hours?|hrs?|h|days?|d|weeks?|w)$/);
  if (!m) return null;
  const n = Number(m[1]);
  if (!n || n < 1) return null;
  const unit = m[2][0]; // h | d | w
  if (unit === "h") return n * HOUR_MS;
  if (unit === "d") return n * 24 * HOUR_MS;
  return n * 7 * 24 * HOUR_MS;
}

/* ─── CRUD ───────────────────────────────────────────────────────────────── */

export type CreateMissionInput = Tenanted & {
  channel: string;
  goal: string;
  cadence?: Partial<Record<MissionLoop, string>>;
  approvalPolicy?: { publish?: "auto" | "gate"; dnaMutations?: "auto" | "gate" };
  budget?: { usdPerDay?: number; postsPerDay?: number };
};

/** The full manager loop on sensible defaults when no cadence is given. */
const DEFAULT_CADENCE: Record<MissionLoop, string> = {
  research: "weekly",
  plan: "weekly",
  generate: "daily",
  analyze: "daily",
  evolve: "weekly",
};

export function createMission(input: CreateMissionInput): Mission {
  resolveChannel(input.channel); // throws loudly on an unknown channel id
  const cadence = input.cadence && Object.values(input.cadence).some(Boolean)
    ? input.cadence
    : DEFAULT_CADENCE;
  for (const [loop, c] of Object.entries(cadence)) {
    if (c && parseCadenceMs(c) === null) {
      throw new Error(
        `unparseable cadence for ${loop}: "${c}" (use "hourly", "daily", "weekly" or "every N hours|days|weeks")`,
      );
    }
  }
  const mission = Mission.parse({
    workspaceId: input.workspaceId,
    createdBy: input.createdBy,
    id: newMissionId(),
    channel: input.channel,
    goal: input.goal,
    status: "active",
    cadence,
    approvalPolicy: input.approvalPolicy ?? {},
    budget: input.budget ?? {},
    queue: [],
    log: [],
    state: {},
    createdAt: nowIso(),
    updatedAt: nowIso(),
  });
  pushLog(mission, `mission created: ${mission.goal}`);
  saveAll([...loadAll(), mission]);
  return mission;
}

export function listMissions(opts: { workspaceId?: string; status?: Mission["status"] } = {}): Mission[] {
  return loadAll().filter(
    (m) =>
      (!opts.status || m.status === opts.status) &&
      (!opts.workspaceId || (m.workspaceId ?? "ws_default") === opts.workspaceId),
  );
}

export function getMission(id: string): Mission {
  const m = loadAll().find((x) => x.id === id);
  if (!m) throw new Error(`mission not found: ${id}`);
  return m;
}

export type MissionPatch = Partial<
  Pick<Mission, "goal" | "cadence" | "approvalPolicy" | "budget" | "status">
>;

export function updateMission(id: string, patch: MissionPatch): Mission {
  const missions = loadAll();
  const i = missions.findIndex((x) => x.id === id);
  if (i < 0) throw new Error(`mission not found: ${id}`);
  // Validate cadence parseability the same way createMission does — an
  // unparseable cadence ("twice daily") silently disables that loop forever
  // (parseCadenceMs returns null → the loop never enqueues), so reject it at the
  // boundary instead of letting it slip through an update.
  if (patch.cadence) {
    for (const [loop, c] of Object.entries(patch.cadence)) {
      if (c && parseCadenceMs(c) === null) {
        throw new Error(
          `unparseable cadence for ${loop}: "${c}" (use "hourly", "daily", "weekly" or "every N hours|days|weeks")`,
        );
      }
    }
  }
  const merged = Mission.parse({
    ...missions[i],
    ...patch,
    // nested objects merge shallowly so a partial budget/cadence patch never
    // wipes the sibling fields
    cadence: { ...missions[i].cadence, ...(patch.cadence ?? {}) },
    approvalPolicy: { ...missions[i].approvalPolicy, ...(patch.approvalPolicy ?? {}) },
    budget: { ...missions[i].budget, ...(patch.budget ?? {}) },
    updatedAt: nowIso(),
  });
  pushLog(merged, `mission updated: ${Object.keys(patch).join(", ") || "noop"}`);
  missions[i] = merged;
  saveAll(missions);
  return merged;
}

export function pauseMission(id: string): Mission {
  return updateMission(id, { status: "paused" });
}

export function resumeMission(id: string): Mission {
  return updateMission(id, { status: "active" });
}

/* ─── Loop goals — concrete, channel-specific worker instructions ────────── */

const todayDate = () => nowIso().slice(0, 10);

/** Items already created today for a channel — the postsPerDay denominator. */
function itemsCreatedToday(channel: string): number {
  const today = todayDate();
  try {
    return listItems().filter((it) => it.channel === channel && (it.createdAt ?? "").slice(0, 10) === today).length;
  } catch {
    return 0;
  }
}

function channelMeta(channel: string): { name: string; platforms: string[]; domain: string } {
  try {
    const c = resolveChannel(channel);
    const platforms = (c.socials?.length ? c.socials : ["instagram", "youtube", "tiktok"]).map((p) =>
      p.toLowerCase(),
    );
    return { name: c.name, platforms, domain: c.domain ?? c.name };
  } catch {
    return { name: channel, platforms: ["instagram", "youtube", "tiktok"], domain: channel };
  }
}

/** The concrete prompt each loop hands its worker agent. Channel-specific and
 *  tool-directive: it names the exact registry tools the role should reach for. */
export function loopGoal(m: Mission, loop: MissionLoop): string {
  const { name, platforms, domain } = channelMeta(m.channel);
  const ch = `channel "${m.channel}" (${name})`;

  switch (loop) {
    case "research":
      return [
        `Refresh the research backing ${ch}. Platforms: ${platforms.join(", ")}.`,
        `For each platform, FIRST check the cache with research_fresh (kind "algo", query "<platform> algorithm ranking signals", maxAgeH 72) and only start a research_run for platforms whose cache is stale.`,
        `Then refresh trend research the same way: research_fresh (kind "trend", query "${domain} trends", maxAgeH 24) → research_run only if stale.`,
        `research_run is long-running — start each needed run ONCE and report the run ids; do not wait or re-fire.`,
        `Finish with: which runs were fresh vs newly started, the key verified findings so far, and 3-5 concrete content implications for this channel.`,
      ].join("\n");

    case "plan":
      return [
        `Refresh the dated content plan for ${ch}.`,
        `FIRST inspect what already exists: plan_list for the channel and plan_strategy — never double-book a date or duplicate a planned angle.`,
        `Then run plan_run for the channel (long-running — start it once and report the job) to research current ranking levers and fill the upcoming days with dated, platform-aware posts.`,
        `If existing planned posts conflict or look stale against the genome and fresh research, fix them surgically with plan_update / plan_move / plan_archive instead of duplicating.`,
        `Deliver: what the plan now covers, what you changed, and the rationale tying choices to genome traits and research.`,
      ].join("\n");

    case "generate": {
      const perDay = m.budget.postsPerDay;
      const made = itemsCreatedToday(m.channel);
      const cap = perDay
        ? `Budget: at most ${perDay} post(s) per day — ${made} already created today, so create at most ${Math.max(0, perDay - made)} now (if 0 remain, stop and report that today's quota is already met).`
        : `Create exactly ONE post this run.`;
      return [
        `Create today's (${todayDate()}) content for ${ch}.`,
        `FIRST call plan_day with today's date to find the planned post: if one exists, generate exactly that (honor its topic, angle, platform, format and mood) via pipeline_generate_post (long-running — start it once, report the job id, do not re-fire).`,
        `If nothing is planned today, build the strongest on-genome concept through the stepwise path instead: draft_ideas → draft_set_idea → draft_script → draft_storyboard → draft_render.`,
        cap,
        `ELEVATE THE CUT, don't ship a static template: once a post has a storyboard/render, run the creative editor on it — creative_edit_start (the full brief→concepts→EDL→passes→self-review loop, long-running: start it once and report the job + its log). For a generation still rendering in the background, note the item id so the edit can run on the finished cut. The goal is a creatively EDITED post, not a raw first render.`,
        `HARD RULE — publishing is human-gated for this mission: do NOT publish anything and do NOT call any publish_* tool. Leave the finished item rendered/packaged for human approval.`,
      ].join("\n");
    }

    case "analyze":
      return [
        `Close the learning loop for ${ch}.`,
        `Run analytics_ingest to pull fresh per-item analytics, then read analytics_scorecard for this channel (and analytics_all_scorecards for cross-channel context).`,
        `Separate signal from noise — one viral outlier is not a pattern. Look for repeated wins/losses across hooks, topics, formats and posting times.`,
        `Record durable patterns as reusable instructions via learnings_record_win / learnings_record_avoid (write them so a script writer could follow them).`,
        `Then close the EDITING loop too: for items with fresh analytics, call creative_learn_performance (channel + item id) so the brand's editing taste compounds from real performance — early drop-off teaches faster hooks, strong saves reinforce what worked. This is how the editor gets better per published video.`,
        `Deliver: what changed in the numbers since last time, what it means for this channel, exactly which learnings you recorded, and which editing-taste signals you learned.`,
      ].join("\n");

    case "evolve": {
      // Pin the dna_evolve policy to the mission's approvalPolicy.dnaMutations.
      // Default is the SAFE 'gate' when unset, mirroring evolveGenome's own
      // default — the autonomous analyst must never be invited to pick 'auto'.
      const policy: "auto" | "gate" = m.approvalPolicy.dnaMutations === "auto" ? "auto" : "gate";
      const policyLine =
        policy === "gate"
          ? `Mutations are approval-GATED for this mission. You MUST call dna_evolve with EXACTLY policy "gate" (never "auto") so EVERY proposed mutation is queued as pending for human approval — nothing may auto-apply. Do not call dna_mutation_approve yourself.`
          : `This mission allows autonomous evolution: call dna_evolve with EXACTLY policy "auto" so confident (>= 0.8) mutations on unlocked paths apply immediately and the rest queue as pending. Do not deviate from this policy value.`;
      return [
        `Evolve the Brand Genome of ${ch} from accumulated evidence.`,
        `Review the current genome (dna_get) and recent history (dna_history) first so you can report the delta afterwards.`,
        policyLine,
        `dna_evolve is long-running — start it once and report the job; then (or on a later check) summarize the proposals via dna_pending_list with their confidence and rationale.`,
        `Deliver: what evidence drove this evolution cycle and which mutations were applied vs queued.`,
      ].join("\n");
    }
  }
}

/** Context injected into every mission task: the standing goal + the channel's
 *  learned DNA (genomeContextSafe never throws — a corrupt genome degrades to
 *  goal-only context instead of stalling the mission). */
function missionContext(m: Mission): string {
  const genome = genomeContextSafe(m.channel);
  return [`MISSION (${m.id}) standing goal for channel "${m.channel}": ${m.goal}`, genome]
    .filter(Boolean)
    .join("\n\n");
}

/** Tool allowlist for a task. generate tasks get the creative preset with every
 *  publish_* pattern stripped — the approvalPolicy.publish gate enforced at the
 *  harness boundary, not just by instruction. Other loops use the role preset. */
function toolsForLoop(loop: MissionLoop, role: AgentRole): string[] | undefined {
  if (loop !== "generate") return undefined; // role preset applies
  return ROLE_PRESETS[role].tools.filter((p) => !p.toLowerCase().startsWith("publish"));
}

/* ─── Budget accounting ──────────────────────────────────────────────────── */

/** USD spent by this mission's tasks today (finishedAt — or startedAt for a
 *  task that died mid-flight — falling on the current calendar day). */
export function spentTodayUsd(m: Mission): number {
  const today = todayDate();
  return m.queue.reduce((sum, t) => {
    const day = (t.finishedAt ?? t.startedAt ?? "").slice(0, 10);
    return day === today ? sum + (t.usd ?? 0) : sum;
  }, 0);
}

/* ─── missionTick — what the scheduler calls every minute ────────────────── */

export type MissionTickOptions = {
  onLog?: (msg: string) => void;
  /** Compute + report due tasks without enqueueing or executing anything. */
  dry?: boolean;
  /** When false, enqueue due tasks but execute none (a render slot already
   *  claimed this tick's heavy-job budget). Default true. */
  execute?: boolean;
};

export type MissionTickResult = {
  /** Loop tasks that became due this tick (enqueued, or would-be under --dry). */
  due: { missionId: string; channel: string; loop: MissionLoop; role: AgentRole; goal: string }[];
  /** The one task executed this tick (absent when nothing ran). */
  executed?: {
    missionId: string;
    taskId: string;
    loop: MissionLoop | null;
    status: MissionTask["status"];
    usd: number;
    summary: string;
  };
  /** Tasks/missions passed over, with reasons (budget, postsPerDay…). */
  skipped: { missionId: string; taskId?: string; reason: string }[];
  /** Dry-run only: the queued task that WOULD execute next. */
  wouldExecute?: { missionId: string; taskId: string; loop: MissionLoop | null; role: string };
};

export async function missionTick(opts: MissionTickOptions = {}): Promise<MissionTickResult> {
  // Serialize every caller (scheduler tick + detached `content mission tick`)
  // through one cross-process lock so a queued task is never executed twice.
  // A dry run is a read-only computation and never executes — let it run without
  // the lock so dashboards can preview due work even while a tick is in flight.
  if (opts.dry) return missionTickInner(opts);
  const log = opts.onLog ?? (() => {});
  if (!acquireMissionsLock()) {
    log("another mission tick is running — skipping");
    return { due: [], skipped: [{ missionId: "*", reason: "mission tick already running (lock held)" }] };
  }
  try {
    return await missionTickInner(opts);
  } finally {
    releaseMissionsLock();
  }
}

async function missionTickInner(opts: MissionTickOptions = {}): Promise<MissionTickResult> {
  const log = opts.onLog ?? (() => {});
  const dry = !!opts.dry;
  const execute = opts.execute ?? true;
  const result: MissionTickResult = { due: [], skipped: [] };

  let missions: Mission[];
  try {
    missions = loadAll();
  } catch (e) {
    log(`missions store unreadable: ${e instanceof Error ? e.message : String(e)}`);
    throw e;
  }
  if (!missions.some((m) => m.status === "active")) return result;

  const now = Date.now();
  let dirty = false;

  /* 1) Enqueue due loop tasks: cadence interval vs state["lastRun.<loop>"]. */
  for (const m of missions) {
    if (m.status !== "active") continue;
    for (const loop of MISSION_LOOPS) {
      const cadence = m.cadence[loop];
      if (!cadence) continue;
      const interval = parseCadenceMs(cadence);
      if (interval === null) {
        result.skipped.push({ missionId: m.id, reason: `unparseable cadence for ${loop}: "${cadence}"` });
        continue;
      }
      const last = m.state[`lastRun.${loop}`];
      if (last && now - Date.parse(last) < interval) continue; // not due yet
      // one in-flight task per loop — never stack duplicates while one waits/runs
      if (m.queue.some((t) => t.status !== "done" && t.status !== "failed" && t.status !== "skipped" && loopOfTask(t.id) === loop)) continue;

      const role = LOOP_ROLES[loop];
      const goal = loopGoal(m, loop);
      result.due.push({ missionId: m.id, channel: m.channel, loop, role, goal });
      if (dry) continue;

      const task = MissionTask.parse({
        id: newTaskId(loop),
        role,
        goal,
        status: "queued",
        dueAt: nowIso(),
        usd: 0,
      });
      m.queue = [...m.queue, task].slice(-100); // keep the newest 100 per spec
      m.updatedAt = nowIso();
      pushLog(m, `enqueued ${loop} task ${task.id} (cadence ${cadence})`);
      dirty = true;
      log(`${m.id}: enqueued ${loop} (${cadence})`);
    }
  }
  if (dirty && !dry) saveAll(missions);

  /* 2) Execute AT MOST ONE queued task across all missions. */
  const firstQueued = (): { m: Mission; task: MissionTask } | null => {
    for (const m of missions) {
      if (m.status !== "active") continue;
      for (const task of m.queue) if (task.status === "queued") return { m, task };
    }
    return null;
  };

  if (dry) {
    const next = firstQueued();
    if (next) {
      result.wouldExecute = {
        missionId: next.m.id,
        taskId: next.task.id,
        loop: loopOfTask(next.task.id),
        role: next.task.role,
      };
    } else if (result.due.length) {
      // nothing queued yet — the first due task would be enqueued AND run
      const d = result.due[0];
      result.wouldExecute = { missionId: d.missionId, taskId: `(new ${d.loop} task)`, loop: d.loop, role: d.role };
    }
    return result;
  }
  if (!execute) {
    if (firstQueued()) log("execution deferred this tick (render slot fired)");
    return result;
  }

  outer: for (const m of missions) {
    if (m.status !== "active") continue;

    /* budget.usdPerDay — mission-wide, today's spend. Blocked tasks WAIT in
       the queue (budget resets at midnight) instead of being discarded; a
       blocked mission never shadows another mission's affordable work. */
    const spent = spentTodayUsd(m);
    if (m.budget.usdPerDay !== undefined && spent >= m.budget.usdPerDay) {
      const waiting = m.queue.filter((t) => t.status === "queued").length;
      if (waiting > 0) {
        const reason = `daily budget exhausted ($${spent.toFixed(2)} of $${m.budget.usdPerDay}) — ${waiting} task(s) wait`;
        result.skipped.push({ missionId: m.id, reason });
        log(`${m.id}: ${reason}`);
        // throttle the mission log: one entry per blocked stretch, not one per minute
        if (!m.log[0]?.event.startsWith("budget-blocked")) {
          pushLog(m, `budget-blocked: ${reason}`);
          saveAll(missions);
        }
      }
      continue;
    }

    for (const task of m.queue) {
      if (task.status !== "queued") continue;
      const loop = loopOfTask(task.id);

      /* budget.postsPerDay — generate-specific. Quota met counts as the loop
         having run today: mark the task skipped + stamp lastRun so the cadence
         doesn't re-enqueue until the next window. */
      if (loop === "generate" && m.budget.postsPerDay !== undefined) {
        const made = itemsCreatedToday(m.channel);
        if (made >= m.budget.postsPerDay) {
          task.status = "skipped";
          task.finishedAt = nowIso();
          task.resultSummary = `skipped: postsPerDay quota met (${made}/${m.budget.postsPerDay} today)`;
          m.state[`lastRun.${loop}`] = nowIso();
          m.updatedAt = nowIso();
          pushLog(m, `skipped ${task.id}: ${task.resultSummary}`);
          result.skipped.push({ missionId: m.id, taskId: task.id, reason: task.resultSummary });
          saveAll(missions);
          log(`${m.id}: ${task.resultSummary}`);
          continue; // skipping a quota'd task is free — keep looking for real work
        }
      }

      /* run it — the one heavy job of this tick */
      task.status = "running";
      task.startedAt = nowIso();
      m.updatedAt = nowIso();
      pushLog(m, `running ${task.id} (${task.role})`);
      saveAll(missions);
      log(`${m.id}: running ${task.id} (${task.role}, ${loop ?? "?"})`);

      const budgetLeft = m.budget.usdPerDay !== undefined ? Math.max(0.01, m.budget.usdPerDay - spent) : undefined;
      try {
        const r = await runAgentTask({
          id: task.id, // doubles as the agent task id → events at data/agent/<id>.jsonl
          role: task.role as AgentRole,
          goal: task.goal,
          context: missionContext(m),
          tenant: systemContext(m.workspaceId || undefined),
          budgetUsd: budgetLeft,
          tools: loop ? toolsForLoop(loop, task.role as AgentRole) : undefined,
        });
        task.status = "done";
        task.finishedAt = nowIso();
        task.usd = r.usd;
        task.resultSummary = r.summary.slice(0, 2000);
        pushLog(m, `done ${task.id} ($${r.usd.toFixed(4)}): ${r.summary.slice(0, 160)}`);
        log(`${m.id}: done ${task.id} ($${r.usd.toFixed(4)})`);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        task.status = "failed";
        task.finishedAt = nowIso();
        task.resultSummary = msg.slice(0, 2000);
        pushLog(m, `failed ${task.id}: ${msg.slice(0, 200)}`);
        log(`${m.id}: failed ${task.id}: ${msg}`);
      }
      // lastRun advances on completion EITHER way — a failing loop retries at
      // its next cadence window, never hot-loops every minute burning spend.
      if (loop) m.state[`lastRun.${loop}`] = nowIso();
      m.updatedAt = nowIso();
      saveAll(missions);
      result.executed = {
        missionId: m.id,
        taskId: task.id,
        loop,
        status: task.status,
        usd: task.usd ?? 0,
        summary: task.resultSummary ?? "",
      };
      break outer; // at most ONE executed task per tick
    }
  }

  return result;
}
