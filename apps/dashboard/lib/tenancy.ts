import "server-only";
import { cache } from "react";
import { auth, clerkClient } from "@clerk/nextjs/server";
import {
  appRoleFromClerk,
  workspaceIdFor,
  can,
  type Permission,
  type Role,
  type TenantContext,
} from "@os/schemas";
import { currentPlanId } from "./billing";

/* The server-side resolver every page / route handler uses to learn WHO is
   asking and WHICH workspace they're in. Built on Clerk's session. The result
   is the single `TenantContext` the rest of the app threads through to scope
   data and gate actions. Wrapped in React.cache so it resolves once per request. */

/* Read the app-role override + creator from the org (for owner/viewer grades
   that Clerk's two built-in roles can't express). Best-effort: on any failure we
   fall back to the Clerk role mapping so auth never hard-fails on a metadata read. */
async function orgRoleDetail(orgId: string, userId: string | null) {
  try {
    const client = await clerkClient();
    const org = await client.organizations.getOrganization({ organizationId: orgId });
    const roles = (org.publicMetadata?.roles ?? {}) as Record<string, string>;
    return {
      isCreator: !!userId && org.createdBy === userId,
      override: userId ? roles[userId] : undefined,
    };
  } catch {
    return { isCreator: false, override: undefined };
  }
}

export const currentContext = cache(async (): Promise<TenantContext> => {
  // Public demo (AUTH_MODE=demo): no login → a read-only VIEWER in the demo
  // workspace. The role matrix blocks every mutation/spend/publish; visitors just
  // browse. No secrets, no writes, no LLM spend (the agent route is gated too).
  if ((process.env.AUTH_MODE ?? "").toLowerCase() === "demo") {
    return {
      workspaceId: process.env.SOCHELI_DEMO_WORKSPACE || "ws_default",
      userId: null,
      orgId: null,
      role: "viewer",
      plan: currentPlanId(),
      via: "session",
    };
  }
  const { userId, orgId, orgRole } = await auth();
  const workspaceId = workspaceIdFor({ orgId, userId });

  let role: Role;
  if (!orgId) {
    role = appRoleFromClerk({ personal: true });
  } else {
    const { isCreator, override } = await orgRoleDetail(orgId, userId);
    role = appRoleFromClerk({ clerkRole: orgRole, isCreator, override });
  }

  return {
    workspaceId,
    userId: userId ?? null,
    orgId: orgId ?? null,
    role,
    plan: currentPlanId(),
    via: "session",
  };
});

/* Convenience: just the workspace id (the common case for scoping a read). */
export async function currentWorkspaceId(): Promise<string> {
  return (await currentContext()).workspaceId;
}

/* Gate helpers. `assertCan` throws a 403-shaped error for route handlers. */
export class ForbiddenError extends Error {
  status = 403;
  constructor(public permission: Permission) {
    super(`Forbidden: missing permission "${permission}"`);
    this.name = "ForbiddenError";
  }
}

export function ctxCan(ctx: TenantContext, permission: Permission, opts?: { isOwnerOfRecord?: boolean }): boolean {
  return can(ctx.role, permission, opts);
}

export function assertCan(ctx: TenantContext, permission: Permission, opts?: { isOwnerOfRecord?: boolean }): void {
  if (!ctxCan(ctx, permission, opts)) throw new ForbiddenError(permission);
}

/* Standard JSON 403 for a route handler that catches ForbiddenError. */
export function forbidden(permission: Permission): Response {
  return Response.json({ error: "forbidden", permission }, { status: 403 });
}
