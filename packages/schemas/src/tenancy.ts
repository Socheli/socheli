import { z } from "zod";

/* ════════════════════════════════════════════════════════════════════════
   TENANCY — the multi-member / organization model, shared everywhere.

   Socheli is file-based and was single-tenant. This module makes every record
   belong to a WORKSPACE and gives a single permission vocabulary that the
   dashboard, the API server, the engine and the agent all import. A storyboard,
   brand, plan post or job that is "in workspace W" is the same fact everywhere.

   - A WORKSPACE is the tenant boundary. It is either a Clerk organization
     (id `org_…`) or a person's private space (`user_<userId>`).
   - Every record carries an optional `workspaceId` + `createdBy` (the Clerk
     user id of the author). They are OPTIONAL so legacy records still validate;
     the migration stamps them, and unstamped records resolve to DEFAULT_WORKSPACE.
   - ROLES are app-level (owner > admin > member > viewer). They are derived from
     the Clerk org role plus an app override stored in org publicMetadata, so we
     get a `viewer` and an `owner` without requiring Clerk custom-role config.
   ════════════════════════════════════════════════════════════════════════ */

/* The workspace that owns all pre-tenancy data. The migration stamps existing
   records with this; reads treat an unstamped record as belonging here. Override
   with SOCHELI_DEFAULT_WORKSPACE for an existing single-tenant deployment whose
   data should land in a specific org. */
export const DEFAULT_WORKSPACE = "ws_default";

/* Build the canonical workspace id from a Clerk org id (preferred) or, for a
   person with no active org, their personal space. Keep this the ONE place that
   decides the id so every surface agrees.

   SINGLE-TENANT MODE: a solo deployment (one operator, all data in the default
   workspace) sets SOCHELI_SINGLE_TENANT=1 — then every session resolves to
   DEFAULT_WORKSPACE, so the operator sees all their pre-tenancy data whether
   they're in a personal account or an auto-created org. Unset = full per-user /
   per-org isolation (multi-tenant SaaS). */
export function workspaceIdFor(opts: { orgId?: string | null; userId?: string | null }): string {
  if (typeof process !== "undefined" && process.env?.SOCHELI_SINGLE_TENANT === "1") return DEFAULT_WORKSPACE;
  if (opts.orgId) return opts.orgId; // Clerk org ids are already prefixed `org_`
  if (opts.userId) return `user_${opts.userId}`;
  return DEFAULT_WORKSPACE;
}

export const isPersonalWorkspace = (workspaceId: string) => workspaceId.startsWith("user_");

/* ─── Roles ──────────────────────────────────────────────────────────────── */
export const ROLES = ["owner", "admin", "member", "viewer"] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_RANK: Record<Role, number> = { owner: 3, admin: 2, member: 1, viewer: 0 };
export const roleAtLeast = (role: Role, min: Role) => ROLE_RANK[role] >= ROLE_RANK[min];

export const ROLE_LABEL: Record<Role, string> = {
  owner: "Owner",
  admin: "Admin",
  member: "Member",
  viewer: "Viewer",
};

/* Clerk only ships `org:admin` / `org:member`. We map those to app roles and let
   an app override (publicMetadata.roles[userId] = "owner" | "viewer" | …) refine
   them — so a workspace can grant a read-only `viewer` or pin the `owner`. */
export function appRoleFromClerk(opts: {
  clerkRole?: string | null; // "org:admin" | "org:member" | …
  isCreator?: boolean; // membership.userId === organization.createdBy
  override?: string | null; // org publicMetadata.roles[userId]
  personal?: boolean; // no active org → user is sole owner of their space
}): Role {
  if (opts.personal) return "owner";
  if (opts.override && (ROLES as readonly string[]).includes(opts.override)) return opts.override as Role;
  if (opts.isCreator) return "owner";
  if (opts.clerkRole === "org:admin") return "admin";
  return "member";
}

/* Map an app role back to the Clerk role to use when inviting / updating a
   member through Clerk's API (owner/admin → org:admin, member/viewer → org:member).
   The finer grade (owner/viewer) is persisted in org publicMetadata separately. */
export const clerkRoleFor = (role: Role): "org:admin" | "org:member" =>
  roleAtLeast(role, "admin") ? "org:admin" : "org:member";

/* ─── Permissions ────────────────────────────────────────────────────────── */
/* Every gated action in the product. Keep this list as the single vocabulary;
   UI, API and agent all check against it. `*.own` means "only records the
   current user authored"; the caller pairs it with an ownership check. */
export const PERMISSIONS = [
  "content.create",
  "content.edit.any",
  "content.edit.own",
  "content.delete.any",
  "content.delete.own",
  "content.publish",
  "queue.dispatch", // start a render / generation job
  "queue.cancel",
  "calendar.edit", // edit/move/plan posts on the calendar
  "plan.run", // run the algo planner
  "brand.manage", // create/edit/delete brands
  "schedule.manage", // autopilot cadence
  "device.manage", // render fleet
  "analytics.view",
  "member.invite",
  "member.remove",
  "member.role", // change a member's role
  "billing.manage",
  "apikey.manage", // issue/revoke API keys
  "org.settings", // edit org profile
  "org.delete",
  "audit.view",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

/* Role → granted permissions. Owner gets everything implicitly. */
const MEMBER_PERMS: Permission[] = [
  "content.create",
  "content.edit.own",
  "content.delete.own",
  "content.publish",
  "queue.dispatch",
  "queue.cancel",
  "calendar.edit",
  "plan.run",
  "analytics.view",
];

const ADMIN_PERMS: Permission[] = [
  ...MEMBER_PERMS,
  "content.edit.any",
  "content.delete.any",
  "brand.manage",
  "schedule.manage",
  "device.manage",
  "member.invite",
  "member.remove",
  "member.role",
  "apikey.manage",
  "org.settings",
  "audit.view",
];

const VIEWER_PERMS: Permission[] = ["analytics.view"];

export const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  owner: [...PERMISSIONS],
  admin: ADMIN_PERMS,
  member: MEMBER_PERMS,
  viewer: VIEWER_PERMS,
};

/* The core authorization check. `can(role, "content.edit.any")`. For `*.own`
   actions pass `{ isOwnerOfRecord }` and we also accept the matching `.any`. */
export function can(
  role: Role,
  permission: Permission,
  ctx?: { isOwnerOfRecord?: boolean },
): boolean {
  const granted = ROLE_PERMISSIONS[role] ?? [];
  // For an *.own action, a `.any` grant always wins; otherwise the `.own` grant
  // applies only when the caller actually owns the record.
  if (permission.endsWith(".own")) {
    const any = permission.replace(/\.own$/, ".any") as Permission;
    if (granted.includes(any)) return true;
    if (granted.includes(permission)) return ctx?.isOwnerOfRecord !== false;
    return false;
  }
  return granted.includes(permission);
}

/* ─── The request context every scoped surface threads through ───────────── */
export type TenantContext = {
  workspaceId: string;
  userId: string | null; // Clerk user id (or null for legacy/static-key callers)
  orgId: string | null; // active Clerk org id, if any
  role: Role;
  plan: string; // PlanId — kept as string here to avoid a schemas↔billing dep
  via: "session" | "apikey" | "system"; // how the caller authenticated
};

/* A system/owner context for migrations, cron, the CLI and trusted scripts. */
export const systemContext = (workspaceId = DEFAULT_WORKSPACE): TenantContext => ({
  workspaceId,
  userId: null,
  orgId: workspaceId.startsWith("org_") ? workspaceId : null,
  role: "owner",
  plan: "team",
  via: "system",
});

/* ─── Record-level scoping ───────────────────────────────────────────────── */
/* The optional fields every tenant-owned record carries. Spread into a zod
   object: `z.object({ ...TenantFields, … })`. */
export const TenantFields = {
  workspaceId: z.string().optional(),
  createdBy: z.string().optional(),
};

export type Tenanted = { workspaceId?: string; createdBy?: string };

/* The workspace a record belongs to — unstamped legacy records fall to default. */
export const recordWorkspace = (r: Tenanted | null | undefined): string =>
  r?.workspaceId || DEFAULT_WORKSPACE;

/* Does a record belong to this context's workspace? Personal/legacy records
   (no workspaceId) are visible only inside DEFAULT_WORKSPACE. */
export function recordInWorkspace(r: Tenanted | null | undefined, workspaceId: string): boolean {
  return recordWorkspace(r) === workspaceId;
}

/* Filter a list down to the caller's workspace. The one helper every read path
   uses, so scoping is consistent and impossible to forget piecemeal. */
export function scopeToWorkspace<T extends Tenanted>(items: T[], ctx: { workspaceId: string }): T[] {
  return items.filter((it) => recordInWorkspace(it, ctx.workspaceId));
}

/* Stamp a record as owned by the caller (on create). Never overwrites an
   existing workspaceId — moving a record between workspaces is a deliberate op. */
export function stampOwnership<T extends Tenanted>(record: T, ctx: TenantContext): T {
  if (!record.workspaceId) record.workspaceId = ctx.workspaceId;
  if (!record.createdBy && ctx.userId) record.createdBy = ctx.userId;
  return record;
}

/* True when the context's user authored the record (drives `*.own` checks). */
export function ownsRecord(r: Tenanted | null | undefined, ctx: { userId: string | null }): boolean {
  return !!ctx.userId && !!r?.createdBy && r.createdBy === ctx.userId;
}
