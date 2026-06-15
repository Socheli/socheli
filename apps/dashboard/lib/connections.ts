import "server-only";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ConnectionScope } from "@os/schemas";
import { REPO_ROOT } from "./data";

/* The dashboard's READ view of the per-brand Meta connection store
   (data/connections/<channel>.json — the gitignored file the engine's
   connections.ts owns). Reads happen here directly (the lib/inbox.ts /
   lib/missions.ts pattern); every MUTATION (connect / verify / refresh /
   disconnect / subscribe) goes through the engine via the canonical tool
   runner so the OAuth + token logic is never re-implemented and a token is
   never re-read here.

   SECURITY: this lib NEVER reads, returns, or logs the `token` field. The only
   connection shape it emits is the redacted ConnectionStatus view below — the
   stored file carries a `token` we deliberately drop on read. */

const sani = (c: string) => (c || "global").replace(/[^a-zA-Z0-9_-]/g, "-");
const connFile = (ch: string) => join(REPO_ROOT, "data", "connections", `${sani(ch)}.json`);

function readJson<T>(path: string, fallback: T): T {
  try {
    return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as T) : fallback;
  } catch {
    return fallback;
  }
}

/* The shape the stored connection MIGHT carry (a superset of what we surface).
   We read it only to project the token-free status view; `token` is read off
   the disk shape but NEVER copied into the output. */
type StoredConnection = {
  channelId?: string;
  /* Auth flavor discriminator (engine schema). "facebook_login" = Page token
     via graph.facebook.com (default; also the shape of every pre-existing
     stored file). "instagram_login" = IG-user token via graph.instagram.com
     (NO Facebook Page → no pageId, "Subscribe webhooks" hidden in the panel). */
  authType?: "facebook_login" | "instagram_login";
  igUserId?: string;
  username?: string;
  pageId?: string;
  pageName?: string;
  scopes?: ConnectionScope[];
  status?: "connected" | "expired" | "revoked" | "error";
  expiresAt?: string;
  connectedAt?: string;
  updatedAt?: string;
  subscribed?: boolean;
  subscribedFields?: string[];
  lastError?: string;
};

/* The redacted, token-free connection summary the page + board consume. */
export type ConnectionStatus = {
  channel: string;
  connected: boolean;
  status?: "connected" | "expired" | "revoked" | "error";
  /* Which OAuth flavor this connection uses. Defaults to "facebook_login" for
     every pre-existing (and env-fallback) connection. The panel keys its
     feature-parity guard (hide "Subscribe webhooks" for instagram_login) on it. */
  authType: "facebook_login" | "instagram_login";
  username?: string;
  accountIdMasked?: string;
  scopes: string[];
  webhookSubscribed: boolean;
  tokenExpiresAt?: string;
  needsReauth: boolean;
  lastError?: string;
  /* Mirrored from the responder store so the board can show a single per-brand
     row (filled in by the page from responderFor; defaults here keep callers
     that read connections alone honest). */
  responderEnabled: boolean;
  defaultAction: string;
};

/* Mask an IG account id to its last 4 — we never surface the full graph id in
   a list view (it's not secret, but the redacted habit keeps PII-leak risk low). */
function maskId(id?: string): string | undefined {
  if (!id) return undefined;
  return id.length <= 4 ? id : `…${id.slice(-4)}`;
}

/** Token-free connection status for one brand. Reads the gitignored
    connection file directly; returns a "not connected" shell when absent. */
export function connectionFor(channel: string): ConnectionStatus {
  const stored = readJson<StoredConnection | null>(connFile(channel), null);
  if (!stored || !stored.igUserId) {
    return {
      channel,
      connected: false,
      authType: "facebook_login",
      scopes: [],
      webhookSubscribed: false,
      needsReauth: false,
      responderEnabled: false,
      defaultAction: "auto_send",
    };
  }
  const status = stored.status ?? "connected";
  const needsReauth = status === "expired" || status === "revoked" || status === "error";
  return {
    channel,
    connected: status === "connected",
    status,
    authType: stored.authType ?? "facebook_login",
    username: stored.username,
    accountIdMasked: maskId(stored.igUserId),
    scopes: stored.scopes ?? [],
    webhookSubscribed: !!stored.subscribed,
    tokenExpiresAt: stored.expiresAt,
    needsReauth,
    lastError: stored.lastError,
    responderEnabled: false,
    defaultAction: "auto_send",
  };
}

/* ── Engine bridge for connection mutations + insight reads ──────────────────
   The dashboard must NOT bundle the node-only engine; every mutation/read that
   touches a live token spawns the canonical tool runner, exactly like
   lib/inbox.ts runInboxTool. The token never leaves the engine process. */

export type ToolResult = { ok: boolean; data?: Record<string, unknown>; message?: string };

const CONNECTION_TOOLS = new Set([
  "connect_start",
  "connect_callback",
  "connect_paste",
  "connections_list",
  "connection_status",
  "connection_refresh",
  "connection_disconnect",
  "connection_subscribe",
  // Instagram-Login flow (NO Facebook Page) — siblings of connect_start/_callback/refresh
  "connect_ig_start",
  "connect_ig_callback",
  "connection_ig_refresh",
  // account-level insights ride the same redacted/token-gated engine path
  "insights_pull",
  "insights_get",
  "insights_scorecard",
  // Bring-Your-Own Meta app (workspace-scoped)
  "meta_app_set",
  "meta_app_status",
  "meta_app_clear",
  // Bring-Your-Own Instagram app (Instagram-Login flow; workspace-scoped)
  "ig_app_set",
  "ig_app_status",
  "ig_app_clear",
]);

export function runConnectionTool(name: string, input: Record<string, unknown>): Promise<ToolResult> {
  if (!CONNECTION_TOOLS.has(name)) return Promise.resolve({ ok: false, message: `not a connection tool: ${name}` });
  const runner = join(REPO_ROOT, "packages", "engine", "src", "tool.ts");
  return new Promise((resolve) => {
    const child = spawn("node", ["--import", "tsx", runner, name, JSON.stringify(input)], { cwd: REPO_ROOT, env: process.env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", (e) => resolve({ ok: false, message: String(e) }));
    child.on("close", () => {
      try {
        resolve(JSON.parse(stdout.trim()) as ToolResult);
      } catch {
        resolve({ ok: false, message: (stderr || stdout).trim().slice(0, 2000) || "engine produced no output" });
      }
    });
  });
}

/* ── Account-level insights read (latest snapshot) ──────────────────────────
   Cheap read for the InsightsCard: the latest captured snapshot from the
   gitignored data/insights/<channel>.json. A live pull goes through
   insights_pull via runConnectionTool. */

export type InsightsSummary = {
  channel: string;
  capturedAt?: string;
  followers?: number;
  reach?: number;
  impressions?: number;
  profileViews?: number;
  accountsEngaged?: number;
  totalInteractions?: number;
};

const insightsFile = (ch: string) => join(REPO_ROOT, "data", "insights", `${sani(ch)}.json`);

type StoredSnapshot = {
  capturedAt?: string;
  followers?: number;
  reach?: number;
  impressions?: number;
  profileViews?: number;
  accountsEngaged?: number;
  totalInteractions?: number;
};

/** Latest account-level insight snapshot for a brand, or null when none. The
    store may be a single snapshot or an array of snapshots (newest last). */
export function insightsFor(channel: string): InsightsSummary | null {
  const raw = readJson<StoredSnapshot | StoredSnapshot[] | null>(insightsFile(channel), null);
  if (!raw) return null;
  const snap = Array.isArray(raw) ? raw[raw.length - 1] : raw;
  if (!snap) return null;
  return {
    channel,
    capturedAt: snap.capturedAt,
    followers: snap.followers,
    reach: snap.reach,
    impressions: snap.impressions,
    profileViews: snap.profileViews,
    accountsEngaged: snap.accountsEngaged,
    totalInteractions: snap.totalInteractions,
  };
}
