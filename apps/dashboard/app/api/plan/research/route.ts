import { spawn } from "node:child_process";
import { join } from "node:path";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { REPO_ROOT } from "../../../../lib/data";
import { currentContext, ctxCan, forbidden } from "../../../../lib/tenancy";
import { audit } from "../../../../lib/audit";
import type { PlannedPost } from "../../../../lib/content-plan";

/* Algo-hacking research → content plan, streamed live to the UI.

   Spawns the engine CLI `algo-plan`, which emits one NDJSON line per research
   step (search → ranking signals → platform playbook → scored ideas → schedule),
   and forwards each line to the browser as a Server-Sent Event. The CLI writes
   the committed plan to data/content-plan.json (unless dry), so by the time the
   `done` step arrives the calendar already has the new posts.

   The planner is gated on `plan.run`. The CLI commits posts without a workspace
   (it has no Clerk), so once the run reports its planRunId we re-stamp exactly
   those new posts with the caller's workspaceId + createdBy — that keeps the new
   plan inside the caller's tenant instead of leaking into DEFAULT_WORKSPACE. */

export const dynamic = "force-dynamic";
export const maxDuration = 800;

const PLAN_FILE = join(REPO_ROOT, "data", "content-plan.json");

/* Stamp the posts a given plan run just committed with the caller's tenancy. */
function stampRun(planRunId: string, workspaceId: string, createdBy: string | null) {
  if (!existsSync(PLAN_FILE)) return;
  try {
    const list = JSON.parse(readFileSync(PLAN_FILE, "utf8")) as PlannedPost[];
    let touched = false;
    for (const p of list) {
      if (p.planRunId !== planRunId) continue;
      if (!p.workspaceId || p.workspaceId === "ws_default") {
        p.workspaceId = workspaceId;
        touched = true;
      }
      if (createdBy && !p.createdBy) {
        p.createdBy = createdBy;
        touched = true;
      }
    }
    if (touched) writeFileSync(PLAN_FILE, JSON.stringify(list, null, 2));
  } catch {
    /* leave the plan as the CLI wrote it */
  }
}

export async function POST(req: Request) {
  const ctx = await currentContext();
  if (!ctxCan(ctx, "plan.run")) return forbidden("plan.run");
  const body = await req.json().catch(() => ({}));
  const channel = String(body.channel ?? "labrinox");
  const days = String(Math.max(1, Math.min(60, Number(body.days ?? 14))));
  const time = /^\d{2}:\d{2}$/.test(String(body.time)) ? String(body.time) : "09:00";
  const dry = body.dry === true;
  const platforms = Array.isArray(body.platforms) ? body.platforms.join(",") : "";

  const cli = join(REPO_ROOT, "packages", "engine", "src", "cli.ts");
  const argv = ["--import", "tsx", cli, "algo-plan", "--channel", channel, "--days", days, "--time", time];
  if (platforms) argv.push("--platforms", platforms);
  if (dry) argv.push("--dry");

  const stream = new ReadableStream({
    start(controller) {
      const enc = new TextEncoder();
      let closed = false;
      const safeEnqueue = (s: string) => {
        if (closed) return;
        try {
          controller.enqueue(enc.encode(s));
        } catch {
          closed = true;
        }
      };
      const send = (event: string, data: unknown) => safeEnqueue(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

      // Heartbeat: a long step (e.g. scoring the concept slate) can run 15-30s
      // with no events; without traffic an upstream proxy / the browser drops the
      // stream → "network error". An SSE comment every 10s keeps it alive.
      const heartbeat = setInterval(() => safeEnqueue(`: ping\n\n`), 10_000);
      const finish = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };

      const child = spawn("node", argv, { cwd: REPO_ROOT, env: process.env });
      let buf = "";
      let stderr = "";

      child.stdout.on("data", (chunk: Buffer) => {
        buf += chunk.toString();
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          try {
            const obj = JSON.parse(line) as { step?: unknown; result?: { planRunId?: string; committed?: boolean; count?: number } };
            if (obj.step) send("step", obj.step);
            else if (obj.result) {
              // Re-stamp the just-committed posts into the caller's workspace.
              if (obj.result.committed && obj.result.planRunId && !dry) {
                stampRun(obj.result.planRunId, ctx.workspaceId, ctx.userId);
                audit(ctx, "plan.run", obj.result.planRunId, { channel, days, count: obj.result.count });
              }
              send("result", obj.result);
            }
          } catch {
            /* ignore non-JSON log noise */
          }
        }
      });
      child.stderr.on("data", (c: Buffer) => (stderr += c.toString()));
      child.on("error", (e) => {
        send("error", { message: String(e) });
        finish();
      });
      child.on("close", (code) => {
        if (code !== 0) send("error", { message: `planner exited ${code}`, detail: stderr.slice(-600) });
        send("end", { code });
        finish();
      });
    },
    cancel() {
      // client disconnected — nothing else to do; the child finishes writing the
      // plan to data/content-plan.json regardless (so a dropped UI still commits).
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
