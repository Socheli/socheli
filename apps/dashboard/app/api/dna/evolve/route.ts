import { getBrand } from "../../../../lib/brands";
import { currentContext, ctxCan, forbidden } from "../../../../lib/tenancy";
import { audit } from "../../../../lib/audit";
import { runDnaTool } from "../../../../lib/dna";

/* Kick off genome evolution (engine dna_evolve).
     POST { channel } → starts a DETACHED `content dna evolve <channel>` run
     (the engine tool spawns it and returns immediately with the pid + log
     path). Evolution gathers learnings/scorecards/fresh research/QA verdicts,
     then a smart-brain pass proposes evidence-backed mutations.

   The dashboard always runs policy "gate": every proposal lands in the
   genome's pending queue for human approval — auto-apply stays a CLI/mission
   decision, never a button. Gated on `brand.manage` (admin+). */

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const ctx = await currentContext();
  if (!ctxCan(ctx, "brand.manage")) return forbidden("brand.manage");

  const body = await req.json().catch(() => null);
  const channel = String(body?.channel ?? "").trim();
  if (!channel) return Response.json({ error: "channel required" }, { status: 400 });
  if (!getBrand(channel, ctx.workspaceId)) return Response.json({ error: "brand not found" }, { status: 404 });

  const res = await runDnaTool("dna_evolve", { channel, policy: "gate" });
  if (!res.ok) return Response.json({ error: res.message ?? "evolve failed to start" }, { status: 500 });
  audit(ctx, "dna.evolve", channel);
  return Response.json({ started: true, channel });
}
