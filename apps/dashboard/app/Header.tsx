"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Menu, Search } from "lucide-react";
import { Show } from "@clerk/nextjs";
import { OrgSwitcher } from "./OrgSwitcher";
import { UserMenu } from "./UserMenu";
import { SoliMark } from "./copilot/SoliMark";
import { crumbFor, PRIMARY } from "./nav";

/* The platform header — a thin sticky bar swept across the top of the content
   column. Left: nav toggle + breadcrumb. Right: Ask-Soli command, New-post
   action, workspace switcher, account menu. Workspace + account moved here from
   the sidebar so the rail is pure navigation. */

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

export function Header({ onToggleNav }: { onToggleNav: () => void }) {
  const path = usePathname() || "/";
  const crumb = crumbFor(path);
  const PrimaryIcon = PRIMARY.icon;
  const askSoli = () => window.dispatchEvent(new CustomEvent("soli:open"));
  const openSearch = () => window.dispatchEvent(new CustomEvent("hypersearch:open"));

  return (
    <header className="app-header">
      <button className="hdr-icon-btn hdr-menu" onClick={onToggleNav} type="button" aria-label="Toggle navigation" title="Toggle navigation">
        <Menu size={17} />
      </button>

      <nav className="hdr-crumb" aria-label="Breadcrumb">
        <Link href="/" className="hdr-crumb-root">Socheli</Link>
        {crumb.section && (
          <>
            <span className="hdr-crumb-sep">/</span>
            <span className="hdr-crumb-sec">{crumb.section}</span>
          </>
        )}
        <span className="hdr-crumb-sep">/</span>
        <span className="hdr-crumb-cur">{crumb.label}</span>
      </nav>

      <div className="hdr-spacer" />

      <button className="hdr-search" onClick={openSearch} type="button" title="Search everything (⌘/)">
        <Search size={14} strokeWidth={2} />
        <span className="hdr-search-text">Search…</span>
        <kbd className="hdr-kbd">{isMac ? "⌘" : "Ctrl"} /</kbd>
      </button>

      <button className="hdr-soli" onClick={askSoli} type="button" title="Ask Soli (⌘K)">
        <SoliMark size={15} className="hdr-soli-mark" />
        <span className="hdr-soli-text">Ask Soli</span>
        <kbd className="hdr-kbd">{isMac ? "⌘" : "Ctrl"} K</kbd>
      </button>

      <Link href={PRIMARY.href} className="hdr-new" title={PRIMARY.label}>
        <PrimaryIcon size={15} strokeWidth={2.2} />
        <span className="hdr-new-text">{PRIMARY.label}</span>
      </Link>

      <span className="hdr-div" />

      <Show when="signed-in">
        <div className="hdr-org"><OrgSwitcher /></div>
        <UserMenu />
      </Show>
      <Show when="signed-out">
        <Link href="/sign-in" className="hdr-new"><span className="hdr-new-text">Sign in</span></Link>
      </Show>
    </header>
  );
}
