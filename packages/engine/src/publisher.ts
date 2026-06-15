import { existsSync, statSync, copyFileSync, writeFileSync } from "node:fs";
import { join, basename } from "node:path";
import type { ContentItem } from "@os/schemas";
import { recordPerformance } from "./learnings.ts";
import { DATA_DIR, ensureDir, nowIso } from "./store.ts";
import { autoSyncAfter } from "./sync.ts";
import { httpCurl, proxyReachable } from "./http.ts";
import { hostConfigured } from "./host.ts";
import { publishInstagram } from "./instagram.ts";
import { resolveIgCreds } from "./connections.ts";
import { isSendingHalted } from "./admin.ts";
import { publishTikTok } from "./tiktok.ts";
import { phoneHandles, phoneDeviceReady, publishViaPhone, phonePublishEnabled, phonePlatforms } from "./phone.ts";
import {
  type PublishResult,
  type PublishOpts,
  isTokenError,
  isTransient,
  withRetry,
  titleFor,
  captionFor,
  hashtagsFor,
  videoPathFor,
  firstCommentFor,
} from "./publish-types.ts";

/* YouTube publishing + analytics. Google may be geo-blocked from the render device
   (→ needs the SOCKS5 tunnel) but reachable DIRECTLY from the server where publishing
   actually runs. So route through the proxy ONLY when it's actually reachable;
   otherwise go direct. Auto-adapts to wherever this runs. */
const GOOGLE_VIA_PROXY = proxyReachable();
const curl = (args: string[]) => httpCurl(args, { proxy: GOOGLE_VIA_PROXY });

export type { PublishResult };

function accessToken(): string | null {
  const { YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET, YOUTUBE_REFRESH_TOKEN } = process.env;
  if (!YOUTUBE_CLIENT_ID || !YOUTUBE_CLIENT_SECRET || !YOUTUBE_REFRESH_TOKEN) return null;
  const r = curl([
    "-X", "POST", "https://oauth2.googleapis.com/token",
    "-d", `client_id=${YOUTUBE_CLIENT_ID}`,
    "-d", `client_secret=${YOUTUBE_CLIENT_SECRET}`,
    "-d", `refresh_token=${YOUTUBE_REFRESH_TOKEN}`,
    "-d", "grant_type=refresh_token",
  ]);
  try {
    return (JSON.parse(r.stdout) as { access_token?: string }).access_token ?? null;
  } catch {
    return null;
  }
}

/* Upload a finished item to YouTube as a Short (resumable upload via the tunnel).
   Async so the resumable byte-upload can be retried with exponential backoff on
   transient (5xx / network) failures; token problems surface as needs-auth. */
export async function publishYouTube(item: ContentItem, privacy = "private"): Promise<PublishResult> {
  // P6: publish YouTube's preferred-aspect derivative when one is selected and
  // rendered; otherwise fall back to the 9:16 master.
  const videoPath = videoPathFor(item, "youtube");
  if (!videoPath || !existsSync(videoPath)) return { status: "error", message: "no rendered video" };
  const token = accessToken();
  if (!token)
    return {
      status: "needs-auth",
      message:
        "Set YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET, YOUTUBE_REFRESH_TOKEN in .env. " +
        "Create an OAuth Desktop client in Google Cloud (YouTube Data API v3 enabled), then do the one-time consent to get a refresh token.",
    };
  // P3: prefer per-platform overrides over the generated packaging.
  const title = titleFor(item, "youtube").slice(0, 95);
  const hashtags = hashtagsFor(item, "youtube");
  // captionFor already drops inline hashtags when first-comment is on (G6); the
  // tag list still rides along in snippet.tags for search regardless.
  const description = `${captionFor(item, "youtube")} #Shorts`.slice(0, 4900);
  const meta = JSON.stringify({ snippet: { title, description, tags: hashtags, categoryId: "28" }, status: { privacyStatus: privacy, selfDeclaredMadeForKids: false } });
  const size = statSync(videoPath).size;

  // step 1: open a resumable session, capture the upload URL from the Location header
  const init = curl([
    "-D", "-", "-o", "/dev/null",
    "-X", "POST", "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status",
    "-H", `Authorization: Bearer ${token}`,
    "-H", "Content-Type: application/json; charset=UTF-8",
    "-H", "X-Upload-Content-Type: video/mp4",
    "-H", `X-Upload-Content-Length: ${size}`,
    "-d", meta,
  ]);
  const loc = /location:\s*(\S+)/i.exec(init.stdout)?.[1];
  if (!loc) {
    const snippet = init.stdout.slice(0, 400);
    if (isTokenError(snippet)) return { status: "needs-auth", message: `YouTube re-auth needed (token expired/invalid): ${snippet.slice(0, 200)}` };
    return { status: "error", message: `no upload session (${snippet.slice(0, 200)})` };
  }

  // step 2: upload the bytes (resumable) — retry transient failures with backoff
  const up = await withRetry(
    async () => curl(["-X", "PUT", loc.trim(), "-H", "Content-Type: video/mp4", "--data-binary", `@${videoPath}`]),
    (r) => {
      try {
        return !(JSON.parse(r.stdout) as { id?: string }).id && isTransient(r.stdout);
      } catch {
        return isTransient(r.stdout);
      }
    },
  );
  try {
    const j = JSON.parse(up.stdout) as { id?: string; error?: { message?: string; code?: number } };
    if (j.id) return { status: "published", id: j.id, url: `https://youtube.com/shorts/${j.id}` };
    const msg = j.error?.message ?? up.stdout.slice(0, 200);
    if (isTokenError(msg, j.error?.code)) return { status: "needs-auth", message: `YouTube re-auth needed (token expired/invalid): ${msg}` };
    return { status: "error", message: msg };
  } catch {
    return { status: "error", message: up.stdout.slice(0, 200) };
  }
}

/* Instagram Reels / TikTok have no clean upload API without a publicly hosted
   video URL (and an approved app). Until there's a host, we produce a ready-to-post
   bundle: the right files + a caption you can paste. Honest and actually useful. */
export function exportBundle(item: ContentItem): string {
  const dir = join(DATA_DIR, "exports", item.id);
  ensureDir(dir);
  const copy = (src?: string, as?: string) => {
    if (src && existsSync(src)) {
      const dest = join(dir, as ?? basename(src));
      copyFileSync(src, dest);
      return basename(dest);
    }
    return undefined;
  };
  const vertical = copy(item.videoPath, "vertical_9x16.mp4");
  const square = copy(item.derivatives?.square, "square_1x1.mp4");
  const wide = copy(item.derivatives?.wide, "wide_16x9.mp4");
  const thumb = copy(item.thumbPath, "cover.jpg");

  const pkg = item.pkg;
  const tags = (pkg?.hashtags ?? []).map((h) => `#${h}`).join(" ");
  const caption = `${pkg?.title ?? item.idea?.topic ?? ""}\n\n${pkg?.caption ?? ""}\n\n${tags}`.trim();
  writeFileSync(join(dir, "caption.txt"), caption + "\n");
  // per-platform, copy-paste-ready captions — honoring P3 overrides + G6 first-
  // comment hashtags so the bundle matches what the live publish would post.
  const bundlePlatforms = new Set<string>([
    ...(pkg?.platforms ?? []).map((p) => p.platform),
    ...Object.keys((pkg as { overrides?: Record<string, unknown> } | undefined)?.overrides ?? {}),
  ]);
  for (const platform of bundlePlatforms) {
    const p = pkg?.platforms?.find((x) => x.platform === platform);
    const kw = p?.keywords?.length ? `\n\nKeywords: ${p.keywords.join(", ")}` : "";
    const t = titleFor(item, platform);
    const body = `${t ? t + "\n\n" : ""}${captionFor(item, platform)}${kw}`.trim();
    writeFileSync(join(dir, `caption_${platform}.txt`), body + "\n");
    const fc = firstCommentFor(item, platform);
    if (fc) writeFileSync(join(dir, `firstcomment_${platform}.txt`), fc + "\n");
  }
  writeFileSync(
    join(dir, "POST.md"),
    `# ${pkg?.title ?? item.idea?.topic ?? item.id}\n\n` +
      `${item.channel} · QA ${item.qa?.overall ?? "?"}/10\n\n` +
      `## Caption\n\n${caption}\n\n## Files\n` +
      [
        vertical && `- **${vertical}** → YouTube Shorts · Instagram Reels · TikTok`,
        square && `- ${square} → Instagram feed`,
        wide && `- ${wide} → YouTube (landscape)`,
        thumb && `- ${thumb} → cover / thumbnail`,
      ]
        .filter(Boolean)
        .join("\n") +
      `\n\n## Alt text\n\n${pkg?.altText ?? ""}\n`,
  );
  return dir;
}

export type PlatformResult = { platform: string; status: string; url?: string; id?: string; message?: string; firstComment?: string };

/* P6: run a platform publisher against its preferred-aspect derivative without
   touching the platform clients. instagram.ts / tiktok.ts upload item.videoPath
   directly, so we temporarily point that at the chosen derivative (falling back
   to the 9:16 master) and restore it afterwards. Non-breaking: with no aspect
   override, videoPathFor returns item.videoPath and nothing changes. */
async function withPreferredAspect(
  item: ContentItem,
  platform: string,
  fn: () => Promise<PublishResult>,
): Promise<PublishResult> {
  const original = item.videoPath;
  const chosen = videoPathFor(item, platform);
  if (chosen && chosen !== original) item.videoPath = chosen;
  try {
    return await fn();
  } finally {
    item.videoPath = original;
  }
}

/* One call to push a finished item everywhere it can go:
   - YouTube: real API upload via the tunnel (private by default for review).
   - Instagram Reels + TikTok: real API publish when creds + a public host are
     configured (instagram.ts / tiktok.ts); otherwise they degrade to needs-auth.
   - Always also writes a paste-ready export bundle, and records a "ready" bundle
     entry for any platform that didn't go live — so nothing ever breaks.
   Async because IG/TikTok poll for transcode completion. Mutates item.publish;
   caller saves. */
export async function publishItem(item: ContentItem, opts: PublishOpts = {}): Promise<PlatformResult[]> {
  const halt = isSendingHalted(item.channel);
  if (halt.halted) return [{ platform: "all", status: "skipped", message: halt.reason ?? "publishing halted by admin" }];
  const results: PlatformResult[] = [];
  item.publish = item.publish ?? [];
  const already = (p: string) => item.publish!.some((e) => e.platform === p && e.status === "published");
  const record = (platform: string, r: PublishResult) => {
    // G6: when a platform opts into first-comment hashtags, surface the comment
    // text so the caller can post it after upload (kept out of the caption).
    const firstComment = r.status === "published" || r.status === "processing" ? firstCommentFor(item, platform) : undefined;
    results.push({ platform, status: r.status, url: r.url, id: r.id, message: r.message, firstComment });
    if (r.status === "published" || r.status === "processing")
      item.publish!.push({ platform, id: r.id, url: r.url, at: nowIso(), status: r.status });
  };

  // 1. live posting per platform (skip any already published). Each platform
  //    publishes its preferred-aspect derivative when selected (P6). When phone
  //    publishing is enabled for a platform (PHONE_PUBLISH=1), the rendered video
  //    is posted by driving the real app on a docked Android — no public host or
  //    App Review needed — instead of the Graph/Content-Posting API.
  if (already("youtube")) results.push({ platform: "youtube", status: "skipped", message: "already published" });
  else if (phoneHandles("youtube")) record("youtube", await withPreferredAspect(item, "youtube", () => publishViaPhone(item, "youtube")));
  else record("youtube", await publishYouTube(item, opts.public ? "public" : "private"));

  if (already("instagram")) results.push({ platform: "instagram", status: "skipped", message: "already published" });
  else if (phoneHandles("instagram")) record("instagram", await withPreferredAspect(item, "instagram", () => publishViaPhone(item, "instagram")));
  else record("instagram", await withPreferredAspect(item, "instagram", () => publishInstagram(item, { public: opts.public, aigc: opts.aigc })));

  if (already("tiktok")) results.push({ platform: "tiktok", status: "skipped", message: "already published" });
  else if (phoneHandles("tiktok")) record("tiktok", await withPreferredAspect(item, "tiktok", () => publishViaPhone(item, "tiktok")));
  else record("tiktok", await withPreferredAspect(item, "tiktok", () => publishTikTok(item, { public: opts.public, aigc: opts.aigc })));

  // 2. always produce the bundle, and mark any non-live platform as "ready" (paste-able)
  const dir = exportBundle(item);
  for (const p of ["instagram", "tiktok"]) {
    const live = item.publish.some((e) => e.platform === p && (e.status === "published" || e.status === "processing"));
    if (!live && !item.publish.some((e) => e.platform === p && e.status === "ready"))
      item.publish.push({ platform: p, url: dir, at: nowIso(), status: "ready" });
  }
  results.push({ platform: "bundle", status: "ready", url: dir });
  autoSyncAfter("publish"); // push updated publish ledger + bundle up to production
  return results;
}

/* Which platforms are wired for LIVE posting right now — for the dashboard
   "Connections" card. `host` gates the IG + TikTok API path; the phone backend
   (a docked Android driven over ADB) is an alternative that needs neither a host
   nor App Review, so a platform counts as live if EITHER path is ready. */
export function platformStatus(channel?: string): {
  youtube: boolean;
  instagram: boolean;
  tiktok: boolean;
  host: boolean;
  phone: { enabled: boolean; deviceReady: boolean; platforms: string[] };
} {
  const host = hostConfigured();
  const phone = { enabled: phonePublishEnabled(), deviceReady: phoneDeviceReady(), platforms: phonePublishEnabled() ? phonePlatforms() : [] };
  const viaPhone = (p: string) => phone.enabled && phone.deviceReady && phone.platforms.includes(p);
  return {
    youtube: !!(process.env.YOUTUBE_CLIENT_ID && process.env.YOUTUBE_CLIENT_SECRET && process.env.YOUTUBE_REFRESH_TOKEN) || viaPhone("youtube"),
    instagram: (!!resolveIgCreds(channel) && host) || viaPhone("instagram"),
    tiktok: (!!process.env.TIKTOK_ACCESS_TOKEN && host) || viaPhone("tiktok"),
    host,
    phone,
  };
}

/* Pull stats for published items and feed the learning loop. */
export function pullStats(item: ContentItem): { views?: number; likes?: number } | null {
  const yt = (item.publish ?? []).find((p) => p.platform === "youtube" && p.id);
  if (!yt?.id) return null;
  const token = accessToken();
  if (!token) return null;
  const r = curl(["https://www.googleapis.com/youtube/v3/videos?part=statistics&id=" + yt.id, "-H", `Authorization: Bearer ${token}`]);
  try {
    const s = (JSON.parse(r.stdout) as { items?: { statistics?: { viewCount?: string; likeCount?: string } }[] }).items?.[0]?.statistics;
    const views = s?.viewCount ? Number(s.viewCount) : undefined;
    if (item.idea) recordPerformance(item.channel, { hook: item.script?.hook ?? "", format: item.idea.format, topic: item.idea.topic, views });
    return { views, likes: s?.likeCount ? Number(s.likeCount) : undefined };
  } catch {
    return null;
  }
}
