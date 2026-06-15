import "server-only";
import { clerkClient } from "@clerk/nextjs/server";

/* Seat counting for usage / billing meters. A workspace's seats-used is the
   number of members in its Clerk organization; a personal workspace (no org) is
   always a single seat. Best-effort: any failure resolves to 1 so the meters
   never hard-fail on a Clerk read. */
export async function workspaceMemberCount(orgId: string | null): Promise<number> {
  if (!orgId) return 1;
  try {
    const client = await clerkClient();
    const org = await client.organizations.getOrganization({ organizationId: orgId });
    return Math.max(1, org.membersCount ?? 1);
  } catch {
    return 1;
  }
}
