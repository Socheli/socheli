import type { PassRecord, EditingTaste } from "@os/schemas";
import { loadItem, saveItem, nowIso, logLine } from "../store.ts";
import { editSignals, type MeterSignal } from "./signals.ts";
import { loadTaste, learnTaste, saveTaste } from "./taste.ts";

/* creative/audio-pass.ts — the CLOSED-LOOP mixer (DaVinci spine §4.3, M9).
 *
 * The old `audio` pass set free-text mixIntent from vibes. This is the
 * meter-grounded replacement, built to mirror the M5 color pass exactly: it
 * reads the real EBU R128 METERS off the render (editor_analyze_av →
 * diagnostics.loudness, surfaced as editSignals().evidence.meter) and solves —
 * in CLOSED FORM, not by guessing — a mix that moves the cut toward four targets:
 *
 *   1. INTEGRATED LOUDNESS — pull integrated LUFS to within ~0.5 LU of the
 *      master target (mix.loudnessTarget ?? -14). The gain delta is the MEASURED
 *      gap (target − measured), applied as a master loudness target the render
 *      normalizes to — deterministic, not a guess.
 *   2. TRUE-PEAK SAFETY — keep true-peak ≤ -1 dBTP. If the meter shows the mix
 *      hotter than the ceiling, we don't push integrated up past it.
 *   3. VO INTELLIGIBILITY — the voiced regions must sit ≥ ~9 LU over the bed.
 *      When a region is buried (per-region RMS far under the loudest/voiced
 *      region), we deepen the music duck and/or lift voice toward that margin.
 *   4. DYNAMICS PRESERVED — don't crush the loudness range. A flat wall (low
 *      LRA) gets gentle dynamics back (ease comp / reduce duck depth); we never
 *      ADD compression that would collapse LRA further.
 *
 * Every solved value is computed from the measured gap, then CLAMPED to the
 * schema band (loudnessTarget −30..−6, duck.amount 0..1, voiceVol 0..2) before
 * it can reach a render. A LOCKED voice/music track is never touched. The whole
 * pass FAILS OPEN: no meters / no render → it degrades to a sensible default
 * mixIntent (clean duck under VO), never throws. When meters exist it can
 * optionally re-verify (re-read the meters) with a skip-on-worsen guard so a
 * change that pushed LUFS/TP/LRA the wrong way is rolled back.
 *
 * It learns the channel's loudness band + VO-over-bed margin into
 * EditingTaste.mixTargets via learnTaste, so the next cut starts from this
 * brand's measured house mix. */

/* ─── Meter targets (the numbers the mixer aims for) ─────────────────────────
   These mirror the render-side master (render.ts masterAudio loudnorm I=-14:
   TP=-1.5) and the signals "VO buried" flag (≥9 LU under the voiced region). */
const DEFAULT_LUFS_TARGET = -14;   // integrated LUFS the master normalizes to (platform-typical)
const LUFS_TOL = 0.5;              // within ±0.5 LU of target = "on target" (don't chase noise)
const TP_CEILING = -1;             // true-peak must sit at or below -1 dBTP
const VO_OVER_BED_LU = 9;          // voiced regions should be ≥9 LU over the bed (intelligibility)
const LRA_FLAT = 4;                // LRA below this = a flat, over-compressed wall (give dynamics back)
const LRA_WIDE = 16;               // LRA above this = very dynamic; fine, never crush it

// Solve clamps (kept conservative so one pass can never over-correct).
const VOICE_VOL_LO = 0.85, VOICE_VOL_HI = 1.5; // VO lift band (1 = unchanged)
const DUCK_MIN = 0.3, DUCK_MAX = 0.9;          // duck depth band when we need VO over the bed
const LUFS_MIN = -30, LUFS_MAX = -6;           // schema loudnessTarget band

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
const round2 = (n: number) => Number(n.toFixed(2));
const round1 = (n: number) => Math.round(n * 10) / 10;

function safeLoadTaste(channel: string): EditingTaste | null {
  try {
    return loadTaste(channel);
  } catch {
    return null;
  }
}

/* The loudness + VO-over-bed band this run mixes toward: the brand's learned
   mixTargets when present (loadTaste), else the defaults. */
function resolveTargets(channel: string | undefined): { lufs: number; voiceOverBedLu: number } {
  const taste = channel ? safeLoadTaste(channel) : null;
  const mt = taste?.mixTargets;
  return {
    lufs: clamp(mt?.loudnessTarget ?? DEFAULT_LUFS_TARGET, LUFS_MIN, LUFS_MAX),
    voiceOverBedLu: clamp(mt?.voiceOverBedLu ?? VO_OVER_BED_LU, 0, 30),
  };
}

/* The VO-over-bed margin a meter currently shows: the loudest (voiced) region's
   RMS minus the median of the quieter (bed/silence) regions. RMS is dBFS-ish
   (less-negative = louder), so a positive margin means the voice sits above the
   bed. Returns undefined when there aren't enough regions to judge. */
function measureVoiceOverBed(m: MeterSignal | undefined): number | undefined {
  const regions = (m?.perRegion ?? []).filter((r) => Number.isFinite(r.rms));
  if (regions.length < 2) return undefined;
  const rms = regions.map((r) => r.rms).sort((a, b) => a - b);
  const loudest = rms[rms.length - 1]; // voiced region (loudest)
  // Median of the NON-loudest regions ≈ the bed/silence floor.
  const rest = rms.slice(0, -1);
  const mid = Math.floor(rest.length / 2);
  const bed = rest.length % 2 ? rest[mid] : (rest[mid - 1] + rest[mid]) / 2;
  return round1(loudest - bed);
}

/* The diagnose→target→intent core: from the measured meter + the targets,
   decide a CONCRETE mix delta (a loudness target, a duck depth, a voice-vol
   trim, and the prose mixIntent that summarizes it). Each axis is a measured gap
   times a fixed mapping, clamped. Returns undefined when the mix is already
   inside every band (nothing to correct). */
type MixDelta = {
  loudnessTarget?: number;
  duck?: { amount: number };
  voiceVol?: number;
  intent: string;
  reasons: string[];
  // The TP headroom we observed, so the caller can refuse a hot push.
  tpHot: boolean;
};

function solveMix(m: MeterSignal, targets: { lufs: number; voiceOverBedLu: number }, prevDuck?: number): MixDelta | undefined {
  const reasons: string[] = [];
  const intentBits: string[] = [];
  const out: MixDelta = { intent: "", reasons, tpHot: false };

  const tpHot = m.truePeakDb != null && m.truePeakDb > TP_CEILING;
  out.tpHot = tpHot;

  // 1. INTEGRATED LOUDNESS — pull to within tolerance of the target. The render
  //    normalizes to mix.loudnessTarget, so when the measured integrated sits off
  //    target we simply SET the master target to the goal (the render's loudnorm
  //    closes the measured gap on the next render). If it's already on target we
  //    leave the target unset. If TP is hot AND we'd be raising loudness, we hold
  //    the target where it is — never push a clipping mix louder.
  if (m.integratedLufs != null) {
    const gap = round1(targets.lufs - m.integratedLufs); // +ve = too quiet, needs lift
    if (Math.abs(gap) > LUFS_TOL) {
      if (gap > 0 && tpHot) {
        reasons.push(`integrated ${round1(m.integratedLufs)} LUFS is ${gap} LU under target but TP ${round1(m.truePeakDb!)} dBTP is hot — hold loudness, limit peaks instead`);
        intentBits.push("hold loudness; limit true-peaks to keep headroom");
      } else {
        out.loudnessTarget = clamp(targets.lufs, LUFS_MIN, LUFS_MAX);
        reasons.push(`integrated ${round1(m.integratedLufs)} LUFS → target ${out.loudnessTarget} (${gap > 0 ? "lift" : "pull down"} ${Math.abs(gap)} LU)`);
        intentBits.push(gap > 0 ? "bring overall level up to target" : "ease overall level down to target");
      }
    }
  }

  // 2. TRUE-PEAK — independent of loudness: if peaks are hot, ask the master to
  //    keep the ceiling (the render's loudnorm TP cap does this; we surface it).
  if (tpHot) {
    intentBits.push(`keep true-peak ≤ ${TP_CEILING} dBTP`);
    reasons.push(`true-peak ${round1(m.truePeakDb!)} dBTP over ${TP_CEILING} — cap peaks`);
  }

  // 3. VO INTELLIGIBILITY — voiced regions must sit ≥ the target margin over the
  //    bed. When buried, deepen the duck toward the gap and (modestly) lift the
  //    voice. The duck delta is proportional to how far under the margin we are.
  const margin = measureVoiceOverBed(m);
  if (margin != null && margin < targets.voiceOverBedLu) {
    const deficit = targets.voiceOverBedLu - margin; // LU the VO is short of the margin
    // Map the LU deficit to a duck-depth increase: ~0.04 deeper per LU short,
    // from the previous depth (default 0.6) — gentle, monotone, clamped.
    const base = prevDuck ?? 0.6;
    const duckAmt = clamp(round2(base + deficit * 0.04), DUCK_MIN, DUCK_MAX);
    out.duck = { amount: duckAmt };
    // A small VO lift only when the deficit is real (≥3 LU short) — we'd rather
    // duck the bed than push the voice into the limiter.
    if (deficit >= 3) out.voiceVol = clamp(round2(1 + Math.min(deficit, 6) * 0.03), VOICE_VOL_LO, VOICE_VOL_HI);
    reasons.push(`VO sits only ${margin} LU over the bed (want ≥${targets.voiceOverBedLu}) → duck ${duckAmt}${out.voiceVol ? `, voice ×${out.voiceVol}` : ""}`);
    intentBits.push("duck music harder under VO so narration stays intelligible");
  }

  // 4. DYNAMICS — a flat wall (low LRA) means we've over-compressed/over-ducked;
  //    ease off so the cut breathes. We NEVER add compression here (that would
  //    collapse LRA further). If LRA is healthy/wide, leave dynamics alone.
  if (m.lra != null && m.lra < LRA_FLAT) {
    // If we were about to (or already) duck deep, pull the duck back a touch so
    // the bed isn't a flat hole; this restores some movement without burying VO.
    if (out.duck) {
      out.duck.amount = clamp(round2(out.duck.amount - 0.05), DUCK_MIN, DUCK_MAX);
    }
    reasons.push(`LRA ${round1(m.lra)} LU is a flat wall (<${LRA_FLAT}) — preserve dynamics, don't crush further`);
    intentBits.push("preserve dynamics — let the loud beats stay loud and the quiet ones quiet");
  } else if (m.lra != null && m.lra > LRA_WIDE) {
    reasons.push(`LRA ${round1(m.lra)} LU is very dynamic — fine, never crush it`);
  }

  if (!intentBits.length && out.loudnessTarget == null && !out.duck && out.voiceVol == null) return undefined;
  out.intent = intentBits.join("; ") || "clean mix: voice intelligible over the bed, level on target";
  return out;
}

/* A sensible DEFAULT mix when there are no meters to measure (the pass is still
   usable, fail-open, like color-pass's palette seed): a clean broadcast-style
   duck under VO and the brand's loudness target. Never throws. */
function defaultMixIntent(): string {
  return "duck music cleanly under VO; balance levels so the voice is always intelligible; clean fades";
}

/* Apply a solved MixDelta onto item.mix, CLAMPED + LOCKED-safe (a locked voice
   track blocks the voice-vol lift; duck/loudnessTarget are global). Returns the
   list of human-readable changes. Mirrors the bridge's discipline in edl.ts. */
function applyMix(id: string, delta: MixDelta): string[] {
  const item = loadItem(id);
  const mix: any = { ...(item.mix ?? {}) };
  const changed: string[] = [];

  if (delta.loudnessTarget != null) {
    const lufs = clamp(delta.loudnessTarget, LUFS_MIN, LUFS_MAX);
    if (mix.loudnessTarget !== lufs) {
      mix.loudnessTarget = lufs;
      changed.push(`loudness target → ${lufs} LUFS`);
    }
  }

  if (delta.duck) {
    const prev: any = mix.duck ?? {};
    const amount = clamp(delta.duck.amount, 0, 1);
    mix.duck = {
      enabled: true,
      amount,
      attack: clamp(prev.attack ?? 0.12, 0, 2),
      release: clamp(prev.release ?? 0.5, 0, 3),
    };
    changed.push(`duck music under VO → amount ${amount.toFixed(2)}`);
  }

  if (delta.voiceVol != null) {
    // Locked-safe: a locked voice track blocks a programmatic VO lift.
    const voiceLocked = Array.isArray(mix.tracks) && mix.tracks.some((t: any) => t?.id === "voice" && t?.locked);
    if (voiceLocked) {
      changed.push("voice track locked — VO lift skipped");
    } else {
      const v = clamp(delta.voiceVol, 0, 2);
      mix.voiceVol = v;
      changed.push(`voice volume → ${v.toFixed(2)}`);
    }
  }

  if (changed.length) {
    item.mix = mix;
    saveItem(item);
  }
  return changed;
}

/* Did a re-measured meter get WORSE on any tracked axis? The skip-on-worsen
   guard: we never KEEP a change that pushed integrated LUFS further from target,
   pushed true-peak hotter (or over the ceiling), or collapsed LRA. Returns the
   list of regressions (empty = the change held or improved). Mirrors
   compareDiagnostics' regression discipline in editor-tools.ts. */
function meterRegressions(before: MeterSignal, after: MeterSignal, lufsTarget: number): string[] {
  const regs: string[] = [];
  if (before.integratedLufs != null && after.integratedLufs != null) {
    const wasOff = Math.abs(before.integratedLufs - lufsTarget);
    const nowOff = Math.abs(after.integratedLufs - lufsTarget);
    if (nowOff > wasOff + LUFS_TOL) regs.push(`integrated drifted from target (${round1(wasOff)}→${round1(nowOff)} LU off)`);
  }
  if (before.truePeakDb != null && after.truePeakDb != null) {
    // Hotter peaks are a regression — especially if they cross the ceiling.
    if (after.truePeakDb > before.truePeakDb + 0.5 || (after.truePeakDb > TP_CEILING && before.truePeakDb <= TP_CEILING)) {
      regs.push(`true-peak got hotter (${round1(before.truePeakDb)}→${round1(after.truePeakDb)} dBTP)`);
    }
  }
  if (before.lra != null && after.lra != null) {
    // A meaningful LRA collapse = dynamics crushed.
    if (after.lra < before.lra - 1.5) regs.push(`dynamics collapsed (LRA ${round1(before.lra)}→${round1(after.lra)} LU)`);
  }
  return regs;
}

export type AudioPassResult = {
  ok: boolean;
  mode: "closed_loop" | "default" | "noop";
  applied: string[];
  intent: string;
  reasons: string[];
  before?: { integratedLufs?: number; truePeakDb?: number; lra?: number; voiceOverBedLu?: number };
  after?: { integratedLufs?: number; truePeakDb?: number; lra?: number; voiceOverBedLu?: number };
  reverted: boolean;
  notes: string[];
};

function meterSnapshot(m: MeterSignal | undefined): AudioPassResult["before"] {
  if (!m) return undefined;
  return {
    integratedLufs: m.integratedLufs,
    truePeakDb: m.truePeakDb,
    lra: m.lra,
    voiceOverBedLu: measureVoiceOverBed(m),
  };
}

/* ─── audioPass — the closed-loop mixer run ──────────────────────────────────
   Read meters → diagnose vs targets → solve a concrete mix → apply it (clamped,
   locked-safe) → optionally re-verify with a skip-on-worsen guard → learn the
   band into taste. Always fail-open. */
export async function audioPass(id: string, opts: { verify?: boolean } = {}): Promise<AudioPassResult> {
  const notes: string[] = [];
  const item = loadItem(id);
  const targets = resolveTargets(item.channel);

  // Read the measured meters (fail-open → null).
  const sig = await editSignals(id).catch(() => null);
  const meter = sig?.evidence.meter;

  // ── No meters → a sensible DEFAULT mix (still usable, no render). We set a
  //    clean duck + the brand's loudness target so an unmeasured cut still mixes
  //    voice-intelligible, mirroring color-pass's palette seed. ──
  if (!meter || (meter.integratedLufs == null && meter.truePeakDb == null && meter.lra == null && !(meter.perRegion && meter.perRegion.length))) {
    const intent = defaultMixIntent();
    const applied = applyMix(id, { intent, reasons: [], tpHot: false, loudnessTarget: targets.lufs, duck: { amount: 0.6 } });
    logLine(loadItem(id), `audio-pass: default mix (no meters) → ${applied.length} change(s)`);
    return {
      ok: true,
      mode: "default",
      applied,
      intent,
      reasons: ["no loudness meters yet (no render / ffmpeg without ebur128) — applied a clean default duck + loudness target"],
      reverted: false,
      notes: ["mixed from defaults; re-run after a render for the meter-driven closed loop"],
    };
  }

  // ── Diagnose vs targets → a concrete mix delta. ──
  const before = meterSnapshot(meter);
  const prevDuck = (item.mix as any)?.duck?.amount;
  const delta = solveMix(meter, targets, typeof prevDuck === "number" ? prevDuck : undefined);

  if (!delta) {
    // Already inside every band — nothing to correct. Learn the band anyway so
    // taste captures a cut that already mixes on target.
    if (item.channel) await learnChannelMixTargets(item.channel, meter, targets).catch(() => {});
    logLine(loadItem(id), `audio-pass: on target (I=${round1(meter.integratedLufs ?? NaN)} TP=${round1(meter.truePeakDb ?? NaN)} LRA=${round1(meter.lra ?? NaN)}) — no change`);
    return {
      ok: true,
      mode: "noop",
      applied: [],
      intent: "mix already on target — voice intelligible, level + peaks + dynamics in band",
      reasons: [],
      before,
      after: before,
      reverted: false,
      notes: ["meters already inside every target band"],
    };
  }

  // ── Apply (clamped, locked-safe). ──
  const applied = applyMix(id, delta);

  // ── Optional VERIFY: re-read the meters and ROLL BACK on worsen. The applied
  //    mix only changes the meters on a RE-RENDER (the existing video is
  //    unchanged), so without one this re-read reflects the SAME frames — we
  //    report it transparently and only revert when a real regression shows. ──
  let after = before;
  let reverted = false;
  if (opts.verify && applied.length) {
    const sig2 = await editSignals(id).catch(() => null);
    const meter2 = sig2?.evidence.meter;
    if (meter2) {
      after = meterSnapshot(meter2);
      const regs = meterRegressions(meter, meter2, targets.lufs);
      if (regs.length) {
        // Skip-on-worsen: restore the prior mix block (re-load the pre-apply
        // values from `item.mix` is lossy, so we re-apply the inverse: clear the
        // loudnessTarget back to the prior, restore prior duck). We keep it
        // simple + safe — revert the loudnessTarget/duck/voiceVol we just set.
        revertMix(id, item.mix, delta);
        reverted = true;
        notes.push(`reverted (verify): ${regs.join("; ")}`);
      } else {
        notes.push("verify: no meter regression");
      }
    } else {
      notes.push("verify: meters unavailable on re-read (re-render to measure)");
    }
  }

  // ── Learn the channel's measured loudness band + VO-over-bed margin. ──
  if (item.channel && !reverted) {
    try {
      await learnChannelMixTargets(item.channel, meter, targets);
    } catch {
      /* taste learning is best-effort and must never fail the pass */
    }
  }

  logLine(
    loadItem(id),
    `audio-pass: ${reverted ? "reverted" : `applied ${applied.length} change(s)`} toward I=${targets.lufs} LUFS, VO≥${targets.voiceOverBedLu} LU`,
  );
  return {
    ok: true,
    mode: "closed_loop",
    applied: reverted ? [] : applied,
    intent: delta.intent,
    reasons: delta.reasons,
    before,
    after,
    reverted,
    notes,
  };
}

/* Roll back the just-applied mix delta to the pre-apply values. We snapshot the
   prior mix block before applyMix mutated it (passed as `prior`) and restore only
   the axes this delta touched — leaving everything else intact. Fail-open. */
function revertMix(id: string, prior: any, delta: MixDelta): void {
  try {
    const item = loadItem(id);
    const mix: any = { ...(item.mix ?? {}) };
    if (delta.loudnessTarget != null) {
      if (prior?.loudnessTarget != null) mix.loudnessTarget = prior.loudnessTarget;
      else delete mix.loudnessTarget;
    }
    if (delta.duck) {
      if (prior?.duck) mix.duck = prior.duck;
      else delete mix.duck;
    }
    if (delta.voiceVol != null) {
      if (prior?.voiceVol != null) mix.voiceVol = prior.voiceVol;
      else delete mix.voiceVol;
    }
    item.mix = mix;
    saveItem(item);
  } catch {
    /* fail-open: a failed revert must never break the pass */
  }
}

/* Compound the channel's measured mix band into EditingTaste.mixTargets: the
   integrated loudness the brand actually ships at and the VO-over-bed margin its
   cuts kept. We blend toward the existing learned target (so it converges, not
   jitters) and never write a band outside a sane floor. Mirrors
   color-pass's learnChannelColorTargets exactly. */
async function learnChannelMixTargets(
  channel: string,
  meter: MeterSignal,
  targets: { lufs: number; voiceOverBedLu: number },
): Promise<void> {
  const margin = measureVoiceOverBed(meter);
  const taste = loadTaste(channel);
  const prev = taste.mixTargets ?? {};
  // Converge toward the new measurement (half-step) so taste sharpens, not flips.
  const blend = (a: number | undefined, b: number, k = 0.5) => round2(a == null ? b : a + (b - a) * k);
  // The brand's loudness target follows the resolved target (it's the goal we
  // mixed to), recorded so the band persists once measured.
  const learnedLufs = clamp(blend(prev.loudnessTarget, targets.lufs), LUFS_MIN, LUFS_MAX);
  // The VO-over-bed margin learns from what this cut actually achieved (when
  // measurable), clamped to a sane intelligibility floor.
  const learnedMargin =
    margin != null ? clamp(blend(prev.voiceOverBedLu, Math.max(margin, VO_OVER_BED_LU)), 0, 30) : prev.voiceOverBedLu ?? targets.voiceOverBedLu;
  taste.mixTargets = {
    loudnessTarget: learnedLufs,
    voiceOverBedLu: round1(learnedMargin),
    note: `learned from meters (I=${round1(meter.integratedLufs ?? NaN)} LUFS${margin != null ? `, VO+${margin} LU over bed` : ""})`,
  };
  // learnTaste re-loads + saves taste itself, which would DROP the mixTargets we
  // just set; persist them first via taste's own atomic save, then learnTaste
  // merges the rule onto the now-on-disk targets (same dance as color-pass).
  saveTasteWithTargets(taste);
  await learnTaste(channel, {
    rule: `master to ≈${learnedLufs} LUFS with the voice ≥${round1(learnedMargin)} LU over the bed (the brand's measured mix)`,
    pref: { sound: `voice intelligible over the bed; master ≈${learnedLufs} LUFS; let dynamics breathe` },
    source: "review",
  });
}

function saveTasteWithTargets(taste: EditingTaste): void {
  try {
    saveTaste(taste);
  } catch {
    /* fail-open: a bad taste write must never break the audio pass */
  }
}

/* A compact PassRecord for the passes.ts `audio` slot. */
export function audioPassRecord(r: AudioPassResult): PassRecord {
  const summary =
    r.mode === "closed_loop"
      ? r.reverted
        ? `audio: closed-loop mix reverted (a change worsened the meters) — held the prior mix`
        : `audio: closed-loop mix → ${r.applied.length} change(s) toward target loudness / VO-over-bed / dynamics`
      : r.mode === "default"
        ? "audio: default mix (no meters yet) — clean duck + loudness target"
        : "audio: meters already on target — no change";
  return { pass: "audio", at: nowIso(), summary, changed: [...r.applied, ...r.reasons, ...r.notes] };
}
