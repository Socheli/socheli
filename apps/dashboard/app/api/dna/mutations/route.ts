import { getBrand } from "../../../../lib/brands";
import { currentContext, ctxCan, forbidden } from "../../../../lib/tenancy";
import { audit } from "../../../../lib/audit";
import { runDnaTool } from "../../../../lib/dna";

/* Pending-mutation approval gate (engine dna_mutation_approve / _reject).
     POST { channel, id, action: "approve" | "reject" }
       approve → applies the stored machine patch, moves the mutation into the
                 evolution history (kind "approved"), bumps the genome version
       reject  → discards it; the genome's traits are untouched

   Gated on `brand.manage` (admin+) per the spec's "approvals = admin+". */

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const ctx = await currentContext();
  if (!ctxCan(ctx, "brand.manage")) return forbidden("brand.manage");

  const body = await req.json().catch(() => null);
  const channel = String(body?.channel ?? "").trim();
  const id = String(body?.id ?? "").trim();
  const action = body?.action === "reject" ? "reject" : body?.action === "approve" ? "approve" : null;
  if (!channel || !id || !action) {
    return Response.json({ error: "channel, id and action (approve|reject) required" }, { status: 400 });
  }
  if (!getBrand(channel, ctx.workspaceId)) return Response.json({ error: "brand not found" }, { status: 404 });

  const tool = action === "approve" ? "dna_mutation_approve" : "dna_mutation_reject";
  const res = await runDnaTool(tool, { channel, id });
  if (!res.ok) return Response.json({ error: res.message ?? `${action} failed` }, { status: 500 });
  audit(ctx, `dna.mutation.${action}`, channel, { id });
  return Response.json(res.data);
}
