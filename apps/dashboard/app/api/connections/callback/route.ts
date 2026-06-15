import { currentContext, ctxCan } from "../../../../lib/tenancy";
import { audit } from "../../../../lib/audit";
import { getBrand } from "../../../../lib/brands";
import { runConnectionTool } from "../../../../lib/connections";

/* Meta OAuth redirect target (engine: connections.ts connect_callback).
   Meta redirects the browser here after the brand owner authorizes:
     GET /api/connections/callback?code=…&state=…
   `state` carries the channel (signed/round-tripped by connect_start). We
   re-resolve the channel from state, verify it's a brand in the caller's
   workspace, exchange the code for the brand's long-lived PAGE token via the
   engine, then redirect back into the wizard at the Verify step.

   SECURITY: the OAuth `code` and the resulting token NEVER appear in a log,
   audit meta, or redirect URL. On any failure we redirect back to the wizard
   with a generic error flag (no code/token leakage). */

export const dynamic = "force-dynamic";

/* `state` is "<channel>:<nonce>" minted by connect_start; the channel is the
   part before the first ':'. We never trust it for auth — we still gate on the
   caller's session + workspace ownership below. */
function channelFromState(state: string): string {
  return state.includes(":") ? state.slice(0, state.indexOf(":")) : state;
}

function redirect(url: string): Response {
  return new Response(null, { status: 302, headers: { Location: url } });
}

export async function GET(req: Request) {
  const ctx = await currentContext();
  const params = new URL(req.url).searchParams;
  const code = params.get("code")?.trim() ?? "";
  const state = params.get("state")?.trim() ?? "";
  const oauthError = params.get("error");

  const channel = channelFromState(state);

  // The user denied on Meta's consent screen, or no channel could be derived.
  if (oauthError || !channel) {
    const back = channel ? `/connections/${encodeURIComponent(channel)}/setup?step=1&error=denied` : "/connections?error=denied";
    return redirect(back);
  }

  if (!getBrand(channel, ctx.workspaceId)) return redirect("/connections?error=brand");
  // This is a browser redirect target — on a permission miss, redirect back into
  // the wizard with a flag rather than dumping raw JSON 403 at the user.
  if (!ctxCan(ctx, "content.publish")) return redirect(`/connections/${encodeURIComponent(channel)}/setup?step=1&error=forbidden`);
  if (!code) return redirect(`/connections/${encodeURIComponent(channel)}/setup?step=1&error=nocode`);

  // Pass workspaceId so the SAME Meta app that started the flow (the workspace's
  // own app, if set) verifies the state + exchanges the code.
  const res = await runConnectionTool("connect_callback", { channel, code, state, workspaceId: ctx.workspaceId });

  // Audit WITHOUT code/token.
  audit(ctx, "connection.connect_callback", channel, {});

  const step = res.ok ? "2" : "1";
  const errFlag = res.ok ? "" : "&error=exchange";
  return redirect(`/connections/${encodeURIComponent(channel)}/setup?step=${step}${errFlag}`);
}
