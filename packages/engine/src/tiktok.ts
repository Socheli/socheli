import { existsSync } from "node:fs";
import { basename } from "node:path";
import type { ContentItem } from "@os/schemas";
import { httpCurl } from "./http.ts";
import { hostUploader } from "./host.ts";
import { type PublishResult, type PublishOpts, captionFor, isAigc, assertDisclosure, isTokenError, isTransient, withRetry, backoffMs, sleep } from "./publish-types.ts";
import type { RawPlatformMetrics } from "./instagram.ts";
export type { RawPlatformMetrics } from "./instagram.ts";

/* TikTok Content Posting API via PULL_FROM_URL. Prerequisites:
   - a TikTok developer app with the `video.publish` scope
   - a TIKTOK_ACCESS_TOKEN (user-authorized)
   - public object storage (host.ts) whose DOMAIN is verified in the TikTok
     developer portal — PULL_FROM_URL rejects unverified domains.

   Honest limit: until the app passes TikTok's audit, posts are forced to
   SELF_ONLY (private). Set TIKTOK_AUDITED=1 once approved to post publicly. */

const API = "https://open.tiktokapis.com/v2";

function asJson(r: { stdout: string }): any {
  try {
    return JSON.parse(r.stdout);
  } catch {
    return { error: { message: (r.stdout || "").slice(0, 200) } };
  }
}

export async function publishTikTok(item: ContentItem, opts: PublishOpts = {}): Promise<PublishResult> {
  if (!item.videoPath || !existsSync(item.videoPath)) return { status: "error", message: "no rendered video" };

  // COMPLIANCE GATE: TikTok requires AI-generated content to be disclosed.
  // Block the publish up-front if disclosure is missing for AI content.
  try {
    assertDisclosure(item, opts);
  } catch (e: any) {
    return { status: "error", message: e?.message ?? "AIGC disclosure required" };
  }
  const aigc = isAigc(opts);

  const token = process.env.TIKTOK_ACCESS_TOKEN;
  if (!token)
    return {
      status: "needs-auth",
      message: "Set TIKTOK_ACCESS_TOKEN in .env. Requires a TikTok developer app with the video.publish scope (app audit needed for public posts).",
    };

  const host = hostUploader();
  if (!host) return { status: "needs-auth", message: "No public host configured — set HOST_S3_* or HOST_UPLOAD_URL. TikTok pulls the video from a verified public URL." };

  let videoUrl: string;
  try {
    ({ url: videoUrl } = await host.uploadPublic(item.videoPath, `tiktok/${item.id}_${basename(item.videoPath)}`));
  } catch (e: any) {
    return { status: "error", message: `host upload failed: ${e?.message ?? e}` };
  }

  // unaudited apps can ONLY post privately; gate public behind explicit opt-in
  const audited = process.env.TIKTOK_AUDITED === "1";
  const privacy = opts.public && audited ? "PUBLIC_TO_EVERYONE" : "SELF_ONLY";
  const title = captionFor(item, "tiktok").slice(0, 2200);

  // AIGC disclosure: TikTok's Content Posting API expects the AI-generated flag
  // inside post_info. The audited field name is `is_aigc`; some app versions use
  // an `aigc_info` block — we send `is_aigc` (the documented field) and keep a
  // mirrored aigc_info for forward-compat. TODO: confirm the exact field once the
  // app clears TikTok audit, and drop whichever the portal rejects.
  const post_info: Record<string, unknown> = {
    title,
    privacy_level: privacy,
    disable_comment: false,
    is_aigc: aigc,
    aigc_info: { is_aigc: aigc },
  };
  const initBody = JSON.stringify({ post_info, source_info: { source: "PULL_FROM_URL", video_url: videoUrl } });

  // init with retry on transient failures (5xx / rate-limit / network blips)
  const init = await withRetry(
    async () =>
      asJson(
        httpCurl([
          "-X", "POST", `${API}/post/publish/video/init/`,
          "-H", `Authorization: Bearer ${token}`,
          "-H", "Content-Type: application/json; charset=UTF-8",
          "-d", initBody,
        ]),
      ),
    (r) => !r?.data?.publish_id && isTransient(String(r?.error?.message ?? r?.error?.code ?? "")),
  );
  const publishId = init?.data?.publish_id as string | undefined;
  if (!publishId) {
    const msg = String(init?.error?.message ?? init?.error?.code ?? "init failed");
    if (isTokenError(msg, init?.error?.code)) return { status: "needs-auth", message: `TikTok re-auth needed (token expired/invalid): ${msg}` };
    return { status: "error", message: `TikTok init: ${msg}` };
  }

  // poll processing status with exponential backoff, retrying transient fetch errors
  let delay = 4000;
  for (let i = 0; i < 30; i++) {
    await sleep(delay);
    delay = Math.min(20_000, delay + backoffMs(Math.min(i, 4), 1500, 12_000));
    const st = asJson(
      httpCurl(["-X", "POST", `${API}/post/publish/status/fetch/`, "-H", `Authorization: Bearer ${token}`, "-H", "Content-Type: application/json; charset=UTF-8", "-d", JSON.stringify({ publish_id: publishId })]),
    );
    const errMsg = String(st?.error?.message ?? st?.error?.code ?? "");
    if (errMsg && isTokenError(errMsg, st?.error?.code)) return { status: "needs-auth", message: `TikTok re-auth needed (token expired during poll): ${errMsg}` };
    if (errMsg && !isTransient(errMsg) && !st?.data) return { status: "error", message: `TikTok status: ${errMsg}` };
    const status = st?.data?.status;
    if (status === "PUBLISH_COMPLETE") return { status: "published", id: publishId, message: privacy === "SELF_ONLY" ? "posted privately (app not audited)" : undefined };
    if (status === "FAILED") return { status: "error", message: `TikTok: ${st?.data?.fail_reason ?? "FAILED"}` };
    if (i === 29) return { status: "processing", id: publishId, message: "still processing after timeout — check TikTok inbox" };
  }
  return { status: "processing", id: publishId };
}

/* ─── G1: TikTok analytics ingestion ───────────────────────────────────────
   Fetch per-video stats via the Display API video/query endpoint. The publish
   flow returns a `publish_id` (not the posted video id); to read stats the
   caller must supply the actual video id (resolvable via video/list once the
   post is public). Token-gated and tolerant: missing token / id → skipped,
   never throws. Reuses the same RawPlatformMetrics shape as instagram.ts. */
export async function fetchTikTokAnalytics(videoId: string): Promise<RawPlatformMetrics> {
  const base: RawPlatformMetrics = { ok: false, platform: "tiktok", postId: videoId };
  if (!videoId) return { ...base, skipped: true, reason: "no video id (publish returns publish_id, not video id)" };
  const token = process.env.TIKTOK_ACCESS_TOKEN;
  if (!token) return { ...base, skipped: true, reason: "TIKTOK_ACCESS_TOKEN not set" };

  const fields = "id,view_count,like_count,comment_count,share_count,duration";
  const body = JSON.stringify({ filters: { video_ids: [videoId] } });
  const res = asJson(
    httpCurl([
      "-X", "POST", `${API}/video/query/?fields=${fields}`,
      "-H", `Authorization: Bearer ${token}`,
      "-H", "Content-Type: application/json; charset=UTF-8",
      "-d", body,
    ]),
  );

  const errMsg = String(res?.error?.message ?? res?.error?.code ?? "");
  if (errMsg && String(res?.error?.code ?? "").toLowerCase() !== "ok") {
    if (isTokenError(errMsg, res?.error?.code)) return { ...base, skipped: true, reason: `re-auth needed: ${errMsg}` };
    if (isTransient(errMsg)) return { ...base, skipped: true, reason: `transient: ${errMsg}` };
  }

  const v = (res?.data?.videos ?? [])[0] as Record<string, number> | undefined;
  if (!v) return { ...base, skipped: true, reason: "no video data (id may not be public / scope video.list required)" };

  return {
    ok: true,
    platform: "tiktok",
    postId: videoId,
    views: typeof v.view_count === "number" ? v.view_count : undefined,
    likes: typeof v.like_count === "number" ? v.like_count : undefined,
    comments: typeof v.comment_count === "number" ? v.comment_count : undefined,
    shares: typeof v.share_count === "number" ? v.share_count : undefined,
    raw: v,
  };
}
