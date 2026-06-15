import { z } from "zod";
import { ok, fail, spawnEngine, tool, type PipelineTool } from "./helpers.ts";
import { listObservations, loadObservation, findObservationByUrl, saveObservation, listProfileObservations } from "../observation-store.ts";

export const observationTools: PipelineTool[] = [
  tool({
    name: "scan_content",
    description: "Scan any Instagram reel, YouTube video, or TikTok link: downloads the video, extracts frames, runs Claude vision analysis on the visual language/edit/music/tone, captures creator info and engagement metrics, and saves to the observation inventory. Long-running — returns observation id immediately.",
    kind: "long",
    schema: z.object({
      url: z.string().url(),
      channel: z.string().optional().describe("Socheli channel id to associate this observation with"),
      tags: z.array(z.string()).default([]),
      forceRescan: z.boolean().default(false),
    }).strict(),
    run: ({ url, channel, tags, forceRescan }) => {
      const args = ["scan", url];
      if (channel) args.push("--channel", channel);
      if (tags.length) args.push("--tags", tags.join(","));
      if (forceRescan) args.push("--force");
      const job = spawnEngine("cli.ts", args, `scan-${Date.now()}.log`);
      return ok({ status: "started", url, ...job }, "Content scan started — poll observation_get with the returned id once complete");
    },
  }),

  tool({
    name: "scan_profile",
    description: "Deep-scan a creator profile on Instagram, YouTube, or TikTok: reads their bio, follows bio links, lists recent posts ranked by engagement, scans the top N posts individually with full vision analysis. Builds a comprehensive creator intelligence record.",
    kind: "long",
    schema: z.object({
      profileUrl: z.string().url(),
      limit: z.number().int().min(1).max(10).default(5).describe("how many top posts to scan"),
      channel: z.string().optional(),
      tags: z.array(z.string()).default([]),
    }).strict(),
    run: ({ profileUrl, limit, channel, tags }) => {
      const args = ["scan-profile", profileUrl, "--limit", String(limit)];
      if (channel) args.push("--channel", channel);
      if (tags.length) args.push("--tags", tags.join(","));
      const job = spawnEngine("cli.ts", args, `scan-profile-${Date.now()}.log`);
      return ok({ status: "started", profileUrl, ...job }, "Profile scan started");
    },
  }),

  tool({
    name: "observation_get",
    description: "Get a saved content observation by id — includes full analysis, frames, metrics, creator info, and top comments.",
    kind: "read",
    schema: z.object({ id: z.string().min(1) }).strict(),
    run: ({ id }) => {
      const obs = loadObservation(id);
      if (!obs) return fail(`no observation: ${id}`);
      return ok(obs as unknown as Record<string, unknown>);
    },
  }),

  tool({
    name: "observation_list",
    description: "List saved observations from the creative intelligence inventory. Filter by platform, tags, or channel.",
    kind: "read",
    schema: z.object({
      platform: z.enum(["instagram", "youtube", "tiktok", "x", "other"]).optional(),
      tags: z.array(z.string()).default([]),
      channel: z.string().optional(),
      limit: z.number().int().min(1).max(100).default(20),
    }).strict(),
    run: ({ platform, tags, channel, limit }) => {
      const items = listObservations({ platform, tags: tags.length ? tags : undefined, channelId: channel, limit });
      return ok({ observations: items.map(o => ({
        id: o.id, url: o.url, platform: o.platform, title: o.title,
        creator: o.creator?.handle, metrics: o.metrics,
        inspirationScore: o.analysis?.inspirationScore,
        tags: o.tags, createdAt: o.createdAt,
      })) });
    },
  }),

  tool({
    name: "observation_tag",
    description: "Add tags to an observation for categorization (e.g. 'ops_room', 'finance', 'reference', 'competitor').",
    kind: "mutate",
    schema: z.object({
      id: z.string().min(1),
      tags: z.array(z.string()).min(1),
    }).strict(),
    run: ({ id, tags }) => {
      const obs = loadObservation(id);
      if (!obs) return fail(`no observation: ${id}`);
      const merged = [...new Set([...obs.tags, ...tags])];
      saveObservation({ ...obs, tags: merged });
      return ok({ id, tags: merged });
    },
  }),

  tool({
    name: "profile_list",
    description: "List deep-scanned creator profiles in the observation inventory.",
    kind: "read",
    schema: z.object({ limit: z.number().int().min(1).max(50).default(20) }).strict(),
    run: ({ limit }) => ok({ profiles: listProfileObservations().slice(0, limit) }),
  }),

  tool({
    name: "inspiration_report",
    description: "Generate a creative brief from all observations tagged or associated with a channel — synthesizes the visual patterns, scene types, edit rhythms, and music styles into an actionable creative direction document.",
    kind: "read",
    schema: z.object({
      channel: z.string().optional(),
      tags: z.array(z.string()).default([]),
      limit: z.number().int().default(10),
    }).strict(),
    run: ({ channel, tags, limit }) => {
      const obs = listObservations({ channelId: channel, tags: tags.length ? tags : undefined, limit });
      if (!obs.length) return fail("no observations found for that filter");
      const analyses = obs.filter(o => o.analysis).map(o => ({
        url: o.url, creator: o.creator?.handle,
        ...o.analysis,
      }));
      return ok({ observationCount: obs.length, analyses, message: "Pass these analyses to the brain to generate a creative brief" });
    },
  }),
];
