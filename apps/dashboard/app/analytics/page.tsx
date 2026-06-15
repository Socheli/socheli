"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { PageHead } from "../PageHead";

/* G2 — Unified cross-platform analytics dashboard.
   Reads aggregated metrics from /api/analytics (which rolls up data/runs + any
   data/analytics snapshots). Matches the War Room dark visual language
   (.card / .stat-value / .grid / .badge / .row). Renders a graceful empty state
   when nothing has been produced or published yet. */

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
type ChannelAgg = { channel: string; posts: number; passed: number; qad: number; cost: number; avgQa: number };
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
type Analytics = {
  hasData: boolean;
  hasMetrics: boolean;
  generatedAt: string;
  totals: { runs: number; publishes: number; views: number; engagement: number; cost: number; avgQa: number; passRate: number };
  platforms: PlatformAgg[];
  channels: ChannelAgg[];
  topPosts: PostRow[];
};

const CHANNEL_NAMES: Record<string, string> = {
  labrinox: "Labrinox",
  claude_code_lab: "Code Labrinox",
  agentic_builder: "Agentic Builder",
  moltjobs: "MoltJobs",
  cognitivx: "iCog",
};
const chName = (id: string) => CHANNEL_NAMES[id] ?? id.replace(/_/g, " ");

const PLATFORM_LABEL: Record<string, string> = {
  instagram: "Instagram",
  tiktok: "TikTok",
  youtube: "YouTube",
};
const plName = (id: string) => PLATFORM_LABEL[id] ?? id;

function fmtNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}
function fmtCost(n: number): string {
  return `$${n.toFixed(2)}`;
}

function BarList({ rows, max, unit }: { rows: { label: string; value: number; sub?: string }[]; max: number; unit?: string }) {
  return (
    <div style={{ display: "grid", gap: 12 }}>
      {rows.map((r) => (
        <div key={r.label} style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <div style={{ width: 130, flexShrink: 0, fontSize: 13, color: "var(--text-light)" }}>{r.label}</div>
          <div style={{ flex: 1, height: 9, background: "var(--bg-surface)", borderRadius: 999, overflow: "hidden" }}>
            <div
              style={{
                height: "100%",
                width: `${max > 0 ? Math.max(3, (r.value / max) * 100) : 0}%`,
                background: "var(--accent)",
                opacity: 0.85,
                borderRadius: 999,
                transition: "width 240ms",
              }}
            />
          </div>
          <div style={{ width: 92, textAlign: "right", fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--text-light)" }}>
            {fmtNum(r.value)}
            {unit ? <span style={{ color: "var(--text-muted)", marginLeft: 3 }}>{unit}</span> : null}
            {r.sub ? <div style={{ fontSize: 10, color: "var(--text-muted)" }}>{r.sub}</div> : null}
          </div>
        </div>
      ))}
    </div>
  );
}

export default function AnalyticsPage() {
  const [data, setData] = useState<Analytics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetch("/api/analytics")
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((d: Analytics) => {
        if (alive) setData(d);
      })
      .catch((e: unknown) => {
        if (alive) setError(e instanceof Error ? e.message : "failed to load");
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  const platformBars = useMemo(() => {
    if (!data) return [];
    const useViews = data.hasMetrics;
    const rows = data.platforms.map((p) => ({
      label: plName(p.platform),
      value: useViews ? p.views : p.posts,
      sub: useViews ? `${p.posts} posts` : `${p.published} live`,
    }));
    return rows;
  }, [data]);
  const platformMax = useMemo(() => Math.max(1, ...platformBars.map((r) => r.value)), [platformBars]);

  const channelBars = useMemo(() => {
    if (!data) return [];
    return data.channels.map((c) => ({ label: chName(c.channel), value: c.posts, sub: `QA ${c.avgQa.toFixed(1)}` }));
  }, [data]);
  const channelMax = useMemo(() => Math.max(1, ...channelBars.map((r) => r.value)), [channelBars]);

  return (
    <>
      <PageHead
        section="grow"
        title="Analytics"
        sub="Unified cross-platform performance across every channel and post."
      />

      {loading ? (
        <div className="empty">Loading analytics...</div>
      ) : error ? (
        <div className="empty">Could not load analytics ({error}).</div>
      ) : !data || !data.hasData ? (
        <div className="empty">
          No analytics yet. Once you publish posts they will roll up here. Head to{" "}
          <Link href="/" style={{ color: "var(--accent)" }}>
            the War Room
          </Link>{" "}
          to produce one.
        </div>
      ) : (
        <>
          <div className="grid cols-4" style={{ marginBottom: 16 }}>
            <Stat label="Total posts" value={String(data.totals.runs)} foot={`${data.totals.publishes} publishes`} />
            <Stat
              label={data.hasMetrics ? "Total views" : "Published"}
              value={data.hasMetrics ? fmtNum(data.totals.views) : String(data.totals.publishes)}
              foot={data.hasMetrics ? `${fmtNum(data.totals.engagement)} engagements` : "across platforms"}
            />
            <Stat label="QA pass rate" value={String(data.totals.passRate)} unit="%" foot={`${data.totals.avgQa.toFixed(1)} avg score`} />
            <Stat label="Total spend" value={fmtCost(data.totals.cost)} foot={`${fmtCost(data.totals.runs ? data.totals.cost / data.totals.runs : 0)} / post`} />
          </div>

          {!data.hasMetrics && (
            <div className="card" style={{ marginBottom: 16, borderColor: "var(--border-interactive)" }}>
              <div className="stat-label">// note</div>
              <div className="sub" style={{ marginTop: 8 }}>
                No platform metric snapshots found yet — showing publish counts. Once view/engagement data lands in{" "}
                <span style={{ fontFamily: "var(--font-mono)", color: "var(--text-light)" }}>data/analytics</span>, charts switch to reach.
              </div>
            </div>
          )}

          <div className="grid cols-2" style={{ marginBottom: 32 }}>
            <div className="card">
              <div className="stat-label" style={{ marginBottom: 18 }}>
                {data.hasMetrics ? "Views by platform" : "Posts by platform"}
              </div>
              {platformBars.length ? <BarList rows={platformBars} max={platformMax} /> : <div className="sub">No platform data.</div>}
            </div>
            <div className="card">
              <div className="stat-label" style={{ marginBottom: 18 }}>
                Posts by channel
              </div>
              {channelBars.length ? <BarList rows={channelBars} max={channelMax} /> : <div className="sub">No channel data.</div>}
            </div>
          </div>

          <h2 className="h2">Top posts</h2>
          {data.topPosts.length === 0 ? (
            <div className="empty">No published posts yet.</div>
          ) : (
            <div className="grid" style={{ gap: 10 }}>
              {data.topPosts.map((p) => (
                <Link key={p.id} href={`/post/${p.id}`} className="row">
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="row-title" style={{ marginBottom: 5 }}>
                      {p.title}
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                      <span className="row-id" style={{ width: "auto" }}>
                        {chName(p.channel)}
                      </span>
                      {p.platforms.map((pl) => (
                        <span key={pl} className="badge b-neutral">
                          <span className="d" />
                          {plName(pl)}
                        </span>
                      ))}
                    </div>
                  </div>
                  {data.hasMetrics && (
                    <div style={{ textAlign: "right", fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--text-light)" }}>
                      <div>{fmtNum(p.views)} views</div>
                      <div style={{ color: "var(--text-muted)", fontSize: 11 }}>{fmtNum(p.engagement)} eng.</div>
                    </div>
                  )}
                  {p.qa != null && <div className="qa-pill">{p.qa.toFixed(1)}</div>}
                  <div className="row-cost">{fmtCost(p.cost)}</div>
                </Link>
              ))}
            </div>
          )}
        </>
      )}
    </>
  );
}

function Stat({ label, value, unit, foot }: { label: string; value: string; unit?: string; foot?: string }) {
  return (
    <div className="card">
      <div className="stat-label">{label}</div>
      <div className="stat-value">
        {value}
        {unit && <span className="stat-unit">{unit}</span>}
      </div>
      {foot && <div className="stat-foot">{foot}</div>}
    </div>
  );
}
