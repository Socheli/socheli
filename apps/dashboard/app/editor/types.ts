/* Client-side view shapes for the /editor surface (Editor Frame-Control — Phase
   C). These mirror the engine artifacts the /api/studio/[id]/{timeline,frame,
   frame-range,frame-edit} routes return (timeline view, FrameSeek, FrameVision,
   words, music) but stay LOOSE/optional — the dashboard compiles strict:false and
   every frame modality fails open at the engine, so the UI reads each field
   defensively. Nothing is parsed client-side; the engine validated at the edge. */

/* timeline_get — the frame-addressed view. One clip carries timeline placement in
   BOTH seconds (authoring) and frames (render-aligned) + the source window. */
export type TimelineClip = {
  id: string;
  trackId: string;
  kind: string;
  sceneRef?: string;
  src?: string;
  startFrame: number;
  endFrame: number;
  startSec: number;
  endSec: number;
  durationSec: number;
  sourceInSec: number;
  sourceOutSec?: number;
  enabled: boolean;
  locked: boolean;
};

export type TimelineTrack = {
  id: string;
  kind: string;
  name?: string;
  clips: TimelineClip[];
};

export type TimelineMarker = { atSec?: number; atFrame?: number; label?: string; kind?: string };

export type TimelineView = {
  fps: number;
  totalFrames: number;
  totalSec: number;
  derived: boolean;
  tracks: TimelineTrack[];
  markers: TimelineMarker[];
};

/* FrameVision (schemas.FrameVision) — one dense-vision grid entry. */
export type FrameVision = {
  frameIndex: number;
  atSec: number;
  description?: string;
  subjects?: string[];
  onScreenText?: string;
  motionScore?: number;
  quality?: number;
  brightness?: number;
  confidence?: number;
};

/* timeline_seek_frame (FrameSeek) — the cross-modal read at one timeline frame. */
export type FrameWord = {
  word: string;
  fromFrame: number;
  toFrame: number;
  fromSec: number;
  toSec: number;
  conf?: number;
};

export type MusicSection = { startFrame: number; endFrame: number; kind: string; note?: string };
export type MusicEnergy = { atFrame: number; atSec: number; energy: number };

export type MusicContext = {
  startFrame: number;
  endFrame: number;
  hasMusic: boolean;
  tempoBpm?: number;
  beats: number[];
  drops: number[];
  sections: MusicSection[];
  energy: MusicEnergy[];
  source: "understanding" | "beat-tracker" | "none";
};

export type FrameSeek = {
  clip: { id?: string; trackId?: string; kind?: string; locked?: boolean; sceneRef?: string } | null;
  sourceInSec: number | null;
  sourceOutSec: number | null;
  sourceAtSec: number | null;
  timelineStartFrame: number | null;
  atSec: number;
  atFrame: number;
  fps?: number;
  vision: { frame: FrameVision; deltaSec: number } | null;
  words: FrameWord[];
  music: MusicContext;
};

/* The result of a frame-edit POST — the FrameEditResult plus the rebuilt index. */
export type FrameEditResult = {
  op?: string;
  changed?: string[];
  touched?: string[];
  skipped?: string;
  fps?: number;
  frameIndex?: Record<string, unknown> | { error: string };
};

/* The /editor server payload (page → client): the ingested run summary + whether
   a playable file exists + whether a dense-vision grid has been built. */
export type EditorRun = {
  id: string;
  name: string;
  channel: string;
  status: string;
  hasVideo: boolean;
  fps: number;
  hasDenseVision: boolean;
};
