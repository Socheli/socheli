import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft } from "lucide-react";
import { currentContext, ctxCan } from "../../../../lib/tenancy";
import { getBrand } from "../../../../lib/brands";
import { connectionFor } from "../../../../lib/connections";
import { responderFor } from "../../../../lib/responder";
import { ConnectWizard } from "./ConnectWizard";

export const dynamic = "force-dynamic";

/* Per-brand connection setup wizard. 404s unless the channel is a brand in the
   caller's workspace. The OAuth callback redirects back here with ?step=2 (and
   an optional ?error= flag the wizard surfaces). */

export default async function ConnectionSetupPage({
  params,
  searchParams,
}: {
  params: Promise<{ channel: string }>;
  searchParams: Promise<{ step?: string; error?: string }>;
}) {
  const { channel } = await params;
  const { step, error } = await searchParams;
  const ctx = await currentContext();
  const brand = getBrand(channel, ctx.workspaceId);
  if (!brand) return notFound();

  const status = connectionFor(channel);
  const { config, templates } = responderFor(channel);
  const initialStep = step ? parseInt(step, 10) || 1 : 1;

  return (
    <>
      <div className="page-head">
        <div className="eyebrow">// connections / setup</div>
        <h1 className="h1">Connect {brand.name}</h1>
        <div className="sub">
          <Link href="/connections" className="btn" style={{ padding: "4px 9px", fontSize: 11.5, marginRight: 8 }}>
            <ChevronLeft size={12} /> All connections
          </Link>
          Connect the account, configure the responder, test, and go live.
        </div>
      </div>

      {error && (
        <div className="card" style={{ marginBottom: 16, padding: "9px 14px", borderColor: "var(--error, #ef5350)" }}>
          <span style={{ fontSize: 12.5, color: "var(--error, #ef5350)" }}>
            {error === "denied" ? "Authorization was cancelled." : error === "exchange" ? "Could not complete the token exchange — try again." : "Something went wrong connecting — try again."}
          </span>
        </div>
      )}

      <ConnectWizard
        channel={channel}
        brandName={brand.name}
        initialStep={initialStep}
        initialStatus={status}
        initialConfig={config}
        templates={templates}
        canPublish={ctxCan(ctx, "content.publish")}
        canEdit={ctxCan(ctx, "content.edit.any")}
      />
    </>
  );
}
