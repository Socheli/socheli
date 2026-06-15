import type { CreativeReview, ReviewFix, TargetPlatform } from "@os/schemas";
import { loadItem, nowIso, logLine } from "../store.ts";
import { rerender } from "../rerender.ts";
import { inferBrief } from "./brief.ts";
import { generateConcepts, chooseConcept } from "./concepts.ts";
import { buildEdl, applyEdlToStoryboard } from "./edl.ts";
import { runPass, PASS_ORDER, type PassName } from "./passes.ts";
import { reviewCut } from "./review.ts";

/* creative/loop.ts — the full create → watch → critique → fix loop.

   This is the senior editor's ENTIRE workflow expressed as one call. Every
   sub-stage (brief → concepts → EDL → layered passes → render → self-review)
   already exists and persists onto the ContentItem; this module ORCHESTRATES
   them into the iterative judgement loop a human editor runs: make the cut,
   WATCH it, critique it honestly, then fix the worst problems and watch again —
   stopping when the cut earns a ship verdict, stops improving, or we hit the
   iteration/budget ceiling.

   Design contract:
   - Fail-open everywhere a render or evidence tool might be missing. The loop's
     value is that it keeps going on whatever artifact exists; a missing video
     means we review the EDL/storyboard on intent alone (reviewCut handles that).
   - Bound the work primarily by maxIterations; budgetUsd is a SOFT cap we honor
     loosely. We don't have a global usd meter here (the sub-calls own think()),
     so we treat budgetUsd as "stop starting new iterations once we'd plausibly
     have spent it" — conservatively, by capping iterations when the budget is
     very small. The hard stop is always maxIterations.
   - Persist throughout: every sub-call saves the item. We reload when we need
     the freshest state and never hold a stale item across an await. */

/* The refinement passes we re-run during a revision iteration. We do NOT re-run
   the full PASS_ORDER on every revision — that's expensive and risks undoing
   good work. Instead we re-run only the passes whose CONCERN the review's fixes
   point at, plus a final QA sweep that re-grades against fresh evidence. */
const FIX_PASS_BY_KEYWORD: { test: RegExp; pass: PassName }[] = [
  // Audio defects → the audio (mix) specialist.
  { test: /\b(audio|silence|silent|loud|hot|quiet|music|voice|narration|mix|duck|drown|level)\b/i, pass: "audio" },
  // Rhythm / length defects → the pacing specialist.
  { test: /\b(pacing|slow|drag|long|short|dead air|trim|tighten|lull|rush|rhythm|hold)\b/i, pass: "pacing" },
  // Caption / readability defects → the typography specialist.
  { test: /\b(read|legib|caption|subtitle|text|small|contrast|illegible|font|word)\b/i, pass: "typography" },
  // Join / freeze / transition defects → the emotion specialist (owns transitions).
  { test: /\b(transition|cut|freeze|frozen|jarring|abrupt|harsh|black frame|jump)\b/i, pass: "emotion" },
  // Footage / motion / visual-interest defects → the visual specialist.
  { test: /\b(b-?roll|footage|visual|motion|static|boring|empty|still)\b/i, pass: "visual" },
  // Grade / look defects → the color specialist.
  { test: /\b(color|colour|grade|palette|look|tone|mood|inconsistent)\b/i, pass: "color" },
];

/* Decide which passes to re-run for a revision, derived from the review's
   actionable (high+medium) fixes. We always include "qa" last so the iteration
   ends on a fresh, evidence-grounded self-review of what we just changed. Order
   is normalized to PASS_ORDER so passes still run in the editor's canonical
   sequence (e.g. pacing before audio before typography before color). */
function passesForReview(review: CreativeReview): PassName[] {
  const actionable = (review.fixes ?? []).filter((f) => f.severity === "high" || f.severity === "medium");
  const wanted = new Set<PassName>();
  for (const fix of actionable) {
    const text = `${fix.issue} ${fix.action}`;
    for (const { test, pass } of FIX_PASS_BY_KEYWORD) {
      if (test.test(text)) wanted.add(pass);
    }
  }
  // If the review flagged problems but none mapped to a concrete specialist (a
  // vague "overall weak"), fall back to the three highest-leverage passes so the
  // iteration still does meaningful work rather than only re-running QA.
  if (wanted.size === 0 && actionable.length) {
    wanted.add("pacing");
    wanted.add("audio");
    wanted.add("typography");
  }
  // Always re-grade at the end of the iteration.
  wanted.add("qa");
  return PASS_ORDER.filter((p) => wanted.has(p));
}

/* Render the cut to WATCH it, fail-open. The whole point of the loop is to judge
   a real artifact, but a render can fail (no media, encoder hiccup) — we log and
   continue so the review still runs on whatever exists (EDL/storyboard on
   intent, or the previous render still on disk). Returns whether a render
   actually happened, purely for the log. */
async function watchRender(id: string): Promise<boolean> {
  try {
    // Preview quality is enough to JUDGE pacing/readability/mix; broll on so the
    // visual decisions are actually visible to the reviewer's evidence tools.
    await rerender(id, { broll: true, preview: true });
    return true;
  } catch (e) {
    const item = loadItem(id);
    logLine(item, `creative loop: render failed (${e instanceof Error ? e.message : String(e)}); reviewing on existing artifact`);
    return false;
  }
}

export async function creativeEdit(
  id: string,
  opts?: {
    platform?: TargetPlatform;
    maxIterations?: number;
    budgetUsd?: number;
    render?: boolean;
    passes?: PassName[];
  },
): Promise<{ reviews: CreativeReview[]; iterations: number; finalVerdict: string }> {
  const maxIterations = Math.max(0, opts?.maxIterations ?? 2);
  const wantRender = opts?.render !== false;
  // Soft budget: a very small budget should curb how many revision iterations we
  // even attempt. We can't meter think() usd from here, so we approximate — each
  // revision iteration is the expensive unit (several passes + a render + a
  // grade). If the budget can't plausibly cover the initial build, cap revisions.
  const budgetUsd = opts?.budgetUsd;
  const budgetCapsIterations = budgetUsd != null && budgetUsd <= 0.25;

  // ── 1. Ensure a brief (the editorial yardstick everything else is graded on).
  let item = loadItem(id);
  if (!item.brief) {
    logLine(item, "creative loop: no brief — inferring editorial brief");
    await inferBrief(id, { platform: opts?.platform });
    item = loadItem(id);
  }

  // ── 2. Ensure a chosen creative concept (direction before cutting).
  if (!item.concepts || item.concepts.length === 0) {
    logLine(item, "creative loop: no concepts — exploring editorial directions");
    await generateConcepts(id);
    item = loadItem(id);
  }
  if (!item.chosenConcept) {
    // Auto-picks the strongest overall when no id is given.
    chooseConcept(id);
    item = loadItem(id);
  }

  // ── 3. Build the editorial spine (EDL) from the chosen concept + brief.
  logLine(item, "creative loop: building EDL spine");
  await buildEdl(id);

  // ── 4. Run the assembly passes — either the caller's explicit set or the full
  //       canonical order (assembly → pacing → emotion → visual → audio →
  //       typography → color → qa). Each pass bridges itself onto the storyboard.
  const initialPasses = opts?.passes ?? PASS_ORDER;
  for (const pass of initialPasses) {
    await runPass(id, pass);
  }
  // Belt-and-suspenders: ensure the latest EDL is projected onto the render
  // target even if the caller passed a `passes` set that omitted bridging passes.
  try {
    applyEdlToStoryboard(id);
  } catch {
    /* bridge is itself fail-open; ignore */
  }

  // ── 5. Render the first cut to WATCH it (fail-open).
  if (wantRender) {
    item = loadItem(id);
    logLine(item, "creative loop: rendering first cut to watch");
    await watchRender(id);
  }

  // ── 6. First self-review against real render evidence.
  let review = await reviewCut(id, { pass: "final" });
  let iterations = 0;
  let lastOverall = review.scores.overall;

  // ── 7. Revision loop: keep fixing while the editor says "revise", bounded by
  //       maxIterations, stopping early when the cut stops improving. We never
  //       loop on "reject" (fundamentally broken — needs a human) or "ship".
  const effectiveMax = budgetCapsIterations ? Math.min(maxIterations, 1) : maxIterations;
  while (review.verdict === "revise" && iterations < effectiveMax) {
    iterations++;
    item = loadItem(id);
    const fixes = (review.fixes ?? []).filter((f) => f.severity === "high" || f.severity === "medium");
    logLine(
      item,
      `creative loop: revision ${iterations}/${effectiveMax} — addressing ${fixes.length} fix(es) (overall ${review.scores.overall.toFixed(1)})`,
    );

    // Turn the review's actionable fixes into a FOCUSED set of re-run passes —
    // only the specialists whose concern the fixes point at, then a QA sweep.
    const revisionPasses = passesForReview(review);
    for (const pass of revisionPasses) {
      await runPass(id, pass);
    }
    // Re-apply the bridge so every refined intent reaches the render target.
    try {
      applyEdlToStoryboard(id);
    } catch {
      /* fail-open */
    }

    // Re-render the revised cut so the next review judges the actual change.
    if (wantRender) await watchRender(id);

    // Re-grade. reviewCut appends to item.reviews and reconciles the verdict to
    // the enforced ship gate, so we can trust it as the loop's control signal.
    const next = await reviewCut(id, { pass: `revision-${iterations}` });

    // Early stop: if the overall score didn't IMPROVE, more iterations are
    // unlikely to help (we're thrashing). Accept the better of the two and bail.
    if (next.scores.overall <= lastOverall + 0.01) {
      item = loadItem(id);
      logLine(
        item,
        `creative loop: overall stopped improving (${lastOverall.toFixed(1)} → ${next.scores.overall.toFixed(1)}) — stopping`,
      );
      review = next;
      break;
    }
    lastOverall = next.scores.overall;
    review = next;
  }

  // ── 8. Return the full self-review history + how it landed.
  const final = loadItem(id);
  logLine(
    final,
    `creative loop: done after ${iterations} revision(s) — verdict "${review.verdict}" (overall ${review.scores.overall.toFixed(1)})`,
  );
  return {
    reviews: final.reviews ?? [],
    iterations,
    finalVerdict: review.verdict,
  };
}
