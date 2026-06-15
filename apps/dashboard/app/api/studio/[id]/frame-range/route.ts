import { ingestedItem, frameRange, wordsAtFrame, musicContext } from "../../../../../lib/studio";
import { currentContext, ctxCan, forbidden } from "../../../../../lib/tenancy";

export const dynamic = "force-dynamic";

/* The /editor WINDOW read (Editor Frame-Control — Phase C).
   GET /api/studio/[id]/frame-range?startFrame=A&endFrame=B[&with=words,music]
     → everything a scrubber/inspector needs to paint a frame window in one round
       trip. Always returns the clips overlapping [A,B] (timeline_frame_range);
       `with` opts into the heavier cross-modal reads:
         · with=words → timeline_words_at_frame (transcript words over the window)
         · with=music → timeline_music_context  (beats/sections/energy over it)
       Default (no `with`) = clips only — the cheap paint read.

   Returns { range, words?, music? }. Reads only; fail-open at the engine — a
   missing modality degrades to empty, never an error.

   Tenancy mirrors GET /api/studio/[id]: workspace + kind:"ingested" gate via
   ingestedItem() before any engine spawn; read gate = analytics.view. */

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await currentContext();
  if (!ctxCan(ctx, "analytics.view")) return forbidden("analytics.view");

  // Workspace + kind gate before any engine spawn.
  const it = ingestedItem(id, ctx.workspaceId);
  if (!it) return new Response("not found", { status: 404 });

  const url = new URL(req.url);
  const startFrame = Math.max(0, Math.round(Number(url.searchParams.get("startFrame") ?? "0")));
  const endFrame = Math.max(startFrame, Math.round(Number(url.searchParams.get("endFrame") ?? "0")));
  if (!Number.isFinite(startFrame) || !Number.isFinite(endFrame)) {
    return Response.json({ error: "startFrame and endFrame must be numbers" }, { status: 400 });
  }
  const want = (url.searchParams.get("with") ?? "").split(",").map((s) => s.trim());

  const [rangeRes, wordsRes, musicRes] = await Promise.all([
    frameRange(id, startFrame, endFrame),
    want.includes("words") ? wordsAtFrame(id, startFrame, endFrame) : Promise.resolve(null),
    want.includes("music") ? musicContext(id, startFrame, endFrame) : Promise.resolve(null),
  ]);

  if (!rangeRes.ok) return Response.json({ error: rangeRes.message ?? "range read failed" }, { status: 500 });

  return Response.json({
    range: rangeRes.data,
    words: wordsRes && wordsRes.ok ? wordsRes.data : undefined,
    music: musicRes && musicRes.ok ? musicRes.data : undefined,
  });
}
