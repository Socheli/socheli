import { cookies } from "next/headers";
import { audit } from "../../../../../lib/audit";
import { exchangeOpenRouterCode } from "../../../../../lib/ai-providers";
import { currentContext, ctxCan } from "../../../../../lib/tenancy";

export const dynamic = "force-dynamic";

function redirect(url: string): Response {
  return new Response(null, { status: 302, headers: { Location: url } });
}

export async function GET(req: Request) {
  const ctx = await currentContext();
  const params = new URL(req.url).searchParams;
  const code = params.get("code")?.trim() ?? "";
  const denied = params.get("error");
  const jar = await cookies();
  const verifier = jar.get("or_pkce")?.value ?? "";

  if (denied) return redirect("/connections?ai=openrouter-denied");
  if (!ctxCan(ctx, "content.publish")) return redirect("/connections?ai=forbidden");
  if (!code || !verifier) return redirect("/connections?ai=openrouter-missing-code");

  const res = await exchangeOpenRouterCode(ctx.workspaceId, code, verifier);
  audit(ctx, "ai_provider.openrouter_oauth_callback", "openrouter", {});
  if (!res.ok) return redirect("/connections?ai=openrouter-exchange-failed");

  const out = redirect("/connections?ai=openrouter-connected");
  out.headers.append("Set-Cookie", "or_pkce=; Path=/api/ai-providers/openrouter; Max-Age=0; HttpOnly; SameSite=Lax");
  return out;
}
