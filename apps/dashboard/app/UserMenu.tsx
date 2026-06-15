"use client";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { useUser, useClerk } from "@clerk/nextjs";

/* Custom account menu — replaces Clerk's <UserButton> popover (dark-on-dark,
   unstyled). Portal-rendered, opens UPWARD from the sidebar foot, themed to match. */
export function UserMenu() {
  const { user } = useUser();
  const clerk = useClerk();
  const [open, setOpen] = useState(false);
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

  if (!user) return null;
  const name = user.fullName || user.primaryEmailAddress?.emailAddress?.split("@")[0] || "Account";
  const email = user.primaryEmailAddress?.emailAddress;
  const img = user.imageUrl;

  // anchor BELOW the trigger (it now lives in the top header), right-aligned so
  // a wide menu never overflows the viewport edge.
  const menuW = 248;
  const menuStyle: CSSProperties = rect
    ? { position: "fixed", top: rect.bottom + 8, left: Math.max(8, rect.right - menuW), width: menuW, zIndex: 1000 }
    : { display: "none" };

  return (
    <>
      <button ref={triggerRef} type="button" className="org-trigger" onClick={() => { if (!open) place(); setOpen((o) => !o); }} aria-expanded={open} aria-haspopup="menu">
        {img ? <img src={img} alt="" width={24} height={24} style={{ borderRadius: "50%", objectFit: "cover", flexShrink: 0 }} /> : <span style={{ width: 24, height: 24, borderRadius: "50%", background: "var(--accent-surface)", display: "inline-flex", alignItems: "center", justifyContent: "center", fontWeight: 600 }}>{name[0]?.toUpperCase()}</span>}
        <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", textAlign: "left", fontWeight: 550 }}>{name}</span>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" style={{ opacity: 0.55, flexShrink: 0 }}><path d="M6 9l6 6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
      </button>
      {open && typeof document !== "undefined" && createPortal(
        <div ref={menuRef} className="select-menu" style={menuStyle} role="menu">
          <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 11px 11px" }}>
            {img ? <img src={img} alt="" width={32} height={32} style={{ borderRadius: "50%", objectFit: "cover" }} /> : <span style={{ width: 32, height: 32, borderRadius: "50%", background: "var(--accent-surface)", display: "inline-flex", alignItems: "center", justifyContent: "center", fontWeight: 600 }}>{name[0]?.toUpperCase()}</span>}
            <div style={{ minWidth: 0 }}>
              <div style={{ fontWeight: 600, fontSize: 13, overflow: "hidden", textOverflow: "ellipsis" }}>{name}</div>
              {email && <div className="row-cost" style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{email}</div>}
            </div>
          </div>
          <div className="org-menu-sep" />
          <a href="/settings" className="select-opt" onClick={() => setOpen(false)} role="menuitem">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none"><path d="M12 15a3 3 0 100-6 3 3 0 000 6z" stroke="currentColor" strokeWidth="1.8"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-2.92.92V21a2 2 0 11-4 0v-.09A1.65 1.65 0 006.78 19l-.06.06a2 2 0 11-2.83-2.83l.06-.06A1.65 1.65 0 004 13.4H3a2 2 0 110-4h.09A1.65 1.65 0 005 6.78l-.06-.06a2 2 0 112.83-2.83l.06.06A1.65 1.65 0 0010 4.6V3a2 2 0 114 0v.09a1.65 1.65 0 002.92.92l.06-.06a2 2 0 112.83 2.83l-.06.06a1.65 1.65 0 00.92 2.92H21a2 2 0 110 4h-.09a1.65 1.65 0 00-1.51 1z" stroke="currentColor" strokeWidth="1.4"/></svg>
            Manage account
          </a>
          <button type="button" className="select-opt" onClick={() => { setOpen(false); clerk.signOut({ redirectUrl: "/sign-in" }); }} role="menuitem" style={{ color: "var(--error)" }}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none"><path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4M16 17l5-5-5-5M21 12H9" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/></svg>
            Sign out
          </button>
        </div>,
        document.body,
      )}
    </>
  );
}
