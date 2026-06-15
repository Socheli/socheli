// Workspace management model + presets + persistence for the editor.
//
// The editor is a center Preview (fixed, never a panel) surrounded by dockable
// panels. A WorkspaceLayout describes which panels are visible, where they dock,
// their order within a region, the region sizes, and the active inspector tab.
// Built-in workspaces ship as presets; users can save/rename/delete their own,
// all persisted to localStorage under a versioned key. The `default` workspace
// reproduces the current hard-coded layout exactly (zero regression).

// ── Model ────────────────────────────────────────────────────────────────────
export type Region = "right" | "bottom";
// Preview is the fixed center stage, intentionally NOT a panel id.
export type PanelId = "inspector" | "timeline" | "audio" | "layers";
export type InspectorTab = "scene" | "transcript" | "style" | "subtitles" | "mix";

export type PanelState = {
  region: Region;
  visible: boolean;
  order: number; // ordering within a region (lower = first)
};

export type WorkspaceLayout = {
  panels: Record<PanelId, PanelState>;
  sizes: { rightW: number; bottomH: number };
  inspectorTab: InspectorTab;
};

export type Workspace = {
  id: string;
  name: string;
  builtin?: boolean;
  layout: WorkspaceLayout;
};

// All panel ids, in canonical order (handy for iteration / menus).
export const PANEL_IDS: PanelId[] = ["inspector", "timeline", "audio", "layers"];

// Per-panel metadata: human title + the region it docks to by default.
export const PANEL_META: Record<PanelId, { title: string; defaultRegion: Region }> = {
  inspector: { title: "Inspector", defaultRegion: "right" },
  timeline: { title: "Timeline", defaultRegion: "bottom" },
  audio: { title: "Audio", defaultRegion: "bottom" },
  layers: { title: "Layers", defaultRegion: "right" },
};

// ── Bounds ───────────────────────────────────────────────────────────────────
export const SIZE_BOUNDS = {
  rightW: { min: 260, max: 720 },
  bottomH: { min: 140, max: 560 },
} as const;

const clampNum = (v: number, min: number, max: number) =>
  Math.min(max, Math.max(min, Number.isFinite(v) ? v : min));

const VALID_TABS: InspectorTab[] = ["scene", "transcript", "style", "subtitles", "mix"];
const VALID_REGIONS: Region[] = ["right", "bottom"];

/** Coerce an arbitrary (possibly persisted/stale) layout into a sane shape. */
export function clampLayout(layout: WorkspaceLayout): WorkspaceLayout {
  const src = layout ?? ({} as WorkspaceLayout);
  const panels = {} as Record<PanelId, PanelState>;
  for (const id of PANEL_IDS) {
    const p = (src.panels as any)?.[id] ?? {};
    const region: Region = VALID_REGIONS.includes(p.region) ? p.region : PANEL_META[id].defaultRegion;
    panels[id] = {
      region,
      visible: typeof p.visible === "boolean" ? p.visible : false,
      order: Number.isFinite(p.order) ? p.order : PANEL_IDS.indexOf(id),
    };
  }
  const sizes = src.sizes ?? ({} as WorkspaceLayout["sizes"]);
  const inspectorTab: InspectorTab = VALID_TABS.includes(src.inspectorTab) ? src.inspectorTab : "scene";
  return {
    panels,
    sizes: {
      rightW: clampNum(sizes.rightW, SIZE_BOUNDS.rightW.min, SIZE_BOUNDS.rightW.max),
      bottomH: clampNum(sizes.bottomH, SIZE_BOUNDS.bottomH.min, SIZE_BOUNDS.bottomH.max),
    },
    inspectorTab,
  };
}

// Helper to build a panels record from a compact spec.
function mkPanels(
  spec: Partial<Record<PanelId, Partial<PanelState>>>
): Record<PanelId, PanelState> {
  const panels = {} as Record<PanelId, PanelState>;
  for (const id of PANEL_IDS) {
    const s = spec[id] ?? {};
    panels[id] = {
      region: s.region ?? PANEL_META[id].defaultRegion,
      visible: s.visible ?? false,
      order: s.order ?? PANEL_IDS.indexOf(id),
    };
  }
  return panels;
}

// ── Built-in presets ─────────────────────────────────────────────────────────
export const DEFAULT_WORKSPACE_ID = "default";

export const BUILTIN_WORKSPACES: Workspace[] = [
  {
    id: "default",
    name: "Default",
    builtin: true,
    // Reproduces the CURRENT layout exactly: inspector docked right (visible),
    // timeline + audio docked bottom (visible), layers hidden (floating toggle),
    // inspector tab = scene, right column 360px, bottom dock 280px.
    layout: {
      panels: mkPanels({
        inspector: { region: "right", visible: true, order: 0 },
        timeline: { region: "bottom", visible: true, order: 0 },
        audio: { region: "bottom", visible: true, order: 1 },
        layers: { region: "right", visible: false, order: 1 },
      }),
      sizes: { rightW: 344, bottomH: 300 },
      inspectorTab: "scene",
    },
  },
  {
    id: "editing",
    name: "Editing",
    builtin: true,
    layout: {
      panels: mkPanels({
        inspector: { region: "right", visible: true, order: 0 },
        layers: { region: "right", visible: true, order: 1 },
        timeline: { region: "bottom", visible: true, order: 0 },
        audio: { region: "bottom", visible: false, order: 1 },
      }),
      sizes: { rightW: 360, bottomH: 280 },
      inspectorTab: "scene",
    },
  },
  {
    id: "captions",
    name: "Captions",
    builtin: true,
    layout: {
      panels: mkPanels({
        inspector: { region: "right", visible: true, order: 0 },
        timeline: { region: "bottom", visible: true, order: 0 },
        audio: { region: "bottom", visible: false, order: 1 },
        layers: { region: "right", visible: false, order: 1 },
      }),
      sizes: { rightW: 440, bottomH: 240 },
      inspectorTab: "subtitles",
    },
  },
  {
    id: "audio",
    name: "Audio",
    builtin: true,
    layout: {
      panels: mkPanels({
        inspector: { region: "right", visible: true, order: 0 },
        audio: { region: "bottom", visible: true, order: 0 },
        timeline: { region: "bottom", visible: true, order: 1 },
        layers: { region: "right", visible: false, order: 1 },
      }),
      sizes: { rightW: 360, bottomH: 320 },
      inspectorTab: "mix",
    },
  },
  {
    id: "minimal",
    name: "Minimal",
    builtin: true,
    layout: {
      panels: mkPanels({
        inspector: { region: "right", visible: false, order: 0 },
        layers: { region: "right", visible: false, order: 1 },
        timeline: { region: "bottom", visible: true, order: 0 },
        audio: { region: "bottom", visible: false, order: 1 },
      }),
      sizes: { rightW: 360, bottomH: 240 },
      inspectorTab: "scene",
    },
  },
];

export const getBuiltin = (id: string): Workspace | undefined =>
  BUILTIN_WORKSPACES.find((w) => w.id === id);

// ── Persistence (SSR-safe, versioned, defensive) ─────────────────────────────
const KEY = "socheli.workspaces.v1";
const KEY_ACTIVE = "socheli.workspaces.v1.active";
const KEY_OVERRIDE = "socheli.workspaces.v1.override";

const hasWindow = () => typeof window !== "undefined" && !!window.localStorage;

function readJSON<T>(key: string, fallback: T): T {
  if (!hasWindow()) return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function writeJSON(key: string, value: unknown): void {
  if (!hasWindow()) return;
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* quota / serialization — ignore */
  }
}

function removeKey(key: string): void {
  if (!hasWindow()) return;
  try {
    window.localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}

/** Load the user's saved custom workspaces (never builtin). */
export function loadCustomWorkspaces(): Workspace[] {
  const raw = readJSON<unknown[]>(KEY, []);
  if (!Array.isArray(raw)) return [];
  const out: Workspace[] = [];
  for (const w of raw) {
    const ws = w as Partial<Workspace>;
    if (!ws || typeof ws.id !== "string" || typeof ws.name !== "string" || !ws.layout) continue;
    out.push({ id: ws.id, name: ws.name, builtin: false, layout: clampLayout(ws.layout as WorkspaceLayout) });
  }
  return out;
}

/** Insert or update a custom workspace by id. Returns the new custom list. */
export function saveCustomWorkspace(ws: Workspace): Workspace[] {
  const clean: Workspace = { id: ws.id, name: ws.name, builtin: false, layout: clampLayout(ws.layout) };
  const list = loadCustomWorkspaces().filter((w) => w.id !== clean.id);
  list.push(clean);
  writeJSON(KEY, list);
  return list;
}

/** Delete a custom workspace by id. Returns the new custom list. */
export function deleteCustomWorkspace(id: string): Workspace[] {
  const list = loadCustomWorkspaces().filter((w) => w.id !== id);
  writeJSON(KEY, list);
  return list;
}

/** Active workspace id (falls back to default). */
export function loadActiveWorkspaceId(): string {
  const id = readJSON<string>(KEY_ACTIVE, DEFAULT_WORKSPACE_ID);
  return typeof id === "string" && id ? id : DEFAULT_WORKSPACE_ID;
}

export function saveActiveWorkspaceId(id: string): void {
  writeJSON(KEY_ACTIVE, id);
}

/** A live, un-saved layout override for the active workspace (transient edits). */
export function loadLayoutOverride(): WorkspaceLayout | null {
  const raw = readJSON<WorkspaceLayout | null>(KEY_OVERRIDE, null);
  if (!raw) return null;
  try {
    return clampLayout(raw);
  } catch {
    return null;
  }
}

export function saveLayoutOverride(layout: WorkspaceLayout | null): void {
  if (layout == null) {
    removeKey(KEY_OVERRIDE);
    return;
  }
  writeJSON(KEY_OVERRIDE, clampLayout(layout));
}

/** Builtin presets followed by the user's custom workspaces. */
export function allWorkspaces(): Workspace[] {
  return [...BUILTIN_WORKSPACES, ...loadCustomWorkspaces()];
}

/** Generate a stable-ish id for a new custom workspace. */
export function newWorkspaceId(): string {
  return `ws_${Math.random().toString(36).slice(2, 8)}${Date.now().toString(36).slice(-4)}`;
}
