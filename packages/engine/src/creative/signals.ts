/* creative/signals.ts — the perception→judgment backbone.
 *
 * A senior editor's cuts are justified by what they OBSERVE, not taste alone
 * (the editor role's own discipline rule). This module turns a run into
 * structured EDIT SIGNALS the passes consult before they act:
 *   - deterministic per-scene read/speak budgets (is the text on screen long
 *     enough to actually read / hear?) — no LLM, always available,
 *   - best-effort render EVIDENCE (silence, freezes, black frames, scene
 *     changes, readability flags) pulled from the editor_* analysis tools when a
 *     render exists — fail-open when it doesn't.
 *
 * Passes inject signalsSummary() into their specialist prompts and use
 * recommendMinSec as a hard floor so an LLM can never leave text un-readable. */

import { loadItem } from "../store.ts";
import { callEditorTool } from "../editor-tools.ts";

// Premium VO cadence ≈ 2.6 words/sec; legible on-screen reading ≈ 16 chars/sec.
// These are the budgets a viewer needs — durations below them mean "too fast".
const WORDS_PER_SEC = 2.6;
const CHARS_PER_SEC = 16;

export type SceneSignal = {
  sceneIndex: number;
  sceneId: string;
  type: string;
  durationSec: number;
  sayWords: number;
  sayChars: number;
  onScreenChars: number;
  readTimeSec: number; // time needed to read the on-screen text
  speakTimeSec: number; // time needed to speak `say`
  tooFast: boolean; // duration below what the viewer needs
  deadAir: boolean; // duration far beyond what the content needs
  recommendMinSec: number; // deterministic floor for legibility / VO
};

/* MIXER METERS (M6, roadmap §4.3): the real loudness picture the audio pass
   grades against — integrated LUFS vs the -14 target, true-peak headroom, the
   loudness range (dynamics, not a flat wall), and per-scene RMS so a beat
   sitting far under the VO is visible. Read from diagnostics.loudness; absent /
   NaN when ffmpeg lacks ebur128 (fail-open). */
export type MeterSignal = {
  integratedLufs?: number;
  truePeakDb?: number;
  lra?: number;
  perRegion?: { startSec: number; endSec: number; rms: number }[];
};

/* COLORIST SCOPES (M3, roadmap §4.1): the per-scene exposure + white-balance
   picture the color pass grades against, read off a render via
   editor_color_scopes. Per scene: a coarse luma distribution (P5/P50/P95), a
   clip risk at each rail, and a white-balance bias (warm = red-over-blue, green
   = tint). consistency carries the scene-to-scene spread the colorist's main job
   is to flatten. Absent / fields NaN when no render or no ebur-grade evidence
   (fail-open). */
export type ScopeSceneSignal = {
  sceneIndex: number;
  type: string;
  lumaP5?: number;
  lumaP50?: number;
  lumaP95?: number;
  clipLowPct?: number;
  clipHighPct?: number;
  warmBias?: number;
  greenBias?: number;
};
export type ScopeSignal = {
  scenes: ScopeSceneSignal[];
  consistency?: { lumaSpread: number; warmSpread: number };
  contactSheet?: string;
};

export type EvidenceSignal = {
  hasRender: boolean;
  silences?: { start: number; end: number }[];
  freezes?: number;
  blackFrames?: number;
  sceneChanges?: number;
  meanDb?: number;
  meter?: MeterSignal;
  scope?: ScopeSignal;
  readabilityFlags?: string[];
  notes: string[];
};

// The mixer's master target: -14 LUFS integrated (the platform-typical loudness
// the existing render-side loudnorm already aims at). Used only to label how far
// the measured integrated loudness sits from target in the summary.
const LUFS_TARGET = -14;

export type EditSignals = {
  scenes: SceneSignal[];
  evidence: EvidenceSignal;
  totalSec: number;
  arc: string[];
};

/* Per-scene floor: the longest of (speak VO + breath), (read on-screen text),
   and a scene-type minimum so structural beats still land. */
function sceneTypeFloor(type: string): number {
  if (/hook/.test(type)) return 1.6;
  if (/cta/.test(type)) return 2.0;
  if (/(quote|terminal|code|chart|diagram|timeline|compare|stats|bento|warning|before_after|section)/.test(type)) return 2.2;
  return 1.2;
}

/* Keys that are NOT on-screen prose: ids, formatting, the b-roll search query,
   the spoken line (budgeted separately), overlays/style sub-trees. Everything
   else that is a string leaf counts as text the viewer must read. */
const NON_TEXT_KEYS = new Set(["id", "type", "say", "style", "broll", "overlays", "emphasis", "hidden", "locked", "durationSec", "accent", "src", "href", "kind", "ease", "prop", "align", "transition", "transitionEase", "textCase", "color"]);

function collectVisibleChars(node: any, key?: string, depth = 0): number {
  if (depth > 6 || node == null) return 0;
  if (key && NON_TEXT_KEYS.has(key)) return 0;
  if (typeof node === "string") {
    // ignore hex colors / urls / pure tokens — they aren't readable prose
    if (/^#?[0-9a-fA-F]{3,8}$/.test(node) || /^https?:\/\//.test(node)) return 0;
    return node.trim().length;
  }
  if (Array.isArray(node)) return node.reduce((a, v) => a + collectVisibleChars(v, undefined, depth + 1), 0);
  if (typeof node === "object") {
    let sum = 0;
    for (const [k, v] of Object.entries(node)) sum += collectVisibleChars(v, k, depth + 1);
    return sum;
  }
  return 0;
}

function wordCount(s?: string): number {
  if (!s) return 0;
  return s.trim().split(/\s+/).filter(Boolean).length;
}

/* Pull the render-evidence diagnostics, fail-open. The shapes mirror
   editor_analyze_av / editor_readability_review (see editor-tools.ts). */
async function gatherEvidence(id: string): Promise<EvidenceSignal> {
  const ev: EvidenceSignal = { hasRender: false, notes: [] };
  try {
    const av = await callEditorTool("editor_analyze_av", { id });
    if (av?.ok && av.data) {
      // The AV diagnostics are nested under data.diagnostics (waveformPath,
      // volume, silence, freezes, blackFrames, sceneChanges); fall back to the
      // top level for forward-compat if that ever flattens.
      const d: any = (av.data as any).diagnostics ?? av.data;
      ev.hasRender = true;
      if (Array.isArray(d.silence)) ev.silences = d.silence.map((s: any) => ({ start: Number(s.start ?? s.silence_start ?? 0), end: Number(s.end ?? s.silence_end ?? 0) }));
      ev.freezes = Array.isArray(d.freezes) ? d.freezes.length : undefined;
      ev.blackFrames = Array.isArray(d.blackFrames) ? d.blackFrames.length : undefined;
      ev.sceneChanges = Array.isArray(d.sceneChanges) ? d.sceneChanges.length : undefined;
      ev.meanDb = typeof d.volume?.meanDb === "number" && !Number.isNaN(d.volume.meanDb) ? d.volume.meanDb : undefined;
      // Loudness meters (M6) live under diagnostics.loudness; keep only finite
      // numbers (ffmpeg without ebur128 fails open to NaN) so the summary never
      // prints garbage. A scalar that's missing simply stays undefined.
      const lo: any = d.loudness;
      if (lo) {
        const fin = (n: any) => (typeof n === "number" && Number.isFinite(n) ? n : undefined);
        const perRegion = Array.isArray(lo.perRegion)
          ? lo.perRegion
              .map((r: any) => ({ startSec: Number(r.startSec), endSec: Number(r.endSec), rms: Number(r.rms) }))
              .filter((r: any) => Number.isFinite(r.startSec) && Number.isFinite(r.endSec))
          : undefined;
        const meter: any = {
          integratedLufs: fin(lo.integratedLufs),
          truePeakDb: fin(lo.truePeakDb),
          lra: fin(lo.lra),
          ...(perRegion && perRegion.length ? { perRegion } : {}),
        };
        // Only attach the meter block if at least one field is real.
        if (meter.integratedLufs != null || meter.truePeakDb != null || meter.lra != null || meter.perRegion) {
          ev.meter = meter;
        }
      }
    }
  } catch (e) {
    ev.notes.push(`av evidence failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  try {
    const rr = await callEditorTool("editor_readability_review", { id });
    if (rr?.ok && rr.data) {
      // Per-scene readability lives under data.review.scenes[]; each entry is
      // { scene:{index,...}, issues:[{severity,reason}] }. There's also a
      // top-level review.issues. Pull both, fail-open on any shape drift.
      const review: any = (rr.data as any).review ?? rr.data;
      const scenes: any[] = review.scenes ?? review.results ?? [];
      const flags: string[] = [];
      for (const s of Array.isArray(scenes) ? scenes : []) {
        const idx = s.scene?.index ?? s.index ?? s.sceneIndex ?? "?";
        for (const iss of s.issues ?? []) {
          if (iss?.reason) flags.push(`s${idx}: ${iss.reason}`);
        }
      }
      for (const iss of review.issues ?? []) {
        if (typeof iss === "string") flags.push(iss);
        else if (iss?.reason) flags.push(iss.reason);
      }
      if (flags.length) ev.readabilityFlags = flags.slice(0, 12);
      if (!ev.hasRender && (scenes.length || flags.length)) ev.hasRender = true;
    }
  } catch (e) {
    ev.notes.push(`readability evidence failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  // COLORIST SCOPES (M3): best-effort per-scene exposure/WB read. Keeps only
  // finite numbers (a scope ffmpeg can't measure stays NaN → dropped) and only
  // attaches the block when at least one scene yields a real luma/WB number, so
  // the summary never prints an empty color table.
  try {
    const sc = await callEditorTool("editor_color_scopes", { id });
    const data: any = sc?.ok ? sc.data : null;
    if (data?.hasRender && Array.isArray(data.scenes) && data.scenes.length) {
      const fin = (n: any) => (typeof n === "number" && Number.isFinite(n) ? n : undefined);
      const scenes: ScopeSceneSignal[] = data.scenes
        .map((s: any) => {
          const st = s.stats ?? {};
          return {
            sceneIndex: Number(s.index ?? 0),
            type: String(s.type ?? "unknown"),
            lumaP5: fin(st.lumaP5),
            lumaP50: fin(st.lumaP50),
            lumaP95: fin(st.lumaP95),
            clipLowPct: fin(st.clipLowPct),
            clipHighPct: fin(st.clipHighPct),
            warmBias: fin(st.wbBias?.warm),
            greenBias: fin(st.wbBias?.green),
          };
        })
        .filter((s: ScopeSceneSignal) => s.lumaP50 != null || s.warmBias != null);
      if (scenes.length) {
        // Scene-to-scene spread = the colorist's consistency target. Penalize a
        // wide P50 / warm-bias range (an inconsistent grade across scenes).
        const p50s = scenes.map((s) => s.lumaP50).filter((n): n is number => n != null);
        const warms = scenes.map((s) => s.warmBias).filter((n): n is number => n != null);
        const spread = (xs: number[]) => (xs.length ? round1(Math.max(...xs) - Math.min(...xs)) : 0);
        ev.scope = {
          scenes,
          consistency: { lumaSpread: spread(p50s), warmSpread: spread(warms) },
          ...(typeof data.contactSheet === "string" ? { contactSheet: data.contactSheet } : {}),
        };
        ev.hasRender = true;
      }
    }
  } catch (e) {
    ev.notes.push(`scope evidence failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!ev.hasRender && ev.notes.length === 0) ev.notes.push("no render evidence yet");
  return ev;
}

/** Compute the full edit-signal picture for a run. Deterministic per-scene
 *  budgets always; render evidence when a render exists (fail-open). */
export async function editSignals(id: string): Promise<EditSignals> {
  const item = loadItem(id);
  const scenes: any[] = (item.storyboard?.scenes ?? []) as any[];

  const sceneSignals: SceneSignal[] = scenes.map((sc, i) => {
    const sayWords = wordCount(sc.say);
    const sayChars = (sc.say ?? "").trim().length;
    const onScreenChars = collectVisibleChars(sc);
    const speakTimeSec = sayWords / WORDS_PER_SEC;
    const readTimeSec = onScreenChars / CHARS_PER_SEC;
    const recommendMinSec = Math.max(speakTimeSec + 0.5, readTimeSec, sceneTypeFloor(String(sc.type ?? "")));
    const durationSec = Number(sc.durationSec ?? 0);
    return {
      sceneIndex: i,
      sceneId: String(sc.id ?? `s${i}`),
      type: String(sc.type ?? "unknown"),
      durationSec,
      sayWords,
      sayChars,
      onScreenChars,
      readTimeSec: round1(readTimeSec),
      speakTimeSec: round1(speakTimeSec),
      tooFast: durationSec < recommendMinSec * 0.92,
      deadAir: durationSec > Math.max(recommendMinSec * 1.8, recommendMinSec + 2.5),
      recommendMinSec: round1(recommendMinSec),
    };
  });

  const evidence = await gatherEvidence(id);
  const totalSec = sceneSignals.reduce((a, s) => a + s.durationSec, 0);
  const arc = (item.edl?.decisions ?? []).map((d: any) => String(d.fn));

  return { scenes: sceneSignals, evidence, totalSec: round1(totalSec), arc };
}

/** A compact, prompt-ready block a pass can read to ground its decisions. */
export function signalsSummary(s: EditSignals): string {
  const rows = s.scenes
    .map((sc) => {
      const flags = [sc.tooFast ? "TOO-FAST" : "", sc.deadAir ? "DEAD-AIR" : ""].filter(Boolean).join("+") || "ok";
      return `  #${sc.sceneIndex} ${sc.type} dur=${sc.durationSec}s need≥${sc.recommendMinSec}s (read ${sc.readTimeSec}s / vo ${sc.speakTimeSec}s) [${flags}]`;
    })
    .join("\n");
  const ev = s.evidence;
  const evLine = ev.hasRender
    ? `RENDER EVIDENCE: silences=${ev.silences?.length ?? 0} freezes=${ev.freezes ?? 0} black=${ev.blackFrames ?? 0} sceneChanges=${ev.sceneChanges ?? 0} meanDb=${ev.meanDb ?? "?"}` +
      (ev.readabilityFlags?.length ? `\n  readability: ${ev.readabilityFlags.slice(0, 6).join(" | ")}` : "")
    : `RENDER EVIDENCE: none yet (${ev.notes[0] ?? "unrendered"})`;
  const lines = [`EDIT SIGNALS — total ${s.totalSec}s, ${s.scenes.length} scenes${s.arc.length ? `, arc: ${s.arc.join("→")}` : ""}`, rows, evLine];
  const meterLine = loudnessLine(ev.meter);
  if (meterLine) lines.push(meterLine);
  const scopeBlock = scopeTable(ev.scope);
  if (scopeBlock) lines.push(scopeBlock);
  return lines.join("\n");
}

/* Compact per-scene exposure / white-balance table for the colorist: luma
   P5/P50/P95 (the exposure read), clip% at each rail, and the WB bias (warm =
   red-over-blue, grn = green tint), plus the scene-to-scene spread the grade
   should flatten. Returns null when no scope evidence exists so the summary
   stays clean for unrendered / non-color runs. */
function scopeTable(sc?: ScopeSignal): string | null {
  if (!sc || !sc.scenes.length) return null;
  const n = (v?: number) => (v == null ? "?" : String(Math.round(v)));
  const s1 = (v?: number) => (v == null ? "?" : String(round1(v)));
  const rows = sc.scenes
    .map((s) => {
      const wb = `${s.warmBias != null && s.warmBias >= 0 ? "+" : ""}${s1(s.warmBias)}`;
      const gn = `${s.greenBias != null && s.greenBias >= 0 ? "+" : ""}${s1(s.greenBias)}`;
      return `  #${s.sceneIndex} ${s.type} luma P5/P50/P95=${n(s.lumaP5)}/${n(s.lumaP50)}/${n(s.lumaP95)} clip↓${s1(s.clipLowPct)}%/↑${s1(s.clipHighPct)}% WB warm=${wb} grn=${gn}`;
    })
    .join("\n");
  const c = sc.consistency;
  const head = `COLOR SCOPES (per-scene exposure / WB${c ? `, consistency: lumaSpread=${c.lumaSpread} warmSpread=${c.warmSpread}` : ""}):`;
  return `${head}\n${rows}`;
}

/* Compact loudness line for the mixer: integrated LUFS vs the -14 target,
   true-peak headroom, LRA (dynamics), and any scene RMS sitting far below the
   voiced level (≥9 LU under the loudest region → likely VO buried under bed).
   Returns null when no real meter exists so the summary stays clean. */
function loudnessLine(m?: MeterSignal): string | null {
  if (!m) return null;
  const parts: string[] = [];
  if (m.integratedLufs != null) {
    const delta = round1(m.integratedLufs - LUFS_TARGET);
    parts.push(`I=${round1(m.integratedLufs)} LUFS (${delta >= 0 ? "+" : ""}${delta} vs ${LUFS_TARGET})`);
  }
  if (m.truePeakDb != null) parts.push(`TP=${round1(m.truePeakDb)} dBTP`);
  if (m.lra != null) parts.push(`LRA=${round1(m.lra)} LU`);
  if (!parts.length && !(m.perRegion && m.perRegion.length)) return null;
  let line = `LOUDNESS: ${parts.join(" ")}`;
  // Flag regions sitting ≥9 LU below the loudest (voiced) region — the mixer's
  // "VO buried under the bed" signal. RMS is dBFS-ish; less-negative = louder.
  const regions = (m.perRegion ?? []).filter((r) => Number.isFinite(r.rms));
  if (regions.length) {
    const loudest = Math.max(...regions.map((r) => r.rms));
    const buried = regions.filter((r) => loudest - r.rms >= 9);
    if (buried.length) {
      line += `\n  low regions (≥9 LU under voiced): ${buried.slice(0, 4).map((r) => `${r.startSec}-${r.endSec}s ${round1(r.rms)}dB`).join(", ")}`;
    }
  }
  return line;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
