import { audit } from "../../../lib/audit";
import { clearSearchProvider, isSearchProvider, searchProviderStatuses, setSearchProviderKey } from "../../../lib/search-providers";
import { currentContext, ctxCan, forbidden } from "../../../lib/tenancy";

export const dynamic = "force-dynamic";

export async function GET() {
  const ctx = await currentContext();
  return Response.json({ providers: searchProviderStatuses(ctx.workspaceId) });
}

export async function POST(req: Request) {
  const ctx = await currentContext();
  if (!ctxCan(ctx, "content.publish")) return forbidden("content.publish");
  const body = await req.json().catch(() => null);
  const action = String(body?.action ?? "");
  const provider = String(body?.provider ?? "");
  if (!isSearchProvider(provider)) return Response.json({ error: "unknown provider" }, { status: 400 });

  if (action === "set_key") {
    const apiKey = String(body?.apiKey ?? "").trim();
    if (!apiKey) return Response.json({ error: "apiKey is required" }, { status: 400 });
    try {
      setSearchProviderKey(ctx.workspaceId, provider, apiKey);
    } catch (e) {
      return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
    }
    audit(ctx, "search_provider.set_key", provider, {});
    return Response.json({ ok: true, providers: searchProviderStatuses(ctx.workspaceId) });
  }

  if (action === "clear") {
    const removed = clearSearchProvider(ctx.workspaceId, provider);
    audit(ctx, "search_provider.clear", provider, { removed });
    return Response.json({ ok: true, providers: searchProviderStatuses(ctx.workspaceId) });
  }

  return Response.json({ error: `unknown action: ${action}` }, { status: 400 });
}
