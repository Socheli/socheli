import { listItemsFor } from "../../lib/data";
import { dailySeries, usageTotals, byChannel } from "../../lib/usage";
import { currentContext } from "../../lib/tenancy";
import { fmtCost } from "../ui";
import { TrendStat, AreaChart, BarChart, BarRow } from "../charts";
import { PageHead } from "../PageHead";

export const dynamic = "force-dynamic";
const CH = (id: string) => ({ labrinox: "Labrinox", claude_code_lab: "Code Labrinox", agentic_builder: "Agentic Builder", moltjobs: "MoltJobs", cognitivx: "iCog" } as Record<string, string>)[id] ?? id.replace(/_/g, " ");

export default async function UsagePage() {
  const ctx = await currentContext();
  const items = listItemsFor(ctx.workspaceId);
  const t = usageTotals(items);
  const ser = dailySeries(30, items);
  const chans = byChannel(items);
  const monthPosts = ser.reduce((a, d) => a + d.posts, 0);
  const maxPosts = Math.max(1, ...chans.map((c) => c.posts));
  const maxCost = Math.max(0.01, ...chans.map((c) => c.cost));

  return (
    <>
      <PageHead
        section="grow"
        title="Usage"
        sub="What your workspace has produced and spent this period. Open source — no limits."
      />

      <div className="grid cols-4" style={{ marginBottom: 16 }}>
        <TrendStat label="Posts · 30d" value={monthPosts} series={ser.map((d) => d.posts)} />
        <TrendStat label="Render minutes" value={Math.round(t.renderMin)} unit="m" series={ser.map((d) => d.renderMin)} />
        <TrendStat label="Spend · 30d" value={fmtCost(t.cost30)} series={ser.map((d) => d.cost)} />
        <TrendStat label="Published" value={t.published} series={ser.map((d) => d.published)} />
      </div>

      <div className="grid cols-2" style={{ marginBottom: 16 }}>
        <div className="card">
          <div className="stat-label">Posts · last 30 days</div>
          <div style={{ marginTop: 14 }}><AreaChart data={ser.map((d) => d.posts)} labels={ser.map((d) => d.label)} /></div>
        </div>
        <div className="card">
          <div className="stat-label">Spend · last 30 days</div>
          <div style={{ marginTop: 14 }}><BarChart data={ser.map((d) => d.cost)} labels={ser.map((d) => d.label)} unit="$" /></div>
        </div>
      </div>

      <div className="grid cols-2">
        <div className="card">
          <div className="stat-label">Posts by channel</div>
          <div style={{ marginTop: 14 }}>{chans.map((c) => <BarRow key={c.channel} label={CH(c.channel)} value={c.posts} max={maxPosts} />)}</div>
        </div>
        <div className="card">
          <div className="stat-label">Cost by channel</div>
          <div style={{ marginTop: 14 }}>{chans.map((c) => <BarRow key={c.channel} label={CH(c.channel)} value={Number(c.cost.toFixed(2))} max={maxCost} suffix="$" color="var(--accent-secondary)" />)}</div>
        </div>
      </div>
    </>
  );
}
