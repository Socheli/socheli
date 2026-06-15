import { listIngested } from "../../../lib/studio";
import { currentContext, ctxCan, forbidden } from "../../../lib/tenancy";

export const dynamic = "force-dynamic";

/* The Studio imports LIST (Pillar 5 — the EDITOR STUDIO).
   GET /api/studio → the caller's workspace ingested runs (the "your imports"
   rail), as PII-free summaries (lib/studio.listIngested — `name` is the original
   filename handle, never a disk path). The page seeds the rail server-side and
   re-fetches this after an import so the new run appears without a full reload.

   Tenancy: scoped to ctx.workspaceId; read gate = analytics.view (a read-only
   listing of ingested runs). No engine spawn — it's a scoped JSON read. */

export async function GET() {
  const ctx = await currentContext();
  if (!ctxCan(ctx, "analytics.view")) return forbidden("analytics.view");
  return Response.json(listIngested(ctx.workspaceId));
}
