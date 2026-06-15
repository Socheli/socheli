import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft } from "lucide-react";
import { currentContext, ctxCan } from "../../../../lib/tenancy";
import { getBrand } from "../../../../lib/brands";
import { connectionFor, insightsFor } from "../../../../lib/connections";
import { responderFor } from "../../../../lib/responder";
import { ManagePanels } from "./ManagePanels";

export const dynamic = "force-dynamic";

/* Per-brand connection management. 404s unless the channel is a brand in the
   caller's workspace. Tabbed surface over the same panels the wizard uses:
   connection, responder rules & tone, templates, dry-run test, and insights. */

export default async function ConnectionManagePage({ params }: { params: Promise<{ channel: string }> }) {
  const { channel } = await params;
  const ctx = await currentContext();
  const brand = getBrand(channel, ctx.workspaceId);
  if (!brand) return notFound();

  const status = connectionFor(channel);
  const { config, templates } = responderFor(channel);
  const insights = insightsFor(channel);

  return (
    <>
      <div className="page-head">
        <div className="eyebrow">// connections / manage</div>
        <h1 className="h1">{brand.name}</h1>
        <div className="sub">
          <Link href="/connections" className="btn" style={{ padding: "4px 9px", fontSize: 11.5, marginRight: 8 }}>
            <ChevronLeft size={12} /> All connections
          </Link>
          Connection, responder rules, templates, test &amp; insights.
        </div>
      </div>

      <ManagePanels
        channel={channel}
        brandName={brand.name}
        status={status}
        config={config}
        templates={templates}
        insights={insights}
        canPublish={ctxCan(ctx, "content.publish")}
        canEdit={ctxCan(ctx, "content.edit.any")}
      />
    </>
  );
}
