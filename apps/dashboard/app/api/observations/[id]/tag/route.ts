import { existsSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "../../../../../lib/data";
import { currentContext, ctxCan, forbidden } from "../../../../../lib/tenancy";
import { audit } from "../../../../../lib/audit";

/* POST /api/observations/:id/tag  { tags: string[] }
   Merges new tags into an observation's tag list.
   Gate: content.create (same as scan — anyone who can generate can tag). */

export const dynamic = "force-dynamic";

const OBS_DIR = join(REPO_ROOT, "data", "observations");
const IDX = join(OBS_DIR, "index.json");

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const ctx = await currentContext();
  if (!ctxCan(ctx, "content.create")) return forbidden("content.create");

  const { id } = await params;
  if (!id || !/^obs_[a-z0-9]+$/i.test(id)) {
    return Response.json({ error: "invalid id" }, { status: 400 });
  }

  let body: { tags?: unknown };
  try {
    body = (await req.json()) as { tags?: unknown };
  } catch {
    return Response.json({ error: "invalid JSON" }, { status: 400 });
  }

  const newTags = Array.isArray(body.tags) ? (body.tags as unknown[]).map(String).filter(Boolean) : [];
  if (!newTags.length) return Response.json({ error: "tags array required" }, { status: 400 });

  const obsPath = join(OBS_DIR, `${id}.json`);
  if (!existsSync(obsPath)) return Response.json({ error: "not found" }, { status: 404 });

  let obs: { tags?: string[] } & Record<string, unknown>;
  try {
    obs = JSON.parse(readFileSync(obsPath, "utf8")) as typeof obs;
  } catch {
    return Response.json({ error: "corrupt observation" }, { status: 500 });
  }

  const merged = [...new Set([...(obs.tags ?? []), ...newTags])];
  obs.tags = merged;
  writeFileSync(obsPath, JSON.stringify(obs, null, 2));

  // Update index entry too
  try {
    if (existsSync(IDX)) {
      const idx = JSON.parse(readFileSync(IDX, "utf8")) as { id: string; tags?: string[] }[];
      const entry = idx.find((o) => o.id === id);
      if (entry) { entry.tags = merged; writeFileSync(IDX, JSON.stringify(idx, null, 2)); }
    }
  } catch {/* non-fatal — index sync is best-effort */}

  audit(ctx, "observation.tag", id, { tags: newTags });
  return Response.json({ id, tags: merged });
}
