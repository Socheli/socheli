"use client";
import { useCallback, useEffect, useMemo, useSyncExternalStore, type SetStateAction } from "react";
import type { UIBlock } from "../../lib/agent/ui-spec";
import { validateBlocks } from "../../lib/agent/ui-spec";
import type { GuideSpec } from "../../lib/agent/guide-spec";

/* Client-side conversation manager for the Socheli copilot.
   Owns the thread list (multi-conversation history), the per-turn tool-event
   timeline, streaming status, and the SSE plumbing against POST /api/agent.
   Robustly parses the "data: <json>\n\n" frames (buffering partial chunks),
   aborts via AbortController, and persists everything to localStorage.

   Conversations are THREADS now: [{id, title, createdAt, updatedAt, messages}]
   plus an activeThreadId. messages/send/stop/clear keep their old contract but
   operate on the active thread; clear() archives the current thread and starts
   a fresh one (history is kept). The legacy single-conversation store
   ("socheli.copilot.v1") is migrated into the first thread on load.

   The state lives in ONE module-level store shared by every useAgent
   consumer, so the Cmd+K panel and the /soli full page render the SAME
   transcript live (a stream started on one surface keeps flowing on the
   other — and keeps flowing into its own thread even if the user switches).
   Each consumer still supplies its own AgentContext per send.

   BACKEND SYNC (additive — localStorage stays the fast cache, keys unchanged):
   threads also persist server-side via /api/chats (data/chats/<ws>/<id>.json).
   On first hydrate we load local exactly as before, then pull the server's
   thread list and merge by id with the newer updatedAt winning; threads that
   exist only on the server arrive as metadata stubs (loaded:false) whose full
   transcripts lazy-load when switched to. Completed turns, renames, deletes
   and new threads debounce-push (1.5s) to the server; a failed push retries
   once, then sits quiet-dirty and retries on the next change. The UI is never
   blocked on sync, and any 401/403 (signed out / local mode) disables sync for
   the session so behavior degrades to exactly the old pure-local store. */

export type ToolEvent = {
  id: string;
  name: string;
  args?: unknown;
  result?: unknown;
  ok?: boolean;
  status: "running" | "done" | "error";
};

/* One step in the turn's ORDERED execution timeline, preserving the arrival
   interleave of reasoning and tool calls that the flat reasoning string +
   tools[] lose. A run of reasoning deltas coalesces into one reason step; each
   tool call is its own step, patched in place by id when its result arrives.
   The live ExecutionTimeline renders these in order; the collapsed
   ReasoningTrace can derive from them or keep using reasoning/tools. */
export type ExecStep =
  | { kind: "reason"; text: string }
  | {
      kind: "tool";
      id: string;
      name: string;
      args?: unknown;
      result?: unknown;
      ok?: boolean;
      status: "running" | "done" | "error";
    };

export type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  /* Wall-clock ms the message was created (stamped on user turns at send time).
     Renders the small time under a user bubble; absent on legacy/streamed msgs. */
  createdAt?: number;
  tools?: ToolEvent[];
  /* Generative UI blocks rendered inline beneath this assistant turn. Each
     ui_render call appends one group; all groups are plain JSON so they
     persist to localStorage with the rest of the transcript. */
  ui?: UIBlock[][];
  /* ui_guide calls made during this turn — rendered as quiet replayable chips
     ("Showing you: Calendar"); the live overlay effect fires once on arrival. */
  guides?: GuideSpec[];
  /* The model's chain-of-thought for this turn, streamed on OpenRouter's
     SEPARATE reasoning channel (never in `content`). Accumulated here and
     rendered ABOVE the answer as a collapsible ReasoningTrace; persisted with
     the thread (opaque string, like `tools`). Absent = no trace. */
  reasoning?: string;
  /* Wall-clock ms the reasoning channel was active (first reasoning delta →
     turn done), so the trace can show "Thought for Ns" from real timing rather
     than a step-count estimate. */
  reasoningMs?: number;
  /* The ORDERED execution timeline for this assistant turn: reasoning beats and
     tool calls in real arrival order (see ExecStep). Drives the live
     ExecutionTimeline while streaming and is persisted with the thread (opaque,
     like tools/reasoning). reasoning + tools are kept for backward-compat. */
  steps?: ExecStep[];
};

export type Thread = {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: ChatMessage[];
  /* false = a server-known thread whose full transcript hasn't been fetched
     yet (metadata stub, or local copy the server has since outrun) — it
     lazy-loads via GET /api/chats?id= when switched to. Absent = fully local. */
  loaded?: boolean;
  /* Inline-history organisation. `pinned` lifts the thread into the PINNED
     group; `folderId` files it under a ChatFolder (null/absent = unfiled
     "recent" bucket). Both round-trip to /api/chats (pin/move ops). */
  pinned?: boolean;
  folderId?: string | null;
};

/* A user-made folder grouping threads in the history rail. Mirrors @os/schemas
   ChatFolder (sans tenancy, which the server stamps). */
export type Folder = { id: string; name: string; createdAt: number };

export type AgentContext = {
  page?: string;
  itemId?: string;
  conceptId?: string;
  /* Tenancy hints for the server. These are HINTS only — the API re-resolves the
     authoritative workspace + role from the Clerk session and ignores any role a
     client claims here — but sending them keeps the client and server views in
     sync and lets the UI reflect the active workspace/role. */
  orgId?: string | null;
  workspaceId?: string;
  role?: string;
  [k: string]: unknown;
};

export type AgentStatus = "idle" | "streaming";

const STORE_KEY = "socheli.copilot.threads.v1";
const LEGACY_KEY = "socheli.copilot.v1";

/* Size caps: localStorage is finite and JSON.parse cost is linear. Keep the 30
   most-recently-touched threads and the last 200 messages of any thread. */
const MAX_THREADS = 30;
const MAX_MESSAGES = 200;
const TITLE_LEN = 40;

type Persisted = { threads: Thread[]; folders: Folder[]; activeThreadId: string; open: boolean };
type LegacyPersisted = { messages: ChatMessage[]; open: boolean };

function rid(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/* Append a reasoning delta to the ordered exec timeline: extend the trailing
   reason step if the last step is a reason (coalesce a run of deltas into one
   beat), otherwise start a fresh reason step (a tool call has since intervened,
   so this is a new "thought" beat after the action). */
function appendReason(steps: ExecStep[] | undefined, text: string): ExecStep[] {
  const list = steps ?? [];
  const last = list[list.length - 1];
  if (last && last.kind === "reason") {
    return [...list.slice(0, -1), { kind: "reason", text: last.text + text }];
  }
  return [...list, { kind: "reason", text }];
}

/* Re-validate persisted ui blocks on hydration: localStorage could be tampered
   or hold blocks from an older schema, and the renderer trusts block shape.
   validateBlocks never throws and drops malformed blocks. */
function sanitizeMessages(messages: ChatMessage[]): ChatMessage[] {
  for (const m of messages) {
    if (m && Array.isArray(m.ui)) {
      m.ui = m.ui.map((group) => validateBlocks(group)).filter((g) => g.length > 0);
    }
  }
  return messages;
}

function sanitizeThread(t: Partial<Thread>): Thread | null {
  if (!t || typeof t.id !== "string" || !Array.isArray(t.messages)) return null;
  return {
    id: t.id,
    title: typeof t.title === "string" ? t.title : "",
    createdAt: typeof t.createdAt === "number" ? t.createdAt : Date.now(),
    updatedAt: typeof t.updatedAt === "number" ? t.updatedAt : Date.now(),
    messages: sanitizeMessages(t.messages.slice(-MAX_MESSAGES)),
    // Preserve the lazy-load marker across reloads so a stub keeps refetching.
    ...(t.loaded === false ? { loaded: false } : {}),
    // Organisation flags — migrate legacy threads to the unfiled/unpinned defaults.
    ...(t.pinned === true ? { pinned: true } : {}),
    ...(typeof t.folderId === "string" ? { folderId: t.folderId } : {}),
  };
}

function sanitizeFolder(f: Partial<Folder>): Folder | null {
  if (!f || typeof f.id !== "string" || typeof f.name !== "string" || !f.name.trim()) return null;
  return {
    id: f.id,
    name: f.name.trim().slice(0, 80),
    createdAt: typeof f.createdAt === "number" ? f.createdAt : Date.now(),
  };
}

/* Newest-touched first, capped at MAX_THREADS — but never drop the active
   thread, even if 30 newer ones exist (it is the one on screen). */
function capThreads(threads: Thread[], activeThreadId: string): Thread[] {
  const sorted = [...threads].sort((a, b) => b.updatedAt - a.updatedAt);
  if (sorted.length <= MAX_THREADS) return sorted;
  const kept = sorted.slice(0, MAX_THREADS);
  const active = sorted.find((t) => t.id === activeThreadId);
  if (active && !kept.includes(active)) kept[kept.length - 1] = active;
  return kept;
}

function loadPersisted(): Persisted {
  if (typeof window === "undefined") return { threads: [], folders: [], activeThreadId: "", open: false };
  // Current shape first.
  try {
    const raw = window.localStorage.getItem(STORE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<Persisted>;
      const threads = (Array.isArray(parsed.threads) ? parsed.threads : [])
        .map((t) => sanitizeThread(t))
        .filter((t): t is Thread => t !== null);
      // Migrate pre-folder payloads: folders absent → []. Drop danging folderIds
      // that point at a folder we don't know (so the thread isn't lost in a ghost).
      const folders = (Array.isArray(parsed.folders) ? parsed.folders : [])
        .map((f) => sanitizeFolder(f))
        .filter((f): f is Folder => f !== null);
      const folderIds = new Set(folders.map((f) => f.id));
      for (const t of threads) {
        if (t.folderId && !folderIds.has(t.folderId)) t.folderId = null;
      }
      const activeThreadId =
        typeof parsed.activeThreadId === "string" && threads.some((t) => t.id === parsed.activeThreadId)
          ? parsed.activeThreadId
          : (threads[0]?.id ?? "");
      return { threads: capThreads(threads, activeThreadId), folders, activeThreadId, open: Boolean(parsed.open) };
    }
  } catch {
    /* fall through to legacy/empty */
  }
  // Migrate the legacy single conversation into the first thread (the legacy
  // key is left in place; migration only runs while the new key is absent, so
  // the user's current chat is never lost and never duplicated).
  try {
    const raw = window.localStorage.getItem(LEGACY_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<LegacyPersisted>;
      const messages = sanitizeMessages(
        (Array.isArray(parsed.messages) ? parsed.messages : []).slice(-MAX_MESSAGES),
      );
      if (messages.length) {
        const now = Date.now();
        const thread: Thread = {
          id: rid("t"),
          title: autoTitle(messages.find((m) => m.role === "user")?.content ?? ""),
          createdAt: now,
          updatedAt: now,
          messages,
        };
        return { threads: [thread], folders: [], activeThreadId: thread.id, open: Boolean(parsed.open) };
      }
      return { threads: [], folders: [], activeThreadId: "", open: Boolean(parsed.open) };
    }
  } catch {
    /* corrupted legacy store — start clean */
  }
  return { threads: [], folders: [], activeThreadId: "", open: false };
}

function autoTitle(text: string): string {
  const oneLine = text.trim().replace(/\s+/g, " ");
  if (!oneLine) return "";
  return oneLine.length > TITLE_LEN ? `${oneLine.slice(0, TITLE_LEN).trimEnd()}…` : oneLine;
}

type StreamFrame =
  | { type: "token"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "tool_call"; id: string; name: string; args: unknown }
  | { type: "tool_result"; id: string; name: string; ok: boolean; result: unknown }
  | { type: "ui"; blocks: UIBlock[] }
  | { type: "guide"; guide: GuideSpec }
  | { type: "done" }
  | { type: "error"; message: string };

/* ---------- shared store (module singleton) ----------
   Seeded with the empty/closed defaults so the server-rendered HTML matches the
   client's first render; hydrated from localStorage after the first mount. */

type StoreState = {
  threads: Thread[];
  folders: Folder[];
  activeThreadId: string;
  open: boolean;
  status: AgentStatus;
};

const INITIAL: StoreState = { threads: [], folders: [], activeThreadId: "", open: false, status: "idle" };
const NO_MESSAGES: ChatMessage[] = [];

let state: StoreState = INITIAL;
let hydrated = false;
let abortCtrl: AbortController | null = null;
let streamThreadId: string | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const fn of listeners) fn();
}

/* Persist threads + open state (versioned key). Skipped until hydration has
   run so we never clobber stored state with the initial empty defaults. */
function persist(): void {
  if (typeof window === "undefined" || !hydrated) return;
  try {
    window.localStorage.setItem(
      STORE_KEY,
      JSON.stringify({
        threads: state.threads,
        folders: state.folders,
        activeThreadId: state.activeThreadId,
        open: state.open,
      } satisfies Persisted),
    );
  } catch {
    /* quota / private mode — non-fatal */
  }
}

function setState(patch: Partial<StoreState>): void {
  state = { ...state, ...patch };
  emit();
  persist();
}

/* Apply fn to one thread's record, trim its transcript to the cap, and bump
   updatedAt — every message (user turn, token, tool event) touches the thread,
   which is what keeps the history rail sorted by real recency. */
function touchThread(id: string, fn: (t: Thread) => Thread): void {
  setState({
    threads: state.threads.map((t) => {
      if (t.id !== id) return t;
      const next = fn(t);
      const messages =
        next.messages.length > MAX_MESSAGES ? next.messages.slice(-MAX_MESSAGES) : next.messages;
      return { ...next, messages, updatedAt: Date.now() };
    }),
  });
}

/* Start a fresh thread and make it active. Empty leftovers (other threads that
   never got a message) are dropped so "clear, clear, clear" can't pile up
   blank rows; the cap keeps the store inside its size budget. */
function createThread(): string {
  const now = Date.now();
  const thread: Thread = { id: rid("t"), title: "", createdAt: now, updatedAt: now, messages: [] };
  const kept = state.threads.filter((t) => t.messages.length > 0 || t.id === streamThreadId);
  setState({
    threads: capThreads([thread, ...kept], thread.id),
    activeThreadId: thread.id,
  });
  scheduleUpsert(thread.id); // no-op server-side while empty+untitled; real once it has content
  return thread.id;
}

/* Hydrate persisted threads + open state on the client after the first
   consumer mounts (idempotent — panel and page can both call it). */
function hydrateOnce(): void {
  if (hydrated || typeof window === "undefined") return;
  hydrated = true;
  const p = loadPersisted();
  if (p.threads.length || p.folders.length || p.open) {
    state = {
      ...state,
      threads: p.threads.length ? p.threads : state.threads,
      folders: p.folders.length ? p.folders : state.folders,
      activeThreadId: p.threads.length ? p.activeThreadId : state.activeThreadId,
      open: p.open || state.open,
    };
    emit();
  }
  // Local state is on screen — now reconcile with the server in the background.
  void pullFromServer();
}

/* ---------- backend sync (/api/chats → data/chats/<ws>/<id>.json) ----------
   localStorage stays the source the UI renders from; the server is a durable
   mirror merged by thread id with the newer updatedAt winning. Everything here
   is fire-and-forget: the UI is NEVER blocked on a fetch, every fetch is
   try/caught, and a 401/403 (signed out / no session) flips syncDisabled so
   the store behaves exactly like the old pure-local version. */

const SYNC_DEBOUNCE_MS = 1500;
/* Client-side ceiling kept under the server's 256KB body cap (with headroom
   for JSON escaping) — oversized threads are slimmed before pushing. */
const MAX_SYNC_BYTES = 240 * 1024;

let syncDisabled = false;
let pulledOnce = false;
let flushTimer: ReturnType<typeof setTimeout> | null = null;
const pendingUpserts = new Set<string>();
const pendingDeletes = new Set<string>();
const pendingRenames = new Map<string, string>();
/* Organisation ops — latest intent per id wins (coalesce rapid toggles). */
const pendingPins = new Map<string, boolean>(); // threadId → pinned
const pendingMoves = new Map<string, string | null>(); // threadId → folderId|null
const pendingFolderUpserts = new Map<string, string>(); // folderId → name
const pendingFolderDeletes = new Set<string>(); // folderId
/* Ids that already got their one automatic retry — further attempts wait for
   the next change (quiet dirty). Cleared on a successful push. */
const retriedOnce = new Set<string>();
const fetchingFull = new Set<string>();

function scheduleSync(): void {
  if (syncDisabled || typeof window === "undefined") return;
  if (flushTimer !== null) clearTimeout(flushTimer);
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flushSync();
  }, SYNC_DEBOUNCE_MS);
}

function scheduleUpsert(id: string): void {
  if (syncDisabled) return;
  pendingUpserts.add(id);
  scheduleSync();
}

function scheduleDelete(id: string): void {
  if (syncDisabled) return;
  pendingUpserts.delete(id);
  pendingRenames.delete(id);
  pendingDeletes.add(id);
  scheduleSync();
}

function scheduleRename(id: string, title: string): void {
  if (syncDisabled) return;
  pendingRenames.set(id, title);
  scheduleSync();
}

function schedulePin(id: string, pinned: boolean): void {
  if (syncDisabled) return;
  pendingPins.set(id, pinned);
  scheduleSync();
}

function scheduleMove(id: string, folderId: string | null): void {
  if (syncDisabled) return;
  pendingMoves.set(id, folderId);
  scheduleSync();
}

function scheduleFolderUpsert(id: string, name: string): void {
  if (syncDisabled) return;
  pendingFolderDeletes.delete(id);
  pendingFolderUpserts.set(id, name);
  scheduleSync();
}

function scheduleFolderDelete(id: string): void {
  if (syncDisabled) return;
  pendingFolderUpserts.delete(id);
  pendingFolderDeletes.add(id);
  scheduleSync();
}

/* POST one op. Returns true when the op needs no retry (success, 404 on a
   rename/delete of a thread the server never had, or sync got disabled). */
async function postOp(payload: Record<string, unknown>): Promise<boolean> {
  try {
    const res = await fetch("/api/chats", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (res.status === 401 || res.status === 403) {
      syncDisabled = true; // signed out / local mode — pure local from here on
      return true;
    }
    if (res.status === 404) return true; // nothing server-side to act on
    return res.ok;
  } catch {
    return false; // offline — caller requeues
  }
}

function requeue(set: Set<string>, id: string): void {
  set.add(id);
  if (!retriedOnce.has(id)) {
    retriedOnce.add(id);
    scheduleSync(); // one automatic retry; afterwards quiet-dirty
  }
}

/* Push the queued deletes/renames/upserts. Sequential on purpose — these are
   tiny JSON posts and ordering keeps delete-then-recreate races impossible. */
async function flushSync(): Promise<void> {
  if (syncDisabled || typeof window === "undefined") return;
  const deletes = [...pendingDeletes];
  pendingDeletes.clear();
  const renames = [...pendingRenames];
  pendingRenames.clear();
  const upserts = [...pendingUpserts];
  pendingUpserts.clear();
  const folderUpserts = [...pendingFolderUpserts];
  pendingFolderUpserts.clear();
  const folderDeletes = [...pendingFolderDeletes];
  pendingFolderDeletes.clear();
  const pins = [...pendingPins];
  pendingPins.clear();
  const moves = [...pendingMoves];
  pendingMoves.clear();

  // Folders first: a move/pin can reference a folder the server must already
  // know about. Folder ops are best-effort and never retried (they're tiny and
  // a missed one heals on the next change via the merge on hydrate).
  for (const [id, name] of folderUpserts) {
    if (pendingFolderDeletes.has(id)) continue;
    await postOp({ op: "folder-upsert", id, name });
  }

  for (const id of deletes) {
    if (await postOp({ op: "delete", id })) retriedOnce.delete(id);
    else requeue(pendingDeletes, id);
  }
  for (const [id, title] of renames) {
    if (pendingDeletes.has(id)) continue;
    if (await postOp({ op: "rename", id, title })) retriedOnce.delete(id);
    else if (!pendingRenames.has(id)) {
      pendingRenames.set(id, title);
      if (!retriedOnce.has(id)) {
        retriedOnce.add(id);
        scheduleSync();
      }
    }
  }
  for (const id of upserts) {
    if (pendingDeletes.has(id)) continue;
    const t = state.threads.find((x) => x.id === id);
    if (!t) continue; // deleted meanwhile
    if (t.loaded === false) {
      // Still a stub. If a turn landed in it before its transcript arrived,
      // stay dirty and resolve the stub first (the fetch keeps whichever side
      // has the newer updatedAt, then re-kicks the sync).
      if (t.messages.length > 0) {
        pendingUpserts.add(id);
        void fetchFullThread(id);
      }
      continue;
    }
    if (t.messages.length === 0 && !t.title) continue; // empty untitled — not worth a row
    if (await postOp({ op: "upsert", thread: payloadFor(t) })) retriedOnce.delete(id);
    else requeue(pendingUpserts, id);
  }

  // Pin/move ride after the thread exists server-side. A 404 (thread the server
  // hasn't seen yet) is treated as success — the next upsert carries the flag
  // in the thread body, so the org state isn't lost.
  for (const [id, pinned] of pins) {
    if (pendingDeletes.has(id)) continue;
    await postOp({ op: "pin", id, pinned });
  }
  for (const [id, folderId] of moves) {
    if (pendingDeletes.has(id)) continue;
    await postOp({ op: "move", id, folderId });
  }

  // Folder deletes last (their threads have already been unfiled locally + via
  // move ops, and the server-side delete is idempotent + unfiles too).
  for (const id of folderDeletes) {
    await postOp({ op: "folder-delete", id });
  }
}

type ThreadPayload = Pick<
  Thread,
  "id" | "title" | "createdAt" | "updatedAt" | "messages" | "pinned" | "folderId"
>;

/* The wire shape for an upsert (never includes the local `loaded` marker).
   If a transcript would blow the server's body cap, slim it: heavy tool
   args/results go first, then the oldest messages, until it fits. */
function payloadFor(t: Thread): ThreadPayload {
  let payload: ThreadPayload = {
    id: t.id,
    title: t.title,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    messages: t.messages,
    ...(t.pinned ? { pinned: true } : {}),
    ...(t.folderId ? { folderId: t.folderId } : {}),
  };
  if (JSON.stringify(payload).length <= MAX_SYNC_BYTES) return payload;
  payload = {
    ...payload,
    messages: payload.messages.map((m) => {
      let next = m;
      if (m.tools?.length) {
        next = { ...next, tools: m.tools.map((tl) => ({ id: tl.id, name: tl.name, ok: tl.ok, status: tl.status })) };
      }
      // Drop heavy step args/results too (keep readable reason text + tool
      // names/status so a reloaded trace still renders, just without the raw
      // result payload that the viz/JSON view would have shown).
      if (m.steps?.length) {
        next = {
          ...next,
          steps: m.steps.map((s) =>
            s.kind === "tool" ? { kind: "tool", id: s.id, name: s.name, ok: s.ok, status: s.status } : s,
          ),
        };
      }
      return next;
    }),
  };
  while (JSON.stringify(payload).length > MAX_SYNC_BYTES && payload.messages.length > 2) {
    payload = { ...payload, messages: payload.messages.slice(10) };
  }
  return payload;
}

type ServerMeta = {
  id?: unknown;
  title?: unknown;
  createdAt?: unknown;
  updatedAt?: unknown;
  pinned?: unknown;
  folderId?: unknown;
};
type ServerFolder = { id?: unknown; name?: unknown; createdAt?: unknown };

/* One-shot reconcile on hydrate: merge the server's thread list into local
   state by id, newer updatedAt winning. Server-only threads land as metadata
   stubs; local threads the server is missing (or has stale) queue for upsert. */
async function pullFromServer(): Promise<void> {
  if (pulledOnce || syncDisabled || typeof window === "undefined") return;
  pulledOnce = true;
  try {
    const res = await fetch("/api/chats");
    if (res.status === 401 || res.status === 403) {
      syncDisabled = true;
      return;
    }
    if (!res.ok) return;
    const data = (await res.json()) as { threads?: ServerMeta[]; folders?: ServerFolder[] };
    const metas = Array.isArray(data?.threads) ? data.threads : [];
    const serverFolders = Array.isArray(data?.folders) ? data.folders : [];

    const byId = new Map(state.threads.map((t) => [t.id, t] as const));
    const serverIds = new Set<string>();
    const merged = [...state.threads];
    let changed = false;

    // Org flags off a server meta: pinned defaults false, folderId nulls out.
    const orgOf = (m: ServerMeta) => ({
      pinned: m.pinned === true ? true : undefined,
      folderId: typeof m.folderId === "string" ? m.folderId : null,
    });

    for (const m of metas) {
      if (!m || typeof m.id !== "string" || typeof m.updatedAt !== "number") continue;
      serverIds.add(m.id);
      const title = typeof m.title === "string" ? m.title : "";
      const createdAt = typeof m.createdAt === "number" ? m.createdAt : m.updatedAt;
      const org = orgOf(m);
      const local = byId.get(m.id);
      if (!local) {
        // Server-only thread → metadata stub; transcript lazy-loads on switch.
        merged.push({
          id: m.id, title, createdAt, updatedAt: m.updatedAt, messages: [], loaded: false,
          ...(org.pinned ? { pinned: true } : {}),
          ...(org.folderId ? { folderId: org.folderId } : {}),
        });
        changed = true;
      } else if (m.updatedAt > local.updatedAt && streamThreadId !== local.id) {
        // Server is newer → adopt the metadata (incl. org flags), mark the
        // transcript stale.
        const idx = merged.indexOf(local);
        merged[idx] = {
          ...local, title: title || local.title, updatedAt: m.updatedAt, loaded: false,
          pinned: org.pinned, folderId: org.folderId,
        };
        changed = true;
      } else if (m.updatedAt < local.updatedAt && local.loaded !== false) {
        scheduleUpsert(local.id); // local is ahead → push
      }
    }
    // Local-only threads the server has never seen.
    for (const t of state.threads) {
      if (!serverIds.has(t.id) && t.messages.length > 0) scheduleUpsert(t.id);
    }

    // Merge folders: union local + server by id (server is authoritative for a
    // shared id), local-only folders push up. Drop dangling thread folderIds.
    const localFolders = new Map(state.folders.map((f) => [f.id, f] as const));
    const folderById = new Map(localFolders);
    const serverFolderIds = new Set<string>();
    for (const sf of serverFolders) {
      const f = sanitizeFolder(sf as Partial<Folder>);
      if (!f) continue;
      serverFolderIds.add(f.id);
      folderById.set(f.id, f);
    }
    for (const f of state.folders) {
      if (!serverFolderIds.has(f.id)) scheduleFolderUpsert(f.id, f.name);
    }
    const nextFolders = [...folderById.values()].sort((a, b) => a.createdAt - b.createdAt);
    const foldersChanged =
      nextFolders.length !== state.folders.length ||
      nextFolders.some((f, i) => state.folders[i]?.id !== f.id || state.folders[i]?.name !== f.name);
    const folderIdSet = new Set(nextFolders.map((f) => f.id));
    if (changed || foldersChanged) {
      const capped = capThreads(merged, state.activeThreadId).map((t) =>
        t.folderId && !folderIdSet.has(t.folderId) ? { ...t, folderId: null } : t,
      );
      setState({ threads: capped, folders: nextFolders });
    }

    // The thread on screen should never sit as a stale stub — fetch it now.
    const active = state.threads.find((t) => t.id === state.activeThreadId);
    if (active && active.loaded === false) void fetchFullThread(active.id);
  } catch {
    /* offline — pure local, exactly like before */
  }
}

/* Fetch one full transcript and swap it in — unless the local copy advanced
   past the server in the meantime, or a stream is flowing into that thread. */
async function fetchFullThread(id: string): Promise<void> {
  if (syncDisabled || typeof window === "undefined" || fetchingFull.has(id)) return;
  fetchingFull.add(id);
  try {
    const res = await fetch(`/api/chats?id=${encodeURIComponent(id)}`);
    if (res.status === 401 || res.status === 403) {
      syncDisabled = true;
      return;
    }
    if (res.status === 404) {
      markLoaded(id); // gone server-side — keep whatever we have locally
      return;
    }
    if (!res.ok) return;
    const data = (await res.json()) as { thread?: Partial<Thread> };
    const fetched = data?.thread ? sanitizeThread(data.thread) : null;
    if (!fetched || fetched.id !== id) {
      markLoaded(id);
      return;
    }
    if (streamThreadId === id) return; // never clobber a live stream's transcript
    setState({
      threads: state.threads.map((t) => {
        if (t.id !== id) return t;
        if (t.updatedAt > fetched.updatedAt) return { ...t, loaded: undefined }; // local won meanwhile
        return { ...fetched, title: fetched.title || t.title };
      }),
    });
    // If this thread was waiting on its stub to resolve before pushing, go now.
    if (pendingUpserts.has(id)) scheduleSync();
  } catch {
    /* offline — the stub stays and refetches on a later switch */
  } finally {
    fetchingFull.delete(id);
  }
}

function markLoaded(id: string): void {
  if (!state.threads.some((t) => t.id === id && t.loaded === false)) return;
  setState({ threads: state.threads.map((t) => (t.id === id ? { ...t, loaded: undefined } : t)) });
  if (pendingUpserts.has(id)) scheduleSync(); // the stub resolved local-side — push now
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

const getSnapshot = (): StoreState => state;
const getServerSnapshot = (): StoreState => INITIAL;

export function useAgent(context: AgentContext, model?: string) {
  const snap = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  useEffect(() => {
    hydrateOnce();
  }, []);

  const setOpen = useCallback((v: SetStateAction<boolean>) => {
    setState({ open: typeof v === "function" ? v(state.open) : v });
  }, []);

  const stop = useCallback(() => {
    abortCtrl?.abort();
    abortCtrl = null;
    setState({ status: "idle" });
  }, []);

  const newThread = useCallback(() => {
    // Reuse an already-empty active thread instead of minting another blank.
    const active = state.threads.find((t) => t.id === state.activeThreadId);
    if (active && active.messages.length === 0) return active.id;
    return createThread();
  }, []);

  /* clear() keeps its old surface contract (composer empties out) but is now
     non-destructive: the current thread stays in history, a fresh one opens. */
  const clear = useCallback(() => {
    stop();
    newThread();
  }, [stop, newThread]);

  const switchThread = useCallback((id: string) => {
    if (id === state.activeThreadId) return;
    const target = state.threads.find((t) => t.id === id);
    if (!target) return;
    setState({ activeThreadId: id });
    // A server stub (or stale local copy) lazy-loads its full transcript now.
    if (target.loaded === false) void fetchFullThread(id);
    // A switch is a change — give any quiet-dirty pushes another chance.
    if (
      pendingUpserts.size || pendingDeletes.size || pendingRenames.size ||
      pendingPins.size || pendingMoves.size || pendingFolderUpserts.size || pendingFolderDeletes.size
    ) scheduleSync();
  }, []);

  const deleteThread = useCallback(
    (id: string) => {
      if (streamThreadId === id) stop(); // never stream into a deleted thread
      const threads = state.threads.filter((t) => t.id !== id);
      const activeThreadId =
        state.activeThreadId === id
          ? ([...threads].sort((a, b) => b.updatedAt - a.updatedAt)[0]?.id ?? "")
          : state.activeThreadId;
      setState({ threads, activeThreadId });
      scheduleDelete(id);
    },
    [stop],
  );

  const renameThread = useCallback((id: string, title: string) => {
    const next = title.trim().slice(0, 80);
    if (!next) return;
    setState({ threads: state.threads.map((t) => (t.id === id ? { ...t, title: next } : t)) });
    scheduleRename(id, next);
  }, []);

  /* ---- inline-history organisation: pin / move / folders ----
     Each mutates the local store synchronously (UI is instant) and debounce-
     syncs the matching /api/chats op. Org changes bump updatedAt so the merge
     on a later hydrate adopts them (server pin/move bump updatedAt too, keeping
     both sides in step). All offline/401-safe via the shared sync layer. */

  const pinThread = useCallback((id: string) => {
    setState({
      threads: state.threads.map((t) =>
        t.id === id && !t.pinned ? { ...t, pinned: true, updatedAt: Date.now() } : t,
      ),
    });
    schedulePin(id, true);
  }, []);

  const unpinThread = useCallback((id: string) => {
    setState({
      threads: state.threads.map((t) =>
        t.id === id && t.pinned ? { ...t, pinned: false, updatedAt: Date.now() } : t,
      ),
    });
    schedulePin(id, false);
  }, []);

  const moveThread = useCallback((id: string, folderId: string | null) => {
    // Unknown target → treat as unfile (never strand a thread in a ghost folder).
    const target =
      folderId && state.folders.some((f) => f.id === folderId) ? folderId : null;
    setState({
      threads: state.threads.map((t) =>
        t.id === id ? { ...t, folderId: target, updatedAt: Date.now() } : t,
      ),
    });
    scheduleMove(id, target);
  }, []);

  const newFolder = useCallback((name: string): string => {
    const clean = name.trim().slice(0, 80) || "New folder";
    const id = rid("f");
    const folder: Folder = { id, name: clean, createdAt: Date.now() };
    setState({ folders: [...state.folders, folder] });
    scheduleFolderUpsert(id, clean);
    return id;
  }, []);

  const renameFolder = useCallback((id: string, name: string) => {
    const clean = name.trim().slice(0, 80);
    if (!clean) return;
    setState({ folders: state.folders.map((f) => (f.id === id ? { ...f, name: clean } : f)) });
    scheduleFolderUpsert(id, clean);
  }, []);

  const deleteFolder = useCallback((id: string) => {
    // Unfile this folder's threads (folderId → null) — never delete threads.
    const now = Date.now();
    setState({
      folders: state.folders.filter((f) => f.id !== id),
      threads: state.threads.map((t) =>
        t.folderId === id ? { ...t, folderId: null, updatedAt: now } : t,
      ),
    });
    // Push the unfile for each affected thread, then drop the folder server-side.
    for (const t of state.threads) {
      if (t.folderId === id) scheduleMove(t.id, null);
    }
    scheduleFolderDelete(id);
  }, []);

  const send = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || state.status === "streaming") return;

      // Sends always land in a real thread — lazily mint one if none is active
      // (fresh install, everything deleted, pre-hydration race).
      let threadId = state.activeThreadId;
      if (!state.threads.some((t) => t.id === threadId)) threadId = createThread();

      const userMsg: ChatMessage = { id: rid("u"), role: "user", content: trimmed, createdAt: Date.now() };
      const assistantId = rid("a");
      const assistantMsg: ChatMessage = { id: assistantId, role: "assistant", content: "", tools: [] };

      // History sent to the agent is the active thread's transcript plus the
      // new user turn. Drop empty assistant turns (interrupted streams).
      const prior = state.threads.find((t) => t.id === threadId)?.messages ?? [];
      const history = [...prior, userMsg]
        .filter((m) => m.content.trim().length > 0)
        .map((m) => ({ role: m.role, content: m.content }));

      touchThread(threadId, (t) => ({
        ...t,
        // Auto-title on the first user message: its first ~40 chars.
        title: t.title || autoTitle(trimmed),
        messages: [...t.messages, userMsg, assistantMsg],
      }));
      setState({ status: "streaming" });

      const controller = new AbortController();
      abortCtrl = controller;
      streamThreadId = threadId;

      // Patches target the thread the stream STARTED in, by id — switching
      // threads mid-stream keeps tokens flowing into the right transcript.
      const patchAssistant = (fn: (m: ChatMessage) => ChatMessage) =>
        touchThread(threadId, (t) => ({
          ...t,
          messages: t.messages.map((m) => (m.id === assistantId ? fn(m) : m)),
        }));

      // Wall-clock of the FIRST reasoning delta this turn — used to compute
      // reasoningMs ("Thought for Ns") when the turn completes.
      let reasoningStart: number | null = null;
      const applyFrame = (frame: StreamFrame) => {
        switch (frame.type) {
          case "token":
            patchAssistant((m) => ({ ...m, content: m.content + frame.text }));
            break;
          case "reasoning":
            if (reasoningStart === null) reasoningStart = Date.now();
            patchAssistant((m) => ({
              ...m,
              reasoning: (m.reasoning ?? "") + frame.text,
              reasoningMs: Date.now() - (reasoningStart as number),
              // Coalesce a run of reasoning deltas into the trailing reason step
              // (extend it); a tool step in between starts a fresh reason step.
              steps: appendReason(m.steps, frame.text),
            }));
            break;
          case "tool_call":
            patchAssistant((m) => ({
              ...m,
              tools: [
                ...(m.tools ?? []),
                { id: frame.id, name: frame.name, args: frame.args, status: "running" },
              ],
              steps: [
                ...(m.steps ?? []),
                { kind: "tool", id: frame.id, name: frame.name, args: frame.args, status: "running" },
              ],
            }));
            break;
          case "tool_result":
            patchAssistant((m) => ({
              ...m,
              tools: (m.tools ?? []).map((t) =>
                t.id === frame.id
                  ? { ...t, result: frame.result, ok: frame.ok, status: frame.ok ? "done" : "error" }
                  : t,
              ),
              // Patch the matching tool step by id in place (order preserved).
              steps: (m.steps ?? []).map((s) =>
                s.kind === "tool" && s.id === frame.id
                  ? { ...s, result: frame.result, ok: frame.ok, status: frame.ok ? "done" : "error" }
                  : s,
              ),
            }));
            break;
          case "ui":
            patchAssistant((m) => ({
              ...m,
              ui: [...(m.ui ?? []), frame.blocks],
            }));
            break;
          case "guide":
            patchAssistant((m) => ({
              ...m,
              guides: [...(m.guides ?? []), frame.guide],
            }));
            // The GuideOverlay (mounted in AppShell) navigates + draws the circle.
            try {
              window.dispatchEvent(new CustomEvent("soli:guide", { detail: frame.guide }));
            } catch { /* SSR-safe no-op */ }
            break;
          case "error":
            patchAssistant((m) => ({
              ...m,
              content: m.content + (m.content ? "\n\n" : "") + `Error: ${frame.message}`,
            }));
            break;
          case "done":
            break;
        }
      };

      try {
        const res = await fetch("/api/agent", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ messages: history, context: { ...context }, model }),
          signal: controller.signal,
        });

        if (!res.ok || !res.body) {
          applyFrame({ type: "error", message: `Request failed (${res.status})` });
          return;
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        // Parse SSE frames split on the blank-line delimiter; keep partial tail.
        const drain = (flush: boolean) => {
          let idx: number;
          while ((idx = buffer.indexOf("\n\n")) !== -1) {
            const rawFrame = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);
            for (const line of rawFrame.split("\n")) {
              const m = line.match(/^data:\s?(.*)$/);
              if (!m) continue;
              const payload = m[1];
              if (!payload) continue;
              try {
                applyFrame(JSON.parse(payload) as StreamFrame);
              } catch {
                /* ignore malformed frame */
              }
            }
          }
          if (flush && buffer.trim()) {
            const m = buffer.trim().match(/^data:\s?(.*)$/);
            if (m?.[1]) {
              try {
                applyFrame(JSON.parse(m[1]) as StreamFrame);
              } catch {
                /* ignore */
              }
            }
            buffer = "";
          }
        };

        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          drain(false);
        }
        buffer += decoder.decode();
        drain(true);
      } catch (e) {
        if ((e as { name?: string })?.name !== "AbortError") {
          const message = e instanceof Error ? e.message : String(e);
          applyFrame({ type: "error", message });
        }
      } finally {
        abortCtrl = null;
        streamThreadId = null;
        setState({ status: "idle" });
        // The turn is complete (or aborted) — debounce-push this thread.
        scheduleUpsert(threadId);
      }
    },
    [context, model],
  );

  /* Edit a prior USER turn: drop that message and everything after it from the
     active thread, then re-send the edited text as a fresh turn so the assistant
     re-answers from there. `state` mutates synchronously, so the truncation is
     in place before send() reads the transcript. No-op mid-stream. */
  const editMessage = useCallback(
    (messageId: string, newText: string) => {
      const trimmed = newText.trim();
      if (!trimmed || state.status === "streaming") return;
      const threadId = state.activeThreadId;
      const thread = state.threads.find((t) => t.id === threadId);
      if (!thread) return;
      const idx = thread.messages.findIndex((m) => m.id === messageId && m.role === "user");
      if (idx < 0) return;
      touchThread(threadId, (t) => ({ ...t, messages: t.messages.slice(0, idx) }));
      void send(trimmed);
    },
    [send],
  );

  /* Derived views: the active thread's transcript (stable empty-array ref when
     there is no thread yet) and the history list, newest-touched first. */
  const active = snap.threads.find((t) => t.id === snap.activeThreadId);
  const messages = active?.messages ?? NO_MESSAGES;
  const threads = useMemo(
    () => [...snap.threads].sort((a, b) => b.updatedAt - a.updatedAt),
    [snap.threads],
  );
  const folders = snap.folders;

  return {
    messages,
    status: snap.status,
    open: snap.open,
    setOpen,
    send,
    editMessage,
    stop,
    clear,
    threads,
    folders,
    activeThreadId: snap.activeThreadId,
    newThread,
    switchThread,
    deleteThread,
    renameThread,
    // inline-history organisation
    pinThread,
    unpinThread,
    moveThread,
    newFolder,
    renameFolder,
    deleteFolder,
  } as const;
}
