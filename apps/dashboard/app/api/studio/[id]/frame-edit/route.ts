import {
  ingestedItem,
  trimClipFrame,
  splitClipFrame,
  moveClipFrame,
  frameIndex,
} from "../../../../../lib/studio";
import { currentContext, ctxCan, forbidden } from "../../../../../lib/tenancy";
import { audit } from "../../../../../lib/audit";

export const dynamic = "force-dynamic";

/* The /editor FRAME-EXACT MUTATE entry (Editor Frame-Control — Phase C).
   POST /api/studio/[id]/frame-edit
     { op:"trim",  clipId, inFrame?, outFrame? }   → timeline_trim_clip_frame
     { op:"split", clipId, atFrame }               → timeline_split_clip_frame
     { op:"move",  clipId, startFrame }             → timeline_move_clip_frame

   Each tool is SKIP-NOT-THROW: a locked / not-found / no-op edit returns
   { skipped } in the result (surfaced verbatim) rather than failing. Every frame
   edit INVALIDATES the frame index, so after a successful mutate we re-run
   timeline_frame_index and return the fresh index alongside the edit result —
   the page can refresh optimistically without a second round trip.

   Tenancy: workspace + kind:"ingested" gate via ingestedItem() before any engine
   spawn. Gate = content.create (a frame edit authors/derives content). Audited
   with the op + clip so a team can answer "who trimmed this?". */

type FrameEditOp = "trim" | "split" | "move";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await currentContext();
  if (!ctxCan(ctx, "content.create")) return forbidden("content.create");

  // Workspace + kind gate before any engine spawn.
  const it = ingestedItem(id, ctx.workspaceId);
  if (!it) return new Response("not found", { status: 404 });

  const body = await req.json().catch(() => null);
  if (!body) return Response.json({ error: "JSON body required" }, { status: 400 });

  const op = body.op as FrameEditOp;
  const clipId = String(body.clipId ?? "").trim();
  if (!["trim", "split", "move"].includes(op)) return Response.json({ error: "op must be trim|split|move" }, { status: 400 });
  if (!clipId) return Response.json({ error: "clipId required" }, { status: 400 });

  let res;
  switch (op) {
    case "trim": {
      const edges: { inFrame?: number; outFrame?: number } = {};
      if (typeof body.inFrame === "number") edges.inFrame = Math.max(0, Math.round(body.inFrame));
      if (typeof body.outFrame === "number") edges.outFrame = Math.max(0, Math.round(body.outFrame));
      if (edges.inFrame === undefined && edges.outFrame === undefined) {
        return Response.json({ error: "trim needs inFrame and/or outFrame" }, { status: 400 });
      }
      res = await trimClipFrame(id, clipId, edges);
      break;
    }
    case "split": {
      if (typeof body.atFrame !== "number") return Response.json({ error: "split needs atFrame" }, { status: 400 });
      res = await splitClipFrame(id, clipId, Math.max(0, Math.round(body.atFrame)));
      break;
    }
    case "move": {
      if (typeof body.startFrame !== "number") return Response.json({ error: "move needs startFrame" }, { status: 400 });
      res = await moveClipFrame(id, clipId, Math.max(0, Math.round(body.startFrame)));
      break;
    }
  }

  if (!res.ok) return Response.json({ error: res.message ?? "frame edit failed" }, { status: 500 });

  // The edit invalidated the frame index — rebuild it so the page's next frame
  // read resolves against the new geometry. Best-effort (a build error here
  // doesn't fail the edit, which already landed).
  const idx = await frameIndex(id);

  audit(ctx, "studio.frameEdit", id, { op, clipId, skipped: (res.data as { skipped?: string } | undefined)?.skipped });
  return Response.json({ op, ...res.data, frameIndex: idx.ok ? idx.data : { error: idx.message } });
}
