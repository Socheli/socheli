import { spawn } from "node:child_process";
import { join } from "node:path";
import { statSync, createReadStream } from "node:fs";
import { REPO_ROOT } from "../data";
import { LOCAL_TOOLS, localToolHandlers, isLocalTool, type AgentToolCtx } from "./orchestration";
import { ICOG_TOOLS, icogToolHandlers, isIcogTool, isIcogConfigured } from "./icog";
import { listMcpTools, callMcpToolByName, isMcpToolName, type McpToolEntry } from "./mcp";
import { gate, scopeArgs, tenantOrSystem } from "./tenancy";
import { createJob, appendEvent, setStatus, getJob } from "./jobs";
import { parseProgress } from "../progress";

/* Bridge between the dashboard agent and the canonical engine tool registry.
   The dashboard must NOT bundle the engine (node-only, tsx-run), so we spawn
   the engine tool runner exactly like app/api/tools/[name]/route.ts does:
     node --import tsx packages/engine/src/tool.ts --manifest
     node --import tsx packages/engine/src/tool.ts <name> <json>
   and parse its JSON stdout. */

export type ToolKind = "read" | "mutate" | "long";

export type ToolDef = {
  name: string;
  description: string;
  kind: ToolKind;
  inputSchema: Record<string, unknown>;
};

export type OpenAITool = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};

const RUNNER = join(REPO_ROOT, "packages", "engine", "src", "tool.ts");
const MAX_BUFFER = 4 * 1024 * 1024; // 4MB cap on tool output
const DEFAULT_TIMEOUT_MS = 180_000;

let manifestCache: ToolDef[] | null = null;
let manifestPromise: Promise<ToolDef[]> | null = null;

/* Fetch (and in-module cache) the full registry manifest, with any tools from
   user-connected external MCP servers appended (see ./mcp.ts). The engine half
   is cached forever (the registry only changes on deploy); the MCP half is
   re-resolved each call behind mcp.ts's own 60s cache, so connecting a server
   in /settings shows up in Soli within a minute without a restart. */
export async function getToolManifest(): Promise<ToolDef[]> {
  const engine = await getEngineManifest();
  const mcp = await listMcpTools(); // never throws; [] when unconfigured/unreachable
  return mcp.length ? [...engine, ...mcp.map(mcpToolDef)] : engine;
}

/* External MCP tools are advertised under their collision-proof prefixed name
   (mcp_<serverId>_<tool>) and classed "mutate" unless the tool name OBVIOUSLY
   reads (a list/get/read prefix followed by a word break) — gate-safe by
   default: an unmapped mutate falls to the content.create baseline in
   tenancy.permByKind, so members can use connected servers but viewers cannot
   act through them. */
function mcpToolDef(t: McpToolEntry): ToolDef {
  const read = /^(list|get|read)([_\-A-Z]|$)/.test(t.name);
  return {
    name: t.prefixedName,
    description: `[${t.serverName} via MCP] ${t.description || t.name}`,
    kind: read ? "read" : "mutate",
    inputSchema: t.inputSchema ?? { type: "object", properties: {} },
  };
}

/* The engine registry manifest (in-module cache, unchanged behavior). */
async function getEngineManifest(): Promise<ToolDef[]> {
  if (manifestCache) return manifestCache;
  if (manifestPromise) return manifestPromise;
  manifestPromise = (async () => {
    const { code, stdout, stderr } = await runRunner(["--manifest"], DEFAULT_TIMEOUT_MS);
    if (code !== 0) {
      manifestPromise = null;
      throw new Error(`tool manifest failed (exit ${code}): ${(stderr || stdout).trim().slice(0, 2000)}`);
    }
    const text = stdout.trim();
    let parsed: ToolDef[];
    try {
      parsed = JSON.parse(text);
    } catch {
      manifestPromise = null;
      throw new Error(`invalid manifest json from engine: ${text.slice(0, 2000)}`);
    }
    manifestCache = parsed;
    return parsed;
  })();
  return manifestPromise;
}

/* The public read-only DEMO (AUTH_MODE=demo) must not advertise memory/iCog
   tools at all: even when ICOG_API_KEY happens to be present, a first-turn
   message can make the model reach for memory and surface an "iCog not
   configured"/connection error to a visitor. So in demo mode we drop every
   memory/iCog tool (the local memory_/icog_ tools AND any external iCog MCP
   tool) from the advertised set, scoped to demo only; authed behavior is
   unchanged. */
const DEMO_MODE = (process.env.AUTH_MODE ?? "").toLowerCase() === "demo";

/* Name predicate for the memory/iCog family, matched loosely so it also catches
   externally connected iCog MCP tools (advertised as mcp_<serverId>_<tool>,
   e.g. mcp_icog_recall): memory_*, recall/remember/forget/learn/reflect/
   introspect/talk/compose/dream*, and anything mentioning icog/cognitivx. */
function isMemoryTool(name: string): boolean {
  return /(^|_)(memory|icog|cognitivx|recall|remember|forget|learn|reflect|introspect|talk|compose|dream)(_|$)/i.test(
    name,
  );
}

/* Convert the registry manifest to OpenAI function-tool definitions, with the
   LOCAL orchestration tools (team_run / workflow_run / queue_enqueue) merged in
   so the model can call them alongside the 76 engine tools. The iCog memory
   tools are merged in only when iCog is configured (ICOG_API_KEY set), so the
   model never advertises a memory it cannot reach. In the demo, memory/iCog
   tools are dropped entirely (see DEMO_MODE above). */
export function toOpenAITools(manifest: ToolDef[]): OpenAITool[] {
  const engine = manifest.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.inputSchema ?? { type: "object", properties: {} },
    },
  }));
  const icog = !DEMO_MODE && isIcogConfigured() ? ICOG_TOOLS : [];
  const tools = [...LOCAL_TOOLS, ...icog, ...engine];
  // Demo: strip any memory/iCog tool that slipped through (e.g. a connected
  // iCog MCP server) so a visitor's first message can't trigger a memory error.
  return DEMO_MODE ? tools.filter((t) => !isMemoryTool(t.function.name)) : tools;
}

/* Dispatch a tool call: local orchestration tools run in-process (with the
   running job ctx so children attach to the right tree), everything else spawns
   the engine runner. Throws on failure so the graph can fold it into a
   ToolMessage error.

   Tenancy is enforced HERE so no path can skip it:
   - gate(): a mutating tool runs only if the caller's role grants the matching
     permission. On deny we RETURN a structured forbidden result (not throw) so
     the model can explain the refusal and keep the turn alive.
   - scopeArgs(): engine tool calls get the caller's workspaceId/createdBy pinned
     in (reserved fields, always overwritten) so a tool only ever touches data in
     the caller's workspace. Local/icog tools act in-process and read the tenant
     from ctx, so they are not arg-scoped.

   `kinds` is the manifest kind lookup (read/mutate/long); a tool absent from it
   (local/icog) is classed via the explicit maps in tenancy.ts. */
export async function dispatchTool(
  name: string,
  args: unknown,
  ctx: AgentToolCtx,
  signal?: AbortSignal,
  kinds?: Map<string, ToolKind>,
): Promise<unknown> {
  const argsObj = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
  const tenant = tenantOrSystem(ctx.tenant);
  const kind: ToolKind = kinds?.get(name) ?? "mutate";

  // Permission gate (viewer -> read tools only; mutations require the right role).
  const denied = gate(name, kind, tenant);
  if (denied) return denied;

  // iCog memory tools talk to the external CognitiveX API; they take the
  // request AbortSignal directly so a cancelled chat aborts the HTTP call.
  if (isIcogTool(name)) {
    return icogToolHandlers[name](argsObj, signal);
  }
  if (isLocalTool(name)) {
    return localToolHandlers[name](argsObj, ctx);
  }
  // External MCP tools (the "mcp_" prefix is reserved by the manifest merge —
  // no engine tool uses it). NOT arg-scoped: the args go to a foreign server
  // verbatim, where workspaceId/createdBy would be meaningless or leaky.
  // Failures come back as { ok:false, error } so the turn survives a flaky or
  // misconfigured server instead of crashing the graph.
  if (isMcpToolName(name)) {
    return callMcpToolByName(name, argsObj, signal);
  }
  // Engine tools: pin the call to the caller's workspace before spawning.
  const result = await runTool(name, scopeArgs(argsObj, tenant), signal);
  // LONG pipeline tools (generate/longform/render/board/…) spawn a detached
  // engine process and return a {status:"started", logPath, …} descriptor
  // immediately — they write human progress text to logPath but are NOT
  // otherwise tracked. Register a Job + tail the log so they appear LIVE in the
  // Tasks board and persist across navigation. Best-effort: never throws.
  if (kind === "long") bridgeLongToolToJob(name, argsObj, result, ctx);
  return result;
}

/* ---- pipeline long-tool → Job bridge ----------------------------------- */

/* The detached engine processes share a small set of append-only log files
   (data/tool-generate.log, tool-longform.log, tool-rerender.log, …), so two
   concurrent runs write to the SAME file. We snapshot the file's byte length at
   registration time and only ever read PAST that offset, so one job's tailer
   never picks up another run's lines. */

type Started = { status?: unknown; logPath?: unknown; eventsPath?: unknown; itemId?: unknown; id?: unknown; seed?: unknown; topic?: unknown; channel?: unknown };

function asStarted(result: unknown): Started | null {
  if (!result || typeof result !== "object") return null;
  // Engine ToolResult envelope is { ok, data, message }.
  const data = (result as { data?: unknown }).data;
  const d = (data && typeof data === "object" ? data : result) as Started;
  return d.status === "started" ? d : null;
}

const TAIL_INTERVAL_MS = 1500;
const TAIL_TIMEOUT_MS = 60 * 60 * 1000; // 1h ceiling — abandon (leave running) after this
const MAX_TAIL_EVENTS = 2000;

function jobTitleFor(name: string, args: Record<string, unknown>, d: Started): string {
  const seed = typeof d.seed === "string" ? d.seed : typeof args.seed === "string" ? args.seed : undefined;
  const topic = typeof d.topic === "string" ? d.topic : typeof args.topic === "string" ? args.topic : undefined;
  const id = typeof d.id === "string" ? d.id : typeof d.itemId === "string" ? d.itemId : undefined;
  const subject = seed || topic || id;
  const verb = name.replace(/^pipeline_/, "").replace(/_/g, " ");
  return subject ? `${verb}: ${subject}`.slice(0, 90) : verb;
}

function bridgeLongToolToJob(
  name: string,
  args: Record<string, unknown>,
  result: unknown,
  ctx: AgentToolCtx,
): void {
  try {
    const d = asStarted(result);
    if (!d) return;
    const logPath = typeof d.logPath === "string" ? d.logPath : typeof d.eventsPath === "string" ? d.eventsPath : undefined;

    const job = createJob({
      kind: "tool",
      title: jobTitleFor(name, args, d),
      // Attach under the running agent's tree when there is one, else a root.
      parentId: ctx.jobId,
      input: { tool: name, ...(typeof d.id === "string" ? { itemId: d.id } : {}) },
      status: "running",
      tenant: ctx.tenant,
    });
    setStatus(job.id, "running");
    appendEvent(job.id, { type: "log", message: `started · ${name}${logPath ? ` · ${logPath.split("/").pop()}` : ""}` });

    if (!logPath) {
      // No log to tail — leave it running; a later poll/restart reconciles it.
      return;
    }
    startLogTailer(job.id, logPath);
  } catch {
    /* never let task-board tracking break a tool call */
  }
}

/* Tail a shared append-only log from the current byte offset, parsing each new
   line into JobEvents until a terminal marker ("✓ done: <id>" / "■ stopped at")
   or the timeout. parseProgress() turns the render-% / chapter lines into a
   pct the Tasks board renders as a thin bar. */
function startLogTailer(jobId: string, logPath: string): void {
  // Start reading AFTER whatever is already in the shared file.
  let offset = 0;
  try {
    offset = statSync(logPath).size;
  } catch {
    offset = 0; // file not created yet — start from 0 once it appears
  }

  const lines: string[] = []; // accumulated for parseProgress (bounded)
  let carry = ""; // partial trailing line between reads
  let lastPct = -1;
  let emitted = 0;
  const startedAt = Date.now();
  let timer: ReturnType<typeof setInterval> | null = null;

  const stop = () => {
    if (timer) clearInterval(timer);
    timer = null;
  };

  const finish = (status: "succeeded" | "failed", detail?: string) => {
    if (!getJob(jobId) || getJob(jobId)!.status !== "running") {
      stop();
      return;
    }
    setStatus(jobId, status, status === "failed" ? { error: detail } : { result: detail });
    stop();
  };

  const handleLine = (raw: string) => {
    const line = raw.replace(/\r$/, "").trim();
    if (!line) return;
    lines.push(line);
    if (lines.length > 400) lines.splice(0, lines.length - 400);

    // Terminal markers from cli.ts: "✓ done: <id>" / "■ stopped at <status>: <id>".
    if (/^✓\s*done/i.test(line) || /^✓\s*packaged/i.test(line)) {
      appendEvent(jobId, { type: "log", message: line.slice(0, 200) });
      finish("succeeded", line.slice(0, 400));
      return;
    }
    if (/^■\s*stopped/i.test(line) || /\berror\b/i.test(line) && /(fatal|failed|exception)/i.test(line)) {
      appendEvent(jobId, { type: "log", message: line.slice(0, 200) });
      finish("failed", line.slice(0, 400));
      return;
    }

    // Progress: fold the render-%/chapter stream into a single pct + label.
    const p = parseProgress(lines);
    if (p.pct != null && p.pct !== lastPct) {
      lastPct = p.pct;
      // Carry pct on the event so the board can draw a bar without re-parsing.
      appendEvent(jobId, { type: "log", message: p.label, pct: p.pct });
    } else if (emitted < MAX_TAIL_EVENTS && /[:·]/.test(line) === false && line.length > 3) {
      // Stage/phase lines (no percent) — sample them so the rail shows motion
      // without flooding (skip noisy decorated lines).
      appendEvent(jobId, { type: "log", message: line.slice(0, 200) });
    }
    emitted++;
  };

  const readChunk = () => {
    const j = getJob(jobId);
    if (!j || j.status !== "running") {
      stop();
      return;
    }
    if (Date.now() - startedAt > TAIL_TIMEOUT_MS) {
      // Give up tailing but DON'T mark failed — the render may still be going;
      // a server restart would reconcile a truly-dead job.
      appendEvent(jobId, { type: "log", message: "tailer timed out — left running" });
      stop();
      return;
    }
    let size = 0;
    try {
      size = statSync(logPath).size;
    } catch {
      return; // file not there yet
    }
    if (size < offset) offset = 0; // file rotated/truncated
    if (size === offset) return; // nothing new

    const stream = createReadStream(logPath, { start: offset, end: size - 1, encoding: "utf8" });
    let buf = "";
    stream.on("data", (c) => {
      buf += c;
    });
    stream.on("end", () => {
      offset = size;
      const text = carry + buf;
      const parts = text.split("\n");
      carry = parts.pop() ?? ""; // last (possibly partial) line carries forward
      for (const part of parts) handleLine(part);
    });
    stream.on("error", () => {
      /* transient — try again next tick */
    });
  };

  timer = setInterval(readChunk, TAIL_INTERVAL_MS);
  // Kick once immediately so a fast tool shows life before the first interval.
  readChunk();
}

export { type AgentToolCtx };

/* Execute a single registry tool, returning its parsed JSON ToolResult.
   Throws on nonzero exit, empty output, or parse failure. Pass an AbortSignal
   to kill the spawned subprocess when the request is cancelled. */
export async function runTool(name: string, args: unknown, signal?: AbortSignal): Promise<unknown> {
  const inputJson = JSON.stringify(args ?? {});
  const { code, stdout, stderr } = await runRunner([name, inputJson], DEFAULT_TIMEOUT_MS, signal);
  if (code !== 0) {
    throw new Error(`tool "${name}" failed (exit ${code}): ${(stderr || stdout).trim().slice(0, 4000)}`);
  }
  const text = stdout.trim();
  if (!text) throw new Error(`tool "${name}" returned empty output`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`tool "${name}" returned invalid json: ${text.slice(0, 4000)}`);
  }
}

function runRunner(
  toolArgs: string[],
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const args = ["--import", "tsx", RUNNER, ...toolArgs];
  return new Promise((resolve) => {
    const child = spawn("node", args, { cwd: REPO_ROOT, env: process.env });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const onAbort = () => {
      stderr += `\n[runner aborted by client]`;
      child.kill("SIGKILL");
      finish(1);
    };

    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
      resolve({ code, stdout, stderr });
    };

    if (signal) {
      if (signal.aborted) {
        child.kill("SIGKILL");
        // Still resolve via close handler below; kick the abort path now.
        queueMicrotask(onAbort);
      } else {
        signal.addEventListener("abort", onAbort, { once: true });
      }
    }

    const timer = setTimeout(() => {
      stderr += `\n[runner timed out after ${timeoutMs}ms]`;
      child.kill("SIGKILL");
      finish(1);
    }, timeoutMs);

    child.stdout.on("data", (d) => {
      stdout += d.toString();
      if (stdout.length > MAX_BUFFER) {
        stdout = stdout.slice(0, MAX_BUFFER);
        child.kill("SIGKILL");
        finish(1);
      }
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString();
      if (stderr.length > MAX_BUFFER) stderr = stderr.slice(0, MAX_BUFFER);
    });
    child.on("close", (c) => finish(c ?? 1));
    child.on("error", (e) => {
      stderr += String(e);
      finish(1);
    });
  });
}
