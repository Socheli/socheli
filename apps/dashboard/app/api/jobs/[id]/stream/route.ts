import { getJobFor, type JobRow } from "../../../../../lib/fleet";
import { currentContext } from "../../../../../lib/tenancy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/* SSE progress stream for one fleet job, scoped to the caller's workspace.
   The bridge writes job state to data/jobs.json (no in-process emitter), so we
   poll the file: replay everything recorded so far, then emit new progress lines
   + status changes. Closes when the job reaches a terminal status or the client
   disconnects. Frames: "data: <json>\n\n". (404 cross-workspace.) */

const SSE_HEADERS = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
};

const isTerminal = (status: string) => status === "done" || status === "error";
const frame = (ev: unknown) => `data: ${JSON.stringify(ev)}\n\n`;

export async function GET(req: Request, ctxp: { params: Promise<{ id: string }> }): Promise<Response> {
  const ctx = await currentContext();
  const { id } = await ctxp.params;
  const initial = getJobFor(id, ctx.workspaceId);
  if (!initial) return Response.json({ error: "job not found" }, { status: 404 });

  const encoder = new TextEncoder();
  const signal = req.signal;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      let poll: ReturnType<typeof setInterval> | null = null;
      let heartbeat: ReturnType<typeof setInterval> | null = null;
      let sentProgress = 0; // how many progress lines already streamed
      let lastStatus: JobRow["status"] | "" = "";

      const safeEnqueue = (chunk: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          closed = true;
        }
      };

      const close = () => {
        if (closed) return;
        closed = true;
        if (poll) clearInterval(poll);
        if (heartbeat) clearInterval(heartbeat);
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };

      // Emit any new progress lines + a status change since the last tick.
      const flush = (job: JobRow) => {
        if (job.status !== lastStatus) {
          lastStatus = job.status;
          safeEnqueue(frame({ type: "status", status: job.status, device: job.device, itemId: job.itemId, message: job.message }));
        }
        const fresh = job.progress.slice(sentProgress);
        for (const p of fresh) safeEnqueue(frame({ type: "progress", ...p }));
        sentProgress = job.progress.length;
        if (isTerminal(job.status)) close();
      };

      // 1) Replay everything recorded so far.
      flush(initial);
      if (closed) return;

      // 2) Poll the bridge file for new lines / terminal status.
      poll = setInterval(() => {
        if (closed) return;
        const job = getJobFor(id, ctx.workspaceId);
        if (!job) {
          close();
          return;
        }
        flush(job);
      }, 1500);

      // Keep the connection warm during quiet periods.
      heartbeat = setInterval(() => {
        if (closed) return;
        safeEnqueue(":keepalive\n\n");
      }, 15_000);

      signal.addEventListener("abort", close, { once: true });
    },
  });

  return new Response(stream, { headers: SSE_HEADERS });
}
