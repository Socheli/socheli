import { currentContext, ctxCan } from "../../lib/tenancy";
import { listBrands } from "../../lib/brands";
import { listMissionsFor } from "../../lib/missions";
import { listWorkspaceMembers } from "../../lib/workspace-members";
import { readAudit } from "../../lib/audit";
import {
  buildBrandRollups,
  unifiedApprovalsFor,
  adminStateFor,
  healthAlertsFor,
} from "../../lib/admin";
import { PageHead } from "../PageHead";
import { AdminCockpit } from "./AdminCockpit";

export const dynamic = "force-dynamic";

/* SMM Admin — the cross-brand autonomous-ops control center (sits ABOVE the
   per-brand /missions, /autopilot, /inbox, /connections surfaces; never
   duplicates them). Server shell: reads the workspace's brand rollups, the
   unified approvals hub, the admin control store (kill-switch + per-brand
   pause + budget caps), derived health alerts, the team roster (for brand
   ownership oversight) and the recent audit feed, then hands everything to the
   client cockpit which keeps it live via router.refresh polling.

   Reads are broad (any member can SEE the rollup); mutations are admin-gated:
   controls/kill-switch/pause/budget need schedule.manage, per-feed approvals
   reuse their own gates (brand.manage / content.publish), reassignment needs
   calendar.edit. The booleans below are threaded to the client so it hides or
   disables what the caller can't do — the API re-checks every gate server-side. */

export default async function AdminPage() {
  const ctx = await currentContext();
  const ws = ctx.workspaceId;

  const rollups = buildBrandRollups(ws);
  const approvals = unifiedApprovalsFor(ws);
  const adminState = adminStateFor(ws);
  const alerts = healthAlertsFor(ws, rollups);

  // Team oversight: roster + who owns each brand's missions (createdBy).
  const members = await listWorkspaceMembers(ctx.orgId, {
    userId: ctx.userId,
    name: undefined,
    email: undefined,
    imageUrl: undefined,
  });
  const memberName = new Map(members.map((m) => [m.userId, m.name]));
  const missions = listMissionsFor(ws);
  const team = listBrands(ws).map((b) => {
    const owners = new Set(
      missions.filter((m) => m.channel === b.id).map((m) => m.createdBy).filter(Boolean) as string[],
    );
    return {
      channel: b.id,
      name: b.name,
      accent: b.accent,
      owners: [...owners].map((id) => ({ userId: id, name: memberName.get(id) ?? id })),
    };
  });

  const canViewAudit = ctxCan(ctx, "audit.view");
  const audit = canViewAudit
    ? readAudit(ws, 60).map((e) => ({ at: e.at, action: e.action, target: e.target, userId: e.userId }))
    : [];

  return (
    <>
      <PageHead
        section="manage"
        title="Ops Control Center"
        sub="Cross-brand autonomous-ops oversight — every brand's mission, autopilot, responder, connection and inbox backlog in one rollup, one approvals hub for every human gate, and the workspace kill-switch."
      />
      <AdminCockpit
        rollups={rollups}
        approvals={approvals}
        adminState={{ killSwitch: adminState.killSwitch, killSwitchReason: adminState.killSwitchReason }}
        alerts={alerts}
        team={team}
        members={members.map((m) => ({ userId: m.userId, name: m.name, role: m.role }))}
        audit={audit}
        canManage={ctxCan(ctx, "schedule.manage")}
        canApproveDna={ctxCan(ctx, "brand.manage")}
        canPublish={ctxCan(ctx, "content.publish")}
        canSend={ctxCan(ctx, "content.publish")}
        canReassign={ctxCan(ctx, "calendar.edit")}
        canViewAudit={canViewAudit}
      />
    </>
  );
}
