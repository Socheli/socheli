import { z } from "zod";

import { type PipelineTool, ok, spawnEngine, tool } from "./helpers.ts";
import { loadItem } from "../store.ts";
import { understandingSummary } from "../understanding.ts";

/**
 * understanding-tools.ts — the deep-understanding tool surface (Pillar 5 / Ingest
 * §7.1.5 N2f). Spread into the canonical registry (registry.ts pipelineTools) so
 * MCP / HTTP / CLI / SDK / the dashboard copilot (Soli) all get it for free.
 *
 *   editor_understand      — LONG: detached worker that runs the full pipeline
 *                            (transcribe → shots → speakers → per-shot multimodal
 *                            → editorial signals) and saves item.understanding.
 *                            Follows the detached-spawn contract.
 *   editor_understanding_get — READ: the stored Understanding index for a run,
 *                            plus a compact agent/Soli-readable summary.
 *
 * Shape note: ok/spawnEngine/tool come from the leaf helpers module (NOT
 * registry.ts) so there is no import cycle — mirrors creative-tools.ts / timeline-
 * tools.ts exactly.
 */

const idArg = z.string().min(1).describe("ingested ContentItem/run id (kind:\"ingested\")");

// Proper-noun accuracy: a vocabulary hint biases Whisper's decoder; a glossary is a
// deterministic wrong→right fix that preserves word timings. Shared by both understand
// tools so Soli can pass the speaker's name / brand / product terms up front.
const vocabularyArg = z
  .array(z.string().min(1))
  .optional()
  .describe('names/jargon that appear in the audio (e.g. ["Ada Lovelace","CognitiveX","Laravel"]) — biases Whisper so it stops mishearing them');
const glossaryArg = z
  .array(z.object({ from: z.string().min(1), to: z.string().min(1) }).strict())
  .optional()
  .describe('exact wrong→right caption fixes Whisper still misses (e.g. [{"from":"Ada Lovejoy","to":"Ada Lovelace"}]) — applied without disturbing word timings');

/** Build the extra CLI flags for understanding-run.ts from the vocab/glossary args. */
function vocabFlags(vocabulary?: string[], glossary?: Array<{ from: string; to: string }>): string[] {
  const extra: string[] = [];
  if (vocabulary && vocabulary.length) extra.push("--vocab", vocabulary.join(", "));
  if (glossary && glossary.length) extra.push("--glossary", glossary.map((g) => `${g.from}=${g.to}`).join(";"));
  return extra;
}

export const understandingTools: PipelineTool[] = [
  tool({
    name: "editor_understand",
    description:
      "DEEP-UNDERSTAND an ingested video: run the full pipeline — Whisper transcript (words + segments), shot segmentation (scene-change ∪ silence ∪ speaker boundaries), heuristic speaker turns, per-shot multimodal analysis (motion / quality / brightness / on-screen-text / framing / energy / spoken words), and editorial signals (filler/disfluency, dead-air spans, redundant lines, top highlights). Saves item.understanding (a structured index the editor passes + Soli read). Pass `vocabulary` (names/jargon in the audio) and/or `glossary` (exact wrong→right fixes) so proper nouns transcribe correctly. LONG-RUNNING: spawns a detached worker and returns immediately with its pid + log path; read it back with editor_understanding_get. Fail-open — messy / no-audio footage still yields a valid index.",
    kind: "long",
    schema: z.object({ id: idArg, vocabulary: vocabularyArg, glossary: glossaryArg }).strict(),
    run: ({ id, vocabulary, glossary }) => {
      const job = spawnEngine("understanding-run.ts", [id, ...vocabFlags(vocabulary, glossary)], "tool-understand.log");
      return ok({ status: "started", ...job, id }, "understanding started");
    },
  }),
  tool({
    name: "editor_understand_deep",
    description:
      "DEEP-SEE + DEEP-HEAR an ingested video — the full editor_understand pipeline PLUS two expensive senses: (1) VISION — Claude looks at each shot's keyframe and describes WHAT'S IN IT (subjects, action, setting, camera shot, movement, emotion, what on-screen text means); (2) MUSIC — beat-track the audio (tempo + beat times), classify music-vs-speech sections, detect drops + an energy curve; then a holistic videoSummary ('what this video IS'). Pass `vocabulary` (names/jargon in the audio) and/or `glossary` (exact wrong→right fixes) so proper nouns transcribe correctly. Use when you need Soli to truly understand a video, not just its metrics — e.g. to montage on visual content or cut on the music. LONG-RUNNING (vision is slow + costs model calls): detached worker, returns pid + log; read back with editor_understanding_get. Fail-open per sense.",
    kind: "long",
    schema: z.object({ id: idArg, vocabulary: vocabularyArg, glossary: glossaryArg }).strict(),
    run: ({ id, vocabulary, glossary }) => {
      const job = spawnEngine("understanding-run.ts", [id, "--deep", ...vocabFlags(vocabulary, glossary)], "tool-understand-deep.log");
      return ok({ status: "started", ...job, id }, "deep understanding started");
    },
  }),
  tool({
    name: "editor_understand_dense_vision",
    description:
      "Build the DENSE per-frame VISION grid for an ingested video (Editor Frame-Control B1): sample the source uniformly at `sampleFps` (0.5/1/2 fps), describe each sampled frame with Claude vision (subjects / on-screen text / what's happening) and stamp the cheap per-frame metrics (motion / quality / brightness) on (almost) every frame — indexed by SOURCE frameIndex (round(atSec*fps)) so the editor + Soli can ask 'what is on screen at frame N' in O(1). Persists item.understanding.denseFrameVision. LONG-RUNNING + PAID (one vision pass per sampled frame): spawns a detached worker and returns immediately with its pid + log path; read it back with editor_understanding_get (the grid is under understanding.denseFrameVision). Fail-open per frame.",
    kind: "long",
    schema: z
      .object({
        id: idArg,
        sampleFps: z
          .number()
          .min(0.1)
          .max(8)
          .optional()
          .describe("frames per second to sample (default 1; 0.5 = every 2s, 2 = every 0.5s)"),
      })
      .strict(),
    run: ({ id, sampleFps }) => {
      const fps = sampleFps && sampleFps > 0 ? sampleFps : 1;
      const job = spawnEngine("dense-vision-run.ts", [id, "--sample-fps", String(fps)], `dense-vision-${id}.log`);
      return ok({ status: "started", ...job, id, sampleFps: fps }, `dense vision started @ ${fps}fps`);
    },
  }),
  tool({
    name: "editor_understanding_get",
    description:
      "Read the stored deep-understanding index for an ingested run: the full Understanding (transcript, shots, speakers, per-shot analysis, highlights, dead-air, filler, redundancy) plus a compact, prompt-/Soli-readable summary. Returns { built:false } when editor_understand hasn't run yet. Use to answer \"what's in this video?\" and to ground a footage edit.",
    kind: "read",
    schema: z.object({ id: idArg }).strict(),
    run: ({ id }) => {
      const item = loadItem(id);
      if (!item.understanding) return ok({ built: false, id }, "no understanding yet — run editor_understand first");
      return ok(
        { built: true, id, summary: understandingSummary(item.understanding), understanding: item.understanding },
        `understanding — ${item.understanding.shots.length} shot(s), ${item.understanding.highlights.length} highlight(s)`,
      );
    },
  }),
];
