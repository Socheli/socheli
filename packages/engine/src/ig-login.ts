import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import { Connection, ConnectionScope, type ConnectionView } from "@os/schemas";

import { nowIso } from "./store.ts";
import { httpCurl } from "./http.ts";
import { isTokenError } from "./publish-types.ts";
import { resolveInstagramApp } from "./ig-app.ts";
import { saveConnection, loadConnection, resolveConnection, toView } from "./connections.ts";

/* ig-login.ts — the "Instagram API with Instagram Login" OAuth subsystem: connect
   an Instagram Business/Creator account with NO backing Facebook Page. PARALLEL to
   connections.ts's Facebook-Login (Page) flow — it writes into the SAME connection
   store (data/connections/<channel>.json) via saveConnection, tagging records with
   authType:"instagram_login" / api:"instagram" so the shared resolveIgCreds() and
   the Graph callers (dms/comments/insights) route to graph.instagram.com instead
   of graph.facebook.com. The Facebook-Login flow is left BYTE-FOR-BYTE untouched.

   Endpoints + scopes VERIFIED June 2026 against
   developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login
   (Business Login for Instagram):
     - authorize:   GET  https://www.instagram.com/oauth/authorize  (no version segment)
     - code→short:  POST https://api.instagram.com/oauth/access_token (form body) → {access_token, user_id, permissions}
     - short→long:  GET  https://graph.instagram.com/access_token?grant_type=ig_exchange_token&client_secret&access_token → {access_token, expires_in}
     - refresh:     GET  https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token → {access_token, expires_in}
     - account:     GET  https://graph.instagram.com/v25.0/me?fields=user_id,username
   The long-lived token lives ~60 days; we auto-refresh near expiry.

   Live Graph calls follow the connections.ts idioms exactly: token-gated, NEVER
   throw (return {ok:false,reason}), NEVER console.log the token, map code-190 /
   OAuthException via isTokenError. Tools return only the redacted ConnectionView.
   There is NO /me/accounts step (no Page) and we do NOT subscribeWebhooks (IG-Login
   webhook subscription is app-dashboard / instagram-object level, out of scope). */

const IG_GRAPH = "https://graph.instagram.com/v25.0";
const IG_TOKEN_HOST = "https://api.instagram.com";
/* The token-exchange + refresh endpoints live on graph.instagram.com WITHOUT a
   version segment (per docs); strip the version off IG_GRAPH so there's one source. */
const IG_GRAPH_ROOT = IG_GRAPH.replace(/\/v\d+(?:\.\d+)?$/, "");

const useProxy = () => process.env.IG_USE_PROXY === "1";

/* The IG-Login OAuth scopes we request. instagram_business_content_publish /
   _manage_insights are included so publish + insights work on the same token. */
const IG_OAUTH_SCOPES: string[] = [
  "instagram_business_basic",
  "instagram_business_manage_messages",
  "instagram_business_manage_comments",
  "instagram_business_content_publish",
  "instagram_business_manage_insights",
];

// ───────────────────────────────────────────────────────────────────────────
// Result shapes — identical to connections.ts (re-declared so surfaces can bind).
// ───────────────────────────────────────────────────────────────────────────
export type Fail = { ok: false; reason: string };
export type OkView = { ok: true; view: ConnectionView };

function graphJson(r: { stdout: string }): any {
  try {
    return JSON.parse(r.stdout);
  } catch {
    return { error: { message: (r.stdout || "").slice(0, 200) } };
  }
}

function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** HMAC(channel|nonce, <workspace or env *Instagram* app secret>) → base64url,
    nonce-prefixed so the callback can recompute it. Format: <nonce>.<hmac>.
    NOTE: keyed on the IG app secret (resolveInstagramApp), NOT the Meta secret. */
function signState(channel: string, nonce: string, workspaceId?: string): string {
  const mac = createHmac("sha256", resolveInstagramApp(workspaceId).appSecret).update(`${channel}|${nonce}`).digest();
  return `${nonce}.${base64url(mac)}`;
}

/** Recompute the HMAC from the embedded nonce and constant-time compare. */
function verifyState(channel: string, state: string, workspaceId?: string): boolean {
  if (!state || !resolveInstagramApp(workspaceId).appSecret) return false;
  const dot = state.indexOf(".");
  if (dot <= 0) return false;
  const nonce = state.slice(0, dot);
  const expected = signState(channel, nonce, workspaceId);
  const a = Buffer.from(state);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** ISO expiry from a Graph `expires_in` (seconds), if present. */
function expiryFrom(expiresIn?: unknown): string | undefined {
  const secs = typeof expiresIn === "number" ? expiresIn : Number(expiresIn);
  if (!Number.isFinite(secs) || secs <= 0) return undefined;
  return new Date(Date.now() + secs * 1000).toISOString();
}

/** A long-lived IG token lives ~60 days; default expiry when Graph omits expires_in. */
function defaultExpiry(): string {
  return new Date(Date.now() + 60 * 86_400_000).toISOString();
}

/** Filter the requested IG scopes down to the schema-valid set so only strings the
    Connection schema accepts persist (the IG-Login strings are now in the enum). */
function knownIgScopes(): ConnectionScope[] {
  return ConnectionScope.options.filter((s) => IG_OAUTH_SCOPES.includes(s)) as ConnectionScope[];
}

// ───────────────────────────────────────────────────────────────────────────
// OAuth — Instagram Login flow (authorize → exchange → long-lived → /me)
// ───────────────────────────────────────────────────────────────────────────

/** Build the Instagram-Login authorize URL + an opaque state to verify on callback.
    Host: www.instagram.com/oauth/authorize (no version). enable_fb_login=0 hides the
    Facebook Login option so the user connects with ONLY their Instagram account. */
export function instagramAuthorizeUrl(channel: string, workspaceId?: string): { url: string; state: string } {
  const app = resolveInstagramApp(workspaceId);
  const nonce = base64url(randomBytes(12));
  // Embed the channel in the state (`<channel>:<nonce>.<hmac>`) so the dashboard
  // callback — which only receives ?state= on a fixed redirect URI — can recover
  // which brand is connecting. exchangeIgCode strips the prefix before verifying.
  const state = `${channel}:${signState(channel, nonce, workspaceId)}`;
  const params = new URLSearchParams({
    client_id: app.appId,
    redirect_uri: app.redirect,
    response_type: "code",
    scope: IG_OAUTH_SCOPES.join(","),
    state,
    enable_fb_login: "0",
  });
  return { url: `https://www.instagram.com/oauth/authorize?${params.toString()}`, state };
}

/** Exchange an OAuth code for a long-lived Instagram-User token, read the IG account
    id/username, and persist the connection. NO /me/accounts, NO pageId, NO webhook
    subscribe. Token-gated, never throws, code-190 → Fail, never logs the token. */
export async function exchangeIgCode(channel: string, code: string, state: string, workspaceId?: string): Promise<OkView | Fail> {
  const app = resolveInstagramApp(workspaceId);
  if (!app.appId || !app.appSecret || !app.redirect) {
    return { ok: false, reason: "No Instagram app configured. Set INSTAGRAM_APP_ID + INSTAGRAM_APP_SECRET + INSTAGRAM_OAUTH_REDIRECT (or META_OAUTH_REDIRECT), or set a workspace app with ig_app_set." };
  }
  // State is `<channel>:<nonce>.<hmac>` — strip the channel prefix before verifying
  // the signed `<nonce>.<hmac>` part (channel ids never contain ':').
  const signed = state.includes(":") ? state.slice(state.indexOf(":") + 1) : state;
  if (!verifyState(channel, signed, workspaceId)) return { ok: false, reason: "state mismatch — possible CSRF or stale link; restart the connect flow" };

  // 1) code → short-lived IG-user token (POST form body; returns user_id directly)
  const shortRes = graphJson(
    httpCurl(
      [
        "-X",
        "POST",
        `${IG_TOKEN_HOST}/oauth/access_token`,
        "-d",
        `client_id=${encodeURIComponent(app.appId)}`,
        "-d",
        `client_secret=${encodeURIComponent(app.appSecret)}`,
        "-d",
        "grant_type=authorization_code",
        "--data-urlencode",
        `redirect_uri=${app.redirect}`,
        "-d",
        `code=${encodeURIComponent(code)}`,
      ],
      { proxy: useProxy() },
    ),
  );
  if (shortRes?.error || shortRes?.error_message) {
    const msg = String(shortRes.error?.message ?? shortRes.error_message ?? shortRes.error ?? "unknown");
    if (isTokenError(msg, shortRes.error?.code ?? shortRes.code)) return { ok: false, reason: `OAuth code rejected: ${msg}` };
    return { ok: false, reason: `code exchange failed: ${msg}` };
  }
  const shortToken = String(shortRes?.access_token ?? "");
  const userIdFromCode = shortRes?.user_id != null ? String(shortRes.user_id) : "";
  if (!shortToken) return { ok: false, reason: "code exchange returned no access_token" };

  // 2) short-lived → long-lived IG-user token (~60 days)
  const longRes = graphJson(
    httpCurl(
      [
        `${IG_GRAPH_ROOT}/access_token?grant_type=ig_exchange_token&client_secret=${encodeURIComponent(app.appSecret)}&access_token=${encodeURIComponent(shortToken)}`,
      ],
      { proxy: useProxy() },
    ),
  );
  if (longRes?.error) {
    const msg = String(longRes.error?.message ?? "unknown");
    if (isTokenError(msg, longRes.error?.code)) return { ok: false, reason: `long-lived exchange rejected: ${msg}` };
    return { ok: false, reason: `long-lived exchange failed: ${msg}` };
  }
  const longToken = String(longRes?.access_token ?? "");
  if (!longToken) return { ok: false, reason: "long-lived exchange returned no access_token" };
  const expiresAt = expiryFrom(longRes?.expires_in) ?? defaultExpiry();

  // 3) /me → confirm account id + username (user_id field for IG-Login)
  const me = graphJson(
    httpCurl(
      [`${IG_GRAPH}/me?fields=user_id,username&access_token=${encodeURIComponent(longToken)}`],
      { proxy: useProxy() },
    ),
  );
  let igUserId = userIdFromCode;
  let username: string | undefined;
  if (me?.error) {
    const msg = String(me.error?.message ?? "unknown");
    if (isTokenError(msg, me.error?.code)) return { ok: false, reason: `account lookup rejected: ${msg}` };
    // Non-token error but we already have user_id from the code exchange — proceed if so.
    if (!igUserId) return { ok: false, reason: `account lookup failed: ${msg}` };
  } else {
    if (me?.user_id != null) igUserId = String(me.user_id);
    if (me?.username) username = String(me.username);
  }
  if (!igUserId) return { ok: false, reason: "could not determine the Instagram account id from the token" };

  const conn: Connection = {
    channelId: channel,
    provider: "meta",
    authType: "instagram_login",
    api: "instagram",
    igAppId: app.appId || undefined,
    igUserId,
    username,
    token: longToken,
    scopes: knownIgScopes(),
    status: "connected",
    expiresAt,
    connectedAt: nowIso(),
    subscribed: false,
    subscribedFields: [],
  };
  saveConnection(conn);
  const saved = loadConnection(channel) ?? conn;
  return { ok: true, view: toView(saved) };
}

/** Refresh the stored long-lived IG token (ig_refresh_token) to extend expiry.
    Token must be ≥24h old and <60 days; if connected <24h ago we skip (no-op ok).
    Branches on authType — refuses a facebook_login connection. */
export async function refreshInstagramToken(channel: string, workspaceId?: string): Promise<OkView | Fail> {
  void workspaceId; // refresh uses the long-lived token only — no app id/secret needed.
  const conn = loadConnection(channel);
  if (!conn) return { ok: false, reason: `no connection stored for ${channel}` };
  if (conn.authType !== "instagram_login") return { ok: false, reason: "not an Instagram-Login connection — use connection_refresh for Facebook-Login tokens" };

  // Instagram refuses ig_refresh_token on tokens younger than 24h — skip gracefully.
  const ageMs = Date.now() - new Date(conn.connectedAt).getTime();
  if (Number.isFinite(ageMs) && ageMs < 24 * 3_600_000) {
    return { ok: true, view: toView(conn) };
  }

  const res = graphJson(
    httpCurl(
      [`${IG_GRAPH_ROOT}/refresh_access_token?grant_type=ig_refresh_token&access_token=${encodeURIComponent(conn.token)}`],
      { proxy: useProxy() },
    ),
  );
  if (res?.error) {
    const msg = String(res.error?.message ?? "unknown");
    if (isTokenError(msg, res.error?.code)) {
      saveConnection({ ...conn, status: "expired", lastError: msg });
      return { ok: false, reason: `refresh rejected (re-connect needed): ${msg}` };
    }
    return { ok: false, reason: `refresh failed: ${msg}` };
  }
  const token = String(res?.access_token ?? "");
  if (!token) return { ok: false, reason: "refresh returned no access_token" };
  const saved = saveConnection({
    ...conn,
    token,
    expiresAt: expiryFrom(res?.expires_in) ?? defaultExpiry(),
    status: "connected",
    lastError: undefined,
  });
  return { ok: true, view: toView(saved) };
}

/** Refresh an Instagram-Login token IF it's near expiry. Returns whether a refresh
    actually ran. No-ops (returns false) for facebook_login, missing, expired-status,
    or not-yet-near-expiry connections. Never throws. */
export async function maybeRefreshInstagram(channel: string, workspaceId?: string): Promise<boolean> {
  const conn = resolveConnection(channel);
  if (!conn || conn.authType !== "instagram_login" || conn.status === "expired") return false;
  const view = toView(conn);
  if (!view.needsRefresh) return false;
  const res = await refreshInstagramToken(channel, workspaceId);
  return res.ok;
}

/** Manual fallback: persist a pasted long-lived Instagram-User token (no OAuth
    round-trip). Mirrors savePastedToken but tags authType:"instagram_login" /
    api:"instagram", leaves pageId undefined, defaults a 60-day expiry. */
export function saveInstagramPastedToken(
  channel: string,
  igUserId: string,
  token: string,
  opts: { username?: string; expiresAt?: string } = {},
): OkView | Fail {
  if (!igUserId || !token) return { ok: false, reason: "igUserId and token are both required" };
  const conn: Connection = {
    channelId: channel,
    provider: "meta",
    authType: "instagram_login",
    api: "instagram",
    igUserId,
    username: opts.username,
    token,
    scopes: knownIgScopes(),
    status: "connected",
    expiresAt: opts.expiresAt ?? defaultExpiry(),
    connectedAt: nowIso(),
    subscribed: false,
    subscribedFields: [],
  };
  const saved = saveConnection(conn);
  return { ok: true, view: toView(saved) };
}

export { IG_GRAPH, IG_TOKEN_HOST, IG_OAUTH_SCOPES };
/* Short alias used by surfaces prose. */
export { instagramAuthorizeUrl as igAuthorizeUrl };
