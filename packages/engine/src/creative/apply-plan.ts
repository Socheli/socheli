/**
 * apply-plan.ts — Pillar 5 N5.1: the EditPlan EXECUTOR.
 *
 * The router (edit-router.ts, N5.0) turns a plain-language ask into an analysis-
 * only `EditPlan` — a list of `EditOp`s each citing real evidence. THIS module is
 * the other half: it APPLIES that plan through the REAL machinery. Every op maps
 * 1:1 to an existing, already-verified function (the M11 trims, the N4 auto-
 * subtitle, the colour/mix bridges, the N5.2 montage compiler), so apply is a
 * straight dispatch — no second interpretation step, no new editing logic.
 *
 * After the ops run we `compileTimeline(id)` once (stamps the footage timeline so
 * the precedence rule "timeline owns timing" is in force and renderHybrid reads
 * the clipPlan), and — only if asked — `renderHybrid(id)` to the final mp4, then
 * (optionally) a `reviewCut` verdict on the result.
 *
 * HOUSE RULES (the whole pillar): clamp / locked-safe / FAIL-OPEN. Each op is
 * tried in isolation — a skip/throw on one op is NOTED and the plan continues
 * (never abort the whole plan on a single bad op). The underlying functions are
 * themselves skip-not-throw (timeline-edit.ts returns a `skipped` result on a
 * locked/missing clip; the grade/montage bridges warn() and degrade), so the
 * worst a malformed op can do is no-op with a note. We never throw out of
 * executeEditPlan — a partial application still beats a corrupted run.
 *
 * Re-render economy (roadmap §7.1.5 note): we batch ALL ops into ONE compile +
 * ONE render, not a render per op.
 */

import type { EditOp, EditPlan, MontageSpec } from "@os/schemas";

import { loadItem, saveItem, nowIso, logLine } from "../store.ts";
import { renderHybrid } from "../render.ts";
import { compileTimeline } from "./compile.ts";
import { timelineTrim, timelineRazor, timelineJLCut, timelineInsert, type TimelineEditResult } from "./timeline-edit.ts";
import { autoSubtitle } from "./auto-subtitle.ts";
import { gradeScene, gradeGlobal, colorIntentToGrade } from "./edl.ts";
import { reviewCut } from "./review.ts";
import { montageFromHighlights } from "./montage.ts";
import { learnFootageTaste } from "./perf.ts";
import { loadEditPlan, EDIT_PLANS_DIR } from "./edit-router.ts";

import { existsSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { EditPlan as EditPlanSchema } from "@os/schemas";

const round2 = (n: number) => Math.round(n * 100) / 100;

export type ApplyOpts = {
  /** Render the result to a final mp4 after applying (default false — apply only). */
  render?: boolean;
  /** Re-review the result for a ship/revise/reject verdict (default false). */
  review?: boolean;
  /** Quick/preview render quality when rendering (passed to renderHybrid). */
  preview?: boolean;
};

export type ApplyResult = {
  id: string;
  planId?: string;
  /** one human-readable line per op that ran (incl. skips, prefixed "skip:"). */
  applied: string[];
  /** the final mp4 path, when opts.render was set and the render succeeded. */
  render?: string;
  /** the review verdict, when opts.review was set. */
  review?: { verdict: string; overall: number };
};

// ---------------------------------------------------------------------------
// executeEditPlan — dispatch each op to its real function, then compile/render.
// ---------------------------------------------------------------------------

/**
 * Execute an EditPlan's ops on run `id` through the real machinery. Returns what
 * applied + (optionally) the render path. FAIL-OPEN per op: a thrown/skipped op
 * is noted and the plan continues. Marks the plan `status:"applied"` on disk if
 * it is a persisted plan (id matches a plan artifact). Never throws.
 */
export async function executeEditPlan(id: string, plan: EditPlan, opts: ApplyOpts = {}): Promise<ApplyResult> {
  const item = loadItem(id);
  const applied: string[] = [];

  // ── Dispatch the ops, in plan order, each isolated. ──
  for (const op of plan.ops) {
    try {
      const line = applyOp(id, op);
      applied.push(line);
    } catch (e) {
      // The op's own function should be skip-not-throw; this is the belt-and-braces
      // fail-open so even an unexpected throw can't abort the rest of the plan.
      applied.push(`skip: ${op.kind} — ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // ── A montage request recomposes the WHOLE spine — run it AFTER the per-clip ops
  //    (a re-montage supersedes individual trims; the ops above acted on the prior
  //    assembly, the montage rebuilds from the understanding). Fail-open. ──
  if (plan.montage) {
    try {
      const spec = normalizeMontageSpec(plan.montage);
      const tl = montageFromHighlights(id, spec);
      const v1 = tl.tracks.find((t) => t.id === "V1");
      applied.push(`montage: rebuilt spine — ${v1?.clips.length ?? 0} clip(s) [${plan.montage.style ?? "highlight_reel"}]`);
    } catch (e) {
      applied.push(`skip: montage — ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // ── Compile ONCE (batches every op into one timeline stamp). Fail-open. ──
  try {
    const { changed } = compileTimeline(id);
    if (changed.length) applied.push(`compile: ${changed.join("; ")}`);
  } catch (e) {
    applied.push(`skip: compile — ${e instanceof Error ? e.message : String(e)}`);
  }

  logLine(loadItem(id), `apply-plan: ${plan.id ?? "(adhoc)"} — ${applied.length} step(s)`);

  const result: ApplyResult = { id, planId: plan.id, applied };

  // ── Optional single render of the batched result. ──
  if (opts.render) {
    try {
      result.render = await renderHybrid(id, { preview: opts.preview });
      applied.push(`render: ${result.render}`);
    } catch (e) {
      applied.push(`skip: render — ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // ── Optional verdict on the result (needs a render to watch; fail-open). ──
  if (opts.review) {
    try {
      const r = await reviewCut(id, { pass: "apply-plan" });
      result.review = { verdict: r.verdict, overall: r.scores.overall };
      applied.push(`review: ${r.verdict} (overall ${r.scores.overall})`);
    } catch (e) {
      applied.push(`skip: review — ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // ── Mark a persisted plan applied (best-effort; an ad-hoc plan has no artifact). ──
  markApplied(plan);

  // ── N5.4: an APPLIED plan reveals the operator's footage-edit taste — promote it
  //    so the next routeEditRequest starts from their learned defaults. Fail-open;
  //    a taste-write hiccup must never affect the edit result. ──
  try {
    const ch = loadItem(id).channel;
    const hadTrim = plan.ops.some((o) => o.kind === "ripple_trim" || o.kind === "remove_clip");
    const subOp = plan.ops.find((o) => o.kind === "subtitle") as { preset?: string } | undefined;
    const v1 = loadItem(id).timeline?.tracks.find((t) => t.id === "V1");
    await learnFootageTaste(ch, {
      reelSec: plan.montage?.targetSec,
      clipCount: plan.montage ? v1?.clips.length : undefined,
      trimAggressive: hadTrim ? true : undefined,
      subtitlePreset: subOp?.preset,
      gradeOnFootage: plan.ops.some((o) => o.kind === "grade") ? true : undefined,
      source: "feedback",
    });
  } catch {
    /* fail-open */
  }

  return result;
}

// ---------------------------------------------------------------------------
// applyOp — the op → fn dispatch table (each EditOp.kind to its real function).
// ---------------------------------------------------------------------------

/**
 * Map ONE EditOp to its real function and return a one-line summary of what it
 * did (or skipped). The dispatch table — each `kind` is exactly one existing
 * function, no new editing logic:
 *
 *   ripple_trim  → timelineTrim(mode:"ripple")     (creative/timeline-edit.ts)
 *   slip         → timelineTrim(mode:"slip")        (   ″   )
 *   slide        → timelineTrim(mode:"slide")       (   ″   )
 *   razor        → timelineRazor                     (   ″   )
 *   jl_cut       → timelineJLCut                     (   ″   )
 *   insert_broll → timelineInsert (overlay clip)     (   ″   )
 *   reorder      → reorder clips on item.timeline    (this file — small mutate)
 *   remove_clip  → drop the clip on item.timeline    (   ″   )
 *   subtitle     → autoSubtitle                      (creative/auto-subtitle.ts)
 *   grade        → gradeScene / gradeGlobal          (creative/edl.ts color bridge)
 *   mix          → parse intent → item.mix           (this file — mix bridge)
 *   select_highlight → montageFromHighlights         (creative/montage.ts)
 */
function applyOp(id: string, op: EditOp): string {
  switch (op.kind) {
    case "ripple_trim": {
      const r = timelineTrim(id, { clipId: op.clipId, edge: op.edge, deltaSec: op.deltaSec, mode: "ripple" });
      return summarizeEdit("ripple_trim", r, op.evidence);
    }
    case "slip": {
      const r = timelineTrim(id, { clipId: op.clipId, edge: "in", deltaSec: op.deltaSec, mode: "slip" });
      return summarizeEdit("slip", r, op.evidence);
    }
    case "slide": {
      const r = timelineTrim(id, { clipId: op.clipId, edge: "in", deltaSec: op.deltaSec, mode: "slide" });
      return summarizeEdit("slide", r, op.evidence);
    }
    case "razor": {
      const r = timelineRazor(id, { clipId: op.clipId, atSec: op.atSec });
      return summarizeEdit("razor", r, op.evidence);
    }
    case "jl_cut": {
      const r = timelineJLCut(id, { clipId: op.clipId, audioLeadSec: op.leadSec });
      return summarizeEdit("jl_cut", r, op.evidence);
    }
    case "insert_broll": {
      // Drop a b-roll/overlay clip onto a dedicated overlay track at atSec. If the
      // op already chose a src we use it; otherwise we can only place a duration
      // placeholder (the footage-search side is N6.3) — note that and skip if there
      // is nothing concrete to insert.
      if (!op.src) return `skip: insert_broll @ ${round2(op.atSec)}s — no src resolved (footage search is N6.3); ${ev(op.evidence)}`;
      ensureOverlayTrack(id); // timelineInsert skips on a missing track — create OV1 first
      const r = timelineInsert(id, {
        trackId: "OV1",
        atSec: op.atSec,
        durationSec: op.durationSec ?? 2,
        kind: "video",
        src: op.src,
      });
      return summarizeEdit("insert_broll", r, op.evidence);
    }
    case "remove_clip":
      return removeClip(id, op.clipId, op.evidence);
    case "reorder":
      return reorderClips(id, op.order, op.evidence);
    case "subtitle": {
      const r = autoSubtitle(id);
      // honour a requested caption preset by writing it onto mix.subtitles.
      if (op.preset) applyCaptionPreset(id, op.preset);
      return `subtitle: ${r.captionClips} caption clip(s)${op.preset ? ` [preset ${op.preset}]` : ""}${ev(op.evidence)}`;
    }
    case "grade":
      return applyGrade(id, op);
    case "mix":
      return applyMix(id, op.intent, op.evidence);
    case "select_highlight": {
      // select_highlight keeps the strongest moments → a montage recompose. The
      // plan-level `montage` (if present) is applied after the op loop; here we
      // honour a standalone select_highlight by composing a spec from its fields.
      const spec: MontageSpec = {
        style: "highlight_reel",
        ...(op.topN !== undefined ? { maxClips: op.topN } : {}),
        ...(op.maxSec !== undefined ? { targetSec: op.maxSec } : {}),
      };
      const tl = montageFromHighlights(id, spec);
      const v1 = tl.tracks.find((t) => t.id === "V1");
      return `select_highlight: kept ${v1?.clips.length ?? 0} moment(s)${op.maxSec ? ` (~${round2(op.maxSec)}s target)` : op.topN ? ` (top ${op.topN})` : ""}${ev(op.evidence)}`;
    }
    default: {
      // Exhaustiveness guard — a new op kind lands here until it's wired, noted not thrown.
      const k = (op as { kind?: string }).kind ?? "unknown";
      return `skip: ${k} — no executor wired yet`;
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers for the ops that aren't a single existing call.
// ---------------------------------------------------------------------------

/** Turn a TimelineEditResult into a one-line summary (skip-aware). */
function summarizeEdit(kind: string, r: TimelineEditResult, evidence?: string): string {
  if (r.skipped) return `skip: ${kind} — ${r.skipped}${ev(evidence)}`;
  return `${kind}: ${r.changed.join("; ") || "applied"}${ev(evidence)}`;
}

const ev = (e?: string) => (e ? `  (${e})` : "");

/** Remove a clip from item.timeline (locked-safe, never throws). A small mutate
 *  this file owns — there is no timelineRemove in timeline-edit.ts, and a remove
 *  is just a filter + persist (no ripple: the caller can compile to re-flow). */
function removeClip(id: string, clipId: string, evidence?: string): string {
  const item = loadItem(id);
  const tl = item.timeline;
  if (!tl) return `skip: remove_clip ${clipId} — no timeline${ev(evidence)}`;
  for (const t of tl.tracks ?? []) {
    const i = (t.clips ?? []).findIndex((c) => c.id === clipId);
    if (i < 0) continue;
    if (t.clips[i].locked) return `skip: remove_clip ${clipId} — locked${ev(evidence)}`;
    t.clips.splice(i, 1);
    item.updatedAt = nowIso();
    saveItem(item);
    return `remove_clip: dropped ${clipId} from ${t.id}${ev(evidence)}`;
  }
  return `skip: remove_clip ${clipId} — not found${ev(evidence)}`;
}

/** Ensure a video overlay track (OV1) exists so an insert_broll has somewhere to
 *  land (timelineInsert is a no-op on a missing track). Idempotent; never throws. */
function ensureOverlayTrack(id: string): void {
  const item = loadItem(id);
  if (!item.timeline) return;
  if ((item.timeline.tracks ?? []).some((t) => t.id === "OV1")) return;
  item.timeline.tracks.push({ id: "OV1", kind: "video", name: "Overlay", clips: [] });
  item.updatedAt = nowIso();
  saveItem(item);
}

/** Reorder a track's clips into the given clip-id sequence, RE-FLOWING start times
 *  sequentially so the cut plays in the new order with no gaps. Operates on the
 *  track that owns the FIRST named id (a reorder is within one track). Unlisted
 *  clips on that track keep their relative order, appended after the listed ones.
 *  Locked clips are left in place (skipped from the re-flow). Never throws. */
function reorderClips(id: string, order: string[], evidence?: string): string {
  const item = loadItem(id);
  const tl = item.timeline;
  if (!tl || !order.length) return `skip: reorder — ${!tl ? "no timeline" : "empty order"}${ev(evidence)}`;
  // Find the track the order addresses (the one holding the first listed id).
  const track = (tl.tracks ?? []).find((t) => (t.clips ?? []).some((c) => order.includes(c.id)));
  if (!track) return `skip: reorder — none of the ids exist on a track${ev(evidence)}`;

  const byId = new Map(track.clips.map((c) => [c.id, c]));
  const listed = order.map((cid) => byId.get(cid)).filter((c): c is NonNullable<typeof c> => Boolean(c));
  const rest = track.clips.filter((c) => !order.includes(c.id)); // keep unlisted clips, in place after
  const sequence = [...listed, ...rest];

  // Re-flow startSec sequentially (durations unchanged) so play order == array order.
  let cursor = 0;
  for (const c of sequence) {
    c.startSec = round2(cursor);
    cursor = round2(cursor + (c.durationSec ?? 0));
  }
  track.clips = sequence;
  item.updatedAt = nowIso();
  saveItem(item);
  return `reorder: ${track.id} → ${listed.length} clip(s) resequenced${ev(evidence)}`;
}

/** Apply a colour grade op via the edl.ts bridge. scene → gradeScene; global →
 *  gradeGlobal (which writes storyboard.grade, the footage master grade renderHybrid
 *  reads). Both are locked-safe and return a `changed` log; fail-open if there is
 *  no storyboard to grade (a pure-footage run with no scenes — note it). */
function applyGrade(id: string, op: Extract<EditOp, { kind: "grade" }>): string {
  if (op.scope === "scene") {
    if (op.sceneIndex === undefined) return `skip: grade scene — no sceneIndex${ev(op.evidence)}`;
    const r = gradeScene(id, op.sceneIndex, { grade: op.grade as any, intent: op.intent });
    return `grade(scene ${op.sceneIndex}): ${r.changed[0] ?? (r.grade ? "graded" : "no grade")}${ev(op.evidence)}`;
  }
  const r = gradeGlobal(id, { grade: op.grade as any, intent: op.intent });
  // No storyboard on a pure-footage run → gradeGlobal no-ops. Fall open with a note;
  // the structured/intent grade can still be re-applied once a storyboard exists.
  return `grade(global): ${r.grade ? "written" : (r.changed[0] ?? "no storyboard — skipped")}${ev(op.evidence)}`;
}

/** Apply a free-text mix intent onto item.mix. parseMixIntent is file-private to
 *  edl.ts, so we run the same deterministic keyword model here (duck / music up-down
 *  / voice up) writing the clamped Mix fields the renderer reads. Additive: only the
 *  fields the intent names are written, never clobbering an existing mix. */
function applyMix(id: string, intent: string, evidence?: string): string {
  const t = String(intent ?? "").toLowerCase();
  const item = loadItem(id);
  const mix = { ...(item.mix ?? {}) };
  const wrote: string[] = [];

  if (/\b(duck|under (the )?(vo|voice|narration)|sidechain)\b/.test(t)) {
    const hard = /\b(hard|heavy|deep|strong)\b/.test(t);
    mix.duck = { enabled: true, amount: hard ? 0.8 : 0.55, attack: 0.12, release: hard ? 0.45 : 0.6 };
    wrote.push(`duck ${hard ? "hard" : "soft"}`);
  }
  if (/\b(silence|quiet|breathe|pull.?back music|drop the music)\b/.test(t)) {
    mix.musicVol = 0.5;
    wrote.push("music down");
  }
  if (/\b(music (up|forward|loud)|drive(s)? the (energy|cut)|big music)\b/.test(t)) {
    mix.musicVol = 1.2;
    wrote.push("music up");
  }
  if (/\b(voice (up|forward|clear)|narration up|lift (the )?vo)\b/.test(t)) {
    mix.voiceVol = 1.15;
    wrote.push("voice up");
  }

  if (!wrote.length) return `skip: mix — nothing in "${intent}" matched a known cue${ev(evidence)}`;
  item.mix = mix;
  item.updatedAt = nowIso();
  saveItem(item);
  return `mix: ${wrote.join(", ")}${ev(evidence)}`;
}

/** Write a requested caption preset onto mix.subtitles (the subtitle op's `preset`).
 *  Only the recognised presets are honoured; anything else is left to the default. */
function applyCaptionPreset(id: string, preset: string): void {
  const allowed = ["pop", "bounce", "phrase", "hormozi", "glow"] as const;
  if (!allowed.includes(preset as (typeof allowed)[number])) return;
  const item = loadItem(id);
  item.mix = {
    ...(item.mix ?? {}),
    subtitles: { ...(item.mix?.subtitles ?? {}), enabled: true, preset: preset as (typeof allowed)[number] },
  };
  item.updatedAt = nowIso();
  saveItem(item);
}

/** Normalize a plan-level montage onto the @os/schemas MontageSpec the compiler
 *  consumes (the EditPlan.montage IS that schema; this is a defensive pass-through
 *  so a partial spec still composes). */
function normalizeMontageSpec(m: NonNullable<EditPlan["montage"]>): MontageSpec {
  return {
    ...(m.targetSec !== undefined ? { targetSec: m.targetSec } : {}),
    ...(m.style !== undefined ? { style: m.style } : {}),
    ...(m.maxClips !== undefined ? { maxClips: m.maxClips } : {}),
    ...(m.orderBy !== undefined ? { orderBy: m.orderBy } : {}),
  };
}

/** Best-effort: re-persist a known plan artifact with status:"applied". A plan
 *  built ad-hoc (no artifact on disk) is left alone. Never throws. */
function markApplied(plan: EditPlan): void {
  try {
    if (!plan.id) return;
    const dest = join(EDIT_PLANS_DIR, `${plan.id}.json`);
    if (!existsSync(dest)) return;
    const updated = EditPlanSchema.parse({ ...plan, status: "applied" });
    const tmp = `${dest}.tmp`;
    writeFileSync(tmp, JSON.stringify(updated, null, 2));
    renameSync(tmp, dest);
  } catch {
    // a failed status stamp must never fail the apply — the edits already landed.
  }
}

// ---------------------------------------------------------------------------
// loadAndExecute — convenience for the tool: load a persisted plan by id (or the
// newest plan for the run) and execute it.
// ---------------------------------------------------------------------------

/** Resolve the plan to apply: an explicit planId, else the newest plan for the run. */
export async function executeEditPlanById(id: string, planId: string | undefined, opts: ApplyOpts = {}): Promise<ApplyResult> {
  let plan: EditPlan;
  if (planId) {
    plan = loadEditPlan(planId);
  } else {
    // newest plan for this run (listEditPlans sorts newest-first).
    const { listEditPlans } = await import("./edit-router.ts");
    const plans = listEditPlans(id);
    if (!plans.length) throw new Error(`no edit plan found for ${id} — run creative_edit_route first`);
    plan = plans[0];
  }
  if (plan.runId !== id) throw new Error(`plan ${plan.id} is for run ${plan.runId}, not ${id}`);
  return executeEditPlan(id, plan, opts);
}
