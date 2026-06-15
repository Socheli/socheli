import { existsSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import {
  Connection,
  ConnectionScope,
  recordInWorkspace,
  type ConnectionView,
} from "@os/schemas";

import { DATA_DIR, ensureDir, nowIso } from "./store.ts";
import { httpCurl } from "./http.ts";
import { isTokenError } from "./publish-types.ts";
import { resolveMetaApp } from "./meta-app.ts";

/* Per-brand Meta (Instagram/Facebook) connections — the credential layer that
   replaces the single global IG_USER_ID / IG_ACCESS_TOKEN. Each brand connects
   its OWN account via Meta (Facebook Login); the PAGE access token is stored per
   channel and resolved by comments.ts / dms.ts / instagram.ts / insights.ts.

   THIS MODULE IS THE SOLE WRITER OF THE CREDENTIAL RESOLVER — everyone else
   imports resolveIgCreds(channel). Resolution order (NEVER throws):
     1. a stored connection (status !== "revoked")  → { source: "connection" }
     2. else process.env.IG_USER_ID + IG_ACCESS_TOKEN → { source: "env" }  (global back-compat, channel="global")
     3. else null

   Live Graph calls follow the comments.ts / dms.ts idioms exactly: token-gated,
   NEVER throw (return { ok:false, reason }), NEVER console.log the token, and map
   Meta code-190 / OAuthException via isTokenError. The token NEVER crosses the
   wire — tools return only the redacted ConnectionView (toView). */

const GRAPH = "https://graph.facebook.com/v21.0";
// Instagram-Login (IG-user token) Graph host — DISTINCT from the Facebook host.
// Tokens minted via the Instagram API with Instagram Login must hit this base.
const GRAPH_IG = "https://graph.instagram.com/v25.0";
const useProxy = () => process.env.IG_USE_PROXY === "1";

function graphJson(r: { stdout: string }): any {
  try {
    return JSON.parse(r.stdout);
  } catch {
    return { error: { message: (r.stdout || "").slice(0, 200) } };
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Store — data/connections/<sanitize(channel)>.json (flat JSON, atomic)
// ───────────────────────────────────────────────────────────────────────────

const CONNECTIONS_DIR = join(DATA_DIR, "connections");
const sanitize = (c: string) => (c || "global").replace(/[^a-zA-Z0-9_-]/g, "-");
const connectionFile = (channel: string) => join(CONNECTIONS_DIR, `${sanitize(channel)}.json`);

function saveJson(path: string, data: unknown): void {
  ensureDir(path.slice(0, path.lastIndexOf("/")));
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  renameSync(tmp, path);
}

export function loadConnection(channel: string): Connection | null {
  const path = connectionFile(channel);
  if (!existsSync(path)) return null;
  try {
    const parsed = Connection.safeParse(JSON.parse(readFileSync(path, "utf8")));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** A usable connection for live calls: present and not revoked. */
export function resolveConnection(channel: string): Connection | null {
  const c = loadConnection(channel);
  if (!c || c.status === "revoked") return null;
  return c;
}

export function saveConnection(c: Connection): Connection {
  const stamped: Connection = { ...c, updatedAt: nowIso() };
  saveJson(connectionFile(c.channelId), stamped);
  return stamped;
}

export function deleteConnection(channel: string): boolean {
  const path = connectionFile(channel);
  if (!existsSync(path)) return false;
  try {
    unlinkSync(path);
    return true;
  } catch {
    return false;
  }
}

/** All stored connections as redacted views; workspace-filtered when ws given. */
export function listConnections(workspaceId?: string): ConnectionView[] {
  if (!existsSync(CONNECTIONS_DIR)) return [];
  const out: ConnectionView[] = [];
  for (const f of readdirSync(CONNECTIONS_DIR)) {
    if (!f.endsWith(".json")) continue;
    try {
      const parsed = Connection.safeParse(JSON.parse(readFileSync(join(CONNECTIONS_DIR, f), "utf8")));
      if (!parsed.success) continue;
      const c = parsed.data;
      if (workspaceId && !recordInWorkspace(c, workspaceId)) continue;
      out.push(toView(c));
    } catch {
      continue;
    }
  }
  return out.sort((a, b) => a.channelId.localeCompare(b.channelId));
}

/** One brand's connection as a redacted view (expiry/refresh warnings), or null. */
export function connectionStatusFor(channel: string): ConnectionView | null {
  const c = loadConnection(channel);
  return c ? toView(c) : null;
}

/** Map an IG account id (or page id) to the channel that owns it (webhook routing). */
export function channelForIgAccount(igUserId: string): string | null {
  if (!igUserId || !existsSync(CONNECTIONS_DIR)) return null;
  for (const f of readdirSync(CONNECTIONS_DIR)) {
    if (!f.endsWith(".json")) continue;
    try {
      const parsed = Connection.safeParse(JSON.parse(readFileSync(join(CONNECTIONS_DIR, f), "utf8")));
      if (!parsed.success) continue;
      const c = parsed.data;
      if (String(c.igUserId) === String(igUserId) || (c.pageId && String(c.pageId) === String(igUserId))) {
        return c.channelId;
      }
    } catch {
      continue;
    }
  }
  return null;
}

/** Redact a connection for transport: drop the token, expose last-4 + expiry summary. */
export function toView(c: Connection): ConnectionView {
  const { token, ...rest } = c;
  const tokenPreview = token ? `…${token.slice(-4)}` : undefined;
  let expiresInDays: number | undefined;
  let needsRefresh: boolean | undefined;
  if (c.expiresAt) {
    const days = (new Date(c.expiresAt).getTime() - Date.now()) / 86_400_000;
    if (Number.isFinite(days)) {
      expiresInDays = Math.round(days);
      needsRefresh = days < 7;
    }
  }
  return { ...rest, tokenPreview, expiresInDays, needsRefresh } as ConnectionView;
}

// ───────────────────────────────────────────────────────────────────────────
// Credential resolver — THE single source of truth for live IG creds per channel
// ───────────────────────────────────────────────────────────────────────────

export type IgCreds = {
  userId: string;
  token: string;
  /** Which Graph API flavor issued the token — picks the base host. */
  api: "facebook" | "instagram";
  /** The full versioned Graph host to call (graph.facebook.com/v21.0 vs graph.instagram.com/v25.0). */
  base: string;
  pageId?: string;
  source: "connection" | "env";
};

/** Resolve live IG credentials for a channel. Stored connection wins; else global
    env fallback (channel="global"); else null. NEVER throws.

    `api`/`base` let callers (dms/comments/insights) pick the right Graph host:
    an instagram_login connection issues an IG-user token that MUST hit
    graph.instagram.com, while a facebook_login (or env) token hits graph.facebook.com.
    GUARANTEE: when api==="facebook", base===GRAPH, so every Facebook request is
    byte-for-byte identical to before. */
export function resolveIgCreds(channel: string | undefined): IgCreds | null {
  const conn = channel ? resolveConnection(channel) : null;
  if (conn && conn.igUserId && conn.token) {
    const api = conn.authType === "instagram_login" ? "instagram" : "facebook";
    const base = api === "instagram" ? GRAPH_IG : GRAPH;
    return { userId: conn.igUserId, token: conn.token, api, base, pageId: conn.pageId, source: "connection" };
  }
  const userId = process.env.IG_USER_ID;
  const token = process.env.IG_ACCESS_TOKEN;
  if (userId && token) return { userId, token, api: "facebook", base: GRAPH, source: "env" };
  return null;
}

// ───────────────────────────────────────────────────────────────────────────
// OAuth — Facebook Login flow (authorize → exchange → long-lived token)
// ───────────────────────────────────────────────────────────────────────────

type Fail = { ok: false; reason: string };
type OkView = { ok: true; view: ConnectionView };

const OAUTH_SCOPES: string[] = ConnectionScope.options as string[];

/* App credentials resolve per-workspace (BYO: workspace store > env). The
   workspaceId flows from the caller (dashboard route → ctx.workspaceId; CLI →
   undefined → env). Deployed instance = Socheli's env app by default; a workspace
   that set its own app overrides it; a local self-host just sets the env. */

function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** HMAC(channel|nonce, <workspace or env app secret>) → base64url, nonce-prefixed
    so the callback can recompute it. Format: <nonce>.<hmac>. */
function signState(channel: string, nonce: string, workspaceId?: string): string {
  const mac = createHmac("sha256", resolveMetaApp(workspaceId).appSecret).update(`${channel}|${nonce}`).digest();
  return `${nonce}.${base64url(mac)}`;
}

/** Build the Facebook Login authorize URL + an opaque state to verify on callback. */
export function authorizeUrl(channel: string, workspaceId?: string): { url: string; state: string } {
  const app = resolveMetaApp(workspaceId);
  const nonce = base64url(randomBytes(12));
  const state = signState(channel, nonce, workspaceId);
  const params = new URLSearchParams({
    client_id: app.appId,
    redirect_uri: app.redirect,
    state,
    scope: OAUTH_SCOPES.join(","),
    response_type: "code",
  });
  return { url: `https://www.facebook.com/v21.0/dialog/oauth?${params.toString()}`, state };
}

/** Recompute the HMAC from the embedded nonce and constant-time compare. */
export function verifyState(channel: string, state: string, workspaceId?: string): boolean {
  if (!state || !resolveMetaApp(workspaceId).appSecret) return false;
  const dot = state.indexOf(".");
  if (dot <= 0) return false;
  const nonce = state.slice(0, dot);
  const expected = signState(channel, nonce, workspaceId);
  const a = Buffer.from(state);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Which granted scopes (token-free) to record. We record the scopes we requested
    that Graph confirmed; for the v21 long-lived flow Graph doesn't echo scopes on
    /me, so we record the requested set as the best-known grant. */
function knownScopes(): ConnectionScope[] {
  return ConnectionScope.options.filter((s) => OAUTH_SCOPES.includes(s)) as ConnectionScope[];
}

/** ISO expiry from a Graph `expires_in` (seconds), if present. */
function expiryFrom(expiresIn?: unknown): string | undefined {
  const secs = typeof expiresIn === "number" ? expiresIn : Number(expiresIn);
  if (!Number.isFinite(secs) || secs <= 0) return undefined;
  return new Date(Date.now() + secs * 1000).toISOString();
}

/** Exchange an OAuth code for a long-lived PAGE token, discover the IG business
    account, persist the connection, and best-effort subscribe webhooks. */
export async function exchangeCode(channel: string, code: string, state: string, workspaceId?: string): Promise<OkView | Fail> {
  const app = resolveMetaApp(workspaceId);
  if (!app.appId || !app.appSecret || !app.redirect) {
    return { ok: false, reason: "No Meta app configured. Set META_APP_ID + META_APP_SECRET + META_OAUTH_REDIRECT, or set a workspace app with meta_app_set." };
  }
  if (!verifyState(channel, state, workspaceId)) return { ok: false, reason: "state mismatch — possible CSRF or stale link; restart the connect flow" };

  // 1) code → short-lived user token
  const shortRes = graphJson(
    httpCurl(
      [
        `${GRAPH}/oauth/access_token?client_id=${encodeURIComponent(app.appId)}&redirect_uri=${encodeURIComponent(app.redirect)}&client_secret=${encodeURIComponent(app.appSecret)}&code=${encodeURIComponent(code)}`,
      ],
      { proxy: useProxy() },
    ),
  );
  if (shortRes?.error) {
    if (isTokenError(String(shortRes.error?.message ?? ""), shortRes.error?.code)) return { ok: false, reason: `OAuth code rejected: ${shortRes.error?.message ?? "code-190"}` };
    return { ok: false, reason: `code exchange failed: ${shortRes.error?.message ?? "unknown"}` };
  }
  const shortToken = String(shortRes?.access_token ?? "");
  if (!shortToken) return { ok: false, reason: "code exchange returned no access_token" };

  // 2) short-lived → long-lived user token
  const longRes = graphJson(
    httpCurl(
      [
        `${GRAPH}/oauth/access_token?grant_type=fb_exchange_token&client_id=${encodeURIComponent(app.appId)}&client_secret=${encodeURIComponent(app.appSecret)}&fb_exchange_token=${encodeURIComponent(shortToken)}`,
      ],
      { proxy: useProxy() },
    ),
  );
  if (longRes?.error) {
    if (isTokenError(String(longRes.error?.message ?? ""), longRes.error?.code)) return { ok: false, reason: `long-lived exchange rejected: ${longRes.error?.message ?? "code-190"}` };
    return { ok: false, reason: `long-lived exchange failed: ${longRes.error?.message ?? "unknown"}` };
  }
  const userToken = String(longRes?.access_token ?? "");
  if (!userToken) return { ok: false, reason: "long-lived exchange returned no access_token" };
  const expiresAt = expiryFrom(longRes?.expires_in);

  // 3) /me/accounts → pages + their IG business account + PAGE token
  const accounts = graphJson(
    httpCurl(
      [`${GRAPH}/me/accounts?fields=id,name,access_token,instagram_business_account{id,username}&access_token=${encodeURIComponent(userToken)}`],
      { proxy: useProxy() },
    ),
  );
  if (accounts?.error) {
    if (isTokenError(String(accounts.error?.message ?? ""), accounts.error?.code)) return { ok: false, reason: `account lookup rejected: ${accounts.error?.message ?? "code-190"}` };
    return { ok: false, reason: `account lookup failed: ${accounts.error?.message ?? "unknown"}` };
  }
  const pages = (accounts?.data ?? []) as any[];
  const page = pages.find((p) => p?.instagram_business_account?.id) ?? pages[0];
  if (!page) return { ok: false, reason: "no Facebook Page found on this account — connect a Page with a linked Instagram business account" };
  const igUserId = String(page?.instagram_business_account?.id ?? "");
  if (!igUserId) return { ok: false, reason: "the selected Page has no linked Instagram business account" };
  const pageToken = String(page?.access_token ?? userToken);

  const conn: Connection = {
    channelId: channel,
    provider: "meta",
    authType: "facebook_login",
    api: "facebook",
    igUserId,
    username: page?.instagram_business_account?.username ? String(page.instagram_business_account.username) : undefined,
    pageId: page?.id ? String(page.id) : undefined,
    pageName: page?.name ? String(page.name) : undefined,
    token: pageToken,
    scopes: knownScopes(),
    status: "connected",
    expiresAt,
    connectedAt: nowIso(),
    subscribed: false,
    subscribedFields: [],
  };
  saveConnection(conn);

  // 4) best-effort webhook subscribe (non-fatal — a failure here doesn't undo the connect)
  await subscribeWebhooks(channel).catch(() => undefined);

  const saved = loadConnection(channel) ?? conn;
  return { ok: true, view: toView(saved) };
}

/** Manual fallback: persist a pasted long-lived PAGE token (no OAuth round-trip). */
export function savePastedToken(
  channel: string,
  igUserId: string,
  token: string,
  opts: { pageId?: string; username?: string } = {},
): OkView | Fail {
  if (!igUserId || !token) return { ok: false, reason: "igUserId and token are both required" };
  const conn: Connection = {
    channelId: channel,
    provider: "meta",
    authType: "facebook_login",
    api: "facebook",
    igUserId,
    username: opts.username,
    pageId: opts.pageId,
    token,
    scopes: knownScopes(),
    status: "connected",
    connectedAt: nowIso(),
    subscribed: false,
    subscribedFields: [],
  };
  const saved = saveConnection(conn);
  // best-effort subscribe (fire-and-forget; sync return shape, so we don't await)
  subscribeWebhooks(channel).catch(() => undefined);
  return { ok: true, view: toView(saved) };
}

/** Re-exchange the stored long-lived token to extend expiry. Branches on authType:
    facebook_login uses the Facebook fb_exchange_token endpoint; instagram_login uses
    the Instagram refresh_access_token endpoint (ig_refresh_token; no client_id/secret). */
export async function refreshConnection(channel: string, workspaceId?: string): Promise<OkView | Fail> {
  const conn = loadConnection(channel);
  if (!conn) return { ok: false, reason: `no connection stored for ${channel}` };

  // ── Instagram-Login refresh: GET graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token
  //    The IG endpoint requires the token be ≥24h old (else 400). If the connection
  //    was just made, treat it as not-yet-due rather than marking it expired.
  if (conn.authType === "instagram_login") {
    const ageMs = Date.now() - new Date(conn.connectedAt).getTime();
    if (Number.isFinite(ageMs) && ageMs >= 0 && ageMs < 24 * 3_600_000) {
      return { ok: true, view: toView(conn) }; // <24h old — IG refresh would 400; not yet due
    }
    const igRes = graphJson(
      httpCurl(
        [`${GRAPH_IG}/refresh_access_token?grant_type=ig_refresh_token&access_token=${encodeURIComponent(conn.token)}`],
        { proxy: useProxy() },
      ),
    );
    if (igRes?.error) {
      if (isTokenError(String(igRes.error?.message ?? ""), igRes.error?.code)) {
        saveConnection({ ...conn, status: "expired", lastError: String(igRes.error?.message ?? "code-190") });
        return { ok: false, reason: `IG refresh rejected (re-connect needed): ${igRes.error?.message ?? "code-190"}` };
      }
      return { ok: false, reason: `IG refresh failed: ${igRes.error?.message ?? "unknown"}` };
    }
    const igToken = String(igRes?.access_token ?? "");
    if (!igToken) return { ok: false, reason: "IG refresh returned no access_token" };
    const igSaved = saveConnection({ ...conn, token: igToken, expiresAt: expiryFrom(igRes?.expires_in) ?? conn.expiresAt, status: "connected", lastError: undefined });
    return { ok: true, view: toView(igSaved) };
  }

  const app = resolveMetaApp(workspaceId);
  if (!app.appId || !app.appSecret) return { ok: false, reason: "No Meta app configured (env or workspace) to refresh a token." };

  const res = graphJson(
    httpCurl(
      [
        `${GRAPH}/oauth/access_token?grant_type=fb_exchange_token&client_id=${encodeURIComponent(app.appId)}&client_secret=${encodeURIComponent(app.appSecret)}&fb_exchange_token=${encodeURIComponent(conn.token)}`,
      ],
      { proxy: useProxy() },
    ),
  );
  if (res?.error) {
    if (isTokenError(String(res.error?.message ?? ""), res.error?.code)) {
      saveConnection({ ...conn, status: "expired", lastError: String(res.error?.message ?? "code-190") });
      return { ok: false, reason: `refresh rejected (re-connect needed): ${res.error?.message ?? "code-190"}` };
    }
    return { ok: false, reason: `refresh failed: ${res.error?.message ?? "unknown"}` };
  }
  const token = String(res?.access_token ?? "");
  if (!token) return { ok: false, reason: "refresh returned no access_token" };
  const saved = saveConnection({ ...conn, token, expiresAt: expiryFrom(res?.expires_in) ?? conn.expiresAt, status: "connected", lastError: undefined });
  return { ok: true, view: toView(saved) };
}

// ───────────────────────────────────────────────────────────────────────────
// Webhook subscription — subscribe the Page to comments + messages on connect
// ───────────────────────────────────────────────────────────────────────────

const SUBSCRIBE_FIELDS = ["feed", "comments", "messages", "message_reactions"];

/** Subscribe the connected Page to the app's webhook fields. Token-gated, never throws. */
export async function subscribeWebhooks(channel: string): Promise<{ ok: true; fields: string[] } | Fail> {
  const conn = resolveConnection(channel);
  if (!conn) return { ok: false, reason: `no usable connection for ${channel}` };
  if (!conn.pageId) return { ok: false, reason: "connection has no pageId — webhooks subscribe at the Page level" };

  const res = graphJson(
    httpCurl(
      [
        "-X",
        "POST",
        `${GRAPH}/${conn.pageId}/subscribed_apps`,
        "--data-urlencode",
        `subscribed_fields=${SUBSCRIBE_FIELDS.join(",")}`,
        "-d",
        `access_token=${conn.token}`,
      ],
      { proxy: useProxy() },
    ),
  );
  if (res?.success === true || res?.id) {
    saveConnection({ ...conn, subscribed: true, subscribedFields: SUBSCRIBE_FIELDS, subscribedAt: nowIso() });
    return { ok: true, fields: SUBSCRIBE_FIELDS };
  }
  if (isTokenError(String(res?.error?.message ?? ""), res?.error?.code)) return { ok: false, reason: `subscribe re-auth needed: ${res?.error?.message ?? "code-190"}` };
  return { ok: false, reason: `subscribe failed: ${res?.error?.message ?? "unknown Graph error"}` };
}

/** Unsubscribe the connected Page from the app's webhook fields. */
export async function unsubscribeWebhooks(channel: string): Promise<{ ok: true } | Fail> {
  const conn = resolveConnection(channel);
  if (!conn) return { ok: false, reason: `no usable connection for ${channel}` };
  if (!conn.pageId) return { ok: false, reason: "connection has no pageId" };

  const res = graphJson(
    httpCurl(
      ["-X", "DELETE", `${GRAPH}/${conn.pageId}/subscribed_apps`, "-d", `access_token=${conn.token}`],
      { proxy: useProxy() },
    ),
  );
  if (res?.success === true) {
    saveConnection({ ...conn, subscribed: false, subscribedFields: [], subscribedAt: undefined });
    return { ok: true };
  }
  if (isTokenError(String(res?.error?.message ?? ""), res?.error?.code)) return { ok: false, reason: `unsubscribe re-auth needed: ${res?.error?.message ?? "code-190"}` };
  return { ok: false, reason: `unsubscribe failed: ${res?.error?.message ?? "unknown Graph error"}` };
}
