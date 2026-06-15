import { z } from "zod";

import { type PipelineTool, asyncResult, ok, spawnEngine, tool } from "./helpers.ts";
import { inferBrief } from "../creative/brief.ts";
import { chooseConcept, generateConcepts } from "../creative/concepts.ts";
import { applyEdlToStoryboard, buildEdl, gradeScene, gradeGlobal } from "../creative/edl.ts";
import { PASS_ORDER, runPass } from "../creative/passes.ts";
import { colorPass } from "../creative/color-pass.ts";
import { audioPass } from "../creative/audio-pass.ts";
import { compositingPass } from "../creative/compositing-pass.ts";
import { reviewCut } from "../creative/review.ts";
import { learnTaste, loadTaste } from "../creative/taste.ts";
import { analyzeClip, perceiveItemBroll } from "../creative/perception.ts";
import { editSignals, signalsSummary } from "../creative/signals.ts";
import { abConcepts } from "../creative/ab.ts";
import { learnTasteFromPerformance } from "../creative/perf.ts";
import { routeEditRequest } from "../creative/edit-router.ts";
import { montageFromHighlights, tightenFootage } from "../creative/montage.ts";
import { executeEditPlan, executeEditPlanById } from "../creative/apply-plan.ts";
import { autoSubtitle } from "../creative/auto-subtitle.ts";
import { styleCaptions } from "../creative/caption-style.ts";
import { computeZoomWindows } from "../creative/emphasis-zoom.ts";
import { ensureKeywordBroll } from "../creative/keyword-broll.ts";
import { beatSyncTimeline } from "../creative/beat-sync.ts";
import { governPacing, applyHook, retentionPass } from "../creative/pacing-governor.ts";
import { loadItem, saveItem, nowIso } from "../store.ts";

/**
 * creative-tools.ts — the creative-EDITOR tool surface (the editorial-judgement
 * layer: brief → concepts → EDL → passes → self-review). Spread into the
 * canonical registry (registry.ts pipelineTools) so MCP / HTTP / CLI / SDK /
 * the dashboard copilot (Soli) all get the editor for free.
 *
 * Shape note: ok/asyncResult/spawnEngine/tool come from the leaf helpers module
 * (NOT registry.ts) so there is no import cycle — see helpers.ts for the
 * __name-initialization rationale. This is byte-identical to dna-tools.ts etc.
 *
 * Async contract: a PipelineTool.run() is SYNCHRONOUS. Tools that await engine
 * work (LLM calls in the creative modules) wrap their promise with asyncResult()
 * so callTool() can unwrap+await it. We never throw out of an async chain — the
 * .then(ok) maps success; callTool()'s own try/catch maps a rejection to fail().
 */

// ---------------------------------------------------------------------------
// Shared input fragments
// ---------------------------------------------------------------------------

const idArg = z.string().min(1).describe("ContentItem/run id (e.g. concept_20260610034331)");
const channelArg = z.string().min(1).describe("channel/brand id (e.g. labrinox)");
const platformArg = z
  .enum(["youtube_short", "tiktok", "reel", "youtube_long"])
  .describe("target platform the cut is being judged/built for");

// A structured colour-grade input (a Partial ColorGrade — every field optional).
// The engine clamps each field to the schema band (lift ±1, gamma/gain 0..2,
// temp/tint ±1, saturation/contrast 0..2, pivot 0..1) before writing, so a caller
// can never emit an out-of-band grade. Kept loose (z.number) here; the bridge owns
// the bands. Either `grade` or `intent` (or both) may be supplied to the tools.
const rgbInput = z
  .object({ r: z.number().optional(), g: z.number().optional(), b: z.number().optional(), master: z.number().optional() })
  .partial();
const gradeInput = z
  .object({
    lift: rgbInput.optional().describe("shadow lift per channel (additive, ±1)"),
    gamma: rgbInput.optional().describe("midtone gamma per channel (multiplier, 0..2, 1=neutral)"),
    gain: rgbInput.optional().describe("highlight gain per channel (multiplier, 0..2, 1=neutral)"),
    temperature: z.number().optional().describe("white balance, warm(+) / cool(−), ±1"),
    tint: z.number().optional().describe("magenta(+) / green(−) bias, ±1"),
    saturation: z.number().optional().describe("0..2, 1=neutral"),
    contrast: z.number().optional().describe("0..2, 1=neutral about pivot"),
    pivot: z.number().optional().describe("contrast pivot point, 0..1 (≈0.435)"),
  })
  .describe("a structured colour grade (Partial ColorGrade; all fields optional, clamped to schema band)");
const colorIntentArg = z
  .string()
  .min(1)
  .describe('free-text grade direction, e.g. "cool, crushed blacks, filmic" or a named look like "teal orange" / "warm film"');

// ---------------------------------------------------------------------------
// The creative_* tools (the editor surface)
// ---------------------------------------------------------------------------

export const creativeTools: PipelineTool[] = [
  tool({
    name: "creative_brief",
    description:
      "Infer (and persist) the editorial brief for a run: purpose, platform, audience, the feeling to evoke, the structure arc and the do-nots — the creative-director intent that grounds concepts/EDL/review. Run this FIRST on any item before generating concepts. Pass a platform to target a specific surface.",
    kind: "mutate",
    schema: z.object({ id: idArg, platform: platformArg.optional() }).strict(),
    run: ({ id, platform }) =>
      asyncResult(inferBrief(id, platform ? { platform } : undefined).then((brief) => ok(brief, "brief inferred"))),
  }),
  tool({
    name: "creative_concepts",
    description:
      "Generate N distinct editorial concepts for a run (each a named directorial take: style, pacing, palette/typography/transition/sound intent, scored on hook/pacing/emotion/brandFit/platformFit). Saves item.concepts. Needs a brief first (creative_brief). Use when you want options before committing a direction.",
    kind: "mutate",
    schema: z.object({ id: idArg, n: z.number().int().min(1).max(8).default(3).describe("how many concepts to generate") }).strict(),
    run: ({ id, n }) => asyncResult(generateConcepts(id, { n }).then((c) => ok(c, `${c.length} concept(s) generated`))),
  }),
  tool({
    name: "creative_choose_concept",
    description:
      "Commit one concept as the cut's chosen direction (sets item.chosenConcept). Omit conceptId to auto-pick the highest-overall-scoring concept. Run after creative_concepts and before creative_edl_build.",
    kind: "mutate",
    schema: z.object({ id: idArg, conceptId: z.string().min(1).optional().describe("concept id to commit; omit to auto-pick best") }).strict(),
    run: ({ id, conceptId }) => ok(chooseConcept(id, conceptId), "concept chosen"),
  }),
  tool({
    name: "creative_edl_build",
    description:
      "Build (and persist) the Edit Decision List from the chosen concept: a per-scene editorial decision (function, intent, pacing, emphasis, transition/broll/mix/color/caption/motion intent) — the editorial plan, not yet applied to the render. Pass conceptId to build from a specific concept. Follow with creative_edl_apply to bridge it onto the storyboard.",
    kind: "mutate",
    schema: z.object({ id: idArg, conceptId: z.string().min(1).optional().describe("concept id to build the EDL from; omit to use the chosen concept") }).strict(),
    run: ({ id, conceptId }) => asyncResult(buildEdl(id, conceptId ? { conceptId } : undefined).then((edl) => ok(edl, `EDL built — ${edl.decisions.length} decision(s)`))),
  }),
  tool({
    name: "creative_edl_apply",
    description:
      "THE BRIDGE: map the EDL's editorial intent onto concrete storyboard scene/mix params (clamped to schema ranges, never touching locked scenes) so the cut renders through Remotion. Returns the list of changed paths. Run after creative_edl_build; re-render to see it.",
    kind: "mutate",
    schema: z.object({ id: idArg }).strict(),
    run: ({ id }) => {
      const { changed } = applyEdlToStoryboard(id);
      return ok({ id, changed }, `EDL applied — ${changed.length} change(s)`);
    },
  }),
  tool({
    name: "creative_grade_scene",
    description:
      "COLORIST: write a real colour grade onto ONE scene (scene.style.grade — per-channel lift/gamma/gain, temperature/tint, saturation/contrast/pivot). Pass a structured `grade` (numbers) and/or a free-text `intent` (\"cool, crushed blacks, filmic\" or a named look like \"teal orange\"); intent is mapped deterministically and the explicit grade wins on top. Every field is clamped to the schema band, a locked scene is skipped (not thrown). Re-render to see it. Use for surgical per-scene grading.",
    kind: "mutate",
    schema: z
      .object({
        id: idArg,
        sceneIndex: z.number().int().min(0).describe("index of the scene to grade"),
        grade: gradeInput.optional(),
        intent: colorIntentArg.optional(),
      })
      .strict()
      .refine((v) => v.grade != null || v.intent != null, { message: "provide a grade and/or an intent" }),
    run: ({ id, sceneIndex, grade, intent }) => {
      const r = gradeScene(id, sceneIndex, { grade, intent });
      return ok(r, r.grade ? `scene ${sceneIndex} graded` : `scene ${sceneIndex}: ${r.changed[0] ?? "no grade written"}`);
    },
  }),
  tool({
    name: "creative_grade_global",
    description:
      "COLORIST: write the GLOBAL project trim onto storyboard.grade — the look every scene shares, composited AFTER the per-scene grades. Same shape/clamping as creative_grade_scene; pass a structured `grade` and/or a free-text `intent`. Merges over any existing global grade. Use for a consistent project-wide look (e.g. \"warm filmic throughout\").",
    kind: "mutate",
    schema: z
      .object({
        id: idArg,
        grade: gradeInput.optional(),
        intent: colorIntentArg.optional(),
      })
      .strict()
      .refine((v) => v.grade != null || v.intent != null, { message: "provide a grade and/or an intent" }),
    run: ({ id, grade, intent }) => {
      const r = gradeGlobal(id, { grade, intent });
      return ok(r, r.grade ? "global grade written" : (r.changed[0] ?? "no grade written"));
    },
  }),
  tool({
    name: "creative_color_pass",
    description:
      "COLORIST (closed loop): grade the whole cut toward MEASURED targets, not vibes. Reads real ffmpeg scopes per scene (luma P50 / clip% / white-balance bias via editor_color_scopes), then solves a per-scene grade in CLOSED FORM toward balanced exposure (P50 into the brand's midtone band), neutral white balance (unless the chosen concept's palette is deliberately stylized), and scene-to-scene CONSISTENCY — writing each grade through the clamped, locked-safe bridge and learning the channel's colour band into editing taste. Fails open: with no render it seeds a gentle look from the concept palette. Set verify=true to re-read the scopes after grading. Re-render to see the result, then re-run for the next iteration.",
    kind: "mutate",
    schema: z.object({ id: idArg, verify: z.boolean().default(false).describe("re-read the scope table after grading to report the consistency the pass bought") }).strict(),
    run: ({ id, verify }) =>
      asyncResult(
        colorPass(id, { verify }).then((r) =>
          ok(r, r.mode === "closed_loop" ? `color pass: graded ${r.scenesGraded} scene(s) toward exposure/WB/consistency` : `color pass: ${r.mode}`),
        ),
      ),
  }),
  tool({
    name: "creative_audio_pass",
    description:
      "MIXER (closed loop): mix the whole cut toward MEASURED loudness targets, not vibes. Reads real EBU R128 meters off the render (integrated LUFS / true-peak / loudness range / per-region RMS via editor_analyze_av), then solves a concrete mix in CLOSED FORM toward four targets: integrated within ~0.5 LU of the master target (mix.loudnessTarget ?? -14), true-peak ≤ -1 dBTP, the voice ≥ ~9 LU over the music bed (intelligibility), and dynamics preserved (don't crush LRA). Writes the loudness target / sidechain duck / voice level through the clamped, locked-safe mix layer and learns the channel's loudness band into editing taste. Fails open: with no meters it applies a clean default duck + loudness target. Set verify=true to re-read the meters with a skip-on-worsen guard (a change that worsens LUFS/TP/LRA is rolled back). Re-render to see the result, then re-run for the next iteration.",
    kind: "mutate",
    schema: z.object({ id: idArg, verify: z.boolean().default(false).describe("re-read the meters after mixing and roll back a change that worsened loudness/true-peak/dynamics") }).strict(),
    run: ({ id, verify }) =>
      asyncResult(
        audioPass(id, { verify }).then((r) =>
          ok(
            r,
            r.mode === "closed_loop"
              ? r.reverted
                ? "audio pass: mix reverted (a change worsened the meters)"
                : `audio pass: ${r.applied.length} change(s) toward target loudness / VO-over-bed / dynamics`
              : `audio pass: ${r.mode}`,
          ),
        ),
      ),
  }),
  tool({
    name: "creative_compositing_pass",
    description:
      "COMPOSITOR (closed loop): author a premium LOOK toward MEASURED visual deficiencies, not vibes. PERCEIVES the cut via editor_video_evidence (dense frames + per-frame pixel metrics + motion deltas + OCR), DIAGNOSES where the picture is lacking (a flat/empty frame wanting a subtle bloom; a busy background hurting on-screen-text legibility wanting a vignette scrim; an inert hero beat wanting a light-leak accent; a subject lost in the frame wanting a soft isolate + glow), then PROPOSES restrained per-scene EffectGraphs onto scene.style.comp through the same deterministic, clamped, locked-safe bridge (buildCompFromIntents). RESTRAINT is load-bearing: DNA-/taste-biased low-opacity defaults, a hard cap on scenes touched, never garish. Fails open: with no render it applies a tasteful DNA-default global wash (or nothing for a minimal brand). Learns durable look prefs into editing taste. Set verify=true to re-perceive and roll back a scene whose deficiency worsened. Re-render to see the result, then re-run for the next iteration.",
    kind: "mutate",
    schema: z.object({ id: idArg, verify: z.boolean().default(false).describe("re-perceive after compositing and roll back a scene whose measured deficiency worsened") }).strict(),
    run: ({ id, verify }) =>
      asyncResult(
        compositingPass(id, { verify }).then((r) =>
          ok(
            r,
            r.mode === "closed_loop"
              ? r.scenesComposited > 0
                ? `compositing pass: composited ${r.scenesComposited} scene(s) against measured deficiencies${r.reverted.length ? ` (${r.reverted.length} reverted)` : ""}`
                : r.reverted.length
                  ? "compositing pass: all proposed looks reverted on verify"
                  : "compositing pass: nothing warranted"
              : `compositing pass: ${r.mode}`,
          ),
        ),
      ),
  }),
  tool({
    name: "creative_pass",
    description:
      "Run ONE focused editing pass over the cut (e.g. pacing, emotion, audio, typography, color, qa). Each pass refines the EDL/storyboard for its single concern and logs a PassRecord (what changed + why). Use for surgical, named refinement; for the whole loop use creative_edit_start.",
    kind: "mutate",
    schema: z.object({ id: idArg, pass: z.enum(PASS_ORDER as [string, ...string[]]).describe("which editing pass to run") }).strict(),
    run: ({ id, pass }) => asyncResult(runPass(id, pass as any).then((rec) => ok(rec, `${pass} pass — ${rec.changed.length} change(s)`))),
  }),
  tool({
    name: "creative_review",
    description:
      "Self-review the current cut as a critical editor: scores it (hook, pacing, audio clarity, subtitle readability, brand consistency, emotional impact, CTA clarity, technical polish) using render evidence, lists concrete fixes (where/issue/action/severity) and returns a verdict (ship/revise/reject). Appends to item.reviews. Use to judge a cut after editing.",
    kind: "mutate",
    schema: z.object({ id: idArg, pass: z.string().min(1).optional().describe("label the review with the pass it follows") }).strict(),
    run: ({ id, pass }) => asyncResult(reviewCut(id, pass ? { pass } : undefined).then((r) => ok(r, `review: ${r.verdict} (overall ${r.scores.overall})`))),
  }),
  tool({
    name: "creative_perceive",
    description:
      "Look at footage with an editor's eye. Pass a source path to analyze ONE clip (motion, shake, quality, brightness, on-screen text, best moment, which scene functions it suits, reject flag). Omit source and pass an id to perceive every b-roll clip on that run. Use to vet footage before building/applying the EDL.",
    kind: "read",
    schema: z.object({ id: idArg.optional(), source: z.string().min(1).optional().describe("path/URL of a single clip to analyze; omit to perceive all of an item's b-roll") }).strict(),
    run: ({ id, source }) => {
      if (source) return asyncResult(analyzeClip(source, id ? { sceneId: id } : undefined).then((a) => ok(a, "clip analyzed")));
      if (!id) throw new Error("creative_perceive needs either a source (single clip) or an id (perceive item b-roll)");
      return asyncResult(perceiveItemBroll(id).then((map) => ok(map, `${Object.keys(map).length} clip(s) perceived`)));
    },
  }),
  tool({
    name: "creative_taste_get",
    description:
      "Get a channel's learned editing taste: pacing/palette/typography/transition/sound preferences plus weighted rules and do-nots (seeded, then sharpened by feedback/reviews/performance). The brand's editorial fingerprint — read it to ground any creative work.",
    kind: "read",
    schema: z.object({ channel: channelArg }).strict(),
    run: ({ channel }) => ok(loadTaste(channel), "taste loaded"),
  }),
  tool({
    name: "creative_taste_learn",
    description:
      "Teach a channel's editing taste: add a preference rule and/or a do-not, and/or set explicit pacing/palette/typography/transitions/sound preferences. Persists to the channel's EditingTaste so future concepts/EDLs honor it. Use to capture an operator's editorial direction or a learning.",
    kind: "mutate",
    schema: z
      .object({
        channel: channelArg,
        rule: z.string().min(1).optional().describe("a preference rule to add (do this)"),
        doNot: z.string().min(1).optional().describe("a do-not rule to add (never do this)"),
        pacing: z.string().min(1).optional().describe("preferred pacing"),
        palette: z.string().min(1).optional().describe("preferred palette intent"),
        typography: z.string().min(1).optional().describe("preferred typography intent"),
        transitions: z.string().min(1).optional().describe("preferred transition intent"),
        sound: z.string().min(1).optional().describe("preferred sound intent"),
      })
      .strict(),
    run: ({ channel, rule, doNot, pacing, palette, typography, transitions, sound }) => {
      // Only forward the prefs the caller actually set, so we never clobber an
      // existing taste pref with an undefined.
      const pref: Record<string, string> = {};
      if (pacing) pref.pacing = pacing;
      if (palette) pref.palette = palette;
      if (typography) pref.typography = typography;
      if (transitions) pref.transitions = transitions;
      if (sound) pref.sound = sound;
      return asyncResult(
        learnTaste(channel, {
          rule,
          doNot,
          pref: Object.keys(pref).length ? (pref as any) : undefined,
          source: "feedback",
        }).then((t) => ok(t, "taste updated")),
      );
    },
  }),
  tool({
    name: "creative_signals",
    description:
      "Read the OBSERVED edit signals for a run — per-scene read/speak budgets (is the text on screen long enough to actually read/hear? TOO-FAST / DEAD-AIR flags) plus render diagnostics (silences, freezes, black frames, scene changes, readability flags) when a render exists. This is the perception→judgment layer the passes consult; read it to ground edits in measurement, not taste.",
    kind: "read",
    schema: z.object({ id: idArg }).strict(),
    run: ({ id }) => asyncResult(editSignals(id).then((s) => ok({ ...s, summary: signalsSummary(s) }, `signals — ${s.scenes.length} scene(s), render evidence: ${s.evidence.hasRender}`))),
  }),
  tool({
    name: "creative_ab",
    description:
      "A/B the top editorial concepts on REAL output: render the top-N scored concepts as variant cuts, self-review each, and commit the winner as the run's chosen direction. Use to pick a direction by proof (how it actually plays) rather than by predicted scores. Renders variants (slower); set render=false to rank by pre-render scores only.",
    kind: "long",
    schema: z.object({ id: idArg, top: z.number().int().min(2).max(4).default(2).describe("how many top concepts to render+compare"), render: z.boolean().default(true).describe("render each variant to judge real frames") }).strict(),
    run: ({ id, top, render }) => asyncResult(abConcepts(id, { top, render }).then((r) => ok(r, `A/B winner: ${r.winner}`))),
  }),
  tool({
    name: "creative_learn_performance",
    description:
      "Close the growth loop: translate a published post's performance (retention, drop-off, views, saves) into durable EDITING taste for the channel — e.g. early drop-off → 'hooks must land faster'. Reads the item's analytics if present; no-op when none exist. Use after analytics land to make the next cut start smarter.",
    kind: "mutate",
    schema: z.object({ channel: channelArg, id: idArg.describe("the published item whose performance to learn from") }).strict(),
    run: ({ channel, id }) => asyncResult(learnTasteFromPerformance(channel, id).then((r) => ok(r, `${r.applied.length} taste signal(s) learned from performance`))),
  }),
  tool({
    name: "creative_edit_start",
    description:
      "Run the FULL autonomous creative edit on a run — brief → concepts → choose → EDL → bridge → editing passes → self-review, iterating until it ships or the budget is spent. Long-running: spawns a detached worker and returns immediately with its pid + log path; watch the log and read item.reviews for the verdict. Use to one-shot 'make this cut great'.",
    kind: "long",
    schema: z
      .object({
        id: idArg,
        platform: platformArg.optional(),
        maxIterations: z.number().int().min(1).max(8).optional().describe("cap the review→fix iterations"),
        render: z.boolean().optional().describe("re-render between iterations to judge real frames"),
        passes: z.array(z.enum(PASS_ORDER as [string, ...string[]])).optional().describe("restrict to a specific pass subset"),
      })
      .strict(),
    run: ({ id, platform, maxIterations, render, passes }) => {
      // Build the worker argv: positional id first, then flags the creative-run
      // entrypoint parses. Keep flags simple/string so the spawn boundary stays
      // shell-free (we spawn node directly, not a shell).
      const args = [id];
      if (platform) args.push("--platform", platform);
      if (typeof maxIterations === "number") args.push("--max-iterations", String(maxIterations));
      if (render) args.push("--render");
      if (passes?.length) args.push("--passes", passes.join(","));
      const job = spawnEngine("creative-run.ts", args, "tool-creative-edit.log");
      return ok({ status: "started", ...job, id }, "creative edit started");
    },
  }),
  tool({
    // Pillar 5 N5.0: the chat→edit router. ANALYSIS ONLY — it produces a grounded
    // EditPlan (ops citing real dead-air spans / highlights / timeline clip ids)
    // and persists it to data/edit-plans/<id>.json. It does NOT apply or render;
    // creative_apply_plan (N5.1) executes an approved plan. "mutate" because it
    // writes the plan artifact, but the run itself is untouched.
    name: "creative_edit_route",
    description:
      "Turn a plain-language edit request on an INGESTED video into a grounded, analysis-only EditPlan — a list of edit operations (ripple_trim/razor/jl_cut/slip/insert_broll/subtitle/grade/mix/select_highlight/reorder…) that each cite real evidence (dead-air spans, highlights, real timeline clip ids) drawn from the run's understanding + edit signals + timeline. Persists the plan to data/edit-plans/<id>.json and returns it. Does NOT apply or render — use creative_apply_plan to execute it. e.g. 'cut the dead air', 'subtitle it', 'make a 20s teaser'.",
    kind: "mutate",
    schema: z
      .object({
        id: idArg,
        request: z.string().min(1).describe("the plain-language edit ask, e.g. 'cut the dead air and subtitle it'"),
        mode: z.enum(["guided", "autonomous"]).optional().describe("guided (human-gated, default) vs autonomous"),
      })
      .strict(),
    run: ({ id, request, mode }) =>
      asyncResult(routeEditRequest(id, request, mode ? { mode } : undefined).then((plan) => ok(plan, `edit plan ${plan.id} — ${plan.ops.length} op(s)${plan.montage ? " + montage" : ""}`))),
  }),
  tool({
    // Pillar 5 N5.2: re-montage an ingested+understood video. Ranks the run's
    // understood shots by composite editorial score (highlight/energy/motion/spoken
    // minus dead-air/filler), keeps the strongest to fit targetSec/maxClips, orders
    // them (narrative/energy/chronological), and REBUILDS item.timeline (V1 cut +
    // A1 audio + re-mapped CAP1 captions, seededFrom:"footage"). Idempotent, fail-open,
    // locked-safe. "mutate" because it rewrites the timeline (a destructive re-cut),
    // though re-running with the same spec is a no-op.
    name: "creative_montage",
    description:
      "Re-montage an INGESTED video into a fast-cut highlight reel / teaser / supercut. Picks the strongest understood shots (by highlight/energy/motion/spoken-content, skipping dead-air) to fit a target length & clip budget, orders them (narrative=story order / energy=build-to-peak / chronological=as-shot), and rebuilds the timeline's video+audio+caption tracks from just those clips. Idempotent (same spec ⇒ same cut). e.g. 'make a 20s teaser', 'cut a 45s highlight reel'.",
    kind: "mutate",
    schema: z
      .object({
        id: idArg,
        targetSec: z.number().positive().optional().describe("target reel length in seconds (defaults by style)"),
        style: z
          .enum(["highlight_reel", "teaser", "supercut", "tight_cut"])
          .optional()
          .describe("montage style — sets sensible default length/clip-count/order"),
        maxClips: z.number().int().positive().optional().describe("max number of clips to keep"),
        orderBy: z
          .enum(["narrative", "energy", "chronological"])
          .optional()
          .describe("clip ordering — narrative/chronological (source order) or energy (build to peak)"),
      })
      .strict(),
    run: ({ id, targetSec, style, maxClips, orderBy }) => {
      const tl = montageFromHighlights(id, { targetSec, style, maxClips, orderBy });
      const v1 = tl.tracks.find((t) => t.id === "V1");
      const clips = v1?.clips.length ?? 0;
      const total = v1?.clips.reduce((s, c) => s + (c.durationSec ?? 0), 0) ?? 0;
      return ok(tl, `montage rebuilt — ${clips} clip(s), ${Math.round(total * 10) / 10}s${style ? ` (${style})` : ""}`);
    },
  }),
  tool({
    name: "creative_tighten",
    description:
      "TIGHTEN an ingested video — the COHERENT alternative to a highlight-reel montage. Keeps the WHOLE narrative in order but cuts out only the dead air and filler ('um'/'uh'/long pauses), so a talking-head pitch gets snappier WITHOUT jump-cuts. Rebuilds the timeline's video track from the keep-spans; captions follow automatically. Use for 'tighten this', 'cut the filler', 'remove the dead air' on a talking-head where you want to keep the full message.",
    kind: "mutate",
    schema: z.object({ id: idArg, padSec: z.number().min(0).max(1).optional().describe("padding kept around each cut (default 0.12s)") }).strict(),
    run: ({ id, padSec }) => {
      const tl = tightenFootage(id, { padSec });
      const v1 = tl.tracks.find((t) => t.id === "V1");
      const clips = v1?.clips.length ?? 0;
      const total = v1?.clips.reduce((s, c) => s + (c.durationSec ?? 0), 0) ?? 0;
      return ok(tl, `tightened — ${clips} kept span(s), ${Math.round(total * 10) / 10}s`);
    },
  }),
  tool({
    name: "creative_beat_sync",
    description:
      "BEAT-SYNC an ingested edit: snap the hard cuts (and the punch-in zoom peaks) to the music bed's DOWNBEATS, 1–2 frames early for anticipation, so the cut feels SCORED. Resolves beats from the run's music bed, preserves every clip's source window (captions still follow at render), and reports the BPM→cut-density grade. Run AFTER creative_montage/creative_tighten + edit-music (music bed must be set), BEFORE render. Fail-open: no detectable beat ⇒ the cut is left unchanged. e.g. 'sync the cuts to the beat', 'make the edit hit on the downbeats'.",
    kind: "mutate",
    schema: z.object({ id: idArg }).strict(),
    run: ({ id }) => {
      const { timeline, snapped, bpm, grade } = beatSyncTimeline(id);
      const v1 = timeline.tracks.find((t) => t.id === "V1");
      const clips = v1?.clips.length ?? 0;
      return ok(
        { snapped, bpm, grade },
        `beat-sync: ${snapped} cut(s) snapped${bpm ? ` @ ${bpm}bpm` : ""} across ${clips} clip(s) — ${grade.grade} (${grade.note})`,
      );
    },
  }),
  tool({
    // Caption STYLE CHOREOGRAPHY: annotate each caption line with its own
    // preset/position/size/accent (and depth) so the video isn't one static
    // subtitle look. Reads understanding highlights + accent keywords to score
    // each line's emphasis. "mutate" — rewrites caption clips' captionStyle.
    name: "creative_style_captions",
    description:
      "STYLE the captions of an ingested video like a pro editor — instead of ONE subtitle look for the whole video, give each line its own treatment: the hook lands big in glow, stats/numbers slam in huge hormozi, brand/keyword lines pop in accent colour, quiet lines sit smaller — all in the readable lower third with a heavy outline so nothing overlaps the face. OPT-IN: pass behind:true to also tuck a few SHORT lines behind the speaker (Odysser depth, needs a subject matte); off by default because a long line behind a head reads poorly. Requires captions already built (creative_subtitle). Run AFTER subtitling and BEFORE render. e.g. 'vary the caption styles', 'make the subtitles dynamic like Hormozi'.",
    kind: "mutate",
    schema: z
      .object({
        id: idArg,
        school: z.enum(["clean", "springy"]).optional().describe("caption SCHOOL: 'clean' = Anton ALL-CAPS, one gold word, snap (Hormozi/business default); 'springy' = Montserrat-900, spring overshoot (entertainment)"),
        behind: z.boolean().optional().describe("opt in to behind-the-subject captions for a few short lines (Odysser depth); default off"),
        behindEvery: z.number().int().min(0).max(12).optional().describe("if behind: tuck every Nth short quiet line behind the subject (default 5; 0 = never)"),
        accent: z.string().optional().describe("accent colour for emphasis/keyword lines (defaults to brand accent)"),
      })
      .strict(),
    run: ({ id, school, behind, behindEvery, accent }) => {
      const r = styleCaptions(id, { school, behind, behindEvery, accent });
      const looks = Object.entries(r.looks).map(([k, v]) => `${k}×${v}`).join(", ");
      return ok(r, r.styled ? `styled ${r.styled} caption line(s): ${looks}` : "no caption track to style — run creative_subtitle first");
    },
  }),
  tool({
    // P3 — emphasis punch-ins: toggle/tune the auto-zoom-on-stressed-words pass and
    // persist it on item.mix.zoomPunch (renderHybrid reads it every render). mutate
    // kind (rewrites mix, no render). Previews the count it will fire at render time.
    name: "creative_punch_ins",
    description:
      "Auto-zoom emphasis PUNCH-INS on an ingested talking-head video — detect the vocally-stressed words (RMS energy peaks) and fire a subtle eased zoom-in that LANDS on each key word, ≤3 big zooms/min, ≥6–8s apart and jittered so it never feels robotic (Submagic/Captions look). Tune intensity (subtle≈108%, normal≈112%, punchy≈118%). OFF restores a flat spine. Requires captions built (creative_subtitle) so it knows word timing. Run AFTER subtitling, BEFORE render. e.g. 'add punch-in zooms', 'zoom on the key words', 'make the punch-ins subtler'.",
    kind: "mutate",
    schema: z
      .object({
        id: idArg,
        enabled: z.boolean().optional().describe("turn punch-ins on/off (default on)"),
        intensity: z.enum(["subtle", "normal", "punchy"]).optional().describe("zoom amount: subtle≈108%, normal≈112%, punchy≈118%"),
        maxPerMin: z.number().int().min(0).max(6).optional().describe("cap big zooms per minute (default 3)"),
      })
      .strict(),
    run: ({ id, enabled, intensity, maxPerMin }) => {
      const item = loadItem(id);
      const scale = intensity === "subtle" ? 1.08 : intensity === "punchy" ? 1.18 : 1.12;
      const zoomPunch = { enabled: enabled !== false, scale, ...(maxPerMin != null ? { maxPerMin } : {}) };
      item.mix = { ...(item.mix ?? {}), zoomPunch } as typeof item.mix;
      item.updatedAt = nowIso();
      saveItem(item);
      // preview the count it will fire at render time (re-anchored to the cut timeline).
      const fps = item.timeline?.fps ?? item.source?.probe?.video?.fps ?? 30;
      const vClips = (item.timeline?.tracks.find((t) => t.kind === "video" && t.id === "V1")?.clips ?? item.timeline?.tracks.find((t) => t.kind === "video")?.clips ?? []) as Parameters<typeof computeZoomWindows>[2];
      const wins = zoomPunch.enabled ? computeZoomWindows(item, fps, vClips, zoomPunch) : [];
      return ok(
        { zoomPunch, count: wins.length },
        zoomPunch.enabled
          ? `punch-ins ${intensity ?? "normal"} (${Math.round((scale - 1) * 100)}%) — ${wins.length} zoom(s) planned`
          : "punch-ins off (flat spine)",
      );
    },
  }),
  tool({
    // P4 — keyword b-roll ("show what's named"): extract the meaning-bearing
    // keywords from the transcript and lay 1.5–2.5s MUTED stock cutaways over the
    // speaker, pre-rolled ~0.35s before the word, with the A-roll voice continuous
    // underneath. Writes a dedicated BROLL1 overlay track (idempotent: replaced on
    // re-run); render.ts buildOverlayClips already composites overlay tracks, so no
    // render/HybridPost edit is needed. async (resolveBroll awaits network) → wraps
    // with asyncResult.
    name: "creative_broll",
    description:
      "Add keyword b-roll cutaways to an INGESTED talking-head video — 'show what's named'. Extracts the meaning-bearing keywords (nouns, numbers, brand/proper names) from the transcript, fetches a matching stock clip per keyword (Pexels/Pixabay/AI cascade), and lays 1.5-2.5s MUTED cutaways over the speaker — pre-rolled ~0.3s before the word is said — with the speaker's audio continuous underneath. Capped at ~35% of runtime with a per-keyword cooldown so it never feels gimmicky, and it never cuts away in the first 2.5s (protects the hook). Requires captions/understanding already built. Run AFTER subtitling/tightening and BEFORE render. e.g. 'add b-roll', 'cut to footage when she names things'.",
    kind: "mutate",
    schema: z
      .object({
        id: idArg,
        dur: z.number().min(1.5).max(2.5).optional().describe("cutaway length in seconds (default 2.0)"),
        preroll: z.number().min(0.2).max(0.5).optional().describe("seconds the cutaway starts BEFORE the keyword (default 0.35)"),
        maxCoverage: z.number().min(0.3).max(0.4).optional().describe("max fraction of runtime covered by b-roll (default 0.35)"),
        cooldownSec: z.number().min(2.5).max(20).optional().describe("min seconds between cutaways for the same keyword (default 6)"),
        styleHint: z.string().optional().describe("footage style bias appended to each stock search (e.g. the mood footageSearch)"),
      })
      .strict(),
    run: ({ id, dur, preroll, maxCoverage, cooldownSec, styleHint }) =>
      asyncResult(
        ensureKeywordBroll(id, { dur, preroll, maxCoverage, cooldownSec, styleHint }).then((r) =>
          ok(
            r,
            r.added
              ? `added ${r.added} keyword b-roll cutaway(s): ${r.keywords.join(", ").slice(0, 80)}`
              : "no keyword b-roll added (no clips passed the gates / resolved)",
          ),
        ),
      ),
  }),
  tool({
    // P6 — PACING GOVERNOR (§3): a PURE timeline post-pass that guarantees the
    // visual-change cadence. Merges the cut/zoom/broll/caption stream, REPAIRS any
    // static stretch >6s by writing an eased gov_ punch-in (Clip.zoom) at the nearest
    // stressed word (snapped to the downbeat grid — one shared snapper), enforces a
    // change every ≤4s body / ≤1.8s high-energy, and CLAMPS density to 5–7 changes /
    // 10s by disabling the lowest-value inserted events (never a hard cut / locked
    // clip). IDEMPOTENT (strips gov_ then recomputes) so it's safe every render.
    name: "creative_pace",
    description:
      "PACING GOVERNOR — guarantee a world-class visual-change cadence on an INGESTED edit. Merges every change (hard cut, punch-in zoom, b-roll cutaway, caption pop) into one stream and: repairs any static stretch >~6s by inserting an eased punch-in at the nearest vocally-stressed word, ensures a change every 2–4s (tighter over high-energy/highlight regions), and clamps density to 5–7 changes / 10s so it never strobes. Writes gov_ zoom keyframes the punch-ins renderer animates (no second transform) and flags 'broll-needed @t' where no clip could take a zoom. Idempotent + fail-open. Run AFTER montage/tighten/b-roll/captions/beat-sync, BEFORE render (the hybrid render also runs it automatically). e.g. 'fix the pacing', 'no part should sit static', 'tighten the cadence'.",
    kind: "mutate",
    schema: z
      .object({
        id: idArg,
        staticFailSec: z.number().min(5).max(8).optional().describe("the static-stretch hard-fail threshold in seconds (default 6)"),
      })
      .strict(),
    run: ({ id, staticFailSec }) => {
      const r = governPacing(id, () => {}, staticFailSec != null ? { staticFailSec } : undefined);
      return ok(r, `governed — ${r.inserts} insert(s), ${r.suppressions} suppression(s), ${r.repaired} static stretch(es) repaired`);
    },
  }),
  tool({
    // P6 — HOOK ENGINE (§6): in-media-res open + a ≤7-word text hook on by 1.0s held
    // ~3s + 2–3 micro-cut punch-ins in the first 2.5s. Pure timeline mutation:
    // ripple-trims a dead-air lead so frame 1 is mid-action, drops a synthetic CAP1
    // hook line (inherits the karaoke styling) or captionText line, and seeds
    // gov_hook_ zooms. Idempotent + locked-safe + fail-open.
    name: "creative_hook",
    description:
      "HOOK ENGINE — make the first 3 seconds of an INGESTED video unskippable. Starts in-media-res (ripple-trims a leading dead-air/low-energy opener so frame 1 is mid-action), puts a ≤7-word text hook on screen by second 1 held ~3s (derived from the opening line or you can pass your own), and forces 2–3 micro-cuts (early punch-ins) in the first ~2.5s so the open has motion. Pure timeline post-pass, idempotent, fail-open. Run BEFORE render (the hybrid render also runs it automatically). e.g. 'add a hook', 'open mid-action', 'make the first second grab them'.",
    kind: "mutate",
    schema: z
      .object({
        id: idArg,
        text: z.string().max(80).optional().describe("override hook text (auto-truncated to 7 words); omit to derive from the opening line"),
      })
      .strict(),
    run: ({ id, text }) => {
      const r = applyHook(id, () => {}, text != null ? { text } : undefined);
      return ok(
        r,
        r.hookText
          ? `hook applied — "${r.hookText}" (${r.microCuts} micro-cut(s)${r.trimmedSec ? `, trimmed ${r.trimmedSec}s lead` : ""})`
          : "no hook applied (no transcript/summary to derive one — pass text)",
      );
    },
  }),
  tool({
    // P6 — RETENTION (one-shot): the hook then the pacing governor, the same order
    // the pre-render compose hook runs them. The 'make this retain' button.
    name: "creative_retention",
    description:
      "RETENTION PASS — one-shot world-class pacing on an INGESTED edit: apply the HOOK (in-media-res + ≤7-word text hook + early micro-cuts) then the PACING GOVERNOR (repair static stretches, enforce 2–4s cadence, clamp density). The single 'make this retain' pass. Idempotent + fail-open. Run after the edit is assembled, before render. e.g. 'make this hold attention', 'world-class pacing pass'.",
    kind: "mutate",
    schema: z.object({ id: idArg }).strict(),
    run: ({ id }) => {
      const r = retentionPass(id);
      return ok(r, `retention pass — hook "${r.hook.hookText}" + ${r.govern.inserts} pacing insert(s), ${r.govern.repaired} stretch(es) repaired`);
    },
  }),
  tool({
    // Pillar 5 N5.1: APPLY a routed EditPlan through the REAL machinery. Each op
    // dispatches 1:1 to an existing function (M11 trims / auto-subtitle / colour+mix
    // bridges / montage), then ONE compile, then (if render) ONE renderHybrid. FAIL-
    // OPEN per op. "long" because rendering is heavy + detaches per the spawn
    // contract; without render it mutates inline.
    name: "creative_apply_plan",
    description:
      "Apply a routed EditPlan to an INGESTED video — execute its ops (ripple-trim dead air, razor/J-L cuts, reorder/remove clips, subtitle, grade, mix, select-highlight/montage) through the real timeline machinery, then compile, then (if render=true) re-render the final hybrid mp4. Pass planId to apply a specific plan, or omit it to apply the NEWEST plan for the run (built by creative_edit_route). Fail-open per op (a bad op is skipped + noted, never aborts the plan). With render=true it detaches and returns a job (pid+log); without render it applies inline and returns what changed.",
    kind: "long",
    schema: z
      .object({
        id: idArg,
        planId: z.string().min(1).optional().describe("the EditPlan id to apply; omit to use the newest plan for the run"),
        render: z.boolean().default(false).describe("re-render the final hybrid mp4 after applying (detaches as a job)"),
        review: z.boolean().default(false).describe("self-review the result for a ship/revise/reject verdict (needs a render)"),
        preview: z.boolean().default(false).describe("quick/preview render quality"),
      })
      .strict(),
    run: ({ id, planId, render, review, preview }) => {
      if (render) {
        // Long path: hand the apply+render to the detached worker (spawn contract).
        const args = [id];
        if (planId) args.push("--plan", planId);
        if (preview) args.push("--preview");
        if (review) args.push("--review");
        const job = spawnEngine("apply-plan-run.ts", args, "tool-apply-plan.log");
        return ok({ status: "started", ...job, id, planId }, "apply + render started");
      }
      // Inline path: apply the ops + compile, no render. asyncResult awaits it.
      return asyncResult(
        executeEditPlanById(id, planId, { review, preview }).then((r) =>
          ok(r, `applied ${r.applied.length} step(s)${r.review ? ` — review: ${r.review.verdict}` : ""}`),
        ),
      );
    },
  }),
  tool({
    // Pillar 5 N5.1: a convenience wrapper over autoSubtitle (N4) — burn captions
    // from the run's transcript onto the caption track + set mix.subtitles.source.
    name: "creative_subtitle",
    description:
      "Auto-subtitle an INGESTED video: build a caption track from the run's transcript (word-grouped lines) and switch the render to read it (mix.subtitles.source='track'). Optionally pick a caption preset (pop/bounce/phrase/hormozi/glow). The one-step 'subtitle it' for an ingested run — needs an understanding/transcript first (editor_understand).",
    kind: "mutate",
    schema: z
      .object({
        id: idArg,
        preset: z.enum(["pop", "bounce", "phrase", "hormozi", "glow"]).optional().describe("caption style preset to apply to mix.subtitles"),
      })
      .strict(),
    run: ({ id, preset }) => {
      const r = autoSubtitle(id);
      if (preset) {
        // honour the requested preset on mix.subtitles (enabled + preset).
        const item = loadItem(id);
        item.mix = { ...(item.mix ?? {}), subtitles: { ...(item.mix?.subtitles ?? {}), enabled: true, preset } };
        item.updatedAt = nowIso();
        saveItem(item);
      }
      return ok({ id, captionClips: r.captionClips, preset }, `subtitled — ${r.captionClips} caption clip(s)${preset ? ` [${preset}]` : ""}`);
    },
  }),
  tool({
    // Pillar 5 N5.1: the ONE-SHOT chat entry. routeEditRequest (N5.0) → executeEditPlan
    // (N5.1) in a single call: "edit this video: <request>". "long" because it can
    // render; without render it routes+applies inline.
    name: "creative_edit",
    description:
      "One-shot 'edit this video: <request>' on an INGESTED run — routes the plain-language request into a grounded EditPlan (citing real dead-air spans / highlights / clip ids) AND applies it through the real machinery in a single call. e.g. 'cut the dead air and subtitle it', 'make a punchy 20s teaser', 'grade it warm and duck the music'. With render=true it detaches and re-renders the final mp4 (returns a job); without render it routes+applies inline and returns the plan + what changed. Odysser-style chat editing.",
    kind: "long",
    schema: z
      .object({
        id: idArg,
        request: z.string().min(1).describe("the plain-language edit ask, e.g. 'cut the dead air and subtitle it'"),
        render: z.boolean().default(false).describe("re-render the final hybrid mp4 after applying (detaches as a job)"),
        review: z.boolean().default(false).describe("self-review the result for a verdict (needs a render)"),
        preview: z.boolean().default(false).describe("quick/preview render quality"),
      })
      .strict(),
    run: ({ id, request, render, review, preview }) => {
      if (render) {
        // Long path: route + apply + render in the detached worker.
        const args = [id, "--request", request];
        if (preview) args.push("--preview");
        if (review) args.push("--review");
        const job = spawnEngine("apply-plan-run.ts", args, "tool-creative-edit.log");
        return ok({ status: "started", ...job, id, request }, "edit (route + apply + render) started");
      }
      // Inline path: route then apply, no render.
      return asyncResult(
        routeEditRequest(id, request)
          .then((plan) => executeEditPlan(id, plan, { review, preview }).then((r) => ({ plan, r })))
          .then(({ plan, r }) =>
            ok({ plan, ...r }, `routed "${request}" → ${plan.ops.length} op(s); applied ${r.applied.length} step(s)`),
          ),
      );
    },
  }),
];
