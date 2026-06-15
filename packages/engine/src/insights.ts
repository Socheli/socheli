import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { AccountInsightSnapshot } from "@os/schemas";

import { DATA_DIR, ensureDir, nowIso } from "./store.ts";
import { httpCurl } from "./http.ts";
import { isTokenError } from "./publish-types.ts";
import { resolveIgCreds } from "./connections.ts";

/* Account-level Instagram insights — distinct from the per-post media analytics
   in learnings.ts. This pulls the BRAND'S OWN account reach/engagement/follower
   metrics for the dashboard insights surface.

   Per-brand: credentials are resolved via resolveIgCreds(channel) (which owns the
   env fallback to the global IG_USER_ID/IG_ACCESS_TOKEN for back-compat). When no
   connection exists the call degrades cleanly — it returns { ok:false, reason }
   and NEVER throws, mirroring fetchInstagramAnalytics. Snapshots persist ONLY
   numeric metrics + the igUserId — never a token.

   graph.facebook.com is not geo-blocked in some regions, so no proxy (set IG_USE_PROXY=1 to
   force the tunnel if your exit needs it). */

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
// Store — data/insights/<channel>.json (flat JSON, atomic). Never holds a token.
// ───────────────────────────────────────────────────────────────────────────

const INSIGHTS_DIR = join(DATA_DIR, "insights");
const sanitize = (c: string) => (c || "global").replace(/[^a-zA-Z0-9_-]/g, "-");
const snapshotsFile = (channel: string) => join(INSIGHTS_DIR, `${sanitize(channel)}.json`);

export function loadInsightSnapshots(channel: string): AccountInsightSnapshot[] {
  const path = snapshotsFile(channel);
  try {
    return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as AccountInsightSnapshot[]) : [];
  } catch {
    return [];
  }
}

export function saveInsightSnapshots(channel: string, snaps: AccountInsightSnapshot[]): void {
  ensureDir(INSIGHTS_DIR);
  const path = snapshotsFile(channel);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(snaps, null, 2));
  renameSync(tmp, path);
}

export function latestInsight(channel: string): AccountInsightSnapshot | null {
  const snaps = loadInsightSnapshots(channel);
  if (!snaps.length) return null;
  // Snapshots are appended in capture order; pick the most recent by capturedAt.
  return snaps.reduce((a, b) => (Date.parse(b.capturedAt) > Date.parse(a.capturedAt) ? b : a));
}

// ───────────────────────────────────────────────────────────────────────────
// Live Graph call (token-gated via resolveIgCreds, never throws)
// ───────────────────────────────────────────────────────────────────────────

/* Pull account-level insights for the brand's connected IG account and persist a
   snapshot. Returns the snapshot, or { ok:false, reason } when not connected /
   re-auth needed / nothing came back. Never throws. */
export async function pullAccountInsights(
  channel: string,
  opts: { period?: "day" | "week" | "days_28" } = {},
): Promise<AccountInsightSnapshot | { ok: false; reason: string }> {
  const creds = resolveIgCreds(channel);
  if (!creds)
    return {
      ok: false,
      reason:
        "Connect this brand's Instagram in the connection wizard, or set IG_USER_ID + IG_ACCESS_TOKEN (token minted with instagram_manage_insights) in .env.",
    };

  const period = opts.period ?? "day";
  const { userId, token, base } = creds;

  // Account-level metrics. The API ignores metrics an account/permission set
  // doesn't support per call, so we request a generous set and read what returns.
  const metrics = "reach,impressions,profile_views,accounts_engaged,total_interactions";
  const insights = graphJson(
    httpCurl([`${base}/${userId}/insights?metric=${metrics}&period=${period}&access_token=${token}`], { proxy: useProxy() }),
  );
  // Follower count is a node field, not an insight metric.
  const fields = graphJson(
    httpCurl([`${base}/${userId}?fields=followers_count&access_token=${token}`], { proxy: useProxy() }),
  );

  if (
    insights?.error &&
    isTokenError(String(insights.error?.message ?? ""), insights.error?.code) &&
    fields?.error
  )
    return { ok: false, reason: `re-auth needed: ${insights.error?.message}` };

  // Parse defensively — account insights may carry values[0].value OR total_value.value
  // depending on the metric/period (mirror the instagram.ts media-insights pattern).
  const m = new Map<string, number>();
  for (const row of (insights?.data ?? []) as any[]) {
    const v = row?.values?.[0]?.value ?? row?.total_value?.value;
    if (typeof v === "number") m.set(String(row.name), v);
  }

  const followers = typeof fields?.followers_count === "number" ? fields.followers_count : undefined;
  const reach = m.get("reach");
  const impressions = m.get("impressions");
  const profileViews = m.get("profile_views");
  const accountsEngaged = m.get("accounts_engaged");
  const totalInteractions = m.get("total_interactions");

  if (
    followers === undefined &&
    reach === undefined &&
    impressions === undefined &&
    profileViews === undefined &&
    accountsEngaged === undefined &&
    totalInteractions === undefined
  )
    return {
      ok: false,
      reason:
        "no account insights returned (insights may need instagram_manage_insights, and the account must be a Business/Creator account)",
    };

  const snap: AccountInsightSnapshot = {
    channel,
    capturedAt: nowIso(),
    igUserId: userId,
    followers,
    reach,
    impressions,
    profileViews,
    accountsEngaged,
    totalInteractions,
    period,
    raw: { insights: insights?.data ?? insights, fields },
  };

  const snaps = loadInsightSnapshots(channel);
  snaps.push(snap);
  saveInsightSnapshots(channel, snaps);
  return snap;
}

// ───────────────────────────────────────────────────────────────────────────
// Scorecard — pure read over stored snapshots, no network.
// ───────────────────────────────────────────────────────────────────────────

export function insightScorecard(channel: string): {
  channel: string;
  latest: AccountInsightSnapshot | null;
  followerDelta?: number;
  reachDelta?: number;
  engagementRate?: number;
  samples: number;
  window?: { from: string; to: string };
} {
  const snaps = loadInsightSnapshots(channel)
    .slice()
    .sort((a, b) => Date.parse(a.capturedAt) - Date.parse(b.capturedAt));
  const latest = snaps.length ? snaps[snaps.length - 1] : null;

  let followerDelta: number | undefined;
  let reachDelta: number | undefined;
  if (snaps.length >= 2) {
    const first = snaps[0];
    const last = snaps[snaps.length - 1];
    if (typeof first.followers === "number" && typeof last.followers === "number")
      followerDelta = last.followers - first.followers;
    if (typeof first.reach === "number" && typeof last.reach === "number") reachDelta = last.reach - first.reach;
  }

  // Engagement rate proxy: interactions over reach for the latest snapshot.
  let engagementRate: number | undefined;
  if (latest && typeof latest.totalInteractions === "number" && typeof latest.reach === "number" && latest.reach > 0)
    engagementRate = Number((latest.totalInteractions / latest.reach).toFixed(4));

  return {
    channel,
    latest,
    followerDelta,
    reachDelta,
    engagementRate,
    samples: snaps.length,
    window: snaps.length ? { from: snaps[0].capturedAt, to: snaps[snaps.length - 1].capturedAt } : undefined,
  };
}
