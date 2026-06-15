import { ingestedItem, renderHybrid, startedJob } from "../../../../../lib/studio";
import { currentContext, ctxCan, forbidden } from "../../../../../lib/tenancy";
import { audit } from "../../../../../lib/audit";

export const dynamic = "force-dynamic";

/* The /editor RENDER entry (Editor Frame-Control — Phase C).
   POST /api/studio/[id]/render
     { aspect?: "9:16"|"1:1"|"16:9"|"original", fill?: "crop"|"blur"|"fit" }
   → render_hybrid: cut the footage spine, composite grade + captions + overlays
     over it, build the audio mix, mux to the final mp4. `aspect` reframes the
     output (e.g. 9:16 for a vertical); `fill` chooses how off-aspect source is
     fit (crop / blur / fit). Sets item.videoPath on success.

   LONG: detaches and returns the started job verbatim ({status:"started", pid,
   logPath}) so the page polls GET /api/studio/[id] until hasVideo flips (then
   bumps videoKey to reload the player), exactly like the chat render path.

   Tenancy: workspace + kind:"ingested" gate via ingestedItem() before any engine
   spawn. Gate = content.create (a render derives content). Audited. */

const ASPECTS = ["9:16", "1:1", "16:9", "original"] as const;
const FILLS = ["crop", "blur", "fit"] as const;
type Aspect = (typeof ASPECTS)[number];
type Fill = (typeof FILLS)[number];

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await currentContext();
  if (!ctxCan(ctx, "content.create")) return forbidden("content.create");

  // Workspace + kind gate before any engine spawn.
  const it = ingestedItem(id, ctx.workspaceId);
  if (!it) return new Response("not found", { status: 404 });

  const body = await req.json().catch(() => ({}));
  const aspect: Aspect | undefined = ASPECTS.includes(body?.aspect) ? (body.aspect as Aspect) : undefined;
  const fill: Fill | undefined = FILLS.includes(body?.fill) ? (body.fill as Fill) : undefined;

  const res = await renderHybrid(id, aspect, fill);
  if (!res.ok) return Response.json({ error: res.message ?? "render failed" }, { status: 500 });

  audit(ctx, "studio.render", id, { aspect, fill });
  return Response.json({ ...res.data, job: startedJob(res) });
}
