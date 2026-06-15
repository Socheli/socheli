import { homedir } from "node:os";
import { copyFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { ContentItem, Storyboard, Script, type ChannelId } from "@os/schemas";
import { getMood } from "@os/tokens";
import { resolveChannel } from "./channels.ts";
import { newId, nowIso, logLine, saveItem, RENDERS_DIR } from "./store.ts";
import { ensureMusic, evenSubtitles, musicBeatFrames, synthSfx, buildSfxCues } from "./media.ts";
import { musicPrompt } from "./music-prompt.ts";
import { renderPost } from "./render.ts";
import type { PostProps, SubtitleCue } from "./types.ts";

/* ─── content demo "<idea>" — the ZERO-AUTH one-liner ────────────────────────
   Renders a real premium 9:16 vertical from a single idea with NO API keys:
     · brain   → SKIPPED. A canned storyboard fixture (built off the idea text)
                 stands in for idea→script→storyboard, so no LLM/key is touched.
     · mood    → motion_graphics (noBroll) → renders on clean generated graphics,
                 so no Pexels/stock-footage key is needed.
     · music   → ensureMusic synth ambient bed (pure ffmpeg sines) — no key.
     · voice   → OFF (subtitles only via evenSubtitles) — never blocks on TTS.
   Robust: every optional step (music/sfx/cover) is best-effort and never hangs.
   Fast: preview render (lower settings, short ~18s clip). */

const titleCase = (s: string) =>
  s.replace(/\b\w/g, (c) => c.toUpperCase()).replace(/\s+/g, " ").trim();

// Trim the idea to a short on-screen hook (<= ~7 words, the hook_text cap).
const hookText = (idea: string): string => {
  const words = idea.replace(/[.?!]+$/, "").split(/\s+/).filter(Boolean);
  return titleCase(words.slice(0, 7).join(" "));
};

const firstWords = (idea: string, n: number) =>
  idea.split(/\s+/).filter(Boolean).slice(0, n).join(" ");

/* Build a 5-scene motion-graphics storyboard purely from the idea string. No
   model — just templated, deterministic copy that names the idea in every beat.
   Total ~18s (within the [min,max] total-duration guard). Parsed through the
   Storyboard schema so the render contract is guaranteed valid. */
function demoStoryboard(idea: string, channel: ReturnType<typeof resolveChannel>): Storyboard {
  const subject = firstWords(idea, 6) || "this idea";
  const hook = hookText(idea);
  const sb = {
    channel: channel.id as ChannelId,
    theme: "concept",
    topic: titleCase(firstWords(idea, 8)),
    format: "before_after" as const,
    hook,
    fps: 30,
    width: 1080,
    height: 1920,
    aspect: "9:16" as const,
    scenes: [
      {
        id: "s1",
        type: "hook_text" as const,
        text: hook,
        say: `Here's the truth about ${subject}.`,
        durationSec: 3,
        emphasis: true,
      },
      {
        id: "s2",
        type: "kinetic_text" as const,
        lines: ["Most people", "get this", "completely wrong."],
        highlight: ["wrong"],
        say: `Most people get ${subject} completely wrong.`,
        durationSec: 3.5,
      },
      {
        id: "s3",
        type: "big_number" as const,
        value: "90%",
        label: `miss what actually matters about ${subject}`,
        say: `Nearly everyone misses what actually matters.`,
        durationSec: 3.5,
        emphasis: true,
      },
      {
        id: "s4",
        type: "bento" as const,
        heading: "What you're really looking at",
        cards: [
          { title: "The setup", text: "what you assume is true" },
          { title: "The twist", text: "what's really going on" },
          { title: "The payoff", text: "why it changes everything" },
        ],
        say: `Once you see the setup, the twist, and the payoff, it clicks.`,
        durationSec: 4,
      },
      {
        id: "s5",
        type: "cta" as const,
        text: "Follow for more",
        handle: channel.handle ?? "@socheli",
        say: `Follow for more — one idea, made clear.`,
        durationSec: 3,
      },
    ],
    cta: "Follow for more",
  };
  // Parse through the schema → fills defaults (motion, level, accents) + guards
  // the duration/scene-count contract. Throwing here would be a fixture bug.
  return Storyboard.parse(sb);
}

export type DemoOpts = { mood?: string; onLog?: (m: string) => void };

/* Run the zero-auth demo. Returns the finished item + the friendly saved path. */
export async function demoGenerate(seed: string, opts: DemoOpts = {}): Promise<{ item: ContentItem; savedPath: string }> {
  const idea = seed.trim() || "how memory actually works";
  const channel = resolveChannel("labrinox");
  const log = (m: string) => {
    opts.onLog?.(m);
    console.log(`  ${m}`);
  };

  // motion_graphics is the no-key visual: noBroll → no Pexels, clean generated bg.
  const mood = getMood(opts.mood || "motion_graphics");

  const item: ContentItem = {
    id: newId(channel.id),
    channel: channel.id as ChannelId,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    status: "idea_proposed",
    seedIdea: `(demo) ${idea}`,
    mood: mood.id,
    ledger: { entries: [], totalUsd: 0 },
    log: [],
  };
  const step = (msg: string) => {
    logLine(item, msg);
    log(msg);
    saveItem(item);
  };
  saveItem(item);

  step(`demo mode — no API keys, canned storyboard, mood ${mood.name}`);

  // 1. Canned idea/script/storyboard (no brain).
  const board = demoStoryboard(idea, channel);
  item.storyboard = board;
  const script: Script = {
    hook: board.hook,
    beats: board.scenes.map((s) => s.say ?? "").filter(Boolean),
    cta: board.cta,
    narration: board.scenes.map((s) => s.say ?? "").filter(Boolean),
  };
  item.script = script;
  item.status = "storyboard_ready";
  const totalSec = board.scenes.reduce((a, s) => a + s.durationSec, 0);
  step(`storyboard: ${board.scenes.length} scenes, ${totalSec}s`);

  // 2. Subtitles from the scene `say` lines (no voice synth → never blocks on TTS).
  const subtitles: SubtitleCue[] = evenSubtitles(board, script.narration);

  // 3. Music — synth ambient bed (ffmpeg only). Best-effort: a missing ffmpeg
  //    just ships silent rather than failing.
  let musicSrc: string | undefined;
  try {
    const m = ensureMusic(item.id, totalSec + 4, channel.theme, musicPrompt(mood.id, item.seedIdea), { moodId: mood.id });
    if (m) {
      musicSrc = m.src;
      step(`music: ${m.source}`);
    } else {
      step("music: skipped (ffmpeg missing)");
    }
  } catch {
    step("music: skipped (synth failed)");
  }

  // 4. Beat-sync + sfx (best-effort).
  const beatFrames = musicSrc ? musicBeatFrames(musicSrc, 30) : [];
  const sfxPaths = synthSfx();
  const sfx = sfxPaths
    ? buildSfxCues(board.scenes.map((s) => s.durationSec), sfxPaths, 30, board.scenes.map((s) => !!s.emphasis))
    : undefined;

  // 5. Render — preview settings for speed, no b-roll (noBroll mood).
  const props: PostProps = {
    storyboard: mood.theme ? { ...board, theme: mood.theme } : board,
    subtitles,
    beatFrames,
    sfx,
    musicSrc,
    brandAccent: channel.accent,
    channelLabel: channel.name.toLowerCase(),
    channelLogo: channel.logo,
    channelHandle: channel.handle,
    mood: mood.id,
  };
  step("rendering (preview, ~9:16)…");
  const out = await renderPost(item.id, props, { preview: true, log });
  item.videoPath = out;
  item.status = "rendered";

  // 6. Copy to a friendly local path so a cold visitor sees an obvious artifact.
  const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  let savedPath = out;
  try {
    const dest = join(homedir(), `socheli-demo-${stamp}.mp4`);
    if (existsSync(out)) {
      copyFileSync(out, dest);
      savedPath = dest;
    }
  } catch {
    /* keep the renders-dir path if the home-dir copy fails */
  }
  item.status = "rendered";
  step(`rendered → ${savedPath}`);
  saveItem(item);

  return { item, savedPath };
}
