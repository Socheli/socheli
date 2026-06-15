/**
 * keyword-broll.ts — KEYWORD B-ROLL ("show what's named").
 *
 * Lays context-relevant stock cutaways over an ingested talking-head edit: the
 * transcript's meaning-bearing keywords (nouns / numbers / brand & proper names)
 * → resolve a matching clip via the EXISTING broll.ts Pexels/Pixabay cascade →
 * place a 1.5–2.5s MUTED, video-only cutaway over the speaker, pre-rolled ~0.35s
 * before the spoken keyword. The speaker's A-roll audio is NEVER touched — the
 * cutaway is muted and the voice mix (owned by ffmpeg buildFootageAudio, which
 * only reads kind:"audio" tracks) plays continuously underneath every cutaway.
 *
 * It REUSES the existing OverlayClip kind:"broll" render path end-to-end: we
 * write the cutaways onto a dedicated `BROLL1` overlay track on item.timeline;
 * render.ts buildOverlayClips already turns overlay-track clips into
 * {kind:"broll", fromF, toF, asset} that HybridPost's OverlayClipLayer composites
 * over the spine+matte. NO render.ts / HybridPost edit is required.
 *
 * Conflict C (build roadmap §3): emphasis/stopword judgement comes from the ONE
 * shared source — caption-style.ts's `emphasisScore`/`STOPWORDS` — so the gold
 * caption word, the punch-in word and the b-roll trigger all agree, instead of
 * each pasting a slightly-different stopword set.
 *
 * Idempotent: BROLL1 is filtered out then rebuilt, so re-runs replace (never
 * stack). FAIL-OPEN: no transcript words / no timeline / nothing resolves ⇒
 * {added:0}; never throws at render.
 */

import type { Clip, Track } from "@os/schemas";

import { loadItem, nowIso, saveItem, warn } from "../store.ts";
import { resolveBroll, loadUsed, type BrollAsset } from "../broll.ts";
import { STOPWORDS, normWord, emphasisScore } from "./caption-style.ts";

const STAT_RE = /(\d|\bmillion\b|\bbillion\b|\bthousand\b|\bpercent\b|%|\bx\b|\b10x\b)/i;
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

type Cand = { word: string; query: string; srcSec: number; emphasis: number };

// Project a SOURCE second onto the TIMELINE via the cut V1 windows (mirrors
// render.ts sourceToTimelineSec). Returns null when the moment was cut away.
function srcToTl(
  t: number,
  v: { inSec?: number; outSec?: number; startSec?: number; durationSec?: number; speed?: number }[],
): number | null {
  for (const c of v) {
    const inSec = c.inSec ?? 0;
    const outSec = c.outSec ?? inSec + (c.durationSec ?? 0) * (c.speed ?? 1);
    if (t >= inSec && t < outSec) return (c.startSec ?? 0) + (t - inSec) / (c.speed ?? 1);
  }
  return null;
}

export async function ensureKeywordBroll(
  id: string,
  opts: { dur?: number; preroll?: number; maxCoverage?: number; cooldownSec?: number; styleHint?: string } = {},
): Promise<{ added: number; keywords: string[] }> {
  const item = loadItem(id);
  const words = item.understanding?.transcript?.words ?? [];
  const tl = item.timeline;
  if (!words.length || !tl) {
    warn(item, "broll", "skip", "no transcript words / timeline");
    return { added: 0, keywords: [] };
  }

  const dur = clamp(opts.dur ?? 2.0, 1.5, 2.5);
  const preroll = clamp(opts.preroll ?? 0.35, 0.2, 0.5);
  const maxCov = clamp(opts.maxCoverage ?? 0.35, 0.3, 0.4);
  const cooldown = Math.max(2.5, opts.cooldownSec ?? 6);

  const v1 = (
    tl.tracks.find((t) => t.kind === "video" && t.id === "V1") ?? tl.tracks.find((t) => t.kind === "video")
  )?.clips ?? [];
  const runtime = v1.reduce((s, c) => s + (c.durationSec ?? 0), 0) || (item.understanding?.durationSec ?? 0);
  if (runtime <= 0) return { added: 0, keywords: [] };
  const highlights = item.understanding?.highlights ?? [];
  const inHi = (t: number) => highlights.some((h) => t >= h.startSec && t < h.endSec);

  // EXTRACT meaning-bearing keywords (nouns/numbers/proper-names), scored. The
  // stopword filter + content-word weighting come from the SHARED helpers
  // (Conflict C); proper-noun / stat detection is token-position-local.
  const cands: Cand[] = [];
  for (let i = 0; i < words.length; i++) {
    const raw = (words[i]?.word ?? "").replace(/[^A-Za-z0-9%]/g, "");
    if (raw.length < 3) continue;
    const lower = normWord(raw);
    if (!lower || STOPWORDS.has(lower)) continue;
    const prev = (words[i - 1]?.word ?? "").trim();
    const startsSentence = i === 0 || /[.!?]["')\]]?$/.test(prev);
    const isProper = (/^[A-Z][a-z0-9]+/.test(raw) && !startsSentence) || /^[A-Z0-9]{2,}$/.test(raw);
    const isStat = STAT_RE.test(raw);
    // Shared per-word emphasis (length/number/proper/highlight weighting) — the
    // ONE heuristic, normalised to ~0..1 to combine with the named-thing bonuses.
    const base = emphasisScore(raw, { inHighlight: inHi(words[i].startSec) }) / 12;
    const isContent = raw.length >= 4; // coarse content-word fallback
    if (!isProper && !isStat && !isContent) continue;
    let emphasis = (isStat ? 0.42 : 0) + (isProper ? 0.34 : 0) + (inHi(words[i].startSec) ? 0.3 : 0) + base;
    if (emphasis < 0.2) continue; // only the strongest named things get a cutaway
    // a number alone ("50") reads better with its neighbour noun as the query
    const query =
      isStat && words[i + 1]?.word
        ? `${raw} ${words[i + 1].word.replace(/[^A-Za-z]/g, "")}`.trim()
        : raw;
    cands.push({ word: lower, query, srcSec: words[i].startSec, emphasis: Math.min(1, emphasis) });
  }
  cands.sort((a, b) => b.emphasis - a.emphasis);

  // GREEDY placement: strongest first, cooldown + min-gap + coverage clamps.
  type Placed = { stem: string; query: string; tlStart: number };
  const placed: Placed[] = [];
  const lastByStem = new Map<string, number>();
  let covered = 0;
  const maxCount = Math.max(1, Math.floor(runtime / 8));
  for (const c of cands) {
    if (placed.length >= maxCount) break;
    if (covered + dur > maxCov * runtime) break;
    const tlSrc = srcToTl(c.srcSec, v1);
    if (tlSrc == null) continue; // keyword's moment was cut away
    const tlStart = Math.max(0, tlSrc - preroll);
    if (tlStart < 2.5) continue; // protect the hook — never cut away in the first 2.5s
    if (tlStart + dur > runtime) continue;
    const st = c.word;
    const lastAt = lastByStem.get(st);
    if (lastAt != null && tlStart - lastAt < cooldown) continue;
    if (placed.some((p) => Math.abs(p.tlStart - tlStart) < dur + 2.5)) continue; // min gap
    placed.push({ stem: st, query: c.query, tlStart });
    lastByStem.set(st, tlStart);
    covered += dur;
  }
  if (!placed.length) {
    warn(item, "broll", "none", "no keyword passed the coverage/cooldown gates");
    return { added: 0, keywords: [] };
  }

  // RESOLVE each keyword's clip via the EXISTING broll cascade (batched by 4).
  const used = loadUsed();
  const resolved: { p: Placed; asset: BrollAsset }[] = [];
  for (let i = 0; i < placed.length; i += 4) {
    const batch = placed.slice(i, i + 4);
    const assets = await Promise.all(batch.map((p) => resolveBroll(p.query, "concrete", used, opts.styleHint)));
    assets.forEach((a, j) => {
      if (a) resolved.push({ p: batch[j], asset: a });
    });
  }
  if (!resolved.length) {
    warn(item, "broll", "unresolved", "no keyword clips resolved");
    return { added: 0, keywords: [] };
  }

  // WRITE a dedicated BROLL1 overlay track (replace any prior — idempotent).
  resolved.sort((a, b) => a.p.tlStart - b.p.tlStart);
  const clips: Clip[] = resolved.map(({ p, asset }, i) => ({
    id: `broll_${i}`,
    kind: "overlay",
    src: asset.src,
    inSec: 0,
    outSec: dur,
    startSec: Math.round(p.tlStart * 100) / 100,
    durationSec: dur,
    speed: 1,
    enabled: true,
  }));
  const tracks: Track[] = (tl.tracks ?? []).filter((t) => t.id !== "BROLL1");
  tracks.push({ id: "BROLL1", kind: "overlay", name: "Keyword B-roll", clips });
  item.timeline = { ...tl, tracks, compiledAt: nowIso() };
  item.updatedAt = nowIso();
  saveItem(item);
  return { added: clips.length, keywords: resolved.map((r) => r.p.query) };
}
