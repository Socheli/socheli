import Link from "next/link";
import { currentContext, ctxCan } from "../../lib/tenancy";
import { listBrands } from "../../lib/brands";
import { connectionFor } from "../../lib/connections";
import { responderConfigFor } from "../../lib/responder";
import { PageHead } from "../PageHead";
import { ConnectionsBoard, type ConnectionRow } from "./ConnectionsBoard";
import { MetaAppCard } from "./MetaAppCard";
import { IgAppCard } from "./IgAppCard";
import { SearchProvidersCard } from "./SearchProvidersCard";
import { searchProviderStatuses } from "../../lib/search-providers";

export const dynamic = "force-dynamic";

/* Connections — per-brand Meta (Instagram/Facebook) account connections and the
   custom responder agent (engine: connections.ts / responder.ts). Server shell:
   one row per brand in the caller's workspace with its live connection state,
   webhook subscription, and responder on/off + default action. Connecting and
   enabling the responder are gated to content.publish (the live-account gate);
   editing rules/templates is content.edit.any. */

export default async function ConnectionsPage() {
  const ctx = await currentContext();
  const brands = listBrands(ctx.workspaceId);

  const rows: ConnectionRow[] = brands.map((b) => {
    const conn = connectionFor(b.id);
    const cfg = responderConfigFor(b.id);
    return { ...conn, brandName: b.name, responderEnabled: cfg.enabled, defaultAction: cfg.defaultAction };
  });

  return (
    <>
      <PageHead
        section="engage"
        title="Connections"
        sub="Connect each brand's own Instagram/Facebook account, then configure a custom responder that handles comments & DMs in your brand voice. Connecting and going live are gated to you; drafting and configuring are safe."
      />
      <Link href="/ai-models" className="card" style={{ display: "flex", alignItems: "center", gap: 12, textDecoration: "none", marginBottom: 16 }}>
        <span style={{ flex: 1 }}>
          <span style={{ display: "block", fontWeight: 600, color: "var(--text-primary)" }}>AI models &amp; providers</span>
          <span className="sub" style={{ fontSize: 13 }}>Connect any LLM provider (OpenAI, Anthropic, Gemini, Groq, OpenRouter, local, …) and pick a model per pipeline task. Moved to AI Models.</span>
        </span>
        <span style={{ color: "var(--accent)", fontFamily: "var(--font-mono)", fontSize: 12 }}>open →</span>
      </Link>
      <SearchProvidersCard providers={searchProviderStatuses(ctx.workspaceId)} canManage={ctxCan(ctx, "content.publish")} />
      <MetaAppCard canManage={ctxCan(ctx, "content.publish")} />
      <IgAppCard canManage={ctxCan(ctx, "content.publish")} />
      <ConnectionsBoard rows={rows} canConnect={ctxCan(ctx, "content.publish")} canEdit={ctxCan(ctx, "content.edit.any")} />
    </>
  );
}
