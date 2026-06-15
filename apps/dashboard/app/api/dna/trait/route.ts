import { getBrand } from "../../../../lib/brands";
import { currentContext, ctxCan, forbidden } from "../../../../lib/tenancy";
import { audit } from "../../../../lib/audit";
import { runDnaTool } from "../../../../lib/dna";

/* Manual trait upsert (engine dna_set_trait).
     POST { channel, path, value, weight? } → upserts a trait on the genome
     (e.g. add a hook to traits.hooks at weight .7) and logs it to the
     evolution history as a manual mutation.

   Gated on `brand.manage` (admin+) — the genome is part of the brand. */

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const ctx = await currentContext();
  if (!ctxCan(ctx, "brand.manage")) return forbidden("brand.manage");

  const body = await req.json().catch(() => null);
  const channel = String(body?.channel ?? "").trim();
  const path = String(body?.path ?? "").trim();
  const value = String(body?.value ?? "").trim();
  const weight = Math.max(0, Math.min(1, Number(body?.weight ?? 0.6)));
  if (!channel || !path || !value) {
    return Response.json({ error: "channel, path and value required" }, { status: 400 });
  }
  if (!getBrand(channel, ctx.workspaceId)) return Response.json({ error: "brand not found" }, { status: 404 });

  const res = await runDnaTool("dna_set_trait", { channel, path, value, weight });
  if (!res.ok) return Response.json({ error: res.message ?? "trait set failed" }, { status: 500 });
  audit(ctx, "dna.trait.set", channel, { path, value, weight });
  return Response.json(res.data);
}
