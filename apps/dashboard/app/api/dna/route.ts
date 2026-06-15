import { getBrand } from "../../../lib/brands";
import { currentContext } from "../../../lib/tenancy";
import { getGenomeFor } from "../../../lib/dna";

/* Brand Genome read API.
     GET ?channel=<brandId> → the channel's full BrandGenome (traits with
     weights/evidence, platform playbooks, evolution history, pending
     mutations, locks). Seeds a default genome from the brand's ChannelDNA on
     first read (engine-side).

   Tenancy: the channel must be a brand inside the caller's workspace — a
   brand id from another workspace 404s, so genomes never leak across
   tenants. Reads are workspace-scoped but not permission-gated (same as the
   brand list itself); every mutation route under /api/dna/* gates on
   `brand.manage`. */

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const ctx = await currentContext();
  const channel = new URL(req.url).searchParams.get("channel")?.trim() ?? "";
  if (!channel) return Response.json({ error: "channel required" }, { status: 400 });

  const brand = getBrand(channel, ctx.workspaceId);
  if (!brand) return Response.json({ error: "brand not found" }, { status: 404 });

  // Direct file read (no engine spawn) for the warm path; getGenomeFor only
  // spawns dna_get on the cold-seed case (genome file absent for this brand).
  // NOTE: dashboard tsconfig sets strict:false (strictNullChecks off), so TS
  // won't narrow getGenomeFor's discriminated union on `res.ok`. Read both
  // optional fields off the union directly — they're present per the variant.
  const res = (await getGenomeFor(channel, ctx.workspaceId)) as {
    ok: boolean;
    genome?: unknown;
    message?: string;
  };
  if (res.ok) return Response.json({ genome: res.genome });
  return Response.json({ error: res.message ?? "genome read failed" }, { status: 500 });
}
