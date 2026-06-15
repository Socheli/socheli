import "server-only";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "./data";

/* Dashboard read-view + engine bridge for the AI DM console. Reads the same flat
   stores the engine owns (data/dms/<ch>/threads.json + data/ai-dm/<ch>.json),
   and routes AI generation / sends / auto-toggles through the canonical tool
   runner (the lib/inbox.ts pattern). Sending is gated server-side in the route;
   the engine's sendMessage enforces the kill-switch + 24h window regardless. */

const sani = (c: string) => (c || "global").replace(/[^a-zA-Z0-9_-]/g, "-");
const threadsFile = (ch: string) => join(REPO_ROOT, "data", "dms", sani(ch), "threads.json");
const autoFile = (ch: string) => join(REPO_ROOT, "data", "ai-dm", `${sani(ch)}.json`);

function readJson<T>(path: string, fallback: T): T {
  try {
    return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as T) : fallback;
  } catch {
    return fallback;
  }
}

export type AiDmMessage = { id: string; text: string; direction: "in" | "out"; timestamp?: string };
type Thread = { conversationId: string; participantUsername?: string; lastInboundAt?: string; messages: AiDmMessage[] };

export type AiDmThread = {
  channel: string;
  conversationId: string;
  username?: string;
  lastMessage: string;
  needsReply: boolean;
  windowOpen: boolean;
  hoursSinceInbound?: number;
  auto: boolean;
  messageCount: number;
};

function autoMap(channel: string): Record<string, boolean> {
  return readJson<{ auto?: Record<string, boolean> }>(autoFile(channel), {}).auto ?? {};
}

export function threadsFor(channel: string): AiDmThread[] {
  const threads = readJson<Thread[]>(threadsFile(channel), []);
  const auto = autoMap(channel);
  return threads
    .map((t) => {
      const last = t.messages[t.messages.length - 1];
      const hrs = t.lastInboundAt ? (Date.now() - new Date(t.lastInboundAt).getTime()) / 3_600_000 : undefined;
      return {
        channel,
        conversationId: t.conversationId,
        username: t.participantUsername,
        lastMessage: last?.text ?? "",
        needsReply: last?.direction === "in",
        windowOpen: hrs === undefined ? true : hrs <= 24,
        hoursSinceInbound: hrs === undefined ? undefined : Math.round(hrs),
        auto: !!auto[t.conversationId],
        messageCount: t.messages.length,
      };
    })
    .sort((a, b) => Number(b.needsReply) - Number(a.needsReply));
}

export function messagesFor(channel: string, conversationId: string): AiDmMessage[] {
  const t = readJson<Thread[]>(threadsFile(channel), []).find((x) => x.conversationId === conversationId);
  return t?.messages ?? [];
}

export type ToolResult = { ok: boolean; data?: Record<string, unknown>; message?: string };

const AIDM_TOOLS = new Set(["aidm_pull", "aidm_reply", "aidm_set_auto", "aidm_auto_sweep", "dm_send", "dm_draft"]);

export function runAiDmTool(name: string, input: Record<string, unknown>): Promise<ToolResult> {
  if (!AIDM_TOOLS.has(name)) return Promise.resolve({ ok: false, message: `not an ai-dm tool: ${name}` });
  const runner = join(REPO_ROOT, "packages", "engine", "src", "tool.ts");
  return new Promise((resolve) => {
    const child = spawn("node", ["--import", "tsx", runner, name, JSON.stringify(input)], { cwd: REPO_ROOT, env: process.env });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (err += d.toString()));
    child.on("error", (e) => resolve({ ok: false, message: String(e) }));
    child.on("close", () => {
      try {
        resolve(JSON.parse(out.trim()) as ToolResult);
      } catch {
        resolve({ ok: false, message: (err || out).trim().slice(0, 2000) || "engine produced no output" });
      }
    });
  });
}
