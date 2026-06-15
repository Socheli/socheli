import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT, listItemsFor } from "../../../lib/data";
import { currentContext, assertCan, forbidden } from "../../../lib/tenancy";

/* Cross-platform analytics aggregator. Rolls up the caller's workspace runs
   (scoped via listItemsFor) plus any dedicated analytics snapshots
   (data/analytics/*.json) into a unified, platform-keyed view.

   Scoped + gated: reads only the caller's workspace items and requires
   `analytics.view`. Returns a graceful empty shape when no data exists yet — the
   page renders an empty state from `hasData: false`. */

export const dynamic = "force-dynamic";

const ANALYTICS_DIR = join(REPO_ROOT, "data", "analytics");

/* Optional richer per-post metrics, if a future pipeline writes them. */
type Metric = {
  itemId?: string;
  platform?: string;
  views?: number;
  likes?: number;
  comments?: number;
  shares?: number;
  reach?: number;
  watchTimeSec?: number;
  at?: string;
};

function readJsonDir<T>(dir: string): T[] {
  if (!existsSync(dir)) return [];
  const out: T[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    try {
      const parsed = JSON.parse(readFileSync(join(dir, f), "utf8"));
      if (Array.isArray(parsed)) out.push(...(parsed as T[]));
      else out.push(parsed as T);
    } catch {
      /* skip malformed */
    }
  }
  return out;
}

function num(n: unknown): number {
  return typeof n === "number" && Number.isFinite(n) ? n : 0;
}

export async function GET() {
  const ctx = await currentContext();
  try {
    assertCan(ctx, "analytics.view");
  } catch {
    return forbidden("analytics.view");
  }

  const runs = listItemsFor(ctx.workspaceId);
  const snapshots = readJsonDir<Metric>(ANALYTICS_DIR);

  // Index optional metrics by itemId+platform for enrichment.
  const metricKey = (id?: string, p?: string) => `${id ?? ""}::${p ?? ""}`;
  const metrics = new Map<string, Metric>();
  for (const m of snapshots) metrics.set(metricKey(m.itemId, m.platform), m);

  type PlatformAgg = {
    platform: string;
    posts: number;
    published: number;
    views: number;
    likes: number;
    comments: number;
    shares: number;
    reach: number;
  };
  const platforms = new Map<string, PlatformAgg>();
  const ensure = (p: string): PlatformAgg => {
    let a = platforms.get(p);
    if (!a) {
      a = { platform: p, posts: 0, published: 0, views: 0, likes: 0, comments: 0, shares: 0, reach: 0 };
      platforms.set(p, a);
    }
    return a;
  };

  type ChannelAgg = { channel: string; posts: number; passed: number; qad: number; cost: number; avgQa: number };
  const channels = new Map<string, ChannelAgg>();

  type PostRow = {
    id: string;
    title: string;
    channel: string;
    createdAt: string;
    qa: number | null;
    platforms: string[];
    views: number;
    engagement: number;
    cost: number;
  };
  const topPosts: PostRow[] = [];

  let totalPublishes = 0;
  let totalViews = 0;
  let totalEngagement = 0;
  let totalCost = 0;

  for (const r of runs) {
    // Channel rollup
    let ch = channels.get(r.channel);
    if (!ch) {
      ch = { channel: r.channel, posts: 0, passed: 0, qad: 0, cost: 0, avgQa: 0 };
      channels.set(r.channel, ch);
    }
    ch.posts += 1;
    ch.cost += num(r.ledger?.totalUsd);
    if (r.qa) {
      ch.qad += 1;
      ch.avgQa += num(r.qa.overall);
      if (r.qa.verdict === "pass") ch.passed += 1;
    }
    totalCost += num(r.ledger?.totalUsd);

    const pubs = Array.isArray(r.publish) ? r.publish : [];
    let postViews = 0;
    let postEng = 0;
    const postPlatforms: string[] = [];
    for (const pub of pubs) {
      const agg = ensure(pub.platform);
      agg.posts += 1;
      const live = pub.status === "published" || pub.status === "live" || pub.status === "ready";
      if (live) agg.published += 1;
      totalPublishes += 1;
      postPlatforms.push(pub.platform);

      const m = metrics.get(metricKey(r.id, pub.platform));
      if (m) {
        agg.views += num(m.views);
        agg.likes += num(m.likes);
        agg.comments += num(m.comments);
        agg.shares += num(m.shares);
        agg.reach += num(m.reach);
        postViews += num(m.views);
        postEng += num(m.likes) + num(m.comments) + num(m.shares);
      }
    }
    totalViews += postViews;
    totalEngagement += postEng;

    if (pubs.length) {
      topPosts.push({
        id: r.id,
        title: r.pkg?.title ?? r.idea?.topic ?? r.seedIdea ?? r.id,
        channel: r.channel,
        createdAt: r.createdAt,
        qa: r.qa ? num(r.qa.overall) : null,
        platforms: postPlatforms,
        views: postViews,
        engagement: postEng,
        cost: num(r.ledger?.totalUsd),
      });
    }
  }

  for (const ch of channels.values()) ch.avgQa = ch.qad ? ch.avgQa / ch.qad : 0;

  // Rank top posts by views, then engagement, then QA, then recency.
  topPosts.sort(
    (a, b) =>
      b.views - a.views ||
      b.engagement - a.engagement ||
      (b.qa ?? 0) - (a.qa ?? 0) ||
      b.createdAt.localeCompare(a.createdAt),
  );

  const platformList = [...platforms.values()].sort((a, b) => b.posts - a.posts || b.views - a.views);
  const channelList = [...channels.values()].sort((a, b) => b.posts - a.posts);

  const totalQad = runs.filter((r) => r.qa).length;
  const totalPassed = runs.filter((r) => r.qa?.verdict === "pass").length;
  const avgQa = totalQad ? runs.reduce((s, r) => s + num(r.qa?.overall), 0) / totalQad : 0;

  const hasData = runs.length > 0;
  const hasMetrics = totalViews > 0;

  return Response.json({
    hasData,
    hasMetrics,
    generatedAt: new Date().toISOString(),
    totals: {
      runs: runs.length,
      publishes: totalPublishes,
      views: totalViews,
      engagement: totalEngagement,
      cost: totalCost,
      avgQa,
      passRate: totalQad ? Math.round((totalPassed / totalQad) * 100) : 0,
    },
    platforms: platformList,
    channels: channelList,
    topPosts: topPosts.slice(0, 12),
  });
}
