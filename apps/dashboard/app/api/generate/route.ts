import { spawn } from "node:child_process";
import { join } from "node:path";
import { openSync } from "node:fs";
import { REPO_ROOT } from "../../../lib/data";
import { currentContext, ctxCan, forbidden } from "../../../lib/tenancy";
import { audit } from "../../../lib/audit";

export const dynamic = "force-dynamic";

/* Generate a post. On the server (fleet enabled) this routes through the Socheli
   API's central scheduler → a capability-matched device renders + syncs back.
   On a local dev box with no fleet, it spawns the engine in-process. */
const fleetEnabled = () => !!process.env.SOCHELI_API_KEY;
const apiBase = () => (process.env.SOCHELI_API_URL || "http://127.0.0.1:8787").replace(/\/$/, "");

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const seed = String(body.seed ?? "").trim();
  const channel = String(body.channel ?? "claude_code_lab");
  // "longform" → a 16:9 multi-chapter YouTube video (engine generateLongform);
  // anything else → a short-form 9:16 post.
  const type = body.type === "longform" ? "longform" : "new";
  if (!seed) return Response.json({ error: "seed required" }, { status: 400 });

  // Dispatching a render job requires queue.dispatch.
  const ctx = await currentContext();
  if (!ctxCan(ctx, "queue.dispatch")) return forbidden("queue.dispatch");

  if (fleetEnabled()) {
    try {
      const r = await fetch(`${apiBase()}/v1/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.SOCHELI_API_KEY}` },
        // Forward the caller's workspace so the engine stamps ownership correctly.
        body: JSON.stringify({ seed, channel, mood: body.mood, voice: body.voice === true, type, workspaceId: ctx.workspaceId }),
      });
      const data = await r.json().catch(() => ({}));
      if (r.ok) audit(ctx, "queue.dispatch", undefined, { seed, channel, type });
      return Response.json(data, { status: r.status });
    } catch (e: any) {
      return Response.json({ error: `api unreachable: ${e?.message ?? e}` }, { status: 502 });
    }
  }

  // local fallback: spawn the engine in-process (dev box, no fleet)
  const cli = join(REPO_ROOT, "packages", "engine", "src", "cli.ts");
  const args =
    type === "longform"
      ? ["--import", "tsx", cli, "longform", seed, "--channel", channel]
      : ["--import", "tsx", cli, "new", seed, "--channel", channel];
  if (type !== "longform" && body.voice === true) args.push("--voice");
  if (type !== "longform" && body.music === false) args.push("--no-music");
  if (body.mood) args.push("--mood", String(body.mood));
  const out = openSync(join(REPO_ROOT, "data", "generate.log"), "a");
  // Pass the caller's workspace to the engine via env so it can stamp ownership
  // (saveItem accepts a workspaceId); the CLI itself has no workspace flag.
  const child = spawn("node", args, { cwd: REPO_ROOT, detached: true, stdio: ["ignore", out, out], env: { ...process.env, SOCHELI_WORKSPACE_ID: ctx.workspaceId } });
  child.unref();
  audit(ctx, "queue.dispatch", undefined, { seed, channel, type });
  return Response.json({ started: true, pid: child.pid });
}
