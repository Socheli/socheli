/* @socheli/sdk — the official TypeScript client for the Socheli content engine.
 *
 *   import { createSocheli } from "@socheli/sdk";
 *   const socheli = createSocheli({ apiKey: process.env.SOCHELI_API_KEY });
 *   const { devices } = await socheli.fleet();
 *   const job = await socheli.generate({ seed: "why we procrastinate", channel: "labrinox" });
 *
 * Zero runtime dependencies — just `fetch`. Works in Node 18+, Bun, Deno, edge.
 */
export * from "./types.ts";
import type { Item, ItemSummary, JobRow, GenerateInput, PublishInput, Schedule, FleetState, Job, Me, ApiKey, Role } from "./types.ts";

export interface SocheliOptions {
  /** API key (Bearer). Falls back to env SOCHELI_API_KEY. */
  apiKey?: string;
  /** API base URL. Defaults to env SOCHELI_API_URL or https://api.socheli.com. */
  baseUrl?: string;
  /** Custom fetch (for testing / non-standard runtimes). */
  fetch?: typeof fetch;
}

export class SocheliError extends Error {
  constructor(message: string, readonly status: number, readonly body?: unknown) {
    super(message);
    this.name = "SocheliError";
  }
}

/** One entry of the canonical tool manifest (`GET /v1/tools`). */
export interface ToolManifestEntry {
  name: string;
  description: string;
  kind: "read" | "mutate" | "long";
  inputSchema: Record<string, unknown>;
}
/** Uniform result shape every registry tool returns. */
export interface ToolResult<T = unknown> {
  ok: boolean;
  data?: T;
  message?: string;
}
/** A planned calendar post (subset; see docs/calendar.md). */
export interface PlannedPost {
  id: string; date: string; time: string; channel: string; platform: string;
  topic: string; angle: string; format: string; mood?: string; hook?: string;
  rationale: string; algoLever?: string; scores?: Record<string, number>;
  overall?: number; status: string; planRunId: string; createdAt: string; updatedAt?: string;
}

export interface SocheliClient {
  health(): Promise<{ ok: boolean; version: string; uptime: number }>;
  /** Who the current API key acts as (its workspace + role). */
  me(): Promise<Me>;
  /** Manage the current workspace's API keys (requires the apikey.manage role). */
  keys: {
    list(): Promise<ApiKey[]>;
    /** Issue a new key — the plaintext is returned ONCE in `key`. */
    issue(input: { label: string; role?: Role }): Promise<{ key: string; record: ApiKey }>;
    revoke(id: string): Promise<boolean>;
  };
  items: {
    list(params?: { limit?: number; channel?: string }): Promise<ItemSummary[]>;
    get(id: string): Promise<Item>;
    publish(id: string, input?: PublishInput): Promise<{ dispatched: boolean }>;
  };
  generate(input: GenerateInput): Promise<{ dispatched: boolean; job: Job }>;
  jobs(): Promise<JobRow[]>;
  fleet(): Promise<FleetState>;
  schedule: {
    get(): Promise<Schedule>;
    set(schedule: Schedule): Promise<Schedule>;
  };
  /** List the canonical tool manifest (editor + pipeline + plan/calendar tools). */
  tools(): Promise<ToolManifestEntry[]>;
  /** Call any registry tool by name with a JSON input object. */
  tool<T = unknown>(name: string, input?: Record<string, unknown>): Promise<ToolResult<T>>;
  /** Content-calendar / plan CRUD — thin wrappers over the plan_* tools. */
  plan: {
    list(params?: { channel?: string; status?: string; includeArchived?: boolean }): Promise<PlannedPost[]>;
    get(id: string): Promise<PlannedPost | null>;
    day(date: string, includeArchived?: boolean): Promise<PlannedPost[]>;
    create(post: Partial<PlannedPost> & { channel: string; date: string; platform: string; topic: string }): Promise<PlannedPost | null>;
    update(id: string, patch: Partial<PlannedPost>): Promise<PlannedPost | null>;
    move(id: string, date: string, time?: string): Promise<PlannedPost | null>;
    archive(id: string): Promise<PlannedPost | null>;
    remove(id: string): Promise<boolean>;
    run(input: { channel: string; days?: number; platforms?: string[]; time?: string }): Promise<ToolResult>;
  };
  /** Community inbox — Instagram comments + DMs (thin wrappers over the
      comment and dm tools). Drafting is local; sending is the human-gated action. */
  inbox: {
    pull(channel: string): Promise<{ comments: ToolResult; dms: ToolResult }>;
    comments(channel: string, unansweredOnly?: boolean): Promise<ToolResult>;
    draftComment(channel: string, commentId: string, reply: string): Promise<ToolResult>;
    pendingComments(channel: string): Promise<ToolResult>;
    sendComment(channel: string, commentId: string, text?: string): Promise<ToolResult>;
    hideComment(channel: string, commentId: string, hide?: boolean): Promise<ToolResult>;
    dms(channel: string): Promise<ToolResult>;
    thread(channel: string, conversationId: string): Promise<ToolResult>;
    draftDm(channel: string, conversationId: string, reply: string): Promise<ToolResult>;
    pendingDms(channel: string): Promise<ToolResult>;
    sendDm(channel: string, conversationId: string, text?: string): Promise<ToolResult>;
  };
}

const DEFAULT_BASE = "https://api.socheli.com";

export function createSocheli(opts: SocheliOptions = {}): SocheliClient {
  const apiKey = opts.apiKey ?? (typeof process !== "undefined" ? process.env?.SOCHELI_API_KEY : undefined);
  const baseUrl = (opts.baseUrl ?? (typeof process !== "undefined" ? process.env?.SOCHELI_API_URL : undefined) ?? DEFAULT_BASE).replace(/\/$/, "");
  const doFetch = opts.fetch ?? fetch;

  async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await doFetch(`${baseUrl}/v1${path}`, {
      method,
      headers: {
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    const data = text ? (() => { try { return JSON.parse(text); } catch { return text; } })() : undefined;
    if (!res.ok) throw new SocheliError((data as any)?.error ?? `${method} ${path} → ${res.status}`, res.status, data);
    return data as T;
  }

  return {
    health: () => req("GET", "/health"),
    me: () => req("GET", "/me"),
    keys: {
      list: () => req<{ keys: ApiKey[] }>("GET", "/keys").then((r) => r.keys),
      issue: (input) => req("POST", "/keys", input),
      revoke: (id) => req<{ revoked: boolean }>("DELETE", `/keys/${encodeURIComponent(id)}`).then((r) => r.revoked),
    },
    items: {
      list: (p = {}) => req("GET", `/items?${new URLSearchParams({ ...(p.limit ? { limit: String(p.limit) } : {}), ...(p.channel ? { channel: p.channel } : {}) })}`),
      get: (id) => req("GET", `/items/${encodeURIComponent(id)}`),
      publish: (id, input = {}) => req("POST", `/items/${encodeURIComponent(id)}/publish`, input),
    },
    generate: (input) => req("POST", "/generate", input),
    jobs: () => req("GET", "/jobs"),
    fleet: () => req("GET", "/fleet"),
    schedule: {
      get: () => req("GET", "/schedule"),
      set: (s) => req("PUT", "/schedule", s),
    },
    tools: () => req<{ tools: ToolManifestEntry[] }>("GET", "/tools").then((r) => r.tools),
    tool: <T = unknown>(name: string, input: Record<string, unknown> = {}) =>
      req<ToolResult<T>>("POST", `/tools/${encodeURIComponent(name)}`, input),
    plan: {
      list: (p = {}) => req<ToolResult<PlannedPost[]>>("POST", "/tools/plan_list", p).then((r) => r.data ?? []),
      get: (id) => req<ToolResult<PlannedPost>>("POST", "/tools/plan_get", { id }).then((r) => (r.ok ? (r.data ?? null) : null)),
      day: (date, includeArchived) => req<ToolResult<{ date: string; posts: PlannedPost[] }>>("POST", "/tools/plan_day", { date, includeArchived }).then((r) => r.data?.posts ?? []),
      create: (post) => req<ToolResult<PlannedPost>>("POST", "/tools/plan_create", post).then((r) => r.data ?? null),
      update: (id, patch) => req<ToolResult<PlannedPost>>("POST", "/tools/plan_update", { id, patch }).then((r) => r.data ?? null),
      move: (id, date, time) => req<ToolResult<PlannedPost>>("POST", "/tools/plan_move", { id, date, time }).then((r) => r.data ?? null),
      archive: (id) => req<ToolResult<PlannedPost>>("POST", "/tools/plan_archive", { id }).then((r) => r.data ?? null),
      remove: (id) => req<ToolResult>("POST", "/tools/plan_delete", { id }).then((r) => r.ok),
      run: (input) => req<ToolResult>("POST", "/tools/plan_run", input),
    },
    inbox: {
      pull: async (channel) => ({
        comments: await req<ToolResult>("POST", "/tools/comments_pull", { channel }),
        dms: await req<ToolResult>("POST", "/tools/dm_pull", { channel }),
      }),
      comments: (channel, unansweredOnly = true) => req<ToolResult>("POST", "/tools/comments_list", { channel, unansweredOnly }),
      draftComment: (channel, commentId, reply) => req<ToolResult>("POST", "/tools/comment_draft", { channel, commentId, reply }),
      pendingComments: (channel) => req<ToolResult>("POST", "/tools/comments_pending", { channel }),
      sendComment: (channel, commentId, text) => req<ToolResult>("POST", "/tools/comment_send", { channel, commentId, ...(text ? { text } : {}) }),
      hideComment: (channel, commentId, hide = true) => req<ToolResult>("POST", "/tools/comment_hide", { channel, commentId, hide }),
      dms: (channel) => req<ToolResult>("POST", "/tools/dm_list", { channel }),
      thread: (channel, conversationId) => req<ToolResult>("POST", "/tools/dm_thread", { channel, conversationId }),
      draftDm: (channel, conversationId, reply) => req<ToolResult>("POST", "/tools/dm_draft", { channel, conversationId, reply }),
      pendingDms: (channel) => req<ToolResult>("POST", "/tools/dm_pending", { channel }),
      sendDm: (channel, conversationId, text) => req<ToolResult>("POST", "/tools/dm_send", { channel, conversationId, ...(text ? { text } : {}) }),
    },
  };
}

export default createSocheli;
