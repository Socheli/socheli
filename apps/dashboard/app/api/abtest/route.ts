import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT, getItemFor, listItemsFor } from "../../../lib/data";
import { currentContext, assertCan, forbidden } from "../../../lib/tenancy";
import { audit } from "../../../lib/audit";
import { ownsRecord } from "@os/schemas";

/* G3 hook A/B testing API.
     GET  ?id=<itemId>   → that item's variants + winner (or 404 if none yet)
     GET  (no id)        → list of A/B tests for the caller's workspace (summary)
     POST {id, count?}   → generate hook variants for an item id (runs the engine)

   Scoped + gated: reads/writes only touch items inside the caller's workspace
   (a test for an item outside the workspace 404s); POST gates on editing that
   item (`content.edit.own`, paired with ownership) and audits on success.
   Persistence lives under data/abtests/<id>.json, written by the engine module
   packages/engine/src/abtest.ts. */

export const dynamic = "force-dynamic";

const ABTEST_DIR = join(REPO_ROOT, "data", "abtests");
const RUNS_DIR = join(REPO_ROOT, "data", "runs");

function readTest(id: string): unknown | null {
  const p = join(ABTEST_DIR, `${id}.json`);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

/* Tests visible to a workspace = tests whose item belongs to that workspace. */
function listTests(workspaceId: string): unknown[] {
  if (!existsSync(ABTEST_DIR)) return [];
  const owned = new Set(listItemsFor(workspaceId).map((it) => it.id));
  return readdirSync(ABTEST_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      try {
        return JSON.parse(readFileSync(join(ABTEST_DIR, f), "utf8"));
      } catch {
        return null;
      }
    })
    .filter((x): x is Record<string, unknown> => !!x && owned.has(String(x.itemId ?? x.id)))
    .sort((a, b) => String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")));
}

export async function GET(req: Request) {
  const ctx = await currentContext();
  const url = new URL(req.url);
  const id = url.searchParams.get("id");
  if (id) {
    // 404 when the item isn't in the caller's workspace (don't leak existence).
    if (!getItemFor(id, ctx.workspaceId)) return Response.json({ error: "not found", id }, { status: 404 });
    const test = readTest(id);
    if (!test) return Response.json({ error: "no a/b test for this item yet", id }, { status: 404 });
    return Response.json(test);
  }
  return Response.json({ tests: listTests(ctx.workspaceId) });
}

export async function POST(req: Request) {
  const ctx = await currentContext();
  const body = await req.json().catch(() => ({}));
  const id = String(body.id ?? "").trim();
  if (!id) return Response.json({ error: "id required" }, { status: 400 });

  // Scope: only act on an item that lives in the caller's workspace.
  const item = getItemFor(id, ctx.workspaceId);
  if (!item || !existsSync(join(RUNS_DIR, `${id}.json`))) {
    return Response.json({ error: "item not found", id }, { status: 404 });
  }
  // Gate: editing this post's hooks requires content edit on a record you own.
  try {
    assertCan(ctx, "content.edit.own", { isOwnerOfRecord: ownsRecord(item, ctx) });
  } catch {
    return forbidden("content.edit.own");
  }

  const count = Math.max(1, Math.min(6, Number(body.count) || 3));
  const tier = ["cheap", "smart", "best"].includes(String(body.tier)) ? String(body.tier) : "smart";

  // Inline driver: load the item from the store, generate variants, print the
  // persisted test as JSON on the last stdout line. Run with tsx so the engine's
  // .ts modules resolve. Mirrors the generate route's `node --import tsx` pattern.
  const driver = `
    import { loadItem } from ${JSON.stringify(join(REPO_ROOT, "packages", "engine", "src", "store.ts"))};
    import { generateVariants } from ${JSON.stringify(join(REPO_ROOT, "packages", "engine", "src", "abtest.ts"))};
    const item = loadItem(${JSON.stringify(id)});
    const { test } = await generateVariants(item, ${count}, ${JSON.stringify(tier)});
    process.stdout.write("\\n__ABTEST_JSON__" + JSON.stringify(test));
  `;

  const res = spawnSync("node", ["--import", "tsx", "--input-type=module", "-"], {
    cwd: REPO_ROOT,
    input: driver,
    env: process.env,
    encoding: "utf8",
    timeout: 1000 * 240,
    maxBuffer: 1 << 25,
  });

  if (res.status !== 0) {
    return Response.json(
      { error: "generation failed", detail: (res.stderr || res.stdout || "").slice(-800) },
      { status: 500 },
    );
  }

  audit(ctx, "abtest.generate", id, { count, tier });

  const marker = "__ABTEST_JSON__";
  const idx = (res.stdout || "").lastIndexOf(marker);
  if (idx < 0) {
    // Generation ran but we couldn't parse a result line — fall back to the file.
    const test = readTest(id);
    if (test) return Response.json(test);
    return Response.json({ error: "no result", detail: (res.stdout || "").slice(-800) }, { status: 500 });
  }
  try {
    return Response.json(JSON.parse(res.stdout.slice(idx + marker.length).trim()));
  } catch {
    const test = readTest(id);
    if (test) return Response.json(test);
    return Response.json({ error: "unparseable result" }, { status: 500 });
  }
}
