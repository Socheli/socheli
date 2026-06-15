import { currentContext, assertCan, forbidden } from "../../../lib/tenancy";
import { readAudit } from "../../../lib/audit";

/* The workspace audit trail for the Team & Organization tab. Read-only; gated on
   `audit.view` and scoped to the caller's workspace. */

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const ctx = await currentContext();
  try {
    assertCan(ctx, "audit.view");
  } catch {
    return forbidden("audit.view");
  }
  const limit = Math.max(1, Math.min(500, Number(new URL(req.url).searchParams.get("limit")) || 100));
  return Response.json({ entries: readAudit(ctx.workspaceId, limit) });
}
