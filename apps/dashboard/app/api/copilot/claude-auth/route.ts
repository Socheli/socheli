import { setClaudeOAuthToken, claudeAuthStatus } from "../../../../lib/agent/claude-auth";
import { currentContext, assertCan, forbidden } from "../../../../lib/tenancy";
import { audit } from "../../../../lib/audit";

export const dynamic = "force-dynamic";

/* Connect the server to Claude Code: the user generates a token with
   `claude setup-token` and pastes it here. Stored 0600; never returned. GET
   reports only whether a token is present. Write needs admin rights. */
export async function GET() {
  return Response.json(claudeAuthStatus());
}

export async function POST(req: Request) {
  const ctx = await currentContext();
  try {
    assertCan(ctx, "content.edit.any");
  } catch {
    return forbidden("content.edit.any");
  }
  const body = await req.json().catch(() => ({}));
  const token = String(body.token ?? "").trim();
  if (!token) return Response.json({ error: "token is required" }, { status: 400 });
  setClaudeOAuthToken(token);
  audit(ctx, "copilot.claude_auth", "connect", {});
  return Response.json({ ok: true, ...claudeAuthStatus() });
}
