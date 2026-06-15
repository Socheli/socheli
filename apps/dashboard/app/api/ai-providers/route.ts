import { NextResponse } from "next/server";
import { audit } from "../../../lib/audit";
import { aiProviderStatuses, clearAiProvider, openRouterOAuthStart, selectAiProvider, setAiProviderKey, type BrainProviderId } from "../../../lib/ai-providers";
import { currentContext, ctxCan, forbidden } from "../../../lib/tenancy";

export const dynamic = "force-dynamic";

const IDS = new Set(["claude", "codex", "openrouter", "anthropic", "openai"]);
const isProvider = (id: string): id is BrainProviderId => IDS.has(id);

function originFrom(req: Request): string {
  const url = new URL(req.url);
  return `${url.protocol}//${url.host}`;
}

export async function GET() {
  const ctx = await currentContext();
  return Response.json({ providers: aiProviderStatuses(ctx.workspaceId) });
}

export async function POST(req: Request) {
  const ctx = await currentContext();
  if (!ctxCan(ctx, "content.publish")) return forbidden("content.publish");
  const body = await req.json().catch(() => null);
  const action = String(body?.action ?? "");
  const provider = String(body?.provider ?? "");
  if (!isProvider(provider)) return Response.json({ error: "unknown provider" }, { status: 400 });

  if (action === "set_key") {
    const apiKey = String(body?.apiKey ?? "").trim();
    const model = String(body?.model ?? "").trim();
    if (!apiKey) return Response.json({ error: "apiKey is required" }, { status: 400 });
    setAiProviderKey(ctx.workspaceId, provider, apiKey, model || undefined);
    audit(ctx, "ai_provider.set_key", provider, { model: model || undefined });
    return Response.json({ ok: true, providers: aiProviderStatuses(ctx.workspaceId) });
  }

  if (action === "select") {
    const model = String(body?.model ?? "").trim();
    selectAiProvider(ctx.workspaceId, provider, model || undefined);
    audit(ctx, "ai_provider.select", provider, { model: model || undefined });
    return Response.json({ ok: true, providers: aiProviderStatuses(ctx.workspaceId) });
  }

  if (action === "clear") {
    const removed = clearAiProvider(ctx.workspaceId, provider);
    audit(ctx, "ai_provider.clear", provider, { removed });
    return Response.json({ ok: true, providers: aiProviderStatuses(ctx.workspaceId) });
  }

  if (action === "openrouter_oauth_start") {
    if (provider !== "openrouter") return Response.json({ error: "OAuth is currently available for OpenRouter only" }, { status: 400 });
    const callbackUrl = `${originFrom(req)}/api/ai-providers/openrouter/callback`;
    const { url, verifier } = openRouterOAuthStart(callbackUrl);
    const res = NextResponse.json({ ok: true, url });
    res.cookies.set("or_pkce", verifier, { httpOnly: true, sameSite: "lax", secure: new URL(req.url).protocol === "https:", path: "/api/ai-providers/openrouter", maxAge: 10 * 60 });
    audit(ctx, "ai_provider.openrouter_oauth_start", "openrouter", {});
    return res;
  }

  return Response.json({ error: `unknown action: ${action}` }, { status: 400 });
}
