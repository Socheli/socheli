import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { DATA_DIR, ensureDir, nowIso } from "./store.ts";
import { think } from "./brain.ts";
import type { ContentItem } from "@os/schemas";
import { recordPerformance, loadAnalytics, type NormalizedMetrics } from "./learnings.ts";

/* ─── G3: hook A/B testing loop ─────────────────────────────────────────────
   The system rarely nails the hook on the first try, yet the hook (first ~2s)
   is the single biggest lever on retention. This module:
     (a) generates N alternative hook / first-scene variants for an item,
     (b) persists those variants and which one was actually published where,
     (c) once analytics land, picks the winning variant and feeds that signal
         back into the learning loop (learnings.recordPerformance) so future
         ideation leans into hook styles that win.

   Everything is self-contained under data/abtests/<id>.json and additive — no
   existing stage reads or writes it until explicitly wired. Generation degrades
   gracefully: if the brain subprocess is unavailable, a deterministic local
   fallback still produces usable variants so the loop never hard-fails. */

const ABTEST_DIR = join(DATA_DIR, "abtests");

/* A single candidate hook. `firstScene` is an optional first-scene on-screen
   text variant paired with the spoken hook, so the test covers both the line
   the viewer hears and the text they read in the opening frame. */
export type HookVariant = {
  id: string;
  /** The spoken/headline hook line (<= a few words, scroll-stopping). */
  hook: string;
  /** Optional first-scene on-screen text paired with this hook. */
  firstScene?: string;
  /** Short label of the persuasion angle (e.g. "curiosity gap", "bold claim"). */
  style: string;
  /** "base" = the item's existing hook, kept as the control. */
  origin: "base" | "generated";
  createdAt: string;
};

/* Records that a given variant was published on a platform, so when analytics
   arrive we can attribute a score back to the exact hook that shipped. */
export type VariantPublication = {
  variantId: string;
  platform: string;
  /** Platform post/media id, when known (mirrors publish[].id). */
  postId?: string;
  at: string;
};

/* When a winner is decided, we snapshot why so the dashboard can explain it. */
export type ABWinner = {
  variantId: string;
  hook: string;
  style: string;
  score: number;
  platform?: string;
  decidedAt: string;
  reason: string;
};

/* The full persisted A/B record for one content item. */
export type ABTest = {
  id: string; // content item id
  channel: string;
  topic: string;
  variants: HookVariant[];
  publications: VariantPublication[];
  winner?: ABWinner;
  createdAt: string;
  updatedAt: string;
};

/* ─── persistence ──────────────────────────────────────────────────────── */
function testPath(id: string) {
  return join(ABTEST_DIR, `${id}.json`);
}

export function loadABTest(id: string): ABTest | null {
  const p = testPath(id);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as ABTest;
  } catch {
    return null;
  }
}

export function listABTests(): ABTest[] {
  ensureDir(ABTEST_DIR);
  return readdirSync(ABTEST_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      try {
        return JSON.parse(readFileSync(join(ABTEST_DIR, f), "utf8")) as ABTest;
      } catch {
        return null;
      }
    })
    .filter((x): x is ABTest => !!x)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function saveABTest(t: ABTest): ABTest {
  ensureDir(ABTEST_DIR);
  t.updatedAt = nowIso();
  writeFileSync(testPath(t.id), JSON.stringify(t, null, 2));
  return t;
}

/* ─── variant generation ───────────────────────────────────────────────── */
const GeneratedVariants = z.object({
  variants: z
    .array(
      z.object({
        hook: z.string().min(1),
        firstScene: z.string().optional(),
        style: z.string().min(1),
      }),
    )
    .min(1),
});

const vid = (n: number) => `v${n}_${Math.random().toString(36).slice(2, 8)}`;

/* Pull the item's existing hook + topic context for prompting / control. */
function itemContext(item: ContentItem): { topic: string; baseHook: string; cta: string; narration: string } {
  const topic = item.idea?.topic ?? item.seedIdea ?? "";
  const baseHook = item.script?.hook ?? item.pkg?.title ?? "";
  const cta = item.script?.cta ?? "";
  const narration = (item.script?.narration ?? []).slice(0, 4).join("\n");
  return { topic, baseHook, cta, narration };
}

/* Deterministic, no-LLM fallback so the loop never hard-fails when the brain
   subprocess is unavailable. Re-frames the base hook through common angles. */
function fallbackVariants(baseHook: string, topic: string, n: number): HookVariant[] {
  const subject = baseHook || topic || "this";
  const templates: { style: string; make: (s: string) => string }[] = [
    { style: "curiosity gap", make: (s) => `The truth about ${s.toLowerCase()}` },
    { style: "bold claim", make: (s) => `${s} is broken. Here's the fix` },
    { style: "negative hook", make: (s) => `Stop doing ${s.toLowerCase()} wrong` },
    { style: "list promise", make: (_s) => `3 things nobody tells you about ${topic || subject}` },
    { style: "question", make: (s) => `Why does ${s.toLowerCase()} actually work?` },
  ];
  const out: HookVariant[] = [];
  for (let i = 0; i < n && i < templates.length; i++) {
    const t = templates[i];
    out.push({
      id: vid(i + 1),
      hook: t.make(subject),
      style: t.style,
      origin: "generated",
      createdAt: nowIso(),
    });
  }
  return out;
}

/* (a) Generate N hook/first-scene variants for an item. Always keeps the item's
   existing hook as the "base" control (first entry), then appends generated
   alternatives. Persists and returns the ABTest. Idempotent-ish: re-running
   regenerates the generated set while preserving any recorded publications. */
export async function generateVariants(
  item: ContentItem,
  count = 3,
  tier: "cheap" | "smart" | "best" = "smart",
): Promise<{ test: ABTest; usd: number }> {
  const { topic, baseHook, cta, narration } = itemContext(item);
  const want = Math.max(1, Math.min(6, count));

  const base: HookVariant = {
    id: vid(0),
    hook: baseHook,
    firstScene: item.storyboard?.scenes?.[0] && "text" in (item.storyboard.scenes[0] as Record<string, unknown>)
      ? String((item.storyboard.scenes[0] as Record<string, unknown>).text ?? "")
      : undefined,
    style: "control (original)",
    origin: "base",
    createdAt: nowIso(),
  };

  let generated: HookVariant[] = [];
  let usd = 0;
  const prompt =
    `You are optimizing the OPENING HOOK of a short faceless vertical video for retention.\n` +
    `Write ${want} DISTINCT alternative hooks, each using a different persuasion angle ` +
    `(e.g. curiosity gap, bold claim, negative/contrarian, specific number/list, question).\n` +
    `Each hook is the first line a viewer hears in the first 2 seconds: punchy, <= 8 words, ` +
    `no clickbait lies, no emojis, no hashtags. Optionally include a short first-scene on-screen ` +
    `text (firstScene) that pairs with the hook.\n\n` +
    `TOPIC: ${topic}\n` +
    (baseHook ? `CURRENT HOOK (do not repeat verbatim): ${baseHook}\n` : "") +
    (cta ? `CTA: ${cta}\n` : "") +
    (narration ? `SCRIPT CONTEXT:\n${narration}\n` : "") +
    `\nReturn ONLY JSON: {"variants":[{"hook":"...","firstScene":"...","style":"..."}]}.`;

  try {
    const res = await think(GeneratedVariants, prompt, tier, 2, "abtest_hook_variants");
    usd = res.usd;
    generated = res.data.variants.slice(0, want).map((v, i) => ({
      id: vid(i + 1),
      hook: v.hook,
      firstScene: v.firstScene,
      style: v.style,
      origin: "generated" as const,
      createdAt: nowIso(),
    }));
  } catch {
    generated = fallbackVariants(baseHook, topic, want);
  }

  // Preserve prior publications/winner if a test already existed for this item.
  const prior = loadABTest(item.id);
  const test: ABTest = {
    id: item.id,
    channel: item.channel,
    topic,
    variants: [base, ...generated],
    publications: prior?.publications ?? [],
    winner: prior?.winner,
    createdAt: prior?.createdAt ?? nowIso(),
    updatedAt: nowIso(),
  };
  return { test: saveABTest(test), usd };
}

/* (b) Record that a specific variant was published on a platform. De-dupes on
   variantId+platform. Creates nothing if the test doesn't exist yet. */
export function recordPublication(
  itemId: string,
  variantId: string,
  platform: string,
  postId?: string,
): ABTest | null {
  const test = loadABTest(itemId);
  if (!test) return null;
  if (!test.variants.some((v) => v.id === variantId)) return null;
  const existing = test.publications.find((p) => p.variantId === variantId && p.platform === platform);
  if (existing) {
    if (postId) existing.postId = postId;
    existing.at = nowIso();
  } else {
    test.publications.push({ variantId, platform, postId, at: nowIso() });
  }
  return saveABTest(test);
}

/* Best representative score from a normalized-metrics array (max across surfaces). */
function bestScore(metrics: NormalizedMetrics[]): { score: number; platform?: string; retention?: number; views: number } {
  if (!metrics.length) return { score: 0, views: 0 };
  const best = metrics.reduce((a, b) => (b.score > a.score ? b : a));
  return { score: best.score, platform: best.platform, retention: best.retention, views: best.views };
}

/* (c) Given ingested analytics for the item, pick the winning hook and feed the
   signal back into the learning loop. Attribution model:
     - We read the per-item analytics snapshot (data/analytics/<id>.json) written
       by learnings.ingestAnalytics. That snapshot is per-item, so the published
       variant (the one tied to a publication record, else the base control) is
       credited with the item's best platform score.
     - The credited variant becomes the winner; its hook STYLE is what we teach
       the brain via recordPerformance, so winning angles compound over time.
   Returns the winner (or null if there's no test / no analytics yet). Never throws. */
export function decideWinner(itemId: string): ABWinner | null {
  const test = loadABTest(itemId);
  if (!test) return null;
  const snap = loadAnalytics(itemId);
  if (!snap || !snap.metrics.length) return null;

  const { score, platform, retention, views } = bestScore(snap.metrics);

  // The variant that actually shipped: prefer one on the winning platform, then
  // any recorded publication, else fall back to the base control.
  let publishedVariantId: string | undefined;
  if (platform) {
    publishedVariantId = test.publications.find((p) => p.platform === platform)?.variantId;
  }
  publishedVariantId ??= test.publications[0]?.variantId;
  const variant =
    test.variants.find((v) => v.id === publishedVariantId) ??
    test.variants.find((v) => v.origin === "base") ??
    test.variants[0];
  if (!variant) return null;

  const winner: ABWinner = {
    variantId: variant.id,
    hook: variant.hook,
    style: variant.style,
    score,
    platform,
    decidedAt: nowIso(),
    reason:
      test.publications.length > 0
        ? `published variant "${variant.style}" scored ${score} on ${platform ?? "platform"}`
        : `no per-variant publication recorded; credited control "${variant.style}" with item score ${score}`,
  };
  test.winner = winner;
  saveABTest(test);

  // Feed the winning hook's STYLE back into the learning loop so future ideation
  // leans into angles that win. Uses the same signal shape as ingestAnalytics.
  recordPerformance(test.channel, {
    hook: variant.style || variant.hook,
    format: snap.format,
    topic: snap.topic,
    retention,
    views,
  });

  return winner;
}
