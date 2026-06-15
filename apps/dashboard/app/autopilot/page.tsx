import { loadSchedule, schedulerStatus, KNOWN_CHANNELS } from "../../lib/schedule";
import { listItemsFor } from "../../lib/data";
import { currentContext, ctxCan } from "../../lib/tenancy";
import { AutopilotControls, CopyCmd } from "./AutopilotControls";
import { Heatmap } from "../charts";
import { PageHead } from "../PageHead";

export const dynamic = "force-dynamic";

const PLATFORMS: { key: "youtube" | "instagram" | "tiktok" | "host"; label: string; color: string }[] = [
  { key: "youtube", label: "YouTube", color: "#ff4e45" },
  { key: "instagram", label: "Instagram", color: "#e1306c" },
  { key: "tiktok", label: "TikTok", color: "#25f4ee" },
  { key: "host", label: "Public host", color: "#9b8cff" },
];

export default async function Autopilot() {
  const ctx = await currentContext();
  const schedule = loadSchedule(ctx.workspaceId);
  const status = schedulerStatus(ctx.workspaceId);
  const canManage = ctxCan(ctx, "schedule.manage");
  // recent autopilot activity = this workspace's items that carry publish entries
  const recent = listItemsFor(ctx.workspaceId)
    .filter((i) => i.publish?.length)
    .slice(0, 6);

  // schedule heatmap: channels × 2-hour buckets, cell = number of slots firing then
  const activeChannels = (schedule.channels ?? []).filter((c) => c.enabled && c.slots.length);
  const hourCols = Array.from({ length: 12 }, (_, i) => String(i * 2).padStart(2, "0"));
  const heatRows = activeChannels.map((c) => KNOWN_CHANNELS.find((k) => k.id === c.channel)?.name ?? c.channel);
  const heatValues = activeChannels.map((c) => {
    const row = new Array(12).fill(0);
    for (const s of c.slots) row[Math.floor(Number(s.time.split(":")[0]) / 2)]++;
    return row;
  });
  const totalSlots = activeChannels.reduce((a, c) => a + c.slots.length, 0);

  return (
    <>
      <PageHead
        section="publish"
        title="Autopilot"
        sub="Cron-driven: select concept → generate → QA-gate → publish, on the cadence you set."
      />

      {heatRows.length > 0 && (
        <div className="card" style={{ marginBottom: 20 }}>
          <div className="stat-label">Posting cadence · {totalSlots} slot(s)/day across {heatRows.length} channel(s)</div>
          <div style={{ marginTop: 14 }}><Heatmap rows={heatRows} cols={hourCols} values={heatValues} /></div>
        </div>
      )}

      <div className="grid cols-2" style={{ alignItems: "start", gap: 20, marginBottom: 20 }}>
        {/* scheduler status */}
        <div className="card">
          <div className="stat-label">Scheduler (launchd)</div>
          <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
            <span className={`badge ${status.loaded ? "b-ok" : status.installed ? "b-neutral" : "b-err"}`}>
              <span className="d" />{status.loaded ? "running" : status.installed ? "installed, not loaded" : "not installed"}
            </span>
            {status.next && <span className="badge b-neutral"><span className="d" />next {status.next.channel}@{status.next.time}</span>}
          </div>
          {!status.loaded && (
            <div style={{ marginTop: 14, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
              <span className="sub">Install the agent (one-time):</span>
              <CopyCmd cmd={status.installCmd} />
            </div>
          )}
          <div className="stat-label" style={{ marginTop: 18 }}>Recent ticks</div>
          <pre style={{ marginTop: 8, maxHeight: 180, overflow: "auto", fontSize: 11.5, lineHeight: 1.5, color: "var(--text-secondary)", background: "var(--bg-surface)", border: "1px solid var(--border-subtle)", borderRadius: 8, padding: "10px 12px", whiteSpace: "pre-wrap" }}>
            {status.logTail || "no ticks yet — install the agent or run `pnpm content tick`."}
          </pre>
        </div>

        {/* connections */}
        <div className="card">
          <div className="stat-label">Connections (live posting)</div>
          <div style={{ display: "grid", gap: 10, marginTop: 14 }}>
            {PLATFORMS.map((p) => {
              const live = status.platforms[p.key];
              return (
                <div key={p.key} style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <span style={{ width: 9, height: 9, borderRadius: 5, background: p.color, opacity: live ? 1 : 0.3 }} />
                  <span style={{ fontWeight: 600, flex: 1 }}>{p.label}</span>
                  <span className={`badge ${live ? "b-ok" : "b-neutral"}`}><span className="d" />{live ? "live" : p.key === "host" ? "not set" : "bundle only"}</span>
                </div>
              );
            })}
          </div>
          <div className="sub" style={{ marginTop: 14, lineHeight: 1.55 }}>
            Instagram & TikTok go live once a public host + their tokens are set in <code>.env</code> (see <code>.env.example</code>). Until then they fall back to a paste-ready export bundle. YouTube needs the OAuth keys + the SOCKS tunnel up.
          </div>
        </div>
      </div>

      {/* editable schedule — read-only unless the role has schedule.manage */}
      <AutopilotControls initial={schedule} channels={KNOWN_CHANNELS} canManage={canManage} />

      {/* recent autopilot output */}
      {recent.length > 0 && (
        <>
          <h2 className="h2" style={{ marginTop: 32 }}>Recently published</h2>
          <div className="grid" style={{ gap: 10 }}>
            {recent.map((it) => (
              <a key={it.id} href={`/post/${it.id}`} className="row">
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="row-title" style={{ marginBottom: 5 }}>{it.pkg?.title ?? it.idea?.topic ?? it.seedIdea}</div>
                  <div style={{ display: "flex", gap: 7, flexWrap: "wrap" }}>
                    {(it.publish ?? []).map((e, i) => (
                      <span key={i} className={`badge ${e.status === "published" ? "b-ok" : e.status === "error" || e.status === "needs-auth" ? "b-err" : "b-neutral"}`}>
                        <span className="d" />{e.platform} {e.status}
                      </span>
                    ))}
                  </div>
                </div>
                <span className="row-id" style={{ width: "auto" }}>{it.channel.replace(/_/g, " ")}</span>
              </a>
            ))}
          </div>
        </>
      )}
    </>
  );
}
