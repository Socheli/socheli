import { spawn } from "node:child_process";
import { mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "../../../lib/data";
import { currentContext, ctxCan, forbidden } from "../../../lib/tenancy";
import { audit } from "../../../lib/audit";

/* Creative Lab scan API.
   POST { url, channel?, tags? }
     → starts engine `content scan <url>` as a detached worker
     → returns { id (pre-allocated), status: "started" } immediately

   The engine worker writes to data/observations/<id>.json as it progresses.
   The client polls GET /api/observations/<id> to check completion.

   Gate: content.create (same tier as generating a post). */

export const dynamic = "force-dynamic";

/* Validates that the URL looks like a plausible IG / YT / TT link. */
function isValidContentUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return ["https:", "http:"].includes(u.protocol) && u.hostname.length > 2;
  } catch {
    return false;
  }
}

export async function POST(req: Request) {
  const ctx = await currentContext();
  if (!ctxCan(ctx, "content.create")) return forbidden("content.create");

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ error: "invalid JSON" }, { status: 400 });
  }

  const url = String(body.url ?? "").trim();
  const channel = String(body.channel ?? "").trim();
  const tagsRaw = Array.isArray(body.tags) ? (body.tags as unknown[]).map(String) : [];

  if (!url || !isValidContentUrl(url)) {
    return Response.json({ error: "url must be a valid Instagram, YouTube, or TikTok link" }, { status: 400 });
  }
  if (channel && !/^[a-zA-Z0-9_-]{1,64}$/.test(channel)) {
    return Response.json({ error: "invalid channel id" }, { status: 400 });
  }

  // Pre-allocate an id that matches the engine's obs_<base36ts><rand> shape
  const id = `obs_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

  const cliPath = join(REPO_ROOT, "packages", "engine", "src", "cli.ts");
  const args = ["--import", "tsx", cliPath, "scan", url, "--id", id];
  if (channel) args.push("--channel", channel);
  if (tagsRaw.length) args.push("--tags", tagsRaw.join(","));

  try {
    mkdirSync(join(REPO_ROOT, "data", "observations"), { recursive: true });
    const logPath = join(REPO_ROOT, "data", `scan-${id}.log`);
    const out = openSync(logPath, "a");
    const child = spawn("node", args, {
      cwd: REPO_ROOT,
      detached: true,
      stdio: ["ignore", out, out],
      env: process.env,
    });
    child.unref();
  } catch (e) {
    return Response.json(
      { error: `failed to start scan worker: ${e instanceof Error ? e.message : String(e)}` },
      { status: 500 }
    );
  }

  audit(ctx, "observation.scan", id, { url: url.slice(0, 200), channel: channel || undefined });
  return Response.json({ id, status: "started" });
}
