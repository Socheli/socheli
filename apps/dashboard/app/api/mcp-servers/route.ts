import { currentContext, ctxCan, forbidden } from "../../../lib/tenancy";
import { audit } from "../../../lib/audit";
import {
  loadMcpServers,
  saveMcpServers,
  mcpStatus,
  newServerId,
  invalidateMcp,
  stdioAllowed,
  type McpServerConfig,
  type McpTransport,
} from "../../../lib/agent/mcp";

/* /api/mcp-servers — manage the external MCP servers plugged into Soli's tool
   surface (lib/agent/mcp.ts; config in data/mcp-servers.json, gitignored).

   SECURITY — an MCP server config is a command-execution / data-exfiltration
   vector, so this is gated HARD:
   - All mutations require "apikey.manage" (admin/owner only — the same grade
     as issuing credentials, which is exactly what connecting a tool server
     is). Members and viewers are denied.
   - GET is readable by any signed-in member, but command/args/env/url are
     REDACTED to name+transport+enabled+status unless the caller holds the
     manage permission.
   - stdio servers (arbitrary command spawn) are accepted only when the
     deployment sets MCP_ALLOW_STDIO=1 — default OFF, because on the shared
     cloud dashboard "run this command" is remote code execution. http servers
     are always allowed. The runtime in mcp.ts re-checks the same env so a
     hand-edited config file cannot bypass this gate either.
   - `env` is a list of env var NAMES to pass through to a stdio child; values
     are never accepted, stored, returned, or logged.
   - Every mutation is audited (lib/audit), like /api/admin. */

export const dynamic = "force-dynamic";

const MANAGE = "apikey.manage" as const;

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_SERVERS = 20;

type Validated = Pick<McpServerConfig, "name" | "transport" | "command" | "args" | "env" | "url" | "timeoutMs">;

/* Validate a client-supplied server payload. Returns the clean fields or a
   human-readable error string. */
function validateServer(body: unknown): { ok: true; server: Validated } | { ok: false; error: string } {
  const b = (body ?? {}) as Record<string, unknown>;
  const name = String(b.name ?? "").trim().slice(0, 60);
  if (!name) return { ok: false, error: "name is required" };
  const transport = b.transport as McpTransport;
  if (transport !== "stdio" && transport !== "http") return { ok: false, error: 'transport must be "stdio" or "http"' };

  const timeoutMs =
    Number.isFinite(Number(b.timeoutMs)) && Number(b.timeoutMs) > 0
      ? Math.min(Number(b.timeoutMs), 300_000)
      : undefined;

  if (transport === "http") {
    const url = String(b.url ?? "").trim();
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return { ok: false, error: "url must be a valid URL" };
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return { ok: false, error: "url must be http(s)" };
    }
    return { ok: true, server: { name, transport, url, timeoutMs } };
  }

  // stdio — the RCE-shaped transport. Deployment opt-in required.
  if (!stdioAllowed()) {
    return { ok: false, error: "stdio MCP servers are disabled on this deployment (set MCP_ALLOW_STDIO=1 on the server to allow local commands)" };
  }
  const command = String(b.command ?? "").trim();
  if (!command) return { ok: false, error: "command is required for stdio servers" };
  const args = Array.isArray(b.args) ? b.args.map((a) => String(a)).filter(Boolean).slice(0, 32) : [];
  const env = Array.isArray(b.env) ? b.env.map((e) => String(e).trim()).filter(Boolean) : [];
  for (const e of env) {
    // Names only — anything that looks like NAME=value is someone pasting a secret.
    if (!ENV_NAME.test(e)) return { ok: false, error: `env entries must be variable NAMES (got "${e.slice(0, 40)}"); values are read from the server environment` };
  }
  return { ok: true, server: { name, transport, command, args, env: env.slice(0, 16), timeoutMs } };
}

/* Public (redacted) view: enough for any member to see what's connected,
   nothing about how. */
function redacted(s: { id: string; name: string; transport: McpTransport; enabled: boolean }) {
  return { id: s.id, name: s.name, transport: s.transport, enabled: s.enabled };
}

export async function GET() {
  const ctx = await currentContext();
  const canManage = ctxCan(ctx, MANAGE);
  const statuses = await mcpStatus();
  const configs = new Map(loadMcpServers().map((s) => [s.id, s]));
  const servers = statuses.map((st) => {
    const cfg = configs.get(st.id);
    const base = { ...redacted(st), status: st.status, toolCount: st.toolCount ?? null, error: st.error ?? null };
    if (!canManage || !cfg) return base;
    return { ...base, command: cfg.command ?? null, args: cfg.args ?? [], env: cfg.env ?? [], url: cfg.url ?? null, timeoutMs: cfg.timeoutMs ?? null };
  });
  return Response.json({ servers, canManage, stdioAllowed: stdioAllowed() });
}

export async function POST(req: Request) {
  const ctx = await currentContext();
  if (!ctxCan(ctx, MANAGE)) return forbidden(MANAGE);

  const body = await req.json().catch(() => null);
  const action = String(body?.action ?? "");
  const servers = loadMcpServers();

  if (action === "add") {
    if (servers.length >= MAX_SERVERS) return Response.json({ error: `limit of ${MAX_SERVERS} servers reached` }, { status: 400 });
    const v = validateServer(body?.server);
    if (v.ok === false) return Response.json({ error: v.error }, { status: 400 });
    const server: McpServerConfig = { id: newServerId(), enabled: true, ...v.server };
    saveMcpServers([...servers, server]);
    invalidateMcp();
    audit(ctx, "mcp.server.add", server.id, { name: server.name, transport: server.transport });
    return Response.json({ ok: true, server });
  }

  // Everything below operates on an existing server by id.
  const id = String(body?.id ?? "");
  const existing = servers.find((s) => s.id === id);
  if (!existing) return Response.json({ error: "server not found" }, { status: 404 });

  if (action === "update") {
    const v = validateServer({ ...existing, ...((body?.server ?? {}) as Record<string, unknown>) });
    if (v.ok === false) return Response.json({ error: v.error }, { status: 400 });
    const next: McpServerConfig = { id: existing.id, enabled: existing.enabled, ...v.server };
    saveMcpServers(servers.map((s) => (s.id === id ? next : s)));
    invalidateMcp(id); // kill any pooled child built from the old command/url
    audit(ctx, "mcp.server.update", id, { name: next.name, transport: next.transport });
    return Response.json({ ok: true, server: next });
  }

  if (action === "toggle") {
    const enabled = body?.enabled === true;
    // Re-enabling a stdio server while the deployment forbids stdio stays blocked.
    if (enabled && existing.transport === "stdio" && !stdioAllowed()) {
      return Response.json({ error: "stdio MCP servers are disabled on this deployment (MCP_ALLOW_STDIO unset)" }, { status: 400 });
    }
    const next = { ...existing, enabled };
    saveMcpServers(servers.map((s) => (s.id === id ? next : s)));
    invalidateMcp(id);
    audit(ctx, "mcp.server.toggle", id, { name: existing.name, enabled });
    return Response.json({ ok: true, server: next });
  }

  if (action === "delete") {
    saveMcpServers(servers.filter((s) => s.id !== id));
    invalidateMcp(id);
    audit(ctx, "mcp.server.delete", id, { name: existing.name, transport: existing.transport });
    return Response.json({ ok: true });
  }

  return Response.json({ error: `unknown action: ${action}` }, { status: 400 });
}
