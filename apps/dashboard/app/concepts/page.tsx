import { listConcepts } from "../../lib/concepts";
import { listItemsFor, videoFile } from "../../lib/data";
import { currentContext } from "../../lib/tenancy";
import { PageHead } from "../PageHead";
import { ConceptBoard } from "./ConceptBoard";

export const dynamic = "force-dynamic";

export default async function ConceptsPage() {
  const ctx = await currentContext();
  const concepts = listConcepts(ctx.workspaceId);
  const items = listItemsFor(ctx.workspaceId); // newest first, this workspace only
  // Link each generated concept to the run it produced (topic === seedIdea), preferring one with a finished video.
  const enriched = concepts.map((c) => {
    const matches = items.filter((it) => it.seedIdea === c.topic || it.idea?.topic === c.topic);
    const run = matches.find((it) => videoFile(it)) ?? matches[0];
    const author = c.createdBy === ctx.userId ? "you" : c.createdBy ?? undefined;
    return run
      ? { ...c, author, run: { id: run.id, hasVideo: !!videoFile(run), status: run.status } }
      : { ...c, author };
  });
  return (
    <>
      <PageHead
        section="create"
        title="Concept Board"
        sub="Review the scored slate, comment, approve — then turn the winner into a video."
      />
      <ConceptBoard concepts={enriched} role={ctx.role} userId={ctx.userId} />
    </>
  );
}
