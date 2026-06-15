import { spawn } from "node:child_process";
import { join } from "node:path";
import { openSync } from "node:fs";
import { REPO_ROOT, getItemFor } from "../../../lib/data";
import { currentContext, ctxCan, forbidden } from "../../../lib/tenancy";
import { audit } from "../../../lib/audit";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const id = String(body.id ?? "").trim();
  if (!id) return Response.json({ error: "id required" }, { status: 400 });

  const ctx = await currentContext();
  // The target must live in the caller's workspace (404 otherwise).
  if (!getItemFor(id, ctx.workspaceId)) return new Response("not found", { status: 404 });
  // Re-rendering dispatches a render job.
  if (!ctxCan(ctx, "queue.dispatch")) return forbidden("queue.dispatch");

  const script = join(REPO_ROOT, "packages", "engine", "src", "rerender.ts");
  const args = ["--import", "tsx", script, id];
  if (body.voice) args.push("--voice");
  if (body.broll) args.push("--broll");
  if (body.procedural) args.push("--procedural");

  const out = openSync(join(REPO_ROOT, "data", "rerender.log"), "a");
  const child = spawn("node", args, { cwd: REPO_ROOT, detached: true, stdio: ["ignore", out, out], env: process.env });
  child.unref();
  audit(ctx, "queue.dispatch", id, { kind: "rerender" });
  return Response.json({ started: true, pid: child.pid });
}
