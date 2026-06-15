import { currentUser } from "@clerk/nextjs/server";
import { currentContext, ctxCan } from "../../lib/tenancy";
import { listWorkspaceMembers } from "../../lib/workspace-members";
import { CalendarClient } from "./CalendarClient";

/* P5 — Content calendar (server shell). Resolves the caller's tenant context +
   the workspace roster, then hands the client component:
     - members      → for the per-member filter and the assignee picker
     - meId / role  → so it can show "assigned to you" and disable controls the
                      role can't use (edit/move = calendar.edit, plan-run = plan.run)
     - icsWorkspace → the workspace token to embed in the public .ics feed URL
   Everything the calendar reads is already scoped to ctx.workspaceId by the APIs. */

export const dynamic = "force-dynamic";

export default async function CalendarPage() {
  const ctx = await currentContext();
  const user = await currentUser();
  const members = await listWorkspaceMembers(ctx.orgId, {
    userId: ctx.userId,
    name: user ? [user.firstName, user.lastName].filter(Boolean).join(" ") : null,
    email: user?.emailAddresses?.[0]?.emailAddress ?? null,
    imageUrl: user?.imageUrl ?? null,
  });

  return (
    <CalendarClient
      members={members}
      meId={ctx.userId}
      role={ctx.role}
      icsWorkspace={ctx.workspaceId}
      canEdit={ctxCan(ctx, "calendar.edit")}
      canPlan={ctxCan(ctx, "plan.run")}
    />
  );
}
