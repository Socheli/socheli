/* creative/ab.ts — A/B the editorial CONCEPTS on REAL output, then commit the
   proven one (manifesto §5: "explore options, pick the strongest" — measured on
   the actual cut, not on the pre-render pitch). A senior editor doesn't argue
   about which direction is best in the abstract; they build the top contenders,
   watch each, and let the strongest cut win.

   The discipline: a concept's pre-render scores are a PROMISE. abConcepts cashes
   that promise in — for each top-N concept it builds a throwaway variant run,
   bridges its EDL onto a real storyboard, (optionally) rerenders it, then has the
   reviewer watch the variant and grade it from render evidence. The winner is the
   variant with the highest reviewed overall, and its concept is committed back to
   the ORIGINAL item so the main loop continues with a direction proven on output.

   Fail-open is sacred (like edl.ts / review.ts / concepts.ts): nothing here may
   throw into the creative loop. If concepts can't be generated, render isn't
   available, or a variant explodes mid-build, we degrade — down to ranking the
   concepts by their pre-render scores.overall — and still return a winner. Every
   throwaway variant run file is cleaned up afterward (unless opts asks to keep
   them) so A/B leaves no litter in data/runs/. */

import { rmSync } from "node:fs";
import { loadItem, saveItem, itemPath, logLine } from "../store.ts";
import { generateConcepts } from "./concepts.ts";
import { buildEdl, applyEdlToStoryboard } from "./edl.ts";
import { reviewCut } from "./review.ts";
import { rerender } from "../rerender.ts";

/* A single concept's A/B result. `overall` is the REVIEWED overall when a variant
   was reviewed on real evidence, or the concept's pre-render scores.overall when
   we degraded (render/review unavailable). `verdict` carries the review verdict
   (ship/revise/reject) or "scored" for the degraded pre-render fallback. */
type RankedConcept = { conceptId: string; overall: number; verdict: string };

/* Build the throwaway variant id for a concept. Derived from the original id so
   the relationship is legible in data/runs/ and the cleanup target is obvious. */
function variantIdFor(id: string, conceptId: string): string {
  return `${id}__ab_${conceptId}`;
}

/* Delete a throwaway variant run file. Best-effort: a failed cleanup must never
   surface as an A/B error (the variant is disposable by definition). */
function cleanupVariant(variantId: string, notes: string[]): void {
  try {
    rmSync(itemPath(variantId), { force: true });
  } catch (e) {
    notes.push(`could not remove variant ${variantId} (${e instanceof Error ? e.message : String(e)})`);
  }
}

/**
 * A/B the top-N editorial concepts on real output and commit the strongest.
 *
 * - Ensures item.concepts exist (generates them if absent).
 * - Picks the top N (opts.top, default 2) by pre-render scores.overall.
 * - For each: deep-clones the item into a throwaway variant run, bridges that
 *   concept's EDL onto the storyboard, optionally rerenders (opts.render !==
 *   false), and self-reviews the variant cut on render evidence.
 * - Ranks by the review's scores.overall; winner = highest. The winning concept
 *   is persisted onto the ORIGINAL item (item.chosenConcept) so the main loop
 *   continues with the proven direction.
 * - Cleans up every throwaway variant run file afterward (unless opts.keep).
 *
 * NEVER throws: degrades to ranking concepts by their pre-render scores when
 * rendering/reviewing is unavailable.
 */
export async function abConcepts(
  id: string,
  opts: { top?: number; render?: boolean; keep?: boolean } = {},
): Promise<{
  winner: string;
  ranked: RankedConcept[];
  notes: string[];
}> {
  const notes: string[] = [];
  let item = loadItem(id);

  // 1) Ensure we have concepts to A/B. generateConcepts persists onto the item;
  //    reload so we read the freshly-saved spread. Fail-open: if generation is
  //    impossible we can't A/B at all — return an empty, honest result.
  if (!item.concepts || item.concepts.length === 0) {
    try {
      await generateConcepts(id);
      item = loadItem(id);
    } catch (e) {
      notes.push(`concept generation failed (${e instanceof Error ? e.message : String(e)}); cannot A/B`);
    }
  }
  const concepts = item.concepts ?? [];
  if (concepts.length === 0) {
    return { winner: "", ranked: [], notes: [...notes, "no concepts available to A/B"] };
  }

  // 2) Pick the top-N by pre-render scores.overall. With a single concept there
  //    is nothing to compare — commit it and return without spinning up a variant.
  const top = Math.max(1, Math.min(concepts.length, opts.top ?? 2));
  const contenders = [...concepts]
    .sort((a, b) => b.scores.overall - a.scores.overall)
    .slice(0, top);

  if (contenders.length === 1) {
    const only = contenders[0];
    item.chosenConcept = only.id;
    saveItem(item);
    logLine(item, `ab: single concept "${only.name}" — committed without variant comparison`);
    return {
      winner: only.id,
      ranked: [{ conceptId: only.id, overall: only.scores.overall, verdict: "scored" }],
      notes: [...notes, `only one concept (${only.id}); committed by default`],
    };
  }

  // 3) Build + review one throwaway variant per contender. Each contender is fully
  //    isolated in a try/catch: a variant that fails to build/render/review must
  //    not sink the whole A/B — it degrades to its pre-render score and we move on.
  const ranked: RankedConcept[] = [];
  const doRender = opts.render !== false;

  for (const concept of contenders) {
    const variantId = variantIdFor(id, concept.id);
    let reviewed = false;
    try {
      // Deep-clone the ORIGINAL item into the variant run. Structured-clone keeps
      // the clone fully independent (no shared refs into the original's arrays),
      // and we pin the variant's id + chosenConcept so every downstream stage
      // (EDL build, bridge, render, review) operates on this concept in isolation.
      const variant = structuredClone(item) as typeof item;
      variant.id = variantId;
      variant.chosenConcept = concept.id;
      // The variant is disposable scratch work — it must never inherit the
      // original's self-review history (that would taint the variant's grade and
      // pollute the original's id space). Start its review log clean.
      variant.reviews = [];
      saveItem(variant);

      // Bridge THIS concept onto a real storyboard: build its EDL, then project
      // the editorial intent to concrete, clamped scene/mix params.
      await buildEdl(variantId, { conceptId: concept.id });
      applyEdlToStoryboard(variantId);

      // Render the variant so the review grades REAL output (the whole point of
      // A/B). Preview quality + b-roll on, fast. FAIL-OPEN: a render error leaves
      // the variant un-(re)rendered and the review falls back to intent-grading.
      if (doRender) {
        try {
          await rerender(variantId, { broll: true, preview: true });
        } catch (e) {
          notes.push(`variant ${concept.id}: render failed (${e instanceof Error ? e.message : String(e)}); reviewing on intent`);
        }
      }

      // Self-review the variant cut. reviewCut never throws (it degrades to a
      // neutral verdict), so a returned scorecard is always usable.
      const review = await reviewCut(variantId, { pass: `ab:${concept.id}` });
      ranked.push({ conceptId: concept.id, overall: review.scores.overall, verdict: review.verdict });
      reviewed = true;
      notes.push(`variant ${concept.id}: ${review.verdict} (overall ${review.scores.overall.toFixed(1)})`);
    } catch (e) {
      notes.push(`variant ${concept.id}: A/B build failed (${e instanceof Error ? e.message : String(e)}); using pre-render score`);
    } finally {
      // Throwaway runs are litter once reviewed — remove them unless asked to keep.
      if (!opts.keep) cleanupVariant(variantId, notes);
    }

    // Degraded fallback: if the variant never produced a review, rank it by its
    // pre-render promise so it still competes (never silently dropped).
    if (!reviewed) {
      ranked.push({ conceptId: concept.id, overall: concept.scores.overall, verdict: "scored" });
    }
  }

  // 4) Highest reviewed overall wins. Tie-break is the contender order (already
  //    sorted by pre-render overall), so a dead heat falls to the stronger pitch.
  const sorted = [...ranked].sort((a, b) => b.overall - a.overall);
  const winner = sorted[0]?.conceptId ?? contenders[0].id;

  // 5) Commit the proven direction back onto the ORIGINAL item so the main loop
  //    continues with the winner — not the pre-render guess. Reload first so we
  //    write onto the latest original (concept generation above may have touched
  //    it) rather than a stale snapshot.
  const original = loadItem(id);
  original.chosenConcept = winner;
  const winNote = sorted[0] ? `overall ${sorted[0].overall.toFixed(1)} (${sorted[0].verdict})` : "default";
  logLine(original, `ab: winner "${winner}" — ${winNote}; ranked [${sorted.map((r) => `${r.conceptId}:${r.overall.toFixed(1)}`).join(", ")}]`);
  saveItem(original);

  return { winner, ranked: sorted, notes };
}
