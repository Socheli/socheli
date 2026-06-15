"use client";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Sidebar } from "./Sidebar";
import { Header } from "./Header";
import { GuideOverlay } from "./GuideOverlay";
import type { GuideSpec } from "../lib/agent/guide-spec";

/* The dashboard chrome (header + sidebar + main) renders only on app routes.
   Auth routes (/sign-in, /sign-up) are standalone full-screen pages with no app
   navigation — so a signed-out visitor never sees the product's internals.

   Two nav modes: desktop collapses the rail to an icon column (`nav-collapsed`),
   mobile slides it in as an overlay drawer (`nav-open`). One toggle drives the
   right one based on viewport. */
const isAuthRoute = (p: string) => p.startsWith("/sign-in") || p.startsWith("/sign-up");
const isMobile = () => typeof window !== "undefined" && window.matchMedia("(max-width: 900px)").matches;

export function AppShell({ children }: { children: ReactNode }) {
  const path = usePathname();
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => {
    try { setCollapsed(localStorage.getItem("socheli.nav.collapsed") === "1"); } catch {}
  }, []);
  useEffect(() => {
    document.body.classList.toggle("nav-collapsed", collapsed);
    try { localStorage.setItem("socheli.nav.collapsed", collapsed ? "1" : "0"); } catch {}
    return () => { document.body.classList.remove("nav-collapsed"); };
  }, [collapsed]);
  useEffect(() => {
    document.body.classList.toggle("nav-open", mobileOpen);
    return () => { document.body.classList.remove("nav-open"); };
  }, [mobileOpen]);

  // Close the mobile drawer whenever the route changes.
  useEffect(() => { setMobileOpen(false); }, [path]);

  const toggleNav = useCallback(() => {
    if (isMobile()) setMobileOpen((v) => !v);
    else setCollapsed((v) => !v);
  }, []);

  // When Soli guides to a sidebar control, make sure that surface is on
  // screen: mobile slides the drawer in; the desktop rail is always visible.
  const revealForGuide = useCallback((spec: GuideSpec) => {
    const needsRail = spec.steps.some((s) => (s.target ?? "").startsWith("nav:") || s.target === "new-post");
    if (needsRail && isMobile()) setMobileOpen(true);
  }, []);

  if (isAuthRoute(path)) return <>{children}</>;
  return (
    <div className="layout">
      <Sidebar collapsed={collapsed} onToggle={toggleNav} onNavigate={() => setMobileOpen(false)} />
      <div className="nav-scrim" onClick={() => setMobileOpen(false)} aria-hidden />
      <div className="app-content">
        <Header onToggleNav={toggleNav} />
        <main className="main">{children}</main>
      </div>
      <GuideOverlay onReveal={revealForGuide} />
    </div>
  );
}
