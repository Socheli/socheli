import { notFound } from "next/navigation";
import { loadResearchRun } from "../../../lib/research";
import { currentContext } from "../../../lib/tenancy";
import { RunView } from "./RunView";

export const dynamic = "force-dynamic";

/* One research run (server shell). The run may legitimately not exist on disk
   yet — the composer redirects here the instant the detached worker is
   spawned, a beat before its first milestone persists — so a missing file is
   NOT a 404: the client view polls until the run appears (and only gives up
   after a generous timeout). Garbage ids that can't be run ids still 404. */

export default async function ResearchRunPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^res_[a-zA-Z0-9_-]{1,72}$/.test(id)) return notFound();
  const ctx = await currentContext();
  const run = loadResearchRun(id, ctx.workspaceId);
  return <RunView id={id} initialRun={run} />;
}
