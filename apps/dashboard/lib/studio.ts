import "server-only";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { REPO_ROOT, listItemsFor, getItemFor, videoFile, type Item } from "./data";

/* ── Studio (Pillar 5 — the EDITOR STUDIO) server layer ──────────────────────
   The thin tenant-aware bridge the /studio page + its API routes call. Studio is
   "Odysser-style" chat-first editing: import ANY video, see the content-aware
   understanding, type an edit ("subtitle it / make a 30s highlight reel / cut the
   dead air"), get a PROPOSED EditPlan, approve (guided) or let it run
   (autonomous), preview.

   This lib NEVER bundles the engine (node-only, tsx-run). Every capability is an
   ENGINE TOOL in the one registry (packages/engine/src/tools/*), invoked through
   the canonical tool runner — EXACTLY the bridge lib/missions.ts (runMissionTool)
   and lib/admin.ts (runAdminTool) use:

       node --import tsx packages/engine/src/tool.ts <toolName> '<jsonInput>'

   so the engine keeps every invariant (probe/normalize, understanding pipeline,
   grounded EditPlan routing, timeline machinery, hybrid render) and the dashboard
   only adds tenancy gating in the API routes. The editor tools are READ for the
   page (understanding/timeline) and MUTATE/LONG for edits; long jobs (ingest
   transcode, creative_apply_plan/creative_edit with render, editor_understand)
   honour the detached-spawn contract and return {status:"started", pid, logPath}
   — we surface that verbatim so the page can poll.

   SECURITY (§7.1.6): a source video's originalPath can carry a home-dir
   path/filename (PII). This lib never returns the raw `source.originalPath` to a
   client — the route layer reads what it needs (status/videoPath) and the page
   shows the run id, not the disk path. */

/* ── Engine tool bridge (reused, not reinvented) ────────────────────────────
   Same spawn shape as runMissionTool / runAdminTool. The allow-list is the
   Studio-relevant slice of the editor tool surface — defence in depth so this
   bridge can only ever drive Studio's own capabilities, never an arbitrary tool.
   (The engine still re-validates every input against the tool's strict zod
   schema; this set just scopes WHAT the Studio server may call.) */

export type ToolResult = { ok: boolean; data?: Record<string, unknown>; message?: string };

const STUDIO_TOOLS = new Set([
  "ingest_video", // import a user video → kind:"ingested" ContentItem (long if transcode)
  "ingest_status", // poll a detached transcode import
  "editor_understand", // LONG: deep-understand worker (transcript/shots/highlights/deadAir/filler)
  "editor_understanding_get", // READ: the stored Understanding index
  "timeline_get", // READ: frame-addressed timeline view
  "creative_edit_route", // route plain-language request → grounded EditPlan (no apply)
  "creative_apply_plan", // apply a routed EditPlan (LONG when render=true)
  "creative_edit", // one-shot route+apply (+optional render)
  "creative_montage", // re-montage into a highlight reel / teaser
  "auto_subtitle", // build the editable CAP1 caption track from the transcript

  /* Frame-control surface (Editor Frame-Control, Phase B) — what the /editor
     page drives. READ: resolve "what's at frame N" (clip + source window + vision
     + words + music) and paint a scrubber window. MUTATE: frame-exact trim / split
     / move (each INVALIDATES the frame index → re-run timeline_frame_index). LONG:
     the dense per-frame vision grid + the hybrid render. */
  "timeline_frame_index", // MUTATE: (re)build the per-clip frame index
  "timeline_query_frame", // READ: resolve atFrame|atSec → clip + source window
  "timeline_seek_frame", // READ: frame N → clip + vision + words + music (the seek)
  "timeline_frame_range", // READ: clips + per-frame metadata over a window
  "timeline_words_at_frame", // READ: transcript words re-anchored onto a frame range
  "timeline_music_context", // READ: beats/drops/sections/energy over a frame range
  "timeline_trim_clip_frame", // MUTATE: frame-exact source in/out trim
  "timeline_split_clip_frame", // MUTATE: razor-split a clip at a timeline frame
  "timeline_move_clip_frame", // MUTATE: move a clip to start at a timeline frame
  "render_hybrid", // LONG: render the cut end-to-end (footage + overlay) → job
  "editor_understand_dense_vision", // LONG: build the dense per-frame vision grid → job
  "editor_filmstrip", // READ: generate/reuse the thumbnail filmstrip jpg for the scrubber
]);

/* Invoke a Studio engine tool through the canonical runner. The runner prints a
   ToolResult JSON on stdout even on failure (exit code mirrors result.ok); we
   parse it regardless and fall back to stderr only when stdout isn't valid JSON
   (e.g. tsx itself failed to boot). Mirrors runMissionTool exactly. */
export function runStudioTool(name: string, input: Record<string, unknown>): Promise<ToolResult> {
  if (!STUDIO_TOOLS.has(name)) {
    return Promise.resolve({ ok: false, message: `not a studio tool: ${name}` });
  }
  const runner = join(REPO_ROOT, "packages", "engine", "src", "tool.ts");
  return new Promise((resolve) => {
    const child = spawn("node", ["--import", "tsx", runner, name, JSON.stringify(input)], {
      cwd: REPO_ROOT,
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", (e) => resolve({ ok: false, message: String(e) }));
    child.on("close", () => {
      try {
        resolve(JSON.parse(stdout.trim()) as ToolResult);
      } catch {
        resolve({ ok: false, message: (stderr || stdout).trim().slice(0, 2000) || "engine produced no output" });
      }
    });
  });
}

/* A started long-job, surfaced verbatim from the detached-spawn contract so the
   page can poll. Present on a ToolResult.data when a tool detached. */
export type StartedJob = { status: "started"; pid?: number; logPath?: string; id?: string };

export function startedJob(res: ToolResult): StartedJob | null {
  const d = res.data as Partial<StartedJob> | undefined;
  return d && d.status === "started" ? (d as StartedJob) : null;
}

/* ── Imports / ingest ───────────────────────────────────────────────────────
   importIngest(path) → ingest_video. A render-friendly source imports inline and
   returns the item ({id,status,videoPath}); one that needs a transcode detaches
   and returns {status:"started", pid, logPath, id} — surfaced verbatim so the
   page polls ingest_status. The API route stages an upload to a temp file and
   passes its absolute path here; a {path} body imports an on-disk file directly. */
export function importIngest(path: string, channel = "labrinox"): Promise<ToolResult> {
  return runStudioTool("ingest_video", { path, channel });
}

export function ingestStatus(id: string): Promise<ToolResult> {
  return runStudioTool("ingest_status", { id });
}

/* ── Understanding ──────────────────────────────────────────────────────────
   getUnderstanding(id) → editor_understanding_get (READ; { built:false } until the
   pipeline has run). buildUnderstanding(id) → editor_understand (LONG; detaches a
   worker and returns a job — poll getUnderstanding until built). */
export function getUnderstanding(id: string): Promise<ToolResult> {
  return runStudioTool("editor_understanding_get", { id });
}

export function buildUnderstanding(id: string): Promise<ToolResult> {
  return runStudioTool("editor_understand", { id });
}

/* ── Timeline (read-only panel) ─────────────────────────────────────────────
   getTimeline(id) → timeline_get: the computed frame-addressed view (always works,
   derived pre-build). The Studio page renders this as a simple read-only timeline,
   NOT a drag NLE (that's a later milestone). */
export function getTimeline(id: string): Promise<ToolResult> {
  return runStudioTool("timeline_get", { id });
}

/* ── Chat editing ───────────────────────────────────────────────────────────
   routeEdit: propose an EditPlan WITHOUT applying (the "guided" gate — the page
   shows the plan, the human approves). applyEdit: execute a routed plan (render
   detaches as a job). oneShotEdit: route+apply in one call (the "autonomous"
   path). montage / subtitle: the common one-tap recipes. */
export type EditMode = "guided" | "autonomous";

export function routeEdit(id: string, request: string, mode: EditMode = "guided"): Promise<ToolResult> {
  return runStudioTool("creative_edit_route", { id, request, mode });
}

export function applyEdit(id: string, planId?: string, render = false): Promise<ToolResult> {
  return runStudioTool("creative_apply_plan", { id, render, ...(planId ? { planId } : {}) });
}

export function oneShotEdit(id: string, request: string, render = false): Promise<ToolResult> {
  return runStudioTool("creative_edit", { id, request, render });
}

export type MontageSpec = {
  targetSec?: number;
  style?: "highlight_reel" | "teaser" | "supercut" | "tight_cut";
  maxClips?: number;
  orderBy?: "narrative" | "energy" | "chronological";
};

export function montage(id: string, spec: MontageSpec = {}): Promise<ToolResult> {
  // Drop undefined so we only send keys the tool's strict schema accepts.
  const input: Record<string, unknown> = { id };
  for (const [k, v] of Object.entries(spec)) if (v !== undefined) input[k] = v;
  return runStudioTool("creative_montage", input);
}

export function subtitle(id: string): Promise<ToolResult> {
  // auto_subtitle builds the editable caption track; the creative_subtitle preset
  // variant is reachable through the chat path (oneShotEdit "subtitle it").
  return runStudioTool("auto_subtitle", { id });
}

/* ── Frame control (the /editor surface) ────────────────────────────────────
   Thin wrappers over the Phase-B frame tools, mirroring getTimeline/routeEdit
   exactly (one runStudioTool call each, undefined keys dropped so the engine's
   strict zod schema only ever sees the keys it accepts). The /api/studio/[id]
   purpose routes gate these (read = analytics.view, mutate/long = content.create)
   — these helpers never gate themselves. */

/* MUTATE — (re)build the per-clip frame index. Run once after a build, and again
   after ANY frame edit (each mutate invalidates it). */
export function frameIndex(id: string): Promise<ToolResult> {
  return runStudioTool("timeline_frame_index", { id });
}

/* READ — "what is at frame N": the picture clip + its source window + the cross-
   modal context (dense vision, transcript words, music) at that exact frame. */
export function seekFrame(id: string, frameIndex: number): Promise<ToolResult> {
  return runStudioTool("timeline_seek_frame", { id, frameIndex });
}

/* READ — resolve a position (by atFrame OR atSec) → clip + source window, no
   cross-modal context (the lighter scrub-jump read). */
export function queryFrame(id: string, at: { atFrame?: number; atSec?: number }): Promise<ToolResult> {
  const input: Record<string, unknown> = { id };
  if (typeof at.atFrame === "number") input.atFrame = at.atFrame;
  if (typeof at.atSec === "number") input.atSec = at.atSec;
  return runStudioTool("timeline_query_frame", input);
}

/* READ — every picture clip + its persisted per-frame metadata over a window. */
export function frameRange(id: string, startFrame: number, endFrame: number): Promise<ToolResult> {
  return runStudioTool("timeline_frame_range", { id, startFrame, endFrame });
}

/* READ — transcript words re-anchored onto a timeline frame range. */
export function wordsAtFrame(id: string, startFrame: number, endFrame: number): Promise<ToolResult> {
  return runStudioTool("timeline_words_at_frame", { id, startFrame, endFrame });
}

/* READ — beats / drops / sections / energy over a timeline frame range. */
export function musicContext(id: string, startFrame: number, endFrame: number): Promise<ToolResult> {
  return runStudioTool("timeline_music_context", { id, startFrame, endFrame });
}

/* MUTATE — frame-exact source-window trim (either edge optional; omitted edge
   left untouched). Invalidates the frame index. */
export function trimClipFrame(id: string, clipId: string, edges: { inFrame?: number; outFrame?: number }): Promise<ToolResult> {
  const input: Record<string, unknown> = { id, clipId };
  if (typeof edges.inFrame === "number") input.inFrame = edges.inFrame;
  if (typeof edges.outFrame === "number") input.outFrame = edges.outFrame;
  return runStudioTool("timeline_trim_clip_frame", input);
}

/* MUTATE — razor-split a clip at an exact timeline frame. Invalidates the index. */
export function splitClipFrame(id: string, clipId: string, atFrame: number): Promise<ToolResult> {
  return runStudioTool("timeline_split_clip_frame", { id, clipId, atFrame });
}

/* MUTATE — move a clip so it starts at an exact timeline frame (slide, no
   ripple). Invalidates the index. */
export function moveClipFrame(id: string, clipId: string, startFrame: number): Promise<ToolResult> {
  return runStudioTool("timeline_move_clip_frame", { id, clipId, startFrame });
}

/* LONG — render the cut end-to-end (footage spine + overlay, optional reframe).
   Detaches; returns the started job verbatim so the page polls. */
export function renderHybrid(id: string, aspect?: "9:16" | "1:1" | "16:9" | "original", fill?: "crop" | "blur" | "fit"): Promise<ToolResult> {
  const input: Record<string, unknown> = { id };
  if (aspect) input.aspect = aspect;
  if (fill) input.fill = fill;
  return runStudioTool("render_hybrid", input);
}

/* LONG — build the dense per-frame vision grid (subjects / on-screen text /
   what's happening, per sampled frame). Detaches; poll understanding until the
   grid lands under understanding.denseFrameVision. */
export function buildDenseVision(id: string, sampleFps?: number): Promise<ToolResult> {
  const input: Record<string, unknown> = { id };
  if (typeof sampleFps === "number") input.sampleFps = sampleFps;
  return runStudioTool("editor_understand_dense_vision", input);
}

/* ── Library reads (tenant-scoped, no engine spawn) ─────────────────────────
   listIngested(): the caller's workspace runs filtered to kind:"ingested" — the
   Studio "your imports" rail. ingestedItem(): one ingested run, scoped + kind-
   gated, for the Studio detail page. studioVideoFile(): the on-disk file for the
   player (the normalized ingested source OR a re-rendered output). These reuse
   lib/data.ts (the same workspace-scoped reads every page uses) so a read never
   spawns the engine. */
export type IngestedSummary = {
  id: string;
  channel: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  name: string; // seedIdea = the original filename (human handle, not a disk path)
  hasUnderstanding: boolean;
  hasTimeline: boolean;
  verified: boolean; // a playable video file exists on disk
};

function summarize(it: Item): IngestedSummary {
  const x = it as Item & { understanding?: unknown; timeline?: unknown };
  return {
    id: it.id,
    channel: it.channel,
    status: it.status,
    createdAt: it.createdAt,
    updatedAt: it.updatedAt,
    name: it.seedIdea,
    hasUnderstanding: !!x.understanding,
    hasTimeline: !!x.timeline,
    verified: !!videoFile(it),
  };
}

export function listIngested(workspaceId: string): IngestedSummary[] {
  return listItemsFor(workspaceId)
    .filter((it) => it.kind === "ingested")
    .map(summarize);
}

/* The ingested run, scoped to the workspace AND gated to kind:"ingested" so the
   Studio routes never operate on a non-ingested post. */
export function ingestedItem(id: string, workspaceId: string): Item | null {
  const it = getItemFor(id, workspaceId);
  return it && it.kind === "ingested" ? it : null;
}

/* Resolve the playable file for the Studio player: prefers a re-rendered output,
   else the normalized ingested source — both already covered by videoFile() (it
   checks item.videoPath, then the renders dir + its Beta/ box). Null → no file yet
   (transcode/render still running). */
export function studioVideoFile(it: Item | null): string | null {
  return videoFile(it);
}
