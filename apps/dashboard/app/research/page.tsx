import { listBrands } from "../../lib/brands";
import { listResearch } from "../../lib/research";
import { currentContext, ctxCan } from "../../lib/tenancy";
import { PageHead } from "../PageHead";
import { ResearchHub } from "./ResearchHub";

export const dynamic = "force-dynamic";

/* Research harness (server shell). Lists the caller's workspace's verified
   research runs and hosts the "new research" composer. Starting a run is
   gated server-side on `plan.run` in /api/research; the same permission is
   passed down so the composer disables itself for viewers. */

export default async function ResearchPage() {
  const ctx = await currentContext();
  const canRun = ctxCan(ctx, "plan.run");
  const runs = listResearch(ctx.workspaceId);
  const brands = listBrands(ctx.workspaceId).map((b) => ({ id: b.id, name: b.name }));
  return (
    <>
      <PageHead
        section="create"
        title="Research"
        sub="Verified multi-source research runs: one question planned into sub-queries, swept across the web, cross-checked claim by claim, and synthesized into a cited report the rest of the system feeds on."
      />
      <ResearchHub initialRuns={runs} brands={brands} canRun={canRun} />
    </>
  );
}
