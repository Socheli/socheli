import { existsSync } from "node:fs";
import { basename } from "node:path";
import type { ContentItem } from "@os/schemas";
import { httpCurl } from "./http.ts";
import { hostUploader } from "./host.ts";
import { resolveIgCreds } from "./connections.ts";
import { type PublishResult, type PublishOpts, captionFor, assertDisclosure, isTokenError, isTransient, withRetry, backoffMs, sleep } from "./publish-types.ts";

/* Instagram Reels publish via the Graph API. Prerequisites (App Review gated):
   - a Business/Creator IG account linked to a Facebook Page
   - a Meta app with `instagram_content_publish` (+ `instagram_basic`) approved
   - a long-lived IG_ACCESS_TOKEN (≈60-day expiry — must be refreshed) + IG_USER_ID
   - public object storage (host.ts) — the Graph API ingests a `video_url`, not a file.

   Three-step container flow: create REELS container → poll until FINISHED →
   publish. graph.facebook.com is not geo-blocked in some regions, so no proxy (set
   IG_USE_PROXY=1 to force the tunnel if your exit needs it). */

const GRAPH = "https://graph.facebook.com/v21.0";
const useProxy = () => process.env.IG_USE_PROXY === "1";

function graphJson(r: { stdout: string }): any {
  try {
    return JSON.parse(r.stdout);
  } catch {
    return { error: { message: (r.stdout || "").slice(0, 200) } };
  }
}

/* Per-brand credentials. resolveIgCreds owns the env fallback (global
   IG_USER_ID/IG_ACCESS_TOKEN) for back-compat — null means not-connected. */
function igCreds(channel?: string) {
  return resolveIgCreds(channel);
}

export async function publishInstagram(item: ContentItem, opts: PublishOpts = {}): Promise<PublishResult> {
  if (!item.videoPath || !existsSync(item.videoPath)) return { status: "error", message: "no rendered video" };

  // COMPLIANCE GATE: Meta requires AI-generated content to be disclosed. Block the
  // publish up-front if disclosure is missing for AI content (matches TikTok).
  try {
    assertDisclosure(item, opts);
  } catch (e: any) {
    return { status: "error", message: e?.message ?? "AIGC disclosure required" };
  }

  const creds = resolveIgCreds(item.channel);
  if (!creds)
    return {
      status: "needs-auth",
      message: "Connect this brand's Instagram in the connection wizard, or set IG_USER_ID + IG_ACCESS_TOKEN.",
    };
  const userId = creds.userId;
  const token = creds.token;
  // Use the connection's resolved API host (graph.facebook.com for Facebook-Login
  // page tokens; graph.instagram.com for Instagram-Login tokens) — an IG-Login
  // token is only valid on graph.instagram.com, so the hardcoded GRAPH would 400.
  const GRAPH = creds.base;

  const host = hostUploader();
  if (!host) return { status: "needs-auth", message: "No public host configured — set HOST_S3_* or HOST_UPLOAD_URL (see host.ts). IG ingests a public video_url." };

  let videoUrl: string;
  try {
    ({ url: videoUrl } = await host.uploadPublic(item.videoPath, `ig/${item.id}_${basename(item.videoPath)}`));
  } catch (e: any) {
    return { status: "error", message: `host upload failed: ${e?.message ?? e}` };
  }

  const caption = captionFor(item, "instagram");

  // AIGC disclosure is enforced up-front via assertDisclosure(). Meta's API still
  // has no public field to set the "AI info" label programmatically, so we cannot
  // hard-set it on the container yet.
  // TODO: set the AI-content label via the Graph API once Meta exposes the field.

  // 1. create the REELS container (retry transient failures)
  const created = await withRetry(
    async () =>
      graphJson(
        httpCurl(
          ["-X", "POST", `${GRAPH}/${userId}/media`, "--data-urlencode", `caption=${caption}`, "-d", "media_type=REELS", "--data-urlencode", `video_url=${videoUrl}`, "-d", `access_token=${token}`],
          { proxy: useProxy() },
        ),
      ),
    (r) => !r.id && isTransient(String(r?.error?.message ?? "")),
  );
  if (!created.id) return tokenAwareError("instagram", created);
  const containerId = created.id as string;

  // 2. poll the container until the upload/transcode FINISHED (Reels can be slow), with backoff
  let delay = 4000;
  for (let i = 0; i < 30; i++) {
    await sleep(delay);
    delay = Math.min(20_000, delay + backoffMs(Math.min(i, 4), 1500, 12_000));
    const st = graphJson(httpCurl([`${GRAPH}/${containerId}?fields=status_code,status&access_token=${token}`], { proxy: useProxy() }));
    if (st.status_code === "FINISHED") break;
    if (st.error && isTokenError(String(st.error?.message ?? ""), st.error?.code)) return { status: "needs-auth", message: `Instagram re-auth needed (token expired during poll): ${st.error?.message}` };
    if (st.error && isTransient(String(st.error?.message ?? ""))) continue; // transient read; keep polling
    if (st.status_code === "ERROR" || st.error) return { status: "error", message: `container ${containerId}: ${st.status ?? st.error?.message ?? "ERROR"}` };
    if (i === 29) return { status: "processing", id: containerId, message: "container still processing after timeout — re-run publish later" };
  }

  // 3. publish the container (retry transient failures)
  const pub = await withRetry(
    async () => graphJson(httpCurl(["-X", "POST", `${GRAPH}/${userId}/media_publish`, "-d", `creation_id=${containerId}`, "-d", `access_token=${token}`], { proxy: useProxy() })),
    (r) => !r.id && isTransient(String(r?.error?.message ?? "")),
  );
  if (!pub.id) return tokenAwareError("instagram", pub);
  return { status: "published", id: pub.id, url: `https://www.instagram.com/reel/${pub.id}/` };
}

/* Meta error 190 / OAuthException = expired or invalid token → surface as
   needs-auth (re-auth) rather than a generic error, so the bundle still runs. */
function tokenAwareError(_platform: string, j: any): PublishResult {
  const msg = j?.error?.message ?? "unknown Graph API error";
  const code = j?.error?.code;
  if (isTokenError(String(msg), code)) return { status: "needs-auth", message: `Instagram re-auth needed (token expired/invalid): ${msg}` };
  return { status: "error", message: msg };
}

/* ─── G1: Instagram analytics ingestion ────────────────────────────────────
   Fetch performance insights for a published IG media id via the Graph API.
   Reels insights vary by account/permissions, so we request a generous field
   set and read whatever comes back. Token-gated: a missing token returns
   { ok:false, skipped:true } so the caller can simply skip — never throws. */
export type RawPlatformMetrics = {
  ok: boolean;
  skipped?: boolean;
  reason?: string;
  platform: "instagram" | "tiktok";
  postId: string;
  views?: number;
  likes?: number;
  comments?: number;
  shares?: number;
  saves?: number;
  reach?: number;
  /** Average watch-time / total-duration if derivable, 0..1. */
  retention?: number;
  raw?: unknown;
};

export async function fetchInstagramAnalytics(mediaId: string, channel?: string): Promise<RawPlatformMetrics> {
  const base: RawPlatformMetrics = { ok: false, platform: "instagram", postId: mediaId };
  if (!mediaId) return { ...base, skipped: true, reason: "no media id" };
  const creds = igCreds(channel);
  const token = creds?.token;
  if (!token) return { ...base, skipped: true, reason: "no Instagram connection (set IG_ACCESS_TOKEN or connect the brand)" };
  const apiBase = creds?.base ?? GRAPH; // graph.instagram.com for IG-Login, else graph.facebook.com

  // Reels-friendly insight metrics; the API ignores unsupported ones per account.
  const metrics = "plays,reach,likes,comments,shares,saved,total_interactions,ig_reels_avg_watch_time,ig_reels_video_view_total_time";
  const insights = graphJson(
    httpCurl([`${apiBase}/${mediaId}/insights?metric=${metrics}&access_token=${token}`], { proxy: useProxy() }),
  );
  // Public fields fallback (like/comment counts) — works even without insights perms.
  const fields = graphJson(
    httpCurl([`${apiBase}/${mediaId}?fields=like_count,comments_count&access_token=${token}`], { proxy: useProxy() }),
  );

  if (insights?.error && isTokenError(String(insights.error?.message ?? ""), insights.error?.code) && fields?.error)
    return { ...base, skipped: true, reason: `re-auth needed: ${insights.error?.message}` };

  const m = new Map<string, number>();
  for (const row of (insights?.data ?? []) as any[]) {
    const v = row?.values?.[0]?.value ?? row?.total_value?.value;
    if (typeof v === "number") m.set(String(row.name), v);
  }

  const avgWatchMs = m.get("ig_reels_avg_watch_time");
  // Retention proxy: avg watch time vs the rendered video duration (ms), if known.
  // We can't read duration here; leave retention undefined unless the API gives a ratio.
  const out: RawPlatformMetrics = {
    ok: true,
    platform: "instagram",
    postId: mediaId,
    views: m.get("plays") ?? m.get("ig_reels_video_view_total_time") ?? undefined,
    reach: m.get("reach"),
    likes: m.get("likes") ?? (typeof fields?.like_count === "number" ? fields.like_count : undefined),
    comments: m.get("comments") ?? (typeof fields?.comments_count === "number" ? fields.comments_count : undefined),
    shares: m.get("shares"),
    saves: m.get("saved"),
    raw: { insights: insights?.data ?? insights, fields, avgWatchMs },
  };
  if (out.views === undefined && out.likes === undefined && out.comments === undefined)
    return { ...base, skipped: true, reason: "no metrics returned (insights may need ads_management/instagram_manage_insights)" };
  return out;
}
