"use client";
import { useEffect, useRef, useState } from "react";
import { useOrganization, useUser } from "@clerk/nextjs";
import {
  ROLES,
  ROLE_LABEL,
  ROLE_PERMISSIONS,
  appRoleFromClerk,
  clerkRoleFor,
  roleAtLeast,
  type Role,
} from "@os/schemas";
import { Modal, Field, Notice } from "../Modal";
import { Select } from "../Select";
import { confirmDialog } from "../confirm";

/* Custom organization management — replaces Clerk's <OrganizationProfile>. The
   product has four app roles (owner > admin > member > viewer) but Clerk only
   ships org:admin / org:member, so we persist the finer grade (owner/viewer) in
   the org's publicMetadata.roles[userId] map and keep Clerk's two roles in sync
   underneath via clerkRoleFor(). The org creator is the Owner; ownership can be
   transferred. Seat invites are blocked once the plan's seat quota is reached. */

type RolesMap = Record<string, Role>;
const ASSIGNABLE: Role[] = [...ROLES]; // owner/admin/member/viewer (owner via transfer)
// Options for the role dropdowns (owner is granted only by transferring ownership).
const ROLE_OPTIONS = ASSIGNABLE.filter((r) => r !== "owner").map((r) => ({ value: r, label: ROLE_LABEL[r] }));

/* Read the publicMetadata bag the org keeps for app roles + the pinned owner. */
function metaRoles(org: any): { roles: RolesMap; owner?: string } {
  const meta = (org?.publicMetadata ?? {}) as { roles?: RolesMap; owner?: string };
  return { roles: meta.roles ?? {}, owner: meta.owner };
}

/* The app role a member is displayed/treated as. */
function memberAppRole(org: any, m: any): Role {
  const { roles, owner } = metaRoles(org);
  const uid = m.publicUserData?.userId ?? m.userId;
  return appRoleFromClerk({
    clerkRole: m.role,
    isCreator: uid === (owner ?? org.createdBy),
    override: uid ? roles[uid] : undefined,
  });
}

export function OrgSettings() {
  const { organization, membership, memberships, invitations, isLoaded } = useOrganization({
    memberships: { infinite: true },
    invitations: { infinite: true },
  });
  const { user } = useUser();
  if (!isLoaded || !organization) return <div className="card"><div className="sub">Loading organization…</div></div>;

  const myRole = memberAppRole(organization, { role: membership?.role, publicUserData: { userId: user?.id } });
  const canManageMembers = roleAtLeast(myRole, "admin"); // owner + admin
  const isOwner = myRole === "owner";

  return (
    <div className="card" style={{ padding: "4px 22px" }}>
      <OrgProfile organization={organization} canEdit={canManageMembers} />
      <Members organization={organization} memberships={memberships} canManage={canManageMembers} isOwner={isOwner} meId={user?.id} />
      {canManageMembers && <Invitations organization={organization} invitations={invitations} memberships={memberships} />}
      <RoleSummary />
      <AuditLog />
      <OrgDanger organization={organization} membership={membership} isOwner={isOwner} />
    </div>
  );
}

function OrgProfile({ organization, canEdit }: any) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(organization.name);
  const [busy, setBusy] = useState(false); const [err, setErr] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const save = async () => { setBusy(true); setErr(""); try { await organization.update({ name }); setOpen(false); } catch (e: any) { setErr(e?.errors?.[0]?.longMessage ?? "Failed"); } setBusy(false); };
  const logo = async (f: File) => { try { await organization.setLogo({ file: f }); } catch { /* ignore */ } };
  return (
    <div className="set-section">
      <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
        {organization.hasImage ? <img src={organization.imageUrl} alt="" className="set-avatar" style={{ borderRadius: 12 }} /> : <span style={{ width: 56, height: 56, borderRadius: 12, background: "var(--accent-surface)", border: "1px solid var(--border-subtle)", display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: 22, fontWeight: 600 }}>{organization.name[0]?.toUpperCase()}</span>}
        <div style={{ flex: 1 }}><div className="set-section-title">{organization.name}</div><div className="set-section-sub">{organization.membersCount} member(s)</div></div>
        {canEdit && <><button className="btn" onClick={() => fileRef.current?.click()} style={{ padding: "8px 14px", fontSize: 12 }}>Logo</button><button className="btn" onClick={() => setOpen(true)} style={{ padding: "8px 14px", fontSize: 12 }}>Edit</button></>}
        <input ref={fileRef} type="file" accept="image/*" hidden onChange={(e) => e.target.files?.[0] && logo(e.target.files[0])} />
      </div>
      <Modal open={open} onClose={() => setOpen(false)} title="Organization profile" width={420}>
        <Notice>{err}</Notice>
        <Field label="Name"><input className="input" value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}><button className="btn" onClick={() => setOpen(false)}>Cancel</button><button className="btn btn-primary" onClick={save} disabled={busy}>{busy ? "Saving…" : "Save"}</button></div>
      </Modal>
    </div>
  );
}

function Members({ organization, memberships, canManage, isOwner, meId }: any) {
  const rows = memberships?.data ?? [];
  const [busyId, setBusyId] = useState<string | null>(null);

  /* Set a member's app role: write the finer grade into publicMetadata.roles and
     keep the Clerk role in sync (owner/admin → org:admin, member/viewer → org:member). */
  const changeRole = async (m: any, appRole: Role) => {
    const uid = m.publicUserData?.userId ?? m.userId;
    setBusyId(m.id);
    try {
      const { roles } = metaRoles(organization);
      const next: RolesMap = { ...roles, [uid]: appRole };
      await organization.update({ publicMetadata: { ...(organization.publicMetadata ?? {}), roles: next } });
      const clerkRole = clerkRoleFor(appRole);
      if (m.role !== clerkRole) await m.update({ role: clerkRole });
      memberships?.revalidate?.();
    } catch { /* ignore */ }
    setBusyId(null);
  };

  /* Transfer ownership: pin the new owner in publicMetadata, promote them in
     Clerk, and demote the previous owner to admin. Owner-only. */
  const transfer = async (m: any) => {
    const uid = m.publicUserData?.userId ?? m.userId;
    const who = [m.publicUserData?.firstName, m.publicUserData?.lastName].filter(Boolean).join(" ") || m.publicUserData?.identifier;
    if (!(await confirmDialog({ title: `Transfer ownership to ${who}?`, message: "They become the Owner; you become an Admin. Only an Owner can delete the org or transfer it again.", confirmText: "Transfer ownership", danger: true }))) return;
    setBusyId(m.id);
    try {
      const { roles } = metaRoles(organization);
      const next: RolesMap = { ...roles, [uid]: "owner", ...(meId ? { [meId]: "admin" as Role } : {}) };
      await organization.update({ publicMetadata: { ...(organization.publicMetadata ?? {}), roles: next, owner: uid } });
      await m.update({ role: "org:admin" });
      memberships?.revalidate?.();
    } catch { /* ignore */ }
    setBusyId(null);
  };

  const remove = async (m: any) => { if (await confirmDialog({ title: "Remove this member?", message: "They'll lose access to this organization.", confirmText: "Remove", danger: true })) { await m.destroy(); memberships?.revalidate?.(); } };

  return (
    <div className="set-section">
      <div className="set-section-title">Members</div>
      <div className="set-section-sub" style={{ marginBottom: 6 }}>People in this organization.</div>
      {rows.map((m: any) => {
        const u = m.publicUserData ?? {};
        const isMe = u.userId === meId;
        const appRole = memberAppRole(organization, m);
        const isTheOwner = appRole === "owner";
        // An owner row is never editable here (use Transfer ownership instead).
        const editable = canManage && !isTheOwner;
        return (
          <div key={m.id} className="set-row">
            {u.imageUrl ? <img src={u.imageUrl} alt="" style={{ width: 28, height: 28, borderRadius: "50%" }} /> : <span style={{ width: 28, height: 28, borderRadius: "50%", background: "var(--accent-surface)", display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: 12, fontWeight: 600 }}>{(u.firstName ?? u.identifier ?? "?")[0]?.toUpperCase()}</span>}
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 550 }}>{[u.firstName, u.lastName].filter(Boolean).join(" ") || u.identifier}{isMe && <span className="row-cost" style={{ marginLeft: 6 }}>you</span>}</div>
              <div className="row-cost">{u.identifier}</div>
            </div>
            {editable ? (
              <Select value={appRole} onChange={(v) => changeRole(m, v as Role)} options={ROLE_OPTIONS} width={118} ariaLabel="Member role" disabled={busyId === m.id} />
            ) : <span className={`badge ${isTheOwner ? "b-accent" : "b-neutral"}`}><span className="d" />{ROLE_LABEL[appRole]}</span>}
            {isOwner && !isMe && !isTheOwner && <button className="btn" onClick={() => transfer(m)} disabled={busyId === m.id} style={{ padding: "5px 10px", fontSize: 11 }}>Make owner</button>}
            {canManage && !isMe && !isTheOwner && <button className="btn danger" onClick={() => remove(m)} style={{ padding: "5px 10px", fontSize: 11 }}>Remove</button>}
          </div>
        );
      })}
    </div>
  );
}

function Invitations({ organization, invitations, memberships }: any) {
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState(""); const [role, setRole] = useState<Role>("member");
  const [busy, setBusy] = useState(false); const [err, setErr] = useState("");
  const rows = invitations?.data ?? [];

  // Open source — unlimited seats, no enforcement.
  const used = (organization.membersCount ?? memberships?.data?.length ?? 1) + rows.length;

  const invite = async () => {
    setBusy(true); setErr("");
    try {
      await organization.inviteMember({ emailAddress: email, role: clerkRoleFor(role) });
      // Pin the finer grade so the invitee resolves to the chosen app role on join.
      if (role === "viewer" || role === "admin") {
        // (Their userId isn't known until they accept; the role select on the
        //  member row applies the precise grade afterwards. We still record the
        //  Clerk role above, which is the correct coarse grade.)
      }
      setEmail(""); setOpen(false); invitations?.revalidate?.();
    } catch (e: any) { setErr(e?.errors?.[0]?.longMessage ?? "Failed to invite"); }
    setBusy(false);
  };
  const revoke = async (inv: any) => { await inv.revoke(); invitations?.revalidate?.(); };

  return (
    <div className="set-section">
      <div style={{ display: "flex", alignItems: "center", marginBottom: 6 }}>
        <div><div className="set-section-title">Invitations</div><div className="set-section-sub">{used} teammate(s) on this workspace. Open source — unlimited seats.</div></div>
        <button className="btn" onClick={() => setOpen(true)} style={{ marginLeft: "auto", padding: "8px 14px", fontSize: 12 }}>+ Invite</button>
      </div>
      {rows.length === 0 ? <div className="sub" style={{ padding: "6px 0" }}>No pending invitations.</div> : rows.map((inv: any) => (
        <div key={inv.id} className="set-row"><span style={{ flex: 1 }}>{inv.emailAddress}</span><span className="badge b-neutral"><span className="d" />{ROLE_LABEL[(appRoleFromClerk({ clerkRole: inv.role }))]}</span><span className="badge b-warn"><span className="d" />pending</span><button className="btn danger" onClick={() => revoke(inv)} style={{ padding: "5px 10px", fontSize: 11 }}>Revoke</button></div>
      ))}
      <Modal open={open} onClose={() => setOpen(false)} title="Invite a teammate" width={420}>
        <Notice>{err}</Notice>
        <Field label="Email"><input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="teammate@example.com" /></Field>
        <Field label="Role" hint="Owner is assigned only by transferring ownership."><Select value={role} onChange={(v) => setRole(v as Role)} options={ROLE_OPTIONS} ariaLabel="Invite role" /></Field>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}><button className="btn" onClick={() => setOpen(false)}>Cancel</button><button className="btn btn-primary" onClick={invite} disabled={busy || !email}>{busy ? "Sending…" : "Send invite"}</button></div>
      </Modal>
    </div>
  );
}

/* What each role can do — a compact summary built from the shared permission map. */
function RoleSummary() {
  const blurb: Record<Role, string> = {
    owner: "Full control, incl. deleting the org and transferring ownership.",
    admin: "Manage members, brands, devices, schedules and API keys; edit any content.",
    member: "Create, edit own content, publish, run the planner and queue renders.",
    viewer: "Read-only — can view analytics, nothing else.",
  };
  return (
    <div className="set-section">
      <div className="set-section-title">Roles & permissions</div>
      <div className="set-section-sub" style={{ marginBottom: 8 }}>What each role can do in this workspace.</div>
      {ROLES.map((r) => (
        <div key={r} className="set-row" style={{ alignItems: "flex-start" }}>
          <span className={`badge ${r === "owner" ? "b-accent" : "b-neutral"}`} style={{ marginTop: 1 }}><span className="d" />{ROLE_LABEL[r]}</span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 12.5 }}>{blurb[r]}</div>
            <div className="row-cost" style={{ marginTop: 2 }}>{ROLE_PERMISSIONS[r].length} permission(s)</div>
          </div>
        </div>
      ))}
    </div>
  );
}

type AuditEntry = { at: string; userId: string | null; action: string; target?: string; meta?: Record<string, unknown> };

/* The workspace audit trail, fetched from /api/audit (gated server-side on
   audit.view; a 403 simply renders the empty/locked note). */
function AuditLog() {
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);
  const [locked, setLocked] = useState(false);
  useEffect(() => {
    let alive = true;
    fetch("/api/audit?limit=50")
      .then((r) => { if (r.status === 403) { setLocked(true); throw new Error("forbidden"); } return r.json(); })
      .then((d) => { if (alive) setEntries(d.entries ?? []); })
      .catch(() => { if (alive) setEntries([]); });
    return () => { alive = false; };
  }, []);
  return (
    <div className="set-section">
      <div className="set-section-title">Audit log</div>
      <div className="set-section-sub" style={{ marginBottom: 8 }}>Recent member-facing changes in this workspace.</div>
      {locked ? <div className="sub" style={{ padding: "6px 0" }}>You don't have permission to view the audit log.</div>
        : entries === null ? <div className="sub" style={{ padding: "6px 0" }}>Loading…</div>
        : entries.length === 0 ? <div className="sub" style={{ padding: "6px 0" }}>No activity recorded yet.</div>
        : entries.map((e, i) => (
            <div key={i} className="set-row" style={{ fontSize: 12.5 }}>
              <span className="badge b-neutral" style={{ minWidth: 0 }}><span className="d" />{e.action}</span>
              <span style={{ flex: 1, minWidth: 0, color: "var(--text-secondary)" }}>{e.target ?? ""}</span>
              <span className="row-cost">{new Date(e.at).toLocaleString()}</span>
            </div>
          ))}
    </div>
  );
}

function OrgDanger({ organization, membership, isOwner }: any) {
  const [busy, setBusy] = useState(false);
  const leave = async () => { if (await confirmDialog({ title: "Leave this organization?", message: "You'll need a new invite to rejoin.", confirmText: "Leave", danger: true })) { setBusy(true); try { await membership?.destroy(); location.href = "/settings"; } catch { setBusy(false); } } };
  const del = async () => { if (await confirmDialog({ title: `Delete "${organization.name}"?`, message: "This cannot be undone.", confirmText: "Delete organization", danger: true })) { setBusy(true); try { await organization.destroy(); location.href = "/settings"; } catch { setBusy(false); } } };
  return (
    <div className="set-section">
      <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
        <div style={{ flex: 1 }}><div className="set-section-title" style={{ color: "var(--error)" }}>Danger zone</div><div className="set-section-sub">{isOwner ? "Permanently delete this organization." : "Leave this organization."}</div></div>
        {!isOwner && <button className="btn danger" onClick={leave} disabled={busy} style={{ padding: "8px 14px", fontSize: 12 }}>Leave</button>}
        {isOwner && <button className="btn danger" onClick={del} disabled={busy} style={{ padding: "8px 14px", fontSize: 12 }}>Delete org</button>}
      </div>
    </div>
  );
}
