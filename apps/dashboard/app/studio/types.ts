/* Client-side view shapes for the Editor Studio (Pillar 5). These mirror the
   engine artifacts the /api/studio routes return (schemas: Understanding,
   EditPlan, timeline view) but stay loose/optional on the client — the dashboard
   compiles strict:false and a degraded model can return a partial plan, so every
   field the UI reads defensively is optional here. Nothing is parsed client-side;
   the engine already validated against the strict zod schema at the boundary. */

/* The PII-free run summary the list + detail read return (lib/studio). `name` is
   the original filename handle, NEVER a disk path (§7.1.6). */
export type IngestedSummary = {
  id: string;
  channel: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  name: string;
  hasUnderstanding: boolean;
  hasTimeline: boolean;
  verified: boolean;
};

/* Understanding (schemas.Understanding) — the content-aware analysis. */
export type TSegment = { index: number; startSec: number; endSec: number; text: string; speaker?: string };
export type Shot = { id: string; index: number; inSec: number; outSec: number; durationSec: number; source: string; keyframeSec: number; speaker?: string };
export type Highlight = { startSec: number; endSec: number; score: number; why: string[] };
export type Span = { startSec: number; endSec: number; reason?: string };
export type FillerHit = { atSec: number; word: string; kind: "filler" | "long_pause" };

export type Understanding = {
  builtAt: string;
  durationSec: number;
  fps?: number;
  transcript: { text: string; segments: TSegment[] };
  shots: Shot[];
  highlights: Highlight[];
  deadAir: Span[];
  filler: FillerHit[];
  notes: string[];
};

/* The detail payload from GET /api/studio/[id]. understanding is { built:false }
   until editor_understand has run; the page then offers the "Understand" action. */
export type StudioDetail = {
  item: { id: string; channel: string; status: string; kind: string; createdAt: string; updatedAt: string; name: string };
  hasVideo: boolean;
  status?: Record<string, unknown> & { error?: string };
  understanding: ({ built: true; summary?: string; understanding: Understanding } | { built: false; error?: string }) & Record<string, unknown>;
  timeline?: { fps?: number; totalSec?: number; totalFrames?: number; derived?: boolean; tracks?: { id: string; clips?: unknown[] }[]; error?: string };
};

/* EditOp (schemas.EditOp) — a single grounded edit step. `kind` is the
   discriminator; the rest are optional because each variant carries its own keys.
   `evidence` is the real artifact the router cited (a dead-air span, a shot id…). */
export type EditOp = {
  kind: string;
  evidence?: string;
  clipId?: string;
  edge?: "in" | "out";
  deltaSec?: number;
  atSec?: number;
  leadSec?: number;
  durationSec?: number;
  query?: string;
  src?: string;
  order?: string[];
  preset?: string;
  scope?: "scene" | "global";
  intent?: string;
  topN?: number;
  maxSec?: number;
};

/* EditPlan (schemas.EditPlan) — the proposed, analysis-only plan the chat returns.
   Approving it → apply (+ optional render). */
export type EditPlan = {
  id: string;
  runId: string;
  request: string;
  mode: "guided" | "autonomous";
  ops: EditOp[];
  rationale: string;
  evidenceRefs: string[];
  montage?: { targetSec?: number; style?: string; maxClips?: number; orderBy?: string };
  estDurationSec?: number;
  status: "proposed" | "approved" | "applied" | "rejected";
  createdAt: string;
};

/* The detached-spawn contract surfaced verbatim so the page can poll. */
export type StartedJob = { status: "started"; pid?: number; logPath?: string; id?: string } | null;
