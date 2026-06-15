import { DEFAULT_WORKSPACE } from "@os/schemas";
import { getJob, subscribe, type Job, type JobEvent } from "../../../../../../lib/agent/jobs";
import { currentContext } from "../../../../../../lib/tenancy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/* SSE stream for one job. Replays all events recorded so far, then streams live
   events via the per-job EventEmitter. Closes when the job reaches a terminal
   status or the client disconnects. Frames: "data: <json>\n\n".
   Scoped: a job outside the caller's workspace reads as 404. */

function jobWorkspace(job: Job): string {
  return job.tenant?.workspaceId || DEFAULT_WORKSPACE;
}

const SSE_HEADERS = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
};

function frame(ev: JobEvent): string {
  return `data: ${JSON.stringify(ev)}\n\n`;
}

function isTerminal(status: string): boolean {
  return status === "succeeded" || status === "failed" || status === "canceled";
}

export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const tenant = await currentContext();
  const { id } = await ctx.params;
  const job = getJob(id);
  if (!job || jobWorkspace(job) !== tenant.workspaceId) {
    return Response.json({ error: "job not found" }, { status: 404 });
  }

  const encoder = new TextEncoder();
  const signal = req.signal;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      let unsub: (() => void) | null = null;
      let heartbeat: ReturnType<typeof setInterval> | null = null;

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
        if (heartbeat) clearInterval(heartbeat);
        if (unsub) unsub();
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };

      // 1) Replay everything recorded so far.
      for (const ev of job.events) safeEnqueue(frame(ev));

      // If the job is already terminal, send a final status and close.
      const current = getJob(id);
      if (current && isTerminal(current.status)) {
        safeEnqueue(frame({ t: Date.now(), type: "status", status: current.status }));
        close();
        return;
      }

      // 2) Stream live events; close when the job reaches a terminal status.
      unsub = subscribe(id, (ev) => {
        safeEnqueue(frame(ev));
        if (ev.type === "status" && ev.status && isTerminal(ev.status)) {
          close();
        }
      });

      // Keep the connection warm and detect dead clients during quiet periods
      // (e.g. a slow engine tool that emits nothing for a while).
      heartbeat = setInterval(() => {
        if (closed) return;
        safeEnqueue(":keepalive\n\n");
        if (closed) close();
      }, 15_000);

      signal.addEventListener("abort", close, { once: true });
    },
    cancel() {
      /* client disconnected; subscribe cleanup happens in close() via abort */
    },
  });

  return new Response(stream, { headers: SSE_HEADERS });
}
