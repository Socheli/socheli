import { EventEmitter } from "node:events";
import { mkdirSync, readFileSync, existsSync } from "node:fs";
import { writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { REPO_ROOT } from "../data";
import type { TenantContext } from "@os/schemas";

/* In-process job manager for the Socheli agent queue / teams / workflows.

   The dashboard is a persistent Node server (not serverless), so we can keep a
   module-singleton registry of jobs in memory, run them as fire-and-forget async
   work, and stream their events over SSE via a per-job EventEmitter. Jobs are
   mirrored to data/agent/jobs.json (debounced) so the tree survives a restart
   (running jobs are reconciled to a terminal state on load).

   Jobs form a tree via parentId/rootId. Sub-agents and workflow steps are CHILD
   jobs. Recursion depth and total jobs per root are capped to prevent runaway
   spawning. */

export type JobKind = "agent" | "team" | "workflow" | "tool" | "subagent";

export type JobStatus = "queued" | "running" | "succeeded" | "failed" | "canceled";

export type JobEventType =
  | "token"
  | "tool_call"
  | "tool_result"
  | "log"
  | "spawn"
  | "status";

export type JobEvent = {
  t: number;
  /* Process-monotonic sequence number assigned on append. Used by clients to
     dedupe events reliably even when many tokens share a millisecond timestamp. */
  seq?: number;
  type: JobEventType;
  // token
  text?: string;
  // tool_call / tool_result
  id?: string;
  name?: string;
  args?: unknown;
  ok?: boolean;
  result?: unknown;
  // spawn
  childId?: string;
  role?: string;
  // status
  status?: JobStatus;
  // log
  message?: string;
  [k: string]: unknown;
};

export type Job = {
  id: string;
  kind: JobKind;
  title: string;
  status: JobStatus;
  parentId?: string;
  rootId: string;
  depth: number;
  prompt?: string;
  input?: unknown;
  model?: string;
  /* The tenant the job runs as — pinned at creation so every tool the job (and
     its sub-agents) calls is scoped to this workspace and gated by this role.
     Persisted so a job's children inherit the right tenant across a restart. */
  tenant?: TenantContext;
  events: JobEvent[];
  result?: string;
  error?: string;
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
};

/* Persisted shape excludes the live AbortController. */
type StoredJob = Omit<Job, never>;

export const MAX_DEPTH = 3;
export const MAX_JOBS_PER_ROOT = 24;

const DATA_DIR = join(REPO_ROOT, "data", "agent");
const STORE_PATH = join(DATA_DIR, "jobs.json");
const SAVE_DEBOUNCE_MS = 400;
const MAX_EVENTS_PER_JOB = 4000;

/* Module-singleton state. Survives across requests within one server process. */
const jobs = new Map<string, Job>();
const emitters = new Map<string, EventEmitter>();
const controllers = new Map<string, AbortController>();
/* Roots that have been canceled. Consulted by createJob so a tree that is still
   actively spawning (lazy team/workflow children) cannot mint new, un-aborted
   children after the user cancels the root. */
const canceledRoots = new Set<string>();

let loaded = false;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let saving = false;
let saveDirty = false;
let eventSeq = 0;

/* True if this job's tree has been canceled (or the root is in a terminal state),
   meaning no new children should spawn. */
export function isRootCanceled(rootId: string): boolean {
  if (canceledRoots.has(rootId)) return true;
  const root = jobs.get(rootId);
  return !!root && (root.status === "canceled" || root.status === "failed");
}

function emitterFor(id: string): EventEmitter {
  let e = emitters.get(id);
  if (!e) {
    e = new EventEmitter();
    e.setMaxListeners(0);
    emitters.set(id, e);
  }
  return e;
}

/* ---- persistence ------------------------------------------------------- */

function load(): void {
  if (loaded) return;
  loaded = true;
  try {
    if (!existsSync(STORE_PATH)) return;
    const raw = readFileSync(STORE_PATH, "utf8");
    const arr = JSON.parse(raw) as StoredJob[];
    if (!Array.isArray(arr)) return;
    for (const j of arr) {
      // A job that was mid-flight when the process died can never resume; mark it
      // failed so the tree shows a terminal, honest state.
      if (j.status === "running" || j.status === "queued") {
        j.status = "failed";
        j.error = j.error || "interrupted by server restart";
        j.endedAt = j.endedAt || Date.now();
      }
      for (const e of j.events) if (typeof e.seq === "number" && e.seq > eventSeq) eventSeq = e.seq;
      jobs.set(j.id, j);
    }
  } catch {
    /* corrupt or unreadable store — start fresh, don't crash import */
  }
}

function scheduleSave(): void {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    void save();
  }, SAVE_DEBOUNCE_MS);
}

/* Serialize the store async + atomically (temp file + rename) so a crash mid-write
   can't corrupt jobs.json. 'token' events are kept only in memory (they dominate
   the event arrays and are not needed across a restart), keeping the persisted
   blob small. Concurrent saves are coalesced via a dirty flag. */
async function save(): Promise<void> {
  if (saving) {
    saveDirty = true;
    return;
  }
  saving = true;
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    const arr = [...jobs.values()].map((j) =>
      j.events.length ? { ...j, events: j.events.filter((e) => e.type !== "token") } : j,
    );
    const tmp = `${STORE_PATH}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(arr), "utf8");
    await rename(tmp, STORE_PATH);
  } catch {
    /* best-effort persistence; never throw on save */
  } finally {
    saving = false;
    if (saveDirty) {
      saveDirty = false;
      scheduleSave();
    }
  }
}

/* Ensure the store is loaded before any read/write. */
function ensureLoaded(): void {
  if (!loaded) load();
}

// Load eagerly on first import.
ensureLoaded();

/* ---- creation / queries ------------------------------------------------ */

export type CreateJobInput = {
  kind: JobKind;
  title: string;
  parentId?: string;
  prompt?: string;
  input?: unknown;
  model?: string;
  status?: JobStatus;
  tenant?: TenantContext;
};

export function createJob(partial: CreateJobInput): Job {
  ensureLoaded();
  const id = randomUUID();

  let rootId: string = id;
  let depth = 0;
  // A child inherits its parent's tenant unless explicitly overridden, so a whole
  // task tree always runs in one workspace under one role.
  let tenant = partial.tenant;
  if (partial.parentId) {
    const parent = jobs.get(partial.parentId);
    if (!parent) throw new Error(`parent job not found: ${partial.parentId}`);
    rootId = parent.rootId;
    depth = parent.depth + 1;
    if (!tenant) tenant = parent.tenant;
    if (depth > MAX_DEPTH) {
      throw new Error(`max recursion depth (${MAX_DEPTH}) exceeded`);
    }
    const count = countJobsForRoot(rootId);
    if (count >= MAX_JOBS_PER_ROOT) {
      throw new Error(`max jobs per root (${MAX_JOBS_PER_ROOT}) exceeded`);
    }
    // A canceled/terminal root must not spawn new children, even if an in-flight
    // team_run/workflow_run tries to lazily mint one after cancel().
    if (isRootCanceled(rootId)) {
      throw new Error(`root job canceled; not spawning new children`);
    }
  }

  const job: Job = {
    id,
    kind: partial.kind,
    title: partial.title,
    status: partial.status ?? "queued",
    parentId: partial.parentId,
    rootId,
    depth,
    prompt: partial.prompt,
    input: partial.input,
    model: partial.model,
    tenant,
    events: [],
    createdAt: Date.now(),
  };
  jobs.set(id, job);
  controllers.set(id, new AbortController());
  scheduleSave();
  return job;
}

function countJobsForRoot(rootId: string): number {
  let n = 0;
  for (const j of jobs.values()) if (j.rootId === rootId) n++;
  return n;
}

export function getJob(id: string): Job | undefined {
  ensureLoaded();
  return jobs.get(id);
}

export function listJobs(): Job[] {
  ensureLoaded();
  return [...jobs.values()].sort((a, b) => b.createdAt - a.createdAt);
}

/* All jobs in one tree (root + descendants), oldest-first for stable rendering. */
export function jobTree(rootId: string): Job[] {
  ensureLoaded();
  return [...jobs.values()]
    .filter((j) => j.rootId === rootId)
    .sort((a, b) => a.createdAt - b.createdAt);
}

/* Distinct root jobs, newest-first — for listing the queue at the top level. */
export function listRoots(): Job[] {
  ensureLoaded();
  return [...jobs.values()]
    .filter((j) => j.id === j.rootId)
    .sort((a, b) => b.createdAt - a.createdAt);
}

/* ---- mutation ---------------------------------------------------------- */

export function appendEvent(id: string, ev: Omit<JobEvent, "t"> & { t?: number }): JobEvent | undefined {
  const job = jobs.get(id);
  if (!job) return undefined;
  const full: JobEvent = { t: ev.t ?? Date.now(), seq: ++eventSeq, ...ev } as JobEvent;
  job.events.push(full);
  // Bound memory: keep the most recent events if a job goes very long.
  if (job.events.length > MAX_EVENTS_PER_JOB) {
    job.events.splice(0, job.events.length - MAX_EVENTS_PER_JOB);
  }
  emitterFor(id).emit("event", full);
  scheduleSave();
  return full;
}

export function setStatus(
  id: string,
  status: JobStatus,
  extra?: { result?: string; error?: string },
): Job | undefined {
  const job = jobs.get(id);
  if (!job) return undefined;
  job.status = status;
  if (status === "running" && !job.startedAt) job.startedAt = Date.now();
  if (status === "succeeded" || status === "failed" || status === "canceled") {
    job.endedAt = job.endedAt ?? Date.now();
    // Free the AbortController once a job is terminal so the Map doesn't grow
    // for the life of the process.
    controllers.delete(id);
  }
  if (extra?.result !== undefined) job.result = extra.result;
  if (extra?.error !== undefined) job.error = extra.error;
  appendEvent(id, { type: "status", status });
  scheduleSave();
  return job;
}

/* The live AbortSignal a runner should pass into streamAgent / runTool. */
export function jobSignal(id: string): AbortSignal | undefined {
  return controllers.get(id)?.signal;
}

export function cancel(id: string): Job | undefined {
  const job = jobs.get(id);
  if (!job) return undefined;
  // Mark the whole tree as canceled FIRST so createJob() refuses to mint any new
  // children for work that is still actively spawning (in-flight team/workflow).
  canceledRoots.add(job.rootId);
  // Abort the running work and propagate to any in-flight children.
  controllers.get(id)?.abort();
  for (const child of jobs.values()) {
    if (child.rootId === job.rootId && child.id !== id) {
      if (child.status === "running" || child.status === "queued") {
        controllers.get(child.id)?.abort();
        child.status = "canceled";
        child.endedAt = child.endedAt ?? Date.now();
      }
    }
  }
  if (job.status === "running" || job.status === "queued") {
    setStatus(id, "canceled");
  }
  scheduleSave();
  return job;
}

/* ---- SSE subscription -------------------------------------------------- */

export type JobSubCallback = (ev: JobEvent) => void;

export function subscribe(id: string, cb: JobSubCallback): () => void {
  const e = emitterFor(id);
  e.on("event", cb);
  return () => unsubscribe(id, cb);
}

export function unsubscribe(id: string, cb: JobSubCallback): void {
  emitters.get(id)?.off("event", cb);
}

/* Force a flush (useful in tests / shutdown). Awaits the async atomic write. */
export async function flush(): Promise<void> {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  await save();
}
