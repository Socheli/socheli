import {
  ingestedItem,
  getUnderstanding,
  getTimeline,
  ingestStatus,
  studioVideoFile,
} from "../../../../lib/studio";
import { currentContext, ctxCan, forbidden } from "../../../../lib/tenancy";

export const dynamic = "force-dynamic";

/* The Studio detail read (Pillar 5 — the EDITOR STUDIO).
   GET /api/studio/[id] → everything the /studio/[id] page needs to render an
   ingested run in one shot:
     { item, status, hasVideo, understanding, timeline }
   · item       — the safe, PII-free run summary (id/status/name = filename handle,
                  NEVER source.originalPath which can be a home-dir path).
     `status` mirrors ingest_status so a still-transcoding import shows progress.
   · understanding — editor_understanding_get ({ built:false } until the deep
                     pipeline has run; the page then offers a "Understand" action).
   · timeline   — timeline_get (always works; derived pre-build) for the read-only
                  timeline/understanding panel.
   · hasVideo   — whether a playable file exists on disk yet (the player polls).

   Tenancy: scoped to ctx.workspaceId AND gated to kind:"ingested" via
   ingestedItem(); a non-ingested or out-of-workspace id 404s before any engine
   spawn. Read gate = analytics.view (a read-only view of an ingested run). */

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await currentContext();
  if (!ctxCan(ctx, "analytics.view")) return forbidden("analytics.view");

  // Workspace + kind gate up front — no engine spawn for a foreign/non-ingested id.
  const it = ingestedItem(id, ctx.workspaceId);
  if (!it) return new Response("not found", { status: 404 });

  // Reads run through the engine tool runner (understanding/timeline live in the
  // engine); ingest_status surfaces transcode progress for a still-importing run.
  const [understanding, timeline, status] = await Promise.all([
    getUnderstanding(id),
    getTimeline(id),
    ingestStatus(id),
  ]);

  return Response.json({
    item: {
      id: it.id,
      channel: it.channel,
      status: it.status,
      kind: it.kind,
      createdAt: it.createdAt,
      updatedAt: it.updatedAt,
      name: it.seedIdea, // original filename handle — NOT a disk path (PII §7.1.6)
    },
    hasVideo: !!studioVideoFile(it),
    status: status.ok ? status.data : { error: status.message },
    understanding: understanding.ok ? understanding.data : { built: false, error: understanding.message },
    timeline: timeline.ok ? timeline.data : { error: timeline.message },
  });
}
