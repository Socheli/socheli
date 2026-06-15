"use client";
import { Fragment, useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { InkIcon, InkHistoryIcon, InkPlusIcon, InkTrashIcon, InkTileFrame } from "../../components/sketch";
import type { Folder, Thread } from "./useAgent";
import { ThreadManager } from "./ThreadManager";

/* Conversation history surfaces over the useAgent thread store.

   Two skins of the same quiet list:
   - <ThreadsRail>  — the collapsible left rail inside the /soli chat column
     ("History" eyebrow, New chat ghost button, rows with relative time,
     hover-revealed delete, double-click to rename).
   - <ThreadsMenu>  — the lightweight dropdown in the Cmd+K panel header
     (same list + New chat, registration-tick corners in the composer PopCard
     grammar, arrow-key navigable, closes on pick/Esc/outside click and hands
     focus back to its trigger).

   Purely presentational: every mutation comes in as a callback from useAgent,
   so both surfaces stay live-synced through the module store. All marks are
   house ink (components/sketch/InkUI) — the active thread carries the
   hand-set ink star, which stamps in on switch (the spark moment); rows
   cascade in on the shared .blk-in 55ms stagger. */

function relTime(ts: number): string {
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 7 * 86400) return `${Math.floor(s / 86400)}d`;
  return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/* Day bucket for the rail's grouped list — recency in plain words instead of
   a flat undifferentiated stack. */
function dayBucket(ts: number): string {
  const d = new Date(ts);
  const today = new Date();
  const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.floor((startOfDay(today) - startOfDay(d)) / 86400000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return "This week";
  return "Earlier";
}

function NewChatButton({ onNew }: { onNew: () => void }) {
  return (
    <button className="thr-new blk-in" type="button" onClick={onNew}>
      <InkTileFrame className="thr-new-frame" />
      <InkPlusIcon size={13} />
      <span>New chat</span>
    </button>
  );
}

function ThreadList({
  threads,
  activeId,
  onSwitch,
  onDelete,
  onRename,
  grouped,
}: {
  threads: Thread[];
  activeId: string;
  onSwitch: (id: string) => void;
  onDelete: (id: string) => void;
  onRename?: (id: string, title: string) => void;
  /* Rail mode groups rows under Today/Yesterday/… eyebrows; the compact
     Cmd+K dropdown stays a flat list. */
  grouped?: boolean;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  if (threads.length === 0) return <div className="thr-empty">No conversations yet</div>;

  const commit = (id: string) => {
    if (onRename && draft.trim()) onRename(id, draft);
    setEditing(null);
  };

  let lastBucket: string | null = null;
  return (
    <ul className="thr-list">
      {threads.map((t, i) => {
        const active = t.id === activeId;
        const bucket = grouped ? dayBucket(t.updatedAt) : null;
        const showBucket = bucket !== null && bucket !== lastBucket;
        if (bucket !== null) lastBucket = bucket;
        return (
          <Fragment key={t.id}>
          {showBucket && <li className="thr-day" aria-hidden="true">{bucket}</li>}
          <li
            className={`thr-row blk-in${active ? " on" : ""}`}
            style={{ "--i": i + 1 } as CSSProperties}
          >
            {editing === t.id ? (
              <input
                className="thr-rename"
                value={draft}
                autoFocus
                aria-label="Rename conversation"
                onChange={(e) => setDraft(e.target.value)}
                onBlur={() => commit(t.id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commit(t.id);
                  if (e.key === "Escape") setEditing(null);
                }}
              />
            ) : (
              <>
                <button
                  className="thr-row-main"
                  type="button"
                  title={t.title || "New chat"}
                  onClick={() => onSwitch(t.id)}
                  onDoubleClick={
                    onRename
                      ? () => {
                          setDraft(t.title || "");
                          setEditing(t.id);
                        }
                      : undefined
                  }
                >
                  {active && <InkIcon name="glyph" size={11} className="thr-star" />}
                  <span className="thr-title">{t.title || "New chat"}</span>
                  <span className="thr-time">{relTime(t.updatedAt)}</span>
                </button>
                <button
                  className="thr-del"
                  type="button"
                  title="Delete conversation"
                  aria-label={`Delete "${t.title || "New chat"}"`}
                  onClick={() => onDelete(t.id)}
                >
                  <InkTrashIcon size={12} />
                </button>
              </>
            )}
          </li>
          </Fragment>
        );
      })}
    </ul>
  );
}

/* Collapsible history rail for the /soli chat column (not the app sidebar).
   Now a thin shell over the SHARED <ThreadManager> (variant="rail") — the
   same folders/pinning/search component the app sidebar renders — so both
   surfaces stay one component over the live singleton store. */
export function ThreadsRail({
  open,
  threads,
  folders,
  activeId,
  onNew,
  onSwitch,
  onDelete,
  onRename,
  onPin,
  onUnpin,
  onMove,
  onNewFolder,
  onRenameFolder,
  onDeleteFolder,
}: {
  open: boolean;
  threads: Thread[];
  folders: Folder[];
  activeId: string;
  onNew: () => void;
  onSwitch: (id: string) => void;
  onDelete: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onPin: (id: string) => void;
  onUnpin: (id: string) => void;
  onMove: (id: string, folderId: string | null) => void;
  onNewFolder: (name: string) => string;
  onRenameFolder: (id: string, name: string) => void;
  onDeleteFolder: (id: string) => void;
}) {
  return (
    <aside className={`thr-rail${open ? " open" : ""}`} aria-label="Conversation history" aria-hidden={!open}>
      <div className="thr-rail-head">
        <span className="thr-eyebrow">History</span>
        {threads.length > 0 && <span className="thr-count">{threads.length}</span>}
      </div>
      <ThreadManager
        variant="rail"
        threads={threads}
        folders={folders}
        activeId={activeId}
        onPick={onSwitch}
        onNew={onNew}
        onDelete={onDelete}
        onRename={onRename}
        onPin={onPin}
        onUnpin={onUnpin}
        onMove={onMove}
        onNewFolder={onNewFolder}
        onRenameFolder={onRenameFolder}
        onDeleteFolder={onDeleteFolder}
      />
    </aside>
  );
}

/* History dropdown for the copilot panel header: trigger + popover. The
   popover carries the composer card's registration-tick corners (the shared
   .cmp-corners overlay takes the bottom pair, .thr-menu::before/::after the
   top pair) and is fully keyboard-driven: focus lands on "New chat" when it
   opens, ArrowUp/Down walk the items, Esc/pick close and return focus to the
   trigger. */
export function ThreadsMenu({
  threads,
  activeId,
  onNew,
  onSwitch,
  onDelete,
}: {
  threads: Thread[];
  activeId: string;
  onNew: () => void;
  onSwitch: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const close = useCallback((refocus: boolean) => {
    setOpen(false);
    if (refocus) triggerRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;
    // First focusable item takes focus so arrows work immediately.
    menuRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    // Safety net for Esc when focus drifted outside the menu (the menu's own
    // handler stops propagation, so this never double-fires).
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close(true);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open, close]);

  /* Arrow keys walk New chat + the thread rows (delete stays a Tab stop);
     Esc closes and hands focus back to the trigger. */
  const onMenuKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close(true);
      return;
    }
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const items = Array.from(
      menuRef.current?.querySelectorAll<HTMLButtonElement>(".thr-new, .thr-row-main") ?? [],
    );
    if (!items.length) return;
    const idx = items.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      e.key === "ArrowDown"
        ? (idx + 1) % items.length
        : (idx - 1 + items.length) % items.length;
    items[next]?.focus();
  };

  return (
    <div className="thr-menu-wrap" ref={wrapRef}>
      <button
        ref={triggerRef}
        className="cp-icon-btn"
        type="button"
        title="Conversation history"
        aria-label="Conversation history"
        aria-expanded={open}
        aria-haspopup="true"
        onClick={() => setOpen((v) => !v)}
      >
        <InkHistoryIcon size={15} />
      </button>
      {open && (
        <div
          className="thr-menu"
          ref={menuRef}
          role="group"
          aria-label="Conversations"
          onKeyDown={onMenuKey}
        >
          <span className="cmp-corners" aria-hidden="true" />
          <NewChatButton
            onNew={() => {
              onNew();
              close(true);
            }}
          />
          <ThreadList
            threads={threads}
            activeId={activeId}
            onSwitch={(id) => {
              onSwitch(id);
              close(true);
            }}
            onDelete={onDelete}
          />
        </div>
      )}
    </div>
  );
}
