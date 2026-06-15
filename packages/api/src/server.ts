import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { createHmac, timingSafeEqual } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import mqtt from "mqtt";
import { can, type TenantContext, type Role, ROLES } from "@os/schemas";
import { listItems, getItem, getJobs, getFleet, getSchedule, getDevices, DATA_DIR } from "./store.ts";
import { jobRequirements, pickDevice } from "./match.ts";
import { resolveContext, authConfigured, listKeys, issueKey, revokeKey } from "./auth.ts";
import { toolsManifest, callTool } from "../../engine/src/tools/registry.ts";
import { ingestComment } from "../../engine/src/comments.ts";
import { ingestMessage } from "../../engine/src/dms.ts";
import { runResponder, loadResponderConfig } from "../../engine/src/responder.ts";
import { runCommentTriggers, loadTriggerConfig } from "../../engine/src/comment-triggers.ts";
import { instagramAuthorizeUrl, exchangeIgCode } from "../../engine/src/ig-login.ts";

/* 24/7 auto-reply: when a webhook delivers a new DM for a channel whose responder
   is ENABLED, run the responder over its inbox — fire-and-forget so the webhook
   200s fast, with a per-channel in-flight guard so retries/bursts don't pile up.
   The responder still enforces the kill-switch + 24h window + never-auto guardrail,
   and auto-sends only the rules marked auto_send (everything else drafts/flags). */
const responderInFlight = new Set<string>();
function maybeAutoRespond(channel: string): void {
  if (responderInFlight.has(channel)) return;
  let enabled = false;
  try {
    enabled = loadResponderConfig(channel).enabled === true;
  } catch {
    enabled = false;
  }
  if (!enabled) return;
  responderInFlight.add(channel);
  void runResponder(channel, { scope: "dm" })
    .catch(() => {})
    .finally(() => responderInFlight.delete(channel));
}

/* Comment→DM triggers: when a webhook delivers a new comment for a channel whose
   trigger config is ENABLED, DM matching commenters (private replies). Same
   fire-and-forget + per-channel in-flight guard; honours the kill-switch inside. */
const triggerInFlight = new Set<string>();
function maybeCommentTrigger(channel: string): void {
  if (triggerInFlight.has(channel)) return;
  let enabled = false;
  try {
    enabled = loadTriggerConfig(channel).enabled === true;
  } catch {
    enabled = false;
  }
  if (!enabled) return;
  triggerInFlight.add(channel);
  void runCommentTriggers(channel, {})
    .catch(() => {})
    .finally(() => triggerInFlight.delete(channel));
}
import { channelForIgAccount } from "../../engine/src/connections.ts";

/* Socheli API — the control-plane backbone. The SDK, CLI, MCP server, and any
   third-party integration talk to this. Auth resolves a Bearer key to a tenant
   context (workspace + role) via data/api-keys.json (the legacy static
   SOCHELI_API_KEY still works as a system/owner key); every read is scoped to
   the caller's workspace and every mutation is gated on the caller's role. */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const PORT = Number(process.env.SOCHELI_API_PORT || 8787);
const VERSION = "0.1.0";
const startedAt = Date.now();

// Hono Variables: the resolved tenant context, set by the auth middleware.
type Env = { Variables: { ctx: TenantContext } };
const app = new Hono<Env>();
app.use("*", cors());

// ── auth: resolve a Bearer key → TenantContext, scoped per request ───────────
app.use("/v1/*", async (c, next) => {
  if (c.req.path === "/v1/health") return next();
  if (!authConfigured()) return c.json({ error: "API not configured (no API keys, no SOCHELI_API_KEY)" }, 503);
  const ctx = resolveContext(c.req.header("Authorization"));
  if (!ctx) return c.json({ error: "unauthorized" }, 401);
  c.set("ctx", ctx);
  return next();
});

/* Map a registry tool's `kind` to the permission required to call it. Read tools
   are open to any authenticated role; mutate/long tools require a content/queue
   permission. `long` tools start a render/generation job → queue.dispatch;
   `mutate` tools edit content → content.edit.any (the broad write grant). */
const toolKind = new Map(toolsManifest().map((t) => [t.name, t.kind] as const));
function toolPermitted(ctx: TenantContext, name: string): boolean {
  const kind = toolKind.get(name) ?? (name.startsWith("editor_") ? "mutate" : "read");
  if (kind === "read") return true;
  if (kind === "long") return can(ctx.role, "queue.dispatch");
  return can(ctx.role, "content.edit.any"); // mutate
}

// ── reads ────────────────────────────────────────────────────────────────────
app.get("/v1/health", (c) => c.json({ ok: true, version: VERSION, uptime: Math.round((Date.now() - startedAt) / 1000) }));

app.get("/v1/items", (c) => {
  const ctx = c.get("ctx");
  const limit = c.req.query("limit") ? Number(c.req.query("limit")) : undefined;
  const channel = c.req.query("channel") || undefined;
  return c.json(listItems({ limit, channel, workspaceId: ctx.workspaceId }));
});

app.get("/v1/items/:id", (c) => {
  const ctx = c.get("ctx");
  const it = getItem(c.req.param("id"), ctx.workspaceId);
  return it ? c.json(it) : c.json({ error: "not found" }, 404);
});

app.get("/v1/jobs", (c) => c.json(getJobs(c.get("ctx").workspaceId).slice(0, 30)));
app.get("/v1/fleet", (c) => c.json(getFleet(c.get("ctx").workspaceId)));
app.get("/v1/schedule", (c) => c.json(getSchedule(c.get("ctx").workspaceId)));

// ── identity ─────────────────────────────────────────────────────────────────
app.get("/v1/me", (c) => {
  const ctx = c.get("ctx");
  return c.json({ workspaceId: ctx.workspaceId, role: ctx.role, userId: ctx.userId, via: ctx.via });
});

// ── Meta webhook intake (comments + DMs) ─────────────────────────────────────
// Mounted OUTSIDE /v1/* so it skips Bearer auth — Meta authenticates by signing
// the body with the app secret, not by carrying our key. Comments/DMs land in
// the per-channel stores (data/comments, data/dms) for the Inbox + agents to
// triage. Set META_VERIFY_TOKEN (handshake), META_APP_SECRET (signature), and
// optionally META_WEBHOOK_CHANNEL (which channel inbound items belong to).
const WEBHOOK_CHANNEL = () => process.env.META_WEBHOOK_CHANNEL || "global";

// GET = the one-time subscription handshake.
// Aliases: /webhooks/meta is the canonical path; /ig + /instagram are accepted
// too (some configs point the Instagram-object webhook at a distinct path).
const WEBHOOK_PATHS = ["/webhooks/meta", "/webhooks/meta/ig", "/webhooks/meta/instagram"];

app.on("GET", WEBHOOK_PATHS, (c) => {
  const mode = c.req.query("hub.mode");
  const token = c.req.query("hub.verify_token");
  const challenge = c.req.query("hub.challenge") ?? "";
  if (mode === "subscribe" && token && token === process.env.META_VERIFY_TOKEN) return c.text(challenge, 200);
  return c.text("forbidden", 403);
});

function verifyMetaSignature(raw: string, header: string | undefined): boolean {
  if (!header?.startsWith("sha256=")) return false;
  // The X-Hub signature is signed with the app secret of the product the event
  // belongs to: META_APP_SECRET for the Facebook-Login (page) webhook,
  // INSTAGRAM_APP_SECRET for the Instagram-Login (object:"instagram") webhook.
  // Accept either so one deployment with both products verifies both.
  const secrets = [process.env.META_APP_SECRET, process.env.INSTAGRAM_APP_SECRET].filter(Boolean) as string[];
  if (!secrets.length) return false; // no secret configured → reject (never accept unsigned)
  const got = Buffer.from(header);
  for (const secret of secrets) {
    const expected = Buffer.from("sha256=" + createHmac("sha256", secret).update(raw).digest("hex"));
    if (got.length === expected.length && timingSafeEqual(got, expected)) return true;
  }
  return false;
}

// POST = signed event delivery. Verify HMAC, then ingest comments + messages.
app.on("POST", WEBHOOK_PATHS, async (c) => {
  const raw = await c.req.text();
  if (!verifyMetaSignature(raw, c.req.header("x-hub-signature-256"))) return c.json({ error: "bad signature" }, 401);
  let body: any;
  try {
    body = JSON.parse(raw);
  } catch {
    return c.json({ error: "bad json" }, 400);
  }
  // body.object distinguishes the webhook product: "page" (Facebook-Login Page
  // connections) vs "instagram" (Instagram-Login, no Page). Captured for
  // observability only — routing below is object-AGNOSTIC and must not branch
  // on it (the entry/changes/messaging payload shape is identical for both).
  const obj = String(body?.object ?? "");
  let comments = 0;
  let messages = 0;
  const dmChannels = new Set<string>(); // channels that got a new DM → maybe auto-respond
  const commentChannels = new Set<string>(); // channels that got a new comment → maybe DM-trigger
  for (const entry of (body?.entry ?? []) as any[]) {
    // Per-brand routing, object-agnostic: entry.id is the account the event is
    // for — for the "page" object it's the Page id, for the "instagram" object
    // it's the IG account id. channelForIgAccount matches BOTH (igUserId OR
    // pageId) → the owning channel; fall back to the global channel. Both the
    // Facebook-Login and Instagram-Login payloads deliver comments under
    // entry[].changes[field=comments] and DMs under entry[].messaging[], so no
    // per-flavor branching is needed here.
    const channel = channelForIgAccount(String(entry?.id ?? "")) || WEBHOOK_CHANNEL();
    // Comment events: entry[].changes[] with field "comments".
    for (const ch of (entry?.changes ?? []) as any[]) {
      if (ch?.field !== "comments" || !ch?.value) continue;
      const v = ch.value;
      const mediaId = String(v.media?.id ?? v.media_id ?? "");
      const commentId = String(v.id ?? "");
      if (!mediaId || !commentId) continue;
      ingestComment(channel, { mediaId, commentId, text: String(v.text ?? ""), username: v.from?.username ? String(v.from.username) : undefined });
      comments++;
      commentChannels.add(channel);
    }
    // DM events: entry[].messaging[] (echoes from us are skipped).
    for (const m of (entry?.messaging ?? []) as any[]) {
      if (!m?.message || m.message.is_echo) continue;
      const senderId = String(m.sender?.id ?? "");
      const text = String(m.message.text ?? "");
      if (!senderId || !text) continue;
      ingestMessage(channel, { senderId, text, messageId: m.message.mid, timestamp: m.timestamp ? new Date(Number(m.timestamp)).toISOString() : undefined });
      messages++;
      dmChannels.add(channel);
    }
  }
  // 24/7 auto-reply: fire the responder for each channel that got a new DM (gated
  // on responder.enabled inside maybeAutoRespond). Fire-and-forget — Meta needs a
  // fast 200; the responder runs in the background.
  for (const ch of dmChannels) maybeAutoRespond(ch);
  for (const ch of commentChannels) maybeCommentTrigger(ch);
  return c.json({ ok: true, object: obj, comments, messages });
});

// ── Instagram-Login OAuth (no Facebook Page) ───────────────────────────────
// GET /connect/ig?channel=<id> → 302 to the IG authorize screen. The opaque
// state embeds the channel so the callback can recover which brand connected.
app.get("/connect/ig", (c) => {
  const channel = c.req.query("channel");
  if (!channel) return c.text("missing ?channel=<id>", 400);
  const { url } = instagramAuthorizeUrl(channel);
  return c.redirect(url, 302);
});

// GET /callback/meta/ig — Instagram redirects here with ?code & ?state (or
// ?error on denial). We recover the channel from the state prefix
// (`<channel>:<nonce>.<hmac>`), exchange the code for a long-lived token, and
// persist the connection. This path MUST match INSTAGRAM_OAUTH_REDIRECT.
const IG_CALLBACK_PATHS = ["/callback/meta/ig", "/api/connections/ig-callback"];
const oauthPage = (title: string, body: string) =>
  `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>` +
  `<body style="font:16px/1.6 -apple-system,system-ui,sans-serif;background:#0b0b0f;color:#e8e8ee;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0">` +
  `<div style="max-width:460px;padding:32px;text-align:center">${body}</div></body>`;
app.on("GET", IG_CALLBACK_PATHS, async (c) => {
  const err = c.req.query("error");
  if (err) {
    const desc = c.req.query("error_description") || err;
    return c.html(oauthPage("Connection cancelled", `<h2>Connection cancelled</h2><p style="color:#9a9aa6">${desc}</p>`), 400);
  }
  const code = c.req.query("code");
  const state = c.req.query("state") ?? "";
  if (!code || !state.includes(":")) return c.html(oauthPage("Invalid callback", `<h2>Invalid callback</h2><p style="color:#9a9aa6">Missing code or state. Restart the connect flow.</p>`), 400);
  const channel = state.slice(0, state.indexOf(":"));
  const res = await exchangeIgCode(channel, code, state);
  if (!res.ok) return c.html(oauthPage("Connection failed", `<h2>Connection failed</h2><p style="color:#9a9aa6">${res.reason}</p>`), 400);
  const u = (res.view as any)?.username;
  return c.html(oauthPage("Connected", `<h2>✅ Instagram connected</h2><p style="color:#9a9aa6">${u ? "@" + u + " · " : ""}channel <b>${channel}</b> is now linked. You can close this tab.</p>`), 200);
});

// ── canonical tool bridge ──────────────────────────────────────────────────
// The single registry (editor + pipeline + plan/calendar tools) exposed over
// REST so the SDK, CLI and MCP can drive every capability — incl. the plan_*
// calendar CRUD — through one uniform surface.
app.get("/v1/tools", (c) => c.json({ tools: toolsManifest() }));

app.post("/v1/tools/:name", async (c) => {
  const ctx = c.get("ctx");
  const name = c.req.param("name");
  if (!toolPermitted(ctx, name)) return c.json({ error: `forbidden: role '${ctx.role}' cannot call '${name}'` }, 403);
  const input = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  // Engine runs scoped to the caller's workspace (it has no Clerk).
  const result = await callTool(name, { workspaceId: ctx.workspaceId, ...(input ?? {}) });
  return c.json(result, result.ok ? 200 : 400);
});

// ── writes ───────────────────────────────────────────────────────────────────
async function dispatch(topic: string, job: Record<string, unknown>): Promise<void> {
  const c = await mqtt.connectAsync(process.env.SOCHELI_BROKER_URL || "mqtt://127.0.0.1:1883", {
    username: process.env.SOCHELI_MQTT_USER,
    password: process.env.SOCHELI_MQTT_PASS,
    connectTimeout: 8000,
  });
  await c.publishAsync(topic, JSON.stringify(job), { qos: 1 });
  await c.endAsync();
}

app.post("/v1/generate", async (c) => {
  const ctx = c.get("ctx");
  if (!can(ctx.role, "queue.dispatch")) return c.json({ error: "forbidden: queue.dispatch" }, 403);
  const b = await c.req.json().catch(() => ({}));
  const type = b.type === "auto" ? "auto" : b.type === "longform" ? "longform" : "new";
  if ((type === "new" || type === "longform") && !b.seed) return c.json({ error: `seed required for a '${type}' build` }, 400);
  // Output geometry (wire contract): an optional named aspect, or a custom
  // width+height (both required) that overrides it. Absent → engine default 9:16.
  const aspect = b.aspect === "9:16" || b.aspect === "1:1" || b.aspect === "16:9" ? b.aspect : undefined;
  const width = Number.isFinite(b.width) && b.width > 0 ? Math.round(b.width) : undefined;
  const height = Number.isFinite(b.height) && b.height > 0 ? Math.round(b.height) : undefined;
  if ((width && !height) || (!width && height)) return c.json({ error: "custom canvas needs both width and height" }, 400);
  const job = {
    id: `job_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`,
    type,
    channel: String(b.channel ?? "labrinox"),
    seed: b.seed ? String(b.seed) : undefined,
    mood: b.mood ? String(b.mood) : undefined,
    aspect,
    width,
    height,
    voice: b.voice === true,
    createdAt: new Date().toISOString(),
    by: "api",
    // tenant: stamp the job so the render result lands in the caller's workspace
    workspaceId: ctx.workspaceId,
    createdBy: ctx.userId ?? undefined,
  };

  // central scheduler: route to the best-fit device by capability
  const reqs = jobRequirements(job);
  const match = pickDevice(getDevices(), reqs);
  if (!match.device) return c.json({ error: match.reason, requirements: reqs }, 503);

  try {
    await dispatch(`socheli/device/${match.device.device}/jobs`, job);
  } catch (e: any) {
    return c.json({ error: `broker unreachable: ${e?.message ?? e}` }, 502);
  }
  return c.json({ dispatched: true, job, device: match.device.device, routing: match.reason });
});

app.post("/v1/items/:id/publish", async (c) => {
  const ctx = c.get("ctx");
  const id = c.req.param("id");
  // 404 (not 403) when the item isn't in the caller's workspace — cross-tenant
  // ids stay indistinguishable from missing ones.
  if (!getItem(id, ctx.workspaceId)) return c.json({ error: "not found" }, 404);
  if (!can(ctx.role, "content.publish")) return c.json({ error: "forbidden: content.publish" }, 403);
  const b = await c.req.json().catch(() => ({}));
  const args = ["--import", "tsx", join(ROOT, "packages", "engine", "src", "cli.ts"), "publish", id];
  if (b.public === true) args.push("--public");
  if (b.aigc === false) args.push("--no-aigc");
  const child = spawn("node", args, { cwd: ROOT, detached: true, stdio: "ignore", env: process.env });
  child.unref();
  return c.json({ dispatched: true });
});

app.put("/v1/schedule", async (c) => {
  const ctx = c.get("ctx");
  if (!can(ctx.role, "schedule.manage")) return c.json({ error: "forbidden: schedule.manage" }, 403);
  const s = await c.req.json().catch(() => null);
  if (!s || typeof s !== "object") return c.json({ error: "bad schedule" }, 400);
  s.updatedAt = new Date().toISOString();
  s.workspaceId = ctx.workspaceId; // the schedule belongs to the caller's workspace
  if (ctx.userId) s.createdBy = ctx.userId;
  writeFileSync(join(DATA_DIR, "schedule.json"), JSON.stringify(s, null, 2));
  return c.json(s);
});

// ── API key management (issue/list/revoke this workspace's keys) ─────────────
app.get("/v1/keys", (c) => {
  const ctx = c.get("ctx");
  if (!can(ctx.role, "apikey.manage")) return c.json({ error: "forbidden: apikey.manage" }, 403);
  return c.json({ keys: listKeys(ctx.workspaceId) });
});

app.post("/v1/keys", async (c) => {
  const ctx = c.get("ctx");
  if (!can(ctx.role, "apikey.manage")) return c.json({ error: "forbidden: apikey.manage" }, 403);
  const b = (await c.req.json().catch(() => ({}))) as { label?: string; role?: string };
  const role = (ROLES as readonly string[]).includes(String(b.role)) ? (b.role as Role) : undefined;
  const { key, record } = issueKey(ctx, { label: String(b.label ?? "API key"), role });
  return c.json({ key, record }, 201); // plaintext returned ONCE
});

app.delete("/v1/keys/:id", (c) => {
  const ctx = c.get("ctx");
  if (!can(ctx.role, "apikey.manage")) return c.json({ error: "forbidden: apikey.manage" }, 403);
  return revokeKey(ctx.workspaceId, c.req.param("id"))
    ? c.json({ revoked: true })
    : c.json({ error: "not found" }, 404);
});

app.notFound((c) => c.json({ error: "not found" }, 404));

serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`[socheli-api ${VERSION}] listening on :${info.port}${authConfigured() ? "" : "  (WARNING: no API keys and no SOCHELI_API_KEY)"}`);
});
