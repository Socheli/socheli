"use client";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { useOrganization, useOrganizationList, useUser } from "@clerk/nextjs";
import { Modal } from "./Modal";
import { CreateOrgForm } from "./settings/CreateOrgForm";

/* Custom workspace switcher — replaces Clerk's <OrganizationSwitcher> popover
   (which clipped against the sidebar's scroll container). Portal-rendered so it
   never clips, themed to the dark UI. */

function Avatar({ src, name, size = 22 }: { src?: string | null; name?: string; size?: number }) {
  if (src) return <img src={src} alt="" width={size} height={size} style={{ borderRadius: 6, objectFit: "cover", flexShrink: 0 }} />;
  return <span style={{ width: size, height: size, borderRadius: 6, flexShrink: 0, background: "var(--accent-surface)", border: "1px solid var(--border-interactive)", display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: size * 0.5, fontWeight: 600, color: "var(--text-light)" }}>{(name ?? "?")[0]?.toUpperCase()}</span>;
}

export function OrgSwitcher() {
  const { user } = useUser();
  const { organization } = useOrganization();
  const { userMemberships, setActive, isLoaded } = useOrganizationList({ userMemberships: { infinite: true } });
  const [open, setOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const place = () => triggerRef.current && setRect(triggerRef.current.getBoundingClientRect());
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (triggerRef.current?.contains(e.target as Node) || menuRef.current?.contains(e.target as Node)) return; setOpen(false); };
    const onMove = () => place();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDoc);
    window.addEventListener("scroll", onMove, true);
    window.addEventListener("resize", onMove);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDoc); window.removeEventListener("scroll", onMove, true); window.removeEventListener("resize", onMove); document.removeEventListener("keydown", onKey); };
  }, [open]);

  const personalName = user?.fullName || user?.primaryEmailAddress?.emailAddress?.split("@")[0] || "Personal account";
  const memberships = userMemberships?.data ?? [];
  const choose = async (orgId: string | null) => { setOpen(false); await setActive?.({ organization: orgId }); };

  // Only show the switcher when there's a REAL team to switch to — a workspace
  // that isn't just the user's auto-created personal mirror org. Otherwise the
  // switcher duplicates the account menu chip (the "two identical chips" bug).
  //
  // Mirror detection, in order of confidence:
  //  1. Exact NORMALIZED name match (strip non-alphanumerics, lowercase)
  //     against every identity the user goes by — full name, username, first
  //     name, email prefix. Always a mirror.
  //  2. Prefix match in EITHER direction against those personas, but only for
  //     solo orgs (membersCount <= 1). This catches the auto-created org named
  //     after the username (e.g. "janedoe42") when the only persona Clerk gives
  //     us is fullName "Jane Doe" → "janedoe" — a prefix, not an exact
  //     match, which slipped past the old check and rendered the duplicate
  //     chip. The membersCount guard keeps a genuine team whose name merely
  //     resembles the user's (e.g. "Jane Media") visible once teammates join.
  // Create a real team from Settings → Team to reveal the switcher. (Wait for
  // load so genuine org users don't see it flash absent.)
  const norm = (s?: string | null) => (s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const personas = [user?.fullName, user?.username, user?.firstName, user?.primaryEmailAddress?.emailAddress?.split("@")[0]]
    .map(norm)
    .filter((p) => p.length >= 3);
  const prefixed = (a: string, b: string) =>
    a.length >= 4 && b.length >= 4 && (a.startsWith(b) || b.startsWith(a));
  const mirrorsUser = (org?: { name?: string | null; membersCount?: number | null } | null) => {
    const n = norm(org?.name);
    if (!n) return true; // unnamed → nothing real to switch to
    if (personas.includes(n)) return true;
    const solo = (org?.membersCount ?? 1) <= 1; // unknown count → assume the auto-created solo mirror
    return solo && personas.some((p) => prefixed(p, n));
  };
  const realOrgs = memberships.filter((m) => !mirrorsUser(m.organization));
  const meaningful = realOrgs.length > 0 || (!!organization && !mirrorsUser(organization));
  if (!isLoaded || !meaningful) return null;

  const menuStyle: CSSProperties = rect ? { position: "fixed", top: rect.bottom + 6, left: rect.left, width: Math.max(220, rect.width), zIndex: 1000 } : { display: "none" };

  return (
    <>
      <button ref={triggerRef} type="button" className="org-trigger" onClick={() => { if (!open) place(); setOpen((o) => !o); }} aria-expanded={open} aria-haspopup="listbox">
        <Avatar src={organization?.imageUrl ?? user?.imageUrl} name={organization?.name ?? personalName} />
        <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", textAlign: "left", fontWeight: 550 }}>{organization?.name ?? personalName}</span>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" style={{ opacity: 0.55, flexShrink: 0 }}><path d="M8 9l4-4 4 4M8 15l4 4 4-4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
      </button>
      {open && typeof document !== "undefined" && createPortal(
        <div ref={menuRef} className="select-menu" style={menuStyle} role="listbox">
          <div className="org-menu-head">Accounts</div>
          <button type="button" className={`select-opt${!organization ? " selected" : ""}`} onClick={() => choose(null)}>
            <Avatar src={user?.imageUrl} name={personalName} size={20} />
            <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>{personalName}</span>
            {!organization && <Check />}
          </button>
          {isLoaded && memberships.map((m) => (
            <button key={m.organization.id} type="button" className={`select-opt${organization?.id === m.organization.id ? " selected" : ""}`} onClick={() => choose(m.organization.id)}>
              <Avatar src={m.organization.imageUrl} name={m.organization.name} size={20} />
              <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>{m.organization.name}</span>
              {organization?.id === m.organization.id && <Check />}
            </button>
          ))}
          <div className="org-menu-sep" />
          <button type="button" className="select-opt" onClick={() => { setOpen(false); setCreateOpen(true); }}>
            <span style={{ width: 20, height: 20, borderRadius: 6, display: "inline-flex", alignItems: "center", justifyContent: "center", border: "1px dashed var(--border-interactive)", flexShrink: 0 }}>+</span>
            Create organization
          </button>
        </div>,
        document.body,
      )}
      <Modal open={createOpen} onClose={() => setCreateOpen(false)} title="Create organization" subtitle="Invite teammates and share a Socheli workspace." width={420}>
        <CreateOrgForm compact onDone={() => setCreateOpen(false)} />
      </Modal>
    </>
  );
}

const Check = () => <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M20 6L9 17l-5-5" stroke="var(--accent)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" /></svg>;
