import { spawn } from "node:child_process";
import { join } from "node:path";
import { REPO_ROOT } from "../../../../lib/data";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/* Execute a single canonical tool by name with the JSON request body as input.
   The dashboard must NOT bundle the engine (node-only, tsx-run), so we spawn the
   engine tool runner: node --import tsx packages/engine/src/tool.ts <name> <json>
   and return its JSON result. */
export async function POST(req: Request, ctx: { params: Promise<{ name: string }> } | { params: { name: string } }) {
  const params = await (ctx as { params: Promise<{ name: string }> }).params;
  const name = String(params?.name ?? "").trim();
  if (!name) return Response.json({ error: "tool name required" }, { status: 400 });

  const body = await req.json().catch(() => ({}));
  const inputJson = JSON.stringify(body ?? {});

  const runner = join(REPO_ROOT, "packages", "engine", "src", "tool.ts");
  const { code, stdout, stderr } = await run(["--import", "tsx", runner, name, inputJson]);

  // The runner prints a JSON ToolResult on stdout EVEN when the tool returns
  // ok:false (it then exits non-zero). Prefer that structured result over a
  // generic wrapper so the real reason — e.g. a validation message — reaches the
  // client instead of an opaque "tool failed".
  const text = stdout.trim();
  if (text) {
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === "object" && "ok" in parsed) {
        // 200 on success; 422 carries the tool's own ok:false message through.
        return Response.json(parsed, { status: parsed.ok ? 200 : 422 });
      }
    } catch {
      /* not a JSON ToolResult — fall through to the error wrappers below */
    }
  }

  if (code !== 0) {
    return Response.json(
      { error: "tool failed", tool: name, exitCode: code, detail: (stderr || stdout).trim().slice(0, 8000) },
      { status: 500 },
    );
  }
  if (!text) return Response.json({ error: "empty result from engine", tool: name }, { status: 500 });
  return Response.json(
    { error: "invalid json from engine", tool: name, detail: text.slice(0, 8000) },
    { status: 500 },
  );
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
