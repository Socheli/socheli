import { notFound } from "next/navigation";
import { currentContext, ctxCan } from "../../../lib/tenancy";
import { ingestedItem, studioVideoFile } from "../../../lib/studio";
import { PageHead } from "../../PageHead";
import { Editor } from "../Editor";
import type { EditorRun } from "../types";

export const dynamic = "force-dynamic";

/* The FRAME EDITOR — Editor Frame-Control, Phase C (the precision surface that
   complements the chat-first /studio). Where /studio is "edit by chat", /editor is
   "edit by frame": a frame-accurate scrubber, a timeline you can click/trim/split,
   and an at-frame inspector (vision / words / music). It deep-links from a /studio
   import (the rail's "Open frame editor" action) onto ONE ingested run.

   Server shell (every interior page's pattern): resolve the caller's tenant
   context, read the workspace-scoped ingested run (ingestedItem — scoped + kind-
   gated, no engine spawn), 404 if it isn't an ingested run for this workspace,
   and hand a PII-free summary to the client. fps resolves understanding.fps ??
   timeline.fps ?? 30 (the §key-fact order). All capability calls flow through the
   tenant-gated /api/studio/[id] purpose routes; read needs analytics.view, every
   mutate/render needs content.create. */

export default async function EditorPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await currentContext();

  // Workspace + kind gate — a foreign or non-ingested id is a 404, no engine spawn.
  const it = ingestedItem(id, ctx.workspaceId);
  if (!it) notFound();

  // understanding/timeline aren't on the base Item type (studio casts to read them).
  const x = it as typeof it & {
    understanding?: { fps?: number; denseFrameVision?: { frameCount?: number } };
    timeline?: { fps?: number };
  };
  const fps = x.understanding?.fps ?? x.timeline?.fps ?? 30;

  const run: EditorRun = {
    id: it.id,
    name: it.seedIdea, // original filename handle — NOT a disk path (PII §7.1.6)
    channel: it.channel,
    status: it.status,
    hasVideo: !!studioVideoFile(it),
    fps,
    hasDenseVision: (x.understanding?.denseFrameVision?.frameCount ?? 0) > 0,
  };

  return (
    <>
      <PageHead
        section="create"
        title="Frame Editor"
        sub="Frame-accurate editing — scrub to any frame, see what's on screen (vision · words · music), and trim, split or move clips on the exact frame. Re-render the cut when you're done."
      />
      <Editor
        run={run}
        canEdit={ctxCan(ctx, "content.create")}
        canView={ctxCan(ctx, "analytics.view")}
      />
    </>
  );
}
