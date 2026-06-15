import { z } from "zod";

import { type PipelineTool, asyncResult, ok, tool } from "./helpers.ts";
import { seedTimelineFromFootage } from "../creative/seed-from-footage.ts";
import { autoSubtitle } from "../creative/auto-subtitle.ts";

/**
 * ingest-seed-tools.ts — Pillar 5 (Ingest & Understand) §7.1.5 N3a + N4a.
 *
 * Two tools that turn an ingested video's `understanding` into the editable NLE
 * layer everything else reads:
 *   - `ingest_seed_timeline` (N3a): seed a footage timeline (V1 video clips per
 *     shot at SOURCE time + A1 source-audio clip + highlight markers + per-shot
 *     clipAnalysis). Idempotent by shot id — manual trims survive a re-seed.
 *   - `auto_subtitle` (N4a): build an editable caption track (kind:"text" clips
 *     with captionText + word timings) from the transcript and flip
 *     Mix.subtitles.source="track".
 *
 * Spread into the canonical registry (registry.ts pipelineTools) so MCP / HTTP /
 * CLI / SDK / Soli all get them for free. Both are "kind: mutate". N3a may build
 * the understanding inline (async — per-shot perception/OCR), so it returns an
 * asyncResult; the heavy detached path is N2's `editor_understand`, which most
 * callers run FIRST so this seed finds a cached index. ok/asyncResult/tool come
 * from the leaf helpers module (no cycle).
 */

const idArg = z.string().min(1).describe("ContentItem/run id of an ingested video (kind:\"ingested\")");

export const ingestSeedTools: PipelineTool[] = [
  tool({
    name: "ingest_seed_timeline",
    description:
      "Seed (or re-seed) a real-footage NLE timeline on an ingested run from its understanding: a V1 VIDEO track (one clip per shot, cutting the source video at SOURCE time, laid sequentially as an assembly cut), an A1 AUDIO track spanning the source production audio, ruler markers from highlights, and per-shot clipAnalysis copied for the perception passes. Builds item.understanding first if absent. seededFrom=\"footage\". IDEMPOTENT by shot id — re-seeding preserves manual trims on clips whose shot still matches. Returns the persisted timeline summary.",
    kind: "mutate",
    schema: z.object({ id: idArg }).strict(),
    run: ({ id }) =>
      asyncResult(
        seedTimelineFromFootage(id).then((tl) => {
          const v1 = tl.tracks.find((t) => t.id === "V1");
          const a1 = tl.tracks.find((t) => t.id === "A1");
          return ok(
            { id, seededFrom: tl.seededFrom, tracks: tl.tracks.length, videoClips: v1?.clips.length ?? 0, hasAudio: !!a1, markers: tl.markers.length },
            `seeded footage timeline — ${v1?.clips.length ?? 0} shot clip(s)${a1 ? " + source audio" : " (no audio)"}, ${tl.markers.length} marker(s)`,
          );
        }),
      ),
  }),
  tool({
    name: "auto_subtitle",
    description:
      "Build an editable CAPTION track (CAP1, kind:\"text\") on an ingested run by grouping the transcript words into readable caption lines — each clip carries captionText + per-word {word,fromSec,toSec} in SOURCE seconds — and set Mix.subtitles.source=\"track\". NOTE: this produces the editable caption track only; the seconds→frame karaoke render mapping is a LATER milestone (N4b/N6), so captions won't burn in until the render path reads subtitles.source=\"track\". Returns { captionClips }.",
    kind: "mutate",
    schema: z.object({ id: idArg }).strict(),
    run: ({ id }) => {
      const { captionClips } = autoSubtitle(id);
      return ok({ id, captionClips }, `built ${captionClips} caption line(s) → CAP1 (subtitles.source=track; render mapping lands in N4b/N6)`);
    },
  }),
];
