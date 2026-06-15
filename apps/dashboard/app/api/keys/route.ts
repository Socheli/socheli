import { currentContext, assertCan, forbidden } from "../../../lib/tenancy";
import { listKeys, issueKey } from "../../../lib/api-keys";
import { audit } from "../../../lib/audit";
import { ROLES, ROLE_RANK, type Role } from "@os/schemas";

/* Per-workspace API-key management for the Settings → API & Developers tab.
     GET   → list the workspace's keys (no secret material)
     POST  → issue a new key {label, role?}; returns the plaintext ONCE
   Both gate on `apikey.manage` and scope strictly to the caller's workspace. */

export const dynamic = "force-dynamic";

/* Clamp a requested role to the issuer's own — a key never escalates privilege. */
const roleAtMost = (want: Role, ceil: Role): Role => (ROLE_RANK[want] <= ROLE_RANK[ceil] ? want : ceil);

export async function GET() {
  const ctx = await currentContext();
  try {
    assertCan(ctx, "apikey.manage");
  } catch {
    return forbidden("apikey.manage");
  }
  return Response.json({ keys: listKeys(ctx.workspaceId) });
}

export async function POST(req: Request) {
  const ctx = await currentContext();
  try {
    assertCan(ctx, "apikey.manage");
  } catch {
    return forbidden("apikey.manage");
  }

  const body = await req.json().catch(() => ({}));
  const label = String(body.label ?? "").trim();
  if (!label) return Response.json({ error: "label required" }, { status: 400 });

  const requested = (ROLES as readonly string[]).includes(String(body.role)) ? (body.role as Role) : "member";
  const role: Role = roleAtMost(requested, ctx.role);

  const { key, record } = issueKey(ctx, { label, role });
  audit(ctx, "apikey.issue", record.id, { label: record.label, role: record.role });
  return Response.json({ key, record });
}
