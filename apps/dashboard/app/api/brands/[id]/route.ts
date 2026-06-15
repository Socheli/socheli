import { getBrand, saveBrand, deleteBrand, brandUsage } from "../../../../lib/brands";
import { currentContext, assertCan, forbidden } from "../../../../lib/tenancy";
import { audit } from "../../../../lib/audit";

export const dynamic = "force-dynamic";

/* A single workspace-owned brand.
     GET    → the brand (404 when it isn't in the caller's workspace)
     PUT    → update it (brand.manage; no plan gate — editing what you manage)
     DELETE → remove it (brand.manage)
   Reads scope to ctx.workspaceId; mutations gate on `brand.manage` and audit. */

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await currentContext();
  const { id } = await params;
  const brand = getBrand(id, ctx.workspaceId);
  if (!brand) return Response.json({ error: "not found" }, { status: 404 });
  return Response.json({ brand });
}

/* Update an existing brand (no plan gate — editing what you already manage). */
export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await currentContext();
  try {
    assertCan(ctx, "brand.manage");
  } catch {
    return forbidden("brand.manage");
  }
  const { id } = await params;
  // 404 a brand outside the workspace before we touch it
  if (!getBrand(id, ctx.workspaceId)) return Response.json({ error: "not found" }, { status: 404 });

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ error: "invalid JSON" }, { status: 400 });
  }
  const res = saveBrand({ ...body, id }, "update", ctx);
  if (!res.ok) {
    const status = res.code === "forbidden" ? 403 : 400;
    return Response.json({ error: res.error, code: res.code }, { status });
  }
  audit(ctx, "brand.update", id, { name: res.brand!.name });
  return Response.json({ brand: res.brand, usage: brandUsage(ctx.workspaceId) });
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await currentContext();
  try {
    assertCan(ctx, "brand.manage");
  } catch {
    return forbidden("brand.manage");
  }
  const { id } = await params;
  const ok = deleteBrand(id, ctx.workspaceId);
  if (!ok) return Response.json({ error: "not found" }, { status: 404 });
  audit(ctx, "brand.delete", id);
  return Response.json({ ok: true, usage: brandUsage(ctx.workspaceId) });
}
