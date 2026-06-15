import "./env.ts";
import { loadItem, saveItem } from "./store.ts";
import { autoSyncAfter } from "./sync.ts";
import { resolveChannel, defaultMoodFor, resolveVoiceSettings } from "./channels.ts";
import { synthVoiceSceneSynced, ensureMusic, evenSubtitles, musicBeatFrames, synthSfx, buildSfxCues, duckMusic, polishVoice } from "./media.ts";
import { resolveScenesBroll, resolveGridCells, loadUsed } from "./broll.ts";
import { musicPrompt } from "./music-prompt.ts";
import { renderPost, renderCover, coverBg } from "./render.ts";
import { Storyboard } from "@os/schemas";
import { getMood } from "@os/tokens";
import { cleanStoryboard, cleanScript } from "./sanitize.ts";
import type { PostProps, SubtitleCue, WordCue } from "./types.ts";

/* Re-render an existing run with current code — no LLM cost.
   Flags: --voice (scene-synced VO + karaoke), --no-music, --procedural (skip MusicGen). */
export async function rerender(id: string, opts: { voice?: boolean; music?: boolean; broll?: boolean; procedural?: boolean; preview?: boolean; mood?: string } = {}) {
  const item = loadItem(id);
  if (!item.storyboard || !item.script) throw new Error(`${id} has no storyboard/script`);
  let board = cleanStoryboard(Storyboard.parse(item.storyboard));
  item.script = cleanScript(item.script);
  const channel = resolveChannel(item.channel);
  const log = (m: string) => console.log("  " + m);

  // Mood: explicit override → the post's stored mood → channel default → explainer.
  const mood = getMood(opts.mood ?? item.mood ?? defaultMoodFor(channel));
  item.mood = mood.id;
  log(`mood: ${mood.name}`);

  let voiceSrc: string | undefined;
  let musicSrc: string | undefined;
  let words: WordCue[] | undefined;
  let subtitles: SubtitleCue[] = evenSubtitles(board, item.script.narration);

  if (opts.voice === true) {
    const vs = resolveVoiceSettings(channel, mood.id);
    const v = synthVoiceSceneSynced(id, board.scenes, 30, channel.voice, vs.kokoroSpeed, channel.elevenVoice, vs);
    if (v) {
      voiceSrc = v.src;
      words = v.words.length ? v.words : undefined;
      subtitles = v.subtitles;
      board = { ...board, scenes: board.scenes.map((s, i) => ({ ...s, durationSec: v.durations[i] })) };
      polishVoice(voiceSrc);
      log(`voice ${v.totalSec.toFixed(1)}s via ${v.engine}, ${words?.length ?? 0} words`);
    }
  }
  const videoDur = board.scenes.reduce((a, s) => a + s.durationSec, 0) + 4; // +outro card
  if (opts.music !== false) {
    const m = ensureMusic(id, videoDur, channel.theme, musicPrompt(mood.id, board.topic), { musicgen: !opts.procedural, moodId: mood.id });
    if (m) { musicSrc = m.src; log(`music: ${m.source}`); }
    else log("music: skipped (MUSIC_PROVIDER=none or ffmpeg missing)");
  }

  let brolls: PostProps["brolls"];
  if (opts.broll === true && !mood.noBroll) {
    const usedBroll = loadUsed();
    brolls = await resolveScenesBroll(board.scenes, usedBroll, mood.footageSearch);
    const cells = await resolveGridCells(board.scenes, usedBroll, mood.footageSearch);
    log(`b-roll: ${brolls.filter(Boolean).length}/${board.scenes.length} scenes${cells ? ` + ${cells} grid panels` : ""}`);
  } else if (mood.noBroll) {
    log("b-roll: skipped (pure motion graphics)");
  }

  // brand the in-video CTA handle to the channel (storyboards may carry an old name)
  board = { ...board, scenes: board.scenes.map((s) => (s.type === "cta" ? { ...s, handle: channel.handle ?? s.handle } : s)) };

  const beatFrames = musicSrc ? musicBeatFrames(musicSrc, 30) : [];
  const sfxPaths = synthSfx();
  const sfx = sfxPaths ? buildSfxCues(board.scenes.map((s) => s.durationSec), sfxPaths, 30, board.scenes.map((s) => !!s.emphasis)) : undefined;
  log(`beat-sync: ${beatFrames.length} beats; sfx: ${sfx?.length ?? 0} cues`);

  if (musicSrc && voiceSrc) musicSrc = duckMusic(id, musicSrc, voiceSrc);

  const props: PostProps = { storyboard: mood.theme ? { ...board, theme: mood.theme } : board, subtitles, words, brolls, beatFrames, sfx, mix: item.mix, voiceSrc, musicSrc, brandAccent: channel.accent, channelLabel: channel.name.toLowerCase(), channelLogo: channel.logo, channelHandle: channel.handle, channelSite: channel.site, channelSocials: channel.socials, mood: mood.id };
  const out = await renderPost(id, props, { preview: opts.preview, log });
  item.videoPath = out;
  item.storyboard = board; // persist sanitized (+ voice-fitted) storyboard

  // refresh the designed cover too
  if (!opts.preview && item.script) {
    const hw = item.script.hook.split(/\s+/).filter(Boolean);
    const cover = await renderCover(id, {
      title: item.script.hook,
      eyebrow: (item.idea?.topic ?? "").split(/\s+/).slice(0, 3).join(" "),
      highlight: (hw[hw.length - 1] || "").replace(/[^\w]/g, ""),
      themeName: mood.theme ?? channel.theme,
      mood: mood.id,
      bg: coverBg(id, brolls),
      logo: channel.logo,
      handle: channel.handle,
    }).catch(() => null);
    if (cover) { item.thumbPath = cover; log("cover refreshed"); }
  }
  saveItem(item);
  console.log(`\n✓ re-rendered → ${out}`);
  autoSyncAfter("rerender"); // push the refreshed run/render up so production reflects it
  return out;
}

// Run the standalone-script block ONLY when this file is the entry point
// (`node rerender.ts <id>`). When cli.ts (or anything) IMPORTS this module, the
// top-level code would otherwise execute with the PARENT command's argv —
// e.g. `content package <id>` makes process.argv[2] = "package", firing
// rerender("package") → loadItem("package") → ENOENT and exitCode=1, which broke
// every command (incl. the dashboard's caption generation). Guard on argv[1].
const isMain = /[/\\]rerender\.ts$/.test(process.argv[1] || "");
const id = isMain ? process.argv[2] : undefined;
const moodArg = (() => { const i = process.argv.indexOf("--mood"); return i >= 0 ? process.argv[i + 1] : undefined; })();
if (id)
  rerender(id, {
    voice: process.argv.includes("--voice"),
    broll: process.argv.includes("--broll"),
    procedural: process.argv.includes("--procedural"),
    preview: process.argv.includes("--preview"),
    mood: moodArg,
  }).catch((e) => {
    console.error("✗", e?.message ?? e);
    process.exitCode = 1;
  });
