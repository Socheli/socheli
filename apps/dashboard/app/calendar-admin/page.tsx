import { currentUser } from "@clerk/nextjs/server";
import { currentContext, ctxCan } from "../../lib/tenancy";
import { listWorkspaceMembers } from "../../lib/workspace-members";
import { adminCalendarFor } from "../../lib/calendar-admin";
import { PageHead } from "../PageHead";
import { CalendarAdminBoard } from "./CalendarAdminBoard";

/* Calendar Admin — cross-brand calendar oversight for an owner/admin.

   Sits ABOVE the per-brand /calendar + /plan: ONE calendar across all brands'
   planned + scheduled posts, an admin approval gate (planned posts need sign-off
   before entering the autopilot queue), per-brand posting policy (cadence /
   best-times / blackout windows), and conflict detection — all AGGREGATED from
   the existing plan/schedule/calendar-meta stores and the engine caladmin_*
   tools (so detection + policy stay single-sourced in the engine).

   Read view is broad (analytics.view); every MUTATION (reschedule / approve /
   reject / policy / blackout) is admin-gated on schedule.manage in the board +
   the route. Reassignment uses the lighter calendar.edit. */

export const dynamic = "force-dynamic";

export default async function CalendarAdminPage() {
  const ctx = await currentContext();
  const user = await currentUser();

  const cal = await adminCalendarFor(ctx.workspaceId);
  const members = await listWorkspaceMembers(ctx.orgId, {
    userId: ctx.userId,
    name: user ? [user.firstName, user.lastName].filter(Boolean).join(" ") : null,
    email: user?.emailAddresses?.[0]?.emailAddress ?? null,
    imageUrl: user?.imageUrl ?? null,
  });

  const canManage = ctxCan(ctx, "schedule.manage");
  const canAssign = ctxCan(ctx, "calendar.edit");

  return (
    <>
      <PageHead
        section="manage"
        title="Calendar Admin"
        sub="One calendar across every brand — approve planned posts into the autopilot queue, set posting policy and blackout windows, and catch slot conflicts before they ship."
      />
      <CalendarAdminBoard
        brands={cal.brands}
        posts={cal.posts}
        approvalQueue={cal.approvalQueue}
        policies={cal.policies}
        conflicts={cal.conflicts}
        members={members}
        meId={ctx.userId}
        canManage={canManage}
        canAssign={canAssign}
      />
    </>
  );
}
