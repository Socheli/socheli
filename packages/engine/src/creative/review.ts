import type {
  ContentItem,
  CreativeReview,
  EditBrief,
  EditConcept,
  ReviewFix,
} from "@os/schemas";
import { CreativeReview as CreativeReviewSchema } from "@os/schemas";
import { think } from "../brain.ts";
import { loadItem, saveItem, nowIso, logLine } from "../store.ts";
import { callEditorTool } from "../editor-tools.ts";
import { tasteContext } from "./taste.ts";

/* creative/review.ts — the editor watches its OWN cut and grades it.
   reviewCut() gathers render evidence from the deterministic editor tools (the
   ground truth a model can't hallucinate: silences, freezes, black frames,
   readability scores, real durations), folds in the editorial intent (brief +
   chosen concept + storyboard summary + the channel's learned taste), and asks
   the smart brain for one CreativeReview scorecard with concrete, located fixes.

   The hard contract: NEVER throw on a missing render or a broken evidence tool.
   A cut may be reviewed before it's rendered (judging the EDL/storyboard on
   intent alone) or while a tool is mid-failure — in every such case we proceed
   with whatever evidence we have and note its absence, because a review loop
   that crashes when there's no video yet is useless to the autonomous editor. */

/* One evidence tool's distilled result. We keep the compact text the prompt
   needs plus any artifact paths to surface as CreativeReview.evidence[]. */
type EvidencePart = { summary: string; paths: string[] };

const EMPTY: EvidencePart = { summary: "", paths: [] };

/* Call an editor_* tool and never let it throw into the review. callEditorTool
   is synchronous today but typed as a Promise — await covers both so a future
   async tool keeps working. A failed/absent tool degrades to a noted gap. */
async function safeTool(name: string, input: unknown): Promise<{ ok: boolean; data?: any; message?: string }> {
  try {
    const res = await callEditorTool(name, input);
    return res.ok ? { ok: true, data: res.data } : { ok: false, message: res.message };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}

/* Round a number for compact prompt text without exploding on NaN/undefined. */
const n2 = (v: unknown): string => {
  const x = Number(v);
  return Number.isFinite(x) ? x.toFixed(2) : "n/a";
};

/* editor_watch_video → metadata + scene timeline + sampled frame paths. This is
   our primary "what does the cut look like" signal and our richest source of
   evidence-image paths (contact sheet + per-scene frames). */
function distillWatch(data: any): EvidencePart {
  if (!data) return EMPTY;
  const dur = data.metadata?.format?.duration;
  const timeline: any[] = Array.isArray(data.timeline) ? data.timeline : [];
  const samples: any[] = Array.isArray(data.samples) ? data.samples : [];
  const lines: string[] = [];
  if (dur != null) lines.push(`Rendered duration: ${n2(dur)}s across ${timeline.length} scenes.`);
  // Surface the per-scene timing so the brain can locate pacing fixes precisely.
  if (timeline.length) {
    lines.push(
      "Scene timing: " +
        timeline
          .slice(0, 24)
          .map((s) => `#${s.index} ${s.type} ${n2(s.durationSec)}s`)
          .join(", "),
    );
  }
  const paths = [
    ...(data.contactSheet ? [String(data.contactSheet)] : []),
    ...samples.map((s) => s?.framePath).filter((p): p is string => typeof p === "string"),
  ];
  return { summary: lines.join("\n"), paths };
}

/* editor_analyze_av → AV continuity diagnostics. These are the hard technical
   defects (audio too hot/quiet, gaps of silence, frozen video, black frames,
   abrupt scene-change density) that gate technicalPolish/audioClarity and
   should drive high-severity fixes. */
function distillAv(data: any): EvidencePart {
  if (!data) return EMPTY;
  const d = data.diagnostics ?? {};
  const lines: string[] = [];
  const vol = d.volume ?? {};
  lines.push(`Loudness: mean ${n2(vol.meanDb)} dB, max ${n2(vol.maxDb)} dB.`);
  const fmtIntervals = (label: string, arr: any[], min = 0) => {
    const hits = (Array.isArray(arr) ? arr : []).filter((x) => (Number(x?.durationSec) || 0) >= min || x?.durationSec == null);
    if (!hits.length) return;
    lines.push(
      `${label}: ${hits
        .slice(0, 6)
        .map((x) => `${n2(x.startSec)}s${x.endSec != null ? `–${n2(x.endSec)}s` : ""}`)
        .join(", ")}`,
    );
  };
  fmtIntervals("Silence", d.silence, 0.5);
  fmtIntervals("Freezes", d.freezes, 0.5);
  fmtIntervals("Black frames", d.blackFrames, 0.25);
  const changes = Array.isArray(d.sceneChanges) ? d.sceneChanges.length : 0;
  if (changes) lines.push(`Detected ${changes} hard visual scene-change(s).`);
  return { summary: lines.join("\n"), paths: d.waveformPath ? [String(d.waveformPath)] : [] };
}

/* editor_readability_review → caption/text legibility on mobile, scene-by-scene.
   We forward the verdict, average score, and the worst offenders (with their
   evidence frames) so the brain can write subtitleReadability-driven fixes. */
function distillReadability(review: any): EvidencePart {
  if (!review) return EMPTY;
  const lines: string[] = [`Readability verdict: ${review.verdict} (avg ${review.avgScore}/100).`];
  const worst: any[] = Array.isArray(review.worstScenes) ? review.worstScenes : [];
  const paths: string[] = [];
  for (const w of worst.slice(0, 3)) {
    const reasons = (w.issues ?? []).map((i: any) => i.reason).filter(Boolean).join(" ");
    lines.push(`- Scene ${w.index} (${w.type}) score ${w.score}: ${reasons || "low score"}`);
    if (w.evidence?.framePath) paths.push(String(w.evidence.framePath));
  }
  return { summary: lines.join("\n"), paths };
}

/* editor_ocr_review (cheap, optional) → does the rendered text actually match
   the intended storyboard text? A low OCR/intent similarity is a rendering bug
   (clipped, wrong, or missing text) the AV/readability passes won't catch. */
function distillOcr(review: any): EvidencePart {
  if (!review) return EMPTY;
  const v = review.verdict ?? review.avgScore != null ? `verdict ${review.verdict ?? "n/a"}` : "";
  const mism: any[] = Array.isArray(review.issues)
    ? review.issues.filter((i: any) => /mismatch|missing|clip/i.test(String(i.reason ?? i.type ?? "")))
    : [];
  if (!v && !mism.length) return EMPTY;
  const lines = [`OCR vs intended text: ${v || "checked"}.`];
  for (const m of mism.slice(0, 3)) lines.push(`- ${m.reason ?? m.type}`);
  return { summary: lines.join("\n"), paths: [] };
}

/* Compact storyboard summary — the editorial content the brain is grading, so
   it can name fixes by scene and judge the hook/arc/CTA against the text. */
function storyboardSummary(item: ContentItem): string {
  const scenes = item.storyboard?.scenes ?? [];
  if (!scenes.length) return "No storyboard scenes.";
  return scenes
    .slice(0, 24)
    .map((s: any, i: number) => {
      const text =
        s.say ?? s.text ?? s.caption ?? s.title ?? (Array.isArray(s.lines) ? s.lines.map((l: any) => (typeof l === "string" ? l : l?.text)).filter(Boolean).join(" / ") : "");
      const flags = [s.emphasis ? "emphasis" : "", s.locked ? "locked" : "", s.hidden ? "hidden" : ""].filter(Boolean).join(",");
      return `#${i} ${s.type} ${n2(s.durationSec)}s${flags ? ` [${flags}]` : ""}: ${String(text).slice(0, 110)}`;
    })
    .join("\n");
}

/* The chosen concept block (if the editor explored concepts) — what the cut is
   SUPPOSED to feel like, so brandConsistency/emotionalImpact are graded against
   an explicit intent rather than the reviewer's guess. */
function conceptSummary(item: ContentItem): string {
  const concepts = item.concepts ?? [];
  const chosen: EditConcept | undefined =
    concepts.find((c) => c.id === item.chosenConcept) ?? concepts[0];
  if (!chosen) return "No chosen concept (judge against the brief).";
  return [
    `Chosen concept "${chosen.name}" (${chosen.style}, ${chosen.pacing} pacing).`,
    chosen.summary,
    chosen.paletteIntent ? `Palette: ${chosen.paletteIntent}` : "",
    chosen.soundIntent ? `Sound: ${chosen.soundIntent}` : "",
    chosen.transitionIntent ? `Transitions: ${chosen.transitionIntent}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/* The brief block (if inferred) — purpose/platform/feeling/hook-window are the
   yardstick for hookStrength and platformFit. */
function briefSummary(brief: EditBrief | undefined): string {
  if (!brief) return "No brief (infer intent from storyboard + concept).";
  return [
    `Purpose: ${brief.purpose}`,
    `Platform: ${brief.platform} · Audience: ${brief.audience}`,
    brief.feeling?.length ? `Desired feeling: ${brief.feeling.join(", ")}` : "",
    `Hook window: ${brief.hookWindowSec}s`,
    brief.doNots?.length ? `Do NOT: ${brief.doNots.join("; ")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/* Fallback heuristic verdict, used only if the brain somehow returns a verdict
   inconsistent with its own scorecard. The contract: ship iff overall >= 8 and
   no high-severity fix; reject only if fundamentally broken (very low overall);
   else revise. We re-derive it so the gate stays trustworthy. */
/* When the LLM grader is unavailable (rate-limited / parse fail), grade from the
 * MEASURED render evidence instead of emitting a useless neutral 5/5. Black frames
 * + freezes → technicalPolish; integrated loudness vs the -14 target + silence →
 * audioClarity; readability flags → subtitleReadability. The dimensions that need a
 * model to judge (hook/emotion/CTA/brand) stay a cautious 6 with an explicit note —
 * we don't fake judgement we couldn't make. This makes a throttled review USEFUL. */
function evidenceReview(avData: any, readabilityData: any, gaps: string[]): CreativeReview {
  const d = avData?.diagnostics ?? avData ?? {};
  const black = Array.isArray(d.blackFrames) ? d.blackFrames.length : 0;
  const freezes = Array.isArray(d.freezes) ? d.freezes.length : 0;
  const silences = Array.isArray(d.silence) ? d.silence.length : 0;
  const lufs = Number(d.loudness?.integratedLufs);
  const tp = Number(d.loudness?.truePeakDb);
  const rev = readabilityData?.review ?? readabilityData ?? {};
  const issues = Array.isArray(rev.scenes) ? rev.scenes.flatMap((s: any) => s.issues ?? []) : Array.isArray(rev.issues) ? rev.issues : [];
  const readFlags = issues.length;
  const clamp = (n: number) => Math.max(1, Math.min(9, Math.round(n)));
  const hasRender = !gaps.some((g) => /no render/.test(g));
  const technicalPolish = hasRender ? clamp(9 - black * 0.8 - freezes * 0.6) : 5;
  const audioClarity = !Number.isFinite(lufs)
    ? hasRender
      ? 6
      : 5
    : clamp(9 - Math.min(6, Math.abs(lufs + 14) * 0.8) - (Number.isFinite(tp) && tp > -1 ? 2 : 0) - silences * 0.3);
  const subtitleReadability = hasRender ? clamp(9 - readFlags * 0.7) : 5;
  const N = 6; // model-only dimensions — cautious neutral, not faked
  const scores = { hookStrength: N, pacing: N, audioClarity, subtitleReadability, brandConsistency: N, emotionalImpact: N, ctaClarity: N, technicalPolish, overall: 0 };
  scores.overall = Math.round(((technicalPolish + audioClarity + subtitleReadability + N * 5) / 8) * 10) / 10;
  const fixes: ReviewFix[] = [];
  if (black > 0) fixes.push({ where: "global", issue: `${black} black-frame event(s) detected`, action: "find + eliminate black/asset-load gaps", severity: "high" });
  if (freezes > 0) fixes.push({ where: "global", issue: `${freezes} freeze(s) detected`, action: "remove the frozen segment(s)", severity: "high" });
  if (Number.isFinite(lufs) && Math.abs(lufs + 14) > 2) fixes.push({ where: "global", issue: `loudness ${lufs.toFixed(1)} LUFS vs -14 target`, action: "re-master loudness to -14 LUFS", severity: "medium" });
  if (readFlags > 0) fixes.push({ where: "global", issue: `${readFlags} readability flag(s)`, action: "enlarge/contrast captions; cut words-per-second", severity: "medium" });
  return {
    at: nowIso(),
    scores,
    fixes,
    verdict: reconcileVerdict(scores.overall, fixes),
    notes: `Evidence-based grade (LLM grader throttled): ${black} black, ${freezes} freeze, ${Number.isFinite(lufs) ? lufs.toFixed(1) + " LUFS" : "loudness n/a"}, ${readFlags} readability flag(s). Hook/emotion/CTA not model-judged.${gaps.length ? ` Gaps: ${gaps.join("; ")}.` : ""}`,
    evidence: [],
  } as CreativeReview;
}

function reconcileVerdict(overall: number, fixes: ReviewFix[]): CreativeReview["verdict"] {
  const hasHigh = fixes.some((f) => f.severity === "high");
  if (overall >= 8 && !hasHigh) return "ship";
  if (overall < 3) return "reject";
  return "revise";
}

/* Watch the cut and grade it. Saves the scorecard into item.reviews (append) and
   returns it. opts.pass tags which editorial pass/iteration produced this review.
   opts is intentionally permissive — callers pass { pass } from the loop. */
export async function reviewCut(id: string, opts?: { pass?: string }): Promise<CreativeReview> {
  const item = loadItem(id);

  // 1) Gather render evidence — each tool fail-open and independent, so a single
  //    broken tool (or no render at all) never aborts the review.
  const [watch, av, readability, ocr] = await Promise.all([
    safeTool("editor_watch_video", { id }),
    safeTool("editor_analyze_av", { id }),
    safeTool("editor_readability_review", { id }),
    // OCR is cheap-ish and high-signal for "did the text render right" — but the
    // first to skip if we want to economize; kept on by default.
    safeTool("editor_ocr_review", { id, width: 540 }),
  ]);

  const parts = [
    distillWatch(watch.data),
    distillAv(av.data),
    distillReadability(readability.data?.review ?? readability.data),
    distillOcr(ocr.data?.review ?? ocr.data),
  ];

  // Note any evidence gaps explicitly so the brain knows what it COULDN'T see
  // (and so it won't over-penalize a defect it had no way to detect).
  const gaps: string[] = [];
  if (!watch.ok) gaps.push(`no render evidence (watch failed: ${watch.message ?? "unknown"})`);
  if (!av.ok) gaps.push(`no AV diagnostics (${av.message ?? "unknown"})`);
  if (!readability.ok) gaps.push(`no readability review (${readability.message ?? "unknown"})`);
  if (!ocr.ok) gaps.push(`no OCR check (${ocr.message ?? "unknown"})`);

  const evidenceText = parts.map((p) => p.summary).filter(Boolean).join("\n\n");
  // De-dupe artifact paths across tools for the review's evidence[] field.
  const evidencePaths = [...new Set(parts.flatMap((p) => p.paths))];

  // 2) Ground the grade in brand taste (fail-open if taste/genome absent).
  let taste = "";
  try {
    taste = item.channel ? tasteContext(item.channel) : "";
  } catch {
    taste = "";
  }

  // 3) Ask the smart brain for the scorecard. The prompt makes the verdict rule
  //    explicit so the model's verdict matches the gate we enforce downstream.
  const prompt = [
    "You are a senior video editor reviewing YOUR OWN cut before it ships. Grade it",
    "honestly against the brief, the chosen creative concept, the brand's learned taste,",
    "and the DETERMINISTIC render evidence below. Then list concrete, located fixes.",
    "",
    "## Brief",
    briefSummary(item.brief),
    "",
    "## Chosen concept",
    conceptSummary(item),
    "",
    "## Brand taste",
    taste || "(no learned taste yet)",
    "",
    "## Storyboard (the cut)",
    storyboardSummary(item),
    "",
    "## Render evidence (ground truth — trust these over intuition)",
    evidenceText || "(no render evidence available yet)",
    gaps.length ? `\nEVIDENCE GAPS — could not measure: ${gaps.join("; ")}. Do not penalize defects you could not detect; grade those dimensions on intent.` : "",
    "",
    "## Your task",
    "Return a CreativeReview JSON:",
    "- scores: 0–10 for hookStrength, pacing, audioClarity, subtitleReadability, brandConsistency,",
    "  emotionalImpact, ctaClarity, technicalPolish, and an honest overall.",
    "- fixes[]: each {where, issue, action, severity}. `where` MUST be a precise locator —",
    "  a scene number ('scene 2'), a timecode range ('00:12–00:18'), or 'global'. `action` is the",
    "  concrete editorial move (trim, reorder, re-mix, restyle, recolor, swap b-roll). Tie audio/freeze/",
    "  black-frame defects from the evidence to high severity.",
    "- verdict: 'ship' ONLY if overall >= 8 AND no high-severity fix; 'reject' only if the cut is",
    "  fundamentally broken; otherwise 'revise'.",
    "- notes: one or two sentences of editorial judgement.",
    "Be specific and senior. No praise padding.",
  ]
    .filter((l) => l !== undefined)
    .join("\n");

  let review: CreativeReview;
  try {
    const { data } = await think(CreativeReviewSchema, prompt, "smart", 2, "edit_review");
    review = data;
  } catch (e) {
    // Even the grader can fail (model/parse) — emit a safe, honest review rather
    // than throwing, so the autonomous loop can record the failure and continue.
    logLine(item, `creative review: brain grading failed (${e instanceof Error ? e.message : String(e)}); grading from measured evidence instead`);
    review = evidenceReview(av.data, readability.data, gaps);
  }

  // 4) Stamp provenance, attach evidence paths, and reconcile the verdict to the
  //    enforced gate so a model slip can't smuggle a weak cut past 'ship'.
  review.at = nowIso();
  if (opts?.pass) review.pass = opts.pass;
  review.evidence = [...new Set([...(review.evidence ?? []), ...evidencePaths])];
  const reconciled = reconcileVerdict(review.scores.overall, review.fixes ?? []);
  if (reconciled !== review.verdict) {
    review.verdict = reconciled; // gate is sacred — derive from scores+severity
  }
  if (gaps.length && !/(gap|no render|unavailable)/i.test(review.notes ?? "")) {
    review.notes = `${review.notes ?? ""}${review.notes ? " " : ""}(Evidence gaps: ${gaps.join("; ")}.)`.trim();
  }

  // Validate at the boundary, then append to the self-review history and persist.
  const parsed = CreativeReviewSchema.parse(review);
  (item.reviews ??= []).push(parsed);
  logLine(
    item,
    `creative review [${opts?.pass ?? "review"}]: ${parsed.verdict} (overall ${parsed.scores.overall.toFixed(1)}, ${parsed.fixes.length} fix${parsed.fixes.length === 1 ? "" : "es"})`,
  );
  saveItem(item);

  return parsed;
}
