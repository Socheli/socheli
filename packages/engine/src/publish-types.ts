import type { ContentItem } from "@os/schemas";

/* Shared by every platform client so publisher.ts can orchestrate them without
   a circular import. Mirrors what publishYouTube already returns. */
export type PublishResult = {
  status: "published" | "processing" | "needs-auth" | "error";
  url?: string;
  id?: string;
  message?: string;
};

/* ---- AIGC / disclosure compliance --------------------------------------- *
   TikTok (and increasingly Meta) require AI-generated content to be disclosed.
   Everything Socheli renders is AI-generated, so disclosure defaults ON. Pass
   { aigc: false } only for content you can attest is NOT AI-generated. */
export type PublishOpts = {
  public?: boolean;
  /** Declare the post as AI-generated content. Defaults to true (everything
      this pipeline produces is AI-generated). */
  aigc?: boolean;
};

/* ---- P3: per-platform packaging overrides ------------------------------- *
   Non-destructive editor overrides on top of the generated packaging. Stored on
   item.pkg.overrides[platform]; any unset field falls back to the per-platform
   variant, then the base package. */
export type PackagingOverride = {
  caption?: string;
  title?: string;
  hashtags?: string[];
  /** P6: which aspect derivative this platform should publish. */
  aspect?: "9:16" | "1:1" | "16:9";
  /** G6: post the hashtags as the first comment instead of inline in caption. */
  firstCommentHashtags?: boolean;
};

/* Read the override block for a platform (safe on partially-typed items). */
export function overrideFor(item: ContentItem, platform: string): PackagingOverride | undefined {
  const ov = (item.pkg as { overrides?: Record<string, PackagingOverride> } | undefined)?.overrides;
  return ov?.[platform];
}

/* The effective hashtags for a platform: override → per-platform variant → base. */
export function hashtagsFor(item: ContentItem, platform: string): string[] {
  const o = overrideFor(item, platform);
  if (o?.hashtags?.length) return o.hashtags;
  const pkg = item.pkg;
  const p = pkg?.platforms?.find((x) => x.platform === platform);
  return p?.hashtags ?? pkg?.hashtags ?? [];
}

/* The effective title for a platform: override → per-platform variant → base. */
export function titleFor(item: ContentItem, platform: string): string {
  const o = overrideFor(item, platform);
  const pkg = item.pkg;
  const p = pkg?.platforms?.find((x) => x.platform === platform);
  return o?.title ?? p?.title ?? pkg?.title ?? item.idea?.topic ?? "Untitled";
}

/* P6: resolve the file a platform should upload, honoring its aspect override and
   falling back to the 9:16 master when the requested derivative isn't rendered. */
export function videoPathFor(item: ContentItem, platform: string): string | undefined {
  const aspect = overrideFor(item, platform)?.aspect;
  if (aspect === "1:1" && item.derivatives?.square) return item.derivatives.square;
  if (aspect === "16:9" && item.derivatives?.wide) return item.derivatives.wide;
  return item.videoPath;
}

/* All Socheli output is synthetic, so the safe default is "this is AIGC". */
export function isAigc(opts: { aigc?: boolean } = {}): boolean {
  return opts.aigc !== false;
}

/* Hard compliance gate. Throw before any network call if a platform that
   mandates AIGC disclosure would be sent undisclosed AI content. Callers wrap
   this and convert the throw into a PublishResult error so the bundle still
   runs. */
export function assertDisclosure(item: ContentItem, opts: { aigc?: boolean } = {}): void {
  // Heuristic: a Socheli item is AI-generated unless the caller explicitly
  // opts out. If someone opts a synthetic item out of disclosure, refuse.
  if (opts.aigc === false) {
    throw new Error(
      "AIGC disclosure is required: this content is AI-generated and must be disclosed per TikTok's content policy. Remove the aigc:false override to publish.",
    );
  }
}

/* ---- reliability: backoff, retry, polling, token detection -------------- */
export const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

/* Exponential backoff with full jitter, capped. */
export function backoffMs(attempt: number, base = 1000, cap = 30_000): number {
  const exp = Math.min(cap, base * 2 ** attempt);
  return Math.round(Math.random() * exp);
}

/* Network/transport blips and platform 5xx / rate-limit responses are worth a
   retry; auth and validation errors are not. */
export function isTransient(msg: string): boolean {
  return /\b(429|500|502|503|504)\b|rate.?limit|timeout|timed out|temporar|try again|ECONNRESET|ETIMEDOUT|EAI_AGAIN|connection reset|empty reply|could not resolve|socket/i.test(
    msg || "",
  );
}

/* Token-expiry / re-auth detection shared across platforms. */
export function isTokenError(msg: string, code?: number | string): boolean {
  if (code === 190) return true; // Meta OAuthException
  return /access[_ ]?token|token.*(expire|invalid|revoke)|expired.*token|unauthor|invalid[_ ]?grant|re-?auth|scope/i.test(
    msg || "",
  );
}

/* Retry an async op with exponential backoff, but only while the error looks
   transient. Returns the last value (success or final failure). `attempts` is
   the total number of tries. */
export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  shouldRetry: (result: T) => boolean,
  attempts = 3,
): Promise<T> {
  let last!: T;
  for (let i = 0; i < attempts; i++) {
    last = await fn(i);
    if (i === attempts - 1 || !shouldRetry(last)) return last;
    await sleep(backoffMs(i));
  }
  return last;
}

/* Pick the caption tailored to a platform, preferring a non-destructive editor
   override (P3) over the per-platform variant, over the generic package caption,
   then the topic. Hashtags appended inline for the single-box platforms (IG/
   TikTok) unless the override asks for them as a first comment (G6) — in which
   case use firstCommentFor() to fetch that text separately. */
export function captionFor(item: ContentItem, platform: string): string {
  const pkg = item.pkg;
  const o = overrideFor(item, platform);
  const p = pkg?.platforms?.find((x) => x.platform === platform);
  const body = o?.caption ?? p?.caption ?? pkg?.caption ?? pkg?.title ?? item.idea?.topic ?? "";
  const tags = o?.firstCommentHashtags ? "" : hashtagsFor(item, platform).map((h) => `#${h}`).join(" ");
  return `${body}${tags ? `\n\n${tags}` : ""}`.trim().slice(0, 2200);
}

/* G6: when a platform opts into first-comment hashtags, this returns the comment
   text to post after the upload; otherwise undefined (hashtags stay in caption). */
export function firstCommentFor(item: ContentItem, platform: string): string | undefined {
  if (!overrideFor(item, platform)?.firstCommentHashtags) return undefined;
  const tags = hashtagsFor(item, platform).map((h) => `#${h}`).join(" ");
  return tags || undefined;
}
