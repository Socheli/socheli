import "server-only";
import { clerkClient } from "@clerk/nextjs/server";
import { appRoleFromClerk, type Role } from "@os/schemas";

/* The roster of teammates in a workspace, for the calendar / queue / plan member
   filters and assignee pickers. A personal workspace (no org) is just the one
   person; an org resolves its Clerk memberships into a lightweight, serialisable
   shape (id + display name + avatar + app role). Best-effort: any Clerk failure
   degrades to an empty list (or the single self member) so a page never hard-fails
   on a roster read. */

export type WorkspaceMember = {
  /** Clerk user id — the value stored in a post's `assignee` / `createdBy`. */
  userId: string;
  name: string;
  email?: string;
  imageUrl?: string;
  role: Role;
};

type ClerkOrg = { createdBy?: string; publicMetadata?: { roles?: Record<string, string> } };

/* Resolve the members visible to a context. `self` is the current viewer used for
   the personal-workspace fallback (so even outside an org you can assign to you). */
export async function listWorkspaceMembers(
  orgId: string | null,
  self?: { userId: string | null; name?: string | null; email?: string | null; imageUrl?: string | null },
): Promise<WorkspaceMember[]> {
  if (!orgId) {
    if (!self?.userId) return [];
    return [{ userId: self.userId, name: self.name || self.email || "You", email: self.email || undefined, imageUrl: self.imageUrl || undefined, role: "owner" }];
  }
  try {
    const client = await clerkClient();
    const org = (await client.organizations.getOrganization({ organizationId: orgId })) as unknown as ClerkOrg;
    const roleOverrides = org.publicMetadata?.roles ?? {};
    const list = await client.organizations.getOrganizationMembershipList({ organizationId: orgId, limit: 100 });
    return (list.data ?? []).map((m) => {
      const pud = m.publicUserData;
      const uid = pud?.userId ?? "";
      const name = [pud?.firstName, pud?.lastName].filter(Boolean).join(" ") || pud?.identifier || uid;
      const role = appRoleFromClerk({
        clerkRole: m.role,
        isCreator: !!uid && org.createdBy === uid,
        override: uid ? roleOverrides[uid] : undefined,
      });
      return { userId: uid, name, email: pud?.identifier ?? undefined, imageUrl: pud?.imageUrl ?? undefined, role };
    }).filter((m) => m.userId);
  } catch {
    return [];
  }
}
