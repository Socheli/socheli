import { getBrand } from "../../../../lib/brands";
import { currentContext, ctxCan, forbidden } from "../../../../lib/tenancy";
import { audit } from "../../../../lib/audit";
import { runDnaTool } from "../../../../lib/dna";

/* Trait-path lock toggle (engine dna_lock_trait).
     POST { channel, path, locked } → pins/unpins a trait path so the
     autonomous evolution loop can never auto-mutate it. Manual edits still
     work on locked paths (locks stop the machine, not the operator).

   Gated on `brand.manage` (admin+). */

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const ctx = await currentContext();
  if (!ctxCan(ctx, "brand.manage")) return forbidden("brand.manage");

  const body = await req.json().catch(() => null);
  const channel = String(body?.channel ?? "").trim();
  const path = String(body?.path ?? "").trim();
  const locked = body?.locked !== false;
  if (!channel || !path) return Response.json({ error: "channel and path required" }, { status: 400 });
  if (!getBrand(channel, ctx.workspaceId)) return Response.json({ error: "brand not found" }, { status: 404 });

  const res = await runDnaTool("dna_lock_trait", { channel, path, locked });
  if (!res.ok) return Response.json({ error: res.message ?? "lock toggle failed" }, { status: 500 });
  audit(ctx, locked ? "dna.lock" : "dna.unlock", channel, { path });
  return Response.json(res.data);
}
