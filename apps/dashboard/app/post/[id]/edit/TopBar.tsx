import Link from "next/link";
import { ArrowLeft, Sparkles, Layers, SlidersHorizontal, Film } from "lucide-react";
import { ASPECTS, type AspectKey } from "./lib";
import { Ico, Key } from "./ui";
import { WorkspaceMenu } from "./WorkspaceMenu";
import { WindowMenu } from "./WindowMenu";
import type { Workspace } from "./workspace";

export function TopBar({
  id, item, scenes, total, currentAspectKey, state, showKeys, layersOpen, canUndo, canRedo,
  setAspect, autoEdit, setLayersOpen, setShowKeys, undo, redo, save, saveRender,
  workspaces, activeWorkspaceId, pickWorkspace, saveAsWorkspace, renameWorkspace, deleteWorkspace, resetToPreset,
  panelList, togglePanel,
  mInspectorOpen, mTimelineOpen, toggleMInspector, toggleMTimeline,
}: {
  id: string;
  item: any;
  scenes: any[];
  total: number;
  currentAspectKey: AspectKey;
  state: "idle" | "saving" | "rendering";
  showKeys: boolean;
  layersOpen: boolean;
  canUndo: boolean;
  canRedo: boolean;
  setAspect: (key: AspectKey) => void;
  autoEdit: () => void;
  setLayersOpen: (fn: (v: boolean) => boolean) => void;
  setShowKeys: (v: boolean) => void;
  undo: () => void;
  redo: () => void;
  save: () => void;
  saveRender: () => void;
  workspaces: Workspace[];
  activeWorkspaceId: string;
  pickWorkspace: (id: string) => void;
  saveAsWorkspace: (name: string) => void;
  renameWorkspace: (id: string, name: string) => void;
  deleteWorkspace: (id: string) => void;
  resetToPreset: () => void;
  panelList: { id: string; title: string; visible: boolean }[];
  togglePanel: (id: string) => void;
  mInspectorOpen: boolean;
  mTimelineOpen: boolean;
  toggleMInspector: () => void;
  toggleMTimeline: () => void;
}) {
  return (
    <div className="ed-top">
      <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
        <Link href={`/post/${id}`} className="ed-back" title="Back"><ArrowLeft size={16} strokeWidth={2} /></Link>
        <span className="ed-title">{item.pkg?.title ?? item.idea?.topic ?? id}</span>
        <span className="ed-meta">{scenes.length} scenes / {total.toFixed(1)}s</span>
        {/* F2: output aspect switcher */}
        <div className="aspect-switch" role="group" aria-label="Aspect ratio">
          {ASPECTS.map((a) => {
            const AI = a.icon;
            return (
              <button
                key={a.key}
                className={`aspect-btn${currentAspectKey === a.key ? " on" : ""}`}
                onClick={() => setAspect(a.key)}
                title={`${a.label} (${a.width}x${a.height})`}
              >
                <AI size={13} strokeWidth={2} />{a.label}
              </button>
            );
          })}
        </div>
      </div>
      <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
        {/* Mobile-only drawer toggles (hidden on desktop via CSS). */}
        <button className={`btn ed-m-only${mTimelineOpen ? " btn-active" : ""}`} onClick={toggleMTimeline} title="Timeline" aria-label="Toggle timeline"><Film size={15} strokeWidth={2} /></button>
        <button className={`btn ed-m-only${mInspectorOpen ? " btn-active" : ""}`} onClick={toggleMInspector} title="Inspector" aria-label="Toggle inspector"><SlidersHorizontal size={15} strokeWidth={2} /></button>
        {state === "rendering" && <span className="ed-meta">rendering MP4</span>}
        <WorkspaceMenu
          workspaces={workspaces}
          activeId={activeWorkspaceId}
          onPick={pickWorkspace}
          onSaveAs={saveAsWorkspace}
          onRename={renameWorkspace}
          onDelete={deleteWorkspace}
          onReset={resetToPreset}
        />
        <WindowMenu panels={panelList} onToggle={togglePanel} />
        <button className="btn" onClick={autoEdit} title="One-click pro pass: duck, hormozi captions, Ken Burns, beat peaks"><Sparkles size={14} strokeWidth={2} />Auto-edit</button>
        <button className={`btn${layersOpen ? " btn-active" : ""}`} onClick={() => setLayersOpen((v) => !v)} title="Layers / outline"><Layers size={14} strokeWidth={2} />Layers</button>
        <button className="btn" onClick={() => setShowKeys(!showKeys)}><Ico c="KY" />Keys</button>
        <button className="btn" onClick={undo} disabled={!canUndo}><Ico c="UN" />Undo <Key>Cmd Z</Key></button>
        <button className="btn" onClick={redo} disabled={!canRedo}><Ico c="RE" />Redo</button>
        <button className="btn" onClick={save} disabled={state !== "idle"}><Ico c="SV" />Save <Key>Cmd S</Key></button>
        <button className="btn btn-primary" onClick={saveRender} disabled={state !== "idle"}><Ico c="RD" />{state === "saving" ? "Saving" : "Save & Render"}</button>
      </div>
    </div>
  );
}
