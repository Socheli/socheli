import { z } from "zod";

import { type PipelineTool, ok, fail, asyncResult, spawnEngine, tool } from "./helpers.ts";
import { timelineView } from "../creative/timeline.ts";
import { compileTimeline, timelineBuild } from "../creative/compile.ts";
import { loadItem, saveItem } from "../store.ts";
import { finishVideo } from "../render.ts";
import {
  buildFrameIndex,
  queryFrameOnTimeline,
  queryFrameRange,
  seekTimelineFrame,
} from "../creative/frame-index.ts";
import { moveClipByFrames, splitClipAtFrame, trimClipByFrames } from "../creative/frame-edit.ts";
import { wordsInFrameRange } from "../creative/frame-transcript.ts";
import { queryMusicInFrameRange } from "../creative/frame-music.ts";
import { filmstripFor } from "../filmstrip.ts";

/**
 * timeline-tools.ts — the Pro-NLE timeline tool surface (DaVinci spine §4.2, M1).
 * Spread into the canonical registry (registry.ts pipelineTools) so MCP / HTTP /
 * CLI / SDK / the dashboard copilot (Soli) all get the timeline view for free.
 *
 * M1 shipped the READ side: `timeline_get` returns the computed, frame-addressed
 * read-only view. M10 adds the build/compile BRIDGE (creative/compile.ts):
 * `timeline_build` seeds item.timeline from a generated storyboard (one video
 * clip per visible scene + audio + caption tracks; idempotent + edit-preserving),
 * and `timeline_compile` projects the timeline back onto the storyboard + mix
 * (storyboard-seeded) or resolves the footage clipPlan (footage-seeded). Both are
 * clamped, locked-safe, skip-not-throw — mirroring the edl.ts bridge discipline.
 * The trim tools (timeline_trim / razor / jl_cut …) land in M11.
 *
 * Shape note: ok/tool come from the leaf helpers module (NOT registry.ts) so
 * there is no import cycle — mirrors creative-tools.ts exactly. `timelineView`
 * is synchronous + pure (loadItem only, no awaited engine work), so unlike the
 * creative_* tools we return its result directly without asyncResult().
 */

const idArg = z.string().min(1).describe("ContentItem/run id (e.g. concept_20260610034331)");

export const timelineTools: PipelineTool[] = [
  tool({
    name: "editor_filmstrip",
    description:
      "Generate (or reuse a cached) thumbnail FILMSTRIP for a run's video — N evenly-spaced frames tiled into ONE jpg for the editor scrubber to lay the whole cut out visually. Cached by source mtime (a re-open is instant). Returns { path, count, tileW, tileH }. Fast; fail-open (no video ⇒ fail). The dashboard /editor surface streams this under the scrubber.",
    kind: "read",
    schema: z.object({ id: idArg, count: z.number().int().min(6).max(60).optional(), height: z.number().int().min(32).max(120).optional() }).strict(),
    run: ({ id, count, height }) => {
      const r = filmstripFor(id, { count, height });
      return r ? ok(r, `filmstrip — ${r.count} frame(s)`) : fail("no video to build a filmstrip from");
    },
  }),
  tool({
    name: "timeline_get",
    description:
      "Read the computed, frame-addressed timeline VIEW for a run: per clip its trackId, kind, sceneRef, source in/out, and timeline start/end in BOTH seconds and frames. Resolves item.timeline when one exists; otherwise derives a view from the storyboard (one video clip per visible scene) + the Mix (one audio clip per track) so it always works pre-build. Read-only — never mutates. Returns { fps, totalFrames, totalSec, derived, tracks, markers }.",
    kind: "read",
    schema: z.object({ id: idArg }).strict(),
    run: ({ id }) => {
      const view = timelineView(id);
      return ok(view, `timeline view — ${view.tracks.length} track(s), ${view.totalFrames} frame(s)${view.derived ? " (derived)" : ""}`);
    },
  }),
  tool({
    name: "timeline_build",
    description:
      "Seed (or re-seed) item.timeline from a GENERATED run's storyboard + mix: one VIDEO clip per visible (non-hidden) scene laid sequentially (sceneRef = scene id), one AUDIO track per mix track, and a caption track when subtitles are on. Idempotent + edit-preserving — re-building keeps manual trims on any clip whose sceneRef still matches. Sets seededFrom:\"storyboard\" and compiledAt (timeline then owns timing). Skips (no-op) if a footage timeline already exists. Returns the persisted timeline.",
    kind: "mutate",
    schema: z.object({ id: idArg }).strict(),
    run: ({ id }) => {
      const timeline = timelineBuild(id);
      const tracks = timeline.tracks.length;
      const vclips = (timeline.tracks.find((t) => t.id === "V1")?.clips ?? []).length;
      return ok(timeline, `timeline built (${timeline.seededFrom}) — ${vclips} video clip(s), ${tracks} track(s)`);
    },
  }),
  tool({
    name: "timeline_compile",
    description:
      "Compile item.timeline BACK onto the render source. For a storyboard-seeded timeline: write each video clip's durationSec onto its scene, hide scenes whose clip was removed, reorder scenes to clip order, and project audio gain automation + the caption track onto item.mix — clamped, locked-safe, and CHANGE-GUARDED so an untouched build→compile is byte-stable (no storyboard/mix change). For a footage-seeded timeline: the storyboard is left untouched and the clipPlan resolves at render (N6). Returns { changed: string[] } (empty ⇒ nothing was written).",
    kind: "mutate",
    schema: z.object({ id: idArg }).strict(),
    run: ({ id }) => {
      const { changed } = compileTimeline(id);
      return ok({ changed }, changed.length ? `compiled — ${changed.length} change(s)` : "compiled — no changes (byte-stable)");
    },
  }),
  tool({
    name: "render_spine_preview",
    description:
      "Render the FOOTAGE SPINE for a footage-seeded run (N6.0): resolve the timeline's video clipPlan, ffmpeg-trim each source window to a normalized part (one WxH/fps/codec from source.probe; re-encoded so every seam is frame-accurate), then concat the parts into ONE silent mp4 of exact total length — the base layer the hybrid render later composites grade + captions + overlays over. This is the cut+concat half only (no Remotion overlay/grade/audio yet). Long-running (one libx264 re-encode per clip): spawns a detached worker and returns immediately with its pid + log path; watch the log, then read renders/<id>_spine.mp4. No-op for storyboard-seeded runs (those have no clipPlan).",
    kind: "long",
    schema: z.object({ id: idArg }).strict(),
    run: ({ id }) => {
      const job = spawnEngine("spine-run.ts", [id], `spine-${id}.log`);
      return ok({ status: "started", ...job, id }, "footage spine render started");
    },
  }),
  tool({
    name: "render_hybrid",
    description:
      "Render a run end-to-end via the HYBRID path (N6.2) — the single safe entry point for BOTH ingested footage and generated runs. For a footage run: cut the silent spine (ffmpeg), composite the color grade + captions + overlays over it in ONE Remotion HybridPost pass (OffthreadVideo base), build the footage AUDIO mix separately in ffmpeg (per-clip extract → channel-strip → adelay → amix → music duck → loudness master), then stream-copy MUX video+audio into the final mp4. For a generated run (no source): delegates to the normal render (HybridPost is a byte-identical superset of Post when there's no spine). Pass `aspect` (e.g. '9:16' for social verticals) to REFRAME the spine, with `fill` choosing how source that doesn't match is fit: 'crop' (zoom-fill, no bars — best for a centered talking-head), 'blur' (fit + blurred-cover background), or 'fit' (letterbox). Sets item.videoPath on success. Long-running (a libx264 spine re-encode + a Remotion render + an audio pass): spawns a detached worker and returns immediately with its pid + log path; watch the log, then read renders/<id>.mp4.",
    kind: "long",
    schema: z
      .object({
        id: idArg,
        aspect: z.enum(["9:16", "1:1", "16:9", "original"]).optional().describe("reframe the output to this aspect (default: keep source)"),
        fill: z.enum(["crop", "blur", "fit"]).optional().describe("how to fit source into a new aspect — crop (zoom-fill), blur (blurred-cover bg), fit (letterbox). default crop"),
      })
      .strict(),
    run: ({ id, aspect, fill }) => {
      const extra: string[] = [];
      if (aspect) extra.push("--aspect", aspect);
      if (fill) extra.push("--fill", fill);
      const job = spawnEngine("hybrid-run.ts", [id, ...extra], `hybrid-${id}.log`);
      return ok({ status: "started", ...job, id }, "hybrid render started");
    },
  }),
  tool({
    name: "render_finish",
    description:
      "M18 ffmpeg FINISHING pass on a run's rendered mp4 — fidelity the in-browser render can't reach: a 3D-LUT grade (pass `lut` = a .cube path) for film-accurate colour beyond the SVG GradePipeline, a true chroma-key/despill (`chromaKey`), and/or a finishing `sharpen`. With nothing requested it's a no-op (the video is byte-identical). In-place on item.videoPath. Use as the LAST step when a LUT or true key is needed.",
    kind: "mutate",
    schema: z
      .object({
        id: idArg,
        lut: z.string().min(1).optional().describe("path to a .cube 3D-LUT file"),
        chromaKeyColor: z.string().min(1).optional().describe("e.g. '0x00ff00' or 'green' — drops this colour"),
        sharpen: z.boolean().optional(),
      })
      .strict(),
    run: ({ id, lut, chromaKeyColor, sharpen }) =>
      asyncResult(
        (async () => {
          const item = loadItem(id);
          if (!item.videoPath) return fail("item has no rendered videoPath to finish");
          const out = finishVideo(item.videoPath, {
            lut,
            chromaKey: chromaKeyColor ? { color: chromaKeyColor } : undefined,
            sharpen,
          });
          item.videoPath = out;
          saveItem(item);
          return ok({ id, videoPath: out }, "finishing pass applied");
        })(),
      ),
  }),

  // ── Editor Frame-Control B5: frame-addressable timeline tools ────────────────
  tool({
    name: "timeline_frame_index",
    description:
      "Build (or rebuild) the FRAME index for a run's timeline (Editor Frame-Control B2): compute every clip's inFrame/outFrame/startFrame from its seconds (sec*fps) and persist a per-clip Timeline.frameMetadata map plus timeline.fps. Seconds stay authoritative; the frame fields are a derived, idempotent mirror. Run this ONCE after timeline_build — the frame queries (timeline_query_frame / timeline_seek_frame / timeline_frame_range) read this index, and any mutate edit (trim/split/move) INVALIDATES it, so re-run after an edit. MUTATE, fail-open (no timeline → 0 frames). Returns { id, fps, clipCount, frameCount, timelineFrames }.",
    kind: "mutate",
    schema: z.object({ id: idArg }).strict(),
    run: ({ id }) => {
      const res = buildFrameIndex(id);
      return ok(res, `frame index built — ${res.clipCount} clip(s), ${res.frameCount} indexed frame(s) @ ${res.fps}fps`);
    },
  }),
  tool({
    name: "timeline_query_frame",
    description:
      "Resolve a position on the TIMELINE (by `atFrame` OR `atSec`) to the picture clip playing there and the SOURCE window it reads (Editor Frame-Control B2): returns { clip, sourceInSec, sourceOutSec, sourceAtSec, timelineStartFrame, atSec, atFrame }. A gap or out-of-range position returns clip:null with the resolved atFrame/atSec. READ-only, fail-open (no timeline → clip:null).",
    kind: "read",
    schema: z
      .object({
        id: idArg,
        atFrame: z.number().int().min(0).optional().describe("timeline frame to resolve"),
        atSec: z.number().min(0).optional().describe("timeline second to resolve (used when atFrame omitted)"),
      })
      .strict(),
    run: ({ id, atFrame, atSec }) => {
      const res = queryFrameOnTimeline(id, { atFrame, atSec });
      return ok(res, res.clip ? `frame @ ${res.atFrame} → clip ${res.clip.id}` : `frame @ ${res.atFrame} → gap (no clip)`);
    },
  }),
  tool({
    name: "timeline_seek_frame",
    description:
      "The canonical 'what is at TIMELINE frame N' read (Editor Frame-Control B2): the picture clip + its source window, PLUS the cross-modal context at that exact frame — dense-vision { frame, deltaSec } (nearest described frame), transcript words on that frame, and the music context (beats/sections/energy) at that frame. Returns the queryFrameOnTimeline shape + { fps, vision, words, music }. READ-only, fail-open — every modality degrades to null/empty independently.",
    kind: "read",
    schema: z.object({ id: idArg, frameIndex: z.number().int().min(0).describe("timeline frame to seek") }).strict(),
    run: ({ id, frameIndex }) => {
      const res = seekTimelineFrame(id, frameIndex);
      return ok(
        res,
        `seek frame ${res.atFrame}${res.clip ? ` → clip ${res.clip.id}` : " → gap"}${res.vision ? ", vision" : ""}${res.words.length ? `, ${res.words.length} word(s)` : ""}${res.music.beats.length ? `, ${res.music.beats.length} beat(s)` : ""}`,
      );
    },
  }),
  tool({
    name: "timeline_frame_range",
    description:
      "Every picture clip (and its persisted per-frame metadata) overlapping the TIMELINE frame range [startFrame, endFrame] — what a scrubber needs to paint a window (Editor Frame-Control B2). Returns { id, fps, startFrame, endFrame, startSec, endSec, clips:[{ clip, trackId, startFrame, endFrame, frames:[{frameIndex,atSec}] }] }. The per-clip `frames` come from the persisted frame index (run timeline_frame_index first; empty until rebuilt after an edit). READ-only, fail-open.",
    kind: "read",
    schema: z
      .object({
        id: idArg,
        startFrame: z.number().int().min(0).describe("first timeline frame of the window"),
        endFrame: z.number().int().min(0).describe("last timeline frame of the window"),
      })
      .strict(),
    run: ({ id, startFrame, endFrame }) => {
      const res = queryFrameRange(id, startFrame, endFrame);
      return ok(res, `range [${res.startFrame}..${res.endFrame}]f → ${res.clips.length} clip(s)`);
    },
  }),
  tool({
    name: "timeline_words_at_frame",
    description:
      "Transcript WORDS whose re-anchored TIMELINE frames overlap [startFrame, endFrame] (Editor Frame-Control B4): each word is mapped from its source-second Whisper timing through the clip source windows onto timeline frames; words whose source moment was cut away are dropped. Returns { id, fps, startFrame, endFrame, words:[{ word, fromFrame, toFrame, fromSec, toSec, sourceFromSec, sourceToSec, conf? }] }. READ-only, fail-open (no transcript/timeline → empty words).",
    kind: "read",
    schema: z
      .object({
        id: idArg,
        startFrame: z.number().int().min(0).describe("first timeline frame of the window"),
        endFrame: z.number().int().min(0).describe("last timeline frame of the window"),
      })
      .strict(),
    run: ({ id, startFrame, endFrame }) => {
      const res = wordsInFrameRange(id, startFrame, endFrame);
      return ok(res, `${res.words.length} word(s) in [${res.startFrame}..${res.endFrame}]f`);
    },
  }),
  tool({
    name: "timeline_music_context",
    description:
      "The MUSIC context inside a TIMELINE frame range (Editor Frame-Control B4): beats, drops, sections (music/speech/mixed/silence) and a coarse energy curve overlapping [startFrame, endFrame], all in FRAME units — so the editor/Soli can 'cut on the drop' / 'split on the beat' entirely in frame space. Prefers the deep music understanding (understanding.music), falling back to the beat tracker on the run's music bed. Returns { id, fps, startFrame, endFrame, hasMusic, tempoBpm?, beats, drops, sections, energy, source }. READ-only, fail-open (no music → empty arrays, source:'none').",
    kind: "read",
    schema: z
      .object({
        id: idArg,
        startFrame: z.number().int().min(0).describe("first timeline frame of the window"),
        endFrame: z.number().int().min(0).describe("last timeline frame of the window"),
      })
      .strict(),
    run: ({ id, startFrame, endFrame }) => {
      const res = queryMusicInFrameRange(id, startFrame, endFrame);
      return ok(
        res,
        `music [${res.startFrame}..${res.endFrame}]f — ${res.beats.length} beat(s), ${res.drops.length} drop(s), ${res.sections.length} section(s) (${res.source})`,
      );
    },
  }),
  tool({
    name: "timeline_trim_clip_frame",
    description:
      "Frame-exact TRIM of a clip's SOURCE in/out edges (Editor Frame-Control B3): set `inFrame` and/or `outFrame` (either optional; omitted edge left untouched) — keeps the clip's timeline START fixed and adjusts duration, snapping to the frame grid. SKIP-NOT-THROW: a locked clip, a not-found clip, a sub-min-duration window, or a no-op trim returns { skipped } (surfaced in the result), never throws. Invalidates the frame index — re-run timeline_frame_index after. MUTATE. Returns FrameEditResult { id, op, changed, touched, skipped?, fps? }.",
    kind: "mutate",
    schema: z
      .object({
        id: idArg,
        clipId: z.string().min(1).describe("the clip to trim"),
        inFrame: z.number().int().min(0).optional().describe("new SOURCE in edge, in frames"),
        outFrame: z.number().int().min(0).optional().describe("new SOURCE out edge, in frames"),
      })
      .strict(),
    run: ({ id, clipId, inFrame, outFrame }) => {
      const res = trimClipByFrames(id, clipId, { inFrame, outFrame });
      return ok(res, res.skipped ? `trim skipped — ${res.skipped}` : `trimmed ${clipId}`);
    },
  }),
  tool({
    name: "timeline_split_clip_frame",
    description:
      "Razor-SPLIT a clip at an exact TIMELINE frame → two clips (Editor Frame-Control B3): LEFT keeps the original id (refs survive), RIGHT is '<id>_b' inheriting every prop with its own source window. The cut must land ≥ 3 frames inside each side. SKIP-NOT-THROW + IDEMPOTENT: a locked/not-found clip, a cut outside the splittable range, or an already-split clip ('<id>_b' exists) returns { skipped }, never throws. Invalidates the frame index — re-run timeline_frame_index after. MUTATE. Returns FrameEditResult { id, op, changed, touched, skipped?, fps? }.",
    kind: "mutate",
    schema: z
      .object({
        id: idArg,
        clipId: z.string().min(1).describe("the clip to split"),
        atFrame: z.number().int().min(0).describe("the TIMELINE frame to cut at"),
      })
      .strict(),
    run: ({ id, clipId, atFrame }) => {
      const res = splitClipAtFrame(id, clipId, atFrame);
      return ok(res, res.skipped ? `split skipped — ${res.skipped}` : `split ${clipId} @ frame ${atFrame}`);
    },
  }),
  tool({
    name: "timeline_move_clip_frame",
    description:
      "Move a clip so it STARTS at an exact TIMELINE frame (Editor Frame-Control B3): its content + duration are unchanged — a slide of the clip in time, NOT a ripple of neighbours. Clamped to startFrame ≥ 0. SKIP-NOT-THROW + IDEMPOTENT: a locked/not-found clip or a move to the clip's current start frame returns { skipped }, never throws. Invalidates the frame index — re-run timeline_frame_index after. MUTATE. Returns FrameEditResult { id, op, changed, touched, skipped?, fps? }.",
    kind: "mutate",
    schema: z
      .object({
        id: idArg,
        clipId: z.string().min(1).describe("the clip to move"),
        startFrame: z.number().int().min(0).describe("the TIMELINE frame the clip should start at"),
      })
      .strict(),
    run: ({ id, clipId, startFrame }) => {
      const res = moveClipByFrames(id, clipId, startFrame);
      return ok(res, res.skipped ? `move skipped — ${res.skipped}` : `moved ${clipId} → frame ${startFrame}`);
    },
  }),
];
