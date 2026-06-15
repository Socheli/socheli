import { spawnSync } from "node:child_process";
import { resolveChannel, channelForMood, defaultMoodFor, resolveVoiceSettings } from "./channels.ts";
import { getMood } from "@os/tokens";
import { outlineLongform, researchLongform } from "./longform-outline.ts";
import { writeChapter, buildChapterBoard } from "./longform-chapter.ts";
import { synthVoiceSceneSynced, polishVoice, ensureMusic, synthSfx, buildSfxCues, evenSubtitles } from "./media.ts";
import { resolveScenesBroll, resolveGridCells, loadUsed } from "./broll.ts";
import { renderPost, concatVideos, addMusicBed, renderCover, coverBg, resetBundle } from "./render.ts";
import { youtubeThumbnail } from "./thumbnail.ts";
import { cleanStoryboard } from "./sanitize.ts";
import { musicPrompt } from "./music-prompt.ts";
import { saveItem, newId, nowIso, logLine, charge, RENDERS_DIR } from "./store.ts";
import { autoSyncAfterRender } from "./sync.ts";
import { Storyboard } from "@os/schemas";
import { join } from "node:path";
import type { PostProps, SubtitleCue, WordCue } from "./types.ts";

const OUTRO_SEC = 100 / 30; // ~3.33s — the per-chapter outro card we trim off

function probe(file: string): number {
  const r = spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file], { encoding: "utf8" });
  return parseFloat((r.stdout || "0").trim()) || 0;
}

/* Trim `seconds` off the tail and re-encode (keeps params uniform for concat). */
function trimTail(file: string, seconds: number): string {
  const dur = probe(file);
  const keep = Math.max(1, dur - seconds);
  const out = file.replace(/\.mp4$/, "_t.mp4");
  const r = spawnSync(
    "ffmpeg",
    ["-y", "-i", file, "-t", keep.toFixed(2), "-c:v", "libx264", "-crf", "18", "-pix_fmt", "yuv420p", "-r", "30", "-c:a", "aac", "-b:a", "256k", out],
    { encoding: "utf8" },
  );
  return r.status === 0 ? out : file;
}

export type LongformOpts = { mood?: string; onLog?: (m: string) => void };

/* Long-form 16:9 YouTube pipeline: outline → shared research → per-chapter
   (script → 16:9 storyboard → voice → b-roll → render) → concat → score → cover. */
export async function generateLongform(topic: string, channelId: string, opts: LongformOpts = {}) {
  const channel = resolveChannel(channelId);
  const log = (m: string) => {
    opts.onLog?.(m);
    console.log(`  ${m}`);
  };
  const moodId = opts.mood ?? defaultMoodFor(channel);
  const mood = getMood(moodId);
  const ec = channelForMood(channel, moodId);

  const item: any = {
    id: newId(channel.id),
    channel: channel.id,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    status: "idea_proposed",
    seedIdea: topic,
    mood: moodId,
    kind: "longform",
    ledger: { entries: [], totalUsd: 0 },
    log: [],
  };
  const step = (msg: string) => {
    logLine(item, msg);
    log(msg);
    saveItem(item);
  };
  saveItem(item);

  // 1. Outline (title + thesis + chapters w/ sub-moods)
  step("outlining the video…");
  const outline = await outlineLongform(ec, topic, moodId);
  charge(item.ledger, "outline", outline.usd);
  item.idea = { topic: outline.data.title, angle: outline.data.thesis, format: "mistake_fix", rationale: outline.data.thesis };
  item.pkg = { title: outline.data.title, caption: outline.data.thesis, hashtags: [], altText: outline.data.title };
  step(`title: "${outline.data.title}" · ${outline.data.chapters.length} chapters`);

  // 2. ONE shared research cache for the whole video (factual consistency)
  step("researching (shared cache)…");
  let research = "";
  try {
    research = (await researchLongform(topic, outline.data)).research;
  } catch {
    /* fail open */
  }

  // 3. Per chapter, SERIALLY (shared assets dir + Chrome stability under load)
  const trimmed: string[] = [];
  const chapters = outline.data.chapters;
  for (let ci = 0; ci < chapters.length; ci++) {
    const ch = chapters[ci];
    step(`chapter ${ch.number}/${chapters.length}: ${ch.title}`);
    const nar = await writeChapter(ec, moodId, outline.data, ch, research);
    charge(item.ledger, `c${ch.number}-script`, nar.usd);
    const boardR = await buildChapterBoard(ec, moodId, ch, nar.data.narration);
    charge(item.ledger, `c${ch.number}-board`, boardR.usd);

    // sanitize + shape as a 16:9 storyboard the renderer understands
    let board: any = cleanStoryboard({
      channel: channel.id,
      theme: channel.theme,
      topic,
      format: "mistake_fix",
      hook: ch.title,
      fps: 30,
      width: 1920,
      height: 1080,
      scenes: boardR.data.scenes,
      cta: "",
    } as any);
    let scenes = board.scenes;

    const chId = `${item.id}_c${ch.number}`;
    let voiceSrc: string | undefined;
    let words: WordCue[] | undefined;
    let subtitles: SubtitleCue[] = [];
    const vs = resolveVoiceSettings(channel, moodId);
    const v = synthVoiceSceneSynced(chId, scenes, 30, channel.voice, vs.kokoroSpeed, channel.elevenVoice, vs);
    if (v) {
      voiceSrc = v.src;
      words = v.words.length ? v.words : undefined;
      subtitles = v.subtitles;
      scenes = scenes.map((s: any, i: number) => ({ ...s, durationSec: v.durations[i] }));
      polishVoice(voiceSrc);
    } else {
      subtitles = evenSubtitles(board, nar.data.narration);
    }

    const usedBroll = loadUsed();
    let brolls: (Awaited<ReturnType<typeof resolveScenesBroll>>) | undefined;
    if (!mood.noBroll) {
      brolls = await resolveScenesBroll(scenes, usedBroll, mood.footageSearch);
      await resolveGridCells(scenes, usedBroll, mood.footageSearch);
    }
    const sfxPaths = synthSfx();
    const sfx = sfxPaths ? buildSfxCues(scenes.map((s: any) => s.durationSec), sfxPaths, 30, scenes.map((s: any) => !!s.emphasis)) : undefined;

    const props: PostProps = {
      storyboard: { ...board, scenes } as any,
      subtitles,
      words,
      brolls,
      sfx,
      mood: moodId,
      voiceSrc,
      brandAccent: channel.accent,
      // YouTube long-form: NO burned-in karaoke captions (viewers use CC; on a
      // 16:9 frame the short-form caption band lands dead-center anyway).
      mix: { subtitles: { enabled: false } },
      channelLabel: channel.name.toLowerCase(),
      channelLogo: channel.logo,
      channelHandle: channel.handle,
      channelSite: channel.site,
      channelSocials: channel.socials,
      // chapters carry NO music — one continuous bed is laid over the whole video
    };
    resetBundle(); // re-bundle so THIS chapter's freshly-resolved b-roll is served
    const out = await renderPost(chId, props, { log });
    // Pass EVERY chapter through the re-encode so they share ONE timebase (concat
    // of mixed timebases silently inflates the total). Non-last chapters also lose
    // the per-chapter outro card; the last keeps it (one outro for the video).
    trimmed.push(trimTail(out, ci < chapters.length - 1 ? OUTRO_SEC : 0));
    item.updatedAt = nowIso();
    saveItem(item);
  }

  // 4. Assemble (concat chapters)
  step("assembling chapters…");
  const concatOut = concatVideos(item.id, trimmed);
  if (!concatOut) throw new Error("chapter concat failed");

  // 5. One continuous music bed under the whole video + master
  step("scoring…");
  const totalSec = probe(concatOut);
  const m = ensureMusic(item.id, totalSec, channel.theme, musicPrompt(moodId, topic), { moodId });
  if (m) addMusicBed(concatOut, m.src, log);
  item.videoPath = concatOut;
  item.status = "rendered";
  step(`rendered → ${concatOut} (${Math.round(totalSec)}s)`);

  // 6. Thumbnail. Long-form is a 16:9 YouTube video, so generate a real 16:9
  //    YouTube thumbnail (AI key visual + baked-in title) rather than the
  //    vertical short-form Cover. Falls back to the designed cover if no image
  //    backend is available.
  try {
    const t = outline.data.title;
    const yt = youtubeThumbnail(item, log);
    if (yt) {
      item.thumbPath = yt;
      step("16:9 YouTube thumbnail generated");
    } else {
      const w = t.split(/\s+/).filter(Boolean);
      const cover = await renderCover(item.id, {
        title: t,
        eyebrow: topic.split(/\s+/).slice(0, 3).join(" "),
        highlight: (w[w.length - 1] || "").replace(/[^\w]/g, ""),
        themeName: channel.theme,
        mood: moodId,
        bg: coverBg(item.id, undefined),
        logo: channel.logo,
        handle: channel.handle,
      });
      if (cover) item.thumbPath = cover;
    }
  } catch {
    /* non-fatal */
  }

  item.status = "packaged";
  step(`✓ long-form done: ${item.id}`);
  saveItem(item);
  autoSyncAfterRender(item);
  return item;
}
