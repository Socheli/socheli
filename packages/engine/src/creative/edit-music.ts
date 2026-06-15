/**
 * edit-music.ts — add an instrumental MUSIC BED to an ingested edit.
 *
 * World-class short-form ALWAYS has a music bed under the talking head; our edits had
 * none (the #1 audio gap). The hybrid audio path (render.ts buildFootageAudio) already
 * ducks + masters `item.musicSrc` against the footage voice — it just was never SET on
 * an ingested run. This resolves a mood-appropriate INSTRUMENTAL bed via the engine's
 * music provider, attenuates it to a background level so it sits UNDER the voice in the
 * gaps (the sidechain duck drops it further while speech plays), and sets item.musicSrc.
 *
 * Spec (docs/WORLD-CLASS-EDITING.md §2): instrumental only; pitch/explainer ~100–120 BPM;
 * bed ~−14 to −16 dB in gaps, ducked ~20 dB under speech; final master −14 LUFS (the
 * render's masterAudio handles the LUFS). FAIL-OPEN: no provider/ffmpeg → returns {} and
 * the edit renders with footage audio only (today's behaviour).
 */

import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, rmSync } from "node:fs";

import { loadItem, nowIso, saveItem } from "../store.ts";
import { ensureMusic } from "../media.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const REMOTION_PUBLIC = join(HERE, "..", "..", "..", "remotion", "public");

/** Pick an instrumental bed prompt from the edit's content + an energy hint. */
function bedPrompt(item: ReturnType<typeof loadItem>, energy?: "calm" | "upbeat" | "hype"): string {
  const summary = (item.understanding as { videoSummary?: string } | undefined)?.videoSummary?.slice(0, 90) ?? "";
  const e = energy ?? "upbeat";
  const bpm = e === "calm" ? "70–90 BPM" : e === "hype" ? "120–150 BPM" : "100–120 BPM";
  const vibe =
    e === "calm" ? "soft ambient pads, minimal, emotional, unobtrusive"
      : e === "hype" ? "driving percussive electronic, energetic, confident"
        : "clean modern uplifting corporate, light electronic, motivational";
  return `instrumental background music bed, NO vocals, ${bpm}, ${vibe} — sits under a talking-head${summary ? ` about ${summary}` : ""}; subtle, supportive, never overpowering the voice`;
}

/**
 * Resolve + attach an instrumental music bed to an ingested edit. Returns the
 * public-relative bed path + provider, or {} on failure. After this, a renderHybrid
 * automatically ducks + masters it under the footage voice.
 */
export function ensureEditMusic(
  id: string,
  opts: { prompt?: string; energy?: "calm" | "upbeat" | "hype"; level?: number } = {},
): { musicSrc?: string; source?: string } {
  const item = loadItem(id);

  // Edit length = the cut spine's total (V1 clips), falling back to the source duration.
  const v1 = item.timeline?.tracks.find((t) => t.id === "V1" && t.kind === "video") ?? item.timeline?.tracks.find((t) => t.kind === "video");
  const cutSec = (v1?.clips ?? []).reduce((s, c) => s + (c.durationSec ?? 0), 0);
  const durSec = Math.max(3, cutSec || Number(item.source?.probe?.durationSec) || 30);

  const prompt = opts.prompt ?? bedPrompt(item, opts.energy);
  const theme = (item.storyboard as { theme?: string } | undefined)?.theme ?? "concept";
  const m = ensureMusic(id, durSec + 2, theme, prompt, {});
  if (!m) return {};

  // Attenuate to a BED level so it doesn't fight the voice in the gaps (the render's
  // sidechain duck pulls it down further under speech). ~0.22 ≈ −13 dB base.
  const level = Math.max(0.05, Math.min(1, opts.level ?? 0.22));
  const bedRel = `${id}_editbed.wav`;
  const r = spawnSync(
    "ffmpeg",
    ["-y", "-i", join(REMOTION_PUBLIC, m.src), "-af", `volume=${level}`, join(REMOTION_PUBLIC, bedRel)],
    { encoding: "utf8" },
  );
  const finalRel = r.status === 0 && existsSync(join(REMOTION_PUBLIC, bedRel)) ? bedRel : m.src;
  // the raw (un-attenuated) bed is scratch once we have the attenuated one.
  if (finalRel !== m.src) { try { rmSync(join(REMOTION_PUBLIC, m.src), { force: true }); } catch { /* ignore */ } }

  (item as { musicSrc?: string }).musicSrc = finalRel;
  item.updatedAt = nowIso();
  saveItem(item);
  return { musicSrc: finalRel, source: m.source };
}
