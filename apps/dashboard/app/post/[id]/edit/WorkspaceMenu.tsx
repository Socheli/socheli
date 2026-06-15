"use client";

import { useEffect, useRef, useState } from "react";
import { LayoutGrid, Check, Pencil, Trash2, Plus, RotateCcw } from "lucide-react";
import type { Workspace } from "./workspace";
import { promptDialog } from "../../../confirm";

// Workspace switcher dropdown. Lists builtin presets, then the user's custom
// "My workspaces" (with rename/delete), a "Save current as…" action, and a
// "Reset to preset" action. Controlled/pure: all mutations are delegated to
// callbacks; the only local state is the open/closed flag.
export function WorkspaceMenu({
  workspaces,
  activeId,
  onPick,
  onSaveAs,
  onRename,
  onDelete,
  onReset,
}: {
  workspaces: Workspace[];
  activeId: string;
  onPick: (id: string) => void;
  onSaveAs: (name: string) => void;
  onRename: (id: string, name: string) => void;
  onDelete: (id: string) => void;
  onReset: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onEsc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onEsc);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onEsc);
    };
  }, [open]);

  const builtin = workspaces.filter((w) => w.builtin);
  const custom = workspaces.filter((w) => !w.builtin);
  const active = workspaces.find((w) => w.id === activeId);

  const promptSaveAs = async () => {
    setOpen(false);
    const name = await promptDialog({ title: "Save current layout as…", defaultValue: "My workspace", placeholder: "Workspace name", confirmText: "Save" });
    if (name) onSaveAs(name);
  };
  const promptRename = async (w: Workspace) => {
    const name = await promptDialog({ title: "Rename workspace", defaultValue: w.name, placeholder: "Workspace name", confirmText: "Rename" });
    if (name) onRename(w.id, name);
  };

  return (
    <div className="ws-menu-wrap" ref={ref} style={{ position: "relative" }}>
      <button className={`btn${open ? " btn-active" : ""}`} onClick={() => setOpen((v) => !v)} title="Workspace">
        <LayoutGrid size={14} strokeWidth={2} />
        {active?.name ?? "Workspace"}
      </button>
      {open && (
        <div className="ctx-menu ws-dropdown" style={{ position: "absolute", top: "calc(100% + 6px)", right: 0, minWidth: 220, zIndex: 50 }} onClick={(e) => e.stopPropagation()}>
          <div className="ctx-title">Presets</div>
          {builtin.map((w) => (
            <button key={w.id} onClick={() => { onPick(w.id); setOpen(false); }} style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <Check size={13} strokeWidth={2} style={{ opacity: w.id === activeId ? 1 : 0 }} />
              {w.name}
            </button>
          ))}

          {custom.length > 0 && <div className="ctx-title">My workspaces</div>}
          {custom.map((w) => (
            <div key={w.id} className="ws-row" style={{ display: "flex", alignItems: "center" }}>
              <button onClick={() => { onPick(w.id); setOpen(false); }} style={{ display: "flex", alignItems: "center", gap: 6, flex: 1 }}>
                <Check size={13} strokeWidth={2} style={{ opacity: w.id === activeId ? 1 : 0 }} />
                {w.name}
              </button>
              <button className="lnk-btn" title="Rename" onClick={() => promptRename(w)}><Pencil size={12} strokeWidth={2} /></button>
              <button className="lnk-btn" title="Delete" onClick={() => onDelete(w.id)}><Trash2 size={12} strokeWidth={2} /></button>
            </div>
          ))}

          <div className="ctx-title">Actions</div>
          <button onClick={promptSaveAs} style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <Plus size={13} strokeWidth={2} />Save current as…
          </button>
          <button onClick={() => { onReset(); setOpen(false); }} style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <RotateCcw size={13} strokeWidth={2} />Reset to preset
          </button>
        </div>
      )}
    </div>
  );
}
