import { spawn } from "node:child_process";
import { join } from "node:path";
import { REPO_ROOT } from "../../../../lib/data";
import { currentContext, assertCan, forbidden } from "../../../../lib/tenancy";
import { audit } from "../../../../lib/audit";

/* "Prompt on it": run a freeform brainstorm for a calendar day. Spawns the engine
   CLI `brainstorm`, which prints a JSON object of on-brand ideas. A planning
   action — gated on `plan.run` and audited. */

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function POST(req: Request) {
  const ctx = await currentContext();
  try {
    assertCan(ctx, "plan.run");
  } catch {
    return forbidden("plan.run");
  }
  const b = await req.json().catch(() => ({}));
  const prompt = String(b.prompt ?? "").trim();
  if (!prompt) return Response.json({ error: "prompt required" }, { status: 400 });
  const channel = String(b.channel ?? "");
  const date = String(b.date ?? "");
  const n = String(Math.max(1, Math.min(8, Number(b.n ?? 5))));

  const cli = join(REPO_ROOT, "packages", "engine", "src", "cli.ts");
  const argv = ["--import", "tsx", cli, "brainstorm", prompt, "--n", n];
  if (channel) argv.push("--channel", channel);
  if (date) argv.push("--date", date);

  const out = await new Promise<string>((resolve) => {
    const child = spawn("node", argv, { cwd: REPO_ROOT, env: process.env });
    let s = "";
    child.stdout.on("data", (d: Buffer) => (s += d.toString()));
    child.on("close", () => resolve(s));
    child.on("error", () => resolve(""));
  });

  // The CLI prints one JSON object; take the last JSON-looking line.
  const line = out.trim().split("\n").reverse().find((l) => l.trim().startsWith("{"));
  if (!line) return Response.json({ error: "brainstorm failed", ideas: [] }, { status: 500 });
  try {
    const parsed = JSON.parse(line) as { ideas?: unknown };
    audit(ctx, "calendar.prompt", date || channel || undefined, { prompt: prompt.slice(0, 120), n });
    return Response.json({ ok: true, ideas: parsed.ideas ?? [] });
  } catch {
    return Response.json({ error: "bad brainstorm output", ideas: [] }, { status: 500 });
  }
}
