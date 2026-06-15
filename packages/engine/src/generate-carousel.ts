import { z } from "zod";
import { CarouselSpec, type ContentItem, type ChannelId } from "@os/schemas";
import { getTheme, getMood } from "@os/tokens";
import { think } from "./brain.ts";
import { resolveChannel } from "./channels.ts";
import { saveItem, loadItem, newId, nowIso, logLine, charge } from "./store.ts";
import { generateImage } from "./thumbnail.ts";
import { renderCarouselSlides } from "./render.ts";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REMOTION_PUBLIC = join(HERE, "..", "..", "remotion", "public");

/* ─── generateCarousel ────────────────────────────────────────────────────────
   Full carousel pipeline: idea → CarouselSpec → optional AI slide backgrounds
   → per-slide PNG renders → packaged ContentItem.

   opts.slides        — number of slides (default 6, min 3, max 12)
   opts.mood          — mood preset override (uses channel default otherwise)
   opts.aspect        — "1:1" square (default) or "4:5" portrait
   opts.preview       — skip AI image generation and use cheaper brain tier
   opts.onLog         — progress callback
   ────────────────────────────────────────────────────────────────────────── */
export async function generateCarousel(
  seed: string,
  channelId: string,
  opts: {
    slides?: number;
    mood?: string;
    aspect?: "1:1" | "4:5";
    preview?: boolean;
    onLog?: (m: string) => void;
  } = {},
): Promise<ContentItem> {
  const channel = resolveChannel(channelId);
  const n = Math.max(3, Math.min(12, opts.slides ?? 6));
  const aspect = opts.aspect ?? "1:1";
  const moodId = opts.mood ?? channel.defaultMood ?? "explainer";
  const log = (m: string) => {
    opts.onLog?.(m);
    console.log(`  [carousel] ${m}`);
  };

  // 1. Create the ContentItem shell.
  const item: ContentItem = {
    id: newId(channel.id),
    channel: channel.id as ChannelId,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    status: "idea_proposed",
    kind: "carousel",
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

  // 2. Brain: design the CarouselSpec.
  step("designing carousel spec…");
  const mood = getMood(moodId);
  const theme = getTheme(channel.theme);
  const accent = channel.accent ?? theme.accent.brand;

  // Lenient schema for the brain — the brain may emit optional fields inconsistently.
  // We parse leniently then coerce to the real CarouselSpec.
  const RawSlide = z.object({
    id: z.string(),
    headline: z.string(),
    body: z.string().optional(),
    imagePrompt: z.string().optional(),
    bgColor: z.string().optional(),
    layout: z.enum(["text_only", "text_over_image", "highlight_bar", "split", "stat_card"]).optional(),
    eyebrow: z.string().optional(),
    isCover: z.boolean().optional(),
    isCta: z.boolean().optional(),
    accent: z.string().optional(),
  });
  const RawCarousel = z.object({
    slides: z.array(RawSlide).min(3).max(12),
    hook: z.string(),
    cta: z.string(),
    topic: z.string(),
  });

  const prompt = `You are a premium Instagram carousel designer for ${channel.name}.

Channel: ${channel.name}
Audience: ${channel.audience}${channel.domain ? `\nDomain: ${channel.domain}` : ""}
Tone: ${channel.tone}
Visual style: ${channel.visualStyle}
Mood: ${mood.name} — ${mood.tone}
Brand accent: ${accent}

Design a ${n}-slide Instagram carousel about: "${seed}"

Rules:
- Slide 1 MUST be the cover (isCover: true): bold hook headline, eyebrow label, no body.
- Last slide MUST be the CTA (isCta: true): follow/save/share prompt + @handle.
- Middle slides: one punchy insight per slide. Short headline (max 10 words). 1-2 line body.
- Choose a layout per slide: "highlight_bar" (default, headline with accent bar), "text_only" (clean dark),
  "text_over_image" (if imagePrompt set), "stat_card" (for data/numbers), "split" (two-column).
- Set imagePrompt on slides where a cinematic AI background would enhance the message (concrete scenes,
  dramatic visuals). Leave unset on pure typographic slides.
- eyebrow: short category label (e.g. "Step 1", "Key Insight", "Warning", "Result").
- Vary layouts across slides for visual rhythm — do not repeat the same layout 3 times in a row.
- topic: the carousel's core subject (short phrase).
- hook: the scroll-stopping opening question/statement shown on the cover.
- cta: the closing call to action.

STYLE: no em dashes, no hype, no "game-changer". Sharp and specific. Write like a smart human.

Return ONLY JSON:
{"slides":[{"id","headline","body?","imagePrompt?","bgColor?","layout","eyebrow?","isCover?","isCta?","accent?"}],"hook","cta","topic"}`;

  const tier = opts.preview ? "smart" : "best";
  const brainResult = await think(RawCarousel, prompt, tier, 2, "carousel_write");
  charge(item.ledger, "carousel_spec", brainResult.usd);

  // Coerce + validate into the canonical CarouselSpec.
  const raw = brainResult.data;
  const carouselSpec = CarouselSpec.parse({
    channel: channel.id,
    topic: raw.topic,
    hook: raw.hook,
    cta: raw.cta,
    theme: channel.theme,
    aspect,
    mood: moodId,
    slides: raw.slides.map((s, i) => ({
      id: s.id || `slide_${i + 1}`,
      headline: s.headline,
      body: s.body,
      imagePrompt: s.imagePrompt,
      bgColor: s.bgColor,
      layout: s.layout ?? "highlight_bar",
      eyebrow: s.eyebrow,
      isCover: s.isCover,
      isCta: s.isCta,
      accent: s.accent,
    })),
  });

  item.carousel = carouselSpec;
  item.status = "storyboard_ready"; // closest lifecycle for a carousel spec
  step(`carousel spec ready — ${carouselSpec.slides.length} slides`);

  // 3. Optionally generate AI background images for slides with imagePrompt.
  if (!opts.preview) {
    for (const slide of carouselSpec.slides) {
      if (!slide.imagePrompt) continue;
      step(`generating background for slide "${slide.id}"…`);
      const imgAspect = aspect === "4:5" ? ("9:16" as const) : ("1:1" as const);
      const safeName = `${item.id}_${slide.id.replace(/[^a-z0-9_-]/gi, "_")}`;
      const absOut = join(REMOTION_PUBLIC, "gen", `${safeName}.png`);
      const result = generateImage(slide.imagePrompt, absOut, { aspect: imgAspect, log });
      if (result) {
        // Store the public-relative path back on the slide so the renderer can
        // find it as a staticFile (bundle snapshot includes gen/ at bundle time).
        slide.bgColor = slide.bgColor ?? undefined;
        // We pass bgImageSrc separately to the renderer via renderCarouselSlides —
        // attach as imagePrompt's resolved path convention on the slide.
        (slide as Record<string, unknown>)._resolvedBg = `gen/${safeName}.png`;
      } else {
        log(`  image gen skipped for ${slide.id} (no backend / failed)`);
      }
    }
  }

  // 4. Render each slide as a PNG.
  step("rendering slides…");
  const slideHandle = channel.handle;
  const slideLogo = channel.logo;

  let slidePaths: string[] = [];
  try {
    slidePaths = await renderCarouselSlides(item.id, carouselSpec, accent, {
      handle: slideHandle,
      logo: slideLogo,
      themeName: channel.theme,
      mood: moodId,
      log,
    });
  } catch (e) {
    logLine(item, `render failed: ${String(e).slice(0, 200)}`);
    item.status = "failed";
    saveItem(item);
    throw e;
  }

  item.carouselSlides = slidePaths;
  item.status = "rendered";
  item.thumbPath = slidePaths[0] ?? undefined; // first slide as preview thumb
  step(`rendered ${slidePaths.length} slides`);

  // 5. Package with a standard caption.
  item.pkg = {
    title: carouselSpec.hook,
    caption: `${carouselSpec.hook}\n\n${carouselSpec.cta}`,
    hashtags: ["carousel", "instagram", channel.id],
    altText: `${carouselSpec.topic} — ${carouselSpec.slides.length}-slide carousel`,
  };
  item.status = "packaged";
  step("packaged");

  saveItem(item);
  return item;
}
