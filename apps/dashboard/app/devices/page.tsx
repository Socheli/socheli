import { fleet } from "../../lib/fleet";
import { currentContext, ctxCan } from "../../lib/tenancy";
import { DevicesClient } from "./DevicesClient";
import { Donut, TrendStat } from "../charts";
import { PageHead } from "../PageHead";

export const dynamic = "force-dynamic";

export default async function DevicesPage() {
  const ctx = await currentContext();
  // devices are shared; jobs are scoped to this workspace.
  const { devices, jobs, online } = fleet(ctx.workspaceId);
  const canDispatch = ctxCan(ctx, "queue.dispatch");
  const busy = devices.filter((d) => d.status === "busy").length;
  const idle = devices.filter((d) => d.status === "idle" || d.status === "online").length;
  const offline = devices.filter((d) => d.status === "offline").length;
  const done = jobs.filter((j) => j.status === "done").length;
  const running = jobs.filter((j) => j.status === "running").length;
  const errored = jobs.filter((j) => j.status === "error").length;
  const totalCaps = devices.reduce((a, d) => a + (d.caps?.length ?? 0), 0);

  return (
    <>
      <PageHead
        section="manage"
        title="Devices"
        sub="Your render fleet. The server dispatches jobs; a capability-matched device picks each one up, renders, and syncs the result back."
      />

      {devices.length > 0 && (
        <div className="grid cols-4" style={{ marginBottom: 20 }}>
          <div className="card"><div className="stat-label">Fleet status</div><div style={{ marginTop: 14 }}>
            <Donut size={120} segments={[{ value: busy, color: "var(--accent)", label: "busy" }, { value: idle, color: "var(--success)", label: "idle" }, { value: offline, color: "var(--text-muted)", label: "offline" }]} label={online} sub="online" />
          </div></div>
          <TrendStat label="Jobs done" value={done} foot={`${running} running · ${errored} errored`} />
          <TrendStat label="Devices" value={devices.length} foot={`${online} online`} />
          <TrendStat label="Capabilities" value={totalCaps} foot="across the fleet" />
        </div>
      )}

      <DevicesClient devices={devices} jobs={jobs} online={online} canDispatch={canDispatch} />
    </>
  );
}
