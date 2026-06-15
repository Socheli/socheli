import { z } from "zod";
import { TenantFields } from "./tenancy.ts";

/* ════════════════════════════════════════════════════════════════════════
   CONNECTIONS — per-brand Meta (Instagram/Facebook) connection wire shapes.

   Each brand connects its OWN Instagram/Facebook account via Meta. Two auth
   flavors, discriminated by `authType`/`api`:
     - facebook_login (api "facebook") — Page token via graph.facebook.com/v21.0
       (the original SaaS path; requires a backing Facebook Page).
     - instagram_login (api "instagram") — IG-user token via graph.instagram.com/v25.0
       (Instagram Business/Creator, NO Facebook Page).
   Both replace the single global IG_USER_ID / IG_ACCESS_TOKEN. The stored token
   is what comments/DM/publish/insights resolve per channel (env fallback for
   back-compat). Tokens live in gitignored data/connections/<channel>.json and
   NEVER cross the wire — only the redacted ConnectionView does.

   Mirrors memory.ts: tiny, .strict(), const + z.infer pair, TenantFields where
   owned. The credential RESOLVER (channel → {igUserId, token}) lives engine-side;
   these zod schemas are the data that persists / crosses the wire.
   ════════════════════════════════════════════════════════════════════════ */

/* Lifecycle of a stored connection. "connected" = usable; "expired" = token past
   expiry (refreshable); "revoked" = user/Meta pulled access (resolver returns null);
   "error" = last live call failed (lastError holds why). */
export const ConnectionStatus = z.enum(["connected", "expired", "revoked", "error"]);
export type ConnectionStatus = z.infer<typeof ConnectionStatus>;

/* The Meta/IG Graph scopes this connection was granted. Surfaced (token-free) so
   connection_status can warn when a capability scope is missing (e.g. DM send needs
   instagram_manage_messages). */
export const ConnectionScope = z.enum([
  // Facebook-Login (Page) scopes — UNCHANGED
  "instagram_basic",
  "instagram_content_publish",
  "instagram_manage_comments",
  "instagram_manage_messages",
  "instagram_manage_insights",
  "pages_show_list",
  "pages_read_engagement",
  "business_management",
  // Instagram-Login (no Page) scopes — VERIFIED June 2026 against
  // developers.facebook.com/docs/instagram-platform (old instagram_* deprecated 2025-01-27)
  "instagram_business_basic",
  "instagram_business_content_publish",
  "instagram_business_manage_comments",
  "instagram_business_manage_messages",
  "instagram_business_manage_insights",
]);
export type ConnectionScope = z.infer<typeof ConnectionScope>;

/* The FULL stored connection — persisted to the gitignored data/connections/<channel>.json.
   `token` is the brand's PAGE access token used by comments/DM/publish/insights.
   THIS SHAPE IS NEVER RETURNED BY A TOOL OR CROSSES THE WIRE — only ConnectionView does. */
export const Connection = z
  .object({
    ...TenantFields,
    channelId: z.string().describe("brand/channel id this connection belongs to"),
    provider: z.literal("meta"),
    // Auth flavor discriminator. "facebook_login" = Page token via graph.facebook.com
    // (the original SaaS path). "instagram_login" = IG-user token via graph.instagram.com
    // (Instagram Business/Creator, NO Facebook Page). Defaults preserve every
    // already-stored connection as facebook_login on re-parse (.strict()).
    authType: z.enum(["facebook_login", "instagram_login"]).default("facebook_login"),
    api: z.enum(["facebook", "instagram"]).default("facebook"),
    igAppId: z.string().optional().describe("BYO/env Instagram App ID that issued an instagram_login token (non-secret, audit/refresh)"),
    igUserId: z.string().describe("Instagram business account id (graph user id)"),
    username: z.string().optional().describe("@handle of the connected IG account"),
    pageId: z.string().optional().describe("Facebook Page id backing the IG account"),
    pageName: z.string().optional(),
    token: z.string().describe("PAGE access token — never returned by a tool, never logged"),
    scopes: z.array(ConnectionScope).default([]),
    status: ConnectionStatus.default("connected"),
    expiresAt: z.string().optional().describe("ISO expiry of the long-lived token"),
    connectedAt: z.string().describe("ISO timestamp of first connect"),
    updatedAt: z.string().optional(),
    subscribed: z.boolean().default(false).describe("webhook subscribed_apps active"),
    subscribedFields: z.array(z.string()).default([]),
    subscribedAt: z.string().optional(),
    lastError: z.string().optional(),
  })
  .strict();
export type Connection = z.infer<typeof Connection>;

/* The REDACTED view — the ONLY connection shape a tool result or API response may
   contain. token is omitted; tokenPreview is the last-4 only; expiry is summarized. */
export const ConnectionView = Connection.omit({ token: true })
  .extend({
    tokenPreview: z.string().optional().describe("last 4 chars of the token, e.g. '…aB3x'"),
    expiresInDays: z.number().optional(),
    needsRefresh: z.boolean().optional().describe("true when token expires in <7 days"),
  })
  .strict();
export type ConnectionView = z.infer<typeof ConnectionView>;
