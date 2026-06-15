import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Reads Socheli's local data store directly. The phone-agent runs on the same
 * Mac that renders, so the runs JSON is right there — no API, no token, no
 * network. We mirror the engine's publish-types resolution (per-platform
 * caption / title / preferred-aspect file) so what the phone posts matches what
 * the API path would have posted.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
// tools/phone-agent/src → repo root is three levels up.
const REPO_ROOT = process.env.SOCHELI_ROOT || join(__dirname, '..', '..', '..');
export const DATA_DIR = join(REPO_ROOT, 'data');
const RUNS_DIR = join(DATA_DIR, 'runs');

function itemPath(id) {
  return join(RUNS_DIR, `${id}.json`);
}

export function loadItem(id) {
  return JSON.parse(readFileSync(itemPath(id), 'utf8'));
}

export function saveItem(item) {
  item.updatedAt = new Date().toISOString();
  writeFileSync(itemPath(item.id), JSON.stringify(item, null, 2));
}

export function listItems() {
  if (!existsSync(RUNS_DIR)) return [];
  return readdirSync(RUNS_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      try {
        return JSON.parse(readFileSync(join(RUNS_DIR, f), 'utf8'));
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

// ── per-platform packaging resolution (mirror of publish-types.ts) ───────────

function overrideFor(item, platform) {
  return item?.pkg?.overrides?.[platform];
}

// IG only links the first ~5 hashtags in a caption; extras render as dead plain
// text. Other platforms tolerate more. Cap per platform so captions stay clean.
const HASHTAG_CAP = { instagram: 5, tiktok: 8, youtube: 12 };

// A hashtag must be a single token: strip the leading '#', drop spaces and
// punctuation (keep letters/digits/underscore across scripts). "mental clarity"
// → "mentalclarity" so it actually links instead of breaking after "#mental".
function cleanTag(h) {
  return String(h).replace(/^#+/, '').replace(/[^\p{L}\p{N}_]/gu, '');
}

export function hashtagsFor(item, platform) {
  const o = overrideFor(item, platform);
  const raw = o?.hashtags?.length
    ? o.hashtags
    : item?.pkg?.platforms?.find((x) => x.platform === platform)?.hashtags ??
      item?.pkg?.hashtags ??
      [];
  const seen = new Set();
  const clean = [];
  for (const t of raw) {
    const c = cleanTag(t);
    if (c && !seen.has(c.toLowerCase())) {
      seen.add(c.toLowerCase());
      clean.push(c);
    }
  }
  return clean.slice(0, HASHTAG_CAP[platform] ?? clean.length);
}

/** The designed cover/thumbnail to apply on the post, or null if missing. */
export function coverFor(item) {
  const c = item?.thumbPath;
  return c && existsSync(c) ? c : null;
}

export function titleFor(item, platform) {
  const o = overrideFor(item, platform);
  const p = item?.pkg?.platforms?.find((x) => x.platform === platform);
  return o?.title ?? p?.title ?? item?.pkg?.title ?? item?.idea?.topic ?? 'Untitled';
}

export function captionFor(item, platform) {
  const o = overrideFor(item, platform);
  const p = item?.pkg?.platforms?.find((x) => x.platform === platform);
  const body = o?.caption ?? p?.caption ?? item?.pkg?.caption ?? item?.pkg?.title ?? item?.idea?.topic ?? '';
  const tags = o?.firstCommentHashtags
    ? ''
    : hashtagsFor(item, platform).map((h) => `#${h}`).join(' ');
  return `${body}${tags ? `\n\n${tags}` : ''}`.trim().slice(0, 2200);
}

/** Preferred-aspect file for a platform, falling back to the 9:16 master. */
export function videoPathFor(item, platform) {
  const aspect = overrideFor(item, platform)?.aspect;
  if (aspect === '1:1' && item?.derivatives?.square) return item.derivatives.square;
  if (aspect === '16:9' && item?.derivatives?.wide) return item.derivatives.wide;
  return item?.videoPath;
}

/** For kind="static_image": the rendered PNG/JPG path, or null. */
export function staticImagePathFor(item) {
  const p = item?.staticImagePath;
  return p && existsSync(p) ? p : null;
}

/**
 * For kind="carousel": array of per-slide rendered PNG paths that exist on disk.
 * Returns null if there are no slides or none exist.
 */
export function carouselSlidesFor(item) {
  const slides = item?.carouselSlides;
  if (!Array.isArray(slides) || slides.length === 0) return null;
  const existing = slides.filter((p) => existsSync(p));
  return existing.length > 0 ? existing : null;
}

// ── selection: what's ready for the phone to post ────────────────────────────

/** True if `platform` already went live for this item. */
export function alreadyPublished(item, platform) {
  return (item.publish ?? []).some(
    (e) => e.platform === platform && (e.status === 'published' || e.status === 'processing'),
  );
}

/**
 * Items the phone should post: packaged, with ready content, that still have at
 * least one un-published target platform. A platform is a candidate when the
 * publish ledger has no live entry for it (a "ready"/bundle entry is fine — that
 * is exactly what the phone is here to finish).
 *
 * Content-kind rules:
 *   short     — needs item.videoPath (vertical 9:16 clip)
 *   longform  — excluded (not phone-postable as a Reel/Short)
 *   static_image — needs item.staticImagePath; only instagram is valid
 *   carousel  — needs item.carouselSlides array; only instagram is valid
 */
export function readyToPost(platforms = ['instagram', 'tiktok', 'youtube']) {
  const out = [];
  for (const item of listItems()) {
    if (item.status !== 'packaged') continue;
    // Long-form (16:9 multi-chapter YouTube videos) must NEVER be offered here.
    if (item.kind === 'longform') continue;

    if (item.kind === 'static_image') {
      // Only Instagram; must have a rendered image on disk.
      if (!item.staticImagePath || !existsSync(item.staticImagePath)) continue;
      const targets = platforms
        .filter((p) => p === 'instagram')
        .filter((p) => !alreadyPublished(item, p));
      if (targets.length) out.push({ item, targets });
      continue;
    }

    if (item.kind === 'carousel') {
      // Only Instagram; must have at least one rendered slide on disk.
      const slides = Array.isArray(item.carouselSlides) ? item.carouselSlides.filter(existsSync) : [];
      if (slides.length === 0) continue;
      const targets = platforms
        .filter((p) => p === 'instagram')
        .filter((p) => !alreadyPublished(item, p));
      if (targets.length) out.push({ item, targets });
      continue;
    }

    // Default: video (short and any future kinds without special handling).
    if (!item.videoPath || !existsSync(item.videoPath)) continue;
    const targets = platforms.filter((p) => !alreadyPublished(item, p));
    if (targets.length) out.push({ item, targets });
  }
  return out;
}

/** Record a phone-posted platform onto the item's publish ledger. */
export function markPosted(item, platform, { url, id } = {}) {
  item.publish = item.publish ?? [];
  // drop any prior non-live ("ready"/"error") entry for this platform
  item.publish = item.publish.filter(
    (e) => !(e.platform === platform && e.status !== 'published' && e.status !== 'processing'),
  );
  item.publish.push({
    platform,
    id,
    url,
    at: new Date().toISOString(),
    status: 'published',
    via: 'phone',
  });
  saveItem(item);
}

/**
 * Record that an item was saved as a draft on a platform (on a specific device).
 * Idempotent per (platform, device): re-drafting refreshes the timestamp rather
 * than stacking entries. Never overrides a live "published"/"processing" entry.
 */
export function markDrafted(item, platform, { device } = {}) {
  item.publish = item.publish ?? [];
  if (item.publish.some((e) => e.platform === platform && (e.status === 'published' || e.status === 'processing')))
    return item; // already live somewhere — don't downgrade to draft
  item.publish = item.publish.filter((e) => !(e.platform === platform && e.status === 'draft' && e.device === device));
  item.publish.push({
    platform,
    at: new Date().toISOString(),
    status: 'draft',
    via: 'phone',
    device,
  });
  saveItem(item);
  return item;
}

/** Items the DB believes are drafted on a platform (optionally on one device). */
export function draftedItems(platform = 'instagram', device) {
  return listItems().filter((it) =>
    (it.publish ?? []).some(
      (e) => e.platform === platform && e.status === 'draft' && (!device || e.device === device),
    ),
  );
}
