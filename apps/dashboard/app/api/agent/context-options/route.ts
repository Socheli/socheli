import { listItemsFor } from "../../../../lib/data";
import { listBrands } from "../../../../lib/brands";
import { currentContext } from "../../../../lib/tenancy";

export const dynamic = "force-dynamic";

/* Options for the composer's context picker ("@" / + in the Soli composer).
   Returns the caller's 10 most recent runs (id/topic/status) and their
   channels (id/name) so the picker can insert @post:<id> / @channel:<id>
   reference tokens. Reads scope to the session workspace via listItemsFor /
   listBrands — same pattern as /api/analytics — so nothing crosses tenants. */
export async function GET() {
  const ctx = await currentContext();
  const items = listItemsFor(ctx.workspaceId)
    .slice(0, 10)
    .map((it) => ({
      id: it.id,
      topic: it.idea?.topic || it.seedIdea || it.id,
      status: it.status,
    }));
  const channels = listBrands(ctx.workspaceId).map((b) => ({ id: b.id, name: b.name }));
  return Response.json({ items, channels });
}
