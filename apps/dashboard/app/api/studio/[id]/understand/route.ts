import { ingestedItem, buildUnderstanding, startedJob } from "../../../../../lib/studio";
import { currentContext, ctxCan, forbidden } from "../../../../../lib/tenancy";
import { audit } from "../../../../../lib/audit";

export const dynamic = "force-dynamic";

/* Trigger DEEP UNDERSTANDING for an ingested run (Pillar 5 — the EDITOR STUDIO).
   POST /api/studio/[id]/understand → lib/studio.buildUnderstanding → engine
   editor_understand: the LONG, detached pipeline (Whisper transcript → shot
   segmentation → speakers → per-shot multimodal → editorial signals). Returns the
   started job verbatim ({status:"started", pid, logPath}); the page then polls
   GET /api/studio/[id] until understanding.built flips true.

   It lives on its own route (not the chat edit route) because understanding is
   the GROUNDING the chat edits against, not an edit op — keeping it separate
   means the edit route only ever routes/applies plans.

   Tenancy: workspace + kind:"ingested" gate via ingestedItem() before any engine
   spawn. Gate = content.create (building the analysis derives content). Audited. */

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await currentContext();
  if (!ctxCan(ctx, "content.create")) return forbidden("content.create");

  const it = ingestedItem(id, ctx.workspaceId);
  if (!it) return new Response("not found", { status: 404 });

  const res = await buildUnderstanding(id);
  if (!res.ok) return Response.json({ error: res.message ?? "understand failed" }, { status: 500 });
  audit(ctx, "studio.understand", id, {});
  return Response.json({ ...res.data, job: startedJob(res) });
}
