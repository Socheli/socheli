/**
 * connection-tools.ts — registry tools for per-brand Meta (Instagram/Facebook)
 * connections. Each brand connects its OWN account via Meta (Facebook Login),
 * replacing the single global IG_USER_ID / IG_ACCESS_TOKEN. The stored PAGE token
 * is what comments/DM/publish/insights resolve per channel (env fallback for
 * back-compat).
 *
 *   connect_start         (read)    build the Facebook Login authorize URL + state
 *   connect_callback      (long)    *** GATED-style *** exchange OAuth code → connection
 *   connect_paste         (mutate)  manual long-lived PAGE token fallback
 *   connections_list      (read)    list connected brand accounts (redacted)
 *   connection_status     (read)    one brand's connection (expiry/refresh warnings)
 *   connection_refresh    (long)    re-exchange the long-lived token to extend expiry
 *   connection_disconnect (mutate)  unsubscribe (best-effort) + delete the connection
 *   connection_subscribe  (long)    (re)subscribe the Page to comments/messages webhooks
 *
 * THE GATE: connect_callback / connection_refresh / connection_subscribe /
 * connect_paste / connection_disconnect are withheld from the autonomous
 * community_manager role (see harness/roles.ts) — connecting/refreshing an
 * account is a human action, like comment_send/dm_send. EVERY result is the
 * redacted ConnectionView; the token NEVER appears in any ToolResult.
 *
 * Imports come from the leaf ./helpers.ts (no registry cycle).
 */

import { z } from "zod";

import { asyncResult, fail, ok, tool, type PipelineTool } from "./helpers.ts";
import {
  authorizeUrl,
  connectionStatusFor,
  deleteConnection,
  exchangeCode,
  listConnections,
  refreshConnection,
  savePastedToken,
  subscribeWebhooks,
  unsubscribeWebhooks,
} from "../connections.ts";
import { setMetaApp, clearMetaApp, metaAppStatus } from "../meta-app.ts";

const DEFAULT_WS = "ws_default";

const channelArg = z.string().min(1).describe("brand/channel id this connection belongs to");

export const connectionTools: PipelineTool[] = [
  tool({
    name: "connect_start",
    description:
      "Begin connecting a brand's Instagram/Facebook account via Meta (Facebook Login). Returns the authorize URL to open and an opaque `state` to pass back to connect_callback. Uses the workspace's own Meta app if set (meta_app_set), else the instance's META_APP_ID.",
    kind: "read",
    schema: z.object({ channel: channelArg, workspaceId: z.string().min(1).optional() }).strict(),
    run: ({ channel, workspaceId }) => {
      const { url, state } = authorizeUrl(channel, workspaceId);
      return ok({ channel, url, state }, "open the URL to authorize, then call connect_callback with the returned code + state");
    },
  }),

  tool({
    name: "connect_callback",
    description:
      "Complete the Meta OAuth handshake: exchange the authorization `code` for a long-lived PAGE token, discover the Instagram business account, store the connection, and subscribe webhooks. Returns the redacted connection (no token). Verifies the `state` from connect_start.",
    kind: "long",
    schema: z
      .object({
        channel: channelArg,
        code: z.string().min(1).describe("the OAuth `code` query param returned to the redirect URI"),
        state: z.string().min(1).describe("the `state` from connect_start (CSRF guard)"),
        workspaceId: z.string().min(1).optional(),
      })
      .strict(),
    run: ({ channel, code, state, workspaceId }) =>
      asyncResult(
        exchangeCode(channel, code, state, workspaceId).then((res) =>
          res.ok ? ok({ channel, connection: res.view }, `connected @${res.view.username ?? channel}`) : fail(res.reason),
        ),
      ),
  }),

  tool({
    name: "connect_paste",
    description:
      "Manual fallback: store a long-lived Instagram PAGE access token for a brand (when you already minted one in the Meta dashboard). Persists the connection and best-effort subscribes webhooks. Returns the redacted connection — the token is never echoed back.",
    kind: "mutate",
    schema: z
      .object({
        channel: channelArg,
        igUserId: z.string().min(1).describe("the Instagram business account id (graph user id)"),
        token: z.string().min(1).describe("the long-lived PAGE access token"),
        pageId: z.string().min(1).optional().describe("the Facebook Page id backing the IG account (enables webhooks)"),
        username: z.string().min(1).optional().describe("the @handle of the connected account"),
      })
      .strict(),
    run: ({ channel, igUserId, token, pageId, username }) => {
      const res = savePastedToken(channel, igUserId, token, { pageId, username });
      return res.ok ? ok({ channel, connection: res.view }, "token stored") : fail(res.reason);
    },
  }),

  tool({
    name: "connections_list",
    description: "List the brand accounts connected via Meta (redacted — token shown only as a last-4 preview). Scoped to the caller's workspace when a tenant context is present.",
    kind: "read",
    schema: z.object({ workspaceId: z.string().min(1).optional().describe("filter to a workspace (defaults to all)") }).strict(),
    run: ({ workspaceId }) => {
      const connections = listConnections(workspaceId);
      return ok({ count: connections.length, connections });
    },
  }),

  tool({
    name: "connection_status",
    description: "Show one brand's Meta connection — status, scopes, expiry (expiresInDays/needsRefresh), webhook subscription — fully redacted (no token). Returns null when the brand isn't connected.",
    kind: "read",
    schema: z.object({ channel: channelArg }).strict(),
    run: ({ channel }) => {
      const view = connectionStatusFor(channel);
      return ok({ channel, connection: view });
    },
  }),

  tool({
    name: "connection_refresh",
    description: "Re-exchange a brand's stored long-lived token to extend its expiry. Returns the redacted connection with the updated expiry. If Meta rejects (token revoked), the connection is marked expired and a re-connect is needed.",
    kind: "long",
    schema: z.object({ channel: channelArg, workspaceId: z.string().min(1).optional() }).strict(),
    run: ({ channel, workspaceId }) =>
      asyncResult(refreshConnection(channel, workspaceId).then((res) => (res.ok ? ok({ channel, connection: res.view }, "token refreshed") : fail(res.reason)))),
  }),

  tool({
    name: "connection_disconnect",
    description: "Disconnect a brand account: best-effort unsubscribe its Page webhooks, then delete the stored connection (and its token) from disk. Live calls for this brand fall back to the global env account (if any) afterward.",
    kind: "mutate",
    schema: z.object({ channel: channelArg }).strict(),
    run: ({ channel }) =>
      asyncResult(
        unsubscribeWebhooks(channel)
          .catch(() => undefined)
          .then(() => {
            const removed = deleteConnection(channel);
            return removed ? ok({ channel, removed: true }, "connection removed") : fail(`no connection stored for ${channel}`);
          }),
      ),
  }),

  tool({
    name: "connection_subscribe",
    description: "(Re)subscribe a connected brand's Facebook Page to the app's comment + message webhooks so inbound items route to its inbox automatically. Returns the subscribed fields.",
    kind: "long",
    schema: z.object({ channel: channelArg }).strict(),
    run: ({ channel }) =>
      asyncResult(
        subscribeWebhooks(channel).then((res) => {
          if (!res.ok) return fail(res.reason);
          return ok({ channel, connection: connectionStatusFor(channel), fields: res.fields }, "webhooks subscribed");
        }),
      ),
  }),

  // ── Bring-Your-Own Meta app (per-workspace override of the instance's app) ───
  tool({
    name: "meta_app_set",
    description:
      "Use YOUR OWN Meta app for this workspace's connections (overrides the instance's default app). Provide your Meta App ID + App Secret; the OAuth redirect stays the instance's callback (whitelist it in your app's Valid OAuth Redirect URIs). The secret is stored gitignored and never returned.",
    kind: "mutate",
    schema: z.object({ appId: z.string().min(1).describe("your Meta App ID"), appSecret: z.string().min(1).describe("your Meta App Secret"), workspaceId: z.string().min(1).optional() }).strict(),
    run: ({ appId, appSecret, workspaceId }) => {
      const ws = workspaceId || DEFAULT_WS;
      setMetaApp(ws, appId, appSecret);
      return ok({ workspaceId: ws, ...metaAppStatus(ws) }, "workspace Meta app set");
    },
  }),

  tool({
    name: "meta_app_status",
    description: "Show which Meta app this workspace's connections use — source (workspace override | instance env | none), the App ID (public), and whether the OAuth redirect is configured. NEVER returns the app secret.",
    kind: "read",
    schema: z.object({ workspaceId: z.string().min(1).optional() }).strict(),
    run: ({ workspaceId }) => ok({ workspaceId: workspaceId || DEFAULT_WS, ...metaAppStatus(workspaceId || DEFAULT_WS) }),
  }),

  tool({
    name: "meta_app_clear",
    description: "Remove this workspace's own Meta app override → its connections fall back to the instance's default app (META_APP_ID).",
    kind: "mutate",
    schema: z.object({ workspaceId: z.string().min(1).optional() }).strict(),
    run: ({ workspaceId }) => {
      const ws = workspaceId || DEFAULT_WS;
      const removed = clearMetaApp(ws);
      return ok({ workspaceId: ws, removed, ...metaAppStatus(ws) }, removed ? "workspace Meta app cleared" : "no workspace Meta app was set");
    },
  }),
];
