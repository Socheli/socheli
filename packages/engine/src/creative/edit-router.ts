/**
 * edit-router.ts — Pillar 5 N5.0: the chat→edit ROUTER.
 *
 * `routeEditRequest` turns a plain-language ask ("cut the dead air", "subtitle
 * it", "make a 20s teaser") into a grounded `EditPlan` — a list of `EditOp`s
 * that each map 1:1 to a real timeline-edit tool / craft pass / bridge mapper.
 *
 * This is ANALYSIS ONLY. It never mutates the run, never applies an op, never
 * renders — apply-plan.ts (N5.1) is the executor. The router's whole job is to
 * map intent → ops grounded in REAL evidence:
 *   - item.understanding (transcript / shots / deadAir / filler / highlights),
 *     digested via understandingSummary()
 *   - editSignals(id) → signalsSummary() (the render-evidence + per-scene model)
 *   - timelineView(id) (the real clip ids a trim/razor/slip/reorder addresses)
 * The model is told to CITE that evidence on each op (`evidence` string) and to
 * only name clip ids that actually exist on the timeline view.
 *
 * FAIL-OPEN (the house rule for the whole pillar): if the brain call throws or
 * returns nothing usable, we fall back to a deterministic HEURISTIC plan derived
 * straight from the understanding (dead-air → ripple_trims over the clips those
 * spans overlap; "subtitle" intent → a single subtitle op; a "highlight/teaser"
 * intent → a select_highlight). A degraded plan still beats no plan, and the
 * apply step is itself locked-safe/clamped — so a wrong op can't corrupt a run.
 *
 * Persistence: the plan is a flat JSON artifact at data/edit-plans/<id>.json
 * (atomic tmp+rename, exactly like missions.ts), NOT a field on the ContentItem.
 * The plan id is derived from the run id + a timestamp so plans are append-only
 * and a run can carry a history of proposals.
 */

import { existsSync, readFileSync, writeFileSync, renameSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { z } from "zod";
import { EditPlan, EditOp, MontageSpec } from "@os/schemas";

import { think } from "../brain.ts";
import { loadItem, DATA_DIR, ensureDir, nowIso } from "../store.ts";
import { tasteContext } from "./taste.ts"; // N5.4: start the plan from the operator's learned footage taste
import { understandingSummary } from "../understanding.ts";
import { editSignals, signalsSummary } from "./signals.ts";
import { timelineView, type TimelineView } from "./timeline.ts";

// ---------------------------------------------------------------------------
// Persistence — data/edit-plans/<id>.json (flat, atomic, append-only).
// ---------------------------------------------------------------------------

export const EDIT_PLANS_DIR = join(DATA_DIR, "edit-plans");

function planPath(id: string): string {
  return join(EDIT_PLANS_DIR, `${id}.json`);
}

/* Atomic write: tmp + rename so a crash mid-write never leaves a half-plan.
   We re-parse through EditPlan so what lands on disk is always schema-valid. */
function saveEditPlan(plan: EditPlan): EditPlan {
  ensureDir(EDIT_PLANS_DIR);
  const valid = EditPlan.parse(plan);
  const dest = planPath(valid.id);
  const tmp = `${dest}.tmp`;
  writeFileSync(tmp, JSON.stringify(valid, null, 2));
  renameSync(tmp, dest);
  return valid;
}

/** Load a persisted plan by id (N5.3 get/approve/reject read this). */
export function loadEditPlan(id: string): EditPlan {
  return EditPlan.parse(JSON.parse(readFileSync(planPath(id), "utf8")));
}

/** All plans for a run, newest first (the router appends, never overwrites). */
export function listEditPlans(runId: string): EditPlan[] {
  ensureDir(EDIT_PLANS_DIR);
  const plans: EditPlan[] = [];
  for (const f of readdirSync(EDIT_PLANS_DIR)) {
    if (!f.endsWith(".json")) continue;
    try {
      const p = EditPlan.parse(JSON.parse(readFileSync(join(EDIT_PLANS_DIR, f), "utf8")));
      if (p.runId === runId) plans.push(p);
    } catch {
      // skip a corrupt/partial plan rather than fail the whole listing
    }
  }
  return plans.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

// ---------------------------------------------------------------------------
// Router.
// ---------------------------------------------------------------------------

export type RouteOpts = {
  /** guided (human-gated) by default; autonomous plans apply without a gate (N5.3). */
  mode?: "guided" | "autonomous";
};

/* A permissive parse schema for the brain output. We accept a partial shape and
   re-stamp the trustworthy fields (id/runId/request/createdAt/status) ourselves
   so a model that omits/mangles them still yields a valid EditPlan. ops/montage
   are parsed against the real schemas so a malformed op is dropped, not trusted. */
const RoutedPlan = z.object({
  ops: z.array(EditOp).default([]),
  rationale: z.string().default(""),
  evidenceRefs: z.array(z.string()).default([]),
  montage: MontageSpec.optional(),
  mode: z.enum(["guided", "autonomous"]).optional(),
});

/**
 * Route a plain-language edit request on an INGESTED run into a grounded,
 * analysis-only EditPlan. Loads the run's understanding + edit signals + the
 * real timeline view, asks the brain to map intent→ops citing that evidence,
 * persists the plan, and returns it. Never throws — falls open to a heuristic
 * plan if the brain call fails.
 */
export async function routeEditRequest(id: string, request: string, opts?: RouteOpts): Promise<EditPlan> {
  const item = loadItem(id);
  const mode = opts?.mode ?? "guided";
  const planId = `${id}_plan_${nowIso().replace(/[-:TZ.]/g, "").slice(0, 14)}`;

  // ── Gather grounding evidence (all fail-open) ──
  const uSummary = item.understanding ? understandingSummary(item.understanding) : "";
  let sSummary = "";
  try {
    sSummary = signalsSummary(await editSignals(id));
  } catch {
    // signals lean on render evidence which an ingested run may not have yet —
    // not having them is fine, the understanding carries the editorial model.
  }
  const view = timelineView(id);
  const tlSummary = timelineSummary(view);

  // ── Ask the brain to map intent → ops, citing the real evidence ──
  try {
    const taste = (() => { try { return tasteContext(item.channel); } catch { return ""; } })();
    const prompt = buildPrompt(request, uSummary, sSummary, tlSummary, taste);
    const { data } = await think(RoutedPlan, prompt, "smart", 2, "edit_route");
    const plan: EditPlan = {
      id: planId,
      runId: id,
      request,
      mode: data.mode ?? mode,
      ops: data.ops,
      rationale: data.rationale || `Routed "${request}" into ${data.ops.length} op(s).`,
      evidenceRefs: data.evidenceRefs,
      montage: data.montage,
      status: "proposed",
      createdAt: nowIso(),
    };
    // A model that returned zero grounded ops is no better than the heuristic —
    // fall through to it rather than persisting an empty plan.
    if (plan.ops.length || plan.montage) return saveEditPlan(plan);
  } catch {
    // fall through to the heuristic
  }

  return saveEditPlan(heuristicPlan(planId, id, request, mode, item.understanding, view));
}

// ---------------------------------------------------------------------------
// Prompt — hand the brain the three grounding digests + a precise op contract.
// ---------------------------------------------------------------------------

function buildPrompt(request: string, uSummary: string, sSummary: string, tlSummary: string, taste = ""): string {
  return [
    "You are the EDIT ROUTER for a faceless-video editor. Turn the user's plain-language",
    "request into a grounded EDIT PLAN: a list of edit operations over an ALREADY-INGESTED",
    "video. You do NOT apply anything — you only plan. Map the intent to operations 1:1 with",
    "the real tools below, and CITE the real evidence each operation acts on.",
    "",
    `USER REQUEST: "${request}"`,
    "",
    uSummary ? `=== UNDERSTANDING (transcript / shots / dead air / filler / highlights) ===\n${uSummary}` : "(no understanding built yet)",
    "",
    sSummary ? `=== EDIT SIGNALS (per-scene pacing + render evidence) ===\n${sSummary}` : "",
    "",
    `=== TIMELINE (the REAL clip ids you may reference) ===\n${tlSummary}`,
    "",
    taste ? `=== LEARNED EDITING TASTE (default to these unless the request overrides) ===\n${taste}` : "",
    "",
    "OPERATION KINDS (use ONLY these; each maps to a real tool):",
    "- ripple_trim {clipId, edge:'in'|'out', deltaSec, evidence?} — grow/shrink a clip edge; use a NEGATIVE deltaSec to REMOVE dead air/filler. clipId MUST be a real timeline clip id.",
    "- razor {clipId, atSec, evidence?} — split a clip at a timeline second.",
    "- jl_cut {clipId, leadSec, evidence?} — lead (+) / lag (-) audio under picture (J/L cut). clipId is the AUDIO clip.",
    "- slip {clipId, deltaSec, evidence?} — shift a source-backed clip's in/out window (broll/voice ONLY).",
    "- slide {clipId, deltaSec, evidence?} — move a clip in time, rippling neighbours.",
    "- insert_broll {atSec, durationSec?, query?, src?, evidence?} — drop an overlay at a timeline second.",
    "- remove_clip {clipId, evidence?} — delete a clip.",
    "- reorder {order:[clipId,...], evidence?} — the new clip sequence (real ids).",
    "- subtitle {preset?, evidence?} — burn auto-captions from the transcript.",
    "- grade {scope:'scene'|'global', sceneIndex?, grade?, intent?, evidence?} — colour. Use `intent` (free text) unless you have a structured grade.",
    "- mix {intent, evidence?} — audio mix (free-text intent).",
    "- select_highlight {topN?, maxSec?, evidence?} — keep only the strongest moments (cite understanding highlights).",
    "",
    "RULES:",
    "- 'cut/remove dead air' → ripple_trim ops with NEGATIVE deltaSec over the clips that overlap the DEAD AIR spans; cite each span (e.g. evidence:'dead air 12.4-13.9s').",
    "- 'subtitle it' / 'add captions' → a single subtitle op.",
    "- 'highlight reel' / 'teaser' / 'shorten to Ns' → set `montage` {targetSec?, style, maxClips?, orderBy?} AND/OR a select_highlight op citing real highlights.",
    "- 'tighten' / 'trim filler' → ripple_trims over filler hits.",
    "- Only reference clipIds that appear in the TIMELINE section. If an op has no real clip to act on, omit it.",
    "- Put every concrete reference you used (span/shot id/clip id) into the top-level evidenceRefs array.",
    "",
    "Return ONLY a JSON object: { ops:[...], rationale, evidenceRefs:[...], montage? }.",
  ]
    .filter(Boolean)
    .join("\n");
}

/* Compact timeline digest the brain reasons over — real clip ids + their
   placement/source so it can pick valid targets for trims/reorders. Caps the
   list so the prompt stays small on a long cut. */
function timelineSummary(view: TimelineView): string {
  const lines: string[] = [`TIMELINE — ${round2(view.totalSec)}s @ ${view.fps}fps, ${view.tracks.length} track(s)${view.derived ? " (derived, pre-build)" : ""}`];
  for (const t of view.tracks) {
    if (!t.clips.length) continue;
    lines.push(`  track ${t.id} [${t.kind}${t.name ? ` "${t.name}"` : ""}]:`);
    for (const c of t.clips.slice(0, 20)) {
      const src = c.src ? ` src=${shortSrc(c.src)}` : c.sceneRef ? ` scene=${c.sceneRef}` : "";
      const lock = c.locked ? " LOCKED" : "";
      lines.push(`    ${c.id} ${round2(c.startSec)}-${round2(c.endSec)}s${src}${lock}`);
    }
    if (t.clips.length > 20) lines.push(`    … +${t.clips.length - 20} more`);
  }
  return lines.join("\n");
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const shortSrc = (s: string) => (s.length > 40 ? `…${s.slice(-37)}` : s);

// ---------------------------------------------------------------------------
// Heuristic fallback — deterministic, evidence-grounded, no brain.
// ---------------------------------------------------------------------------

/* The minimal grounded plan we can build without the model, driven entirely by
   the understanding + a keyword read of the request. Conservative: it only
   emits ops it can tie to real evidence (a dead-air span over a real clip, a
   highlight). Mirrors the brain's contract so apply-plan treats both identically. */
function heuristicPlan(
  planId: string,
  runId: string,
  request: string,
  mode: "guided" | "autonomous",
  understanding: ReturnType<typeof loadItem>["understanding"],
  view: TimelineView,
): EditPlan {
  const ask = request.toLowerCase();
  const ops: EditOp[] = [];
  const refs: string[] = [];
  const why: string[] = [];

  const wantsSubtitle = /subtitle|caption|cc\b|text on screen/.test(ask);
  const wantsDeadAir = /dead ?air|silence|pause|trim|tighten|cut the/.test(ask);
  const wantsHighlight = /highlight|teaser|reel|supercut|shorten|best (bits|moments)|condense/.test(ask);

  // Real video clips (source-backed picture spine) we can address for trims.
  const videoClips = view.tracks
    .filter((t) => t.kind === "video")
    .flatMap((t) => t.clips)
    .filter((c) => !c.locked);

  if (wantsSubtitle) {
    ops.push({ kind: "subtitle" });
    why.push("burn captions from the transcript");
  }

  if (wantsDeadAir && understanding?.deadAir?.length) {
    // Map each dead-air span to the video clip whose timeline window overlaps it,
    // and propose a negative ripple on the trailing edge to remove the silence.
    for (const span of understanding.deadAir.slice(0, 12)) {
      const hit = videoClips.find((c) => c.startSec <= span.endSec && c.endSec >= span.startSec);
      if (!hit) continue;
      const delta = -round2(Math.max(0.1, span.endSec - span.startSec));
      ops.push({ kind: "ripple_trim", clipId: hit.id, edge: "out", deltaSec: delta, evidence: `dead air ${round2(span.startSec)}-${round2(span.endSec)}s` });
      refs.push(`deadAir:${round2(span.startSec)}-${round2(span.endSec)}s`);
    }
    if (ops.some((o) => o.kind === "ripple_trim")) why.push(`ripple out ${understanding.deadAir.length} dead-air span(s)`);
  }

  if (wantsHighlight) {
    const n = understanding?.highlights?.length ?? 0;
    // Prefer a select_highlight grounded in the understanding's scored highlights;
    // attach a montage spec so the N5.2 compiler can recompose if asked to.
    const targetSec = parseTargetSec(ask);
    ops.push({ kind: "select_highlight", ...(targetSec ? { maxSec: targetSec } : { topN: Math.min(Math.max(3, Math.round(n / 2) || 3), n || 5) }) });
    why.push(`keep the strongest ${n || "few"} moment(s)`);
    if (n) refs.push(...understanding!.highlights.slice(0, 5).map((h) => `highlight:${round2(h.startSec)}-${round2(h.endSec)}s`));
    return {
      id: planId,
      runId,
      request,
      mode,
      ops,
      rationale: `Heuristic: ${why.join("; ")}.`,
      evidenceRefs: refs,
      montage: { style: /teaser/.test(ask) ? "teaser" : "highlight_reel", ...(targetSec ? { targetSec } : {}), orderBy: "narrative" },
      status: "proposed",
      createdAt: nowIso(),
    };
  }

  // Nothing matched a known intent → an empty-but-valid plan with a note, so the
  // caller sees an explicit "couldn't ground this" rather than a thrown error.
  return {
    id: planId,
    runId,
    request,
    mode,
    ops,
    rationale: ops.length ? `Heuristic: ${why.join("; ")}.` : `Heuristic: no grounded operation matched "${request}".`,
    evidenceRefs: refs,
    status: "proposed",
    createdAt: nowIso(),
  };
}

/* Pull a target length out of phrases like "30s", "20 sec", "make it 1 minute". */
function parseTargetSec(ask: string): number | undefined {
  const m = ask.match(/(\d+(?:\.\d+)?)\s*(s\b|sec|second)/);
  if (m) return round2(parseFloat(m[1]));
  const min = ask.match(/(\d+(?:\.\d+)?)\s*(m\b|min|minute)/);
  if (min) return round2(parseFloat(min[1]) * 60);
  return undefined;
}
