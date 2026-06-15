import { z } from "zod";
import { EdlDecision, type Edl, type PassRecord, type ContentItem } from "@os/schemas";
import { loadItem, saveItem, nowIso, logLine } from "../store.ts";
import { think } from "../brain.ts";
import { genomeContextSafe } from "../dna.ts";
import { tasteContext } from "./taste.ts";
import { buildEdl, applyEdlToStoryboard } from "./edl.ts";
import { reviewCut } from "./review.ts";
import { editSignals, signalsSummary } from "./signals.ts";
import { learnTasteFromReview } from "./perf.ts";
import { colorPass, colorPassRecord } from "./color-pass.ts";
import { audioPass, audioPassRecord } from "./audio-pass.ts";
import { compositingPass } from "./compositing-pass.ts";
import { understandingSummary } from "../understanding.ts";

/* creative/passes.ts — the senior editor's LAYERED passes.

   A professional editor does not solve every problem at once. They work the cut
   in disciplined passes: lock the assembly first, then rhythm, then emotion,
   then look, then sound, then text, then color, and finally a QA sweep. Each
   pass is a SPECIALIST who touches ONLY its concern and leaves everything else
   alone — that's what makes the process reversible and debuggable.

   Each pass here loads the run, ensures an Edl exists (the editorial spine from
   edl.ts), asks a pass-scoped specialist prompt to refine ONLY the relevant
   EdlDecision fields, writes the refined Edl back, bridges it onto the
   storyboard/mix via applyEdlToStoryboard (the deterministic, schema-clamped
   projection), records a PassRecord, and returns it.

   Safety contract (inherited from the spine): we never touch a locked scene
   (the bridge enforces that), we clamp every numeric through the bridge, and one
   bad decision is skipped — never thrown. A pass should always leave the cut in
   a renderable state, even if the brain is unavailable. */

export type PassName =
  | "assembly"
  | "pacing"
  | "emotion"
  | "visual"
  | "audio"
  | "typography"
  | "color"
  | "qa";

/* Fail-open digest of the footage-understanding index for the pass prompt — a
   malformed/partial Understanding must never break a pass (CLAUDE.md fail-open). */
function safeUnderstandingSummary(u: ContentItem["understanding"]): string {
  try {
    return u ? understandingSummary(u) : "";
  } catch {
    return "";
  }
}

/* The canonical order a senior editor works in: structure before rhythm,
   rhythm before feeling, feeling before look, picture before sound, sound
   before text, text before grade, grade before a final QA sweep. */
export const PASS_ORDER: PassName[] = [
  "assembly",
  "pacing",
  "emotion",
  "visual",
  "audio",
  "typography",
  "color",
  "qa",
];

/* ─── Which EdlDecision fields each pass is ALLOWED to touch ──────────────────
   A pass is a specialist; it must not bleed into another's concern. We merge
   the model's proposal onto the existing decision, but only let the whitelisted
   fields through — so a pacing pass can never silently restyle captions, and an
   audio pass can never resequence the cut. Structural fields (sceneId,
   sceneIndex, fn for non-assembly passes) are NON-negotiable and forced to the
   existing truth, mirroring how edl.ts re-aligns model output to real scenes. */
const PASS_FIELDS: Record<PassName, (keyof z.infer<typeof EdlDecision>)[]> = {
  // Assembly owns the spine: function tags, keep/drop, and the editorial intent.
  assembly: ["fn", "keep", "intent", "rationale"],
  // Pacing owns durations + which beats punch.
  pacing: ["pacingSec", "emphasis", "rationale"],
  // Emotion owns where things breathe (mix) and how beats join (transition).
  emotion: ["transitionIn", "mixIntent", "emphasis", "rationale"],
  // Visual owns footage + on-screen motion.
  visual: ["brollIntent", "motionIntent", "rationale"],
  // Audio owns the mix bus (duck/balance/fades), expressed as mixIntent.
  audio: ["mixIntent", "rationale"],
  // Typography owns captions + on-screen text legibility intent.
  typography: ["captionIntent", "rationale"],
  // Color owns the grade direction.
  color: ["colorIntent", "rationale"],
  // QA tweaks are applied deterministically (not by this whitelist) below.
  qa: ["pacingSec", "emphasis", "transitionIn", "captionIntent", "mixIntent", "colorIntent", "rationale"],
};

/* The clamp the spine uses for the one free numeric a pass might emit. Kept in
   sync with edl.ts (SCENE_MIN/MAX) so a pass can't push pacing out of range
   before the bridge re-clamps it anyway — belt and suspenders. */
const SCENE_MIN_SEC = 2;
const SCENE_MAX_SEC = 14;
const clampSec = (n: number) => Math.max(SCENE_MIN_SEC, Math.min(SCENE_MAX_SEC, Number(n.toFixed(2))));

/* A pass-scoped specialist instruction: what THIS editor cares about, and the
   ONLY thing they're permitted to change. Grounded later in brief + concept +
   taste so every pass speaks the same creative language. */
const PASS_BRIEFING: Record<PassName, string> = {
  assembly:
    "You are the ASSEMBLY editor. Lock the story SPINE only — no effects, no styling. " +
    "For each scene confirm its narrative function (fn) and whether it earns its place " +
    "(keep=false to trim weak/redundant beats; the hook must open, a cta must close). " +
    "Refine `intent` to one tight clause naming what the beat does for the story. " +
    "Do NOT set pacing, transitions, b-roll, mix, color, or captions here.",
  pacing:
    "You are the PACING editor. Set `pacingSec` per scene so the rhythm breathes: the " +
    "hook lands inside the brief's hook window, dead air is cut, and the rhythm VARIES " +
    "(don't make every beat the same length — quicken transitions, hold beats where text " +
    "must be read). Mark `emphasis=true` on ONLY the 1-2 emotional PEAK beats. " +
    "Touch ONLY pacingSec and emphasis.",
  emotion:
    "You are the EMOTION editor. Shape the feeling curve. Decide where the cut should " +
    "BREATHE vs drive: set `mixIntent` like 'let silence breathe' on a reflective beat or " +
    "'music swells' on a peak. Choose the entry `transitionIn` that serves the emotional " +
    "join (a hard cut for tension, a soft fade for a release). Confirm `emphasis` on the " +
    "true peak. Touch ONLY transitionIn, mixIntent, and emphasis — not pacing or visuals.",
  visual:
    "You are the VISUAL editor. Give each scene visual interest. Where b-roll fits, write a " +
    "concrete `brollIntent` (what the footage should literally SHOW, serving the line). Add " +
    "`motionIntent` for subtle, premium movement (e.g. 'slow ken-burns push in', 'gentle pan " +
    "right') — never a lurch, and never motion with nothing to say. " +
    "Touch ONLY brollIntent and motionIntent.",
  audio:
    "You are the AUDIO/MIX editor. Set `mixIntent` so the voice is always intelligible: duck " +
    "music under VO, balance levels, fade in/out cleanly, and let silence land where the " +
    "emotion pass asked for it. Be specific ('duck music hard under VO', 'music up to drive the " +
    "outro'). Touch ONLY mixIntent.",
  typography:
    "You are the TYPOGRAPHY editor. Make every word legible on a phone. Set `captionIntent` " +
    "naming the caption style (e.g. 'punchy word-by-word', 'one clean phrase at a time', " +
    "'premium glow') and WHICH words to accent (quote them: \"like this\"). Keep it readable: " +
    "no tiny or low-contrast text. Touch ONLY captionIntent.",
  color:
    "You are the COLOR editor. Hold ONE consistent grade/mood across the whole cut that " +
    "expresses the concept's palette. Set `colorIntent` per scene as a short grade direction " +
    "(e.g. 'high-contrast punchy', 'soft cinematic muted', 'cool teal shadows'). Keep it " +
    "consistent scene-to-scene — no jarring shifts. Touch ONLY colorIntent.",
  qa:
    "You are the QA editor. (This pass is driven by the deterministic self-review, not by you.)",
};

/* Build the EDL-decision table the brain edits, scoped to the fields this pass
   owns so the model sees exactly the surface it's allowed to change. */
function decisionTable(edl: Edl, pass: PassName): string {
  const fields = PASS_FIELDS[pass];
  return edl.decisions
    .map((d) => {
      const shown: Record<string, unknown> = { sceneIndex: d.sceneIndex, sceneId: d.sceneId, fn: d.fn };
      for (const f of fields) if (f !== "rationale" && (d as any)[f] != null) shown[f] = (d as any)[f];
      return JSON.stringify(shown);
    })
    .join("\n");
}

/* Merge a pass's proposals back onto the EDL, letting ONLY this pass's fields
   through (plus a structural re-align to the real scenes). Returns the new
   decisions array + a human list of what changed, so the PassRecord is honest.
   Mirrors edl.ts: index by sceneIndex (fallback sceneId), force structural
   fields, clamp the one free numeric. */
function mergePass(
  edl: Edl,
  pass: PassName,
  proposed: z.infer<typeof EdlDecision>[],
): { decisions: z.infer<typeof EdlDecision>[]; changed: string[] } {
  const allowed = new Set<string>(PASS_FIELDS[pass]);
  // Assembly is the only pass permitted to retag `fn`; every other pass treats
  // the existing function as ground truth so it can't accidentally restructure.
  const canRetagFn = pass === "assembly";

  const byIndex = new Map<number, z.infer<typeof EdlDecision>>();
  const byId = new Map<string, z.infer<typeof EdlDecision>>();
  for (const p of proposed) {
    if (Number.isInteger(p.sceneIndex)) byIndex.set(p.sceneIndex, p);
    if (p.sceneId) byId.set(p.sceneId, p);
  }

  const changed: string[] = [];
  const decisions = edl.decisions.map((base) => {
    const p = byIndex.get(base.sceneIndex) ?? byId.get(base.sceneId);
    if (!p) return base; // model skipped this scene — keep it untouched

    // Start from the existing decision; overlay ONLY the whitelisted fields.
    const next: Record<string, unknown> = { ...base };
    for (const [k, v] of Object.entries(p)) {
      if (v == null) continue;
      if (k === "fn" && !canRetagFn) continue; // only assembly retags function
      if (!allowed.has(k) && k !== "fn") continue;
      // Clamp the one free numeric a pass might emit before it hits the bridge.
      if (k === "pacingSec" && typeof v === "number") {
        const c = clampSec(v);
        if (Math.abs(c - Number((base as any).pacingSec ?? 0)) > 0.01) changed.push(`scene ${base.sceneIndex}: ${k} → ${c}`);
        next[k] = c;
        continue;
      }
      if (JSON.stringify((base as any)[k]) !== JSON.stringify(v)) {
        changed.push(`scene ${base.sceneIndex}: ${k}${typeof v === "string" ? ` → ${String(v).slice(0, 48)}` : k === "keep" || k === "emphasis" ? ` ${v ? "on" : "off"}` : ""}`);
      }
      next[k] = v;
    }

    // Structural fields are non-negotiable — force the truth so a hallucinated
    // id/index can never desync the bridge.
    next.sceneId = base.sceneId;
    next.sceneIndex = base.sceneIndex;
    if (!canRetagFn) next.fn = base.fn;

    // Re-parse at the boundary so a malformed merge is rejected (and the base
    // kept) rather than poisoning the EDL.
    try {
      return EdlDecision.parse(next);
    } catch {
      return base;
    }
  });

  return { decisions, changed };
}

/* ─── runPass ────────────────────────────────────────────────────────────────
   Run ONE editorial pass over a run's EDL and bridge it onto the storyboard.
   Conservative + reversible: refines only this pass's concern, never throws on a
   single bad decision, and always leaves the cut renderable. */
export async function runPass(id: string, pass: PassName): Promise<PassRecord> {
  const item = loadItem(id);

  // Ensure the editorial spine exists. buildEdl is itself fail-open (a missing
  // storyboard yields an empty spine), so we never throw here.
  if (!item.edl || !item.edl.decisions?.length) {
    await buildEdl(id);
  }
  // Re-load so we operate on the persisted, freshest EDL (buildEdl saved it).
  let edl = loadItem(id).edl;
  if (!edl || !edl.decisions.length) {
    // Nothing to edit (no scenes yet). Record a no-op pass honestly.
    const rec: PassRecord = { pass, at: nowIso(), summary: `${pass}: no scenes to edit`, changed: [] };
    const it = loadItem(id);
    (it.edl ??= { decisions: [], passLog: [], updatedAt: nowIso() } as Edl).passLog.push(rec);
    it.edl.updatedAt = nowIso();
    saveItem(it);
    return rec;
  }

  // QA is special: it is driven by the deterministic self-review, not a free
  // specialist edit. Handle it on its own path.
  if (pass === "qa") return runQaPass(id);

  // COLOR is special (M5, roadmap §4.1): the colorist is a CLOSED LOOP grounded
  // in real ffmpeg scopes, not a prose vibe. It reads the per-scene scope table
  // (luma P50 / clip% / WB bias), solves a per-scene grade in closed form toward
  // balanced exposure + neutral-or-stylized WB + scene-to-scene consistency,
  // writes it through the bridge tools (clamped, locked-safe), and learns the
  // channel's colour band. Fail-open: no render → a deterministic palette seed.
  if (pass === "color") {
    try {
      const r = await colorPass(id);
      return appendPass(id, colorPassRecord(r));
    } catch (e) {
      // Never let the colour pass abort the loop — record an honest no-op.
      return appendPass(id, { pass: "color", at: nowIso(), summary: `color: skipped (${e instanceof Error ? e.message : String(e)})`, changed: [] });
    }
  }

  // AUDIO is special (M9, roadmap §4.3): the mixer is a CLOSED LOOP grounded in
  // real ebur128 meters, not a prose vibe. It reads the loudness meters
  // (integrated LUFS / true-peak / LRA / per-region RMS), diagnoses vs targets
  // (level on target, VO ≥ ~9 LU over the bed, peaks ≤ -1 dBTP, dynamics not
  // crushed), solves a concrete mix in closed form, writes it through the
  // clamped/locked-safe mix layer, optionally re-verifies with a skip-on-worsen
  // guard, and learns the channel's loudness band. Fail-open: no meters → a
  // sensible default duck + loudness target.
  if (pass === "audio") {
    try {
      const r = await audioPass(id);
      return appendPass(id, audioPassRecord(r));
    } catch (e) {
      // Never let the mixer abort the loop — record an honest no-op.
      return appendPass(id, { pass: "audio", at: nowIso(), summary: `audio: skipped (${e instanceof Error ? e.message : String(e)})`, changed: [] });
    }
  }

  // ── Observed evidence: the perception→judgment backbone ──
  // Deterministic per-scene read/speak budgets (always available) plus render
  // diagnostics when a render exists. Injected into the prompt so the specialist
  // edits what's OBSERVABLE, and used below as a hard pacing floor. Fail-open.
  const sig = await editSignals(id).catch(() => null);

  // ── Footage understanding (Pillar 5): for an INGESTED run the real evidence is
  // the deep-understanding index (transcript / shots / dead-air / highlights),
  // not the generated-storyboard signals. Inject its compact digest so a footage
  // pass edits against what's actually IN the video. Absent on generated runs. ──
  const understanding = item.understanding ? safeUnderstandingSummary(item.understanding) : "";

  // ── Specialist edit for this pass ──
  const genome = genomeContextSafe(item.channel);
  let taste = "";
  try {
    taste = item.channel ? tasteContext(item.channel) : "";
  } catch {
    taste = "";
  }
  const brief = item.brief;
  const concept = (item.concepts ?? []).find((c) => c.id === item.chosenConcept);
  const fields = PASS_FIELDS[pass].filter((f) => f !== "rationale");

  const prompt = [
    PASS_BRIEFING[pass],
    "",
    brief ? `BRIEF:\n${JSON.stringify({ purpose: brief.purpose, platform: brief.platform, feeling: brief.feeling, hookWindowSec: brief.hookWindowSec, doNots: brief.doNots })}` : "BRIEF: (none — infer a tasteful default)",
    "",
    concept
      ? `CHOSEN CONCEPT:\n${JSON.stringify({ name: concept.name, style: concept.style, pacing: concept.pacing, paletteIntent: concept.paletteIntent, typographyIntent: concept.typographyIntent, transitionIntent: concept.transitionIntent, soundIntent: concept.soundIntent })}`
      : "CHOSEN CONCEPT: (none — hold one coherent direction across every scene)",
    "",
    genome ? `${genome}\n` : "",
    taste ? `${taste}\n` : "",
    sig ? `${signalsSummary(sig)}\n` : "",
    understanding ? `${understanding}\n` : "",
    "CURRENT DECISIONS (one per scene, in order — refine ONLY this pass's fields):",
    decisionTable(edl, pass),
    "",
    `Return ONLY JSON: {"decisions":[{"sceneIndex","sceneId",${fields.map((f) => `"${f}"`).join(",")}}]}.`,
    "Return one entry per scene you change (you may omit scenes you'd leave as-is).",
    "Keep every change CONSERVATIVE and reversible — touch nothing outside your concern.",
  ]
    .filter(Boolean)
    .join("\n");

  let proposed: z.infer<typeof EdlDecision>[] = [];
  try {
    // A loose schema so partial per-pass proposals (only this pass's fields)
    // parse cleanly; mergePass re-validates each merged decision strictly.
    const { data } = await think(
      z.object({ decisions: z.array(EdlDecision.partial().extend({ sceneIndex: z.number().int() })) }),
      prompt,
      "smart",
      2,
      `edit_pass_${pass}`,
    );
    proposed = data.decisions as z.infer<typeof EdlDecision>[];
  } catch {
    // Brain unavailable — a no-op pass is a valid outcome; the cut stays as-is.
    proposed = [];
  }

  const { decisions, changed } = mergePass(edl, pass, proposed);

  // DETERMINISTIC PACING FLOOR — the pacing editor may chase rhythm and cut a
  // beat below what a viewer needs to actually read its text or hear its line.
  // We never allow that: clamp each pacingSec up to the scene's observed
  // recommendMinSec. This is judgment grounded in measurement, not the model's
  // taste — the LLM proposes rhythm, the read/speak budget sets the floor.
  if (pass === "pacing" && sig) {
    for (const d of decisions) {
      const s = sig.scenes.find((x) => x.sceneIndex === d.sceneIndex);
      if (s && d.pacingSec != null && d.pacingSec < s.recommendMinSec) {
        const floored = clampSec(Math.max(d.pacingSec, s.recommendMinSec));
        if (Math.abs(floored - d.pacingSec) > 0.01) {
          changed.push(`scene ${d.sceneIndex}: pacing floor → ${floored}s (needs ${s.recommendMinSec}s to read/hear)`);
          d.pacingSec = floored;
        }
      }
    }
  }

  // Persist the refined EDL (preserving prior pass history), then BRIDGE it.
  const it = loadItem(id);
  it.edl = { ...edl, decisions, updatedAt: nowIso() };
  saveItem(it);

  // Project intent → concrete, clamped storyboard/mix params. The bridge reports
  // exactly what it touched (and what it skipped, e.g. locked scenes).
  let bridged: string[] = [];
  try {
    bridged = applyEdlToStoryboard(id).changed;
  } catch (e) {
    bridged = [`bridge skipped (${e instanceof Error ? e.message : String(e)})`];
  }

  // VISUAL is also where the CLOSED-LOOP COMPOSITOR runs (M15, roadmap §4.4): after
  // the visual specialist sets b-roll/motion intent, the compositor PERCEIVES the
  // cut (editor_video_evidence — dense frames + pixel metrics + motion + OCR),
  // DIAGNOSES measured visual deficiencies (flat/empty frames, busy bg under text,
  // an inert hero beat, a subject lost in the frame), and PROPOSES restrained,
  // DNA-biased per-scene EffectGraphs (scene.style.comp) through the same clamped,
  // locked-safe bridge — learning durable look prefs into taste. Fail-open: it never
  // throws and never blocks the visual pass; a no-op when nothing is warranted.
  let compNotes: string[] = [];
  if (pass === "visual") {
    try {
      const cr = await compositingPass(id);
      if (cr.scenesComposited > 0 || cr.mode === "dna_default") {
        compNotes = [
          `compositing: ${cr.mode === "dna_default" ? "DNA-default global wash" : `${cr.scenesComposited} scene(s) composited`}`,
          ...cr.reasons,
          ...cr.reverted,
        ];
      }
    } catch (e) {
      compNotes = [`compositing: skipped (${e instanceof Error ? e.message : String(e)})`];
    }
  }

  // The PassRecord summary names what this specialist did + how it landed.
  const summary =
    changed.length || bridged.length || compNotes.length
      ? `${pass}: refined ${changed.length} decision field(s), ${bridged.length} storyboard change(s)${compNotes.length ? `, composited ${compNotes.length - 1 > 0 ? compNotes.length - 1 : 0} look(s)` : ""}`
      : `${pass}: reviewed — no change needed`;

  return appendPass(id, { pass, at: nowIso(), summary, changed: [...changed, ...bridged, ...compNotes] });
}

/* ─── QA pass ─────────────────────────────────────────────────────────────────
   Run the self-review, then translate ONLY its HIGH-severity fixes into light,
   deterministic decision tweaks (no big rewrites), and re-bridge. We trust the
   located fixes from review.ts (which are grounded in real render evidence) and
   apply the smallest safe nudge that addresses each one. */
async function runQaPass(id: string): Promise<PassRecord> {
  // reviewCut is fail-open and appends to item.reviews; tag it as the qa pass.
  let review: Awaited<ReturnType<typeof reviewCut>> | null = null;
  try {
    review = await reviewCut(id, { pass: "qa" });
  } catch {
    review = null;
  }

  const it = loadItem(id);
  const edl = it.edl;
  if (!edl || !review) {
    return appendPass(id, { pass: "qa", at: nowIso(), summary: "qa: review unavailable — no change", changed: [] });
  }

  // Compound the brand's editing TASTE from this review: recurring/high-severity
  // editorial fixes become durable do-nots/rules so the next cut starts smarter.
  // Fire-and-forget, fail-open — taste learning must never block the QA pass.
  if (it.channel) {
    try {
      await learnTasteFromReview(it.channel, review);
    } catch {
      /* taste learning is best-effort */
    }
  }

  const highFixes = (review.fixes ?? []).filter((f) => f.severity === "high");
  const changed: string[] = [];

  // Map each high-severity fix to a small, deterministic decision tweak located
  // by its `where` (a scene number when present; otherwise treated as global).
  for (const fix of highFixes) {
    const sceneIdx = parseSceneIndex(fix.where);
    const text = `${fix.issue} ${fix.action}`.toLowerCase();

    const applyTo = (d: z.infer<typeof EdlDecision>) => {
      // Audio defect (silence / hot / muddy / drowned voice) → force a clean duck.
      if (/\b(silence|silent|audio|loud|hot|quiet|music|voice|narration|mix|drown)\b/.test(text)) {
        d.mixIntent = "duck music hard under VO; balance levels, clean fades";
        changed.push(`scene ${d.sceneIndex}: qa mix fix (duck under VO)`);
      }
      // Readability defect → enforce a legible caption preset + steer larger text.
      if (/\b(read|legib|caption|subtitle|text|small|contrast|illegible)\b/.test(text)) {
        d.captionIntent = "clean legible captions, high contrast, comfortably large";
        changed.push(`scene ${d.sceneIndex}: qa readability fix (legible captions)`);
      }
      // Pacing defect (too long / dead air / drags) → tighten this beat a notch.
      if (/\b(pacing|slow|drag|long|dead air|trim|tighten|lull)\b/.test(text) && d.pacingSec != null) {
        const tightened = clampSec(d.pacingSec * 0.85);
        if (tightened < d.pacingSec) {
          d.pacingSec = tightened;
          changed.push(`scene ${d.sceneIndex}: qa pacing fix (tighten → ${tightened}s)`);
        }
      }
      // Freeze / black-frame / hard-cut defect → soften the join with a fade.
      if (/\b(freeze|frozen|black frame|jarring|abrupt|harsh cut)\b/.test(text)) {
        if (d.transitionIn !== "fade") {
          d.transitionIn = "fade";
          changed.push(`scene ${d.sceneIndex}: qa transition fix (soften to fade)`);
        }
      }
    };

    if (sceneIdx != null) {
      const d = edl.decisions.find((x) => x.sceneIndex === sceneIdx);
      if (d) applyTo(d);
    } else {
      // Global fix → apply the gentlest interpretation across all decisions.
      for (const d of edl.decisions) applyTo(d);
    }
  }

  // Persist tweaked decisions and re-bridge so the fixes reach the render.
  it.edl = { ...edl, updatedAt: nowIso() };
  saveItem(it);

  let bridged: string[] = [];
  try {
    bridged = applyEdlToStoryboard(id).changed;
  } catch (e) {
    bridged = [`bridge skipped (${e instanceof Error ? e.message : String(e)})`];
  }

  const summary = `qa: ${review.verdict} (overall ${review.scores.overall.toFixed(1)}); applied ${changed.length} high-severity fix(es), ${bridged.length} storyboard change(s)`;
  return appendPass(id, { pass: "qa", at: nowIso(), summary, changed: [...changed, ...bridged] });
}

/* Parse a scene index out of a review fix's `where` locator ("scene 2",
   "Scene #2", "00:12" → null since that's a timecode, "global" → null). Returns
   the 0-based scene index when the locator names one, else null (= global). */
function parseSceneIndex(where: string | undefined): number | null {
  if (!where) return null;
  const m = /scene\s*#?\s*(\d+)/i.exec(where);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

/* Append a PassRecord to item.edl.passLog and persist atomically. Re-loads the
   item so we never clobber a concurrent write from the bridge/review. */
function appendPass(id: string, rec: PassRecord): PassRecord {
  const item = loadItem(id);
  if (!item.edl) {
    item.edl = { decisions: [], passLog: [], updatedAt: nowIso() } as Edl;
  }
  (item.edl.passLog ??= []).push(rec);
  item.edl.updatedAt = nowIso();
  logLine(item, `pass [${rec.pass}]: ${rec.summary}`);
  saveItem(item);
  return rec;
}
