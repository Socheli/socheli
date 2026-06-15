import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { DATA_DIR, ensureDir, nowIso } from "./store.ts";
import { httpCurl } from "./http.ts";
import { isTokenError } from "./publish-types.ts";
import { resolveIgCreds } from "./connections.ts";
import { isSendingHalted } from "./admin.ts";

/* Instagram comment management via the Graph API — the read/triage/moderate half
   of community management (publishing lives in instagram.ts). Same prerequisites
   as publishing plus the comment scope:
     - Business/Creator IG linked to a Facebook Page (or the Instagram-login app)
     - a long-lived access token minted with `instagram_manage_comments`
       (+ `instagram_basic`) — the publish token's `instagram_content_publish`
       scope alone is NOT enough to read/reply to comments

   PER-BRAND CREDENTIALS: live calls resolve credentials per `channel` via
   resolveIgCreds(channel) — a stored connection (data/connections/<channel>.json)
   wins, else the global IG_USER_ID / IG_ACCESS_TOKEN env fallback (channel
   "global"). So each brand uses its OWN connected account; old single-account
   deployments keep working through the env fallback.

   Design: the LIVE reply send is GATED, exactly like the publish gate. An agent
   pulls comments, drafts brand-voice replies, and may hide spam — but a human
   sends the replies (comment_send), so the brand voice never goes out unreviewed.
   Token-gated calls NEVER throw: missing creds return { ok:false, reason } so a
   triage run degrades cleanly. */

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

export type IgComment = {
  id: string;
  text: string;
  username?: string;
  timestamp?: string;
  likeCount?: number;
  hidden?: boolean;
};

export type CommentSnapshot = {
  mediaId: string;
  caption?: string;
  permalink?: string;
  pulledAt: string;
  comments: IgComment[];
};

export type DraftReply = {
  commentId: string;
  mediaId: string;
  username?: string;
  inReplyTo: string; // the comment text being answered (for human review)
  reply: string;
  draftedAt: string;
  status: "pending" | "sent" | "skipped";
  sentId?: string;
  sentAt?: string;
};

// ───────────────────────────────────────────────────────────────────────────
// Store — data/comments/<channel>/{snapshots,drafts}.json (flat JSON, atomic)
// ───────────────────────────────────────────────────────────────────────────

const COMMENTS_DIR = join(DATA_DIR, "comments");
const sanitize = (c: string) => (c || "global").replace(/[^a-zA-Z0-9_-]/g, "-");
const channelDir = (channel: string) => join(COMMENTS_DIR, sanitize(channel));
const snapshotsFile = (channel: string) => join(channelDir(channel), "snapshots.json");
const draftsFile = (channel: string) => join(channelDir(channel), "drafts.json");

function loadJson<T>(path: string, fallback: T): T {
  try {
    return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as T) : fallback;
  } catch {
    return fallback;
  }
}

function saveJson(path: string, data: unknown): void {
  ensureDir(path.slice(0, path.lastIndexOf("/"))); // parent dir
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  renameSync(tmp, path);
}

export function loadSnapshots(channel: string): CommentSnapshot[] {
  return loadJson<CommentSnapshot[]>(snapshotsFile(channel), []);
}
export function saveSnapshots(channel: string, snaps: CommentSnapshot[]): void {
  saveJson(snapshotsFile(channel), snaps);
}
export function loadDrafts(channel: string): DraftReply[] {
  return loadJson<DraftReply[]>(draftsFile(channel), []);
}
export function saveDrafts(channel: string, drafts: DraftReply[]): void {
  saveJson(draftsFile(channel), drafts);
}

/** Flatten stored comments; `unansweredOnly` drops any that already have a
    pending/sent draft (so an agent doesn't double-reply). */
export function listStoredComments(
  channel: string,
  opts: { unansweredOnly?: boolean } = {},
): Array<IgComment & { mediaId: string; permalink?: string }> {
  const drafted = new Set(loadDrafts(channel).map((d) => d.commentId));
  const out: Array<IgComment & { mediaId: string; permalink?: string }> = [];
  for (const snap of loadSnapshots(channel)) {
    for (const c of snap.comments) {
      if (opts.unansweredOnly && drafted.has(c.id)) continue;
      out.push({ ...c, mediaId: snap.mediaId, permalink: snap.permalink });
    }
  }
  return out;
}

/** Look up one stored comment by id across the channel's snapshots. */
export function findComment(channel: string, commentId: string): (IgComment & { mediaId: string }) | undefined {
  for (const snap of loadSnapshots(channel)) {
    const c = snap.comments.find((x) => x.id === commentId);
    if (c) return { ...c, mediaId: snap.mediaId };
  }
  return undefined;
}

/* Webhook intake — called by the API's /v1/webhooks/meta route on a `comments`
   event. Appends the comment to its media snapshot (creating one if needed). */
export function ingestComment(
  channel: string,
  ev: { mediaId: string; commentId: string; text: string; username?: string; timestamp?: string },
): void {
  const snaps = loadSnapshots(channel);
  let snap = snaps.find((s) => s.mediaId === ev.mediaId);
  if (!snap) {
    snap = { mediaId: ev.mediaId, pulledAt: nowIso(), comments: [] };
    snaps.push(snap);
  }
  if (snap.comments.some((c) => c.id === ev.commentId)) return; // de-dupe replays
  snap.comments.push({ id: ev.commentId, text: ev.text, username: ev.username, timestamp: ev.timestamp || nowIso() });
  saveSnapshots(channel, snaps);
}

export function upsertDraft(channel: string, draft: DraftReply): DraftReply {
  const drafts = loadDrafts(channel);
  const i = drafts.findIndex((d) => d.commentId === draft.commentId);
  if (i >= 0) drafts[i] = draft;
  else drafts.push(draft);
  saveDrafts(channel, drafts);
  return draft;
}

// ───────────────────────────────────────────────────────────────────────────
// Live Graph calls (token-gated, never throw)
// ───────────────────────────────────────────────────────────────────────────

type LiveGate = { ok: false; reason: string };
const needsAuth = (extra = ""): LiveGate => ({
  ok: false,
  reason:
    "Connect this brand's Instagram account (Connections), or set IG_USER_ID + IG_ACCESS_TOKEN (token with instagram_manage_comments) in .env, to manage comments." +
    (extra ? ` ${extra}` : ""),
});

/** Pull recent media + their comments for the brand's connected IG account. */
export async function pullComments(channel: string, opts: { limit?: number } = {}): Promise<{ ok: true; snapshots: CommentSnapshot[] } | LiveGate> {
  const creds = resolveIgCreds(channel);
  if (!creds) return needsAuth();
  const { userId, token, base } = creds;
  const limit = Math.max(1, Math.min(25, opts.limit ?? 10));

  const media = graphJson(
    httpCurl([`${base}/${userId}/media?fields=id,caption,permalink,comments_count,timestamp&limit=${limit}&access_token=${token}`], { proxy: useProxy() }),
  );
  if (media?.error) {
    if (isTokenError(String(media.error?.message ?? ""), media.error?.code)) return needsAuth(`Re-auth: ${media.error?.message}`);
    return { ok: false, reason: `Graph media list failed: ${media.error?.message ?? "unknown"}` };
  }

  const snapshots: CommentSnapshot[] = [];
  for (const m of (media?.data ?? []) as any[]) {
    if (!m?.id || !(m.comments_count > 0)) continue;
    const cs = graphJson(
      httpCurl([`${base}/${m.id}/comments?fields=id,text,username,timestamp,like_count,hidden&access_token=${token}`], { proxy: useProxy() }),
    );
    const comments: IgComment[] = ((cs?.data ?? []) as any[]).map((c) => ({
      id: String(c.id),
      text: String(c.text ?? ""),
      username: c.username ? String(c.username) : undefined,
      timestamp: c.timestamp ? String(c.timestamp) : undefined,
      likeCount: typeof c.like_count === "number" ? c.like_count : undefined,
      hidden: typeof c.hidden === "boolean" ? c.hidden : undefined,
    }));
    snapshots.push({
      mediaId: String(m.id),
      caption: m.caption ? String(m.caption).slice(0, 200) : undefined,
      permalink: m.permalink ? String(m.permalink) : undefined,
      pulledAt: nowIso(),
      comments,
    });
  }
  return { ok: true, snapshots };
}

/** Send a reply to a comment (LIVE — this is the gated action). */
export async function sendReply(channel: string, commentId: string, message: string): Promise<{ ok: true; id: string } | LiveGate | { ok: false; reason: string }> {
  const halt = isSendingHalted(channel);
  if (halt.halted) return { ok: false, reason: halt.reason ?? "sending halted by admin" };
  const creds = resolveIgCreds(channel);
  if (!creds) return needsAuth();
  const { token, base } = creds;
  const res = graphJson(
    httpCurl(["-X", "POST", `${base}/${commentId}/replies`, "--data-urlencode", `message=${message}`, "-d", `access_token=${token}`], { proxy: useProxy() }),
  );
  if (res?.id) return { ok: true, id: String(res.id) };
  if (isTokenError(String(res?.error?.message ?? ""), res?.error?.code)) return needsAuth(`Re-auth: ${res.error?.message}`);
  return { ok: false, reason: `reply failed: ${res?.error?.message ?? "unknown Graph error"}` };
}

/** Hide or unhide a comment (LIVE — spam moderation). */
export async function setHidden(channel: string, commentId: string, hide: boolean): Promise<{ ok: true } | LiveGate | { ok: false; reason: string }> {
  const creds = resolveIgCreds(channel);
  if (!creds) return needsAuth();
  const { token, base } = creds;
  const res = graphJson(
    httpCurl(["-X", "POST", `${base}/${commentId}?hide=${hide ? "true" : "false"}`, "-d", `access_token=${token}`], { proxy: useProxy() }),
  );
  if (res?.success === true || res?.id) return { ok: true };
  if (isTokenError(String(res?.error?.message ?? ""), res?.error?.code)) return needsAuth(`Re-auth: ${res.error?.message}`);
  return { ok: false, reason: `hide failed: ${res?.error?.message ?? "unknown Graph error"}` };
}
