import { z } from "zod";

import { type PipelineTool, ok, tool } from "./helpers.ts";
import {
  timelineInsert,
  timelineJLCut,
  timelineMarker,
  timelineOverwrite,
  timelineRazor,
  timelineTrim,
} from "../creative/timeline-edit.ts";

/**
 * timeline-edit-tools.ts — the Pro-NLE TRIM PRIMITIVE tool surface (DaVinci
 * spine §4.2, M11). Spread into the canonical registry (registry.ts
 * pipelineTools) so MCP / HTTP / CLI / SDK / Soli all get the NLE edit ops.
 *
 * These mutate item.timeline (clamped, locked-safe, never-throw — the ops
 * themselves return a `skipped` note rather than raising) and saveItem. They are
 * "kind: mutate". Like timeline_get they're SYNCHRONOUS (loadItem/saveItem only,
 * no awaited engine work), so we return ok() directly — no asyncResult().
 *
 * ok/tool come from the leaf helpers module (NOT registry.ts) so there is no
 * import cycle — mirrors timeline-tools.ts exactly.
 */

const idArg = z.string().min(1).describe("ContentItem/run id (must already have a built item.timeline)");

// Common shape for the new-clip insert/overwrite tools.
const newClipShape = {
  trackId: z.string().min(1).describe("target track id (e.g. V1 / A1)"),
  atSec: z.number().min(0).describe("timeline time to place the clip at (seconds)"),
  durationSec: z.number().min(0).describe("clip length on the timeline (seconds)"),
  kind: z.enum(["video", "audio", "overlay", "text"]).optional().describe("clip kind (default video)"),
  src: z.string().optional().describe("source asset path/url (for source-backed clips)"),
  sceneRef: z.string().optional().describe("storyboard scene id this clip realizes"),
  inSec: z.number().min(0).optional().describe("source in-point (default 0)"),
  outSec: z.number().min(0).optional().describe("source out-point (default inSec+durationSec)"),
  clipId: z.string().optional().describe("explicit clip id (default auto-generated)"),
};

export const timelineEditTools: PipelineTool[] = [
  tool({
    name: "timeline_trim",
    description:
      "Trim a clip's edge on item.timeline in one of four NLE modes. RIPPLE: move the edge AND shift every later clip on the track (track length changes). ROLL: move the edit point shared with the adjacent clip — one grows as the other shrinks, total UNCHANGED, no other clip moves. SLIP: change which part of the source plays WITHOUT moving the clip on the timeline (shifts inSec+outSec by delta*speed; source-backed clips only). SLIDE: move the clip along the timeline, trimming the neighbours it slides over (total unchanged). edge 'in'=head, 'out'=tail; positive deltaSec drags the edge later. Clamped to source bounds + a min clip length; locked clips are never touched; never throws — returns a {skipped} note instead. Returns {op, changed, touched, track}.",
    kind: "mutate",
    schema: z
      .object({
        id: idArg,
        clipId: z.string().min(1).describe("the clip to trim"),
        edge: z.enum(["in", "out"]).describe("which edge: 'in' (head) or 'out' (tail)"),
        deltaSec: z.number().describe("seconds to move the edge (positive = later)"),
        mode: z.enum(["ripple", "roll", "slip", "slide"]).describe("trim mode"),
      })
      .strict(),
    run: ({ id, clipId, edge, deltaSec, mode }) => {
      const r = timelineTrim(id, { clipId, edge, deltaSec, mode });
      return ok(r, r.skipped ? `trim ${mode}: skipped — ${r.skipped}` : r.changed.join("; "));
    },
  }),
  tool({
    name: "timeline_razor",
    description:
      "Razor-cut a clip into two abutting clips at a TIMELINE time (atSec), dividing the source in/out at the exact same proportion so each half plays the correct footage. No ripple — the cut is in place. The left half keeps the original id; the right is a new '<id>_b'. Clamped so each half is ≥ the min clip length; locked clips are never split; never throws (returns {skipped}). Returns {op, changed, touched, track}.",
    kind: "mutate",
    schema: z
      .object({
        id: idArg,
        clipId: z.string().min(1).describe("the clip to split"),
        atSec: z.number().min(0).describe("timeline time to cut at (seconds)"),
      })
      .strict(),
    run: ({ id, clipId, atSec }) => {
      const r = timelineRazor(id, { clipId, atSec });
      return ok(r, r.skipped ? `razor: skipped — ${r.skipped}` : r.changed.join("; "));
    },
  }),
  tool({
    name: "timeline_insert",
    description:
      "INSERT a new clip onto a track at atSec, RIPPLING everything at/after the insert point later by the clip's duration (an insert edit — nothing is overwritten, the tail moves down). Locked downstream clips are not moved (noted). Returns {op, changed, touched, track}.",
    kind: "mutate",
    schema: z.object({ id: idArg, ...newClipShape }).strict(),
    run: ({ id, ...spec }) => {
      const r = timelineInsert(id, spec as any);
      return ok(r, r.skipped ? `insert: skipped — ${r.skipped}` : r.changed.join("; "));
    },
  }),
  tool({
    name: "timeline_overwrite",
    description:
      "OVERWRITE: drop a new clip at atSec, covering whatever it lands on (no ripple). Clips fully under it are removed; a clip straddling an edge is trimmed back to its exposed part (source in/out divided correctly). Locked clips are never modified/removed. Returns {op, changed, touched, track}.",
    kind: "mutate",
    schema: z.object({ id: idArg, ...newClipShape }).strict(),
    run: ({ id, ...spec }) => {
      const r = timelineOverwrite(id, spec as any);
      return ok(r, r.skipped ? `overwrite: skipped — ${r.skipped}` : r.changed.join("; "));
    },
  }),
  tool({
    name: "timeline_marker",
    description:
      "Add a ruler marker (chapter/beat/note) to item.timeline at a timeline time. Returns {op, changed}.",
    kind: "mutate",
    schema: z
      .object({
        id: idArg,
        atSec: z.number().min(0).describe("timeline time (seconds)"),
        label: z.string().optional().describe("marker label"),
        color: z.string().optional().describe("marker color (hex)"),
      })
      .strict(),
    run: ({ id, atSec, label, color }) => {
      const r = timelineMarker(id, { atSec, label, color });
      return ok(r, r.skipped ? `marker: skipped — ${r.skipped}` : r.changed.join("; "));
    },
  }),
  tool({
    name: "timeline_jl_cut",
    description:
      "J/L CUT — decouple a video clip's AUDIO from its PICTURE (the move the flat scene model can't do). Splits the clip's audio onto a dedicated 'A_JL' audio track as a separate clip offset from the picture: positive audioLeadSec = audio starts EARLIER (L-cut, audio leads the next shot); negative = audio starts LATER (J-cut, audio trails past the cut). The picture clip is unchanged; the audio clip carries the same source window, positioned by the offset, and renders as a positioned <Audio> (no TransitionSeries change). Idempotent per picture clip. Locked/non-video clips are skipped (never throws). Returns {op, changed, touched, track}.",
    kind: "mutate",
    schema: z
      .object({
        id: idArg,
        clipId: z.string().min(1).describe("the VIDEO clip whose audio to offset"),
        audioLeadSec: z.number().describe("seconds the audio leads (+, L-cut) or trails (−, J-cut) the picture"),
      })
      .strict(),
    run: ({ id, clipId, audioLeadSec }) => {
      const r = timelineJLCut(id, { clipId, audioLeadSec });
      return ok(r, r.skipped ? `jl_cut: skipped — ${r.skipped}` : r.changed.join("; "));
    },
  }),
];
