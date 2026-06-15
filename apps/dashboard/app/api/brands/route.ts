import { listBrands, brandUsage, saveBrand, slugifyBrandId, getBrand } from "../../../lib/brands";
import { currentContext, assertCan, forbidden } from "../../../lib/tenancy";
import { audit } from "../../../lib/audit";

export const dynamic = "force-dynamic";

/* Per-workspace brand registry for the Channels page.
     GET  → list THIS workspace's brands + its plan brand allowance
     POST → create a brand (plan-gated, brand.manage only)
   Reads scope to ctx.workspaceId; mutations gate on `brand.manage` and audit. */

/* List the workspace's brands + the plan's brand allowance. */
export async function GET() {
  const ctx = await currentContext();
  return Response.json({ brands: listBrands(ctx.workspaceId), usage: brandUsage(ctx.workspaceId) });
}

/* Create a brand (plan-gated). Body is a partial ChannelDNA from the wizard;
   we fill an id from the name when absent and apply schema defaults. */
export async function POST(req: Request) {
  const ctx = await currentContext();
  try {
    assertCan(ctx, "brand.manage");
  } catch {
    return forbidden("brand.manage");
  }

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ error: "invalid JSON" }, { status: 400 });
  }
  // derive a unique id from the name if none supplied. Brand ids are global keys
  // in the registry file, so probe across all workspaces to avoid a collision.
  let id = (body.id as string) || slugifyBrandId((body.name as string) || "");
  if (!body.id) {
    let n = id;
    let i = 2;
    while (getBrand(n)) n = `${id}_${i++}`;
    id = n;
  }
  const res = saveBrand({ ...body, id }, "create", ctx);
  if (!res.ok) {
    const status = res.code === "limit" ? 402 : res.code === "exists" ? 409 : res.code === "forbidden" ? 403 : 400;
    return Response.json({ error: res.error, code: res.code }, { status });
  }
  audit(ctx, "brand.create", res.brand!.id, { name: res.brand!.name });
  return Response.json({ brand: res.brand, usage: brandUsage(ctx.workspaceId) }, { status: 201 });
}
