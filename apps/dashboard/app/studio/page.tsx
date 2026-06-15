import { currentContext, ctxCan } from "../../lib/tenancy";
import { listIngested } from "../../lib/studio";
import { PageHead } from "../PageHead";
import { Studio } from "./Studio";

export const dynamic = "force-dynamic";

/* Editor Studio — Pillar 5, the Odysser-style chat-first editor surface.
   Import ANY video, see the content-aware analysis (transcript / shots / dead-air
   / highlights), then EDIT BY CHAT: "subtitle it", "make a 30s highlight reel",
   "cut the dead air", "grade it warm" → a PROPOSED EditPlan → approve (guided) or
   let it run (autonomous) → preview. Workflow-first, NOT a drag NLE (that's later).

   Server shell (every interior page's pattern): resolve the caller's tenant
   context, read the workspace's ingested runs (lib/studio.listIngested — a
   scoped read, no engine spawn), and hand them to the client surface. All
   capability calls flow through the tenant-gated /api/ingest + /api/studio/[id]
   routes, which spawn the one engine tool registry. Content gating mirrors the
   routes: importing/editing needs content.create; the read view needs
   analytics.view. */

export default async function StudioPage() {
  const ctx = await currentContext();
  const ingested = listIngested(ctx.workspaceId);

  return (
    <>
      <PageHead
        section="create"
        title="Editor Studio"
        sub="Import any video and edit it by chat — it understands your footage (transcript, shots, dead-air, highlights), proposes a grounded plan, and you approve or let it run."
      />
      <Studio
        initial={ingested}
        canEdit={ctxCan(ctx, "content.create")}
        canView={ctxCan(ctx, "analytics.view")}
      />
    </>
  );
}
