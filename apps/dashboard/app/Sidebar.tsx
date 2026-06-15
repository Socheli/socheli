"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import Link from "next/link";
import { PanelLeftClose, PanelLeft, ChevronRight } from "lucide-react";
import { MEGA, HOME, PRIMARY, WAR_ROOM, type MegaCategory } from "./nav";
import { InkDivider, InkRing, InkIcon } from "../components/sketch";
import { MegaMenu, type MegaAnchor } from "./MegaMenu";
import { useAgent, type AgentContext } from "./copilot/useAgent";
import { ThreadManager } from "./copilot/ThreadManager";

/* The primary navigation rail — v3, a MEGA-MENU rail. The pinned trio (the
   New-post CTA, Soli/home, War Room) stays prominent up top — the daily
   entries. Below them the six classic sections collapse into ~5 CATEGORY ROWS
   (Create · Publish · Grow · Engage · Manage), each a quiet button with its
   representative icon + label + chevron. The 22-destination list is gone from
   the rail; each category instead opens a rich flyout MegaMenu panel listing
   its destinations.

   Interaction model:
     • desktop — hover a row (with a small open/close delay so travelling
       between rail and panel never flickers) OR click it (sticky) to open the
       flyout. The panel is fixed/anchored to the right of the rail, so it
       overlays content with no layout shift. Esc, outside-click and route
       change all close it.
     • collapsed rail (body.nav-collapsed, 72px) — rows go icon-only and the
       flyout still flies out on hover/click. This is the ideal mega-menu UX.
     • mobile drawer (narrow) — flyouts don't work on touch, so tapping a
       category expands its items INLINE as an accordion instead.

   The collapse toggle + mobile drawer behaviour from the AppShell are
   preserved untouched. */

const isMobileMq = () =>
  typeof window !== "undefined" && window.matchMedia("(max-width: 900px)").matches;

function isActive(path: string, href: string) {
  return href === "/" ? path === "/" : path === href || path.startsWith(href + "/");
}
function catActive(path: string, cat: MegaCategory) {
  return cat.columns.some((c) => c.links.some((l) => isActive(path, l.href)));
}

const HOVER_OPEN_MS = 90;
const HOVER_CLOSE_MS = 180;

export function Sidebar({ collapsed, onToggle, onNavigate }: { collapsed: boolean; onToggle: () => void; onNavigate?: () => void }) {
  const path = usePathname();
  const router = useRouter();
  const HomeIcon = HOME.icon;
  const WarRoomIcon = WAR_ROOM.icon;
  const PrimaryIcon = PRIMARY.icon;

  // Inline chat history over the shared copilot thread store. The context is a
  // light page hint (this surface never sends — picking a thread routes to "/"
  // where the conversation lives), so it stays stable to avoid resubscribing.
  const histContext = useMemo<AgentContext>(() => ({ page: path }), [path]);
  const {
    threads, folders, activeThreadId,
    newThread, switchThread, deleteThread, renameThread,
    pinThread, unpinThread, moveThread, newFolder, renameFolder, deleteFolder,
  } = useAgent(histContext);

  // Picking a thread switches the active conversation and navigates home, where
  // Soli renders it. A "New chat" also lands on "/".
  const pickThread = useCallback((id: string) => {
    switchThread(id);
    onNavigate?.();
    if (path !== "/") router.push("/");
  }, [switchThread, onNavigate, path, router]);
  const startNew = useCallback(() => {
    newThread();
    onNavigate?.();
    if (path !== "/") router.push("/");
  }, [newThread, onNavigate, path, router]);

  // Which category's flyout (desktop) / accordion (mobile) is open.
  const [open, setOpen] = useState<string | null>(null);
  const [anchor, setAnchor] = useState<MegaAnchor>({ top: 0, left: 0 });
  // Sticky = opened by an explicit click (vs. transient hover); stays until
  // dismissed rather than closing on mouse-leave.
  const [sticky, setSticky] = useState(false);
  const [mobile, setMobile] = useState(false);

  const rowRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const triggerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const mq = window.matchMedia("(max-width: 900px)");
    const sync = () => setMobile(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);

  const clearTimers = () => {
    if (openTimer.current) { clearTimeout(openTimer.current); openTimer.current = null; }
    if (closeTimer.current) { clearTimeout(closeTimer.current); closeTimer.current = null; }
  };

  const close = useCallback(() => {
    clearTimers();
    setOpen(null);
    setSticky(false);
  }, []);

  // Anchor the flyout to the top of the hovered/clicked row.
  const anchorTo = useCallback((key: string) => {
    const el = rowRefs.current[key];
    if (!el) return;
    const r = el.getBoundingClientRect();
    // 8px gap to the right of the rail; align the panel's top to the row's top.
    setAnchor({ top: Math.max(12, r.top), left: r.right + 8 });
  }, []);

  const openCat = useCallback((key: string, asSticky: boolean) => {
    clearTimers();
    anchorTo(key);
    triggerRef.current = rowRefs.current[key];
    setOpen(key);
    if (asSticky) setSticky(true);
  }, [anchorTo]);

  // Hover intent (desktop only) — small open + close delays prevent flicker
  // when the cursor travels across the gap into the panel.
  const onRowEnter = (key: string) => {
    if (mobile) return;
    clearTimers();
    openTimer.current = setTimeout(() => openCat(key, false), HOVER_OPEN_MS);
  };
  const onRowLeave = () => {
    if (mobile || sticky) return;
    clearTimers();
    closeTimer.current = setTimeout(() => setOpen(null), HOVER_CLOSE_MS);
  };
  const onPanelEnter = () => { if (!mobile) clearTimers(); };
  const onPanelLeave = () => {
    if (mobile || sticky) return;
    clearTimers();
    closeTimer.current = setTimeout(() => setOpen(null), HOVER_CLOSE_MS);
  };

  const onRowClick = (key: string) => {
    if (mobile) {
      // accordion: toggle inline
      setOpen((cur) => (cur === key ? null : key));
      return;
    }
    if (open === key && sticky) close();
    else openCat(key, true);
  };

  const onRowKeyDown = (e: React.KeyboardEvent, key: string) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onRowClick(key);
    } else if (!mobile && (e.key === "ArrowRight" || e.key === "ArrowDown")) {
      e.preventDefault();
      openCat(key, true); // MegaMenu autofocuses its first item on open
    }
  };

  // Outside-click + route-change close (desktop flyout). Re-anchor on
  // scroll/resize so the fixed panel tracks its row.
  useEffect(() => { if (!mobile) close(); }, [path, mobile, close]);
  useEffect(() => {
    if (!open || mobile) return;
    const onDocDown = (e: MouseEvent) => {
      const t = e.target as Node;
      const inRow = Object.values(rowRefs.current).some((el) => el?.contains(t));
      const inPanel = (t as HTMLElement)?.closest?.(".mm-panel");
      if (!inRow && !inPanel) close();
    };
    const reanchor = () => anchorTo(open);
    document.addEventListener("mousedown", onDocDown);
    window.addEventListener("resize", reanchor);
    window.addEventListener("scroll", reanchor, true);
    return () => {
      document.removeEventListener("mousedown", onDocDown);
      window.removeEventListener("resize", reanchor);
      window.removeEventListener("scroll", reanchor, true);
    };
  }, [open, mobile, close, anchorTo]);

  return (
    <aside className="sidebar" data-collapsed={collapsed ? "1" : "0"}>
      <div className="sb-top">
        <Link href="/" className="sb-brand" onClick={onNavigate} title="Socheli">
          <img src="/rem/logos/socheli-mark-light.png" alt="" className="sb-brand-mark" />
          <span className="sb-brand-text">
            <span className="sb-brand-name">Socheli</span>
            <span className="sb-brand-sub">content engine</span>
          </span>
        </Link>
        <button className="sb-collapse" onClick={onToggle} type="button" aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"} title={collapsed ? "Expand" : "Collapse"}>
          {collapsed ? <PanelLeft size={15} /> : <PanelLeftClose size={15} />}
        </button>
      </div>

      <Link href={PRIMARY.href} className="sb-cta" onClick={onNavigate} title={PRIMARY.label} data-guide="new-post">
        <PrimaryIcon size={16} strokeWidth={2.2} />
        <span className="sb-cta-label">{PRIMARY.label}</span>
      </Link>

      <nav className="sb-nav">
        {/* pinned — the chat-first surfaces stay full-size and prominent */}
        <Link href={HOME.href} className={`sb-link${isActive(path, HOME.href) ? " active" : ""}`} onClick={onNavigate} title={HOME.label} data-guide={`nav:${HOME.href}`}>
          <span className="sb-rail" />
          {isActive(path, HOME.href) && <InkRing className="sb-active-ring" />}
          <HomeIcon size={17} strokeWidth={1.9} className="sb-ico" />
          <span className="sb-link-label">{HOME.label}</span>
        </Link>
        <Link href={WAR_ROOM.href} className={`sb-link${isActive(path, WAR_ROOM.href) ? " active" : ""}`} onClick={onNavigate} title={WAR_ROOM.label} data-guide={`nav:${WAR_ROOM.href}`}>
          <span className="sb-rail" />
          {isActive(path, WAR_ROOM.href) && <InkRing className="sb-active-ring" />}
          <WarRoomIcon size={17} strokeWidth={1.9} className="sb-ico" />
          <span className="sb-link-label">{WAR_ROOM.label}</span>
        </Link>

        {/* hand-drawn rule between the pinned trio and the category rail */}
        <div className="sb-ink-sep" aria-hidden="true"><InkDivider /></div>

        {/* the lean category rail — one row per mega-menu category. Each row
            triggers a flyout panel (desktop) or an inline accordion (mobile). */}
        {MEGA.map((cat) => {
          const Icon = cat.icon;
          const active = catActive(path, cat);
          const isOpen = open === cat.key;
          return (
            <div className="mm-cat" key={cat.key} onMouseEnter={() => onRowEnter(cat.key)} onMouseLeave={onRowLeave}>
              <button
                type="button"
                ref={(el) => { rowRefs.current[cat.key] = el; }}
                className={`sb-link sb-cat-row${active ? " active" : ""}${isOpen ? " open" : ""}`}
                onClick={() => onRowClick(cat.key)}
                onKeyDown={(e) => onRowKeyDown(e, cat.key)}
                aria-haspopup="menu"
                aria-expanded={isOpen}
                title={cat.label}
              >
                <span className="sb-rail" />
                {active && <InkRing className="sb-active-ring" />}
                <Icon size={16} strokeWidth={1.85} className="sb-ico" />
                <span className="sb-link-label">{cat.label}</span>
                <ChevronRight size={13} className="mm-cat-chev" aria-hidden />
              </button>

              {/* mobile: inline accordion of the category's items (flyouts
                  don't work on touch). Two columns collapse to one flat list. */}
              {mobile && isOpen && (
                <div className="mm-acc">
                  {cat.columns.map((col, ci) => (
                    <div className="mm-acc-col" key={col.label ?? ci}>
                      {col.label && <span className="mm-acc-label">{col.label}</span>}
                      {col.links.map((l) => {
                        const LinkIcon = l.icon;
                        const la = isActive(path, l.href);
                        return (
                          <Link
                            key={l.href}
                            href={l.href}
                            className={`sb-link sb-mini mm-acc-item${la ? " active" : ""}`}
                            onClick={onNavigate}
                            title={l.label}
                            data-guide={`nav:${l.href}`}
                          >
                            <span className="sb-rail" />
                            {la && <InkRing className="sb-active-ring" />}
                            <LinkIcon size={14} strokeWidth={1.8} className="sb-ico" />
                            <span className="sb-link-label">{l.label}</span>
                          </Link>
                        );
                      })}
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </nav>

      {/* Socheli-style animated divider under the triggers */}
      <div className="sb-hist-divider" aria-hidden="true"><InkDivider withStar /></div>

      {/* inline chat history — shares the live thread store with /soli + Cmd+K.
          Takes the remaining height and scrolls; the footer pins below. */}
      <div className="sb-history">
        <ThreadManager
          variant="sidebar"
          collapsed={collapsed}
          threads={threads}
          folders={folders}
          activeId={activeThreadId}
          onPick={pickThread}
          onNew={startNew}
          onDelete={deleteThread}
          onRename={renameThread}
          onPin={pinThread}
          onUnpin={unpinThread}
          onMove={moveThread}
          onNewFolder={newFolder}
          onRenameFolder={renameFolder}
          onDeleteFolder={deleteFolder}
        />
      </div>

      <div className="sb-foot">
        <span className="sb-status">
          <span className="sb-status-mark"><span className="sb-status-dot" /><InkRing className="sb-status-ring" /></span>
          <span className="sb-link-label">All systems go</span>
        </span>
      </div>

      {/* desktop flyout — fixed overlay, never pushes content */}
      {open && !mobile && (() => {
        const cat = MEGA.find((c) => c.key === open);
        if (!cat) return null;
        return (
          <MegaMenu
            category={cat}
            anchor={anchor}
            onClose={close}
            onNavigate={onNavigate}
            onPanelEnter={onPanelEnter}
            onPanelLeave={onPanelLeave}
            triggerRef={triggerRef}
          />
        );
      })()}
    </aside>
  );
}
