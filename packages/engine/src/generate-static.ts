/* Static-image post pipeline.
   seed → idea (via ideate) → script (hook + beats + cta) → AI key-visual →
   renderStatic PNG → ContentItem with kind="static_image".

   The "script" for a static post is intentionally thin:
     headline = script.hook   (the scroll-stopper)
     body      = script.beats[0] (one supporting line)
     cta baked into item.script.cta, not rendered onto the image by default
*/

import { type ChannelId } from "@os/schemas";
import { getMood } from "@os/tokens";
import { resolveChannel, channelForMood, defaultMoodFor } from "./channels.ts";
import { ideate, pickHook, writeScript } from "./stages.ts";
import { cleanIdea, cleanScript } from "./sanitize.ts";
import { saveItem, newId, nowIso, logLine, charge } from "./store.ts";
import { aiKeyVisual } from "./thumbnail.ts";
import { renderStatic } from "./render.ts";
import type { ContentItem } from "@os/schemas";

export async function generateStatic(
  seed: string,
  channelId: string,
  opts: {
    layout?: "text_only" | "text_over_image" | "highlight_bar" | "split" | "stat_card";
    mood?: string;
    voice?: boolean;
    preview?: boolean;
    onLog?: (m: string) => void;
  } = {},
): Promise<ContentItem> {
  const channel = resolveChannel(channelId);
  const log = (m: string) => {
    opts.onLog?.(m);
    console.log(`  ${m}`);
  };

  const item: ContentItem = {
    id: newId(channel.id),
    channel: channel.id as ChannelId,
    kind: "static_image",
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

  // 1. Idea — same as the video pipeline but kept quick (no trend scan for stills).
  step("ideating…");
  const ideaResult = await ideate(channel, seed);
  charge(item.ledger, "idea", ideaResult.usd);
  item.idea = cleanIdea(ideaResult.data);
  step(`idea: ${item.idea.topic} [${item.idea.format}]`);

  // Resolve mood cluster.
  const moodId = opts.mood ?? item.idea.mood ?? defaultMoodFor(channel);
  const mood = getMood(moodId);
  item.mood = mood.id;
  const ec = channelForMood(channel, mood.id);
  step(`mood: ${mood.name}`);

  // 2. Hook → Script (the script gives us headline + body text).
  const hookResult = await pickHook(ec, item.idea, mood.id);
  charge(item.ledger, "hook", hookResult.usd);
  step(`hook: "${hookResult.data.best}"`);

  const scriptResult = await writeScript(ec, item.idea, hookResult.data.best, mood.id);
  charge(item.ledger, "script", scriptResult.usd);
  item.script = cleanScript(scriptResult.data);
  item.status = "script_ready";
  step(`script ready`);

  // Derive the static copy from the script:
  //   headline = hook (the scroll-stopper, <= 9 words by schema)
  //   body     = beats[0] (first supporting beat — one punchy line)
  const headline = item.script.hook;
  const body = item.script.beats[0] ?? undefined;
  const layout = opts.layout ?? "highlight_bar";

  // 3. AI key-visual background.
  step("generating AI background image…");
  let bgImageSrc: string | undefined;
  try {
    const bg = await aiKeyVisual(item, log);
    if (bg) {
      bgImageSrc = bg;
      step("AI key-visual ready");
    } else {
      step("AI key-visual unavailable, using gradient fallback");
    }
  } catch (e: unknown) {
    step(`AI key-visual failed (${(e as Error)?.message?.slice(0, 60) ?? e}), using gradient fallback`);
  }

  // 4. Render the PNG via Remotion renderStill.
  // Use "storyboard_ready" as the in-progress marker (closest available state);
  // status advances to "rendered" when the PNG lands.
  item.status = "storyboard_ready";
  saveItem(item);
  step("rendering static PNG…");

  const accent = channel.accent ?? "#d4f700";
  const themeName = channel.theme;
  const handle = channel.handle;
  const logo = channel.logo;

  const pngPath = await renderStatic(
    item.id,
    {
      headline,
      body,
      layout,
      bgImageSrc,
      accent,
      themeName,
      mood: mood.id,
      handle,
      logo,
      width: 1080,
      height: 1080,
    },
    { log },
  );

  item.staticImagePath = pngPath;
  item.status = "rendered";

  // Persist the StaticImageSpec alongside the item for reference / carousel re-use.
  item.staticImage = {
    channel: channel.id as ChannelId,
    topic: item.idea.topic,
    headline,
    body,
    layout,
    theme: themeName,
    aspect: "1:1",
    mood: mood.id,
    accent,
  };

  step(`rendered → ${pngPath}`);
  saveItem(item);
  return item;
}
