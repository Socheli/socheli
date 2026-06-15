import { spawn } from "node:child_process";
import { join } from "node:path";
import { openSync } from "node:fs";
import { REPO_ROOT, getItemFor } from "../../../lib/data";
import { currentContext, ctxCan, forbidden } from "../../../lib/tenancy";
import { audit } from "../../../lib/audit";

export const dynamic = "force-dynamic";

/* Publish a finished item to every configured platform. Detached + fire-and-
   forget because IG/TikTok poll for transcode completion (minutes). Mirrors
   app/api/generate/route.ts. */
export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const id = String(body.id ?? "").trim();
  if (!id) return Response.json({ error: "id required" }, { status: 400 });

  const ctx = await currentContext();
  // The target must live in the caller's workspace (404 otherwise).
  if (!getItemFor(id, ctx.workspaceId)) return new Response("not found", { status: 404 });
  // Publishing is gated by content.publish.
  if (!ctxCan(ctx, "content.publish")) return forbidden("content.publish");

  const cli = join(REPO_ROOT, "packages", "engine", "src", "cli.ts");
  const args = ["--import", "tsx", cli, "publish", id];
  if (body.public === true) args.push("--public");
  if (body.aigc === false) args.push("--no-aigc");

  const out = openSync(join(REPO_ROOT, "data", "publish.log"), "a");
  const child = spawn("node", args, { cwd: REPO_ROOT, detached: true, stdio: ["ignore", out, out], env: process.env });
  child.unref();

  audit(ctx, "content.publish", id, { public: body.public === true });
  return Response.json({ started: true, pid: child.pid });
}
