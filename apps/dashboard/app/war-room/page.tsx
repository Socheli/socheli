import Link from "next/link";
import { warRoom, listItemsFor } from "../../lib/data";
import { currentWorkspaceId } from "../../lib/tenancy";
import { fleet } from "../../lib/fleet";
import { dailySeries, usageTotals, qaDistribution, byChannel, pctDelta } from "../../lib/usage";
import { StatusBadge, fmtCost, ChannelFilter } from "../ui";
import { TrendStat, AreaChart, Donut, BarRow, ProgressRing } from "../charts";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "War Room — Socheli",
  description: "Command overview — autonomous content operations",
};

const CH = (id: string) => ({ labrinox: "Labrinox", claude_code_lab: "Code Labrinox", agentic_builder: "Agentic Builder", moltjobs: "MoltJobs", cognitivx: "iCog" } as Record<string, string>)[id] ?? id.replace(/_/g, " ");

export default async function WarRoom({ searchParams }: { searchParams: Promise<{ channel?: string }> }) {
  const { channel } = await searchParams;
  const workspaceId = await currentWorkspaceId();
  const items = listItemsFor(workspaceId);
  const w = warRoom(workspaceId);
  const t = usageTotals(items);
  const ser = dailySeries(14, items);
  const qa = qaDistribution(items);
  const chans = byChannel(items).slice(0, 6);
  const f = fleet();
  const recent = channel ? items.filter((it) => it.channel === channel).slice(0, 12) : w.recent;
  const maxPosts = Math.max(1, ...chans.map((c) => c.posts));

  return (
    <>
      <div className="page-head">
        <div className="eyebrow">// command center</div>
        <h1 className="h1">War Room</h1>
        <div className="sub">Autonomous content operations — quality before volume.</div>
      </div>

      {/* headline trend stats */}
      <div className="grid cols-4" style={{ marginBottom: 16 }}>
        <TrendStat label="Produced · 7d" value={t.posts7} series={ser.map((d) => d.posts)} deltaPct={pctDelta(t.posts7, t.posts7prev)} foot={`${t.posts} all-time`} />
        <TrendStat label="Published" value={t.published} series={ser.map((d) => d.published)} foot={`${f.online} device(s) online`} />
        <TrendStat label="Spend · 30d" value={fmtCost(t.cost30)} series={ser.map((d) => d.cost)} foot={`${fmtCost(t.costUsd)} all-time`} />
        <div className="card" style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <ProgressRing value={t.passRate / 100} label={<span style={{ fontSize: 15 }}>{t.passRate}%</span>} />
          <div>
            <div className="stat-label">QA pass rate</div>
            <div className="stat-foot" style={{ marginTop: 6 }}>avg {t.qaAvg.toFixed(1)}/10 · publication-grade</div>
          </div>
        </div>
      </div>

      {/* production trend + QA distribution */}
      <div className="grid cols-2" style={{ marginBottom: 16 }}>
        <div className="card">
          <div className="stat-label">Production · last 14 days</div>
          <div style={{ marginTop: 14 }}><AreaChart data={ser.map((d) => d.posts)} labels={ser.map((d) => d.label)} /></div>
        </div>
        <div className="card">
          <div className="stat-label">QA distribution</div>
          <div style={{ marginTop: 16 }}>
            <Donut segments={qa.map((b) => ({ value: b.count, color: b.color, label: b.band }))} label={qa.reduce((a, b) => a + b.count, 0)} sub="scored" />
          </div>
        </div>
      </div>

      {/* by channel + fleet */}
      <div className="grid cols-2" style={{ marginBottom: 32 }}>
        <div className="card">
          <div className="stat-label">Output by channel</div>
          <div style={{ marginTop: 14 }}>
            {chans.length === 0 ? <div className="sub">no posts yet</div> : chans.map((c) => <BarRow key={c.channel} label={CH(c.channel)} value={c.posts} max={maxPosts} />)}
          </div>
        </div>
        <div className="card">
          <div className="stat-label">Render fleet</div>
          {f.devices.length === 0 ? (
            <div className="sub" style={{ marginTop: 12 }}>No devices connected. <Link href="/devices" style={{ color: "var(--accent)" }}>Set one up →</Link></div>
          ) : (
            <div style={{ marginTop: 12, display: "grid", gap: 9 }}>
              {f.devices.slice(0, 5).map((d) => (
                <div key={d.device} style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <span style={{ width: 8, height: 8, borderRadius: 4, background: d.status === "busy" ? "var(--accent)" : d.status === "offline" ? "var(--text-muted)" : "var(--success)" }} />
                  <span style={{ fontWeight: 600 }}>{d.device}</span>
                  <span className="row-cost">{d.profile ? `${d.profile.ramGb}GB · ${d.profile.gpu}` : ""}</span>
                  <span className="badge b-neutral" style={{ marginLeft: "auto" }}><span className="d" />{d.status}</span>
                </div>
              ))}
              <Link href="/devices" className="row-cost" style={{ color: "var(--accent)", marginTop: 2 }}>Manage fleet →</Link>
            </div>
          )}
        </div>
      </div>

      {w.best && (
        <div className="card" style={{ marginBottom: 32, borderColor: "var(--accent-muted)" }}>
          <div className="stat-label" style={{ color: "var(--accent)" }}>★ Best candidate</div>
          <div style={{ display: "flex", alignItems: "center", gap: 16, marginTop: 14 }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 19, fontWeight: 640, letterSpacing: "-0.02em" }}>{w.best.pkg?.title ?? w.best.idea?.topic ?? w.best.seedIdea}</div>
              <div className="sub" style={{ marginTop: 6 }}>{CH(w.best.channel)}</div>
            </div>
            <div style={{ fontSize: 30, fontWeight: 700, color: "var(--accent)", letterSpacing: "-0.03em" }}>{w.best.qa?.overall.toFixed(1)}<span style={{ fontSize: 15, color: "var(--text-muted)" }}>/10</span></div>
            <Link href={`/post/${w.best.id}`} className="btn btn-primary">Open</Link>
          </div>
        </div>
      )}

      <h2 className="h2">Recent runs</h2>
      <ChannelFilter active={channel} base="/war-room" />
      {recent.length === 0 ? (
        <div className="empty">No runs yet. Head to <Link href="/new" style={{ color: "var(--accent)" }}>New Post</Link> to generate one.</div>
      ) : (
        <div className="grid" style={{ gap: 10 }}>
          {recent.map((it) => (
            <Link key={it.id} href={`/post/${it.id}`} className="row row-thumb">
              <div className="thumb">{it.videoPath ? <img src={`/api/thumb/${it.id}`} alt="" /> : <span className="thumb-ph">{it.channel?.[0]?.toUpperCase()}</span>}</div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="row-title" style={{ marginBottom: 5 }}>{it.pkg?.title ?? it.idea?.topic ?? it.seedIdea}</div>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <StatusBadge status={it.status} />
                  <span className="row-id" style={{ width: "auto" }}>{CH(it.channel)}</span>
                </div>
              </div>
              {it.qa && <div className="qa-pill">{it.qa.overall.toFixed(1)}</div>}
              <div className="row-cost">{fmtCost(it.ledger.totalUsd)}</div>
            </Link>
          ))}
        </div>
      )}
    </>
  );
}
