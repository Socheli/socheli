import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "../data";

/* Claude Code OAuth token for the SERVER-side subscription path. The user runs
   `claude setup-token` (on any machine with a browser), pastes the resulting
   token into the connect UI, and we store it 0600 and inject it as
   CLAUDE_CODE_OAUTH_TOKEN into the `soli-turn` child — so the server's headless
   `claude` runs on their Claude Code (Max/Pro) subscription with NO API key and
   NO dependency on the M4 being online. Secret: never synced, never committed. */
const FILE = join(REPO_ROOT, "data", "claude-oauth.json");

export function getClaudeOAuthToken(): string | null {
  try {
    if (existsSync(FILE)) {
      const j = JSON.parse(readFileSync(FILE, "utf8")) as { token?: string };
      if (j?.token && typeof j.token === "string") return j.token;
    }
  } catch {
    /* ignore */
  }
  return process.env.CLAUDE_CODE_OAUTH_TOKEN || null;
}

export function setClaudeOAuthToken(token: string): void {
  const t = token.trim();
  if (!t) throw new Error("token is required");
  mkdirSync(join(REPO_ROOT, "data"), { recursive: true });
  writeFileSync(FILE, JSON.stringify({ token: t, updatedAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
}

export function claudeAuthStatus(): { connected: boolean } {
  return { connected: !!getClaudeOAuthToken() };
}
