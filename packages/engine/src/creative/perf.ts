import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { CreativeReview, ReviewFix, TasteRule } from "@os/schemas";
import { DATA_DIR } from "../store.ts";
import { learnTaste } from "./taste.ts";

/* perf.ts — close the editor's learning loop (manifesto §13).

   Editing TASTE (the craft judgement in taste.ts) should not be a static seed:
   it must GROW from evidence the editor itself produced — its own self-reviews
   (CreativeReview.fixes) and, once a post is live, observed PERFORMANCE
   (data/analytics/<id>.json, written by learnings.ts:ingestAnalytics).

   Both entry points are deliberately CONSERVATIVE and FAIL-OPEN: a learning
   loop must never crash the cut/review/publish flow it hangs off, and it must
   not pollute taste with one-off scene noise. We only promote signal that is
   clearly actionable AND general (a durable lesson, not "scene 3 was loud"),
   capped per call, and lean on learnTaste()'s own text-keyed de-dupe so the
   same lesson learned twice strengthens conviction instead of duplicating. */

/* Heuristic bucket for a fix: map its free-text where/issue/action onto the
   editorial dimension it concerns, so a "hook" fix becomes a hook lesson, a
   "pacing" fix a rhythm lesson, etc. Returns null when the fix is too specific
   / off-axis to generalize (those are left to the per-item edit, not taste). */
type FixDimension = "hook" | "pacing" | "subtitle" | "audio" | "visual" | "brand";

function classifyFix(fix: ReviewFix): FixDimension | null {
  const hay = `${fix.where} ${fix.issue} ${fix.action}`.toLowerCase();
  // Order matters: most specific signals first so e.g. a caption-legibility note
  // lands in "subtitle" rather than the broader "visual" bucket.
  if (/\bhook|opening|first 3 ?s|cold open|intro\b/.test(hay)) return "hook";
  if (/\bsubtitle|caption|legib|readab|text size|line ?wrap|contrast\b/.test(hay)) return "subtitle";
  if (/\bpac|rhythm|dead air|silence|drag|too (long|slow|fast)|tighten|trim\b/.test(hay)) return "pacing";
  if (/\baudio|volume|loud|quiet|music|duck|mix|voice level|sfx\b/.test(hay)) return "audio";
  if (/\bbrand|palette|color|accent|font|typograph|house style\b/.test(hay)) return "brand";
  if (/\bvisual|framing|compos|transition|motion|cut\b/.test(hay)) return "visual";
  return null;
}

/* The durable taste lesson a recurring/severe fix in each dimension teaches.
   Phrased as GENERAL craft rules (not item-specific) so they read well injected
   into future think() prompts via tasteContext(). */
function lessonFor(dim: FixDimension): { rule?: string; doNot?: string } {
  switch (dim) {
    case "hook":
      // A repeatedly-flagged hook means our openings keep failing to grab — make
      // it a guardrail so future cuts front-load the payoff.
      return { doNot: "slow or weak openings — the hook must land in the first 3s" };
    case "pacing":
      return { rule: "tighten dead air and vary the rhythm — never let a beat drag" };
    case "subtitle":
      return { doNot: "unreadable captions — keep subtitles legible (size, contrast, line-wrap)" };
    case "audio":
      return { rule: "duck music under the voice and keep levels clean — voice always intelligible" };
    case "brand":
      return { rule: "hold the brand's palette/type — one accent, consistent house style" };
    case "visual":
      return { rule: "every transition earns its place — motion only with intent, cut on action" };
  }
}

/* learnTaste's source field is a fixed enum; surface it as a constant so both
   entry points stamp provenance correctly (review-sourced vs performance). */
const REVIEW_SRC = "review" as const;
const PERF_SRC = "performance" as const;

/* Promote RECURRING / high-severity editorial fixes from a self-review into
   durable taste. We score each editorial DIMENSION by how strongly the review
   complained about it (count + severity), then promote the few strongest into
   taste rules/doNots. This is the "review" half of the loop.

   Conservative by design: at most ~3 updates per review, only dimensions that
   either recurred OR were flagged high-severity (a single low/medium one-off is
   per-item noise, not a house lesson). FAIL-OPEN — any error is swallowed so a
   review can never be lost to a taste-write hiccup. */
export async function learnTasteFromReview(channel: string, review: CreativeReview): Promise<void> {
  try {
    const fixes = review?.fixes ?? [];
    if (!fixes.length) return;

    const sevWeight = { low: 1, medium: 2, high: 4 } as const;
    // Aggregate per dimension: total severity-weighted score + a high-severity flag.
    const agg = new Map<FixDimension, { score: number; count: number; high: boolean }>();
    for (const fix of fixes) {
      const dim = classifyFix(fix);
      if (!dim) continue; // off-axis / too specific to generalize
      const cur = agg.get(dim) ?? { score: 0, count: 0, high: false };
      cur.score += sevWeight[fix.severity ?? "medium"];
      cur.count += 1;
      cur.high = cur.high || fix.severity === "high";
      agg.set(dim, cur);
    }

    // Only durable signal graduates: a dimension that RECURRED (>=2 fixes) or was
    // ever flagged HIGH severity. Strongest-scoring first, hard-capped at 3 so a
    // noisy review can't dump its whole fix list into permanent taste.
    const promote = [...agg.entries()]
      .filter(([, v]) => v.high || v.count >= 2)
      .sort((a, b) => b[1].score - a[1].score)
      .slice(0, 3);

    for (const [dim] of promote) {
      const lesson = lessonFor(dim);
      // learnTaste de-dupes by rule text and bumps weight on repeats, so calling
      // it again for a recurring dimension SHARPENS conviction rather than bloats.
      await learnTaste(channel, { ...lesson, source: REVIEW_SRC });
    }
  } catch {
    /* fail-open: the learning loop must never break the review pipeline */
  }
}

/* The analytics snapshot shape we read here is written by learnings.ts
   (ingestAnalytics → data/analytics/<id>.json). We re-declare only the fields
   we consume rather than import the type, to keep this module decoupled and
   tolerant of older/partial snapshots (everything is read defensively). */
const ANALYTICS_DIR = join(DATA_DIR, "analytics");

type PerfMetric = {
  views?: number;
  saves?: number;
  shares?: number;
  retention?: number; // 0..1 fraction watched
  score?: number; // 0..100 composite
};
type PerfSnapshot = { metrics?: PerfMetric[]; dropoff?: number };

/* Read this item's stored analytics and turn OBSERVED performance into editing
   taste. The discipline: every promoted lesson is grounded in a number we saw,
   not a vibe. Early drop-off teaches the hook to land harder; strong saves
   reinforce the craft prefs that earned them.

   Returns the human-readable list of taste updates applied (empty when there's
   no analytics yet — never throws). This is the "performance" half of the loop. */
export async function learnTasteFromPerformance(
  channel: string,
  itemId: string,
): Promise<{ applied: string[] }> {
  const applied: string[] = [];
  try {
    const p = join(ANALYTICS_DIR, `${itemId}.json`);
    if (!existsSync(p)) return { applied };

    let snap: PerfSnapshot;
    try {
      snap = JSON.parse(readFileSync(p, "utf8")) as PerfSnapshot;
    } catch {
      return { applied }; // corrupt snapshot — nothing observed to learn from
    }

    const metrics = snap.metrics ?? [];
    if (!metrics.length) return { applied };

    // Best surface = the platform that performed strongest; we learn from the
    // post's best showing (a weak cross-post shouldn't drown a real win).
    const best = metrics.reduce((a, b) => ((b.score ?? 0) > (a.score ?? 0) ? b : a));
    const retention = best.retention; // 0..1, may be undefined for IG/TikTok
    const saves = best.saves ?? 0;
    const views = best.views ?? 0;
    // dropoff (if present): steep early loss is a hook failure even when overall
    // retention looks ok — treat a >0.45 first-window drop as a fast bleed.
    const steepEarlyDrop = typeof snap.dropoff === "number" && snap.dropoff > 0.45;

    // ── Early drop-off → the hook isn't landing. Grounded in retention<55% or a
    //    steep first-window dropoff, this becomes a durable hook guardrail. ──
    if ((typeof retention === "number" && retention < 0.55) || steepEarlyDrop) {
      const rule = "hook must land harder and faster in the first 3s — viewers leave early";
      await learnTaste(channel, { rule, source: PERF_SRC });
      applied.push(rule);
    }

    // ── Strong saves → people want to keep this. Saves are the highest-intent
    //    signal; reinforce the deliberate-pacing pref that tends to earn them. ──
    //    (saveRate threshold kept conservative; absolute saves as a floor so a
    //    tiny-view post with 1 save can't masquerade as a save-magnet.)
    const saveRate = views > 0 ? saves / views : 0;
    if (saves >= 25 && saveRate >= 0.01) {
      const rule = "lean into the deliberate, legible pacing that earns saves — it's working";
      await learnTaste(channel, { rule, source: PERF_SRC });
      applied.push(rule);
    }

    // ── Strong retention → the cut held attention end-to-end; reinforce it so
    //    the editor keeps protecting watch-through on future cuts. ──
    if (typeof retention === "number" && retention >= 0.7) {
      const rule = "this cut held attention end-to-end — keep tight, breathing pacing";
      await learnTaste(channel, { rule, source: PERF_SRC });
      applied.push(rule);
    }
  } catch {
    /* fail-open: never let analytics learning throw into the publish/loop path */
  }
  return { applied };
}

/* ── N5.4: learn the operator's FOOTAGE-edit taste ───────────────────────────
   When a user edits an INGESTED video, their accepted choices reveal a standing
   preference the next edit should start from: how long they want a reel, how
   hard they cut, the caption style, whether they grade real footage. We promote
   those into the same EditingTaste store (as durable rules, text-keyed so
   repeats strengthen rather than duplicate) so routeEditRequest can begin from
   the learned defaults — "tighten to a reel" then means THEIR reel.

   Conservative + FAIL-OPEN, exactly like the review/performance learners: a
   one-off edit shouldn't carve a house rule, and a taste-write hiccup must never
   break the apply/montage path it hangs off. Returns what it promoted. */
export async function learnFootageTaste(
  channel: string,
  signal: {
    reelSec?: number; // accepted montage/target length → preferred reel length band
    clipCount?: number; // clips in an accepted reel → cut cadence
    trimAggressive?: boolean; // did they cut dead air hard, or keep it breathing?
    subtitlePreset?: string; // accepted caption style
    gradeOnFootage?: boolean; // do they grade real footage or leave it natural?
    source?: TasteRule["source"];
  },
): Promise<{ applied: string[] }> {
  const applied: string[] = [];
  const source = signal.source ?? "feedback";
  const promote = async (rule: string) => {
    try {
      await learnTaste(channel, { rule, source });
      applied.push(rule);
    } catch {
      /* one rule failing must not abort the rest */
    }
  };
  try {
    if (typeof signal.reelSec === "number" && signal.reelSec > 0) {
      // Bucket to a band so "~18s" and "~22s" reinforce one "short reel" lesson
      // rather than fragmenting into many near-identical rules.
      const band = signal.reelSec <= 20 ? "a tight ~15-20s reel" : signal.reelSec <= 45 ? "a ~30-45s cut" : "a longer ~60s+ cut";
      await promote(`when re-montaging, the operator prefers ${band}`);
    }
    if (typeof signal.clipCount === "number" && signal.clipCount > 0) {
      const cadence = signal.clipCount >= 6 ? "fast, many-cut" : signal.clipCount >= 3 ? "punchy, few-cut" : "minimal, hero-clip";
      await promote(`prefers a ${cadence} montage cadence`);
    }
    if (signal.trimAggressive === true) await promote("cut dead air and filler aggressively on ingested footage");
    else if (signal.trimAggressive === false) await promote("trim ingested footage gently — keep natural breathing room");
    if (signal.subtitlePreset?.trim()) await promote(`caption ingested videos in the "${signal.subtitlePreset.trim()}" style`);
    if (signal.gradeOnFootage === true) await promote("grade ingested footage (don't leave it ungraded)");
  } catch {
    /* fail-open: footage-taste learning must never break the edit/apply path */
  }
  return { applied };
}
