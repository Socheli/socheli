import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { REPO_ROOT } from "../data";

/* External MCP connections for Soli — a minimal, dependency-free MCP CLIENT.

   Users register external MCP servers (data/mcp-servers.json, gitignored) and
   their tools are merged into Soli's tool surface in tools.ts exactly like the
   ICOG_TOOLS / LOCAL_TOOLS merges: advertised as `mcp_<serverId>_<toolName>`,
   gated as mutations by default, dispatched back here.

   Transports:
   - "stdio": we spawn the configured command and speak JSON-RPC 2.0 over its
     stdio. The wild supports TWO framings — newline-delimited (what Claude
     Code's stdio transport and our engine/src/harness/mcp-stdio.ts speak) and
     LSP-style `Content-Length` headers (what packages/mcp speaks). We READ
     both (the parser sniffs each frame) and, until the server's first reply
     tells us which dialect it speaks, we WRITE a hybrid frame
     (`Content-Length: N\r\n\r\n<json>\n`) that both kinds of server parse: a
     CL server consumes exactly N bytes; a line server sees the header as one
     junk line (it replies with an ignorable id:null parse error), an empty
     line, then the JSON line. After the first response we lock to the
     detected framing. One persistent child per enabled server lives in a
     module-level pool — restarted on crash, killed after 5 min idle.
   - "http": one JSON-RPC POST per request (streamable-http style, no SSE
     stream subscription in v1; an event-stream RESPONSE body is still
     tolerated by extracting its `data:` payload). We attempt the initialize
     handshake once and carry the `mcp-session-id` header if the server
     issues one; servers that reject initialize are treated as raw JSON-RPC.

   SECURITY:
   - stdio = arbitrary command execution. Spawning is refused unless
     MCP_ALLOW_STDIO=1 (checked HERE at runtime, not just in the API route, so
     a hand-edited config file cannot bypass the gate on a shared server).
   - `env` in the config is a list of env var NAMES to pass through from the
     host process — values are never stored, returned, or logged. The child
     env is otherwise minimal (PATH/HOME/LANG only).
   - Nothing in this module logs argument payloads or env values. */

export type McpTransport = "stdio" | "http";

export type McpServerConfig = {
  id: string; // generated, alphanumeric only (safe inside mcp_<id>_<tool> names)
  name: string;
  transport: McpTransport;
  command?: string; // stdio: executable
  args?: string[]; // stdio: argv
  env?: string[]; // stdio: NAMES of host env vars to pass through (never values)
  url?: string; // http: endpoint
  enabled: boolean;
  timeoutMs?: number; // per-call timeout (default 60s calls / 20s handshake)
};

export type McpToolEntry = {
  server: string; // server id
  serverName: string;
  name: string; // the tool's ORIGINAL name (what tools/call expects)
  prefixedName: string; // mcp_<serverId>_<sanitized tool name> — unique, advertised
  description: string;
  inputSchema: Record<string, unknown>;
};

export type McpServerStatus = {
  id: string;
  name: string;
  transport: McpTransport;
  enabled: boolean;
  status: "connected" | "error" | "disabled" | "stdio_blocked";
  toolCount?: number;
  error?: string;
};

const CONFIG_PATH = join(REPO_ROOT, "data", "mcp-servers.json");
const HANDSHAKE_TIMEOUT_MS = 20_000;
const CALL_TIMEOUT_MS = 60_000;
const IDLE_KILL_MS = 5 * 60_000;
const TOOLS_CACHE_MS = 60_000;
const MAX_BUFFER = 4 * 1024 * 1024; // same cap as the engine runner bridge

export const stdioAllowed = () => process.env.MCP_ALLOW_STDIO === "1";

/* ── Config store (flat JSON, atomic tmp+rename — engine dms.ts pattern) ───── */

export function loadMcpServers(): McpServerConfig[] {
  if (!existsSync(CONFIG_PATH)) return [];
  try {
    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
    if (!Array.isArray(raw)) return [];
    return raw.filter(
      (s): s is McpServerConfig =>
        !!s &&
        typeof s === "object" &&
        typeof s.id === "string" &&
        typeof s.name === "string" &&
        (s.transport === "stdio" || s.transport === "http"),
    );
  } catch {
    return [];
  }
}

export function saveMcpServers(servers: McpServerConfig[]): void {
  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  const tmp = `${CONFIG_PATH}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(servers, null, 2));
  renameSync(tmp, CONFIG_PATH);
}

/* Alphanumeric-only ids: the prefixed tool name is mcp_<id>_<tool>, parsed by
   splitting on "_" — an id containing "_" would break the round-trip. */
export function newServerId(): string {
  return `m${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`.replace(/[^a-z0-9]/g, "");
}

/* ── JSON-RPC plumbing shared by both transports ───────────────────────────── */

type JsonRpcMsg = {
  jsonrpc?: "2.0";
  id?: string | number | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string };
};

function rpcResultOrThrow(msg: JsonRpcMsg, what: string): unknown {
  if (msg.error) throw new Error(`${what} failed: ${msg.error.message ?? `code ${msg.error.code}`}`);
  return msg.result;
}

/* ── stdio transport: persistent child pool ────────────────────────────────── */

type Pending = {
  resolve: (msg: JsonRpcMsg) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  onAbort?: () => void;
  signal?: AbortSignal;
};

type StdioConn = {
  child: ChildProcessWithoutNullStreams;
  buf: Buffer;
  pending: Map<number, Pending>;
  nextId: number;
  framing: "unknown" | "line" | "cl";
  ready: Promise<void>;
  idleTimer: ReturnType<typeof setTimeout> | null;
  stderrTail: string;
  dead: boolean;
};

const pool = new Map<string, StdioConn>();

function killConn(serverId: string): void {
  const conn = pool.get(serverId);
  if (!conn) return;
  pool.delete(serverId);
  conn.dead = true;
  if (conn.idleTimer) clearTimeout(conn.idleTimer);
  for (const p of conn.pending.values()) {
    clearTimeout(p.timer);
    p.reject(new Error("mcp connection closed"));
  }
  conn.pending.clear();
  try {
    conn.child.kill("SIGKILL");
  } catch {
    /* already gone */
  }
}

function writeFrame(conn: StdioConn, msg: Record<string, unknown>): void {
  const body = JSON.stringify(msg);
  if (conn.framing === "line") {
    conn.child.stdin.write(body + "\n");
  } else if (conn.framing === "cl") {
    conn.child.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  } else {
    // Framing unknown (pre-first-response): hybrid frame both dialects accept.
    conn.child.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}\n`);
  }
}

/* Parse the child's stdout, accepting Content-Length frames AND newline-
   delimited envelopes interleaved in one buffer. Sets conn.framing from the
   first successfully parsed message. */
function drainStdout(serverId: string, conn: StdioConn): void {
  for (;;) {
    // Strip inter-frame whitespace (e.g. the trailing \n of our hybrid frame echoing patterns).
    let start = 0;
    while (start < conn.buf.length && (conn.buf[start] === 0x0a || conn.buf[start] === 0x0d)) start++;
    if (start > 0) conn.buf = conn.buf.subarray(start);
    if (conn.buf.length === 0) return;

    let bodyText: string | null = null;
    let detected: "line" | "cl" = "line";

    if (conn.buf.subarray(0, 15).toString("utf8").toLowerCase() === "content-length:") {
      const headerEnd = conn.buf.indexOf("\r\n\r\n");
      if (headerEnd === -1) return; // incomplete header
      const m = /content-length:\s*(\d+)/i.exec(conn.buf.subarray(0, headerEnd).toString("utf8"));
      if (!m) {
        conn.buf = conn.buf.subarray(headerEnd + 4);
        continue;
      }
      const len = Number(m[1]);
      const bodyStart = headerEnd + 4;
      if (conn.buf.length < bodyStart + len) return; // incomplete body
      bodyText = conn.buf.subarray(bodyStart, bodyStart + len).toString("utf8");
      conn.buf = conn.buf.subarray(bodyStart + len);
      detected = "cl";
    } else {
      const nl = conn.buf.indexOf("\n");
      if (nl === -1) {
        if (conn.buf.length > MAX_BUFFER) killConn(serverId); // runaway non-protocol output
        return;
      }
      bodyText = conn.buf.subarray(0, nl).toString("utf8").trim();
      conn.buf = conn.buf.subarray(nl + 1);
      detected = "line";
    }

    if (!bodyText) continue;
    let msg: JsonRpcMsg;
    try {
      msg = JSON.parse(bodyText);
    } catch {
      continue; // non-JSON noise on stdout — skip
    }
    if (conn.framing === "unknown") conn.framing = detected;
    if (typeof msg.id !== "number") continue; // notifications / id:null parse-error replies
    const p = conn.pending.get(msg.id);
    if (!p) continue;
    conn.pending.delete(msg.id);
    clearTimeout(p.timer);
    if (p.signal && p.onAbort) p.signal.removeEventListener("abort", p.onAbort);
    p.resolve(msg);
  }
}

function stdioRequest(
  serverId: string,
  conn: StdioConn,
  method: string,
  params: unknown,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<JsonRpcMsg> {
  return new Promise<JsonRpcMsg>((resolve, reject) => {
    if (conn.dead) return reject(new Error("mcp connection closed"));
    const id = conn.nextId++;
    const timer = setTimeout(() => {
      const p = conn.pending.get(id);
      conn.pending.delete(id);
      if (p?.signal && p.onAbort) p.signal.removeEventListener("abort", p.onAbort);
      reject(new Error(`mcp ${method} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    const entry: Pending = { resolve, reject, timer, signal };
    if (signal) {
      const onAbort = () => {
        conn.pending.delete(id);
        clearTimeout(timer);
        reject(new Error("mcp call aborted"));
      };
      entry.onAbort = onAbort;
      if (signal.aborted) return onAbort();
      signal.addEventListener("abort", onAbort, { once: true });
    }
    conn.pending.set(id, entry);
    writeFrame(conn, { jsonrpc: "2.0", id, method, params });
  });
}

function touchIdle(serverId: string, conn: StdioConn): void {
  if (conn.idleTimer) clearTimeout(conn.idleTimer);
  conn.idleTimer = setTimeout(() => {
    if (conn.pending.size === 0) killConn(serverId);
    else touchIdle(serverId, conn); // busy — re-arm
  }, IDLE_KILL_MS);
  conn.idleTimer.unref?.();
}

/* Get (or spawn + handshake) the persistent child for a stdio server. */
async function stdioConn(cfg: McpServerConfig): Promise<StdioConn> {
  const existing = pool.get(cfg.id);
  if (existing && !existing.dead) {
    await existing.ready;
    return existing;
  }
  if (!stdioAllowed()) {
    throw new Error("stdio MCP servers are disabled on this deployment (set MCP_ALLOW_STDIO=1 to allow)");
  }
  if (!cfg.command) throw new Error(`mcp server "${cfg.name}" has no command`);

  // Minimal child env + explicitly named passthrough vars. Values never logged.
  const env: Record<string, string> = {};
  for (const k of ["PATH", "HOME", "LANG"]) if (process.env[k]) env[k] = process.env[k]!;
  for (const name of cfg.env ?? []) {
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && process.env[name] !== undefined) env[name] = process.env[name]!;
  }

  // Default stdio (all pipes); env is the minimal allowlisted set built above.
  const child = spawn(cfg.command, cfg.args ?? [], { cwd: REPO_ROOT, env: env as NodeJS.ProcessEnv });
  const conn: StdioConn = {
    child,
    buf: Buffer.alloc(0),
    pending: new Map(),
    nextId: 1,
    framing: "unknown",
    ready: Promise.resolve(),
    idleTimer: null,
    stderrTail: "",
    dead: false,
  };
  pool.set(cfg.id, conn);

  child.stdout.on("data", (d: Buffer) => {
    conn.buf = Buffer.concat([conn.buf, d]);
    drainStdout(cfg.id, conn);
  });
  child.stderr.on("data", (d: Buffer) => {
    conn.stderrTail = (conn.stderrTail + d.toString("utf8")).slice(-2000);
  });
  const onGone = () => {
    if (pool.get(cfg.id) === conn) killConn(cfg.id); // rejects pending; next call respawns
    conn.dead = true;
  };
  child.on("close", onGone);
  child.on("error", onGone);

  conn.ready = (async () => {
    const t = Math.min(cfg.timeoutMs ?? HANDSHAKE_TIMEOUT_MS, HANDSHAKE_TIMEOUT_MS);
    const init = await stdioRequest(cfg.id, conn, "initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "socheli-soli", version: "0.1.0" },
    }, t);
    rpcResultOrThrow(init, "initialize");
    // Framing is locked now; the initialized notification goes out clean.
    writeFrame(conn, { jsonrpc: "2.0", method: "notifications/initialized" });
  })().catch((e) => {
    const tail = conn.stderrTail.trim();
    killConn(cfg.id);
    throw new Error(`${e instanceof Error ? e.message : String(e)}${tail ? ` — stderr: ${tail.slice(-300)}` : ""}`);
  });

  await conn.ready;
  touchIdle(cfg.id, conn);
  return conn;
}

/* ── http transport: one POST per JSON-RPC request ─────────────────────────── */

type HttpSession = { sessionId?: string; handshake: "pending" | "done" | "unsupported" };
const httpSessions = new Map<string, HttpSession>();
let httpRpcId = 1;

async function httpPost(
  cfg: McpServerConfig,
  payload: Record<string, unknown>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{ msg: JsonRpcMsg | null; sessionId?: string; status: number }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const onAbort = () => ctrl.abort();
  if (signal) {
    if (signal.aborted) ctrl.abort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  try {
    const session = httpSessions.get(cfg.id);
    const res = await fetch(cfg.url!, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(session?.sessionId ? { "mcp-session-id": session.sessionId } : {}),
      },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    const sessionId = res.headers.get("mcp-session-id") ?? undefined;
    const text = await res.text();
    if (!res.ok) {
      return { msg: { error: { code: res.status, message: `HTTP ${res.status}: ${text.slice(0, 300)}` } }, sessionId, status: res.status };
    }
    if (!text.trim()) return { msg: null, sessionId, status: res.status }; // accepted notification
    let body = text.trim();
    if (body.includes("data:") && !body.startsWith("{")) {
      // Tolerate an event-stream response body: take the last data: payload.
      const datas = body.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim());
      body = datas[datas.length - 1] ?? body;
    }
    try {
      return { msg: JSON.parse(body) as JsonRpcMsg, sessionId, status: res.status };
    } catch {
      return { msg: { error: { message: `invalid JSON-RPC response: ${body.slice(0, 200)}` } }, sessionId, status: res.status };
    }
  } catch (e) {
    if (e instanceof Error && e.name === "AbortError") {
      throw new Error(signal?.aborted ? "mcp call aborted" : `mcp http call timed out after ${timeoutMs}ms`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", onAbort);
  }
}

async function httpRequest(
  cfg: McpServerConfig,
  method: string,
  params: unknown,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<unknown> {
  let session = httpSessions.get(cfg.id);
  if (!session || session.handshake === "pending") {
    session = { handshake: "pending" };
    httpSessions.set(cfg.id, session);
    const { msg, sessionId } = await httpPost(cfg, {
      jsonrpc: "2.0",
      id: httpRpcId++,
      method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "socheli-soli", version: "0.1.0" } },
    }, timeoutMs, signal);
    if (msg && !msg.error) {
      session.handshake = "done";
      if (sessionId) session.sessionId = sessionId;
      await httpPost(cfg, { jsonrpc: "2.0", method: "notifications/initialized" }, timeoutMs, signal).catch(() => {});
    } else {
      session.handshake = "unsupported"; // plain JSON-RPC endpoint — call methods directly
    }
  }
  const { msg } = await httpPost(cfg, { jsonrpc: "2.0", id: httpRpcId++, method, params }, timeoutMs, signal);
  if (!msg) throw new Error(`mcp ${method}: empty response`);
  return rpcResultOrThrow(msg, method);
}

/* ── Unified request ───────────────────────────────────────────────────────── */

async function mcpRequest(
  cfg: McpServerConfig,
  method: string,
  params: unknown,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<unknown> {
  if (cfg.transport === "http") return httpRequest(cfg, method, params, timeoutMs, signal);
  const conn = await stdioConn(cfg);
  try {
    const msg = await stdioRequest(cfg.id, conn, method, params, timeoutMs, signal);
    return rpcResultOrThrow(msg, method);
  } finally {
    touchIdle(cfg.id, conn);
  }
}

/* ── Tool discovery (cached 60s) + dispatch ────────────────────────────────── */

const sanitize = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, "_");
export const isMcpToolName = (name: string) => name.startsWith("mcp_");

type ToolsCache = {
  at: number;
  entries: McpToolEntry[];
  byPrefixed: Map<string, McpToolEntry>;
  serverStatus: Map<string, { status: McpServerStatus["status"]; toolCount?: number; error?: string }>;
};
let toolsCache: ToolsCache | null = null;
let toolsPromise: Promise<ToolsCache> | null = null;

async function refreshTools(): Promise<ToolsCache> {
  if (toolsCache && Date.now() - toolsCache.at < TOOLS_CACHE_MS) return toolsCache;
  if (toolsPromise) return toolsPromise;
  toolsPromise = (async () => {
    const cache: ToolsCache = { at: Date.now(), entries: [], byPrefixed: new Map(), serverStatus: new Map() };
    const servers = loadMcpServers();
    await Promise.all(
      servers.map(async (cfg) => {
        if (!cfg.enabled) {
          cache.serverStatus.set(cfg.id, { status: "disabled" });
          return;
        }
        if (cfg.transport === "stdio" && !stdioAllowed()) {
          cache.serverStatus.set(cfg.id, { status: "stdio_blocked", error: "stdio servers disabled (MCP_ALLOW_STDIO unset)" });
          return;
        }
        try {
          const res = (await mcpRequest(cfg, "tools/list", {}, Math.min(cfg.timeoutMs ?? HANDSHAKE_TIMEOUT_MS, HANDSHAKE_TIMEOUT_MS))) as {
            tools?: Array<{ name?: string; description?: string; inputSchema?: Record<string, unknown> }>;
          };
          const tools = Array.isArray(res?.tools) ? res.tools : [];
          for (const t of tools) {
            if (!t?.name || typeof t.name !== "string") continue;
            let prefixed = `mcp_${cfg.id}_${sanitize(t.name)}`;
            let n = 2;
            while (cache.byPrefixed.has(prefixed)) prefixed = `mcp_${cfg.id}_${sanitize(t.name)}_${n++}`; // sanitize collision
            const entry: McpToolEntry = {
              server: cfg.id,
              serverName: cfg.name,
              name: t.name,
              prefixedName: prefixed,
              description: typeof t.description === "string" ? t.description : "",
              inputSchema:
                t.inputSchema && typeof t.inputSchema === "object" ? t.inputSchema : { type: "object", properties: {} },
            };
            cache.entries.push(entry);
            cache.byPrefixed.set(prefixed, entry);
          }
          cache.serverStatus.set(cfg.id, { status: "connected", toolCount: tools.length });
        } catch (e) {
          cache.serverStatus.set(cfg.id, { status: "error", error: e instanceof Error ? e.message : String(e) });
        }
      }),
    );
    toolsCache = cache;
    return cache;
  })().finally(() => {
    toolsPromise = null;
  });
  return toolsPromise;
}

/* All tools advertised by enabled external servers. Never throws — an
   unreachable server simply contributes no tools (its error shows in status). */
export async function listMcpTools(): Promise<McpToolEntry[]> {
  if (loadMcpServers().every((s) => !s.enabled)) return []; // common case: feature unused, zero cost
  try {
    return (await refreshTools()).entries;
  } catch {
    return [];
  }
}

/* Call one tool on one server. Returns the unwrapped MCP result; throws on
   protocol/transport failure (callMcpToolByName folds throws into {ok:false}). */
export async function callMcpTool(
  server: string,
  name: string,
  args: unknown,
  signal?: AbortSignal,
): Promise<unknown> {
  const cfg = loadMcpServers().find((s) => s.id === server);
  if (!cfg) throw new Error(`unknown mcp server: ${server}`);
  if (!cfg.enabled) throw new Error(`mcp server "${cfg.name}" is disabled`);
  const res = (await mcpRequest(cfg, "tools/call", { name, arguments: args ?? {} }, cfg.timeoutMs ?? CALL_TIMEOUT_MS, signal)) as {
    isError?: boolean;
    content?: Array<{ type?: string; text?: string }>;
  };
  // Unwrap the MCP content envelope: join text parts, parse JSON when it is JSON.
  const text = (res?.content ?? [])
    .filter((c) => c?.type === "text" && typeof c.text === "string")
    .map((c) => c.text)
    .join("\n");
  let value: unknown = text;
  try {
    value = text ? JSON.parse(text) : res;
  } catch {
    /* keep raw text */
  }
  if (res?.isError) return { ok: false, error: typeof value === "string" ? value : JSON.stringify(value).slice(0, 4000) };
  return { ok: true, server: cfg.name, tool: name, result: value };
}

/* Dispatch by ADVERTISED name (mcp_<id>_<tool>). Never throws — failures come
   back as { ok:false, error } so the agent turn survives (icog handler style). */
export async function callMcpToolByName(
  prefixedName: string,
  args: unknown,
  signal?: AbortSignal,
): Promise<unknown> {
  try {
    let entry = toolsCache?.byPrefixed.get(prefixedName);
    if (!entry) entry = (await refreshTools()).byPrefixed.get(prefixedName);
    if (!entry) return { ok: false, error: `unknown mcp tool: ${prefixedName}` };
    return await callMcpTool(entry.server, entry.name, args, signal);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/* Per-server status for the settings UI / API (refreshes the 60s cache). */
export async function mcpStatus(): Promise<McpServerStatus[]> {
  const servers = loadMcpServers();
  const cache = servers.some((s) => s.enabled) ? await refreshTools().catch(() => null) : null;
  return servers.map((s) => {
    const st = cache?.serverStatus.get(s.id);
    return {
      id: s.id,
      name: s.name,
      transport: s.transport,
      enabled: s.enabled,
      status: st?.status ?? (s.enabled ? "error" : "disabled"),
      toolCount: st?.toolCount,
      error: st?.error,
    };
  });
}

/* Drop caches (and the pooled child) after a config mutation so the next call
   sees the new config immediately instead of a stale 60s window. */
export function invalidateMcp(serverId?: string): void {
  toolsCache = null;
  if (serverId) {
    killConn(serverId);
    httpSessions.delete(serverId);
  } else {
    for (const id of [...pool.keys()]) killConn(id);
    httpSessions.clear();
  }
}
