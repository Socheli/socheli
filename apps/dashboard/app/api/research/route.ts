import { spawn } from "node:child_process";
import { mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "../../../lib/data";
import { listResearch, RESEARCH_DEPTHS, RESEARCH_KINDS } from "../../../lib/research";
import { currentContext, ctxCan, forbidden } from "../../../lib/tenancy";
import { audit } from "../../../lib/audit";

/* Research harness API.
     GET  [?kind=&channel=]  → this workspace's research runs (index, enriched)
     POST {query, kind?, depth?, channel?} → start a verified research run

   POST mirrors the `research_run` registry tool exactly: pre-allocate the run
   id, spawn the engine's detached worker (research/run-cli.ts) and return the
   id immediately — the run page then polls GET /api/research/<id> while the
   worker persists steps/sources/claims/report at every milestone. The worker
   outlives this request on purpose: research keeps going if the tab closes.

   Starting research is gated on `plan.run` (it's the same class of paid,
   strategy-feeding compute as the algo planner); reads are open to any member
   of the workspace. Runs are stamped --workspace/--by so they stay inside the
   caller's tenant. */

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const ctx = await currentContext();
  const url = new URL(req.url);
  const kind = url.searchParams.get("kind") ?? undefined;
  const channel = url.searchParams.get("channel") ?? undefined;
  return Response.json({ runs: listResearch(ctx.workspaceId, { kind, channel }) });
}

export async function POST(req: Request) {
  const ctx = await currentContext();
  if (!ctxCan(ctx, "plan.run")) return forbidden("plan.run");

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ error: "invalid JSON" }, { status: 400 });
  }

  const query = String(body.query ?? "").trim().replace(/\s+/g, " ");
  const kind = String(body.kind ?? "topic");
  const depth = String(body.depth ?? "standard");
  const channel = String(body.channel ?? "").trim();

  if (query.length < 3 || query.length > 400)
    return Response.json({ error: "query must be 3–400 characters" }, { status: 400 });
  if (!(RESEARCH_KINDS as readonly string[]).includes(kind))
    return Response.json({ error: `kind must be one of ${RESEARCH_KINDS.join(", ")}` }, { status: 400 });
  if (!(RESEARCH_DEPTHS as readonly string[]).includes(depth))
    return Response.json({ error: `depth must be one of ${RESEARCH_DEPTHS.join(", ")}` }, { status: 400 });
  if (channel && !/^[a-zA-Z0-9_-]{1,64}$/.test(channel))
    return Response.json({ error: "invalid channel id" }, { status: 400 });

  // Pre-allocate the run id (same shape as the engine's newResearchId) so the
  // composer can redirect to /research/<id> while the worker is still booting.
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
  const id = `res_${kind}_${stamp}_${Math.random().toString(36).slice(2, 6)}`;

  const worker = join(REPO_ROOT, "packages", "engine", "src", "research", "run-cli.ts");
  const args = ["--import", "tsx", worker, query, "--kind", kind, "--depth", depth, "--id", id, "--workspace", ctx.workspaceId];
  if (ctx.userId) args.push("--by", ctx.userId);
  if (channel) args.push("--channel", channel);

  try {
    // Same detached-spawn shape as the research_run tool: log to data/, unref,
    // return immediately. The run JSON under data/research/ is the live state.
    mkdirSync(join(REPO_ROOT, "data"), { recursive: true });
    const out = openSync(join(REPO_ROOT, "data", `tool-research-${id}.log`), "a");
    const child = spawn("node", args, { cwd: REPO_ROOT, detached: true, stdio: ["ignore", out, out], env: process.env });
    child.unref();
  } catch (e) {
    return Response.json({ error: `failed to start research worker: ${e instanceof Error ? e.message : String(e)}` }, { status: 500 });
  }

  audit(ctx, "research.run", id, { kind, depth, channel: channel || undefined, query: query.slice(0, 140) });
  return Response.json({ id, status: "started" });
}
