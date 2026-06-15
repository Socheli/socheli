import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { getBrand } from "../../../../lib/brands";
import { currentContext, ctxCan } from "../../../../lib/tenancy";
import { GenomePanel } from "./GenomePanel";

export const dynamic = "force-dynamic";

/* Brand Genome (server shell). The brand detail surface for the channel's
   living DNA: learned trait weights, platform playbooks, evolution history and
   the pending-mutation approval queue. Reads scope to the caller's workspace
   (a foreign brand id 404s); all mutations gate server-side on `brand.manage`
   and we pass the same permission down so the UI hides admin actions. */

export default async function BrandGenomePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await currentContext();
  const brand = getBrand(id, ctx.workspaceId);
  if (!brand) return notFound();
  const canManage = ctxCan(ctx, "brand.manage");

  return (
    <>
      <div className="page-head">
        <Link
          href="/channels"
          className="eyebrow"
          style={{ display: "inline-flex", alignItems: "center", gap: 6, textDecoration: "none" }}
        >
          <ArrowLeft size={12} /> brands
        </Link>
        <div className="eyebrow">// brand genome / {brand.name}</div>
        <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
          <span
            className="brand-dot"
            style={{ background: brand.accent ?? "#888", boxShadow: `0 0 14px ${brand.accent ?? "#888"}` }}
          />
          <h1 className="h1">{brand.name} — Genome</h1>
        </div>
        <div className="sub" style={{ marginTop: 8 }}>
          The brand&apos;s living DNA — trait affinities learned from performance, platform playbooks from
          research, and every mutation with its cause and evidence. Locks pin a trait path against the
          autonomous evolution loop.
        </div>
      </div>
      <GenomePanel channel={brand.id} accent={brand.accent ?? "#888"} canManage={canManage} />
    </>
  );
}
