"use client";
import {
  useCallback, useEffect, useMemo, useRef, useState, type CSSProperties,
} from "react";
import { InkIcon, InkChevronIcon, InkPlusIcon, InkTrashIcon } from "../../components/sketch";
import type { Folder, Thread } from "./useAgent";

/* ThreadManager — the ONE chat-history manager, shared by the app sidebar
   (variant="sidebar", inline rows under the mega-menu triggers) and the /soli
   chat rail (variant="rail"). Purely presentational over the useAgent module
   store: every mutation arrives as a callback, so both surfaces stay live-synced.

   Structure, top → bottom:
     • a minimalist ink SEARCH input (mono "search chats") filtering by thread
       title + folder name, live;
     • small New chat + New folder actions;
     • a PINNED group ("PINNED" eyebrow, starred rows) when any thread is pinned;
     • FOLDERS as collapsible categories (ink chevron, remembered open state per
       folder, header hover → rename inline / delete-with-confirm, threads
       indented under each);
     • RECENT — the unfiled threads, newest-first.

   Each thread row: truncated title + active ink star; hover or a "···" menu →
   Pin/Unpin · Move to folder (submenu) · Rename (inline) · Delete (confirm).
   Keyboard accessible; ink styling lives in app/chats.css. */

/* ---- small house-grammar glyphs (single-stroke, draw-in via .ink-drawable) ---- */
function Glyph({ size, children, className }: { size: number; children: React.ReactNode; className?: string }) {
  return (
    <svg
      className={`ink-drawable${className ? ` ${className}` : ""}`}
      viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor"
      strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"
    >
      {children}
    </svg>
  );
}
function InkSearchIcon({ size = 13, className }: { size?: number; className?: string }) {
  return (
    <Glyph size={size} className={className}>
      <path pathLength={1} d="M10.4 4.2 C13.9 4 16.9 6.7 17.1 10.2 C17.3 13.7 14.6 16.7 11.1 16.9 C7.6 17.1 4.6 14.4 4.4 10.9 C4.2 7.5 6.9 4.5 10.4 4.2 Z" />
      <path pathLength={1} d="M15.4 15.2 C16.9 16.7 18.4 18.2 19.8 19.8" />
    </Glyph>
  );
}
function InkFolderIcon({ size = 13, className }: { size?: number; className?: string }) {
  return (
    <Glyph size={size} className={className}>
      <path pathLength={1} d="M4.3 6.6 C5.9 6.5 7.5 6.5 9.1 6.6 C9.7 6.65 10 6.9 10.3 7.4 C10.6 7.9 10.9 8.4 11.3 8.7 C13.9 8.8 16.5 8.8 19.1 8.9 C19.7 8.95 20.1 9.35 20.1 9.95 C20 12.7 20 15.5 19.9 18.2 C19.85 18.8 19.45 19.2 18.85 19.2 C13.6 19.35 8.4 19.35 3.85 19.2 C3.25 19.2 2.9 18.8 2.9 18.2 C3 14.4 3 10.6 3 7 C3 6.8 3.5 6.6 4.3 6.6 Z" />
    </Glyph>
  );
}
/* ---- topic glyphs for the COLLAPSED rail ----
   When the sidebar is folded to its 72px icon rail there is no room for titles,
   so each conversation is represented by a single hand-drawn ink mark chosen
   from the chat's subject (its title). Same single-stroke house grammar as the
   glyphs above; the full title surfaces in a hover popover. */
function CalendarG({ size = 18, className }: { size?: number; className?: string }) {
  return (
    <Glyph size={size} className={className}>
      <path pathLength={1} d="M4.2 6.6 C9 6.3 15 6.3 19.8 6.6 C20 11 20 16 19.8 19.4 C15 19.7 9 19.7 4.2 19.4 C4 16 4 11 4.2 6.6 Z" />
      <path pathLength={1} d="M4.3 10 C9 9.8 15 9.8 19.7 10" />
      <path pathLength={1} d="M8.3 4.4 L8.1 7.6" />
      <path pathLength={1} d="M15.9 4.4 L15.7 7.6" />
    </Glyph>
  );
}
function ChartG({ size = 18, className }: { size?: number; className?: string }) {
  return (
    <Glyph size={size} className={className}>
      <path pathLength={1} d="M5 4.6 C4.8 9.5 4.8 14.5 5 19.4 C9.8 19.6 14.6 19.6 19.4 19.4" />
      <path pathLength={1} d="M8.4 19 C8.5 16.6 8.5 14.2 8.4 12.8" />
      <path pathLength={1} d="M12.2 19 C12.3 15 12.3 11 12.2 8.6" />
      <path pathLength={1} d="M16 19 C16.1 16 16.1 13 16 10.8" />
    </Glyph>
  );
}
function BulbG({ size = 18, className }: { size?: number; className?: string }) {
  return (
    <Glyph size={size} className={className}>
      <path pathLength={1} d="M12 4 C15.3 4 17.9 6.6 17.8 9.8 C17.7 12 16.4 13.4 15.3 14.7 C14.7 15.4 14.5 16.1 14.5 16.9 L9.5 16.9 C9.5 16.1 9.3 15.4 8.7 14.7 C7.6 13.4 6.3 12 6.2 9.8 C6.1 6.6 8.7 4 12 4 Z" />
      <path pathLength={1} d="M9.7 18.7 L14.3 18.7" />
      <path pathLength={1} d="M10.6 20.3 L13.4 20.3" />
    </Glyph>
  );
}
function VideoG({ size = 18, className }: { size?: number; className?: string }) {
  return (
    <Glyph size={size} className={className}>
      <path pathLength={1} d="M4.5 6.6 C9 6.3 15 6.3 19.5 6.6 C19.7 11 19.7 14 19.5 17.4 C15 17.7 9 17.7 4.5 17.4 C4.3 14 4.3 11 4.5 6.6 Z" />
      <path pathLength={1} d="M10.3 9.4 C12.3 10.4 14 11.3 15.4 12 C14 12.8 12.3 13.7 10.3 14.7 C10.2 12.9 10.2 11.1 10.3 9.4 Z" />
    </Glyph>
  );
}
function SearchG({ size = 18, className }: { size?: number; className?: string }) {
  return (
    <Glyph size={size} className={className}>
      <path pathLength={1} d="M10.4 4.4 C13.9 4.2 16.8 6.9 17 10.3 C17.2 13.8 14.5 16.7 11 16.9 C7.5 17.1 4.6 14.4 4.4 11 C4.2 7.5 6.9 4.6 10.4 4.4 Z" />
      <path pathLength={1} d="M15.4 15.3 C16.9 16.8 18.3 18.2 19.7 19.7" />
    </Glyph>
  );
}
function ChatG({ size = 18, className }: { size?: number; className?: string }) {
  return (
    <Glyph size={size} className={className}>
      <path pathLength={1} d="M5 6.6 C10 6.3 15 6.3 19 6.6 C19.2 10 19.2 13 19 15.6 C15 15.9 12 15.9 9.6 15.8 L6 18.8 C6.1 17.7 6.1 16.7 6 15.7 C5.4 15.6 5 15.1 5 14.1 C4.8 11.6 4.8 9.1 5 6.6 Z" />
    </Glyph>
  );
}
function RocketG({ size = 18, className }: { size?: number; className?: string }) {
  return (
    <Glyph size={size} className={className}>
      <path pathLength={1} d="M12 3.6 C15 6.2 16.5 10.2 16 14.6 C15 15.6 13.5 16.1 12 16.1 C10.5 16.1 9 15.6 8 14.6 C7.5 10.2 9 6.2 12 3.6 Z" />
      <path pathLength={1} d="M8.2 13.4 C7.1 14.4 6.4 15.6 6 17 C7.2 16.7 8.3 16.2 9.2 15.4" />
      <path pathLength={1} d="M15.8 13.4 C16.9 14.4 17.6 15.6 18 17 C16.8 16.7 15.7 16.2 14.8 15.4" />
      <path pathLength={1} d="M11 16.6 C11.4 18 11.8 19.2 12 20.4 C12.2 19.2 12.6 18 13 16.6" />
    </Glyph>
  );
}
function MegaphoneG({ size = 18, className }: { size?: number; className?: string }) {
  return (
    <Glyph size={size} className={className}>
      <path pathLength={1} d="M5 10 C8 8.8 11 7.6 13.6 6.4 C13.9 9.8 13.9 13.4 13.6 16.8 C11 15.6 8 14.4 5 13.2 C4.8 12.1 4.8 11.1 5 10 Z" />
      <path pathLength={1} d="M8.4 13.6 C8.8 15.6 9.2 17.5 9.6 18.6 C8.7 18.8 7.8 18.6 7.2 17.8 C6.8 16.6 6.7 15.2 6.8 13.9" />
    </Glyph>
  );
}
function ListG({ size = 18, className }: { size?: number; className?: string }) {
  return (
    <Glyph size={size} className={className}>
      <path pathLength={1} d="M8 7.4 C11.5 7.2 15.5 7.2 18.6 7.4" />
      <path pathLength={1} d="M8 12 C11.5 11.8 15.5 11.8 18.6 12" />
      <path pathLength={1} d="M8 16.6 C10.5 16.4 13 16.4 15 16.6" />
      <path pathLength={1} d="M5 7.3 L5.4 7.3" />
      <path pathLength={1} d="M5 11.9 L5.4 11.9" />
      <path pathLength={1} d="M5 16.5 L5.4 16.5" />
    </Glyph>
  );
}
function HashG({ size = 18, className }: { size?: number; className?: string }) {
  return (
    <Glyph size={size} className={className}>
      <path pathLength={1} d="M9.4 4.8 C8.9 9.6 8.3 14.5 7.8 19.3" />
      <path pathLength={1} d="M15.6 4.8 C15.1 9.6 14.5 14.5 14 19.3" />
      <path pathLength={1} d="M5.3 9.4 C9.8 9.2 14.8 9.2 18.9 9" />
      <path pathLength={1} d="M4.9 14.8 C9.4 14.6 14.4 14.6 18.5 14.4" />
    </Glyph>
  );
}
function SparkG({ size = 18, className }: { size?: number; className?: string }) {
  return (
    <Glyph size={size} className={className}>
      <path pathLength={1} d="M12 4 C12.7 9 14.6 11 19.4 12 C14.6 13 12.7 15 12 20 C11.3 15 9.4 13 4.6 12 C9.4 11 11.3 9 12 4 Z" />
    </Glyph>
  );
}

type GlyphC = (p: { size?: number; className?: string }) => React.ReactElement;
/* Pick a topic mark from the chat title. Keyword → glyph; falls back to the
   brand spark. Order matters: the most specific intents win. */
function topicGlyph(title: string): GlyphC {
  const t = (title || "").toLowerCase();
  const has = (...w: string[]) => w.some((x) => t.includes(x));
  if (has("calendar", "schedule", "this week", "today", "tomorrow", "best time")) return CalendarG;
  if (has("score", "perform", "analytic", "stats", "metric", "growth", "how did", "report")) return ChartG;
  if (has("render", "video", "reel", "short", "clip", "footage", "edit", "thumbnail")) return VideoG;
  if (has("research", "find ", "search", "look up", "competitor", "trend", "algo")) return SearchG;
  if (has("dm", "comment", "inbox", "message", "reply", "community", "respond", "hello", "hi ", "hey")) return ChatG;
  if (has("plan", "idea", "brainstorm", "concept", "hook", "strateg")) return BulbG;
  if (has("list ", "show ", "summar")) return ListG;
  if (has("ad ", "ads", "boost", "campaign", "promote")) return MegaphoneG;
  if (has("launch", "mission", "autopilot", "auto")) return RocketG;
  if (has("channel:", "@channel", "#")) return HashG;
  return SparkG;
}

/* The folded-rail history: one topic icon per recent chat, newest-first, with a
   fixed-position hover popover showing the full title (the sidebar clips
   overflow-x, so the popover is portaled to the viewport via position:fixed). */
function CollapsedHistory({
  threads, activeId, onPick,
}: {
  threads: Thread[];
  activeId: string;
  onPick: (id: string) => void;
}) {
  // Pinned float to the top, then newest-first; cap the rail so it never grows
  // unbounded — the full, searchable list is one expand-click away.
  const ordered = useMemo(() => {
    const pinned = threads.filter((t) => t.pinned);
    const rest = threads.filter((t) => !t.pinned);
    return [...pinned, ...rest].slice(0, 16);
  }, [threads]);
  const [hover, setHover] = useState<{ top: number; left: number; title: string; pinned: boolean } | null>(null);

  if (ordered.length === 0) return null;

  return (
    <div className="tm tm-collapsed" data-variant="sidebar-collapsed">
      <ul className="tmc-list">
        {ordered.map((t, i) => {
          const G = topicGlyph(t.title || "");
          const title = t.title || "New chat";
          return (
            <li
              key={t.id}
              className={`tmc-item blk-in${t.id === activeId ? " on" : ""}`}
              style={{ "--i": i + 1 } as CSSProperties}
            >
              <button
                type="button"
                className="tmc-btn"
                aria-label={title}
                title=""
                onClick={() => onPick(t.id)}
                onMouseEnter={(e) => {
                  const r = e.currentTarget.getBoundingClientRect();
                  setHover({ top: r.top + r.height / 2, left: r.right + 10, title, pinned: !!t.pinned });
                }}
                onMouseLeave={() => setHover(null)}
                onFocus={(e) => {
                  const r = e.currentTarget.getBoundingClientRect();
                  setHover({ top: r.top + r.height / 2, left: r.right + 10, title, pinned: !!t.pinned });
                }}
                onBlur={() => setHover(null)}
              >
                {t.pinned && <span className="tmc-pin" aria-hidden="true" />}
                <G size={18} className="tmc-glyph" />
              </button>
            </li>
          );
        })}
      </ul>
      {hover && (
        <div
          className="tmc-pop"
          style={{ position: "fixed", top: hover.top, left: hover.left } as CSSProperties}
          role="tooltip"
        >
          {hover.pinned && <span className="tmc-pop-pin">pinned</span>}
          <span className="tmc-pop-title">{hover.title}</span>
        </div>
      )}
    </div>
  );
}

/* ··· — the row's overflow menu trigger. */
function InkDotsIcon({ size = 14, className }: { size?: number; className?: string }) {
  return (
    <Glyph size={size} className={className}>
      <path pathLength={1} d="M5.6 11.9 C5.7 11.9 5.8 11.9 5.9 11.9 C6 12 6.1 12.1 6.1 12.2 C6.1 12.3 6 12.4 5.9 12.4 C5.7 12.4 5.6 12.3 5.6 12.1 Z" />
      <path pathLength={1} d="M11.8 11.9 C11.9 11.9 12 11.9 12.1 11.9 C12.2 12 12.3 12.1 12.3 12.2 C12.3 12.3 12.2 12.4 12.1 12.4 C11.9 12.4 11.8 12.3 11.8 12.1 Z" />
      <path pathLength={1} d="M18 11.9 C18.1 11.9 18.2 11.9 18.3 11.9 C18.4 12 18.5 12.1 18.5 12.2 C18.5 12.3 18.4 12.4 18.3 12.4 C18.1 12.4 18 12.3 18 12.1 Z" />
    </Glyph>
  );
}

const OPEN_KEY = "socheli.copilot.folders.open.v1";

function loadOpenState(): Record<string, boolean> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(OPEN_KEY);
    return raw ? (JSON.parse(raw) as Record<string, boolean>) : {};
  } catch { return {}; }
}

export type ThreadManagerProps = {
  threads: Thread[];
  folders: Folder[];
  activeId: string;
  variant: "sidebar" | "rail";
  /* sidebar only: the rail is folded to 72px — render the icon-only history. */
  collapsed?: boolean;
  onPick: (threadId: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onPin: (id: string) => void;
  onUnpin: (id: string) => void;
  onMove: (id: string, folderId: string | null) => void;
  onNewFolder: (name: string) => string;
  onRenameFolder: (id: string, name: string) => void;
  onDeleteFolder: (id: string) => void;
};

export function ThreadManager(props: ThreadManagerProps) {
  const {
    threads, folders, activeId, variant, collapsed,
    onPick, onNew, onDelete, onRename, onPin, onUnpin, onMove,
    onNewFolder, onRenameFolder, onDeleteFolder,
  } = props;

  const [query, setQuery] = useState("");
  // Per-folder remembered open state (default open).
  const [openState, setOpenState] = useState<Record<string, boolean>>({});
  useEffect(() => { setOpenState(loadOpenState()); }, []);
  const setFolderOpen = useCallback((id: string, open: boolean) => {
    setOpenState((prev) => {
      const next = { ...prev, [id]: open };
      try { window.localStorage.setItem(OPEN_KEY, JSON.stringify(next)); } catch { /* non-fatal */ }
      return next;
    });
  }, []);
  const isFolderOpen = (id: string) => openState[id] !== false;

  // Inline folder-rename state + folder delete-confirm.
  const [editingFolder, setEditingFolder] = useState<string | null>(null);
  const [folderDraft, setFolderDraft] = useState("");
  const [confirmFolder, setConfirmFolder] = useState<string | null>(null);
  // Adding-a-folder inline input (the New folder action opens it).
  const [adding, setAdding] = useState(false);
  const [addDraft, setAddDraft] = useState("");

  const q = query.trim().toLowerCase();
  const matches = useCallback(
    (t: Thread) => !q || (t.title || "New chat").toLowerCase().includes(q),
    [q],
  );

  // A folder shows if it matches by name OR holds a matching thread.
  const folderById = useMemo(() => new Map(folders.map((f) => [f.id, f] as const)), [folders]);
  const knownFolderIds = useMemo(() => new Set(folders.map((f) => f.id)), [folders]);

  // Partition: pinned (any folder), then per-folder threads, then unfiled recent.
  // `threads` already arrives newest-first from the store.
  const pinned = useMemo(() => threads.filter((t) => t.pinned && matches(t)), [threads, matches]);
  const byFolder = useMemo(() => {
    const map = new Map<string, Thread[]>();
    for (const t of threads) {
      if (t.pinned) continue; // pinned rises out of its folder into the PINNED group
      if (t.folderId && knownFolderIds.has(t.folderId)) {
        if (!map.has(t.folderId)) map.set(t.folderId, []);
        map.get(t.folderId)!.push(t);
      }
    }
    return map;
  }, [threads, knownFolderIds]);
  const recent = useMemo(
    () => threads.filter((t) => !t.pinned && (!t.folderId || !knownFolderIds.has(t.folderId)) && matches(t)),
    [threads, knownFolderIds, matches],
  );

  const commitFolderRename = (id: string) => {
    if (folderDraft.trim()) onRenameFolder(id, folderDraft);
    setEditingFolder(null);
  };
  const commitAdd = () => {
    const name = addDraft.trim();
    if (name) {
      const id = onNewFolder(name);
      setFolderOpen(id, true);
    }
    setAdding(false);
    setAddDraft("");
  };

  const hasAnything = threads.length > 0 || folders.length > 0;

  // Folded icon-rail (decided AFTER all hooks above have run, so hook order is
  // never disturbed when collapse toggles): topic marks + hover popovers.
  if (variant === "sidebar" && collapsed) {
    return <CollapsedHistory threads={threads} activeId={activeId} onPick={onPick} />;
  }

  return (
    <div className={`tm tm-${variant}`} data-variant={variant}>
      {/* search */}
      <div className="tm-search">
        <InkSearchIcon size={13} className="tm-search-ico" />
        <input
          className="tm-search-input"
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="search chats"
          aria-label="Search chats"
          spellCheck={false}
          autoComplete="off"
        />
      </div>

      {/* actions */}
      <div className="tm-actions">
        <button className="tm-act" type="button" onClick={onNew} title="New chat">
          <InkPlusIcon size={12} /> <span>New chat</span>
        </button>
        <button
          className="tm-act tm-act-folder"
          type="button"
          onClick={() => { setAdding(true); setAddDraft(""); }}
          title="New folder"
        >
          <InkFolderIcon size={12} /> <span>New folder</span>
        </button>
      </div>
      {adding && (
        <div className="tm-add-folder">
          <input
            className="tm-rename"
            value={addDraft}
            autoFocus
            aria-label="New folder name"
            placeholder="folder name"
            onChange={(e) => setAddDraft(e.target.value)}
            onBlur={commitAdd}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitAdd();
              if (e.key === "Escape") { setAdding(false); setAddDraft(""); }
            }}
          />
        </div>
      )}

      <div className="tm-scroll">
        {!hasAnything && <div className="tm-empty">No conversations yet</div>}

        {/* PINNED */}
        {pinned.length > 0 && (
          <div className="tm-group">
            <div className="tm-group-head"><span className="tm-eyebrow">Pinned</span></div>
            <ul className="tm-list">
              {pinned.map((t, i) => (
                <ThreadRow
                  key={t.id} thread={t} i={i} active={t.id === activeId} folders={folders}
                  folderById={folderById}
                  {...{ onPick, onDelete, onRename, onPin, onUnpin, onMove, onNewFolder }}
                />
              ))}
            </ul>
          </div>
        )}

        {/* FOLDERS */}
        {folders.map((f) => {
          const inFolder = (byFolder.get(f.id) ?? []).filter(matches);
          const folderNameHit = !q || f.name.toLowerCase().includes(q);
          // When searching, hide folders with no name hit and no matching thread.
          if (q && !folderNameHit && inFolder.length === 0) return null;
          const isOpen = isFolderOpen(f.id) || (!!q && inFolder.length > 0);
          return (
            <div className="tm-group tm-folder" key={f.id}>
              <div className="tm-group-head tm-folder-head">
                {editingFolder === f.id ? (
                  <input
                    className="tm-rename"
                    value={folderDraft}
                    autoFocus
                    aria-label="Rename folder"
                    onChange={(e) => setFolderDraft(e.target.value)}
                    onBlur={() => commitFolderRename(f.id)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") commitFolderRename(f.id);
                      if (e.key === "Escape") setEditingFolder(null);
                    }}
                  />
                ) : (
                  <>
                    <button
                      className="tm-folder-toggle"
                      type="button"
                      aria-expanded={isOpen}
                      onClick={() => setFolderOpen(f.id, !isFolderOpen(f.id))}
                      title={isOpen ? "Collapse folder" : "Expand folder"}
                    >
                      <InkChevronIcon size={11} className={`tm-chev${isOpen ? " open" : ""}`} />
                      <InkFolderIcon size={12} className="tm-folder-ico" />
                      <span className="tm-folder-name">{f.name}</span>
                      <span className="tm-folder-count">{(byFolder.get(f.id) ?? []).length}</span>
                    </button>
                    <span className="tm-folder-acts">
                      <button
                        className="tm-mini-btn" type="button" title="Rename folder"
                        aria-label={`Rename folder ${f.name}`}
                        onClick={() => { setFolderDraft(f.name); setEditingFolder(f.id); }}
                      >ren</button>
                      <button
                        className="tm-mini-btn tm-mini-del" type="button" title="Delete folder"
                        aria-label={`Delete folder ${f.name}`}
                        onClick={() => setConfirmFolder(f.id)}
                      ><InkTrashIcon size={11} /></button>
                    </span>
                  </>
                )}
              </div>
              {confirmFolder === f.id && (
                <div className="tm-confirm" role="alertdialog" aria-label="Delete folder?">
                  <span>Delete folder? Chats are kept.</span>
                  <button type="button" className="tm-confirm-yes" onClick={() => { onDeleteFolder(f.id); setConfirmFolder(null); }}>Delete</button>
                  <button type="button" className="tm-confirm-no" onClick={() => setConfirmFolder(null)}>Cancel</button>
                </div>
              )}
              {isOpen && (
                <ul className="tm-list tm-list-indent">
                  {inFolder.length === 0
                    ? <li className="tm-folder-empty">empty</li>
                    : inFolder.map((t, i) => (
                        <ThreadRow
                          key={t.id} thread={t} i={i} active={t.id === activeId} folders={folders}
                          folderById={folderById}
                          {...{ onPick, onDelete, onRename, onPin, onUnpin, onMove, onNewFolder }}
                        />
                      ))}
                </ul>
              )}
            </div>
          );
        })}

        {/* RECENT (unfiled) */}
        {recent.length > 0 && (
          <div className="tm-group">
            <div className="tm-group-head"><span className="tm-eyebrow">Recent</span></div>
            <ul className="tm-list">
              {recent.map((t, i) => (
                <ThreadRow
                  key={t.id} thread={t} i={i} active={t.id === activeId} folders={folders}
                  folderById={folderById}
                  {...{ onPick, onDelete, onRename, onPin, onUnpin, onMove, onNewFolder }}
                />
              ))}
            </ul>
          </div>
        )}

        {hasAnything && q && pinned.length === 0 && recent.length === 0 &&
          folders.every((f) => (byFolder.get(f.id) ?? []).filter(matches).length === 0 && !f.name.toLowerCase().includes(q)) && (
            <div className="tm-empty">No matches</div>
          )}
      </div>
    </div>
  );
}

/* One thread row. Hover reveals the ··· menu; click the title picks the thread.
   Inline rename swaps the title for an input. The menu (Pin/Unpin · Move ·
   Rename · Delete-confirm) is a small ink popover anchored to the row. */
function ThreadRow({
  thread, i, active, folders, folderById,
  onPick, onDelete, onRename, onPin, onUnpin, onMove, onNewFolder,
}: {
  thread: Thread;
  i: number;
  active: boolean;
  folders: Folder[];
  folderById: Map<string, Folder>;
  onPick: (id: string) => void;
  onDelete: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onPin: (id: string) => void;
  onUnpin: (id: string) => void;
  onMove: (id: string, folderId: string | null) => void;
  onNewFolder: (name: string) => string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const [moveOpen, setMoveOpen] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);
  const wrapRef = useRef<HTMLLIElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);

  const closeMenu = useCallback(() => {
    setMenuOpen(false); setMoveOpen(false); setConfirmDel(false);
  }, []);

  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) closeMenu();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { closeMenu(); btnRef.current?.focus(); } };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [menuOpen, closeMenu]);

  const commit = () => {
    if (draft.trim()) onRename(thread.id, draft);
    setEditing(false);
  };
  const startRename = () => { setDraft(thread.title || ""); setEditing(true); closeMenu(); };

  const title = thread.title || "New chat";
  const currentFolder = thread.folderId ? folderById.get(thread.folderId) : undefined;

  return (
    <li
      className={`tm-row blk-in${active ? " on" : ""}${menuOpen ? " menu-open" : ""}`}
      style={{ "--i": i + 1 } as CSSProperties}
      ref={wrapRef}
    >
      {editing ? (
        <input
          className="tm-rename"
          value={draft}
          autoFocus
          aria-label="Rename conversation"
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
            if (e.key === "Escape") setEditing(false);
          }}
        />
      ) : (
        <>
          <button
            className="tm-row-main"
            type="button"
            title={title}
            onClick={() => onPick(thread.id)}
            onDoubleClick={startRename}
          >
            {(active || thread.pinned) && (
              <InkIcon name="glyph" size={10} className={`tm-star${thread.pinned ? " pinned" : ""}`} />
            )}
            <span className="tm-title">{title}</span>
          </button>
          <button
            ref={btnRef}
            className="tm-menu-btn"
            type="button"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-label={`Conversation actions for ${title}`}
            onClick={() => setMenuOpen((v) => !v)}
          >
            <InkDotsIcon size={14} />
          </button>
        </>
      )}

      {menuOpen && !editing && (
        <div className="tm-menu" role="menu" aria-label={`Actions for ${title}`}>
          <button className="tm-menu-item" role="menuitem" type="button"
            onClick={() => { thread.pinned ? onUnpin(thread.id) : onPin(thread.id); closeMenu(); }}>
            {thread.pinned ? "Unpin" : "Pin"}
          </button>
          <button className="tm-menu-item tm-has-sub" role="menuitem" type="button"
            aria-haspopup="menu" aria-expanded={moveOpen}
            onClick={() => setMoveOpen((v) => !v)}>
            Move to folder <InkChevronIcon size={10} className={`tm-chev${moveOpen ? " open" : ""}`} />
          </button>
          {moveOpen && (
            <div className="tm-submenu" role="menu" aria-label="Move to folder">
              {folders.map((f) => (
                <button key={f.id} className={`tm-menu-item${currentFolder?.id === f.id ? " on" : ""}`} role="menuitem" type="button"
                  onClick={() => { onMove(thread.id, f.id); closeMenu(); }}>
                  <InkFolderIcon size={11} /> {f.name}
                </button>
              ))}
              <button className="tm-menu-item" role="menuitem" type="button"
                onClick={() => { const id = onNewFolder("New folder"); onMove(thread.id, id); closeMenu(); }}>
                <InkPlusIcon size={11} /> New folder…
              </button>
              {thread.folderId && (
                <button className="tm-menu-item" role="menuitem" type="button"
                  onClick={() => { onMove(thread.id, null); closeMenu(); }}>
                  Remove from folder
                </button>
              )}
            </div>
          )}
          <button className="tm-menu-item" role="menuitem" type="button" onClick={startRename}>
            Rename
          </button>
          {confirmDel ? (
            <div className="tm-confirm tm-confirm-row" role="alertdialog" aria-label="Delete conversation?">
              <button type="button" className="tm-confirm-yes" onClick={() => { onDelete(thread.id); closeMenu(); }}>Delete</button>
              <button type="button" className="tm-confirm-no" onClick={() => setConfirmDel(false)}>Cancel</button>
            </div>
          ) : (
            <button className="tm-menu-item tm-menu-del" role="menuitem" type="button" onClick={() => setConfirmDel(true)}>
              <InkTrashIcon size={11} /> Delete
            </button>
          )}
        </div>
      )}
    </li>
  );
}

export default ThreadManager;
