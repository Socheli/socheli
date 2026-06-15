import { ContentItem, Storyboard, RULES, QA_PASS_THRESHOLD, type ChannelId, type Idea } from "@os/schemas";
import { getMood } from "@os/tokens";
import { resolveChannel, channelForMood, defaultMoodFor, resolveVoiceSettings } from "./channels.ts";
import { ideate, scanTrends, pickHook, writeScript, buildStoryboard, factCheck, runQA, reviseStoryboard, packagePost } from "./stages.ts";
import { selectConcept } from "./selection.ts";
import { runResearch } from "./research/orchestrator.ts";
import { getLearnings, recordWin } from "./learnings.ts";
import { genomeContextSafe } from "./dna.ts";
import { saveItem, loadItem, newId, nowIso, logLine, charge, warn } from "./store.ts";
import { autoSyncAfterRender } from "./sync.ts";
import { synthVoiceSceneSynced, ensureMusic, evenSubtitles, musicBeatFrames, synthSfx, buildSfxCues, duckMusic, polishVoice } from "./media.ts";
import { resolveScenesBroll, resolveGridCells, loadUsed } from "./broll.ts";
import { makeThumbnail } from "./derivatives.ts";
import { musicPrompt } from "./music-prompt.ts";
import { cleanIdea, cleanScript, cleanStoryboard, cleanPackage } from "./sanitize.ts";
import { renderPost, renderCover, coverBg } from "./render.ts";
import { choreographWordCues } from "./creative/caption-style.ts";
import { aiKeyVisual } from "./thumbnail.ts";
import type { PostProps, SubtitleCue, WordCue } from "./types.ts";

type Opts = {
  voice?: boolean;
  music?: boolean;
  broll?: boolean;
  preview?: boolean;
  mood?: string; // override the mood preset (else channel default / idea suggestion)
  abStoryboard?: boolean; // default true — generate 2 storyboard variants, pick higher-scoring
  maxQaPasses?: number;   // default 3 — max iterative QA+revision cycles before render
  research?: "quick" | "standard" | "deep"; // run verified research on the seed FIRST, fold the cited report into ideation
  onLog?: (m: string) => void;
};

export async function generate(seed: string, channelId: string, opts: Opts = {}): Promise<ContentItem> {
  const channel = resolveChannel(channelId);
  const log = (m: string) => {
    opts.onLog?.(m);
    console.log(`  ${m}`);
  };

  const item: ContentItem = {
    id: newId(channel.id),
    channel: channel.id as ChannelId,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    status: "idea_proposed",
    seedIdea: seed,
    ledger: { entries: [], totalUsd: 0 },
    log: [],
  };
  const step = (msg: string) => {
    logLine(item, msg);
    log(msg);
    saveItem(item);
  };
  saveItem(item);

  // 1. Idea. Two paths:
  //    (a) operator gave a seed → refine that ONE idea (trend/learning aware).
  //    (b) no seed (autonomous) → SELECT a concept: propose a scored slate and
  //        take the winner. This is the "what should we make?" decision.
  const autoSelect = !seed.trim() || seed.trim().toLowerCase() === "auto";
  let idea: { data: Idea; usd: number };
  if (autoSelect) {
    step("selecting concept (trend + learning aware)…");
    const sel = await selectConcept(channel, 5, log);
    charge(item.ledger, "concept-select", sel.usd);
    idea = { data: cleanIdea(sel.idea), usd: 0 };
    item.seedIdea = `(auto) ${sel.idea.topic}`;
    item.idea = idea.data;
    step(`picked concept: ${idea.data.topic} [${idea.data.format}] from ${sel.board.length} candidates`);
  } else {
    step("scanning trends + learnings…");
    let context = [getLearnings(channel.id), genomeContextSafe(channel.id)].filter(Boolean).join("\n\n");
    try {
      const tr = await scanTrends(channel);
      charge(item.ledger, "trends", tr.usd);
      if (tr.data.angles.length) context = [context, `Trending now: ${tr.data.angles.join("; ")}`].filter(Boolean).join("\n");
    } catch {
      /* trends optional */
    }
    // Deep-research the seed BEFORE ideation when asked: a verified, cited report
    // (+ the strongest verified facts) is folded into the ideation context so the
    // whole video is grounded in real sources, not just the model's priors.
    if (opts.research) {
      step(`researching "${seed}" (${opts.research})…`);
      try {
        const rr = await runResearch(
          { kind: "deep", query: seed, channel: channel.id, depth: opts.research },
          (s) => log(`  research · ${s.label}`),
        );
        charge(item.ledger, "research", rr.usd);
        if (rr.report) {
          const verified = rr.claims.filter((c) => c.status === "verified").slice(0, 8).map((c) => `- ${c.text}`).join("\n");
          context = [
            context,
            `Verified research on "${seed}":\n${rr.report.slice(0, 4000)}${verified ? `\n\nKey verified facts:\n${verified}` : ""}`,
          ].filter(Boolean).join("\n\n");
          step(`research done — ${rr.sources.length} sources · ${rr.claims.length} claims`);
        } else {
          step("research produced no report — continuing from priors");
        }
      } catch (e) {
        warn(item, "research", "research_failed", `research failed (continuing without): ${String((e as Error)?.message ?? e)}`);
      }
    }
    idea = await ideate(channel, seed, context);
    charge(item.ledger, "idea", idea.usd);
    idea.data = cleanIdea(idea.data);
    item.idea = idea.data;
    step(`idea: ${idea.data.topic} [${idea.data.format}]`);
  }

  // Resolve the MOOD cluster: explicit override → idea's suggestion → channel default.
  const moodId = opts.mood ?? idea.data.mood ?? defaultMoodFor(channel);
  const mood = getMood(moodId);
  item.mood = mood.id;
  // effective channel DNA for this content cluster (cluster domain/formats override the base)
  const ec = channelForMood(channel, mood.id);
  step(`mood: ${mood.name}`);

  // 2. Hook engineering (best of 5) → Script  (using the cluster's effective DNA)
  const hook = await pickHook(ec, idea.data, mood.id);
  charge(item.ledger, "hook", hook.usd);
  step(`hook: "${hook.data.best}"`);
  const script = await writeScript(ec, idea.data, hook.data.best, mood.id);
  charge(item.ledger, "script", script.usd);
  script.data = cleanScript(script.data);
  item.script = script.data;
  item.status = "script_ready";
  step(`script: "${script.data.hook}"`);

  // 3. Storyboard — A/B: generate 2 variants in parallel, quick-score, take the better one.
  //    Skip in preview mode (cost saving). Skip for longform (handled per-chapter).
  const doAB = opts.preview !== true && opts.abStoryboard !== false;
  let sb: Awaited<ReturnType<typeof buildStoryboard>>;

  if (doAB) {
    // Generate 2 storyboard variants concurrently — same inputs, different random seeds
    // (the LLM's temperature provides variation; we pass a "variant" hint in guidance)
    const [sbA, sbB] = await Promise.all([
      buildStoryboard(ec, idea.data, script.data, mood.id, "VARIANT A: lean into data/numbers — make every scene carry a specific metric or claim"),
      buildStoryboard(ec, idea.data, script.data, mood.id, "VARIANT B: lean into narrative tension — hook → problem → reveal → payoff arc"),
    ]);
    charge(item.ledger, "storyboard", sbA.usd + sbB.usd);

    // Quick QA score both variants (use a lightweight score — just overall)
    const [qaA, qaB] = await Promise.all([
      runQA(channel, cleanStoryboard(sbA.data), script.data),
      runQA(channel, cleanStoryboard(sbB.data), script.data),
    ]);
    charge(item.ledger, "storyboard-qa", qaA.usd + qaB.usd);

    const winner = qaA.data.overall >= qaB.data.overall ? sbA : sbB;
    const loserScore = qaA.data.overall >= qaB.data.overall ? qaB.data.overall : qaA.data.overall;
    step(`storyboard A/B: picked ${qaA.data.overall >= qaB.data.overall ? "A" : "B"} (${Math.max(qaA.data.overall, qaB.data.overall)}/10 vs ${loserScore}/10)`);
    sb = winner;
  } else {
    sb = await buildStoryboard(ec, idea.data, script.data, mood.id);
    charge(item.ledger, "storyboard", sb.usd);
  }

  sb.data = cleanStoryboard(sb.data);
  sb.data = { ...sb.data, scenes: sb.data.scenes.map((s) => (s.type === "cta" ? { ...s, handle: channel.handle ?? s.handle } : s)) };
  item.storyboard = sb.data;
  item.status = "storyboard_ready";
  step(`storyboard: ${sb.data.scenes.length} scenes, ${sb.data.scenes.reduce((a, s) => a + s.durationSec, 0)}s`);

  // 4a. Fact-check (catch wrong technical claims before render)
  const fc = await factCheck(channel, script.data, sb.data);
  charge(item.ledger, "factcheck", fc.usd);
  if (!fc.data.ok) step(`fact-check flagged: ${fc.data.issues.join("; ")}`);

  // 4b. QA gate — iterative revision loop (up to 3 QA passes, stop when score ≥ 8)
  const QA_TARGET = 8;
  const MAX_QA_PASSES = Math.max(1, Math.min(5, opts.maxQaPasses ?? 3));
  let qa = await runQA(channel, sb.data, script.data);
  charge(item.ledger, "qa", qa.usd);

  for (let pass = 1; pass < MAX_QA_PASSES && (qa.data.overall < QA_TARGET || qa.data.verdict !== "pass" || !fc.data.ok); pass++) {
    const feedback = [
      ...qa.data.notes,
      ...(fc.data.ok ? [] : fc.data.issues),
      ...(qa.data.overall < QA_TARGET ? [`Score is ${qa.data.overall}/10 — target is ${QA_TARGET}. Push harder on specificity and hook sharpness.`] : []),
    ];
    step(`revising (QA ${qa.data.overall}/10, pass ${pass}/${MAX_QA_PASSES - 1}): ${feedback.slice(0, 3).join("; ")}`);
    try {
      const revised = await reviseStoryboard(channel, idea.data, script.data, sb.data, feedback);
      charge(item.ledger, `revise${pass}`, revised.usd);
      sb.data = cleanStoryboard(revised.data);
      sb.data = { ...sb.data, scenes: sb.data.scenes.map((s) => (s.type === "cta" ? { ...s, handle: channel.handle ?? s.handle } : s)) };
      item.storyboard = sb.data;
      qa = await runQA(channel, sb.data, script.data);
      charge(item.ledger, `qa${pass + 1}`, qa.usd);
    } catch {
      break; // keep current storyboard on any failure
    }
  }

  item.qa = qa.data;
  if (qa.data.overall < QA_PASS_THRESHOLD || qa.data.verdict === "kill") {
    item.status = "qa_failed";
    step(`QA failed after ${Math.min(qa.data.overall < QA_TARGET ? MAX_QA_PASSES : 1, MAX_QA_PASSES)} passes: ${qa.data.overall}/10 — ${qa.data.notes.join("; ")}`);
    saveItem(item);
    return item;
  }
  item.status = "qa_passed";
  step(`QA passed: ${qa.data.overall}/10`);

  // 5. Media — scene-synced natural voice (opt-in) + word-level captions + music
  let board = sb.data;
  let voiceSrc: string | undefined;
  let musicSrc: string | undefined;
  let words: WordCue[] | undefined;
  let subtitles: SubtitleCue[] = [];

  if (opts.voice === true) {
    const vs = resolveVoiceSettings(channel, mood.id);
    const v = synthVoiceSceneSynced(item.id, board.scenes, 30, channel.voice, vs.kokoroSpeed, channel.elevenVoice, vs);
    if (v) {
      voiceSrc = v.src;
      words = v.words.length ? v.words : undefined;
      subtitles = v.subtitles;
      board = { ...board, scenes: board.scenes.map((s, i) => ({ ...s, durationSec: v.durations[i] })) };
      const polished = polishVoice(voiceSrc);
      step(`voice: ${v.totalSec.toFixed(1)}s via ${v.engine}, ${words?.length ?? 0} words synced${polished ? " (polished)" : ""}`);
      // Word-level karaoke captions were expected but Whisper degraded → the
      // render shipped phrase-level subtitles. Don't swallow it: record a proper
      // warning (with the real error) that the dashboard + device both surface.
      if (!words && v.captionError) {
        warn(
          item,
          "captions",
          "whisper_failed",
          "Word-level captions unavailable — Whisper transcription failed; shipped phrase-level subtitles instead.",
          v.captionError,
        );
        saveItem(item);
      }
    } else {
      subtitles = evenSubtitles(board, script.data.narration);
      warn(
        item,
        "voice",
        "voice_unavailable",
        "Voiceover synthesis failed — distributed the script as plain subtitles (no narration audio).",
      );
      saveItem(item);
    }
  } else {
    subtitles = evenSubtitles(board, script.data.narration);
  }

  const videoDur = board.scenes.reduce((a, s) => a + s.durationSec, 0) + 4; // +outro card
  if (opts.music !== false) {
    // Music bed is on by default. Provider chain (MUSIC_PROVIDER=auto): hosted
    // music API → local MusicGen (if cached) → curated loops → synthesized ambient
    // bed. Never ships silent unless MUSIC_PROVIDER=none.
    const m = ensureMusic(item.id, videoDur, channel.theme, musicPrompt(mood.id, idea.data.topic), { moodId: mood.id });
    if (m) { musicSrc = m.src; step(`music: ${m.source}`); }
    else step("music: skipped (MUSIC_PROVIDER=none or ffmpeg missing)");
  }

  // 5b. B-roll (hybrid: stock for concrete, AI image for abstract). Pure
  //     motion-graphics moods (mood.noBroll) skip footage entirely — scenes
  //     render on clean generated backgrounds.
  let brolls: PostProps["brolls"];
  if (mood.noBroll) {
    step("b-roll: skipped (pure motion graphics)");
  } else if (opts.broll !== false) {
    const usedBroll = loadUsed();
    brolls = await resolveScenesBroll(board.scenes, usedBroll, mood.footageSearch);
    const cells = await resolveGridCells(board.scenes, usedBroll, mood.footageSearch); // full-bleed bg per grid panel
    const got = brolls.filter(Boolean).length;
    step(got ? `b-roll: ${got}/${board.scenes.length} scenes${cells ? ` + ${cells} grid panels` : ""}` : "b-roll: none (geometric background)");
  }

  // 5c. Beat-sync + sound design
  const beatFrames = musicSrc ? musicBeatFrames(musicSrc, 30) : [];
  const sfxPaths = synthSfx();
  const sfx = sfxPaths ? buildSfxCues(board.scenes.map((s) => s.durationSec), sfxPaths, 30, board.scenes.map((s) => !!s.emphasis)) : undefined;
  if (beatFrames.length) step(`beat-sync: ${beatFrames.length} beats; sfx: ${sfx?.length ?? 0} cues`);

  // 5d. Sidechain-duck music under the voice (mastering happens post-render)
  if (musicSrc && voiceSrc) musicSrc = duckMusic(item.id, musicSrc, voiceSrc);

  // 6. Render
  // Caption choreography: vary the subtitle look line-by-line (hook glow → stat
  // hormozi → quiet phrase) so a GENERATED post isn't one static caption style —
  // the same director the ingest/edit path uses, here driven by the voice cues.
  const captionLineStyles = words && words.length ? choreographWordCues(words, { accent: channel.accent }) : undefined;
  const props: PostProps = {
    // a mood may override the render theme (e.g. --mood ink → white ink_paper)
    storyboard: mood.theme ? { ...board, theme: mood.theme } : board,
    subtitles,
    words,
    captionLineStyles,
    brolls,
    beatFrames,
    sfx,
    voiceSrc,
    musicSrc,
    brandAccent: channel.accent,
    channelLabel: channel.name.toLowerCase(),
    channelLogo: channel.logo,
    channelHandle: channel.handle,
    channelSite: channel.site,
    channelSocials: channel.socials,
    mood: mood.id,
  };
  const out = await renderPost(item.id, props, { preview: opts.preview, log });
  item.videoPath = out;
  item.status = "rendered";
  step(`rendered → ${out}`);

  // 6b. Designed cover (Remotion still) — key visual + bold title + brand, not a frame grab.
  //     Non-fatal: a cover failure must never kill a finished render.
  if (!opts.preview) {
    const hookWords = script.data.hook.split(/\s+/).filter(Boolean);
    // Premium AI key visual (Codex $imagegen / gpt-image-1) when available; else
    // the b-roll/gradient bg. Non-fatal + cached, so it never blocks a render.
    const aiBg = await aiKeyVisual(item, log).catch(() => null);
    if (aiBg) step("AI thumbnail key visual generated");
    const cover = await renderCover(item.id, {
      title: script.data.hook,
      eyebrow: idea.data.topic.split(/\s+/).slice(0, 3).join(" "),
      highlight: (hookWords[hookWords.length - 1] || "").replace(/[^\w]/g, ""),
      themeName: mood.theme ?? channel.theme,
      mood: mood.id,
      bg: aiBg ?? coverBg(item.id, brolls),
      logo: channel.logo,
      handle: channel.handle,
    }).catch((e) => {
      log(`cover failed (${String(e?.message ?? e).slice(0, 80)}), using frame grab`);
      return null;
    });
    item.thumbPath = cover ?? makeThumbnail(item.id, out) ?? undefined;
    step(cover ? "cover generated" : "thumbnail generated (fallback)");
  }

  // 7. Package
  const pkg = await packagePost(channel, sb.data, script.data);
  charge(item.ledger, "package", pkg.usd);
  pkg.data = cleanPackage(pkg.data);
  item.pkg = pkg.data;
  if (qa.data.overall >= 8) recordWin(channel.id, `"${idea.data.topic}" (${idea.data.format}) scored ${qa.data.overall}/10`);
  item.status = "packaged";
  step(`packaged: "${pkg.data.title}" — total $${item.ledger.totalUsd.toFixed(3)}`);

  saveItem(item);
  autoSyncAfterRender(item);
  return item;
}

export { loadItem };
