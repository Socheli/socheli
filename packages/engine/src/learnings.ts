import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR, ensureDir, nowIso } from "./store.ts";
import type { ContentItem } from "@os/schemas";
import { fetchInstagramAnalytics, type RawPlatformMetrics } from "./instagram.ts";
import { fetchTikTokAnalytics } from "./tiktok.ts";

/* Persistent performance memory — the learning loop. Analytics feed wins/avoids
   here; ideation reads them so the system learns what works over time. */
const FILE = join(DATA_DIR, "learnings.json");

export type Learnings = Record<
  string,
  { wins: string[]; avoid: string[]; samples: number; updatedAt: string }
>;

function load(): Learnings {
  if (!existsSync(FILE)) return {};
  try {
    return JSON.parse(readFileSync(FILE, "utf8")) as Learnings;
  } catch {
    return {};
  }
}
function save(l: Learnings) {
  ensureDir(DATA_DIR);
  writeFileSync(FILE, JSON.stringify(l, null, 2));
}

const ch = (l: Learnings, c: string) => (l[c] ??= { wins: [], avoid: [], samples: 0, updatedAt: nowIso() });
const dedupePush = (arr: string[], v: string, cap = 12) => {
  if (!arr.includes(v)) arr.unshift(v);
  return arr.slice(0, cap);
};

export function recordWin(channel: string, note: string) {
  const l = load();
  const c = ch(l, channel);
  c.wins = dedupePush(c.wins, note);
  c.samples++;
  c.updatedAt = nowIso();
  save(l);
}
export function recordAvoid(channel: string, note: string) {
  const l = load();
  const c = ch(l, channel);
  c.avoid = dedupePush(c.avoid, note);
  c.updatedAt = nowIso();
  save(l);
}

/* Turn analytics into learnings: strong retention/views → win, weak → avoid. */
export function recordPerformance(
  channel: string,
  perf: { hook: string; format: string; topic: string; retention?: number; views?: number },
) {
  const strong = (perf.retention ?? 0) >= 0.55 || (perf.views ?? 0) >= 10000;
  const weak = (perf.retention ?? 1) < 0.3;
  if (strong) {
    recordWin(channel, `format "${perf.format}" + hook style "${perf.hook}" performed well`);
    recordWin(channel, `topic angle "${perf.topic}" resonated`);
  } else if (weak) {
    recordAvoid(channel, `hook "${perf.hook}" underperformed (low retention)`);
  }
}

/* ─── G1: analytics ingestion + unified normalizer + store ─────────────────
   Pull per-post metrics from the platform APIs, normalize into one shape, and
   persist a snapshot under the engine data dir (data/analytics/<id>.json).
   Everything is token-gated: missing tokens / ids simply skip. The summary
   signals are then fed into the learning loop above so the brain learns what
   works. Additive + non-breaking — nothing calls this until wired. */
const ANALYTICS_DIR = join(DATA_DIR, "analytics");

/* One normalized metrics record per platform, plus a derived engagement
   rate + a 0..100 score so the dashboard and learnings can rank uniformly. */
export type NormalizedMetrics = {
  platform: "instagram" | "tiktok";
  postId: string;
  views: number;
  likes: number;
  comments: number;
  shares: number;
  saves: number;
  reach: number;
  retention?: number;
  /** (likes+comments+shares+saves)/views, 0..1. */
  engagementRate: number;
  /** Composite 0..100 score (engagement-weighted, retention-boosted). */
  score: number;
};

/* The persisted snapshot tying an item's identity/creative to its metrics, so
   the scorecard can roll up by channel + format + hook without re-loading runs. */
export type AnalyticsSnapshot = {
  id: string;
  channel: string;
  topic: string;
  format: string;
  hook: string;
  fetchedAt: string;
  metrics: NormalizedMetrics[];
};

/* Map a raw platform payload onto the unified shape. Missing fields → 0. */
export function normalizeMetrics(raw: RawPlatformMetrics): NormalizedMetrics {
  const views = raw.views ?? 0;
  const likes = raw.likes ?? 0;
  const comments = raw.comments ?? 0;
  const shares = raw.shares ?? 0;
  const saves = raw.saves ?? 0;
  const reach = raw.reach ?? 0;
  const interactions = likes + comments + shares + saves;
  const engagementRate = views > 0 ? interactions / views : 0;
  // Composite: engagement rate is the backbone; retention boosts; shares/saves
  // weigh heavier (stronger intent). Capped to 0..100.
  const weighted = views > 0 ? (likes + comments + 2 * shares + 2 * saves) / views : 0;
  const base = Math.min(1, weighted * 8); // ~12.5% weighted engagement → full marks
  const retentionBoost = raw.retention !== undefined ? Math.min(1, raw.retention / 0.6) : base;
  const score = Math.round(Math.min(100, (base * 0.7 + retentionBoost * 0.3) * 100));
  return { platform: raw.platform, postId: raw.postId, views, likes, comments, shares, saves, reach, retention: raw.retention, engagementRate: Number(engagementRate.toFixed(4)), score };
}

function snapshotPath(id: string) {
  return join(ANALYTICS_DIR, `${id}.json`);
}

export function loadAnalytics(id: string): AnalyticsSnapshot | null {
  const p = snapshotPath(id);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as AnalyticsSnapshot;
  } catch {
    return null;
  }
}

export function listAnalytics(): AnalyticsSnapshot[] {
  ensureDir(ANALYTICS_DIR);
  return readdirSync(ANALYTICS_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      try {
        return JSON.parse(readFileSync(join(ANALYTICS_DIR, f), "utf8")) as AnalyticsSnapshot;
      } catch {
        return null;
      }
    })
    .filter((x): x is AnalyticsSnapshot => !!x);
}

function saveAnalytics(snap: AnalyticsSnapshot) {
  ensureDir(ANALYTICS_DIR);
  writeFileSync(snapshotPath(snap.id), JSON.stringify(snap, null, 2));
}

/* Pick the platform post ids from an item's publish[] records. IG uses the
   media id; TikTok stores a publish_id which is NOT queryable for stats — only
   use it if it looks like a real video id (callers can override later). */
function publishIds(item: ContentItem): { instagram?: string; tiktok?: string } {
  const out: { instagram?: string; tiktok?: string } = {};
  for (const p of item.publish ?? []) {
    if (p.status !== "published" || !p.id) continue;
    if (p.platform === "instagram" && !out.instagram) out.instagram = p.id;
    if (p.platform === "tiktok" && !out.tiktok) out.tiktok = p.id;
  }
  return out;
}

/* G1 entry point: fetch + normalize + store analytics for a published item,
   then feed the strongest platform's summary into the learning loop. Returns
   the snapshot (or null if nothing could be fetched). Never throws. */
export async function ingestAnalytics(item: ContentItem): Promise<AnalyticsSnapshot | null> {
  const ids = publishIds(item);
  const raw: RawPlatformMetrics[] = [];
  try {
    if (ids.instagram) raw.push(await fetchInstagramAnalytics(ids.instagram, item.channel));
  } catch { /* ignore — token/network gated */ }
  try {
    if (ids.tiktok) raw.push(await fetchTikTokAnalytics(ids.tiktok));
  } catch { /* ignore */ }

  const metrics = raw.filter((r) => r.ok).map(normalizeMetrics);
  if (!metrics.length) return null;

  const snap: AnalyticsSnapshot = {
    id: item.id,
    channel: item.channel,
    topic: item.idea?.topic ?? item.seedIdea ?? "",
    format: item.idea?.format ?? "unknown",
    hook: item.script?.hook ?? item.pkg?.title ?? "",
    fetchedAt: nowIso(),
    metrics,
  };
  saveAnalytics(snap);

  // Feed the best-performing platform's summary into the brain's learnings.
  const best = metrics.reduce((a, b) => (b.score > a.score ? b : a));
  recordPerformance(item.channel, {
    hook: snap.hook,
    format: snap.format,
    topic: snap.topic,
    retention: best.retention,
    views: best.views,
  });
  return snap;
}

/* ─── G5: per-channel scorecard ────────────────────────────────────────────
   Roll up stored analytics into a dashboard-readable summary: average score,
   best/worst format, totals, and posting cadence (avg days between posts).
   Pure read over the analytics dir — no network. */
export type ChannelScorecard = {
  channel: string;
  posts: number;
  avgScore: number;
  totalViews: number;
  avgEngagementRate: number;
  bestFormat?: { format: string; avgScore: number; samples: number };
  worstFormat?: { format: string; avgScore: number; samples: number };
  topPost?: { id: string; topic: string; score: number };
  /** Average days between posts (cadence), or undefined with <2 posts. */
  cadenceDays?: number;
  updatedAt: string;
};

/* Collapse a snapshot's per-platform metrics into one representative row:
   max score (best surface) + summed views + averaged engagement. */
function rollupSnapshot(s: AnalyticsSnapshot) {
  const score = s.metrics.reduce((m, x) => Math.max(m, x.score), 0);
  const views = s.metrics.reduce((m, x) => m + x.views, 0);
  const eng = s.metrics.length ? s.metrics.reduce((m, x) => m + x.engagementRate, 0) / s.metrics.length : 0;
  return { score, views, eng };
}

export function channelScorecard(channel: string): ChannelScorecard {
  const snaps = listAnalytics().filter((s) => s.channel === channel);
  const empty: ChannelScorecard = { channel, posts: 0, avgScore: 0, totalViews: 0, avgEngagementRate: 0, updatedAt: nowIso() };
  if (!snaps.length) return empty;

  let scoreSum = 0;
  let viewSum = 0;
  let engSum = 0;
  let topPost: ChannelScorecard["topPost"];
  const byFormat = new Map<string, { sum: number; n: number }>();

  for (const s of snaps) {
    const { score, views, eng } = rollupSnapshot(s);
    scoreSum += score;
    viewSum += views;
    engSum += eng;
    if (!topPost || score > topPost.score) topPost = { id: s.id, topic: s.topic, score };
    const f = byFormat.get(s.format) ?? { sum: 0, n: 0 };
    f.sum += score;
    f.n += 1;
    byFormat.set(s.format, f);
  }

  const formats = [...byFormat.entries()]
    .map(([format, { sum, n }]) => ({ format, avgScore: Math.round(sum / n), samples: n }))
    .sort((a, b) => b.avgScore - a.avgScore);

  // cadence: avg gap in days between fetched snapshots (proxy for posting rhythm)
  const times = snaps.map((s) => Date.parse(s.fetchedAt)).filter((t) => !Number.isNaN(t)).sort((a, b) => a - b);
  let cadenceDays: number | undefined;
  if (times.length >= 2) {
    const span = times[times.length - 1] - times[0];
    cadenceDays = Number((span / (times.length - 1) / 86_400_000).toFixed(2));
  }

  return {
    channel,
    posts: snaps.length,
    avgScore: Math.round(scoreSum / snaps.length),
    totalViews: viewSum,
    avgEngagementRate: Number((engSum / snaps.length).toFixed(4)),
    bestFormat: formats[0],
    worstFormat: formats.length > 1 ? formats[formats.length - 1] : undefined,
    topPost,
    cadenceDays,
    updatedAt: nowIso(),
  };
}

/* All channels that have any stored analytics, scored — for the dashboard grid. */
export function allScorecards(): ChannelScorecard[] {
  const channels = [...new Set(listAnalytics().map((s) => s.channel))];
  return channels.map(channelScorecard).sort((a, b) => b.avgScore - a.avgScore);
}

/* Summary fed into the ideation prompt. */
export function getLearnings(channel: string): string {
  const c = load()[channel];
  if (!c || (!c.wins.length && !c.avoid.length)) return "";
  const parts: string[] = [];
  if (c.wins.length) parts.push(`WHAT WORKS (lean in): ${c.wins.slice(0, 6).join("; ")}`);
  if (c.avoid.length) parts.push(`WHAT FLOPS (avoid): ${c.avoid.slice(0, 6).join("; ")}`);
  return parts.join("\n");
}
