import { listItems, listItemsFor, type Item } from "./data";
import { planById } from "./billing";

/* Usage + analytics aggregation, derived from the file store (data/runs). Powers
   the War Room charts, the Usage tracker, and billing quota meters. All counts
   are real; render-minutes is estimated from storyboard duration.

   Everything here accepts an explicit `items` list so callers can scope to a
   workspace (pass `listItemsFor(workspaceId)`); `workspaceUsage` rolls the
   common quota figures — posts-this-month, devices, seats — for one workspace. */

const dayKey = (iso: string) => iso.slice(0, 10);
const renderSec = (it: Item) => it.storyboard?.scenes?.reduce((a, s) => a + (s.durationSec || 0), 0) ?? 0;

export type DayPoint = { date: string; label: string; posts: number; cost: number; renderMin: number; published: number };

export function dailySeries(days = 14, items: Item[] = listItems()): DayPoint[] {
  const today = new Date();
  const buckets: DayPoint[] = [];
  const idx = new Map<string, DayPoint>();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today.getTime() - i * 86400_000);
    const date = d.toISOString().slice(0, 10);
    const p: DayPoint = { date, label: `${d.getMonth() + 1}/${d.getDate()}`, posts: 0, cost: 0, renderMin: 0, published: 0 };
    buckets.push(p);
    idx.set(date, p);
  }
  for (const it of items) {
    const p = idx.get(dayKey(it.createdAt));
    if (!p) continue;
    p.posts += 1;
    p.cost += it.ledger?.totalUsd ?? 0;
    p.renderMin += renderSec(it) / 60;
    p.published += (it.publish ?? []).some((e) => e.status === "published") ? 1 : 0;
  }
  return buckets;
}

export type ChannelAgg = { channel: string; posts: number; cost: number; avgQa: number; published: number };

export function byChannel(items: Item[] = listItems()): ChannelAgg[] {
  const m = new Map<string, { posts: number; cost: number; qaSum: number; qaN: number; published: number }>();
  for (const it of items) {
    const e = m.get(it.channel) ?? { posts: 0, cost: 0, qaSum: 0, qaN: 0, published: 0 };
    e.posts += 1;
    e.cost += it.ledger?.totalUsd ?? 0;
    if (it.qa?.overall != null) { e.qaSum += it.qa.overall; e.qaN += 1; }
    e.published += (it.publish ?? []).some((p) => p.status === "published") ? 1 : 0;
    m.set(it.channel, e);
  }
  return [...m.entries()].map(([channel, e]) => ({ channel, posts: e.posts, cost: e.cost, avgQa: e.qaN ? e.qaSum / e.qaN : 0, published: e.published })).sort((a, b) => b.posts - a.posts);
}

/* QA score distribution in 4 bands (for a donut / bars). */
export function qaDistribution(items: Item[] = listItems()): { band: string; count: number; color: string }[] {
  const bands = [
    { band: "8–10 elite", min: 8, color: "var(--success)", count: 0 },
    { band: "7–8 pass", min: 7, color: "var(--accent)", count: 0 },
    { band: "5–7 mid", min: 5, color: "var(--warning)", count: 0 },
    { band: "<5 weak", min: 0, color: "var(--error)", count: 0 },
  ];
  for (const it of items) {
    const q = it.qa?.overall;
    if (q == null) continue;
    (bands.find((b) => q >= b.min) ?? bands[3]).count++;
  }
  return bands.map(({ band, count, color }) => ({ band, count, color }));
}

export type UsageTotals = {
  posts: number;
  published: number;
  costUsd: number;
  renderMin: number;
  qaAvg: number;
  passRate: number;
  posts7: number;
  posts7prev: number;
  cost30: number;
};

export function usageTotals(items: Item[] = listItems()): UsageTotals {
  const qad = items.filter((i) => i.qa);
  const ser = dailySeries(60, items);
  const last7 = ser.slice(-7).reduce((a, p) => a + p.posts, 0);
  const prev7 = ser.slice(-14, -7).reduce((a, p) => a + p.posts, 0);
  const cost30 = ser.slice(-30).reduce((a, p) => a + p.cost, 0);
  return {
    posts: items.length,
    published: items.filter((i) => (i.publish ?? []).some((p) => p.status === "published")).length,
    costUsd: items.reduce((a, i) => a + (i.ledger?.totalUsd ?? 0), 0),
    renderMin: items.reduce((a, i) => a + renderSec(i) / 60, 0),
    qaAvg: qad.length ? qad.reduce((a, i) => a + (i.qa!.overall ?? 0), 0) / qad.length : 0,
    passRate: qad.length ? Math.round((qad.filter((i) => i.qa!.verdict === "pass" || (i.qa!.overall ?? 0) >= 7).length / qad.length) * 100) : 0,
    posts7: last7,
    posts7prev: prev7,
    cost30,
  };
}

export const pctDelta = (cur: number, prev: number) => (prev <= 0 ? (cur > 0 ? 100 : 0) : Math.round(((cur - prev) / prev) * 100));

/* ── Workspace-scoped quota usage ──────────────────────────────────────────
   The shape the Usage / Billing pages render: this month's posts against the
   plan, plus seats-used (org member count) and devices, all vs the plan quota.
   `members` is supplied by the caller (it comes from Clerk, server-side). */
export type WorkspaceUsage = {
  plan: ReturnType<typeof planById>;
  postsThisMonth: number;
  postsQuota: number;
  postsPct: number; // 0..1
  seatsUsed: number;
  seatsQuota: number;
  devicesQuota: number;
  brandsQuota: number;
  totals: UsageTotals;
};

export function workspaceUsage(
  workspaceId: string,
  opts: { planId?: string; members?: number } = {},
): WorkspaceUsage {
  const items = listItemsFor(workspaceId);
  const plan = planById(opts.planId);
  const postsThisMonth = dailySeries(30, items).reduce((a, d) => a + d.posts, 0);
  const postsQuota = plan.quota.postsPerMonth;
  return {
    plan,
    postsThisMonth,
    postsQuota,
    postsPct: Math.min(1, postsThisMonth / Math.max(1, postsQuota)),
    seatsUsed: Math.max(1, opts.members ?? 1),
    seatsQuota: plan.quota.seats,
    devicesQuota: plan.quota.devices,
    brandsQuota: plan.quota.brands,
    totals: usageTotals(items),
  };
}
