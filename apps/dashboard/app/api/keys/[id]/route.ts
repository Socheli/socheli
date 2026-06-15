import { currentContext, assertCan, forbidden } from "../../../../lib/tenancy";
import { revokeKey } from "../../../../lib/api-keys";
import { audit } from "../../../../lib/audit";

/* DELETE a workspace API key by id. Gated on `apikey.manage`; the revoke helper
   only touches a key that belongs to the caller's workspace (404 otherwise). */

export const dynamic = "force-dynamic";

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await currentContext();
  try {
    assertCan(ctx, "apikey.manage");
  } catch {
    return forbidden("apikey.manage");
  }
  const { id } = await params;
  const ok = revokeKey(ctx.workspaceId, id);
  if (!ok) return Response.json({ error: "not found" }, { status: 404 });
  audit(ctx, "apikey.revoke", id);
  return Response.json({ ok: true });
}
