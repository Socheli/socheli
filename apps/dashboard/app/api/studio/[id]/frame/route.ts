import { ingestedItem, seekFrame, queryFrame } from "../../../../../lib/studio";
import { currentContext, ctxCan, forbidden } from "../../../../../lib/tenancy";

export const dynamic = "force-dynamic";

/* The /editor SINGLE-FRAME read (Editor Frame-Control — Phase C).
   GET /api/studio/[id]/frame?atFrame=N        → the FULL seek (timeline_seek_frame):
        the picture clip + its source window PLUS the cross-modal context at that
        exact frame — dense vision { frame, deltaSec }, transcript words on the
        frame, and the music context (beats/sections/energy). This is what the
        FrameInspector renders when you scrub to a frame.
   GET /api/studio/[id]/frame?atSec=S          → the lighter jump (timeline_query_frame):
        resolve a SECOND to the clip + source window, no cross-modal context — the
        scrub-drag read where we only need "which clip / where in source".

   `atFrame` takes precedence (frame-exact); `atSec` is the fallback the scrubber
   uses while dragging. Returns the tool's data verbatim (json-safe, no disk
   paths leak — clip.src can carry an asset path but never the source's
   originalPath, which lib/studio never returns).

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
  const atFrameRaw = url.searchParams.get("atFrame");
  const atSecRaw = url.searchParams.get("atSec");

  // Frame-exact seek (the full cross-modal read) when atFrame is given.
  if (atFrameRaw !== null) {
    const atFrame = Math.max(0, Math.round(Number(atFrameRaw)));
    if (!Number.isFinite(atFrame)) return Response.json({ error: "atFrame must be a number" }, { status: 400 });
    const res = await seekFrame(id, atFrame);
    if (!res.ok) return Response.json({ error: res.message ?? "seek failed" }, { status: 500 });
    return Response.json(res.data);
  }

  // Lighter jump (clip + source window only) when only a second is given.
  if (atSecRaw !== null) {
    const atSec = Math.max(0, Number(atSecRaw));
    if (!Number.isFinite(atSec)) return Response.json({ error: "atSec must be a number" }, { status: 400 });
    const res = await queryFrame(id, { atSec });
    if (!res.ok) return Response.json({ error: res.message ?? "query failed" }, { status: 500 });
    return Response.json(res.data);
  }

  return Response.json({ error: "atFrame or atSec required" }, { status: 400 });
}
