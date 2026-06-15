import { SettingsClient } from "./SettingsClient";
import { McpServersCard } from "./McpServersCard";
import { currentContext, ctxCan } from "../../lib/tenancy";
import { PageHead } from "../PageHead";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const apiBase = process.env.SOCHELI_PUBLIC_API_URL || "https://api.socheli.com";
  const ctx = await currentContext();
  // Gate the API-key UI server-side; the client only ever offers what the role allows.
  const canManageKeys = ctxCan(ctx, "apikey.manage");
  return (
    <>
      <PageHead
        section="account"
        title="Settings"
        sub="Your profile, security, team, and developer access."
      />
      <SettingsClient apiBase={apiBase} role={ctx.role} canManageKeys={canManageKeys} />
      {/* External MCP connections for the Soli copilot (self-gating: the card
          reads canManage/stdioAllowed from /api/mcp-servers and offers only
          what the caller's role allows). */}
      <McpServersCard />
    </>
  );
}
