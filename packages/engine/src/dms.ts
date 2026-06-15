import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { DATA_DIR, ensureDir, nowIso } from "./store.ts";
import { httpCurl } from "./http.ts";
import { isTokenError } from "./publish-types.ts";
import { resolveIgCreds } from "./connections.ts";
import { isSendingHalted } from "./admin.ts";

/* Instagram Direct Messages via the Graph API — Phase 2 of community management
   (comments are Phase 1, see comments.ts). Prerequisites beyond publishing:
     - Business/Creator IG linked to a Facebook Page (or the Instagram-login app)
     - an access token minted with `instagram_manage_messages`
     - the Messenger/Instagram webhook subscribed (intake lands via the API's
       /v1/webhooks/meta route → ingestMessage()), OR a poll via pullConversations

   PER-BRAND CREDENTIALS: live calls resolve credentials per `channel` via
   resolveIgCreds(channel) — a stored connection wins, else the global IG_USER_ID /
   IG_ACCESS_TOKEN env fallback (channel "global"). Each brand uses its OWN
   connected account; old single-account deployments keep working via the env
   fallback.

   THE 24-HOUR WINDOW: Meta only lets you message a user within 24h of THEIR last
   message (the Human Agent tag extends to 7 days but needs the feature enabled).
   sendMessage() computes hours-since-last-inbound from the stored thread and
   refuses outside the window with a clear reason, rather than letting Meta reject.

   Same gating model as comments + publish: an agent triages + drafts; a human
   sends (dm_send). Live calls are token-gated and never throw. */

const GRAPH = "https://graph.facebook.com/v21.0";
const useProxy = () => process.env.IG_USE_PROXY === "1";

function graphJson(r: { stdout: string }): any {
  try {
    return JSON.parse(r.stdout);
  } catch {
    return { error: { message: (r.stdout || "").slice(0, 200) } };
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Types
// ───────────────────────────────────────────────────────────────────────────

export type DmMessage = {
  id: string;
  text: string;
  /** "in" = from the user to us; "out" = from us. */
  direction: "in" | "out";
  fromId?: string;
  timestamp?: string;
};

export type DmThread = {
  conversationId: string;
  participantId: string; // the user's IG-scoped id (IGSID) — the recipient for replies
  participantUsername?: string;
  updatedAt: string;
  /** ISO of the user's most recent INBOUND message — drives the 24h window. */
  lastInboundAt?: string;
  messages: DmMessage[];
};

export type DmDraft = {
  conversationId: string;
  recipientId: string;
  inReplyTo: string;
  reply: string;
  draftedAt: string;
  status: "pending" | "sent" | "skipped";
  sentId?: string;
  sentAt?: string;
};

// ───────────────────────────────────────────────────────────────────────────
// Store — data/dms/<channel>/{threads,drafts}.json (flat JSON, atomic)
// ───────────────────────────────────────────────────────────────────────────

const DMS_DIR = join(DATA_DIR, "dms");
const sanitize = (c: string) => (c || "global").replace(/[^a-zA-Z0-9_-]/g, "-");
const channelDir = (channel: string) => join(DMS_DIR, sanitize(channel));
const threadsFile = (channel: string) => join(channelDir(channel), "threads.json");
const draftsFile = (channel: string) => join(channelDir(channel), "drafts.json");

function loadJson<T>(path: string, fallback: T): T {
  try {
    return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as T) : fallback;
  } catch {
    return fallback;
  }
}
function saveJson(path: string, data: unknown): void {
  ensureDir(path.slice(0, path.lastIndexOf("/")));
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  renameSync(tmp, path);
}

export function loadThreads(channel: string): DmThread[] {
  return loadJson<DmThread[]>(threadsFile(channel), []);
}
export function saveThreads(channel: string, threads: DmThread[]): void {
  saveJson(threadsFile(channel), threads);
}
export function loadDmDrafts(channel: string): DmDraft[] {
  return loadJson<DmDraft[]>(draftsFile(channel), []);
}
export function saveDmDrafts(channel: string, drafts: DmDraft[]): void {
  saveJson(draftsFile(channel), drafts);
}

export function findThread(channel: string, conversationId: string): DmThread | undefined {
  return loadThreads(channel).find((t) => t.conversationId === conversationId);
}

/** Threads that need a reply: last message is inbound and no pending draft. */
export function listOpenThreads(channel: string): DmThread[] {
  const drafted = new Set(loadDmDrafts(channel).filter((d) => d.status === "pending").map((d) => d.conversationId));
  return loadThreads(channel).filter((t) => {
    if (drafted.has(t.conversationId)) return false;
    const last = t.messages[t.messages.length - 1];
    return last ? last.direction === "in" : false;
  });
}

export function upsertDmDraft(channel: string, draft: DmDraft): DmDraft {
  const drafts = loadDmDrafts(channel);
  const i = drafts.findIndex((d) => d.conversationId === draft.conversationId);
  if (i >= 0) drafts[i] = draft;
  else drafts.push(draft);
  saveDmDrafts(channel, drafts);
  return draft;
}

/** Merge one thread into the store (replace by conversationId). */
export function upsertThread(channel: string, thread: DmThread): void {
  const threads = loadThreads(channel);
  const i = threads.findIndex((t) => t.conversationId === thread.conversationId);
  if (i >= 0) threads[i] = thread;
  else threads.push(thread);
  saveThreads(channel, threads);
}

const hoursSince = (iso?: string): number | undefined =>
  iso ? (Date.now() - new Date(iso).getTime()) / 3_600_000 : undefined;

/** Is the 24h messaging window open for this thread? */
export function windowOpen(thread: DmThread | undefined): { open: boolean; hours?: number } {
  const h = hoursSince(thread?.lastInboundAt);
  if (h === undefined) return { open: true }; // unknown → let Meta decide
  return { open: h <= 24, hours: Math.round(h) };
}

// ───────────────────────────────────────────────────────────────────────────
// Webhook intake — called by the API's /v1/webhooks/meta route
// ───────────────────────────────────────────────────────────────────────────

/** Append an inbound DM (from a `messages` webhook event) to the store. */
export function ingestMessage(
  channel: string,
  ev: { conversationId?: string; senderId: string; text: string; messageId?: string; timestamp?: string },
): void {
  const conversationId = ev.conversationId || `igsid:${ev.senderId}`;
  const threads = loadThreads(channel);
  let t = threads.find((x) => x.conversationId === conversationId);
  if (!t) {
    t = { conversationId, participantId: ev.senderId, updatedAt: nowIso(), messages: [] };
    threads.push(t);
  }
  const ts = ev.timestamp || nowIso();
  const msgId = ev.messageId || `m_${ts}`;
  if (t.messages.some((m) => m.id === msgId)) return; // de-dupe Meta webhook retries
  t.messages.push({ id: msgId, text: ev.text, direction: "in", fromId: ev.senderId, timestamp: ts });
  t.updatedAt = ts;
  t.lastInboundAt = ts;
  saveThreads(channel, threads);
}

// ───────────────────────────────────────────────────────────────────────────
// Live Graph calls (token-gated, never throw)
// ───────────────────────────────────────────────────────────────────────────

type LiveGate = { ok: false; reason: string };
const needsAuth = (extra = ""): LiveGate => ({
  ok: false,
  reason:
    "Connect this brand's Instagram account (Connections), or set IG_USER_ID + IG_ACCESS_TOKEN (token with instagram_manage_messages) in .env, to manage DMs." +
    (extra ? ` ${extra}` : ""),
});

/** Pull recent IG conversations + their messages for the brand's connected account. */
export async function pullConversations(channel: string, opts: { limit?: number } = {}): Promise<{ ok: true; threads: DmThread[] } | LiveGate> {
  const creds = resolveIgCreds(channel);
  if (!creds) return needsAuth();
  const { userId, token, base } = creds;
  const limit = Math.max(1, Math.min(25, opts.limit ?? 10));

  const convos = graphJson(
    httpCurl([`${base}/${userId}/conversations?platform=instagram&fields=id,updated_time,participants&limit=${limit}&access_token=${token}`], { proxy: useProxy() }),
  );
  if (convos?.error) {
    if (isTokenError(String(convos.error?.message ?? ""), convos.error?.code)) return needsAuth(`Re-auth: ${convos.error?.message}`);
    return { ok: false, reason: `Graph conversations failed: ${convos.error?.message ?? "unknown"}` };
  }

  const threads: DmThread[] = [];
  for (const c of (convos?.data ?? []) as any[]) {
    if (!c?.id) continue;
    const participant = ((c.participants?.data ?? []) as any[]).find((p) => String(p.id) !== String(userId)) ?? {};
    const msgRes = graphJson(
      httpCurl([`${base}/${c.id}?fields=messages{id,from,to,message,created_time}&access_token=${token}`], { proxy: useProxy() }),
    );
    const raw = ((msgRes?.messages?.data ?? []) as any[]).slice().reverse(); // API returns newest-first
    const messages: DmMessage[] = raw.map((m) => ({
      id: String(m.id),
      text: String(m.message ?? ""),
      direction: String(m.from?.id) === String(userId) ? "out" : "in",
      fromId: m.from?.id ? String(m.from.id) : undefined,
      timestamp: m.created_time ? String(m.created_time) : undefined,
    }));
    const lastIn = [...messages].reverse().find((m) => m.direction === "in");
    threads.push({
      conversationId: String(c.id),
      participantId: String(participant.id ?? ""),
      participantUsername: participant.username ? String(participant.username) : undefined,
      updatedAt: c.updated_time ? String(c.updated_time) : nowIso(),
      lastInboundAt: lastIn?.timestamp,
      messages,
    });
  }
  return { ok: true, threads };
}

/** Send a DM reply (LIVE, GATED). Enforces the 24h window from the stored thread. */
export async function sendMessage(
  channel: string,
  conversationId: string,
  recipientId: string,
  text: string,
): Promise<{ ok: true; id: string } | LiveGate | { ok: false; reason: string }> {
  const halt = isSendingHalted(channel);
  if (halt.halted) return { ok: false, reason: halt.reason ?? "sending halted by admin" };
  const creds = resolveIgCreds(channel);
  if (!creds) return needsAuth();
  const { userId, token, base } = creds;
  if (!recipientId) return { ok: false, reason: "no recipient id (IGSID) for this thread" };

  const w = windowOpen(findThread(channel, conversationId));
  if (!w.open) return { ok: false, reason: `outside the 24-hour messaging window (last inbound ~${w.hours}h ago) — Meta will reject this send` };

  const body = JSON.stringify({ recipient: { id: recipientId }, message: { text } });
  const res = graphJson(
    httpCurl(["-X", "POST", `${base}/${userId}/messages?access_token=${token}`, "-H", "Content-Type: application/json", "-d", body], { proxy: useProxy() }),
  );
  if (res?.message_id || res?.id) return { ok: true, id: String(res.message_id ?? res.id) };
  if (isTokenError(String(res?.error?.message ?? ""), res?.error?.code)) return needsAuth(`Re-auth: ${res.error?.message}`);
  return { ok: false, reason: `DM send failed: ${res?.error?.message ?? "unknown Graph error"}` };
}
