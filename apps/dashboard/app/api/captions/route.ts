import { spawn } from "node:child_process";
import { join } from "node:path";
import { REPO_ROOT } from "../../../lib/data";

export const dynamic = "force-dynamic";

/* Regenerate per-platform captions/hashtags for an item (runs `content package <id>`). */
export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const id = String(body.id ?? "").trim();
  if (!id) return Response.json({ error: "id required" }, { status: 400 });

  const cli = join(REPO_ROOT, "packages", "engine", "src", "cli.ts");
  let stderr = "";
  const code = await new Promise<number>((resolve) => {
    const child = spawn("node", ["--import", "tsx", cli, "package", id], { cwd: REPO_ROOT, env: process.env });
    child.stderr?.on("data", (d) => (stderr += d.toString()));
    child.on("close", (c) => resolve(c ?? 1));
    child.on("error", (e) => { stderr += String(e?.message ?? e); resolve(1); });
  });
  if (code !== 0) {
    // Surface the engine's own message (e.g. "not enough content…") so the UI can
    // show why nothing happened instead of silently failing.
    const msg = stderr.trim().split("\n").pop() || "packaging failed";
    return Response.json({ error: msg }, { status: 500 });
  }
  return Response.json({ ok: true });
}
