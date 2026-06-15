import {
  ingestedItem,
  routeEdit,
  oneShotEdit,
  applyEdit,
  montage,
  subtitle,
  startedJob,
  type EditMode,
  type MontageSpec,
} from "../../../../../lib/studio";
import { currentContext, ctxCan, forbidden } from "../../../../../lib/tenancy";
import { audit } from "../../../../../lib/audit";

export const dynamic = "force-dynamic";

/* The Studio CHAT-EDIT entry (Pillar 5 — the EDITOR STUDIO, Odysser model).
   POST /api/studio/[id]/edit
     { request, mode?, render?, action?, planId?, montage? }

   action (default inferred from mode):
     · "route"    (mode:"guided", default)   → propose an EditPlan, do NOT apply.
                   The page shows the plan; the human approves (→ "apply").
     · "oneshot"  (mode:"autonomous")         → route + apply in one call.
     · "apply"    → execute a previously-routed plan (planId optional = newest).
     · "montage"  → re-cut a highlight reel / teaser (montage spec).
     · "subtitle" → build the editable caption track from the transcript.

   `render:true` on oneshot/apply detaches the hybrid re-render as a job — surfaced
   verbatim ({status:"started", pid, logPath}) so the page polls /api/studio/[id].

   Tenancy: workspace + kind:"ingested" gate via ingestedItem(); the human-gated
   APPROVAL model is the engine's (route proposes, apply executes). Gate =
   content.create (an edit authors/derives content). Every action is audited. */

type EditAction = "route" | "oneshot" | "apply" | "montage" | "subtitle";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await currentContext();
  if (!ctxCan(ctx, "content.create")) return forbidden("content.create");

  // Workspace + kind gate before any engine spawn.
  const it = ingestedItem(id, ctx.workspaceId);
  if (!it) return new Response("not found", { status: 404 });

  const body = await req.json().catch(() => null);
  if (!body) return Response.json({ error: "JSON body required" }, { status: 400 });

  const request = String(body.request ?? "").trim();
  const mode: EditMode = body.mode === "autonomous" ? "autonomous" : "guided";
  const render = body.render === true;
  // Default action: guided → propose-only (route); autonomous → route+apply.
  const action: EditAction =
    typeof body.action === "string" && ["route", "oneshot", "apply", "montage", "subtitle"].includes(body.action)
      ? (body.action as EditAction)
      : mode === "autonomous"
        ? "oneshot"
        : "route";

  // A free-text request is required for the chat actions (not for montage/subtitle).
  if ((action === "route" || action === "oneshot") && !request) {
    return Response.json({ error: "request required" }, { status: 400 });
  }

  let res;
  switch (action) {
    case "route":
      res = await routeEdit(id, request, mode);
      break;
    case "oneshot":
      res = await oneShotEdit(id, request, render);
      break;
    case "apply": {
      const planId = typeof body.planId === "string" && body.planId.trim() ? body.planId.trim() : undefined;
      res = await applyEdit(id, planId, render);
      break;
    }
    case "montage": {
      const spec: MontageSpec = {};
      if (typeof body.montage?.targetSec === "number") spec.targetSec = body.montage.targetSec;
      if (typeof body.montage?.style === "string") spec.style = body.montage.style;
      if (typeof body.montage?.maxClips === "number") spec.maxClips = body.montage.maxClips;
      if (typeof body.montage?.orderBy === "string") spec.orderBy = body.montage.orderBy;
      res = await montage(id, spec);
      break;
    }
    case "subtitle":
      res = await subtitle(id);
      break;
  }

  if (!res.ok) return Response.json({ error: res.message ?? "edit failed" }, { status: 500 });
  audit(ctx, "studio.edit", id, { action, mode, render, request: request.slice(0, 200) });
  return Response.json({ action, ...res.data, job: startedJob(res) });
}
