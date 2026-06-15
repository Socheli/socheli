import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { currentContext } from "../../../../../../lib/tenancy";
import { getMissionFor, agentTaskLogPath } from "../../../../../../lib/missions";

/* Read at most the trailing `maxBytes` of a file without loading the whole thing.
   A long-running task's JSONL is mostly token-delta lines (dropped below) and can
   reach many megabytes — reading the full file every ~3.5s poll is O(filesize)
   for an O(tail) need. We open, seek to (size - window), and read forward, so
   each poll is constant-time regardless of how long the task has run.

   The first (possibly partial) line is discarded by the caller when the window
   started mid-file, since seeking by byte offset can split a UTF-8 line. */
function readTail(path: string, maxBytes: number): { text: string; truncated: boolean } {
  const size = statSync(path).size;
  const start = Math.max(0, size - maxBytes);
  const len = size - start;
  if (len <= 0) return { text: "", truncated: false };
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.allocUnsafe(len);
    let read = 0;
    // readSync may return short; loop until the window is filled (or EOF).
    while (read < len) {
      const n = readSync(fd, buf, read, len - read, start + read);
      if (n <= 0) break;
      read += n;
    }
    return { text: buf.toString("utf8", 0, read), truncated: start > 0 };
  } finally {
    closeSync(fd);
  }
}

/* Live task feed — the dashboard equivalent of the engine's mission_task_log
   tool. Mission task ids double as harness agent-task ids, so this returns the
   task's queue record (status / usd / result summary) plus the trailing JSONL
   agent events from data/agent/<taskId>.jsonl. A plain file tail (no engine
   spawn) because the board polls this every ~3s while a task runs.

     GET ?tail=150        → last N meaningful events (token deltas dropped)
     GET ?tail=150&tokens=1 → include raw token events

   Tenancy: the parent mission must live in the caller's workspace (404
   otherwise), and the task must be on that mission's queue — so one workspace
   can never tail another's agent logs by guessing task ids. */

export const dynamic = "force-dynamic";

export async function GET(req: Request, ctxArg: { params: Promise<{ id: string; taskId: string }> }) {
  const { id, taskId } = await ctxArg.params;
  const ctx = await currentContext();

  const mission = getMissionFor(id, ctx.workspaceId);
  if (!mission) return Response.json({ error: "not found" }, { status: 404 });
  const task = mission.queue.find((t) => t.id === taskId);
  if (!task) return Response.json({ error: "task not found" }, { status: 404 });

  const url = new URL(req.url);
  const tail = Math.max(1, Math.min(500, Number(url.searchParams.get("tail")) || 150));
  const withTokens = url.searchParams.get("tokens") === "1";

  const path = agentTaskLogPath(taskId);
  let events: unknown[] = [];
  let totalEvents = 0;
  if (existsSync(path)) {
    // Window the tail so each poll is constant-time. Sized to comfortably hold
    // the last ~150 meaningful events even when interleaved with token deltas;
    // when the file is smaller than the window the whole file is read.
    const { text, truncated } = readTail(path, 128 * 1024);
    let lines = text.split("\n").filter(Boolean);
    // A byte-offset window can land mid-line — drop the first fragment so we
    // never feed a half-line to JSON.parse (only when we actually truncated).
    if (truncated && lines.length) lines = lines.slice(1);
    const parsed = lines.map((l) => {
      try {
        return JSON.parse(l) as { type?: string };
      } catch {
        return { type: "raw", line: l };
      }
    });
    // Token deltas flood the tail and mean nothing row-by-row — drop them
    // unless explicitly asked, so `tail` counts real steps/tool calls.
    const meaningful = withTokens ? parsed : parsed.filter((e) => e.type !== "token");
    // `totalEvents` is the meaningful-event count WITHIN the tail window (we no
    // longer scan the whole file); it stays >= events.length for the UI counter.
    totalEvents = meaningful.length;
    events = meaningful.slice(-tail);
  }

  return Response.json({ task, events, totalEvents });
}
