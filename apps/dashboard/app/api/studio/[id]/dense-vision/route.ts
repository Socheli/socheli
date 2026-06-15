import { ingestedItem, buildDenseVision, startedJob } from "../../../../../lib/studio";
import { currentContext, ctxCan, forbidden } from "../../../../../lib/tenancy";
import { audit } from "../../../../../lib/audit";

export const dynamic = "force-dynamic";

/* The /editor DENSE-VISION entry (Editor Frame-Control — Phase C).
   POST /api/studio/[id]/dense-vision   { sampleFps?: 0.5 | 1 | 2 }
   → editor_understand_dense_vision: sample the source uniformly at `sampleFps`,
     describe each sampled frame with Claude vision (subjects / on-screen text /
     what's happening) + stamp the cheap per-frame metrics, indexed by SOURCE
     frame — so the FrameInspector can answer "what's on screen at frame N" in
     O(1). Persists understanding.denseFrameVision.

   LONG + PAID (one vision pass per sampled frame): detaches and returns the
   started job verbatim ({status:"started", pid, logPath}). The page polls GET
   /api/studio/[id] until understanding.denseFrameVision lands, then re-reads the
   inspected frame so its vision block fills in.

   Tenancy: workspace + kind:"ingested" gate via ingestedItem() before any engine
   spawn. Gate = content.create (building the analysis derives content). Audited. */

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await currentContext();
  if (!ctxCan(ctx, "content.create")) return forbidden("content.create");

  // Workspace + kind gate before any engine spawn.
  const it = ingestedItem(id, ctx.workspaceId);
  if (!it) return new Response("not found", { status: 404 });

  const body = await req.json().catch(() => ({}));
  // Clamp to the tool's allowed sampling band; undefined → engine default (1fps).
  const sampleFps =
    typeof body?.sampleFps === "number" ? Math.min(8, Math.max(0.1, body.sampleFps)) : undefined;

  const res = await buildDenseVision(id, sampleFps);
  if (!res.ok) return Response.json({ error: res.message ?? "dense vision failed" }, { status: 500 });

  audit(ctx, "studio.denseVision", id, { sampleFps });
  return Response.json({ ...res.data, job: startedJob(res) });
}
