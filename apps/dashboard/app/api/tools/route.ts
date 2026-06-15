import { spawn } from "node:child_process";
import { join } from "node:path";
import { REPO_ROOT } from "../../../lib/data";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/* Canonical tool registry manifest.
   The dashboard must NOT bundle the engine (node-only, tsx-run), so we spawn the
   engine tool runner and return its JSON manifest. */
export async function GET() {
  const runner = join(REPO_ROOT, "packages", "engine", "src", "tool.ts");
  const { code, stdout, stderr } = await run(["--import", "tsx", runner, "--manifest"]);
  if (code !== 0) {
    return Response.json(
      { error: "manifest failed", exitCode: code, detail: (stderr || stdout).trim().slice(0, 4000) },
      { status: 500 },
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return Response.json(
      { error: "invalid manifest json from engine", detail: stdout.trim().slice(0, 4000) },
      { status: 500 },
    );
  }
  return Response.json(parsed);
}

function run(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn("node", args, { cwd: REPO_ROOT, env: process.env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("close", (c) => resolve({ code: c ?? 1, stdout, stderr }));
    child.on("error", (e) => resolve({ code: 1, stdout, stderr: stderr + String(e) }));
  });
}
