import { getCopilotModel, setCopilotModel, COPILOT_MODEL_PRESETS } from "../../../../lib/agent/model-config";
import { currentContext, assertCan, forbidden } from "../../../../lib/tenancy";
import { audit } from "../../../../lib/audit";

export const dynamic = "force-dynamic";

/* The model that powers Soli. GET returns the current model + presets; POST
   switches it (write needs edit rights). The copilot reads the persisted value
   per message, so a switch is live on the next turn — no restart. */
export async function GET() {
  return Response.json({ model: getCopilotModel(), presets: COPILOT_MODEL_PRESETS });
}

export async function POST(req: Request) {
  const ctx = await currentContext();
  try {
    assertCan(ctx, "content.edit.any");
  } catch {
    return forbidden("content.edit.any");
  }
  const body = await req.json().catch(() => ({}));
  const model = String(body.model ?? "").trim();
  if (!model) return Response.json({ error: "model is required" }, { status: 400 });
  setCopilotModel(model);
  audit(ctx, "copilot.model", model, { model });
  return Response.json({ ok: true, model, presets: COPILOT_MODEL_PRESETS });
}
