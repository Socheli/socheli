import { spawn } from "node:child_process";
import { join } from "node:path";
import { REPO_ROOT } from "../../../lib/data";
import { stampUnowned } from "../../../lib/concepts";
import { currentContext, assertCan, forbidden } from "../../../lib/tenancy";
import { audit } from "../../../lib/audit";

export const dynamic = "force-dynamic";

/* Generate a fresh scored concept board for a channel (runs `content board`). */
export async function POST(req: Request) {
  const ctx = await currentContext();
  try {
    assertCan(ctx, "content.create");
  } catch {
    return forbidden("content.create");
  }
  const body = await req.json().catch(() => ({}));
  const channel = String(body.channel ?? "labrinox");
  const n = String(body.n ?? 5);
  const cli = join(REPO_ROOT, "packages", "engine", "src", "cli.ts");
  const code = await new Promise<number>((resolve) => {
    // Uses the configured brain (OpenRouter on google/gemini-2.5-flash — cheap +
    // reliable enough for the board schema; the weak -lite default was the
    // "propose did nothing" cause). env carries OPENROUTER_MODEL* from .env.
    const child = spawn("node", ["--import", "tsx", cli, "board", "--channel", channel, "--n", n], { cwd: REPO_ROOT, env: process.env });
    child.on("close", (c) => resolve(c ?? 1));
    child.on("error", () => resolve(1));
  });
  if (code !== 0) return Response.json({ error: "board generation failed" }, { status: 500 });
  // The engine (no Clerk) wrote the fresh slate unstamped — claim it for this workspace.
  stampUnowned(ctx);
  audit(ctx, "concept.board", channel, { n: Number(n) });
  return Response.json({ ok: true });
}
