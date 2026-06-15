"use client";
import { useEffect, useState, useMemo, useRef } from "react";
import type { PlayerRef } from "@remotion/player";
import type { MouseEvent, PointerEvent, CSSProperties } from "react";
import { Preview } from "../Preview";
import { getTracks, upsertKeyframe, clearTracks, kenBurns, keyframeCount, type KfProp } from "../../../../lib/keyframes";
import {
  type Scene, type AudioTrack, type Mix, type Snapshot, type AspectKey, type Overlay,
  TR, FPS, ASPECTS, aspectKeyFor, TYPE_COLOR,
  newScene, newOverlay, textAnchor, textFont1080, textWeight, primaryText, setPrimaryText,
  sceneAtFrame, cloneScene, splitScene, mergeScenes, trackDefaults, hslColor,
} from "./lib";
import { OverlayLayer } from "./OverlayLayer";
import { TopBar } from "./TopBar";
import { ShortcutPanel } from "./ShortcutPanel";
import { LayersPanel } from "./LayersPanel";
import { ContextMenu } from "./ContextMenu";
import { CanvasTextOverlay } from "./CanvasTextOverlay";
import { TextPopover } from "./TextPopover";
import { InspectorScene } from "./InspectorScene";
import { InspectorStyle } from "./InspectorStyle";
import { InspectorSubtitles } from "./InspectorSubtitles";
import { InspectorMix } from "./InspectorMix";
import { InspectorTranscript } from "./InspectorTranscript";
import { InspectComponent } from "./InspectComponent";
import { TimelineBar } from "./TimelineBar";
import { Transport } from "./Transport";
import { Timeline } from "./Timeline";
import { AudioLanes } from "./AudioLanes";
import { Splitter } from "./Splitter";
import { DockPanel } from "./DockPanel";
import {
  type WorkspaceLayout, type Workspace, type PanelId, type InspectorTab, type Region,
  PANEL_IDS, PANEL_META, SIZE_BOUNDS, DEFAULT_WORKSPACE_ID,
  clampLayout, getBuiltin, allWorkspaces, newWorkspaceId,
  loadActiveWorkspaceId, saveActiveWorkspaceId, loadLayoutOverride, saveLayoutOverride,
  saveCustomWorkspace, deleteCustomWorkspace, loadCustomWorkspaces,
} from "./workspace";

export default function Editor({ id }: { id: string }) {
  const [item, setItem] = useState<any>(null);
  const [renderProps, setRenderProps] = useState<any>(null);
  const [scenes, setScenes] = useState<Scene[]>([]);
  const [mix, setMix] = useState<Mix>({});
  const [sel, setSel] = useState(0);
  // ── Workspace / dockable-panel state ───────────────────────────────────────
  // The active inspector tab now lives inside the layout object (single source of
  // truth). `layout` describes panel visibility/region/order, region sizes, and
  // the active inspector tab; it is the live (possibly unsaved) layout. On first
  // mount we hydrate from a transient localStorage override, else the active
  // saved/builtin workspace, else the Default builtin — all SSR-safe so server
  // and first client render agree (initializers only touch window in the browser).
  // Both initialize to the SSR-safe Default so the server HTML and the first
  // client (hydration) render produce identical DOM — no hydration mismatch /
  // layout flash. Any stored override / active workspace is applied in a
  // post-mount effect (see below), after hydration is complete.
  const [activeWorkspaceId, setActiveWorkspaceId] = useState<string>(DEFAULT_WORKSPACE_ID);
  const [layout, setLayout] = useState<WorkspaceLayout>(() =>
    clampLayout((getBuiltin(DEFAULT_WORKSPACE_ID) as Workspace).layout),
  );
  // Hydrate from localStorage AFTER the first render so server/client agree. The
  // ref also guards the persistence effect from clobbering storage on mount.
  const wsHydrated = useRef(false);
  // setTab writes the active inspector tab into the layout (single source of truth).
  const setTab = (t: InspectorTab) => setLayout((l) => (l.inspectorTab === t ? l : { ...l, inspectorTab: t }));
  const tab = layout.inspectorTab;
  const [tool, setTool] = useState<"select" | "razor" | "stitch" | "text">("select");
  // Mobile-only drawer toggles (≤900px): the right inspector dock slides in as a
  // full-height overlay, the bottom timeline dock as a bottom sheet. Desktop
  // ignores these (CSS only reads the classes under the mobile breakpoint).
  const [mInspectorOpen, setMInspectorOpen] = useState(false);
  const [mTimelineOpen, setMTimelineOpen] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number; i: number; kind: "scene" | "audio" } | null>(null);
  const [selTrack, setSelTrack] = useState("music");
  const [showKeys, setShowKeys] = useState(false);
  const [hoverCut, setHoverCut] = useState<{ i: number; ratio: number } | null>(null);
  const [textPopover, setTextPopover] = useState<{ x: number; y: number } | null>(null);
  const [inspect, setInspect] = useState<number | null>(null);
  // History is tracked in refs (past/future) so it doesn't churn the editor on
  // every keystroke. This bumps a counter purely to force a re-render after a
  // history change so derived UI (TopBar canUndo/canRedo) re-evaluates — the
  // value itself is never read, only the act of setting it matters.
  const [, forceHistoryRender] = useState(0);
  const setHistoryTick = (fn: (v: number) => number) => forceHistoryRender(fn);
  const [withVoice, setWithVoice] = useState(true);
  const [withBroll, setWithBroll] = useState(true);
  const [state, setState] = useState<"idle" | "saving" | "rendering">("idle");
  const [drag, setDrag] = useState<number | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [playFrame, setPlayFrame] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(false);
  const [snapBeat, setSnapBeat] = useState(false); // C7: snap razor/trim to nearest beat
  const [safeZones, setSafeZones] = useState(false); // C5: TikTok/Reels/Shorts safe-zone overlay
  const [dims, setDims] = useState<{ width: number; height: number }>({ width: 1080, height: 1920 }); // F2: output aspect/dims
  // C11: Layers panel is now a dockable panel — its visibility lives in layout.
  // `layersOpen` is derived; the TopBar "Layers" button toggles the panel.
  const [trimLive, setTrimLive] = useState<{ i: number; durationSec: number } | null>(null); // C1: live trim readout
  // Free-form overlay layer state (overlays live on scene.overlays, saved via scenes PATCH)
  const [selOverlay, setSelOverlay] = useState<string | null>(null);
  const [overlayAddOpen, setOverlayAddOpen] = useState(false);
  const [overlayEmojiOpen, setOverlayEmojiOpen] = useState(false);
  const overlayDragRef = useRef<{ id: string; x: number; y: number; sx: number; sy: number; previewW: number } | null>(null);
  const overlayBoxRef = useRef<{ id: string; mode: "scale" | "rotate"; startX: number; startY: number; startScale: number; startRot: number; cx: number; cy: number } | null>(null);
  const trimRef = useRef<{ i: number; startX: number; startDur: number; pxPerSec: number } | null>(null); // C1: trim drag bookkeeping
  const boxRef = useRef<{ mode: "scale" | "rotate"; corner: string; startX: number; startY: number; startScale: number; startRot: number; cx: number; cy: number } | null>(null); // C5: transform-box drag
  const playerRef = useRef<PlayerRef>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const canvasTextRef = useRef<HTMLTextAreaElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const [frameBox, setFrameBox] = useState({ w: 0, h: 0 });
  const textDragRef = useRef<{ x: number; y: number; sx: number; sy: number; previewW: number } | null>(null);
  const lastSnap = useRef<string>("");
  const applyingHistory = useRef(false);
  const past = useRef<string[]>([]);
  const future = useRef<string[]>([]);
  const histSuppress = useRef(false); // pause per-frame history capture during a drag
  const dragSnap = useRef<string | null>(null); // snapshot taken at drag start
  const skipStageClick = useRef(false); // set when an outside-mousedown closes the editor, so the trailing click doesn't reopen it

  const snapshot = (nextScenes = scenes, nextMix = mix): Snapshot => ({ scenes: nextScenes, mix: nextMix });
  const restoreSnapshot = (raw: string) => {
    const snap = JSON.parse(raw) as Snapshot;
    applyingHistory.current = true;
    setScenes(snap.scenes);
    setMix(snap.mix);
    setSel((cur) => Math.max(0, Math.min(cur, snap.scenes.length - 1)));
  };
  const undo = () => {
    const prev = past.current.pop();
    if (!prev) return;
    future.current.push(JSON.stringify(snapshot()));
    restoreSnapshot(prev);
    setHistoryTick((v) => v + 1);
  };
  const redo = () => {
    const next = future.current.pop();
    if (!next) return;
    past.current.push(JSON.stringify(snapshot()));
    restoreSnapshot(next);
    setHistoryTick((v) => v + 1);
  };

  // ── Workspace handlers ─────────────────────────────────────────────────────
  // Switch to a workspace: load its layout (builtin or custom) as the live layout
  // and clear any transient override so the preset shows verbatim.
  const pickWorkspace = (id: string) => {
    const ws = allWorkspaces().find((w) => w.id === id);
    if (!ws) return;
    setActiveWorkspaceId(id);
    setLayout(clampLayout(ws.layout));
    saveLayoutOverride(null);
  };
  // Save the current live layout as a brand-new custom workspace and select it.
  const saveAsWorkspace = (name: string) => {
    const ws: Workspace = { id: newWorkspaceId(), name, builtin: false, layout: clampLayout(layout) };
    saveCustomWorkspace(ws);
    setActiveWorkspaceId(ws.id);
    saveActiveWorkspaceId(ws.id);
    saveLayoutOverride(null);
  };
  const renameWorkspace = (id: string, name: string) => {
    const ws = loadCustomWorkspaces().find((w) => w.id === id);
    if (!ws) return;
    saveCustomWorkspace({ ...ws, name });
  };
  const deleteWorkspace = (id: string) => {
    deleteCustomWorkspace(id);
    if (activeWorkspaceId === id) pickWorkspace(DEFAULT_WORKSPACE_ID);
  };
  // Reset the live layout to the active workspace's saved/preset layout.
  const resetToPreset = () => {
    const ws = allWorkspaces().find((w) => w.id === activeWorkspaceId) ?? getBuiltin(DEFAULT_WORKSPACE_ID)!;
    setLayout(clampLayout(ws.layout));
    saveLayoutOverride(null);
  };
  const togglePanel = (id: PanelId) =>
    setLayout((l) => ({ ...l, panels: { ...l.panels, [id]: { ...l.panels[id], visible: !l.panels[id].visible } } }));
  const setPanelVisible = (id: PanelId, visible: boolean) =>
    setLayout((l) => (l.panels[id].visible === visible ? l : { ...l, panels: { ...l.panels, [id]: { ...l.panels[id], visible } } }));
  // Apply a pixel delta to a region size, clamped to its bounds.
  const setRegionSize = (which: "rightW" | "bottomH", deltaPx: number) =>
    setLayout((l) => {
      const b = SIZE_BOUNDS[which];
      const next = Math.min(b.max, Math.max(b.min, l.sizes[which] + deltaPx));
      if (next === l.sizes[which]) return l;
      return { ...l, sizes: { ...l.sizes, [which]: next } };
    });
  // Derived Layers-panel toggle for the TopBar button.
  const layersOpen = layout.panels.layers.visible;
  // Evaluate the updater against the current visibility so non-toggle callers
  // (e.g. force-close) behave correctly, not just the (v)=>!v toggle.
  const setLayersOpen = (fn: (v: boolean) => boolean) =>
    setPanelVisible("layers", fn(layout.panels.layers.visible));

  // measure the real (letterboxed) video rect inside the stage so on-canvas
  // overlays line up with the actual frame, not the stage box around it.
  useEffect(() => {
    const el = frameRef.current;
    if (!el) return;
    const measure = () => setFrameBox({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [item]);

  // track the player's current frame for the timeline playhead
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const p = playerRef.current;
      const f = p?.getCurrentFrame?.();
      if (typeof f === "number") setPlayFrame(f);
      const pl = p?.isPlaying?.();
      if (typeof pl === "boolean") setPlaying(pl);
      const m = p?.isMuted?.();
      if (typeof m === "boolean") setMuted(m);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  // Hydrate the live layout/active workspace from localStorage once, post-mount,
  // so the first client render matches the server (SSR-safe Default) and we only
  // diverge afterwards. Prefer a transient override, then the saved/builtin
  // active workspace, then the Default builtin. Marks hydration complete so the
  // persistence effect below may start saving.
  useEffect(() => {
    const base = (getBuiltin(DEFAULT_WORKSPACE_ID) as Workspace).layout;
    const override = loadLayoutOverride();
    if (override) {
      setLayout(override);
    } else {
      const activeId = loadActiveWorkspaceId();
      const ws = allWorkspaces().find((w) => w.id === activeId);
      setLayout(clampLayout(ws?.layout ?? base));
    }
    setActiveWorkspaceId(loadActiveWorkspaceId());
    wsHydrated.current = true;
  }, []);

  // Persist the live layout (as a transient override) + the active workspace id.
  // Skipped until hydration completes so we never clobber storage with the
  // initial SSR Default; thereafter every layout/active change is saved.
  useEffect(() => {
    if (!wsHydrated.current) return;
    saveLayoutOverride(layout);
    saveActiveWorkspaceId(activeWorkspaceId);
  }, [layout, activeWorkspaceId]);

  useEffect(() => {
    fetch(`/api/item/${id}`).then((r) => r.json()).then((it) => {
      setItem(it);
      setScenes(it.storyboard?.scenes ?? []);
      const w = Number(it.storyboard?.width) || 1080;
      const h = Number(it.storyboard?.height) || 1920;
      setDims({ width: w, height: h });
      const nextMix = it.mix ?? { musicVol: 1, voiceVol: 1, sfxVol: 1, beatIntensity: 1 };
      setMix({ ...nextMix, tracks: trackDefaults(nextMix) });
    });
    fetch(`/api/props/${id}`).then((r) => (r.ok ? r.json() : null)).then(setRenderProps).catch(() => {});
  }, [id]);

  useEffect(() => {
    const raw = JSON.stringify(snapshot());
    if (!lastSnap.current) {
      lastSnap.current = raw;
      return;
    }
    if (raw === lastSnap.current) return;
    if (applyingHistory.current) {
      applyingHistory.current = false;
      lastSnap.current = raw;
      return;
    }
    // during a drag, keep the live state in sync but defer recording so the
    // whole drag collapses into a single undo step (pushed on pointer-up).
    if (histSuppress.current) {
      lastSnap.current = raw;
      return;
    }
    past.current.push(lastSnap.current);
    if (past.current.length > 80) past.current.shift();
    future.current = [];
    lastSnap.current = raw;
    setHistoryTick((v) => v + 1);
  }, [scenes, mix]);

  const liveProps = useMemo(() => {
    if (!renderProps?.storyboard) return null;
    return { ...renderProps, storyboard: { ...renderProps.storyboard, scenes }, mix };
  }, [renderProps, scenes, mix]);
  const inspectProps = useMemo(() => {
    if (!liveProps?.storyboard || inspect === null || !scenes[inspect]) return null;
    const soloScene = scenes[inspect];
    return {
      ...liveProps,
      storyboard: {
        ...liveProps.storyboard,
        scenes: [soloScene],
        hook: primaryText(soloScene) || liveProps.storyboard.hook,
      },
      subtitles: [],
      words: undefined,
      sfx: [],
      mix: { ...mix, muteMusic: true, muteVoice: true, muteSfx: true },
      brolls: liveProps.brolls?.[inspect] ? [liveProps.brolls[inspect]] : [],
    };
  }, [liveProps, scenes, inspect, mix]);

  const total = scenes.reduce((a, s) => a + (s.durationSec || 0), 0);
  const durFs = scenes.map((sc) => Math.max(2 * TR + 4, Math.round((sc.durationSec || 2) * FPS)));
  const totalF = durFs.reduce((a, d) => a + d, 0) - Math.max(0, durFs.length - 1) * TR + (100 - TR);
  const playFrac = totalF > 0 ? Math.min(1, playFrame / totalF) : 0;
  const sceneStart = (i: number) => { let cur = 0; for (let j = 0; j < i; j++) cur += durFs[j] - TR; return cur; };
  // ── Beat markers + snap-to-beat (C7) ──────────────────────────────────────
  const beatFrames: number[] = useMemo(
    () => (Array.isArray(renderProps?.beatFrames) ? (renderProps.beatFrames as number[]).filter((f) => f >= 0 && f <= totalF) : []),
    [renderProps, totalF],
  );
  // snap an absolute frame to the nearest beat (within tolerance) when enabled
  const snapFrameToBeat = (frame: number, tolFrames = 6): number => {
    if (!snapBeat || !beatFrames.length) return frame;
    let best = frame, bestD = Infinity;
    for (const b of beatFrames) { const d = Math.abs(b - frame); if (d < bestD) { bestD = d; best = b; } }
    return bestD <= tolFrames ? best : frame;
  };
  // snap a within-scene ratio to the nearest beat (for razor splits) when enabled
  const snapRatioToBeat = (i: number, ratio: number): number => {
    if (!snapBeat || !beatFrames.length) return ratio;
    const start = sceneStart(i);
    const abs = snapFrameToBeat(start + ratio * durFs[i]);
    return Math.max(0, Math.min(1, (abs - start) / Math.max(1, durFs[i])));
  };
  const seekToRatio = (ratio: number) => {
    if (totalF <= 0) return;
    const frame = Math.round(Math.max(0, Math.min(1, ratio)) * totalF);
    setPlayFrame(frame);
    setSel(sceneAtFrame(scenes, frame));
    playerRef.current?.seekTo?.(frame);
  };
  const seekFromEl = (el: HTMLElement | null, clientX: number) => {
    if (!el) return;
    const rect = el.getBoundingClientRect();
    seekToRatio((clientX - rect.left) / Math.max(1, rect.width));
  };
  const seekTimeline = (clientX: number) => seekFromEl(trackRef.current, clientX);
  const togglePlay = () => { const p = playerRef.current; if (!p) return; (p.isPlaying?.() ? p.pause : p.play)?.call(p); };
  const stepFrame = (delta: number) => {
    const cur = playerRef.current?.getCurrentFrame?.() ?? playFrame;
    const next = Math.max(0, Math.min(totalF, Math.round(cur + delta)));
    playerRef.current?.pause?.();
    playerRef.current?.seekTo?.(next);
    setPlayFrame(next);
    setSel(sceneAtFrame(scenes, next));
  };
  const toggleMute = () => { const p = playerRef.current; if (!p) return; (p.isMuted?.() ? p.unmute : p.mute)?.call(p); };
  const goFullscreen = () => playerRef.current?.requestFullscreen?.();
  const fmtClock = (frame: number) => {
    const s = Math.max(0, Math.round(frame / FPS));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  };
  const scrubPlayhead = (e: PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    seekTimeline(e.clientX);
  };
  // C11: locked scenes ignore edits — patch/patchStyle no-op when the target is
  // locked. Lock/hide toggles themselves go through setScenes directly so they
  // remain operable on a locked row.
  const patch = (i: number, p: Partial<Scene>) => setScenes((ss) => ss.map((s, j) => (j === i ? (s.locked ? s : { ...s, ...p }) : s)));
  const patchStyle = (i: number, p: any) => { if (scenes[i]?.locked) return; patch(i, { style: { ...(scenes[i].style ?? {}), ...p } }); };
  // C11: layer toggles bypass the lock guard so locked/hidden rows stay operable.
  const toggleLock = (i: number) => setScenes((ss) => ss.map((sc, j) => (j === i ? { ...sc, locked: !sc.locked } : sc)));
  const toggleHidden = (i: number) => setScenes((ss) => ss.map((sc, j) => (j === i ? { ...sc, hidden: !sc.hidden } : sc)));
  // ── Keyframe authoring (C2) ──────────────────────────────────────────────
  const patchKeyframes = (tracks: ReturnType<typeof getTracks>) => patchStyle(sel, { keyframes: tracks.length ? tracks : undefined });
  const sceneKfTime = () => (durFs[sel] ? Math.max(0, Math.min(1, (playFrame - sceneStart(sel)) / durFs[sel])) : 0);
  const curPropValue = (prop: KfProp): number => {
    const st = scenes[sel]?.style ?? {};
    if (prop === "x") return Number(st.x ?? 0);
    if (prop === "y") return Number(st.y ?? 0);
    if (prop === "rotation") return Number(st.rotation ?? 0);
    if (prop === "opacity") return Number(st.opacity ?? 1);
    return 1; // scale base
  };
  const addKeyAtPlayhead = (prop: KfProp) => patchKeyframes(upsertKeyframe(getTracks(scenes[sel]?.style), prop, sceneKfTime(), curPropValue(prop)));
  const applyKenBurns = (dir: "in" | "out") => patchKeyframes(kenBurns(0.14, dir));
  const clearMotion = () => patchKeyframes(clearTracks(getTracks(scenes[sel]?.style)));
  const s = scenes[sel] ?? scenes[0] ?? {};
  const patchSelectedText = (value: string) => { if (scenes[sel]?.locked) return; setScenes((ss) => ss.map((x, j) => (j === sel ? setPrimaryText(x, value) : x))); };
  const selectedText = primaryText(s);
  const beginTextDrag = (e: PointerEvent<HTMLElement>) => {
    e.preventDefault();
    e.stopPropagation();
    const previewW = frameBox.w || (frameRef.current?.clientWidth ?? 420);
    textDragRef.current = { x: e.clientX, y: e.clientY, sx: Number(s.style?.x ?? 0), sy: Number(s.style?.y ?? 0), previewW: Math.max(1, previewW) };
    dragSnap.current = JSON.stringify(snapshot()); // remember state before the move
    histSuppress.current = true;
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const moveTextDrag = (e: PointerEvent<HTMLElement>) => {
    if (!textDragRef.current || !e.currentTarget.hasPointerCapture(e.pointerId)) return;
    e.preventDefault();
    const d = textDragRef.current;
    const scale = 1080 / d.previewW;
    patchStyle(sel, {
      x: Math.round(Math.max(-420, Math.min(420, d.sx + (e.clientX - d.x) * scale))),
      y: Math.round(Math.max(-720, Math.min(720, d.sy + (e.clientY - d.y) * scale))),
    });
  };
  const endTextDrag = () => {
    textDragRef.current = null;
    if (!histSuppress.current) return;
    histSuppress.current = false;
    const before = dragSnap.current;
    dragSnap.current = null;
    const after = JSON.stringify(snapshot());
    if (before && before !== after) {
      past.current.push(before);
      if (past.current.length > 80) past.current.shift();
      future.current = [];
      lastSnap.current = after;
      setHistoryTick((v) => v + 1);
    }
  };
  const resetTextTransform = () => patchStyle(sel, { x: undefined, y: undefined, rotation: undefined, fontScale: undefined, letterSpacing: undefined, lineHeight: undefined, paragraphSpacing: undefined });
  // ── On-canvas 8-handle transform box (C5) ─────────────────────────────────
  // Resize handles scale the text via style.fontScale (corner drag = uniform;
  // Shift keeps the current aspect, which here is already uniform-only). The
  // rotation handle rotates with 15deg snap when Shift is held. Alignment guides
  // (to canvas center/edges) light up while a handle is being dragged.
  const beginBoxDrag = (e: PointerEvent<HTMLElement>, mode: "scale" | "rotate", corner: string) => {
    e.preventDefault();
    e.stopPropagation();
    const box = (e.currentTarget.closest(".canvas-text-select") as HTMLElement | null)?.getBoundingClientRect();
    const cx = box ? box.left + box.width / 2 : e.clientX;
    const cy = box ? box.top + box.height / 2 : e.clientY;
    boxRef.current = {
      mode, corner, startX: e.clientX, startY: e.clientY,
      startScale: Number(s.style?.fontScale ?? 1), startRot: Number(s.style?.rotation ?? 0),
      cx, cy,
    };
    dragSnap.current = JSON.stringify(snapshot());
    histSuppress.current = true;
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const moveBoxDrag = (e: PointerEvent<HTMLElement>) => {
    const b = boxRef.current;
    if (!b || !e.currentTarget.hasPointerCapture(e.pointerId)) return;
    e.preventDefault();
    if (b.mode === "rotate") {
      const ang = Math.atan2(e.clientY - b.cy, e.clientX - b.cx) * 180 / Math.PI + 90;
      let rot = ang;
      if (e.shiftKey) rot = Math.round(rot / 15) * 15;
      patchStyle(sel, { rotation: Math.max(-180, Math.min(180, Math.round(rot))) });
      return;
    }
    // scale: use the pointer's distance from box center vs the start distance
    const startD = Math.hypot(b.startX - b.cx, b.startY - b.cy) || 1;
    const curD = Math.hypot(e.clientX - b.cx, e.clientY - b.cy);
    const next = Math.max(0.4, Math.min(2.5, Number((b.startScale * (curD / startD)).toFixed(2))));
    patchStyle(sel, { fontScale: next });
  };
  const endBoxDrag = (e: PointerEvent<HTMLElement>) => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    boxRef.current = null;
    endTextDrag();
  };
  // ── Free-form overlay layer ───────────────────────────────────────────────
  // Overlays are stored on the selected scene (scene.overlays) and saved through
  // the existing scenes PATCH. Each authoring action is one undo step; drags
  // collapse into a single step via the same dragSnap/histSuppress mechanism.
  const sceneOverlays: Overlay[] = scenes[sel]?.overlays ?? [];
  const setSceneOverlays = (next: Overlay[]) => {
    if (scenes[sel]?.locked) return;
    setScenes((ss) => ss.map((x, j) => (j === sel ? { ...x, overlays: next.length ? next : undefined } : x)));
  };
  const addOverlay = (make: () => Omit<Overlay, "id" | "x" | "y">) => {
    if (scenes[sel]?.locked) return;
    const ov = newOverlay(make);
    setSceneOverlays([...sceneOverlays, ov]);
    setSelOverlay(ov.id);
    setOverlayAddOpen(false);
    setOverlayEmojiOpen(false);
  };
  const addOverlayEmoji = (emoji: string) => addOverlay(() => ({ type: "emoji", content: emoji, scale: 1, rotation: 0, opacity: 1 }));
  const patchOverlay = (oid: string, p: Partial<Overlay>) => {
    if (scenes[sel]?.locked) return;
    setSceneOverlays(sceneOverlays.map((o) => (o.id === oid ? { ...o, ...p } : o)));
  };
  const deleteOverlay = (oid: string) => {
    if (scenes[sel]?.locked) return;
    setSceneOverlays(sceneOverlays.filter((o) => o.id !== oid));
    setSelOverlay((cur) => (cur === oid ? null : cur));
  };
  const pushDragHistory = (before: string | null) => {
    histSuppress.current = false;
    dragSnap.current = null;
    const after = JSON.stringify(snapshot());
    if (before && before !== after) {
      past.current.push(before);
      if (past.current.length > 80) past.current.shift();
      future.current = [];
      lastSnap.current = after;
      setHistoryTick((v) => v + 1);
    }
  };
  const beginOverlayDrag = (e: PointerEvent<HTMLElement>, oid: string) => {
    if (scenes[sel]?.locked) return;
    e.preventDefault();
    e.stopPropagation();
    setSelOverlay(oid);
    const o = sceneOverlays.find((x) => x.id === oid);
    const previewW = frameBox.w || (frameRef.current?.clientWidth ?? 420);
    overlayDragRef.current = { id: oid, x: e.clientX, y: e.clientY, sx: Number(o?.x ?? 0), sy: Number(o?.y ?? 0), previewW: Math.max(1, previewW) };
    dragSnap.current = JSON.stringify(snapshot());
    histSuppress.current = true;
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const moveOverlayDrag = (e: PointerEvent<HTMLElement>) => {
    const d = overlayDragRef.current;
    if (!d || !e.currentTarget.hasPointerCapture(e.pointerId)) return;
    e.preventDefault();
    const scale = 1080 / d.previewW;
    patchOverlay(d.id, {
      x: Math.round(Math.max(-540, Math.min(540, d.sx + (e.clientX - d.x) * scale))),
      y: Math.round(Math.max(-960, Math.min(960, d.sy + (e.clientY - d.y) * scale))),
    });
  };
  const endOverlayDrag = (e: PointerEvent<HTMLElement>) => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    if (!overlayDragRef.current) return;
    overlayDragRef.current = null;
    if (!histSuppress.current) return;
    pushDragHistory(dragSnap.current);
  };
  const beginOverlayBox = (e: PointerEvent<HTMLElement>, oid: string, mode: "scale" | "rotate") => {
    if (scenes[sel]?.locked) return;
    e.preventDefault();
    e.stopPropagation();
    const box = (e.currentTarget.closest(".ovl-item") as HTMLElement | null)?.getBoundingClientRect();
    const cx = box ? box.left + box.width / 2 : e.clientX;
    const cy = box ? box.top + box.height / 2 : e.clientY;
    const o = sceneOverlays.find((x) => x.id === oid);
    overlayBoxRef.current = {
      id: oid, mode, startX: e.clientX, startY: e.clientY,
      startScale: Number(o?.scale ?? 1), startRot: Number(o?.rotation ?? 0), cx, cy,
    };
    dragSnap.current = JSON.stringify(snapshot());
    histSuppress.current = true;
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const moveOverlayBox = (e: PointerEvent<HTMLElement>) => {
    const b = overlayBoxRef.current;
    if (!b || !e.currentTarget.hasPointerCapture(e.pointerId)) return;
    e.preventDefault();
    if (b.mode === "rotate") {
      const ang = Math.atan2(e.clientY - b.cy, e.clientX - b.cx) * 180 / Math.PI + 90;
      let rot = ang;
      if (e.shiftKey) rot = Math.round(rot / 15) * 15;
      patchOverlay(b.id, { rotation: Math.max(-180, Math.min(180, Math.round(rot))) });
      return;
    }
    const startD = Math.hypot(b.startX - b.cx, b.startY - b.cy) || 1;
    const curD = Math.hypot(e.clientX - b.cx, e.clientY - b.cy);
    const next = Math.max(0.2, Math.min(6, Number((b.startScale * (curD / startD)).toFixed(2))));
    patchOverlay(b.id, { scale: next });
  };
  const endOverlayBox = (e: PointerEvent<HTMLElement>) => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    if (!overlayBoxRef.current) return;
    overlayBoxRef.current = null;
    if (!histSuppress.current) return;
    pushDragHistory(dragSnap.current);
  };
  const audioTracks = trackDefaults(mix);
  const selectedTrack = audioTracks.find((t) => t.id === selTrack) ?? audioTracks[0];
  const subtitleSettings = {
    enabled: true,
    mode: "karaoke" as const,
    preset: (mix.captionStyle ?? "pop") as "pop" | "bounce" | "phrase" | "hormozi" | "glow",
    position: "bottom" as const,
    fontScale: 1,
    letterSpacing: -0.01,
    lineHeight: 1.12,
    background: false,
    backgroundOpacity: 0.48,
    highlightColor: s.style?.accent ?? "",
    inactiveOpacity: 0.32,
    maxWords: 4,
    ...(mix.subtitles ?? {}),
  };
  const patchSubtitles = (p: Partial<NonNullable<Mix["subtitles"]>>) => {
    const nextSubtitles = { ...(mix.subtitles ?? {}), ...p };
    setMix({ ...mix, subtitles: nextSubtitles, captionStyle: nextSubtitles.preset ?? mix.captionStyle });
  };

  const addScene = (type: string) => {
    const ns = [...scenes];
    ns.splice(sel + 1, 0, newScene(type));
    setScenes(ns); setSel(sel + 1); setAddOpen(false);
  };
  const dup = () => { const ns = [...scenes]; ns.splice(sel + 1, 0, cloneScene(s)); setScenes(ns); setSel(sel + 1); };
  const delAt = (i: number) => { if (scenes[i]?.locked) return; if (scenes.length <= 2) return; const ns = scenes.filter((_, j) => j !== i); setScenes(ns); setSel(Math.max(0, Math.min(i - 1, ns.length - 1))); };
  const del = () => delAt(sel);
  // C1: ripple delete — remove the scene and close the gap. Scenes are sequential
  // so removal already collapses; this is the same as delAt plus a playhead reseat.
  const rippleDelAt = (i: number) => {
    if (scenes.length <= 2) return;
    delAt(i);
    const target = Math.max(0, Math.min(i, scenes.length - 2));
    requestAnimationFrame(() => playerRef.current?.seekTo?.(sceneStart(target)));
  };
  const reorder = (from: number, to: number) => { if (from === to) return; const ns = [...scenes]; const [m] = ns.splice(from, 1); ns.splice(to, 0, m); setScenes(ns); setSel(to); };
  const splitAt = (i: number, ratio = 0.5) => {
    const current = scenes[i];
    if (!current || current.locked) return;
    const r = Math.max(0.08, Math.min(0.92, ratio));
    const [a, b] = splitScene(current, r);
    const ns = [...scenes];
    ns.splice(i, 1, a, b);
    setScenes(ns);
    setSel(i + 1);
    playerRef.current?.seekTo?.(sceneStart(i) + Math.round(Math.max(1, a.durationSec) * FPS));
  };
  const stitchAt = (i: number, preferNext = true) => {
    if (scenes.length <= 1) return;
    const left = preferNext ? i : i - 1;
    if (left < 0 || left >= scenes.length - 1) return;
    if (scenes[left]?.locked || scenes[left + 1]?.locked) return;
    const ns = [...scenes];
    ns.splice(left, 2, mergeScenes(ns[left], ns[left + 1]));
    setScenes(ns);
    setSel(left);
    playerRef.current?.seekTo?.(sceneStart(left));
  };
  const setSceneSpeed = (i: number, speed: number) => {
    const current = scenes[i];
    if (!current) return;
    const baseDuration = current.baseDurationSec ?? current.durationSec ?? 2;
    patch(i, { speed, baseDurationSec: baseDuration, durationSec: Number((baseDuration / speed).toFixed(2)) });
  };
  // F2: pick an output aspect — sets the stored storyboard dims, the on-canvas
  // frame ratio, and the <Preview> composition. Persisted on save.
  const currentAspectKey = aspectKeyFor(dims.width, dims.height);
  const currentAspect = ASPECTS.find((a) => a.key === currentAspectKey) ?? ASPECTS[0];
  const setAspect = (key: AspectKey) => {
    const a = ASPECTS.find((x) => x.key === key) ?? ASPECTS[0];
    setDims({ width: a.width, height: a.height });
  };
  // C10: one-click pro pass — enable duck, hormozi subtitles, Ken Burns on
  // image/b-roll scenes, and mark the 1-2 longest scenes as beat peaks. Single
  // undoable action: state changes from one event collapse into one history step.
  const autoEdit = () => {
    setMix((m) => ({
      ...m,
      duck: { ...(m.duck ?? {}), enabled: true },
      captionStyle: "hormozi",
      subtitles: { ...(m.subtitles ?? {}), enabled: true, preset: "hormozi" },
    }));
    setScenes((ss) => {
      // indices of the 1-2 longest scenes → emphasis (beat peak)
      const ranked = ss.map((sc, i) => ({ i, d: sc.durationSec || 2 })).sort((a, b) => b.d - a.d);
      const peaks = new Set(ranked.slice(0, Math.min(2, ranked.length)).map((r) => r.i));
      return ss.map((sc, i) => {
        if (sc.locked) return sc;
        let next = { ...sc };
        if (peaks.has(i)) next.emphasis = true;
        const visual = sc.type === "image_focus" || !!sc.broll;
        if (visual && keyframeCount(getTracks(sc.style)) === 0) {
          next.style = { ...(sc.style ?? {}), keyframes: kenBurns(0.14, "in") };
        }
        return next;
      });
    });
  };
  // ── Clip trim (C1) ────────────────────────────────────────────────────────
  // Drag a scene block's tail edge to change durationSec (min 2s, max 14s),
  // snapping its end frame to the playhead, adjacent block edges, and (when
  // enabled) the nearest beat. A live readout shows seconds/frames while dragging.
  const beginTrim = (e: PointerEvent<HTMLElement>, i: number) => {
    e.preventDefault();
    e.stopPropagation();
    const block = e.currentTarget.parentElement as HTMLElement | null; // .tlb
    const pxPerSec = block ? block.getBoundingClientRect().width / Math.max(0.5, scenes[i].durationSec || 2) : 60;
    trimRef.current = { i, startX: e.clientX, startDur: scenes[i].durationSec || 2, pxPerSec: Math.max(1, pxPerSec) };
    dragSnap.current = JSON.stringify(snapshot());
    histSuppress.current = true;
    setTrimLive({ i, durationSec: scenes[i].durationSec || 2 });
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const moveTrim = (e: PointerEvent<HTMLElement>) => {
    const t = trimRef.current;
    if (!t || !e.currentTarget.hasPointerCapture(e.pointerId)) return;
    e.preventDefault();
    let dur = t.startDur + (e.clientX - t.startX) / t.pxPerSec;
    dur = Math.max(2, Math.min(14, dur));
    // snap the scene END frame to playhead / adjacent edges / beats
    const start = sceneStart(t.i);
    let endF = start + Math.max(2 * TR + 4, Math.round(dur * FPS));
    const candidates = [playFrame, sceneStart(t.i + 1), totalF, ...(snapBeat ? beatFrames : [])];
    for (const c of candidates) { if (c > start && Math.abs(c - endF) <= 6) { endF = c; break; } }
    const snappedDur = Math.max(2, Math.min(14, (endF - start) / FPS));
    const rounded = Number(snappedDur.toFixed(2));
    setTrimLive({ i: t.i, durationSec: rounded });
    patch(t.i, { durationSec: rounded, baseDurationSec: undefined, speed: 1 });
  };
  const endTrim = (e: PointerEvent<HTMLElement>) => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    trimRef.current = null;
    setTrimLive(null);
    if (!histSuppress.current) return;
    histSuppress.current = false;
    const before = dragSnap.current;
    dragSnap.current = null;
    const after = JSON.stringify(snapshot());
    if (before && before !== after) {
      past.current.push(before);
      if (past.current.length > 80) past.current.shift();
      future.current = [];
      lastSnap.current = after;
      setHistoryTick((v) => v + 1);
    }
  };
  const patchEffect = (i: number, key: string, value: any) => {
    const current = scenes[i] ?? {};
    patch(i, { effects: { ...(current.effects ?? {}), [key]: value } });
  };
  const updateTrack = (id: string, p: Partial<AudioTrack>) => {
    const tracks = trackDefaults(mix).map((t) => (t.id === id ? { ...t, ...p } : t));
    const next: Mix = { ...mix, tracks };
    if (id === "music" && p.vol !== undefined) next.musicVol = p.vol;
    if (id === "voice" && p.vol !== undefined) next.voiceVol = p.vol;
    if (id === "sfx" && p.vol !== undefined) next.sfxVol = p.vol;
    if (id === "music" && (p.mute !== undefined || p.disabled !== undefined)) next.muteMusic = p.disabled ?? p.mute;
    if (id === "voice" && (p.mute !== undefined || p.disabled !== undefined)) next.muteVoice = p.disabled ?? p.mute;
    if (id === "sfx" && (p.mute !== undefined || p.disabled !== undefined)) next.muteSfx = p.disabled ?? p.mute;
    setMix(next);
  };
  const splitAudioAtPlayhead = (id: string) => {
    const at = Math.max(0, Math.min(1, playFrac));
    const tr = trackDefaults(mix).find((t) => t.id === id);
    const splits = [...(tr?.splits ?? []), at].filter((v, i, a) => a.findIndex((x) => Math.abs(x - v) < 0.01) === i).sort((a, b) => a - b);
    updateTrack(id, { splits });
  };
  const contextForScene = (e: MouseEvent, i: number) => {
    e.preventDefault();
    setSel(i);
    setMenu({ x: e.clientX, y: e.clientY, i, kind: "scene" });
  };
  const ratioFromEvent = (e: MouseEvent<HTMLElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return Math.max(0, Math.min(1, (e.clientX - r.left) / Math.max(1, r.width)));
  };
  const clickSceneBlock = (e: MouseEvent<HTMLElement>, i: number) => {
    const ratio = ratioFromEvent(e);
    if (tool === "razor") return splitAt(i, snapRatioToBeat(i, ratio));
    if (tool === "stitch") return stitchAt(i, ratio > 0.5);
    const frame = sceneStart(i) + Math.round(ratio * durFs[i]);
    setSel(i);
    setPlayFrame(frame);
    playerRef.current?.seekTo?.(frame);
    if (tool === "text") {
      setTab("scene");
      setTextPopover({ x: 18, y: 18 });
      requestAnimationFrame(() => canvasTextRef.current?.focus());
    }
  };
  const inspectScene = (i: number) => {
    setSel(i);
    setInspect(i);
    setTextPopover(null);
    setMenu(null);
  };
  const nudgeSel = (dir: -1 | 1) => {
    const next = Math.max(0, Math.min(scenes.length - 1, sel + dir));
    setSel(next);
    playerRef.current?.seekTo?.(sceneStart(next));
  };
  const toggleMenuForSelected = () => {
    setMenu({ x: Math.round(window.innerWidth / 2) - 80, y: Math.round(window.innerHeight - 230), i: sel, kind: "scene" });
  };

  const openTextPopover = (_e: MouseEvent<HTMLDivElement>) => {
    const stage = stageRef.current;
    if (!stage) return;
    setTextPopover({ x: 18, y: 18 });
  };
  const closeTextEditor = () => { setTool("select"); setTextPopover(null); };
  const clickStage = (e: MouseEvent<HTMLDivElement>) => {
    e.stopPropagation();
    if ((e.target as HTMLElement | null)?.closest("button")) return;
    // the outside-mousedown already closed the editor on this same click — don't reopen
    if (skipStageClick.current) { skipStageClick.current = false; return; }
    // already editing → a background click dismisses (outside handler also fires)
    if (tool === "text" || textPopover) { closeTextEditor(); return; }
    const f = playerRef.current?.getCurrentFrame?.() ?? 0;
    const i = sceneAtFrame(scenes, f);
    setSel(i);
    // park the playhead mid-scene so the rendered text is past its entrance
    // animation and stays visible after the editor is dismissed.
    const mid = sceneStart(i) + Math.floor(durFs[i] / 2);
    playerRef.current?.pause?.();
    playerRef.current?.seekTo?.(mid);
    setPlayFrame(mid);
    setTool("text");
    setTab("scene");
    openTextPopover(e);
    requestAnimationFrame(() => canvasTextRef.current?.focus());
  };
  const doubleClickStage = (e: MouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    const f = playerRef.current?.getCurrentFrame?.() ?? 0;
    inspectScene(sceneAtFrame(scenes, f));
  };

  async function save() {
    setState("saving");
    await fetch(`/api/item/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ scenes, mix, width: dims.width, height: dims.height, aspect: currentAspectKey }) });
    setState("idle");
  }
  async function saveRender() {
    setState("saving");
    await fetch(`/api/item/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ scenes, mix, width: dims.width, height: dims.height, aspect: currentAspectKey }) });
    await fetch(`/api/rerender`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, voice: withVoice, broll: withBroll }) });
    setState("rendering");
  }

  // Dismiss the on-canvas text editor when clicking empty space on the CANVAS
  // (the stage/video area) — but never when using the inspector or timeline, so
  // editing tools don't collapse the session. Closing the box leaves the rest
  // of the UI and the selected scene untouched.
  useEffect(() => {
    if (tool !== "text" && !textPopover) return;
    const onDown = (e: globalThis.MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (!t) return;
      if (t.closest(".canvas-text-select") || t.closest(".text-pop")) return; // inside editor → keep
      if (!t.closest(".ed-stage")) return; // outside the canvas (inspector/timeline) → keep
      skipStageClick.current = true; // the trailing click on the stage must NOT reopen
      setTool("select");
      setTextPopover(null);
    };
    document.addEventListener("mousedown", onDown, true);
    return () => document.removeEventListener("mousedown", onDown, true);
  }, [tool, textPopover]);

  useEffect(() => {
    const isTyping = (target: EventTarget | null) => {
      const el = target as HTMLElement | null;
      if (!el || typeof el.closest !== "function") return false;
      return !!el.closest("input, textarea, select, [contenteditable='true']");
    };
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      // Undo/redo must work everywhere — including while editing a text field —
      // because controlled <textarea>s have no usable native undo. Our history
      // covers text edits, moves, and every style change uniformly.
      if (mod && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
        return;
      }
      if (mod && e.key.toLowerCase() === "y") {
        e.preventDefault();
        redo();
        return;
      }
      if (isTyping(e.target)) return;
      // Intended save combo, then bail on ANY other modifier combo so editor
      // single-key tools never hijack browser/global shortcuts (Cmd+R reload,
      // Cmd+K Copilot, Cmd+T, etc.). Cmd+Z/Y are already handled above.
      if (mod && e.key.toLowerCase() === "s") { e.preventDefault(); if (e.shiftKey) void saveRender(); else void save(); return; }
      if (mod) return;
      // C5: when the on-canvas transform box is active, arrow keys nudge the
      // text position (style.x/y); 1px default, 10px with Shift.
      if ((tool === "text" || textPopover) && (e.key === "ArrowLeft" || e.key === "ArrowRight" || e.key === "ArrowUp" || e.key === "ArrowDown")) {
        e.preventDefault();
        const step = e.shiftKey ? 10 : 1;
        const dx = e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0;
        const dy = e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0;
        patchStyle(sel, {
          x: Math.round(Math.max(-420, Math.min(420, Number(s.style?.x ?? 0) + dx))),
          y: Math.round(Math.max(-720, Math.min(720, Number(s.style?.y ?? 0) + dy))),
        });
        return;
      }
      // transport (pro-editor standard)
      if (e.key === " ") { e.preventDefault(); togglePlay(); return; }
      if (e.key === "ArrowLeft") { e.preventDefault(); stepFrame(e.shiftKey ? -FPS : -1); return; }
      if (e.key === "ArrowRight") { e.preventDefault(); stepFrame(e.shiftKey ? FPS : 1); return; }
      if (e.key === "Home") { e.preventDefault(); stepFrame(-1e9); return; }
      if (e.key === "End") { e.preventDefault(); stepFrame(1e9); return; }
      if (e.key === "?") { e.preventDefault(); setShowKeys((v) => !v); return; }
      if (e.key === "Escape") { setInspect(null); setMenu(null); setTextPopover(null); setAddOpen(false); setShowKeys(false); setTool("select"); setSelOverlay(null); setOverlayAddOpen(false); setOverlayEmojiOpen(false); return; }
      // A selected overlay takes priority for Delete/Backspace so the scene isn't removed.
      if ((e.key === "Backspace" || e.key === "Delete") && selOverlay) { e.preventDefault(); deleteOverlay(selOverlay); return; }
      if (e.key.toLowerCase() === "r") { e.preventDefault(); setTool((v) => (v === "razor" ? "select" : "razor")); return; }
      if (e.key.toLowerCase() === "t") { e.preventDefault(); setTool((v) => (v === "text" ? "select" : "text")); setTab("scene"); requestAnimationFrame(() => canvasTextRef.current?.focus()); return; }
      if (e.key.toLowerCase() === "j") { e.preventDefault(); setTool((v) => (v === "stitch" ? "select" : "stitch")); return; }
      if (e.key.toLowerCase() === "s") { e.preventDefault(); splitAt(sel); return; }
      if (e.key.toLowerCase() === "d") { e.preventDefault(); dup(); return; }
      if (e.key === "Backspace" || e.key === "Delete") { e.preventDefault(); if (e.shiftKey) rippleDelAt(sel); else del(); return; }
      if (e.key === "[") { e.preventDefault(); nudgeSel(-1); return; }
      if (e.key === "]") { e.preventDefault(); nudgeSel(1); return; }
      if (e.key === "=" || e.key === "+") { e.preventDefault(); setSceneSpeed(sel, Math.min(3, Number(((s.speed ?? 1) + 0.25).toFixed(2)))); return; }
      if (e.key === "-") { e.preventDefault(); setSceneSpeed(sel, Math.max(0.25, Number(((s.speed ?? 1) - 0.25).toFixed(2)))); return; }
      if (e.key.toLowerCase() === "a") { e.preventDefault(); setAddOpen((v) => !v); return; }
      if (e.key.toLowerCase() === "c") { e.preventDefault(); setTab("style"); return; }
      if (e.key.toLowerCase() === "m") { e.preventDefault(); setTab("mix"); return; }
      if (e.key.toLowerCase() === "e") { e.preventDefault(); setTab("scene"); return; }
      if (e.key.toLowerCase() === "x") { e.preventDefault(); toggleMenuForSelected(); return; }
      if (e.key === "1") { setSelTrack("music"); setTab("mix"); return; }
      if (e.key === "2") { setSelTrack("voice"); setTab("mix"); return; }
      if (e.key === "3") { setSelTrack("sfx"); setTab("mix"); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  if (!item) return <div className="empty">Loading</div>;

  const accent = s.style?.accent ?? "";
  const hue = s.style?.hue ?? 0;
  const saturation = s.style?.saturation ?? 0;
  const lightness = s.style?.lightness ?? 100;

  // ── On-canvas text editor geometry ──────────────────────────────────────
  // Mirror the composition transform (translate x/y in 1080-space → rotate →
  // fontScale) anchored at where this scene type renders its text, so the
  // editable overlay sits ON the real frame instead of the stage box.
  const anchor = textAnchor(s.type);
  const pxPer = frameBox.w ? frameBox.w / 1080 : 0; // screen px per composition px
  const padX = frameBox.w * (96 / 1080); // composition PAD
  const canvasOX = Number(s.style?.x ?? 0) * pxPer;
  const canvasOY = Number(s.style?.y ?? 0) * pxPer;
  const canvasBaseTop = anchor.v === "top" ? frameBox.h * 0.17 : anchor.v === "bottom" ? frameBox.h * 0.8 : frameBox.h / 2;
  const canvasFontPx = Math.max(12, textFont1080(s.type) * pxPer);
  const canvasFontWeight = textWeight(s.type);
  const canvasLineHeight = s.style?.lineHeight ?? (canvasFontPx >= 40 ? 1.06 : 1.18);
  const canvasTextStyle: CSSProperties = {
    position: "absolute",
    left: padX + canvasOX,
    top: canvasBaseTop + canvasOY,
    width: Math.max(120, frameBox.w - padX * 2),
    transform: `translateY(-50%) rotate(${s.style?.rotation ?? 0}deg) scale(${s.style?.fontScale ?? 1})`,
    transformOrigin: anchor.h === "left" ? "left center" : "center center",
    textAlign: anchor.h === "left" ? "left" : "center",
  };
  const inspectSceneData = inspect !== null ? scenes[inspect] : null;
  const patchInspect = (p: Partial<Scene>) => {
    if (inspect === null) return;
    patch(inspect, p);
  };
  const patchInspectLine = (lineIndex: number, p: Record<string, string>) => {
    if (!inspectSceneData?.lines) return;
    patchInspect({ lines: inspectSceneData.lines.map((ln: any, j: number) => (j === lineIndex ? { ...ln, ...p } : ln)) });
  };
  const deleteInspectLine = (lineIndex: number) => {
    if (!inspectSceneData?.lines) return;
    patchInspect({ lines: inspectSceneData.lines.filter((_: any, j: number) => j !== lineIndex) });
  };
  const addInspectLine = () => {
    if (!inspectSceneData?.lines) return;
    patchInspect({ lines: [...inspectSceneData.lines, { kind: "assistant", text: "new output" }] });
  };

  // ── Dockable panel content ─────────────────────────────────────────────────
  // Each panel's body is just the JSX that previously lived inline; the docking
  // wrapper (DockPanel) + placement is driven by `layout`. The Inspector keeps
  // its 5-tab header (bound to layout.inspectorTab) plus the active pane.
  const inspectorContent = (
    <div className="ed-inspector ws-pane-inspector">
      <div className="ed-tabs">
        {(["scene", "transcript", "style", "subtitles", "mix"] as const).map((t) => (
          <button key={t} className={`ed-tab${tab === t ? " on" : ""}`} onClick={() => setTab(t)}>{t}</button>
        ))}
      </div>

      {tab === "scene" && (
        <InspectorScene
          s={s}
          sel={sel}
          scenes={scenes}
          textRef={textRef}
          patch={patch}
          setSceneSpeed={setSceneSpeed}
          splitAt={splitAt}
          setScenes={setScenes}
          sceneKfTime={sceneKfTime}
          clearMotion={clearMotion}
          applyKenBurns={applyKenBurns}
          addKeyAtPlayhead={addKeyAtPlayhead}
        />
      )}

      {tab === "transcript" && (
        <InspectorTranscript
          scenes={scenes}
          sel={sel}
          words={liveProps?.words}
          patch={patch}
          setScenes={setScenes}
          setSel={setSel}
          delAt={rippleDelAt}
          reorder={reorder}
          sceneStartFrame={sceneStart}
          seekToFrame={(frame) => {
            const f = Math.max(0, Math.min(totalF, Math.round(frame)));
            playerRef.current?.pause?.();
            playerRef.current?.seekTo?.(f);
            setPlayFrame(f);
            setSel(sceneAtFrame(scenes, f));
          }}
        />
      )}

      {tab === "style" && (
        <InspectorStyle
          s={s}
          sel={sel}
          scenes={scenes}
          accent={accent}
          hue={hue}
          saturation={saturation}
          lightness={lightness}
          patchStyle={patchStyle}
          patchEffect={patchEffect}
          setScenes={setScenes}
        />
      )}

      {tab === "subtitles" && (
        <InspectorSubtitles
          subtitleSettings={subtitleSettings}
          accent={accent}
          patchSubtitles={patchSubtitles}
        />
      )}

      {tab === "mix" && (
        <InspectorMix
          mix={mix}
          audioTracks={audioTracks}
          selTrack={selTrack}
          selectedTrack={selectedTrack}
          withVoice={withVoice}
          withBroll={withBroll}
          setMix={setMix}
          setSelTrack={setSelTrack}
          setMenu={setMenu}
          updateTrack={updateTrack}
          splitAudioAtPlayhead={splitAudioAtPlayhead}
          setWithVoice={setWithVoice}
          setWithBroll={setWithBroll}
        />
      )}
    </div>
  );

  const timelineContent = (
    <div className="ed-timeline ws-pane-timeline">
      <TimelineBar
        addOpen={addOpen}
        scenes={scenes}
        tool={tool}
        snapBeat={snapBeat}
        beatFrames={beatFrames}
        setAddOpen={setAddOpen}
        addScene={addScene}
        dup={dup}
        del={del}
        setTool={setTool}
        setTab={setTab}
        canvasTextRef={canvasTextRef}
        setSnapBeat={setSnapBeat}
      />
      <Transport
        playing={playing}
        muted={muted}
        playFrame={playFrame}
        totalF={totalF}
        playFrac={playFrac}
        togglePlay={togglePlay}
        toggleMute={toggleMute}
        fmtClock={fmtClock}
        seekFromEl={seekFromEl}
        goFullscreen={goFullscreen}
      />
      <Timeline
        scenes={scenes}
        sel={sel}
        tool={tool}
        id={id}
        drag={drag}
        hoverCut={hoverCut}
        trimLive={trimLive}
        beatFrames={beatFrames}
        snapBeat={snapBeat}
        totalF={totalF}
        playFrac={playFrac}
        trackRef={trackRef}
        setDrag={setDrag}
        reorder={reorder}
        setHoverCut={setHoverCut}
        ratioFromEvent={ratioFromEvent}
        clickSceneBlock={clickSceneBlock}
        inspectScene={inspectScene}
        contextForScene={contextForScene}
        beginTrim={beginTrim}
        moveTrim={moveTrim}
        endTrim={endTrim}
        scrubPlayhead={scrubPlayhead}
        seekTimeline={seekTimeline}
      />
    </div>
  );

  const audioContent = (
    <div className="ed-timeline ws-pane-audio">
      <AudioLanes
        audioTracks={audioTracks}
        selTrack={selTrack}
        setSelTrack={setSelTrack}
        setTab={setTab}
        setMenu={setMenu}
      />
    </div>
  );

  const layersContent = (
    <div className="ws-pane-layers" onClick={(e) => e.stopPropagation()}>
      <LayersPanel
        scenes={scenes}
        sel={sel}
        setLayersOpen={() => setPanelVisible("layers", false)}
        setSel={setSel}
        seekToSceneStart={(i) => playerRef.current?.seekTo?.(sceneStart(i))}
        toggleHidden={toggleHidden}
        toggleLock={toggleLock}
        embedded
      />
    </div>
  );

  const PANEL_CONTENT: Record<PanelId, React.ReactNode> = {
    inspector: inspectorContent,
    timeline: timelineContent,
    audio: audioContent,
    layers: layersContent,
  };

  // Visible panels for a region, in their saved order.
  const regionPanels = (region: Region): PanelId[] =>
    PANEL_IDS.filter((pid) => layout.panels[pid].region === region && layout.panels[pid].visible)
      .sort((a, b) => layout.panels[a].order - layout.panels[b].order);
  const rightPanels = regionPanels("right");
  const bottomPanels = regionPanels("bottom");

  return (
    <div className={`editor${mInspectorOpen ? " ed-m-inspector-open" : ""}${mTimelineOpen ? " ed-m-timeline-open" : ""}`} onClick={() => { if (menu) setMenu(null); if (textPopover) setTextPopover(null); }}>
      {menu && (
        <ContextMenu
          menu={menu}
          selectedTrack={selectedTrack}
          scenes={scenes}
          selTrack={selTrack}
          setMenu={setMenu}
          splitAt={splitAt}
          stitchAt={stitchAt}
          setScenes={setScenes}
          setSel={setSel}
          setSceneSpeed={setSceneSpeed}
          patchStyle={patchStyle}
          patchEffect={patchEffect}
          delAt={delAt}
          splitAudioAtPlayhead={splitAudioAtPlayhead}
          updateTrack={updateTrack}
        />
      )}
      {/* TOP BAR */}
      <TopBar
        id={id}
        item={item}
        scenes={scenes}
        total={total}
        currentAspectKey={currentAspectKey}
        state={state}
        showKeys={showKeys}
        layersOpen={layersOpen}
        canUndo={!!past.current.length}
        canRedo={!!future.current.length}
        setAspect={setAspect}
        autoEdit={autoEdit}
        setLayersOpen={setLayersOpen}
        setShowKeys={setShowKeys}
        undo={undo}
        redo={redo}
        save={save}
        saveRender={saveRender}
        workspaces={allWorkspaces()}
        activeWorkspaceId={activeWorkspaceId}
        pickWorkspace={pickWorkspace}
        saveAsWorkspace={saveAsWorkspace}
        renameWorkspace={renameWorkspace}
        deleteWorkspace={deleteWorkspace}
        resetToPreset={resetToPreset}
        panelList={PANEL_IDS.map((pid) => ({ id: pid, title: PANEL_META[pid].title, visible: layout.panels[pid].visible }))}
        togglePanel={(pid) => togglePanel(pid as PanelId)}
        mInspectorOpen={mInspectorOpen}
        mTimelineOpen={mTimelineOpen}
        toggleMInspector={() => { setMInspectorOpen((v) => !v); setMTimelineOpen(false); }}
        toggleMTimeline={() => { setMTimelineOpen((v) => !v); setMInspectorOpen(false); }}
      />
      {/* Mobile drawer backdrop (≤900px): tap to dismiss whichever drawer is open. */}
      {(mInspectorOpen || mTimelineOpen) && (
        <div className="ed-m-backdrop" onClick={() => { setMInspectorOpen(false); setMTimelineOpen(false); }} />
      )}
      {showKeys && <ShortcutPanel />}

      {/* The live Player works from the storyboard (no render needed). A render
          additionally unlocks the audio-derived features: beat detection,
          word-level transcripts and resolved B-roll. Nudge it until rendered. */}
      {(!renderProps || renderProps.preview) && (
        <div className="ed-render-hint" role="status" style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 16px", background: "var(--bg-surface, #1a1a1a)", borderBottom: "1px solid var(--border-subtle)", fontSize: 12.5, color: "var(--text-muted)" }}>
          <span className="tl-dot" style={{ background: "var(--accent)" }} />
          <span>{liveProps ? "Previewing from the storyboard. Render once to also enable beat detection, word-level transcripts, and B-roll." : "Generate a storyboard to preview, then render to enable beat detection, transcripts, and B-roll."}</span>
          <button className="btn" style={{ marginLeft: "auto", padding: "5px 12px" }} disabled={state !== "idle"} onClick={() => void saveRender()}>
            {state === "rendering" ? "Rendering…" : state === "saving" ? "Saving…" : "Save & Render"}
          </button>
        </div>
      )}

      {/* WORKSPACE BODY: an upper row (center stage + right dock) over a bottom
          dock, all driven by `layout`. The center stage (Preview + overlays) is
          always visible; panels dock right/bottom and are individually
          dismissable, with splitters resizing the right/bottom regions. */}
      <div className="ed-body ws-body" style={{ flexDirection: "column" }}>
        <div className="ws-upper" style={{ flex: 1, display: "flex", minHeight: 0, minWidth: 0 }}>
          <div className="ws-center" style={{ flex: 1, display: "flex", minWidth: 0, minHeight: 0 }}>
        <div ref={stageRef} className="ed-stage" onClick={clickStage} onDoubleClick={doubleClickStage} title="click preview text to edit on canvas / double-click to inspect component">
          <div ref={frameRef} className="ed-frame" style={{ aspectRatio: currentAspect.ratio }}>
          {liveProps ? <Preview ref={playerRef} props={liveProps} fill controls={false} width={dims.width} height={dims.height} /> : <div className="empty">No storyboard yet — generate one to preview.</div>}
          <CanvasTextOverlay
            liveProps={liveProps}
            tool={tool}
            textPopover={textPopover}
            frameBox={frameBox}
            boxRef={boxRef}
            textDragRef={textDragRef}
            canvasTextStyle={canvasTextStyle}
            canvasTextRef={canvasTextRef}
            sel={sel}
            s={s}
            selectedText={selectedText}
            canvasFontPx={canvasFontPx}
            canvasFontWeight={canvasFontWeight}
            canvasLineHeight={canvasLineHeight}
            anchor={anchor}
            safeZones={safeZones}
            setTool={setTool}
            setTextPopover={setTextPopover}
            beginTextDrag={beginTextDrag}
            moveTextDrag={moveTextDrag}
            endTextDrag={endTextDrag}
            beginBoxDrag={beginBoxDrag}
            moveBoxDrag={moveBoxDrag}
            endBoxDrag={endBoxDrag}
            patchSelectedText={patchSelectedText}
            patchStyle={patchStyle}
            resetTextTransform={resetTextTransform}
            setSafeZones={setSafeZones}
          />
          <OverlayLayer
            s={s}
            sel={sel}
            overlays={sceneOverlays}
            frameBox={frameBox}
            locked={!!s.locked}
            selectedOverlay={selOverlay}
            addOpen={overlayAddOpen}
            emojiOpen={overlayEmojiOpen}
            setAddOpen={setOverlayAddOpen}
            setEmojiOpen={setOverlayEmojiOpen}
            addOverlay={addOverlay}
            addEmoji={addOverlayEmoji}
            selectOverlay={setSelOverlay}
            patchOverlay={patchOverlay}
            deleteOverlay={deleteOverlay}
            beginOverlayDrag={beginOverlayDrag}
            moveOverlayDrag={moveOverlayDrag}
            endOverlayDrag={endOverlayDrag}
            beginOverlayBox={beginOverlayBox}
            moveOverlayBox={moveOverlayBox}
            endOverlayBox={endOverlayBox}
          />
          {textPopover && (
            <TextPopover
              textPopover={textPopover}
              sel={sel}
              s={s}
              textRef={textRef}
              setTab={setTab}
              patch={patch}
              patchStyle={patchStyle}
            />
          )}
          </div>
        </div>
          </div>

          {/* RIGHT DOCK */}
          {rightPanels.length > 0 && (
            <>
              <Splitter orientation="vertical" onResize={(d) => setRegionSize("rightW", -d)} />
              <div
                className="ws-dock ws-dock-right"
                style={{ width: layout.sizes.rightW, flex: "0 0 auto", display: "flex", flexDirection: "column", minHeight: 0, minWidth: 0 }}
              >
                {rightPanels.map((pid) => (
                  <DockPanel key={pid} title={PANEL_META[pid].title} onClose={() => setPanelVisible(pid, false)}>
                    {PANEL_CONTENT[pid]}
                  </DockPanel>
                ))}
              </div>
            </>
          )}
        </div>

        {/* BOTTOM DOCK */}
        {bottomPanels.length > 0 && (
          <>
            <Splitter orientation="horizontal" onResize={(d) => setRegionSize("bottomH", -d)} />
            <div
              className="ws-dock ws-dock-bottom"
              style={{ height: layout.sizes.bottomH, flex: "0 0 auto", display: "flex", flexDirection: "column", minHeight: 0, minWidth: 0 }}
            >
              {bottomPanels.map((pid) => (
                <DockPanel key={pid} title={PANEL_META[pid].title} onClose={() => setPanelVisible(pid, false)}>
                  {PANEL_CONTENT[pid]}
                </DockPanel>
              ))}
            </div>
          </>
        )}
      </div>

      {inspect !== null && inspectSceneData && (
        <InspectComponent
          inspect={inspect}
          inspectSceneData={inspectSceneData}
          inspectProps={inspectProps}
          dims={dims}
          setInspect={setInspect}
          setSel={setSel}
          patchInspect={patchInspect}
          patchInspectLine={patchInspectLine}
          deleteInspectLine={deleteInspectLine}
          addInspectLine={addInspectLine}
        />
      )}
    </div>
  );
}
