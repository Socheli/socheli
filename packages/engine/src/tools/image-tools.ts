// image-tools.ts — static_generate + carousel_generate + carousel_get
import { z } from "zod";
import { ok, fail, spawnEngine, tool, type PipelineTool } from "./helpers.ts";
import { loadItem, listItems } from "../store.ts";

export const imageTools: PipelineTool[] = [
  tool({
    name: "static_generate",
    description: "Generate a premium static image post (single photo/quote card) in the @THEKAIZENSHERPA style: textured background, bold serif headline, neon highlight bar. Long-running — returns run id immediately, poll with content_get.",
    kind: "long",
    schema: z.object({
      seed: z.string().min(1),
      channel: z.string().min(1),
      layout: z.enum(["text_only", "text_over_image", "highlight_bar", "split", "stat_card"]).default("highlight_bar"),
      mood: z.string().optional(),
      preview: z.boolean().default(false),
    }).strict(),
    run: ({ seed, channel, layout, mood, preview }) => {
      const args = ["static", seed, "--channel", channel, "--layout", layout];
      if (mood) args.push("--mood", mood);
      if (preview) args.push("--preview");
      const job = spawnEngine("cli.ts", args, `static-${Date.now()}.log`);
      return ok({ status: "started", ...job }, "Static image generation started");
    },
  }),
  tool({
    name: "carousel_generate",
    description: "Generate a multi-slide Instagram carousel post (swipeable, 4-10 slides). Each slide is a premium styled image with brand typography. Long-running — returns run id immediately.",
    kind: "long",
    schema: z.object({
      seed: z.string().min(1),
      channel: z.string().min(1),
      slides: z.number().int().min(3).max(10).default(6),
      mood: z.string().optional(),
      aspect: z.enum(["1:1", "4:5"]).default("1:1"),
      preview: z.boolean().default(false),
    }).strict(),
    run: ({ seed, channel, slides, mood, aspect, preview }) => {
      const args = ["carousel", seed, "--channel", channel, "--slides", String(slides), "--aspect", aspect];
      if (mood) args.push("--mood", mood);
      if (preview) args.push("--preview");
      const job = spawnEngine("cli.ts", args, `carousel-${Date.now()}.log`);
      return ok({ status: "started", ...job }, "Carousel generation started");
    },
  }),
  tool({
    name: "carousel_get",
    description: "Get a generated carousel's slide images and metadata by content item id.",
    kind: "read",
    schema: z.object({ id: z.string().min(1) }).strict(),
    run: ({ id }) => {
      const item = loadItem(id);
      if (!item) return fail(`no content item: ${id}`);
      if (item.kind !== "carousel") return fail(`item ${id} is not a carousel (kind=${item.kind})`);
      return ok({ id: item.id, status: item.status, slides: (item as any).carouselSlides ?? [], carousel: (item as any).carousel, pkg: item.pkg });
    },
  }),
  tool({
    name: "static_get",
    description: "Get a generated static image post by content item id.",
    kind: "read",
    schema: z.object({ id: z.string().min(1) }).strict(),
    run: ({ id }) => {
      const item = loadItem(id);
      if (!item) return fail(`no content item: ${id}`);
      if (item.kind !== "static_image") return fail(`item ${id} is not a static image (kind=${item.kind})`);
      return ok({ id: item.id, status: item.status, imagePath: (item as any).staticImagePath, spec: (item as any).staticImage, pkg: item.pkg });
    },
  }),
];
