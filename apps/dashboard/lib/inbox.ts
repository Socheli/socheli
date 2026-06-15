import "server-only";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "./data";

/* The dashboard's READ view of the community inbox stores (data/comments/<ch>,
   data/dms/<ch>) — the same flat-JSON files the engine's comments.ts/dms.ts own.
   Reads happen here directly (the lib/missions.ts pattern); every MUTATION goes
   through the engine via the canonical tool runner so the gate + Graph logic is
   never re-implemented. Sending a reply is the human-gated action (comment_send
   / dm_send), mirroring the publish gate. */

const sani = (c: string) => (c || "global").replace(/[^a-zA-Z0-9_-]/g, "-");
const commentsDir = (ch: string) => join(REPO_ROOT, "data", "comments", sani(ch));
const dmsDir = (ch: string) => join(REPO_ROOT, "data", "dms", sani(ch));

function readJson<T>(path: string, fallback: T): T {
  try {
    return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as T) : fallback;
  } catch {
    return fallback;
  }
}

export type InboxComment = { channel: string; id: string; text: string; username?: string; permalink?: string; hidden?: boolean; draft?: string };
export type InboxDm = { channel: string; conversationId: string; username?: string; lastMessage: string; windowOpen: boolean; hoursSinceInbound?: number; draft?: string };

type Snap = { mediaId: string; permalink?: string; comments: { id: string; text: string; username?: string; hidden?: boolean }[] };
type CDraft = { commentId: string; reply: string; status: string };
type Thread = { conversationId: string; participantUsername?: string; lastInboundAt?: string; messages: { text: string; direction: string }[] };
type DDraft = { conversationId: string; reply: string; status: string };

/** Comments for one channel, split into the triage queue (unanswered) and the
    pending-approval queue (drafted, awaiting human send). */
export function commentsFor(channel: string): { triage: InboxComment[]; pending: InboxComment[] } {
  const snaps = readJson<Snap[]>(join(commentsDir(channel), "snapshots.json"), []);
  const drafts = readJson<CDraft[]>(join(commentsDir(channel), "drafts.json"), []);
  const draftBy = new Map(drafts.filter((d) => d.status === "pending").map((d) => [d.commentId, d.reply]));
  const triage: InboxComment[] = [];
  const pending: InboxComment[] = [];
  for (const s of snaps) {
    for (const c of s.comments) {
      const row: InboxComment = { channel, id: c.id, text: c.text, username: c.username, permalink: s.permalink, hidden: c.hidden };
      if (draftBy.has(c.id)) pending.push({ ...row, draft: draftBy.get(c.id) });
      else triage.push(row);
    }
  }
  return { triage, pending };
}

/** DM threads for one channel, split into triage (last message inbound, no
    draft) and pending (drafted, awaiting send), with the 24h window state. */
export function dmsFor(channel: string): { triage: InboxDm[]; pending: InboxDm[] } {
  const threads = readJson<Thread[]>(join(dmsDir(channel), "threads.json"), []);
  const drafts = readJson<DDraft[]>(join(dmsDir(channel), "drafts.json"), []);
  const draftBy = new Map(drafts.filter((d) => d.status === "pending").map((d) => [d.conversationId, d.reply]));
  const triage: InboxDm[] = [];
  const pending: InboxDm[] = [];
  for (const t of threads) {
    const last = t.messages[t.messages.length - 1];
    const hours = t.lastInboundAt ? (Date.now() - new Date(t.lastInboundAt).getTime()) / 3_600_000 : undefined;
    const row: InboxDm = {
      channel,
      conversationId: t.conversationId,
      username: t.participantUsername,
      lastMessage: last?.text ?? "",
      windowOpen: hours === undefined ? true : hours <= 24,
      hoursSinceInbound: hours === undefined ? undefined : Math.round(hours),
    };
    if (draftBy.has(t.conversationId)) pending.push({ ...row, draft: draftBy.get(t.conversationId) });
    else if (last?.direction === "in") triage.push(row);
  }
  return { triage, pending };
}

/* ── Engine bridge for mutations (pull / draft / send / hide) ───────────────
   The dashboard must NOT bundle the node-only engine; mutations spawn the
   canonical tool runner, exactly like lib/missions.ts runMissionTool. */

export type ToolResult = { ok: boolean; data?: Record<string, unknown>; message?: string };

const INBOX_TOOLS = new Set([
  "comments_pull",
  "comment_draft",
  "comment_send",
  "comment_hide",
  "dm_pull",
  "dm_draft",
  "dm_send",
]);

export function runInboxTool(name: string, input: Record<string, unknown>): Promise<ToolResult> {
  if (!INBOX_TOOLS.has(name)) return Promise.resolve({ ok: false, message: `not an inbox tool: ${name}` });
  const runner = join(REPO_ROOT, "packages", "engine", "src", "tool.ts");
  return new Promise((resolve) => {
    const child = spawn("node", ["--import", "tsx", runner, name, JSON.stringify(input)], { cwd: REPO_ROOT, env: process.env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", (e) => resolve({ ok: false, message: String(e) }));
    child.on("close", () => {
      try {
        resolve(JSON.parse(stdout.trim()) as ToolResult);
      } catch {
        resolve({ ok: false, message: (stderr || stdout).trim().slice(0, 2000) || "engine produced no output" });
      }
    });
  });
}
