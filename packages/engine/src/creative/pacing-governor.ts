/* ─── P6 — PACING GOVERNOR + HOOK (composes P3/P4/P5; the LAST pillar) ───────
   WORLD-CLASS-EDITING §3 (Pacing) + §6 (Hook). A pure, schema-respecting POST-PASS
   over an already-assembled FOOTAGE timeline (after montage/tighten → keyword-broll
   → edit-music → beat-sync → punch-ins), run once more right before render.

   This module DOES NOT animate anything and DOES NOT touch ffmpeg. It only WRITES
   the canonical persisted timeline shapes that the other pillars already render:
     • `governPacing` repairs static stretches and enforces the visual-change cadence
       by writing `Clip.zoom` keyframes (the ONE canonical zoom form — roadmap §3
       Conflict A) onto the V1 clip playing that timeline second, with a `gov_` id.
       P3's render.ts flatten turns those into ZoomWindows → FootageSpine scales them.
     • `applyHook` ripple-trims a dead-air opener (in-media-res), drops a ≤7-word
       text hook (a synthetic CAP1 caption line so it inherits the karaoke styling,
       else a captionText line), and seeds 2–3 micro-cut punch-ins (`gov_hook_`).

   THREE invariants the roadmap nails this module to:
     • CONFLICT B — it does NOT re-derive a beat grid. It imports `resolveDownbeats`
       + `snapFrameToDownbeat` from beat-sync.ts and snaps every insert through them
       (no-op fail-open when no music bed). Frames are TIMELINE frames; the Clip.zoom
       atFrame is clip-relative, so it snaps in timeline frames then converts back.
     • CONFLICT C — it does NOT re-derive a stopword/emphasis heuristic. It imports
       `emphasisScore` from caption-style.ts to land inserts on stressed words.
     • CONFLICT E — IDEMPOTENT. Every governor insert carries a stable id prefix
       (`gov_` / `gov_hook_`); each entry point STRIPS its own prior inserts first,
       then recomputes from the un-governed base. So the render.ts pre-render hook
       (which runs every render) never drifts the timeline.

   FAIL-OPEN throughout: no timeline / not footage / no V1 ⇒ a warn + no-op; a
   pillar that can't compute returns a zeroed report, never throws at render. */

import type { Clip, ContentItem, Marker, Timeline, Track } from "@os/schemas";
import { loadItem, nowIso, saveItem, warn } from "../store.ts";
import { emphasisScore } from "./caption-style.ts";
import { resolveDownbeats, snapFrameToDownbeat } from "./beat-sync.ts";

const round2 = (n: number) => Math.round(n * 100) / 100;
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

// §3/§6 params (Frame = 1080×1920 @ fps). All seconds; sec→frame via Math.round.
const BODY_GAP_MAX = 4.0; // a body change must land within this many seconds
const HIGH_ENERGY_GAP = 1.8; // tighter budget over a hot / in-highlight region
const STATIC_FAIL_SEC = clamp(Number(process.env.SOCHELI_STATIC_FAIL_SEC) || 6.0, 5, 8);
const DENSITY_WINDOW = 10; // density clamp window, seconds
const DENSITY_MAX = 7; // ceiling changes per window
const DENSITY_MIN = 5; // floor — never suppress below this
const REMEDY_ZOOM = 1.12; // the static-stretch / cadence remedy zoom
const REMEDY_ZOOM_FRAMES = 12; // ramp-in frames for an inserted zoom (@30fps base)
const ZOOM_SPACING_SEC = 6.5; // min gap between inserted governor zooms
const HOOK_MAX_WORDS = 7;
const HOOK_ON_BY_SEC = 1.0; // the hook text is on screen by this second
const HOOK_HOLD = 3.0; // held this long (within the 2–4s band)
const DEAD_LEAD_MAX_SEC = 1.2; // in-media-res: only drop an opener lead this short
const DEAD_ENERGY_DB = -34; // …or quieter than this (per-shot energyRms)

type Log = (m: string) => void;

/* A single point of visual change on the assembled timeline (timeline seconds). */
type VisualChange = { atSec: number; kind: "cut" | "zoom" | "broll" | "caption"; value: number; ref?: string };

const V1Of = (tl: Timeline): Track | undefined =>
  tl.tracks.find((t) => t.id === "V1" && t.kind === "video") ?? tl.tracks.find((t) => t.kind === "video");

const fpsOf = (item: ContentItem): number =>
  item.timeline?.fps ?? item.source?.probe?.video?.fps ?? item.understanding?.fps ?? 30;

/* A footage timeline with a ≥1-clip V1 we may mutate? Fail-open guard. */
function readyFootage(item: ContentItem): { tl: Timeline; v1: Track } | null {
  const tl = item.timeline;
  const v1 = tl ? V1Of(tl) : undefined;
  if (!tl || tl.seededFrom !== "footage" || !v1 || !(v1.clips?.length)) return null;
  return { tl, v1 };
}

/* Strip THIS pillar's prior inserts so a re-run recomputes from the ungoverned
   base (Conflict E). `governPacing` strips its own `gov_` (cadence/static) zooms +
   `broll-needed` markers but MUST leave the hook's `gov_hook_` zooms (owned by
   applyHook) in place — so the `gov_` strip explicitly excludes the `gov_hook_`
   namespace. applyHook strips `gov_hook_` (its own). */
function stripGovInserts(tl: Timeline, prefix: string): void {
  const matches = (id: string): boolean =>
    prefix === "gov_" ? id.startsWith("gov_") && !id.startsWith("gov_hook_") : id.startsWith(prefix);
  for (const t of tl.tracks) {
    for (const c of t.clips ?? []) {
      const zooms = (c as { zoom?: { id?: string }[] }).zoom;
      if (zooms?.length) {
        const kept = zooms.filter((z) => !matches(z.id ?? ""));
        if (kept.length !== zooms.length) (c as { zoom?: unknown }).zoom = kept.length ? kept : undefined;
      }
    }
  }
  // markers are only stamped by governPacing → strip them on the gov_ pass only.
  if (prefix === "gov_" && tl.markers?.length) tl.markers = tl.markers.filter((m) => !(m.label ?? "").startsWith("broll-needed"));
}

/* Write an eased punch-in onto the V1 clip playing `tlSec`. ONE producer of the
   canonical Clip.zoom shape (P3 renders it). Snaps the peak to the downbeat grid
   (Conflict B) in TIMELINE frames, then stores it clip-relative. Spacing-guards
   against an existing zoom on the same clip. Locked / disabled clips are skipped.
   Returns true if a zoom was written. */
function insertPunchIn(
  v1: Track,
  tlSec: number,
  fps: number,
  tag: string,
  downbeats: number[],
  bpm: number | undefined,
): boolean {
  const clips = v1.clips ?? [];
  // snap the desired insert moment (timeline frames) to the downbeat grid first.
  const snappedF = snapFrameToDownbeat(Math.round(tlSec * fps), downbeats, fps, bpm);
  const snappedSec = snappedF / fps;
  const clip = clips.find((c) => {
    const s = c.startSec ?? 0;
    return snappedSec >= s && snappedSec < s + (c.durationSec ?? 0) && c.locked !== true && c.enabled !== false;
  });
  if (!clip) return false;
  const atFrame = Math.max(0, Math.round((snappedSec - (clip.startSec ?? 0)) * fps));
  const zooms = ((clip as { zoom?: ZoomKf[] }).zoom ?? []).slice();
  // spacing: skip if any zoom already sits < ZOOM_SPACING within this clip.
  if (zooms.some((z) => Math.abs(z.atFrame - atFrame) < ZOOM_SPACING_SEC * fps)) return false;
  const rampF = Math.max(1, Math.round(REMEDY_ZOOM_FRAMES * (fps / 30)));
  zooms.push({ atFrame, scale: REMEDY_ZOOM, ease: "inout", holdF: 6, rampInF: rampF, rampOutF: rampF + 2, id: tag });
  (clip as { zoom?: ZoomKf[] }).zoom = zooms.sort((a, b) => a.atFrame - b.atFrame);
  return true;
}

type ZoomKf = { atFrame: number; scale: number; ease: "in" | "out" | "inout"; holdF?: number; rampInF?: number; rampOutF?: number; id?: string };

/* The timeline second of the nearest vocally-stressed transcript word inside
   [loSec, hiSec], scored by the shared emphasisScore heuristic (Conflict C).
   Falls back to the window centre when no qualifying word lands in range. */
function stressedSecIn(item: ContentItem, loSec: number, hiSec: number, fps: number, v1: Track): number {
  const mid = (loSec + hiSec) / 2;
  const words = item.understanding?.transcript?.words ?? [];
  if (!words.length) return mid;
  // project a SOURCE-second word onto the timeline through the V1 cut.
  const toTl = (srcSec: number): number | null => {
    for (const c of v1.clips ?? []) {
      const inSec = c.inSec ?? 0;
      const outSec = c.outSec ?? inSec + (c.durationSec ?? 0) * (c.speed ?? 1);
      if (srcSec >= inSec && srcSec < outSec) return (c.startSec ?? 0) + (srcSec - inSec) / (c.speed ?? 1);
    }
    return null;
  };
  let bestSec = mid;
  let bestScore = -1;
  for (const w of words) {
    const tl = toTl(w.startSec);
    if (tl == null || tl < loSec || tl > hiSec) continue;
    const sc = emphasisScore(w.word) - Math.abs(tl - mid) * 0.25; // prefer stressed, near mid
    if (sc > bestScore) {
      bestScore = sc;
      bestSec = tl;
    }
  }
  return bestSec;
}

/* ── BUILD THE MERGED VISUAL-CHANGE STREAM (timeline seconds, sorted). ──
   cut: each V1 clip start (skip the first — t=0 is the opening, not a change).
   zoom: every Clip.zoom keyframe (any producer), peak = clip.start + atFrame/fps.
   broll: every clip on a non-V1 overlay/video track → in + out events.
   caption: each styled CAP1 line's startSec (a caption pop). */
function buildStream(tl: Timeline, fps: number, v1: Track): VisualChange[] {
  const ev: VisualChange[] = [];
  const clips = [...(v1.clips ?? [])].sort((a, b) => (a.startSec ?? 0) - (b.startSec ?? 0));
  clips.forEach((c, i) => {
    if (i > 0) ev.push({ atSec: c.startSec ?? 0, kind: "cut", value: clamp(0.4 + (c.durationSec ?? 0) / 12, 0.4, 1), ref: c.id });
    for (const z of ((c as { zoom?: ZoomKf[] }).zoom ?? [])) ev.push({ atSec: round2((c.startSec ?? 0) + z.atFrame / fps), kind: "zoom", value: 0.7, ref: z.id });
  });
  for (const t of tl.tracks) {
    if (t === v1 || t.id === "V1") continue;
    if (t.kind !== "overlay" && t.kind !== "video") continue;
    for (const c of t.clips ?? []) {
      if (c.enabled === false) continue;
      const s = c.startSec ?? 0;
      ev.push({ atSec: s, kind: "broll", value: 0.85, ref: c.id });
      ev.push({ atSec: round2(s + (c.durationSec ?? 0)), kind: "broll", value: 0.85, ref: c.id });
    }
  }
  const cap = tl.tracks.find((t) => t.id === "CAP1" || (t.kind === "text" && t.name === "captions"));
  for (const c of cap?.clips ?? []) {
    if (c.enabled === false) continue;
    if (!(c as { captionStyle?: unknown }).captionStyle) continue; // only count styled pops
    const v = (c as { captionStyle?: { emphasis?: number } }).captionStyle?.emphasis ?? 0.3;
    ev.push({ atSec: c.startSec ?? 0, kind: "caption", value: clamp(v, 0.1, 0.9), ref: c.id });
  }
  return ev.sort((a, b) => a.atSec - b.atSec);
}

/* Is the region [a,b] "hot" (tight cadence budget)? — overlaps a highlight. */
function regionHot(item: ContentItem, v1: Track, aSec: number, bSec: number): boolean {
  const hi = (item.understanding?.highlights ?? []) as { startSec: number; endSec: number }[];
  if (!hi.length) return false;
  // map the timeline window back to source via the spanning clip, test highlight overlap.
  for (const c of v1.clips ?? []) {
    const s = c.startSec ?? 0;
    const e = s + (c.durationSec ?? 0);
    if (bSec <= s || aSec >= e) continue;
    const inSec = c.inSec ?? 0;
    const spd = c.speed ?? 1;
    const srcA = inSec + Math.max(0, aSec - s) * spd;
    const srcB = inSec + (Math.min(e, bSec) - s) * spd;
    if (hi.some((h) => Math.min(srcB, h.endSec) - Math.max(srcA, h.startSec) > 0.01)) return true;
  }
  return false;
}

/* ── governPacing: repair static stretches, enforce body cadence, clamp density. ── */
export function governPacing(
  id: string,
  log: Log = () => {},
  opts?: { staticFailSec?: number },
): { inserts: number; suppressions: number; repaired: number } {
  let item: ContentItem;
  try {
    item = loadItem(id);
  } catch {
    return { inserts: 0, suppressions: 0, repaired: 0 };
  }
  const ready = readyFootage(item);
  if (!ready) {
    log("govern: skipped — not a footage timeline with a V1 track");
    return { inserts: 0, suppressions: 0, repaired: 0 };
  }
  const { tl, v1 } = ready;
  const fps = fpsOf(item);
  const failSec = clamp(opts?.staticFailSec ?? STATIC_FAIL_SEC, 5, 8);

  // Conflict E: strip prior gov_ inserts (NOT the hook's gov_hook_), recompute fresh.
  stripGovInserts(tl, "gov_");

  const { downbeats, bpm } = resolveDownbeats(item, fps);
  const runtimeSec = (v1.clips ?? []).reduce((s, c) => Math.max(s, (c.startSec ?? 0) + (c.durationSec ?? 0)), 0);

  let inserts = 0;
  let repaired = 0;
  let n = 0;

  // 3+4. WALK GAPS — repair static stretches, then enforce min cadence. Recompute the
  // stream after each insert pass so newly-written zooms count toward cadence.
  const passGaps = (): void => {
    const stream = buildStream(tl, fps, v1);
    // sentinel endpoints so the lead/tail of the video are governed too.
    const pts = [{ atSec: 0, kind: "cut" as const, value: 1 }, ...stream, { atSec: runtimeSec, kind: "cut" as const, value: 1 }];
    for (let i = 0; i < pts.length - 1; i++) {
      const cur = pts[i].atSec;
      const next = pts[i + 1].atSec;
      const gap = next - cur;
      if (gap <= 0.01) continue;
      const budget = regionHot(item, v1, cur, next) ? HIGH_ENERGY_GAP : BODY_GAP_MAX;
      if (gap > failSec) {
        // hard-fail: insert remedies at cur + k*budget, snapped to a stressed word.
        const k = Math.max(1, Math.floor(gap / budget));
        let any = false;
        for (let j = 1; j <= k; j++) {
          const target = cur + j * budget;
          if (target >= next - 0.2) break;
          const at = stressedSecIn(item, Math.max(cur + 0.3, target - budget / 2), Math.min(next - 0.3, target + budget / 2), fps, v1);
          if (insertPunchIn(v1, at, fps, `gov_${n++}`, downbeats, bpm)) {
            inserts++;
            any = true;
          } else {
            // no V1 clip could take a zoom (locked) — flag for keyword-broll / operator.
            (tl.markers ??= []).push({ atSec: round2(at), label: `broll-needed @${round2(at)}s`, color: "#ff5470" } as Marker);
          }
        }
        if (any) repaired++;
      } else if (gap > budget) {
        // body coasts > budget but not a hard fail → ONE punch-in near cur+budget.
        const at = stressedSecIn(item, cur + 0.3, Math.min(next - 0.3, cur + budget + budget / 2), fps, v1);
        if (insertPunchIn(v1, at, fps, `gov_${n++}`, downbeats, bpm)) inserts++;
      }
    }
  };
  passGaps();
  passGaps(); // second pass picks up any still-too-wide sub-gaps the first repaired around

  // 5. CLAMP DENSITY (5–7 / 10s): in any over-dense window, SUPPRESS the lowest-value
  //    INSERTED events (a gov_ zoom or a caption pop) — never a hard cut, never locked.
  let suppressions = 0;
  const isLocked = (ref?: string): boolean => (v1.clips ?? []).some((c) => c.id === ref && c.locked === true);
  // map a zoom event ref(id) → its clip + keyframe, so we can disable it.
  const disableZoom = (refId?: string): boolean => {
    if (!refId) return false;
    for (const c of v1.clips ?? []) {
      const zooms = (c as { zoom?: ZoomKf[] }).zoom;
      const idx = zooms?.findIndex((z) => z.id === refId) ?? -1;
      if (zooms && idx >= 0) {
        zooms.splice(idx, 1);
        if (!zooms.length) (c as { zoom?: unknown }).zoom = undefined;
        return true;
      }
    }
    return false;
  };
  const disableCaption = (refId?: string): boolean => {
    const cap = tl.tracks.find((t) => t.id === "CAP1" || (t.kind === "text" && t.name === "captions"));
    const clip = (cap?.clips ?? []).find((c) => c.id === refId);
    if (clip && clip.enabled !== false) {
      clip.enabled = false;
      return true;
    }
    return false;
  };
  // slide a 10s window; suppress excess down to DENSITY_MAX (never below DENSITY_MIN).
  let guard = 0;
  for (;;) {
    if (guard++ > 4000) break; // safety
    const stream = buildStream(tl, fps, v1);
    let windowOver: VisualChange[] | null = null;
    for (const e of stream) {
      const win = stream.filter((x) => x.atSec >= e.atSec && x.atSec < e.atSec + DENSITY_WINDOW);
      if (win.length > DENSITY_MAX) {
        windowOver = win;
        break;
      }
    }
    if (!windowOver) break;
    // candidates to suppress: only inserted gov_ zooms + caption pops, never cuts/broll/locked.
    const cands = windowOver
      .filter((e) => (e.kind === "zoom" && (e.ref ?? "").startsWith("gov_") && !isLocked(e.ref)) || e.kind === "caption")
      .sort((a, b) => a.value - b.value);
    if (!cands.length) break; // can't suppress without violating the rules
    // keep the floor: don't drop below DENSITY_MIN.
    if (windowOver.length - 1 < DENSITY_MIN) break;
    const victim = cands[0];
    const ok = victim.kind === "zoom" ? disableZoom(victim.ref) : disableCaption(victim.ref);
    if (!ok) break;
    suppressions++;
  }

  tl.compiledAt = nowIso();
  item.timeline = tl;
  item.updatedAt = nowIso();
  saveItem(item);
  warn(item, "govern", "ok", `governed: ${inserts} insert(s), ${suppressions} suppression(s), ${repaired} static stretch(es) repaired`);
  log(`govern: ${inserts} insert(s), ${suppressions} suppression(s), ${repaired} static stretch(es) repaired`);
  return { inserts, suppressions, repaired };
}

/* ── applyHook: in-media-res trim + ≤7-word text hook + 2–3 micro-cuts. ── */
export function applyHook(
  id: string,
  log: Log = () => {},
  opts?: { text?: string; textOverlay?: boolean },
): { hookText: string; microCuts: number; trimmedSec: number } {
  let item: ContentItem;
  try {
    item = loadItem(id);
  } catch {
    return { hookText: "", microCuts: 0, trimmedSec: 0 };
  }
  const ready = readyFootage(item);
  if (!ready) {
    log("hook: skipped — not a footage timeline with a V1 track");
    return { hookText: "", microCuts: 0, trimmedSec: 0 };
  }
  const { tl, v1 } = ready;
  const fps = fpsOf(item);
  const { downbeats, bpm } = resolveDownbeats(item, fps);

  // Conflict E: re-strip prior hook inserts so a re-run recomputes from base.
  stripGovInserts(tl, "gov_hook_");
  // Also drop any prior hook TEXT caption (stripGovInserts only clears zoom keyframes) —
  // so toggling the overlay off, or a re-run, never leaves a stale duplicate caption.
  for (const t of tl.tracks) {
    if (t.kind === "text") t.clips = (t.clips ?? []).filter((c) => c.id !== "gov_hook_cap");
  }

  const clips = [...(v1.clips ?? [])].sort((a, b) => (a.startSec ?? 0) - (b.startSec ?? 0));

  // 1. IN-MEDIA-RES: if the FIRST clip's leading ≤1.2s is dead-air / very quiet,
  //    ripple-trim that lead so frame 1 is mid-action. Locked-safe / fail-open.
  let trimmedSec = 0;
  const first = clips[0];
  if (first && first.locked !== true && (first.durationSec ?? 0) > DEAD_LEAD_MAX_SEC + 0.4) {
    const inSec = first.inSec ?? 0;
    const dead = (item.understanding?.deadAir ?? []) as { startSec: number; endSec: number }[];
    const leadDead = dead.find((d) => d.startSec <= inSec + 0.05 && d.endSec > inSec + 0.1);
    // per-shot energy: the shot whose source window opens this clip.
    const perShot = item.understanding?.perShot ?? {};
    const quiet = Object.values(perShot).some(
      (s) => (s as { energyRms?: number }).energyRms != null && (s as { energyRms?: number }).energyRms! < DEAD_ENERGY_DB,
    );
    let dropSec = 0;
    if (leadDead) dropSec = clamp(leadDead.endSec - inSec, 0, DEAD_LEAD_MAX_SEC);
    else if (quiet) dropSec = Math.min(DEAD_LEAD_MAX_SEC, 0.6);
    if (dropSec > 0.1) {
      first.inSec = round2(inSec + dropSec);
      first.durationSec = round2(Math.max(0.2, (first.durationSec ?? 0) - dropSec / (first.speed ?? 1)));
      trimmedSec = round2(dropSec);
      // ripple later V1 starts back (and the A1 mirror if 1:1).
      let cursor = first.startSec ?? 0;
      cursor += first.durationSec ?? 0;
      for (let i = 1; i < clips.length; i++) {
        clips[i].startSec = round2(cursor);
        cursor += clips[i].durationSec ?? 0;
      }
      const a1 = tl.tracks.find((t) => t.kind === "audio");
      if (a1 && a1.clips.length === clips.length) {
        a1.clips = a1.clips.map((a, i) => ({ ...a, startSec: clips[i].startSec, outSec: clips[i].outSec, durationSec: clips[i].durationSec }));
      }
      v1.clips = clips;
    }
  }

  // 2. TEXT HOOK: ≤7-word hook overlay. OFF by default for talking-heads — the speaker
  //    SAYS the hook, so the karaoke caption already shows those words; a second hook
  //    caption just duplicates it. Opt in with textOverlay:true (or pass explicit text)
  //    for b-roll/no-caption openings where a title hook adds value.
  const wantOverlay = opts?.textOverlay === true || !!opts?.text;
  const hookText = wantOverlay ? deriveHookText(item, opts?.text) : "";
  if (hookText) writeHookCaption(item, tl, v1, fps, hookText);

  // 3. MICRO-CUTS: ensure 2–3 changes inside [0, 2.5s] — seed punch-ins at ~0.4s/1.1s
  //    when the opening shot coasts. gov_hook_ ids → idempotent.
  let microCuts = 0;
  const earlyZooms = (clips[0] ? ((clips[0] as { zoom?: ZoomKf[] }).zoom ?? []) : []).filter((z) => z.atFrame / fps < 2.5).length;
  const earlyCut = clips.some((c, i) => i > 0 && (c.startSec ?? 0) < 2.5);
  let want = 2 - (earlyCut ? 1 : 0) - earlyZooms;
  const seeds = [0.4, 1.1, 1.9];
  for (let i = 0; i < seeds.length && want > 0; i++) {
    if (insertPunchIn(v1, seeds[i], fps, `gov_hook_${i}`, downbeats, bpm)) {
      microCuts++;
      want--;
    }
  }

  tl.compiledAt = nowIso();
  item.timeline = tl;
  item.updatedAt = nowIso();
  saveItem(item);
  warn(item, "hook", "ok", `hook: "${hookText}" — ${microCuts} micro-cut(s)${trimmedSec ? `, trimmed ${trimmedSec}s lead` : ""}`);
  log(`hook: "${hookText}" — ${microCuts} micro-cut(s)${trimmedSec ? `, trimmed ${trimmedSec}s lead` : ""}`);
  return { hookText, microCuts, trimmedSec };
}

/* ≤7-word hook line: caller text → first transcript line → videoSummary clause. */
function deriveHookText(item: ContentItem, override?: string): string {
  const cap = (s: string): string => s.trim().split(/\s+/).slice(0, HOOK_MAX_WORDS).join(" ").replace(/[.,;:]+$/, "");
  if (override && override.trim()) return cap(override);
  const segs = item.understanding?.transcript?.segments ?? [];
  if (segs.length && segs[0].text?.trim()) return cap(segs[0].text);
  const words = item.understanding?.transcript?.words ?? [];
  if (words.length) return cap(words.slice(0, HOOK_MAX_WORDS).map((w) => w.word).join(" "));
  const summary = item.understanding?.videoSummary ?? "";
  if (summary.trim()) return cap(summary.split(/[.!?]/)[0] ?? summary);
  return "";
}

/* Write a synthetic CAP1 caption line for the hook. Source-time words inside the
   FIRST clip's source window → render's sourceToTimelineSec re-anchors them to
   timeline ~[HOOK_ON_BY_SEC, HOOK_ON_BY_SEC+HOOK_HOLD]. Carries a HOOK captionStyle
   so it renders through the styled karaoke path when captions are styled (and the
   global path otherwise). Idempotent: any prior `gov_hook_cap` line is replaced. */
function writeHookCaption(item: ContentItem, tl: Timeline, v1: Track, fps: number, text: string): void {
  let cap = tl.tracks.find((t) => t.id === "CAP1" || (t.kind === "text" && t.name === "captions"));
  if (!cap) {
    cap = { id: "CAP1", kind: "text", name: "captions", clips: [] } as Track;
    tl.tracks.push(cap);
  }
  cap.clips = (cap.clips ?? []).filter((c) => c.id !== "gov_hook_cap");
  const first = (v1.clips ?? [])[0];
  if (!first) return;
  const inSec = first.inSec ?? 0;
  const speed = first.speed ?? 1;
  const tokens = text.split(/\s+/).filter(Boolean).slice(0, HOOK_MAX_WORDS);
  if (!tokens.length) return;
  const step = HOOK_HOLD / Math.max(1, tokens.length);
  // each word's SOURCE second = inSec + (HOOK_ON_BY_SEC + i*step)*speed → timeline HOOK_ON_BY_SEC + i*step.
  const words = tokens.map((w, i) => {
    const tlAt = HOOK_ON_BY_SEC + i * step;
    return { word: w, fromSec: round2(inSec + tlAt * speed), toSec: round2(inSec + (tlAt + step) * speed) };
  });
  const hookClip: Clip = {
    id: "gov_hook_cap",
    kind: "text",
    inSec,
    startSec: HOOK_ON_BY_SEC,
    durationSec: HOOK_HOLD,
    speed: 1,
    enabled: true,
    captionText: text,
    words,
    // a big centred-upper HOOK look so it lands as the opener; the styled karaoke
    // path renders it when captions are styled, the global path otherwise.
    captionStyle: { preset: "glow", position: "top", fontScale: 1.3, emphasis: 0.9, depth: "front" },
  };
  cap.clips.push(hookClip);
}

/* One-shot retention pass: the hook then the pacing governor (the order the
   render.ts pre-render compose hook runs them in). */
export function retentionPass(id: string, log: Log = () => {}): {
  hook: ReturnType<typeof applyHook>;
  govern: ReturnType<typeof governPacing>;
} {
  const hook = applyHook(id, log);
  const govern = governPacing(id, log);
  return { hook, govern };
}
