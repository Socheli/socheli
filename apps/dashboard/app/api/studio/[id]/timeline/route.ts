import { ingestedItem, getTimeline, frameIndex } from "../../../../../lib/studio";
import { currentContext, ctxCan, forbidden } from "../../../../../lib/tenancy";

export const dynamic = "force-dynamic";

/* The /editor TIMELINE read (Editor Frame-Control — Phase C).
   GET /api/studio/[id]/timeline → the frame-addressed timeline VIEW plus a freshly
   (re)built frame index in one shot:
     · timeline_get          — fps + tracks + clips in BOTH seconds and frames
                               (always works; derived pre-build).
     · timeline_frame_index  — (re)build the per-clip frame index so the frame
                               reads (seek/range/words/music) resolve. Idempotent;
                               cheap. We rebuild on every load so a clip edit done
                               elsewhere can't leave a stale index.

   Returns { timeline, frameIndex }. The page reads `timeline.fps` (falling back
   to understanding.fps ?? 30) and paints tracks/clips/playhead from it.

   Tenancy mirrors GET /api/studio/[id]: workspace + kind:"ingested" gate via
   ingestedItem() before any engine spawn; read gate = analytics.view. Even though
   timeline_frame_index is a mutate, it only derives an index off authoritative
   seconds — a read of the timeline view, so it stays on the analytics.view gate. */

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await currentContext();
  if (!ctxCan(ctx, "analytics.view")) return forbidden("analytics.view");

  // Workspace + kind gate before any engine spawn.
  const it = ingestedItem(id, ctx.workspaceId);
  if (!it) return new Response("not found", { status: 404 });

  // Build the index first (so the frame reads resolve), then read the view.
  const idx = await frameIndex(id);
  const timeline = await getTimeline(id);
  if (!timeline.ok) {
    return Response.json({ error: timeline.message ?? "timeline read failed" }, { status: 500 });
  }

  return Response.json({
    timeline: timeline.data,
    frameIndex: idx.ok ? idx.data : { error: idx.message },
  });
}
