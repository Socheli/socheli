/**
 * ig-connection-tools.ts — registry tools for the Instagram API with Instagram
 * Login flow: a brand connects ONLY its Instagram Business/Creator account (NO
 * Facebook Page) via Meta's "Business Login for Instagram". This is the sibling
 * of connection-tools.ts (the Facebook-Login / Page flow); both write the SAME
 * gitignored data/connections/<channel>.json store via the engine, and both
 * resolve through resolveIgCreds — the connection's `authType` discriminator
 * tells every Graph caller which host to use (graph.facebook.com vs
 * graph.instagram.com).
 *
 *   connect_ig_start      (read)    build the Instagram Login authorize URL + state
 *   connect_ig_callback   (long)    *** GATED-style *** exchange the IG code → connection
 *   connection_ig_refresh (long)    re-exchange the long-lived IG token (60-day window)
 *   ig_app_set            (mutate)  Bring-Your-Own Instagram app (id + secret) per workspace
 *   ig_app_status         (read)    which Instagram app this workspace uses (NEVER the secret)
 *   ig_app_clear          (mutate)  drop the workspace's own Instagram app override
 *
 * THE GATE: connect_ig_callback / connection_ig_refresh / ig_app_set /
 * ig_app_clear are human-only — connecting/refreshing/configuring a live account
 * is a human action (like comment_send/dm_send). The community_manager role uses
 * an ALLOWLIST (harness/roles.ts) that contains only connections_list +
 * connection_status, so these mutating tools are gated OUT by omission — no
 * denylist edit is needed. EVERY result is the redacted ConnectionView; the
 * token NEVER appears in any ToolResult, and the Instagram App Secret is never
 * returned or logged.
 *
 * Imports come from the leaf ./helpers.ts (no registry cycle). The OAuth/refresh
 * logic lives in ../ig-login.ts; the BYO Instagram app store in ../ig-app.ts.
 */

import { z } from "zod";

import { asyncResult, fail, ok, tool, type PipelineTool } from "./helpers.ts";
import { instagramAuthorizeUrl, exchangeIgCode, refreshInstagramToken } from "../ig-login.ts";
import { setIgApp, clearIgApp, igAppStatus } from "../ig-app.ts";

const DEFAULT_WS = "ws_default";

const channelArg = z.string().min(1).describe("brand/channel id this connection belongs to");

export const igConnectionTools: PipelineTool[] = [
  tool({
    name: "connect_ig_start",
    description:
      "Begin connecting a brand's Instagram Business/Creator account via Instagram Login (NO Facebook Page). Returns the authorize URL to open (www.instagram.com/oauth/authorize) and an opaque `state` to pass back to connect_ig_callback. Uses the workspace's own Instagram app if set (ig_app_set), else the instance's INSTAGRAM_APP_ID. The redirect lands on /api/connections/ig-callback.",
    kind: "read",
    schema: z.object({ channel: channelArg, workspaceId: z.string().min(1).optional() }).strict(),
    run: ({ channel, workspaceId }) => {
      const { url, state } = instagramAuthorizeUrl(channel, workspaceId);
      return ok({ channel, url, state }, "open the URL to authorize, then call connect_ig_callback with the returned code + state");
    },
  }),

  tool({
    name: "connect_ig_callback",
    description:
      "Complete the Instagram Login handshake: exchange the authorization `code` for a long-lived Instagram User token (60 days), read the IG account (user_id + username), and store the connection (authType=instagram_login, api=instagram). Returns the redacted connection (no token). Verifies the `state` from connect_ig_start. There is NO Facebook Page in this flow.",
    kind: "long",
    schema: z
      .object({
        channel: channelArg,
        code: z.string().min(1).describe("the OAuth `code` query param returned to the redirect URI"),
        state: z.string().min(1).describe("the `state` from connect_ig_start (CSRF guard)"),
        workspaceId: z.string().min(1).optional(),
      })
      .strict(),
    run: ({ channel, code, state, workspaceId }) =>
      asyncResult(
        exchangeIgCode(channel, code, state, workspaceId).then((res) =>
          res.ok ? ok({ channel, connection: res.view }, `connected @${res.view.username ?? channel}`) : fail(res.reason),
        ),
      ),
  }),

  tool({
    name: "connection_ig_refresh",
    description:
      "Re-exchange a brand's long-lived Instagram User token to extend its 60-day expiry (ig_refresh_token; token must be ≥24h old). Returns the redacted connection with the updated expiry. If Meta rejects (token revoked), the connection is marked expired and a re-connect is needed. Only valid for instagram_login connections.",
    kind: "long",
    schema: z.object({ channel: channelArg, workspaceId: z.string().min(1).optional() }).strict(),
    run: ({ channel, workspaceId }) =>
      asyncResult(refreshInstagramToken(channel, workspaceId).then((res) => (res.ok ? ok({ channel, connection: res.view }, "token refreshed") : fail(res.reason)))),
  }),

  // ── Bring-Your-Own Instagram app (per-workspace override of the instance's app) ─
  tool({
    name: "ig_app_set",
    description:
      "Use YOUR OWN Instagram app for this workspace's Instagram-Login connections (overrides the instance's default INSTAGRAM_APP_ID). Provide the Instagram App ID + Instagram App Secret from App Dashboard → Instagram → API setup with Instagram login (DISTINCT from the Meta/Facebook app id/secret). The OAuth redirect stays this instance's /api/connections/ig-callback (whitelist it in your app's Instagram OAuth redirect list). The secret is stored gitignored and never returned.",
    kind: "mutate",
    schema: z.object({ appId: z.string().min(1).describe("your Instagram App ID"), appSecret: z.string().min(1).describe("your Instagram App Secret"), workspaceId: z.string().min(1).optional() }).strict(),
    run: ({ appId, appSecret, workspaceId }) => {
      const ws = workspaceId || DEFAULT_WS;
      setIgApp(ws, appId, appSecret);
      return ok({ workspaceId: ws, ...igAppStatus(ws) }, "workspace Instagram app set");
    },
  }),

  tool({
    name: "ig_app_status",
    description: "Show which Instagram app this workspace's Instagram-Login connections use — source (workspace override | instance env | none), the Instagram App ID (public), and whether the OAuth redirect is configured. NEVER returns the app secret.",
    kind: "read",
    schema: z.object({ workspaceId: z.string().min(1).optional() }).strict(),
    run: ({ workspaceId }) => ok({ workspaceId: workspaceId || DEFAULT_WS, ...igAppStatus(workspaceId || DEFAULT_WS) }),
  }),

  tool({
    name: "ig_app_clear",
    description: "Remove this workspace's own Instagram app override → its Instagram-Login connections fall back to the instance's default app (INSTAGRAM_APP_ID).",
    kind: "mutate",
    schema: z.object({ workspaceId: z.string().min(1).optional() }).strict(),
    run: ({ workspaceId }) => {
      const ws = workspaceId || DEFAULT_WS;
      const removed = clearIgApp(ws);
      return ok({ workspaceId: ws, removed, ...igAppStatus(ws) }, removed ? "workspace Instagram app cleared" : "no workspace Instagram app was set");
    },
  }),
];
