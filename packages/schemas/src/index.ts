import { z } from "zod";
import { TenantFields } from "./tenancy.ts";

/* ════════════════════════════════════════════════════════════════════════
   CONTENT-OS SCHEMAS — single source of truth.
   Every tool, agent, the engine, the renderer and the dashboard import these.
   A storyboard that is valid here is valid everywhere.
   ════════════════════════════════════════════════════════════════════════ */

/* The multi-member / organization model (workspaces, roles, permissions). */
export * from "./tenancy.ts";

/* The pluggable long-term memory layer's transport shapes (provider-agnostic). */
export * from "./memory.ts";

/* Per-brand Meta (Instagram/Facebook) connection wire shapes. */
export * from "./connections.ts";

/* Per-brand custom responder agent: rules, config, templates, decisions. */
export * from "./responder.ts";

/* Per-brand account-level Instagram insight snapshots. */
export * from "./insights.ts";

/* Paid amplification: Instagram boost records + ads config (NO token fields). */
export * from "./ads.ts";

/* Soli copilot conversation history (backend-persistent chat threads). */
export * from "./chats.ts";

/* ─── Design-rule constants (blueprint §5.4) ───────────────────────────── */
export const RULES = {
  maxTitleWords: 9,
  maxSubtitleLineChars: 36,
  maxSubtitleLines: 2,
  minSceneDuration: 2,
  maxSceneDuration: 14,
  maxScenes: 9,
  minTotalDuration: 12,
  maxTotalDuration: 75,
  transitionFrames: 9, // overlap between scenes — shared by renderer + voice timing
} as const;

const wordsLte = (n: number) => (s: string) =>
  s.trim().split(/\s+/).filter(Boolean).length <= n;

/* ─── Channels ─────────────────────────────────────────────────────────────
   Channel + theme are free strings so a new channel/theme is a one-file add
   (channels.ts + a theme in tokens). The engine validates against its registry. */
export const ChannelId = z.string();
export type ChannelId = string;

export const ChannelDNA = z.object({
  ...TenantFields, // workspaceId + createdBy — which org/person owns this brand
  id: ChannelId,
  name: z.string(),
  audience: z.string(),
  domain: z.string().optional(),
  formats: z.array(z.string()).optional(),
  sceneTypes: z.array(z.string()).optional(), // allowlist of renderer scene types; omit = all allowed
  defaultMood: z.string().optional(), // fallback mood when the idea agent doesn't suggest one
  // Content clusters: the moods this channel offers, each with its OWN topic domain
  // + format/DNA overrides. The first entry is the channel's default cluster.
  moods: z
    .array(z.object({ id: z.string(), domain: z.string().optional(), formats: z.array(z.string()).optional(), note: z.string().optional() }))
    .optional(),
  tone: z.string(),
  visualStyle: z.string(),
  // Brand signature colour (hex). When set, overrides the theme/mood accent at
  // render time so the brand's chosen colour is the on-screen accent everywhere.
  accent: z.string().optional(),
  slogan: z.string().optional(), // short tagline (shown in brand UI / outro)
  website: z.string().optional(), // source site (also used to seed the brand)
  // Editorial archetype — HOW this channel conceives a video: its directorial
  // sensibility, structural instincts, and the visual moves it reaches for.
  // Fed into the script + storyboard agents so each DNA *thinks* differently.
  archetype: z.string().optional(),
  theme: z.string(),
  logo: z.string().optional(), // watermark + outro logo (path relative to remotion public/)
  handle: z.string().optional(), // @handle for the outro / subscribe card
  site: z.string().optional(), // website shown on the outro (e.g. labrato.tech)
  socials: z.array(z.string()).optional(), // platforms shown on the outro (e.g. Instagram, X, YouTube)
  voice: z.string().default("af_heart"), // Kokoro voice id (persona)
  elevenVoice: z.string().optional(), // ElevenLabs voice id (premium, used when key present)
  voiceSpeed: z.number().default(1.0),
  // Per-channel ElevenLabs voice_settings override (merged over the mood-derived
  // defaults) — lets a channel read steadier or more expressive than the mood.
  voiceSettings: z
    .object({
      stability: z.number().optional(),
      similarity_boost: z.number().optional(),
      style: z.number().optional(),
      use_speaker_boost: z.boolean().optional(),
    })
    .optional(),
  // Pronunciation overrides applied to narration BEFORE TTS (whole-word, case-
  // insensitive). e.g. { "USDC": "U-S-D-C", "MCP": "M-C-P", "iCog": "eye cog" }.
  sayAs: z.record(z.string()).optional(),
  bannedPatterns: z.array(z.string()),
  preferredHooks: z.array(z.string()),
});
export type ChannelDNA = z.infer<typeof ChannelDNA>;

/* ─── Idea / Script ────────────────────────────────────────────────────── */
export const Idea = z.object({
  topic: z.string().min(3),
  angle: z.string(),
  format: z.enum([
    "mistake_fix",
    "terminal_tip",
    "before_after",
    "architecture_warning",
    "quote_card",
    "tip_list",
    "myth_fact",
    "step_guide",
    "stat_drop",
    "definition",
    "comparison",
    "listicle",
  ]),
  rationale: z.string(),
  mood: z.string().optional(), // suggested mood preset (explainer|motivational|business|tech|mindfulness)
});
export type Idea = z.infer<typeof Idea>;

export const Script = z.object({
  hook: z.string().refine(wordsLte(RULES.maxTitleWords), {
    message: `hook must be <= ${RULES.maxTitleWords} words`,
  }),
  beats: z.array(z.string()).min(2).max(6),
  cta: z.string(),
  narration: z.array(z.string()).min(2),
});
export type Script = z.infer<typeof Script>;

/* ─── DaVinci spine §4.1 — COLOR (per-scene + global grade) ──────────────────
   A real, validated colour grade: per-channel lift/gamma/gain, white-balance
   (temp/tint), saturation/contrast about a pivot, plus an optional curves table.
   `ColorGrade` rides on `sceneBase.style.grade` (per scene); `GlobalGrade` is the
   storyboard-level master trim composited AFTER the per-scene grades. The render
   maps these to SVG feComponentTransfer/feColorMatrix (lib/grade.tsx). EVERY
   field is optional/defaulted so a grade-less legacy scene/storyboard parses and
   renders pixel-identical (no grade ⇒ the renderer's legacy filter path).
   Declared HERE (ahead of the scenes) because `sceneBase.style`/`Storyboard`
   reference these schema VALUES at definition time. */
const rgbTriplet = z.object({
  r: z.number().optional(),
  g: z.number().optional(),
  b: z.number().optional(),
});
export type RgbTriplet = z.infer<typeof rgbTriplet>;

// A small editable curve: monotone-in-`t` control points sampled into an SVG
// `type='table'` transfer function. `t`/`v` are normalised 0..1 (input→output).
export const ColorCurve = z.object({
  points: z
    .array(z.object({ t: z.number().min(0).max(1), v: z.number().min(0).max(1) }))
    .min(2)
    .optional(),
});
export type ColorCurve = z.infer<typeof ColorCurve>;

// The per-channel grade shape, shared by per-scene `ColorGrade` and the
// storyboard-level `GlobalGrade`. lift/gamma/gain are the three-way primaries;
// channels run ~-1..1 (lift) / 0..2 (gamma, gain) — clamped at the render edge,
// kept generous here so the bridge can write deltas without tripping validation.
const gradeShape = {
  // Shadows / midtones / highlights — additive lift, multiplicative gain,
  // power-curve gamma. Each is an optional RGB triplet.
  lift: rgbTriplet.optional(),     // shadow pedestal, channel ≈ -1..1
  gamma: rgbTriplet.optional(),    // midtone power,  channel ≈ 0..2 (1 = neutral)
  gain: rgbTriplet.optional(),     // highlight slope, channel ≈ 0..2 (1 = neutral)
  temperature: z.number().min(-1).max(1).optional(), // warm(+) / cool(-) white balance
  tint: z.number().min(-1).max(1).optional(),        // magenta(+) / green(-) bias
  saturation: z.number().min(0).max(2).optional(),   // 1 = neutral, 0 = mono, 2 = vivid
  contrast: z.number().min(0).max(2).optional(),     // 1 = neutral, about `pivot`
  pivot: z.number().min(0).max(1).optional(),        // contrast pivot point (≈0.435)
  // Optional per-channel + master curves table (RGB master via `all`).
  curves: z
    .object({ all: ColorCurve.optional(), r: ColorCurve.optional(), g: ColorCurve.optional(), b: ColorCurve.optional() })
    .optional(),
};

export const ColorGrade = z.object({ ...gradeShape });
export type ColorGrade = z.infer<typeof ColorGrade>;

// Same shape — the storyboard master grade (project trim), applied over the
// per-scene grades. Kept as a distinct named export for clarity at call sites.
export const GlobalGrade = z.object({ ...gradeShape });
export type GlobalGrade = z.infer<typeof GlobalGrade>;

/* ─── DaVinci spine §4.4 — COMPOSITING (Fusion-style node graph) ─────────────
   A composable effect DAG per scene (`sceneBase.style.comp`) and at the
   storyboard level (`Storyboard.comp`, post-scope). Nodes wire by id via
   `inputs`; per-param keyframe tracks animate effects over the scene's frames.
   `params` is a free record (each node type reads its own keys) so the schema is
   stable as the node vocabulary grows. All optional/defaulted → legacy parses;
   no `comp` ⇒ the renderer's legacy effect/overlay path. Motion-tracking samples
   live in `TrackData` (precomputed offline, attached to a `track_attach` node).
   Declared HERE so `sceneBase.style`/`Storyboard` can reference the value. */

// One node in the effect graph. `type` is the effect primitive; `inputs` are the
// ids of upstream nodes feeding it (empty = a source/leaf).
export const EffectNode = z.object({
  id: z.string(),
  type: z.enum([
    "grade",         // per-scene colour grade (the SAME field as §4.1, as a node)
    "glow",
    "bloom",
    "light_leak",
    "chroma_ab",     // chromatic aberration
    "grain",
    "vignette",
    "blur",
    "sharpen",
    "mask_shape",
    "mask_luma",
    "mask_alpha",
    "key_luma",
    "key_chroma",
    "transform",
    "displace",
    "blend",
    "source",        // a leaf input (scene content / asset)
    "track_attach",  // pin a layer to motion-tracking samples (TrackData)
  ]),
  params: z.record(z.unknown()).optional(),     // node-type-specific params
  inputs: z.array(z.string()).default([]),      // upstream node ids
  // Per-param keyframe tracks (prop name → animated points). `ease` per segment.
  keyframes: z
    .array(
      z.object({
        prop: z.string(),
        points: z
          .array(
            z.object({
              t: z.number().min(0).max(1),
              v: z.number(),
              ease: z.enum(["linear", "easeIn", "easeOut", "easeInOut", "hold"]).optional(),
            }),
          )
          .min(1),
      }),
    )
    .optional(),
});
export type EffectNode = z.infer<typeof EffectNode>;

export const EffectGraph = z.object({
  nodes: z.array(EffectNode).default([]),
  output: z.string().optional(),   // id of the node whose result is the final image
});
export type EffectGraph = z.infer<typeof EffectGraph>;

// Motion-tracking samples (precomputed offline by comp_track). One sample per
// frame: a tracked point's pixel position, consumed by `track_attach` nodes.
export const TrackData = z.object({
  points: z.array(z.object({ frame: z.number().int().min(0), x: z.number(), y: z.number() })).default([]),
});
export type TrackData = z.infer<typeof TrackData>;

/* ─── Scenes (discriminated union — the allowed component vocabulary) ───── */
const sceneBase = {
  id: z.string(),
  durationSec: z.number().min(RULES.minSceneDuration).max(RULES.maxSceneDuration),
  // The line spoken WHILE this scene is on screen. Drives scene-by-scene voice
  // sync (scene duration is fitted to its spoken line when voiceover is on).
  say: z.string().optional(),
  // Optional B-roll behind the scene: a short visual search/generation query and
  // whether the subject is concrete (→ stock footage) or abstract (→ AI image).
  broll: z
    .object({
      query: z.string(),
      kind: z.enum(["concrete", "abstract"]).default("concrete"),
    })
    .optional(),
  // Mark the 1-2 emotional PEAK scenes. Only these react to the beat (punch + flash),
  // so the edit has highs and lows instead of pulsing on every beat.
  emphasis: z.boolean().default(false),
  // Layers panel state (editor-only): hide a scene from the render, or lock it
  // against edits. Unset = visible + unlocked (old behavior).
  hidden: z.boolean().optional(),
  locked: z.boolean().optional(),
  // Per-scene creative overrides set from the editor (all optional).
  style: z
    .object({
      accent: z.string().optional(), // override the theme accent for this scene
      transition: z
        .enum(["slide", "fade", "wipe", "slamzoom", "zoom", "push", "cover", "spin", "glitch"])
        .optional(), // entry transition
      transitionDuration: z.number().min(0.1).max(1.5).optional(), // per-scene entry transition duration (seconds)
      transitionEase: z.enum(["linear", "easeIn", "easeOut", "easeInOut"]).optional(), // entry transition easing
      fontScale: z.number().min(0.6).max(1.6).optional(), // scale on-screen text
      align: z.enum(["center", "left"]).optional(),
      x: z.number().min(-420).max(420).optional(), // editor text transform, render pixels
      y: z.number().min(-720).max(720).optional(),
      rotation: z.number().min(-45).max(45).optional(),
      letterSpacing: z.number().min(-0.08).max(0.2).optional(),
      lineHeight: z.number().min(0.8).max(1.8).optional(),
      paragraphSpacing: z.number().min(0).max(80).optional(),
      textCase: z.enum(["none", "upper", "lower", "title"]).optional(),
      effectIntensity: z.number().min(0).max(1).optional(), // master intensity for this scene's effects overlay
      // Text outline (stroke) drawn around on-screen text.
      stroke: z
        .object({ color: z.string(), width: z.number().min(0).max(20) })
        .optional(),
      // Text drop shadow behind on-screen text.
      shadow: z
        .object({
          color: z.string(),
          blur: z.number().min(0).max(60),
          x: z.number().min(-40).max(40),
          y: z.number().min(-40).max(40),
        })
        .optional(),
      // Keyframe animation tracks. Each track animates one transform property
      // across the scene's lifetime; `t` is normalized 0→1 over the scene's
      // frames, `v` is the value, `ease` is the segment's outgoing easing.
      // When a track exists for a prop it overrides the static value above.
      keyframes: z
        .array(
          z.object({
            prop: z.enum(["x", "y", "scale", "rotation", "opacity"]),
            points: z
              .array(
                z.object({
                  t: z.number().min(0).max(1),
                  v: z.number(),
                  ease: z.enum(["linear", "easeIn", "easeOut", "easeInOut", "hold"]).default("easeInOut"),
                }),
              )
              .min(1),
          }),
        )
        .optional(),
      // ── DaVinci spine: per-scene colour grade (§4.1) + compositing effect
      //    graph (§4.4). Both optional → grade-less/comp-less scenes render via
      //    the legacy filter/effect path, pixel-identical. ──
      grade: ColorGrade.optional(),
      comp: EffectGraph.optional(),
    })
    .optional(),
  // Free-form overlay elements placed on top of the scene (stickers, shapes,
  // images, logos, emoji, free text). All additive; unset = no overlays.
  overlays: z
    .array(
      z.object({
        id: z.string(),
        type: z.enum(["sticker", "shape", "image", "logo", "emoji", "text"]),
        content: z.string().optional(),
        src: z.string().optional(),
        shape: z.enum(["rect", "circle", "triangle", "star", "arrow", "line"]).optional(),
        color: z.string().optional(),
        x: z.number(),
        y: z.number(),
        scale: z.number().default(1),
        rotation: z.number().default(0),
        opacity: z.number().min(0).max(1).default(1),
      }),
    )
    .optional(),
};

export const Motion = z.enum([
  "fade_in_up",
  "slam_in",
  "wipe",
  "reveal",
  "none",
]);

const subtitleLine = z
  .string()
  .refine((s) => s.length <= RULES.maxSubtitleLineChars, {
    message: `subtitle line must be <= ${RULES.maxSubtitleLineChars} chars`,
  });

export const TerminalLine = z.object({
  kind: z.enum([
    "user",
    "assistant",
    "tool",
    "file",
    "error",
    "warning",
    "ok",
    "blank",
  ]),
  text: z.string(),
});
export type TerminalLine = z.infer<typeof TerminalLine>;

export const HookScene = z.object({
  ...sceneBase,
  type: z.literal("hook_text"),
  text: z.string().refine(wordsLte(RULES.maxTitleWords), {
    message: `hook_text must be <= ${RULES.maxTitleWords} words`,
  }),
  motion: Motion.default("fade_in_up"),
});

export const TerminalScene = z.object({
  ...sceneBase,
  type: z.literal("terminal"),
  path: z.string().default("~/project"),
  status: z.enum(["ok", "error"]).default("ok"),
  lines: z.array(TerminalLine).min(1).max(8),
});

export const BeforeAfterScene = z.object({
  ...sceneBase,
  type: z.literal("before_after"),
  caption: z.string().optional(),
  left: z.object({ title: z.string(), text: z.string(), bad: z.boolean().default(true) }),
  right: z.object({ title: z.string(), text: z.string(), bad: z.boolean().default(false) }),
});

export const CodeScene = z.object({
  ...sceneBase,
  type: z.literal("code_block"),
  language: z.string().default("ts"),
  title: z.string().optional(),
  code: z.string(),
  focusLines: z.array(z.number()).default([]),
});

/* Truncate-don't-reject: cheap models (gemini-flash etc.) often return MORE array
   items than a scene allows (e.g. 5 diagram nodes when max is 4), which would fail
   the WHOLE storyboard parse. Slice to max BEFORE validation so the scene stays
   valid instead of crashing the stage. */
const capped = <T extends z.ZodTypeAny>(item: T, min: number, max: number) =>
  z.preprocess((v) => (Array.isArray(v) ? v.slice(0, max) : v), z.array(item).min(min).max(max));

export const KineticScene = z.object({
  ...sceneBase,
  type: z.literal("kinetic_text"),
  lines: capped(z.string(), 1, 4),
  highlight: z.array(z.string()).default([]),
});

export const WarningScene = z.object({
  ...sceneBase,
  type: z.literal("warning"),
  level: z.enum(["info", "warning", "danger"]).default("warning"),
  text: z.string(),
});

export const CTAScene = z.object({
  ...sceneBase,
  type: z.literal("cta"),
  text: z.string(),
  handle: z.string().optional(),
});

// A giant animated statistic / number with a label (counts up if numeric).
export const BigNumberScene = z.object({
  ...sceneBase,
  type: z.literal("big_number"),
  value: z.string(), // e.g. "80ms", "1890", "3x", "0%"
  label: z.string(), // short caption under the number
});

// A full-screen quote with attribution.
export const QuoteScene = z.object({
  ...sceneBase,
  type: z.literal("quote"),
  text: z.string(),
  author: z.string().optional(),
});

// A full-bleed image moment (uses the scene's b-roll) with one short caption.
export const ImageFocusScene = z.object({
  ...sceneBase,
  type: z.literal("image_focus"),
  caption: z.string(),
});

// The frame itself splits into 2-3 FULL-BLEED sections (rows or columns), each
// with its own background visual, revealing step by step. Not boxes on a bg.
export const GridScene = z.object({
  ...sceneBase,
  type: z.literal("grid"),
  layout: z.enum(["rows", "cols"]).default("rows"),
  cells: z
    .array(
      z.object({
        title: z.string(),
        text: z.string(),
        query: z.string().optional(), // 2-5 visual words for this panel's full-bleed background
        bg: z.string().optional(), // resolved asset path (filled by the engine)
        bgType: z.enum(["video", "image"]).optional(),
      }),
    )
    .min(2)
    .max(3),
});

// An animated vertical bar chart — 2-5 bars grow from zero, values count up.
export const ChartScene = z.object({
  ...sceneBase,
  type: z.literal("chart"),
  title: z.string().optional(),
  unit: z.string().optional(), // appended to each value, e.g. "%", "ms", "k"
  bars: z
    .array(z.object({ label: z.string(), value: z.number() }))
    .min(2)
    .max(5),
});

// A node-flow diagram: 2-4 labelled cards appear staggered, connector lines draw
// in between consecutive nodes. A "how it works" / forward-momentum moment.
export const DiagramScene = z.object({
  ...sceneBase,
  type: z.literal("diagram"),
  direction: z.enum(["vertical", "horizontal"]).default("vertical"),
  nodes: capped(z.object({ label: z.string() }), 2, 4),
});

// A chronological timeline: a vertical axis draws down, 2-4 events appear
// staggered from top to bottom, each with an optional time eyebrow + label.
export const TimelineScene = z.object({
  ...sceneBase,
  type: z.literal("timeline"),
  events: capped(z.object({ time: z.string().optional(), label: z.string() }), 2, 4),
});

// A stylized abstract MAP moment (no real geography): a dark field, a glowing
// accent route that draws in, and 1-3 pulsing pin markers each with a label.
// Evokes "location / where" without literal map tiles.
export const MapScene = z.object({
  ...sceneBase,
  type: z.literal("map"),
  caption: z.string().optional(),
  points: capped(z.object({ label: z.string() }), 1, 3),
});

// ── Long-form chapter anchors ──────────────────────────────────────────────
// A chapter title card (number + title + optional kicker) that opens a chapter.
export const ChapterTitleScene = z.object({
  ...sceneBase,
  type: z.literal("chapter_title"),
  number: z.number().int().min(1),
  title: z.string(),
  kicker: z.string().optional(), // small label above the title
});

// A short recap card listing the takeaways of a section.
export const SectionSummaryScene = z.object({
  ...sceneBase,
  type: z.literal("section_summary"),
  heading: z.string().optional(),
  points: capped(z.string(), 1, 4),
});

// Pure motion-graphics: an animated app/product UI inside a device frame
// (browser, phone, or window). Content rows animate in staggered; one row can be
// the accent "primary" action. The SaaS-explainer signature — no stock footage.
export const DeviceMockupScene = z.object({
  ...sceneBase,
  type: z.literal("device_mockup"),
  device: z.enum(["browser", "phone", "window"]).default("browser"),
  app: z.string().optional(), // url shown in the browser bar / app title
  headline: z.string().optional(), // one short line above the device
  rows: z
    .array(z.object({ text: z.string(), value: z.string().optional(), accent: z.boolean().default(false) }))
    .min(1)
    .max(6),
});

// Pure motion-graphics: a bento grid of 2-6 feature/benefit cards that pop in
// staggered. The first card is emphasized (accent). Great for "what you get".
export const BentoScene = z.object({
  ...sceneBase,
  type: z.literal("bento"),
  heading: z.string().optional(),
  cards: z.array(z.object({ title: z.string(), text: z.string().optional() })).min(2).max(6),
});

// Pure motion-graphics: a row/grid of 2-4 big metrics that count up together.
export const StatsScene = z.object({
  ...sceneBase,
  type: z.literal("stats"),
  heading: z.string().optional(),
  stats: capped(z.object({ value: z.string(), label: z.string() }), 2, 4),
});

// Pure motion-graphics: an "us vs them" feature checklist — two columns, rows
// tick in with ✓ / ✗. Column A is the hero (accent), B the alternative.
export const CompareScene = z.object({
  ...sceneBase,
  type: z.literal("compare"),
  a: z.string(), // hero column label (e.g. "Socheli")
  b: z.string(), // alternative label (e.g. "By hand")
  rows: z.array(z.object({ feature: z.string(), a: z.boolean().default(true), b: z.boolean().default(false) })).min(2).max(5),
});

// Intelligence-briefing dialogue: sequential ROLE / text lines (ops_room + war_economy moods).
// Roles like OPERATOR/COMMANDER appear as a fixed-width colored prefix before each line.
export const DialogueLine = z.object({
  role: z.string(),          // displayed as uppercase prefix, e.g. "OPERATOR"
  text: z.string(),
  color: z.string().optional(), // hex override for this role's label color
});
export type DialogueLine = z.infer<typeof DialogueLine>;

export const DialogueScene = z.object({
  ...sceneBase,
  type: z.literal("dialogue"),
  lines: z.array(DialogueLine).min(1).max(8),
  title: z.string().optional(),    // episode/segment header, e.g. "OPERATIONS ROOM — EP.122"
  subtitle: z.string().optional(), // context line below title
});

export const Scene = z.discriminatedUnion("type", [
  HookScene,
  TerminalScene,
  BeforeAfterScene,
  CodeScene,
  KineticScene,
  WarningScene,
  CTAScene,
  BigNumberScene,
  QuoteScene,
  ImageFocusScene,
  GridScene,
  ChartScene,
  DiagramScene,
  TimelineScene,
  MapScene,
  ChapterTitleScene,
  SectionSummaryScene,
  DeviceMockupScene,
  BentoScene,
  StatsScene,
  CompareScene,
  DialogueScene,
]);
export type Scene = z.infer<typeof Scene>;
export const SCENE_TYPES = [
  "hook_text",
  "terminal",
  "before_after",
  "code_block",
  "kinetic_text",
  "warning",
  "cta",
  "big_number",
  "quote",
  "image_focus",
  "grid",
  "chart",
  "diagram",
  "timeline",
  "map",
  "chapter_title",
  "section_summary",
  "device_mockup",
  "bento",
  "stats",
  "compare",
  "dialogue",
] as const;

/* ─── Subtitles (burned in, timed) ─────────────────────────────────────── */
export const Subtitle = z.object({
  startSec: z.number(),
  endSec: z.number(),
  lines: z.array(subtitleLine).max(RULES.maxSubtitleLines),
});
export type Subtitle = z.infer<typeof Subtitle>;

/* ─── Storyboard (the render contract) ─────────────────────────────────── */
export const Storyboard = z
  .object({
    channel: ChannelId,
    theme: z.string(),
    topic: z.string(),
    format: Idea.shape.format,
    hook: z.string(),
    fps: z.number().default(30),
    width: z.number().default(1080), // 1080 (9:16 shorts) or 1920 (16:9 long-form)
    height: z.number().default(1920),
    aspect: z.enum(["9:16", "1:1", "16:9"]).optional(), // editor-chosen aspect; width/height remain source of truth when set
    scenes: z.array(Scene).min(2).max(RULES.maxScenes),
    cta: z.string(),
    // ── DaVinci spine: the storyboard-level master grade (§4.1, composited
    //    after per-scene grades) + a post-scope compositing graph (§4.4). Both
    //    optional → legacy storyboards parse and render unchanged. ──
    grade: GlobalGrade.optional(),
    comp: EffectGraph.optional(),
  })
  .superRefine((sb, ctx) => {
    const total = sb.scenes.reduce((a, s) => a + s.durationSec, 0);
    if (total < RULES.minTotalDuration || total > RULES.maxTotalDuration) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `total duration ${total}s out of range [${RULES.minTotalDuration}, ${RULES.maxTotalDuration}]`,
      });
    }
    const ids = new Set<string>();
    for (const s of sb.scenes) {
      if (ids.has(s.id))
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `duplicate scene id ${s.id}` });
      ids.add(s.id);
    }
  });
export type Storyboard = z.output<typeof Storyboard>;

export const totalDurationSec = (sb: Storyboard) =>
  sb.scenes.reduce((a, s) => a + s.durationSec, 0);

/* ─── Static Image + Carousel specs ─────────────────────────────────────── */
export const SlideSpec = z.object({
  id: z.string(),
  // The primary headline text on this slide
  headline: z.string().max(120),
  // Optional supporting body copy (short — 1-2 lines max on screen)
  body: z.string().max(280).optional(),
  // AI image generation prompt for the background visual
  imagePrompt: z.string().optional(),
  // Explicit background color if no image (hex or css color)
  bgColor: z.string().optional(),
  // Layout variant: text-only, text-over-image, highlight-bar, split, stat
  layout: z.enum(["text_only", "text_over_image", "highlight_bar", "split", "stat_card"]).default("highlight_bar"),
  // Small label shown as eyebrow/slide number
  eyebrow: z.string().optional(),
  // Whether this slide is the cover slide (first, branded)
  isCover: z.boolean().optional(),
  // Whether this is the CTA/last slide
  isCta: z.boolean().optional(),
  // Accent color override for this specific slide (hex)
  accent: z.string().optional(),
});
export type SlideSpec = z.infer<typeof SlideSpec>;

export const CarouselSpec = z.object({
  channel: ChannelId,
  topic: z.string(),
  hook: z.string(),
  cta: z.string(),
  theme: z.string(),
  // 4-10 slides: cover + content slides + CTA slide
  slides: z.array(SlideSpec).min(3).max(12),
  // Aspect ratio: 1:1 for square feed, 4:5 for portrait feed
  aspect: z.enum(["1:1", "4:5"]).default("1:1"),
  mood: z.string().optional(),
});
export type CarouselSpec = z.infer<typeof CarouselSpec>;

export const StaticImageSpec = z.object({
  channel: ChannelId,
  topic: z.string(),
  headline: z.string().max(120),
  body: z.string().max(280).optional(),
  imagePrompt: z.string().optional(),
  bgColor: z.string().optional(),
  layout: SlideSpec.shape.layout,
  theme: z.string(),
  aspect: z.enum(["1:1", "4:5", "9:16"]).default("1:1"),
  mood: z.string().optional(),
  accent: z.string().optional(),
});
export type StaticImageSpec = z.infer<typeof StaticImageSpec>;

/* ─── Long-form (16:9 YouTube) — chapter-first ─────────────────────────────
   A long-form video = an outline of chapters. Each chapter is an independent
   production unit (its own sub-mood, narration, scenes). Chapters render
   separately and concat. The scene array per chapter is relaxed vs the shorts
   Storyboard (more scenes, no 75s cap). */
export const ChapterOutline = z.object({
  id: z.string(),
  number: z.number().int().min(1),
  title: z.string(),
  subMood: z.string(), // sub-mood id (hook|context|mechanism|evidence|case_study|counterpoint|implication|payoff)
  purpose: z.string(), // what this chapter must accomplish
  points: z.array(z.string()).min(1).max(6), // the outline bullets it must cover
});
export type ChapterOutline = z.infer<typeof ChapterOutline>;

export const LongformOutline = z.object({
  title: z.string(), // the video title
  thesis: z.string(), // the through-line / central argument
  chapters: z.array(ChapterOutline).min(3).max(9),
});
export type LongformOutline = z.infer<typeof LongformOutline>;

// A chapter's scenes (the render unit). Relaxed limits for 16:9 long-form.
export const ChapterBoard = z.object({
  id: z.string(),
  number: z.number().int().min(1),
  title: z.string(),
  subMood: z.string(),
  narration: z.array(z.string()).min(1), // spoken lines, in order
  scenes: z.array(Scene).min(2).max(22),
});
export type ChapterBoard = z.infer<typeof ChapterBoard>;

// The assembled long-form video.
export const Longform = z.object({
  channel: ChannelId,
  theme: z.string(),
  mood: z.string(),
  topic: z.string(),
  title: z.string(),
  thesis: z.string(),
  fps: z.number().default(30),
  width: z.number().default(1920),
  height: z.number().default(1080),
  chapters: z.array(ChapterBoard).min(2),
  cta: z.string().optional(),
});
export type Longform = z.infer<typeof Longform>;

/* ─── QA report (blueprint §13 rubric) ─────────────────────────────────── */
export const QA_DIMENSIONS = [
  "specificity",
  "utility",
  "technical_validity",
  "visual_clarity",
  "brand_fit",
  "anti_slop",
  "platform_safety",
] as const;

export const QAReport = z.object({
  scores: z.object(
    Object.fromEntries(QA_DIMENSIONS.map((d) => [d, z.number().min(0).max(10)])) as Record<
      (typeof QA_DIMENSIONS)[number],
      z.ZodNumber
    >,
  ),
  overall: z.number().min(0).max(10),
  verdict: z.enum(["pass", "revise", "kill"]),
  notes: z.array(z.string()),
});
export type QAReport = z.infer<typeof QAReport>;

/* ─── Packaging (the post) ─────────────────────────────────────────────── */
/* Per-platform packaging — each platform has its own caption/hashtag conventions. */
export const PlatformPackage = z.object({
  platform: z.enum(["youtube", "instagram", "tiktok", "x"]),
  title: z.string().optional(), // youtube headline
  caption: z.string(), // platform-tailored description/caption
  hashtags: z.array(z.string()).default([]), // sized mix; default [] so a cheap model omitting it doesn't fail packaging
  keywords: z.array(z.string()).optional(), // youtube SEO tags
});
export type PlatformPackage = z.infer<typeof PlatformPackage>;

export const PostPackage = z.object({
  title: z.string(),
  caption: z.string(),
  hashtags: z.array(z.string()).default([]),
  altText: z.string().default(""),
  platforms: z.array(PlatformPackage).optional(), // per-platform variants
  // Per-platform packaging overrides set from the editor, keyed by platform id
  // (e.g. "youtube" | "instagram" | "tiktok" | "x"). Any field unset = fall back
  // to the base/platform-variant value. Additive, non-breaking.
  overrides: z
    .record(
      z.string(),
      z.object({
        caption: z.string().optional(),
        title: z.string().optional(),
        hashtags: z.array(z.string()).optional(),
      }),
    )
    .optional(),
});
export type PostPackage = z.infer<typeof PostPackage>;

/* ─── Cost ledger ──────────────────────────────────────────────────────── */
export const CostEntry = z.object({ stage: z.string(), usd: z.number(), at: z.string() });
export const CostLedger = z.object({
  entries: z.array(CostEntry),
  totalUsd: z.number(),
});
export type CostLedger = z.infer<typeof CostLedger>;

/* ─── Run warnings ─────────────────────────────────────────────────────────
   Non-fatal degradations during a render: a quality fallback the pipeline took
   rather than aborting (word-level captions → phrase subtitles when Whisper
   fails, premium music → procedural bed, voiceover → distributed subtitles).
   These used to be swallowed silently; now they are recorded on the run, shown
   in the dashboard, and reported back to the device that ran the job, so the
   degradation + the real error are visible instead of a mystery in the output. */
export const RunWarning = z.object({
  at: z.string(),
  stage: z.string(), // "captions" | "voice" | "music" | "broll" | …
  code: z.string(), // machine code, e.g. "whisper_failed"
  message: z.string(), // human-readable one-liner (what degraded + the consequence)
  detail: z.string().optional(), // the underlying error / stderr tail
});
export type RunWarning = z.infer<typeof RunWarning>;

/* ─── DaVinci spine §4.3 — AUDIO (Fairlight-grade desk shapes) ────────────────
   Keyframed gain/pan automation, a per-track EQ/comp/de-ess/gate/denoise chain,
   and per-clip automation on the Mix. All shapes are additive + optional so the
   existing two-volume Mix still parses; the render/ffmpeg builders read them when
   present and fall back to today's behaviour when absent. */

// A keyframed automation curve. `t∈0..1` over the span it scopes; `v` is the
// value (gain multiplier or pan position depending on where it's attached).
// Evaluated like the existing scene keyframes / duck envelope.
export const AutoCurve = z.object({
  points: z.array(z.object({ t: z.number().min(0).max(1), v: z.number() })).min(1),
  easing: z.enum(["linear", "easeIn", "easeOut", "easeInOut", "hold"]).default("easeInOut"),
});
export type AutoCurve = z.infer<typeof AutoCurve>;

// One parametric EQ band (baked by ffmpeg `equalizer`/shelf before <Audio>).
export const AudioBand = z.object({
  freq: z.number().min(20).max(20000),       // centre frequency (Hz)
  gain: z.number().min(-24).max(24),         // boost/cut (dB)
  q: z.number().min(0.1).max(10).default(1), // bandwidth (quality factor)
  type: z.enum(["peak", "lowshelf", "highshelf", "lowpass", "highpass", "notch"]).default("peak"),
});
export type AudioBand = z.infer<typeof AudioBand>;

// A downward compressor (ffmpeg `acompressor`). dB thresholds, ratio, ms times.
export const Comp = z.object({
  threshold: z.number().min(-60).max(0).default(-18), // dB below which to compress
  ratio: z.number().min(1).max(20).default(3),
  attack: z.number().min(0).max(500).default(20),     // ms
  release: z.number().min(0).max(2000).default(150),  // ms
  makeup: z.number().min(0).max(24).optional(),        // makeup gain (dB)
});
export type Comp = z.infer<typeof Comp>;

// De-esser — tames sibilance around a centre frequency (ffmpeg `deesser`).
export const DeEss = z.object({
  freq: z.number().min(2000).max(12000).default(6500), // sibilance band centre (Hz)
  amount: z.number().min(0).max(1).default(0.4),        // intensity 0..1
});
export type DeEss = z.infer<typeof DeEss>;

// Noise gate — silences signal below a threshold (ffmpeg `agate`).
export const Gate = z.object({
  threshold: z.number().min(-80).max(0).default(-40), // dB open threshold
  attack: z.number().min(0).max(500).default(10),     // ms
  release: z.number().min(0).max(2000).default(120),  // ms
});
export type Gate = z.infer<typeof Gate>;

// Spectral denoise / hiss removal (ffmpeg `afftdn`). `amount` 0..1.
export const Denoise = z.object({
  amount: z.number().min(0).max(1).default(0.3),
});
export type Denoise = z.infer<typeof Denoise>;

/* Mix (per-item editor overrides: volumes, beat intensity, track automation) */
export const AudioTrack = z.object({
  id: z.enum(["music", "voice", "sfx"]),
  name: z.string().optional(),
  vol: z.number().min(0).max(3).optional(),
  mute: z.boolean().optional(),
  disabled: z.boolean().optional(),
  speed: z.number().min(0.25).max(4).optional(),
  pan: z.number().min(-1).max(1).optional(),
  fadeIn: z.number().min(0).max(10).optional(),
  fadeOut: z.number().min(0).max(10).optional(),
  splits: z.array(z.number().min(0).max(1)).optional(),
  locked: z.boolean().optional(),
  // ── DaVinci spine §4.3: per-track channel-strip chain + automation (all
  //    additive/optional → legacy tracks parse; ffmpeg pre-bakes the chain, the
  //    renderer applies gain/pan automation in-frame). ──
  eq: z.array(AudioBand).optional(),     // parametric EQ bands (in series)
  comp: Comp.optional(),                  // downward compressor
  deess: DeEss.optional(),                // sibilance control
  gate: Gate.optional(),                  // noise gate
  denoise: Denoise.optional(),            // spectral denoise / de-hiss
  gain: AutoCurve.optional(),             // keyframed track gain automation
  // keyframed track pan automation (-1..1 values). Named `panAuto` because the
  // legacy scalar `pan` above is a single static value — automation is additive.
  panAuto: AutoCurve.optional(),
});
export type AudioTrack = z.infer<typeof AudioTrack>;

export const Mix = z.object({
  musicVol: z.number().min(0).max(2).optional(),
  voiceVol: z.number().min(0).max(2).optional(),
  sfxVol: z.number().min(0).max(2).optional(),
  beatIntensity: z.number().min(0).max(2).optional(),
  muteMusic: z.boolean().optional(),
  muteVoice: z.boolean().optional(),
  muteSfx: z.boolean().optional(),
  captionStyle: z.enum(["pop", "bounce", "phrase"]).optional(),
  subtitles: z.object({
    enabled: z.boolean().optional(),
    mode: z.enum(["karaoke", "lines"]).optional(),
    preset: z.enum(["pop", "bounce", "phrase", "hormozi", "glow", "clean", "springy"]).optional(),
    // Words to emphasize in captions (case-insensitive match against caption words).
    keywords: z.array(z.string()).optional(),
    position: z.enum(["bottom", "middle", "top"]).optional(),
    fontScale: z.number().min(0.6).max(1.8).optional(),
    letterSpacing: z.number().min(-0.08).max(0.2).optional(),
    lineHeight: z.number().min(0.8).max(1.8).optional(),
    background: z.boolean().optional(),
    backgroundOpacity: z.number().min(0).max(1).optional(),
    highlightColor: z.string().optional(),
    inactiveOpacity: z.number().min(0.1).max(0.8).optional(),
    maxWords: z.number().min(1).max(8).optional(),
    // Pillar 5 (Ingest) §7.1.2(c): where the caption words come from. "voice" =
    // derive from the synthesized VO/word-cues (the generated default); "track" =
    // render reads a dedicated caption track on the timeline (the kind:"text"
    // clips an ingested run seeds from the transcript). Optional → legacy = voice.
    source: z.enum(["voice", "track"]).optional(),
  }).optional(),
  // Music ducking under voice: drop music gain while narration plays.
  duck: z.object({
    enabled: z.boolean().optional(),
    amount: z.number().min(0).max(1).optional(), // how far to duck (0 = none, 1 = full)
    attack: z.number().min(0).max(2).optional(), // seconds to ramp down at voice start
    release: z.number().min(0).max(3).optional(), // seconds to ramp back up at voice end
  }).optional(),
  // EMPHASIS PUNCH-IN settings (build roadmap §3). The auto-zoom pass reads these to
  // decide how strong/frequent the zoom on a vocally-stressed word is. Off ⇒ flat spine.
  zoomPunch: z.object({
    enabled: z.boolean().optional(),
    scale: z.number().min(1.04).max(1.25).optional(),       // peak zoom (default 1.12)
    maxPerMin: z.number().int().min(0).max(6).optional(),   // cap big zooms per minute (default 3)
    minSpacingSec: z.number().min(3).max(15).optional(),    // min gap between zooms (default 6.5)
    originX: z.number().min(0).max(1).optional(),           // transform origin (default 0.5)
    originY: z.number().min(0).max(1).optional(),           // (default 0.42 — near the face)
  }).optional(),
  tracks: z.array(AudioTrack).optional(),
  // ── DaVinci spine §4.3: per-clip automation overrides (a frame-region gain/pan
  //    dip scoped to one track + time window) + the loudness master target. Both
  //    optional/defaulted so legacy mixes parse and render unchanged. ──
  clips: z
    .array(
      z.object({
        trackId: z.string(),                 // which AudioTrack id this automates
        startSec: z.number().min(0),         // region start on the timeline
        // region length (seconds). Optional — absent = the curve runs to the end
        // of the track (the renderer windows `[startSec, startSec+durSec)`; with no
        // durSec it spans to track end). The curve's t∈0..1 maps over this window.
        durSec: z.number().min(0).optional(),
        gain: AutoCurve.optional(),          // gain automation over the region
        pan: AutoCurve.optional(),           // pan automation over the region
      }),
    )
    .optional(),
  // Integrated LUFS master target. Optional (not `.default()`) so the many
  // call sites that build a `Mix` literal via `{ ...item.mix }` keep compiling;
  // consumers treat absent as the default -14 LUFS (render reads `?? -14`).
  loudnessTarget: z.number().optional(),
});
export type Mix = z.infer<typeof Mix>;

/* ─── Creative-editing layer (the editorial brain) ──────────────────────────
   These shapes turn the static template renderer into a creative editor. They
   are NON-DESTRUCTIVE: they live alongside the storyboard, record editorial
   JUDGEMENT (brief → concepts → an Edit Decision List → self-reviews), and are
   bridged back onto storyboard scene params + mix at apply time. Every field is
   optional on ContentItem so existing runs parse unchanged. See
   packages/engine/src/creative/ for the engine that produces/consumes them. */

/** The narrative FUNCTION a scene serves in the cut (story-map roles). */
export const SceneFunction = z.enum([
  "hook",
  "context",
  "problem",
  "tension",
  "idea",
  "proof",
  "example",
  "resolution",
  "cta",
  "b_roll",
  "transition",
]);
export type SceneFunction = z.infer<typeof SceneFunction>;

/** The editorial style/direction a concept commits to. */
export const EditStyle = z.enum([
  "cinematic",
  "fast_ad",
  "documentary",
  "luxury_minimal",
  "energetic_social",
  "educational",
  "custom",
]);
export type EditStyle = z.infer<typeof EditStyle>;

export const TargetPlatform = z.enum([
  "instagram_reel",
  "tiktok",
  "youtube_short",
  "youtube",
  "ad",
  "brand_film",
]);
export type TargetPlatform = z.infer<typeof TargetPlatform>;

/* The editorial brief — what the cut is FOR, inferred or stated before edits.
   A strong editor builds strategy first; a weak one starts cutting. */
export const EditBrief = z.object({
  purpose: z.string(), // "45s IG Reel for a premium storytelling app"
  platform: TargetPlatform,
  audience: z.string(), // who it's for
  feeling: z.array(z.string()).max(8), // desired emotional register(s)
  structureArc: z.array(SceneFunction).max(16), // the intended story arc
  constraints: z.array(z.string()).default([]), // hard rules ("9:16", "Persian subtitles")
  doNots: z.array(z.string()).default([]), // taste guardrails ("no cheesy transitions")
  references: z.array(z.string()).default([]), // reference looks / videos / brands
  hookWindowSec: z.number().min(0.5).max(8).default(3), // seconds to establish curiosity
  notes: z.string().optional(),
  updatedAt: z.string().optional(),
});
export type EditBrief = z.infer<typeof EditBrief>;

/* A scored editorial concept — one valid direction. A creative editor explores
   several before committing, then chooses the strongest against the brief. */
export const ConceptScores = z.object({
  hook: z.number().min(0).max(10),
  pacing: z.number().min(0).max(10),
  emotion: z.number().min(0).max(10),
  brandFit: z.number().min(0).max(10),
  platformFit: z.number().min(0).max(10),
  overall: z.number().min(0).max(10),
});
export type ConceptScores = z.infer<typeof ConceptScores>;

export const EditConcept = z.object({
  id: z.string(),
  name: z.string(), // "Cinematic emotional"
  style: EditStyle,
  summary: z.string(), // one-paragraph creative direction
  pacing: z.enum(["slow", "measured", "brisk", "fast", "frenetic"]),
  paletteIntent: z.string().optional(), // "warm, low-key, single teal accent"
  typographyIntent: z.string().optional(),
  transitionIntent: z.string().optional(), // "hard cuts only, no wipes"
  soundIntent: z.string().optional(), // music/sfx/silence direction
  scores: ConceptScores,
  rationale: z.string(), // why this direction fits the brief
});
export type EditConcept = z.infer<typeof EditConcept>;

/* One editorial decision for one scene — the unit of the Edit Decision List.
   It records INTENT + RATIONALE; the bridge (applyEdlToStoryboard) translates
   intent into concrete storyboard params at apply time, leaving the decision
   layer intact and re-runnable. */
export const EdlDecision = z.object({
  sceneId: z.string(),
  sceneIndex: z.number().int().min(0),
  fn: SceneFunction, // narrative function in the cut
  intent: z.string(), // what this beat must accomplish
  pacingSec: z.number().min(0.4).max(20).optional(), // editorial duration target
  emphasis: z.boolean().optional(), // a peak moment (beat-synced punch)
  keep: z.boolean().default(true), // false = trimmed from the cut
  transitionIn: z.string().optional(), // intent token: "cut" | "wipe" | "slamzoom" | ...
  brollIntent: z.string().optional(), // what b-roll should show / footage style
  mixIntent: z.string().optional(), // "duck music hard under VO", "let silence breathe"
  colorIntent: z.string().optional(), // "lift shadows, cool grade"
  // DaVinci spine §4.1 — a STRUCTURED grade the brain can emit alongside (or
  // instead of) the free-text colorIntent. When present the bridge writes it
  // straight onto scene.style.grade (clamped); otherwise colorIntent is mapped
  // deterministically. Optional + legacy-safe: an EdlDecision without a grade
  // parses and bridges exactly as before.
  grade: ColorGrade.optional(),
  captionIntent: z.string().optional(), // "poetic phrase captions, key word accented"
  motionIntent: z.string().optional(), // "slow ken-burns push in"
  // DaVinci spine §4.4 — free-text COMPOSITING intent ("isolate the subject and
  // glow it", "vintage film grain + leak", "punchy bloom"). `buildCompFromIntents`
  // (creative/edl.ts) deterministically maps it (+ colorIntent) to a small
  // EffectGraph written onto scene.style.comp. Optional + legacy-safe: an
  // EdlDecision without a visualIntent parses and bridges exactly as before.
  visualIntent: z.string().optional(),
  rationale: z.string().optional(),
});
export type EdlDecision = z.infer<typeof EdlDecision>;

/* A record of one editorial pass having run over the cut. */
export const PassRecord = z.object({
  pass: z.string(), // "assembly" | "pacing" | "emotion" | ...
  at: z.string(),
  summary: z.string(),
  changed: z.array(z.string()).default([]), // human-readable change list
});
export type PassRecord = z.infer<typeof PassRecord>;

/* The Edit Decision List — the editorial spine of a cut. */
export const Edl = z.object({
  concept: z.string().optional(), // chosen EditConcept id
  decisions: z.array(EdlDecision).default([]),
  passLog: z.array(PassRecord).default([]),
  updatedAt: z.string().optional(),
});
export type Edl = z.infer<typeof Edl>;

/* A self-review scorecard — the editor watching its own cut and grading it
   against editorial + technical criteria, then listing concrete fixes. */
export const ReviewFix = z.object({
  where: z.string(), // "scene 2" | "00:12-00:18" | "global"
  issue: z.string(),
  action: z.string(), // the concrete edit to make
  severity: z.enum(["low", "medium", "high"]).default("medium"),
});
export type ReviewFix = z.infer<typeof ReviewFix>;

export const ReviewScores = z.object({
  hookStrength: z.number().min(0).max(10),
  pacing: z.number().min(0).max(10),
  audioClarity: z.number().min(0).max(10),
  subtitleReadability: z.number().min(0).max(10),
  brandConsistency: z.number().min(0).max(10),
  emotionalImpact: z.number().min(0).max(10),
  ctaClarity: z.number().min(0).max(10),
  technicalPolish: z.number().min(0).max(10),
  overall: z.number().min(0).max(10),
});
export type ReviewScores = z.infer<typeof ReviewScores>;

export const CreativeReview = z.object({
  at: z.string(),
  pass: z.string().optional(), // which pass / iteration produced this review
  scores: ReviewScores,
  fixes: z.array(ReviewFix).default([]),
  verdict: z.enum(["ship", "revise", "reject"]),
  notes: z.string().optional(),
  evidence: z.array(z.string()).default([]), // paths to frames/contact-sheets used
});
export type CreativeReview = z.infer<typeof CreativeReview>;

/* Perception of a SOURCE clip (b-roll candidate or scene asset) — what the
   editor "sees" before committing footage to the cut. */
export const ClipAnalysis = z.object({
  sceneId: z.string().optional(),
  source: z.string(), // url or path
  motion: z.number().min(0).max(1).optional(), // 0 static … 1 frenetic
  shaky: z.boolean().optional(),
  quality: z.number().min(0).max(1).optional(), // sharpness/exposure composite
  brightness: z.number().min(0).max(1).optional(),
  hasText: z.boolean().optional(), // watermark / burned-in text risk
  bestMomentSec: z.number().optional(), // peak segment start
  suitableFor: z.array(SceneFunction).default([]),
  reject: z.boolean().optional(),
  notes: z.string().optional(),
});
export type ClipAnalysis = z.infer<typeof ClipAnalysis>;

/* Per-channel EDITING taste — distinct from the content Brand Genome (DNA).
   Persisted at data/editing-taste/<channel>.json; recalled into briefs/passes
   and grown from self-reviews and published performance. */
export const TasteRule = z.object({
  rule: z.string(),
  weight: z.number().min(0).max(1).default(0.5),
  source: z.enum(["seed", "feedback", "review", "performance"]).default("seed"),
  at: z.string().optional(),
});
export type TasteRule = z.infer<typeof TasteRule>;

export const EditingTaste = z.object({
  channel: ChannelId,
  prefs: z
    .object({
      pacing: z.string().optional(),
      palette: z.string().optional(),
      typography: z.string().optional(),
      transitions: z.string().optional(),
      sound: z.string().optional(),
    })
    .default({}),
  rules: z.array(TasteRule).default([]), // "do" preferences
  doNots: z.array(TasteRule).default([]), // guardrails
  // Learned COLOR targets (DaVinci spine §4.1, M5): the per-channel exposure/WB
  // band the colorist pass grades toward, compounded from real scope readings of
  // shipped cuts. lumaP50 is the midtone the brand sits at (0..255); lumaTol the
  // half-width of the acceptable band; the WB tolerances say how far off-neutral
  // this brand's look is allowed to be before the pass corrects it (a stylized
  // teal-orange brand tolerates a wider warm bias than a clean documentary one).
  // All optional → a never-graded channel falls back to the pass's defaults.
  colorTargets: z
    .object({
      lumaP50: z.number().min(0).max(255).optional(),
      lumaTol: z.number().min(0).max(128).optional(),
      warmTol: z.number().min(0).max(100).optional(),
      greenTol: z.number().min(0).max(100).optional(),
      note: z.string().optional(),
    })
    .optional(),
  // Learned MIX targets (DaVinci spine §4.3, M9): the per-channel loudness/mix
  // band the audio pass mixes toward, compounded from real ebur128 meter readings
  // of shipped cuts. loudnessTarget is the integrated LUFS the brand masters to;
  // voiceOverBedLu the VO-above-bed margin that kept narration intelligible (the
  // brand's house "how loud is the voice over the music"). All optional → a
  // never-mixed channel falls back to the pass's defaults.
  mixTargets: z
    .object({
      loudnessTarget: z.number().min(-30).max(-6).optional(),
      voiceOverBedLu: z.number().min(0).max(30).optional(),
      note: z.string().optional(),
    })
    .optional(),
  updatedAt: z.string().optional(),
});
export type EditingTaste = z.infer<typeof EditingTaste>;

/* ─── DaVinci spine §4.2 — TIMELINE (the Pro NLE realization layer) ──────────
   A non-destructive multi-track timeline that lives on `ContentItem.timeline?`
   exactly the way `edl` does today. `compileTimeline` projects it back onto the
   storyboard + mix (see creative/compile.ts). All fields optional/defaulted so
   every legacy run (no timeline) parses; an item with no timeline renders via the
   storyboard as before. */

// Per-caption-line STYLE (caption choreography). A line-scoped subset of the
// global Mix.subtitles knobs plus `depth`: "front" = over everything (default),
// "behind" = composited BEHIND the subject matte (Odysser look — the person
// occludes the words). `emphasis` is the director's 0..1 importance score (drives
// size/positioning), kept for downstream UIs. All optional → a styled clip only
// overrides what it sets; the rest inherits the global subtitle style.
export const CaptionStyle = z.object({
  preset: z.enum(["pop", "bounce", "phrase", "hormozi", "glow", "clean", "springy"]).optional(),
  position: z.enum(["bottom", "middle", "top"]).optional(),
  fontScale: z.number().min(0.6).max(2.2).optional(),
  highlightColor: z.string().optional(),
  depth: z.enum(["front", "behind"]).optional(),
  emphasis: z.number().min(0).max(1).optional(),
});
export type CaptionStyle = z.infer<typeof CaptionStyle>;

// One clip on a track. Carries BOTH source time (in/out into the underlying
// asset/scene) and timeline time (where it lands in the cut) so trims are
// ripple/slip/slide-able. `sceneRef` ties a video/text clip back to a storyboard
// scene; `src` is set for source-backed media (b-roll/voice/sfx).
export const Clip = z.object({
  id: z.string(),
  kind: z.enum(["video", "audio", "overlay", "text"]),
  sceneRef: z.string().optional(),       // storyboard scene id this clip realizes
  src: z.string().optional(),            // asset path/url for source-backed clips
  inSec: z.number().min(0).default(0),   // source in-point
  outSec: z.number().min(0).optional(),  // source out-point (absent = to end)
  startSec: z.number().min(0).default(0),// timeline position (where it starts)
  durationSec: z.number().min(0),        // length on the timeline
  // Frame-addressable mirror of the seconds fields (Editor Frame-Control B2).
  // Computed from sec*fps when the frame index is built; seconds remain the
  // source of truth. All optional → legacy timelines parse unchanged.
  inFrame: z.number().int().min(0).optional(),    // source in-point, frames (inSec * fps)
  outFrame: z.number().int().min(0).optional(),   // source out-point, frames (outSec * fps)
  startFrame: z.number().int().min(0).optional(), // timeline start, frames (startSec * fps)
  speed: z.number().min(0.1).max(8).default(1),
  gain: AutoCurve.optional(),            // per-clip gain automation (audio clips)
  enabled: z.boolean().default(true),
  locked: z.boolean().optional(),
  // Pillar 5 (Ingest) §7.1.2(c): caption payload for a kind:"text" clip, so a
  // caption clip carries the words it shows (seeded from the transcript). `words`
  // are in SOURCE seconds; the footage compiler maps them to WordCue frames at
  // caption-build time. Both optional → only set on auto-subtitled tracks.
  captionText: z.string().optional(),
  words: z
    .array(z.object({ word: z.string(), fromSec: z.number(), toSec: z.number() }))
    .optional(),
  // Caption STYLE CHOREOGRAPHY: a per-caption-line style so a video isn't one
  // static subtitle look top-to-bottom. The style director (creative/caption-
  // style.ts) assigns each line its own preset/position/size/accent (and `depth`
  // for Odysser-style behind-subject captions). The footage compiler turns each
  // styled caption clip into its own positioned Karaoke overlay. Absent ⇒ the
  // line uses the global Mix.subtitles style (legacy single-style behaviour).
  captionStyle: CaptionStyle.optional(),
  // EMPHASIS PUNCH-IN keyframes (the ONE canonical persisted zoom representation — the
  // build roadmap §3 Conflict A). Both producers write here: the auto RMS punch-ins
  // (creative/emphasis-zoom.ts) and the pacing governor's static-stretch remedy
  // (creative/pacing-governor.ts, `gov_`-prefixed). render.ts is the single converter
  // that flattens these (clip-relative frames) into timeline ZoomWindows for FootageSpine.
  // `atFrame` is WITHIN the clip; one animator applies exactly one active window/frame.
  zoom: z
    .array(
      z.object({
        atFrame: z.number().int().min(0), // peak frame, relative to the clip start
        scale: z.number().min(1).max(1.6),
        ease: z.enum(["in", "out", "inout"]).default("inout"),
        holdF: z.number().int().min(0).default(6),
        rampInF: z.number().int().min(1).default(12),
        rampOutF: z.number().int().min(1).default(14),
        id: z.string().optional(), // "gov_"/"punch_" prefix for idempotent strip-and-recompute
      }),
    )
    .optional(),
});
export type Clip = z.infer<typeof Clip>;

// A named track holding ordered clips. `kind` picks the lane discipline.
export const Track = z.object({
  id: z.string(),
  kind: z.enum(["video", "audio", "overlay", "text"]),
  name: z.string().optional(),
  clips: z.array(Clip).default([]),
});
export type Track = z.infer<typeof Track>;

// A ruler marker (chapter/beat/note) at a timeline position.
export const Marker = z.object({
  atSec: z.number().min(0),
  label: z.string().optional(),
  color: z.string().optional(),
});
export type Marker = z.infer<typeof Marker>;

export const Timeline = z.object({
  tracks: z.array(Track).default([]),
  markers: z.array(Marker).default([]),
  // Set once `timeline_build` has seeded the timeline. Per §2.1 precedence, once
  // this is present the timeline OWNS timing (clip durations win over EDL pacing).
  compiledAt: z.string().optional(),
  fps: z.number().optional(),            // editor fps (falls back to storyboard.fps)
  // Pillar 5 (Ingest) §7.1.2(c): which spine this timeline was seeded from —
  // "storyboard" (a generated run, clips ref scenes) vs "footage" (an ingested
  // run, clips cut the source video at source time). Tells compile/render which
  // path to take. Optional → legacy timelines (storyboard-seeded) parse unchanged.
  seededFrom: z.enum(["storyboard", "footage"]).optional(),
  // Lazily-built per-clip frame index (Editor Frame-Control B2): clipId → the
  // list of addressable frames on the timeline for that clip. Built async after
  // the timeline exists (creative/frame-index.ts buildFrameIndex); used for O(1)
  // frame→clip resolution by timeline_query_frame / timeline_seek_frame. Optional
  // → timelines without a built index parse unchanged.
  frameMetadata: z
    .record(
      z.string(), // clipId
      z.object({
        frames: z
          .array(
            z.object({
              frameIndex: z.number().int().min(0), // timeline frame number
              atSec: z.number().min(0),            // its time on the timeline
            }),
          )
          .optional(),
      }),
    )
    .optional(),
});
export type Timeline = z.infer<typeof Timeline>;

/* ─── Pillar 5 (Ingest & Understand) §7.1.2(a) — SOURCE ──────────────────────
   An ingested user video registers as a NORMAL ContentItem (kind:"ingested",
   videoPath = the normalized source) so every existing evidence tool / craft
   pass / timeline / caption renderer reuses unchanged. `source` records the
   import provenance + the ffprobe of the original. All fields additive/optional
   on ContentItem → every legacy run still ContentItem.parse()s. */

// The ffprobe of an imported file. Stream-level facts the ingest/normalize and
// hybrid-render stages read (WxH/fps drive the spine; rotation is baked at cut).
export const SourceProbe = z.object({
  container: z.string().optional(),
  durationSec: z.number(),
  video: z
    .object({
      codec: z.string(),
      width: z.number().int(),
      height: z.number().int(),
      fps: z.number(), // from avg_frame_rate
      rotation: z.number().int().default(0), // side_data_list ∪ tags.rotate ∪ display-matrix
      pixFmt: z.string().optional(),
      sar: z.string().optional(),
      bitrate: z.number().optional(),
    })
    .optional(),
  audioStreams: z
    .array(
      z.object({
        codec: z.string(),
        channels: z.number().int(),
        sampleRate: z.number().int(),
        language: z.string().optional(),
      }),
    )
    .default([]),
  hasAudio: z.boolean().default(false),
});
export type SourceProbe = z.infer<typeof SourceProbe>;

// The ingest record: where the file came from, the render-friendly copy (== the
// original when no transcode was needed), normalization provenance, and the probe.
export const SourceVideo = z.object({
  originalPath: z.string(),
  originalName: z.string().optional(),
  path: z.string(), // render-friendly file (== originalPath if no transcode)
  normalized: z.boolean().default(false),
  normalizeReason: z.string().optional(),
  bytes: z.number().int().optional(),
  sha256: z.string().optional(),
  probe: SourceProbe,
  importedAt: z.string(),
  importedBy: z.string().optional(),
});
export type SourceVideo = z.infer<typeof SourceVideo>;

/* ─── Pillar 5 (Ingest & Understand) §7.1.2(b) — UNDERSTANDING ────────────────
   The structured index the agent reads, mirroring how `editSignals` grounds the
   generated passes today. A one-shot ingest artifact (N2 owns; N3/N5 read); the
   mutable editing layer is `timeline`. Stores SECONDS throughout (source-accurate)
   — convert to frames only at caption build (N4). All additive/optional on
   ContentItem → legacy runs (no understanding) parse unchanged. */

// A time region in source seconds (silence/turn/dead-air…), with an optional why.
export const Span = z.object({
  startSec: z.number(),
  endSec: z.number(),
  reason: z.string().optional(),
});
export type Span = z.infer<typeof Span>;

// A transcribed word with its timing + confidence (Whisper word-level output).
export const TWord = z.object({
  word: z.string(),
  startSec: z.number(),
  endSec: z.number(),
  conf: z.number().optional(),
});
export type TWord = z.infer<typeof TWord>;

// A transcript segment (a spoken line/phrase), carrying boundaries the shot
// segmenter and editorial scorers read (speaker tag + Whisper QA probs).
export const TSegment = z.object({
  index: z.number().int(),
  startSec: z.number(),
  endSec: z.number(),
  text: z.string(),
  speaker: z.string().optional(),
  avgLogprob: z.number().optional(),
  noSpeechProb: z.number().optional(),
});
export type TSegment = z.infer<typeof TSegment>;

export const Transcript = z.object({
  text: z.string(),
  words: z.array(TWord).default([]),
  segments: z.array(TSegment).default([]),
});
export type Transcript = z.infer<typeof Transcript>;

// A heuristic speaker (pause-gap + RMS level-shift, NOT diarization — flagged in
// Understanding.notes). `turns` are the spans this speaker holds the floor.
export const Speaker = z.object({
  id: z.string(),
  label: z.string().optional(),
  turns: z.array(Span).default([]),
  totalSec: z.number(),
});
export type Speaker = z.infer<typeof Speaker>;

// One shot (a continuous take) — the unit a footage-seeded timeline clip cuts.
// `source` records which boundary opened it; `keyframeSec` is the representative
// frame the per-shot multimodal analysis samples.
export const Shot = z.object({
  id: z.string(),
  index: z.number().int(),
  inSec: z.number(),
  outSec: z.number(),
  durationSec: z.number(),
  source: z.enum(["cut", "silence", "speaker", "fallback"]), // which boundary opened it
  keyframeSec: z.number(),
  speaker: z.string().optional(),
});
export type Shot = z.infer<typeof Shot>;

// Per-shot multimodal evidence the passes read — extends ClipAnalysis (reusing
// motion/shaky/quality/brightness/bestMomentSec) with footage-specific signals.
// `faces` is absent in v1 (no face detector in-repo); framing is approximated
// from edge/contrast pixel metrics only — don't overclaim face analysis.
export const ShotAnalysis = ClipAnalysis.extend({
  onScreenText: z.string().optional(),
  ocrConf: z.number().optional(),
  framing: z.enum(["wide", "mid", "tight"]).optional(), // coarse, from edge/contrast metrics
  motionDelta: z.number().optional(),
  transcriptText: z.string().optional(),
  energyRms: z.number().optional(),
  faces: z.number().int().optional(), // absent v1; no detector in-repo
  // SEMANTIC vision pass (OPT-IN "deep" stage): what a human would say the shot
  // CONTAINS, filled by the Claude-vision keyframe call (scan.ts subscription
  // path). All optional — legacy/fast-path Understanding has only the metrics
  // above and parses unchanged. `cameraShot` is the model's read of framing (a
  // semantic complement to the coarse pixel-metric `framing`); `textMeaning`
  // interprets what burned-in text COMMUNICATES, beyond the raw `onScreenText` OCR.
  description: z.string().optional(), // 1-2 sentence plain-language summary of the shot
  subjects: z.array(z.string()).optional(), // people/objects present
  action: z.string().optional(), // what is happening
  setting: z.string().optional(), // where it takes place
  cameraShot: z
    .enum(["extreme_wide", "wide", "medium", "close", "extreme_close", "unknown"])
    .optional(),
  movement: z.string().optional(), // camera/subject motion, in words
  emotion: z.string().optional(), // mood/affect of the shot
  tags: z.array(z.string()).optional(),
  textMeaning: z.string().optional(), // what any on-screen text COMMUNICATES (beyond raw OCR)
});
export type ShotAnalysis = z.infer<typeof ShotAnalysis>;

// A scored peak moment the montage/highlight selector ranks (why = the cited
// reasons: "high motion", "VO punchline", "on-screen text"…).
export const Highlight = z.object({
  startSec: z.number(),
  endSec: z.number(),
  score: z.number(),
  why: z.array(z.string()).default([]),
});
export type Highlight = z.infer<typeof Highlight>;

// A disfluency the editor pass can ripple out — a filler word or a long pause.
export const FillerHit = z.object({
  atSec: z.number(),
  word: z.string(),
  kind: z.enum(["filler", "long_pause"]),
});
export type FillerHit = z.infer<typeof FillerHit>;

// Two segments that say nearly the same thing (similarity ∈ 0..1) — the redundancy
// the tighten/supercut pass can collapse. aSeg/bSeg index into Transcript.segments.
export const RedundantPair = z.object({
  aSeg: z.number().int(),
  bSeg: z.number().int(),
  similarity: z.number(),
});
export type RedundantPair = z.infer<typeof RedundantPair>;

// One contiguous audio region classified by what fills it. The MUSIC pass derives
// these by intersecting the Whisper SPEECH spans (transcript.words/segments) with
// energy from ffmpeg (silencedetect/astats/volumedetect): non-speech + energy =
// "music", speech over a music bed = "mixed", no energy = "silence".
export const AudioSection = z.object({
  startSec: z.number(),
  endSec: z.number(),
  kind: z.enum(["music", "speech", "mixed", "silence"]),
  note: z.string().optional(),
});
export type AudioSection = z.infer<typeof AudioSection>;

// Deep MUSIC understanding (OPT-IN "deep" stage) — the soundtrack's structure the
// editor can cut to. `beats`/`drops` are SECONDS from the proven python beat
// tracker (media.ts musicBeatFrames → beat-times.py); `energyCurve` is a coarse
// loudness-over-time sampling (ffmpeg astats), `sections` the music-vs-speech map.
// All arrays default([]) and scalars optional → absent on legacy/fast-path runs.
export const MusicAnalysis = z.object({
  sections: z.array(AudioSection).default([]), // music-vs-speech-vs-silence map
  beats: z.array(z.number()).default([]), // beat onset times, sec
  tempoBpm: z.number().optional(),
  drops: z.array(z.number()).default([]), // big-energy onsets (drops/hits), sec
  energyCurve: z
    .array(z.object({ atSec: z.number(), energy: z.number() }))
    .default([]),
  hasMusic: z.boolean().optional(),
  notes: z.array(z.string()).default([]),
});
export type MusicAnalysis = z.infer<typeof MusicAnalysis>;

// ── Dense per-frame VISION (Editor Frame-Control Phase B1) ─────────────────
// One frame in the DENSE grid: the editor samples the source at `sampleFps` and
// records, per sampled frame, the cheap pixel metrics (motion/quality/brightness,
// from analyzeFramePixels/perRegionRms) PLUS — when the opt-in vision pass runs —
// a Claude-vision read (description/subjects/onScreenText, via describeFrames).
// `frameIndex` is in TIMELINE/source frame units (atSec * fps) for O(1) lookup;
// it is NOT the sample ordinal. All semantic fields optional → a metrics-only
// fast pass (no vision spend) still produces a valid FrameVision.
export const FrameVision = z.object({
  frameIndex: z.number().int().min(0), // source/timeline frame number (atSec * fps)
  atSec: z.number().min(0),            // exact time of this frame
  description: z.string().optional(),  // 1-line plain-language read of the frame
  subjects: z.array(z.string()).optional(), // people/objects present
  onScreenText: z.string().optional(), // burned-in / visible text
  motionScore: z.number().min(0).max(1).optional(), // 0..1, frame-to-frame motion
  quality: z.number().min(0).max(1).optional(),     // 0..1, sharpness/clarity proxy
  brightness: z.number().min(0).max(1).optional(),  // 0..1, mean luma
  confidence: z.number().min(0).max(1).optional(),  // 0..1, vision-pass confidence
});
export type FrameVision = z.infer<typeof FrameVision>;

// The persisted DENSE grid for one understood item: frames sampled at a uniform
// `sampleFps` (0.5 / 1 / 2) over [startSec, endSec], indexed by frameIndex. Built
// by the detached dense-vision worker and stored on Understanding. Optional on
// Understanding → legacy/fast-path runs (no dense grid) parse unchanged.
export const DenseFrameVision = z.object({
  sampleFps: z.number().min(0).default(1), // grid sampling rate (frames/sec scanned)
  frameCount: z.number().int().min(0),     // number of entries in `frames`
  startSec: z.number().min(0).default(0),
  endSec: z.number().min(0),
  frames: z.array(FrameVision).default([]),
  lastUpdatedAt: z.string().optional(),
});
export type DenseFrameVision = z.infer<typeof DenseFrameVision>;

export const Understanding = z.object({
  builtAt: z.string(),
  durationSec: z.number(),
  fps: z.number().optional(),
  transcript: Transcript,
  speakers: z.array(Speaker).default([]),
  shots: z.array(Shot).default([]),
  perShot: z.record(z.string(), ShotAnalysis).default({}), // keyed by shot id
  highlights: z.array(Highlight).default([]),
  deadAir: z.array(Span).default([]),
  filler: z.array(FillerHit).default([]),
  redundancy: z.array(RedundantPair).default([]),
  // Deep passes (OPT-IN): filled only when ingest runs with the "deep" flag, so
  // legacy runs (no music/videoSummary) parse unchanged.
  music: MusicAnalysis.optional(), // deep MUSIC understanding (beats/sections/drops)
  videoSummary: z.string().optional(), // holistic "what this video IS" (structure + content + mood)
  // Dense per-frame vision grid (OPT-IN, Editor Frame-Control B1) — built by the
  // detached dense-vision worker, indexed by frameIndex for O(1) frame lookup.
  // Optional → legacy/fast-path runs (no dense grid) parse unchanged.
  denseFrameVision: DenseFrameVision.optional(),
  notes: z.array(z.string()).default([]), // e.g. "heuristic speaker turns", "no audio"
});
export type Understanding = z.infer<typeof Understanding>;

/* ─── Agent edit layer — EditOp / MontageSpec / EditPlan (Pillar 5 N5) ─────
   §7.1.2(d): the intent layer the chat/agent surface emits over an INGESTED
   run. An EditPlan is analysis-only until applied (N5.1); it is persisted as a
   flat JSON artifact under data/edit-plans/<id>.json (NOT on the ContentItem),
   exactly like missions/research reports. Each EditOp maps 1:1 to a real
   timeline-edit tool / craft pass / bridge mapper so apply-plan (N5.1) is a
   straight dispatch with no second interpretation step. All variants stay
   additive — every field the executor doesn't need is .optional() so a partial
   plan from a degraded model still parses and applies the ops it could ground.

   Citing evidence: ops reference REAL understanding/timeline artifacts —
   ripple_trim/razor/slip/slide/remove_clip carry a `clipId` (a timeline clip)
   and may carry an `evidence` string (e.g. a deadAir span "12.4-13.9s" or a
   shot id) that the router pulled from Understanding/timelineView. select_highlight
   leans on understanding.highlights; reorder names real clip/shot ids. The
   plan-level `evidenceRefs` is the audit trail of everything cited. */
export const EditOp = z.discriminatedUnion("kind", [
  // M11 trims (creative/timeline-edit.ts) — clipId is a real timeline clip id.
  z.object({
    kind: z.literal("ripple_trim"),
    clipId: z.string(),
    edge: z.enum(["in", "out"]),
    deltaSec: z.number(), // +grow / -shrink the chosen edge; downstream clips ripple
    evidence: z.string().optional(), // e.g. a deadAir span / filler hit this trim removes
  }),
  z.object({
    kind: z.literal("razor"),
    clipId: z.string(),
    atSec: z.number(), // split the clip at this timeline second
    evidence: z.string().optional(),
  }),
  z.object({
    kind: z.literal("jl_cut"),
    clipId: z.string(), // the audio clip whose head/tail leads/lags the picture
    leadSec: z.number(), // +lead (J: audio early) / -lag (L: audio late)
    evidence: z.string().optional(),
  }),
  z.object({
    kind: z.literal("slip"),
    clipId: z.string(), // source-backed clip only (broll/voice) — gated off synthesized scenes
    deltaSec: z.number(), // shift the source in/out window, keep timeline position
    evidence: z.string().optional(),
  }),
  z.object({
    kind: z.literal("slide"),
    clipId: z.string(),
    deltaSec: z.number(), // move the clip in time, ripple its neighbours
    evidence: z.string().optional(),
  }),
  z.object({
    kind: z.literal("insert_broll"),
    atSec: z.number(), // timeline second to drop the overlay in
    durationSec: z.number().optional(),
    query: z.string().optional(), // footage search intent
    src: z.string().optional(), // explicit asset, if already chosen
    evidence: z.string().optional(),
  }),
  z.object({
    kind: z.literal("remove_clip"),
    clipId: z.string(),
    evidence: z.string().optional(),
  }),
  z.object({
    kind: z.literal("reorder"),
    order: z.array(z.string()), // real clip ids (or shot ids), the new sequence
    evidence: z.string().optional(),
  }),
  // Caption track (N4 auto-subtitle) — `preset` selects a caption style.
  z.object({
    kind: z.literal("subtitle"),
    preset: z.string().optional(),
    evidence: z.string().optional(),
  }),
  // Craft bridges (creative/edl.ts) — structured grade OR free-text intent.
  z.object({
    kind: z.literal("grade"),
    scope: z.enum(["scene", "global"]),
    sceneIndex: z.number().int().optional(), // required when scope="scene"
    grade: z.record(z.any()).optional(), // structured Grade payload
    intent: z.string().optional(), // free-text colour intent (colorIntentToGrade)
    evidence: z.string().optional(),
  }),
  z.object({
    kind: z.literal("mix"),
    intent: z.string(), // free-text mix intent (parseMixIntent)
    evidence: z.string().optional(),
  }),
  // Montage selection (N5.2) — keep only the strongest moments.
  z.object({
    kind: z.literal("select_highlight"),
    topN: z.number().int().optional(), // keep the N highest-scoring highlights
    maxSec: z.number().optional(), // …or trim to a target length
    evidence: z.string().optional(),
  }),
]);
export type EditOp = z.infer<typeof EditOp>;

/* A re-montage request — the N5.2 montage compiler reads this to pick + order
   clips. Distinct from a single EditOp because it re-composes the whole spine. */
export const MontageSpec = z.object({
  targetSec: z.number().optional(),
  style: z.enum(["highlight_reel", "teaser", "supercut", "tight_cut"]).optional(),
  maxClips: z.number().int().optional(),
  orderBy: z.enum(["narrative", "energy", "chronological"]).optional(),
});
export type MontageSpec = z.infer<typeof MontageSpec>;

/* The grounded plan the router produces from a plain-language request. Analysis
   only until N5.1 applies it. `mode` distinguishes a guided (human-gated) plan
   from an autonomous one. Persisted flat at data/edit-plans/<id>.json. */
export const EditPlan = z.object({
  id: z.string(),
  runId: z.string(), // the ingested ContentItem this plan edits
  request: z.string(), // the plain-language ask, verbatim
  mode: z.enum(["guided", "autonomous"]),
  ops: z.array(EditOp).default([]),
  rationale: z.string(),
  evidenceRefs: z.array(z.string()).default([]), // shot ids / silence spans / scope refs cited
  montage: MontageSpec.optional(), // present when the request is a re-montage
  estDurationSec: z.number().optional(),
  status: z.enum(["proposed", "approved", "applied", "rejected"]).default("proposed"),
  createdAt: z.string(),
});
export type EditPlan = z.infer<typeof EditPlan>;

/* ─── Lifecycle + ContentItem (the unit the store + dashboard track) ───── */
export const Lifecycle = z.enum([
  "idea_proposed",
  "script_ready",
  "storyboard_ready",
  "qa_passed",
  "qa_failed",
  "rendered",
  "packaged",
  "failed",
  // Pillar 5 (Ingest) §7.1.2(a): resting state right after a user video is
  // imported (probed + normalized) but before it has been understood/edited.
  "ingested",
]);
export type Lifecycle = z.infer<typeof Lifecycle>;

export const ContentItem = z.object({
  ...TenantFields, // workspaceId + createdBy — the owning org/person (optional; legacy = default)
  id: z.string(),
  channel: ChannelId,
  createdAt: z.string(),
  updatedAt: z.string(),
  status: Lifecycle,
  // "short" (vertical Reel/Short/TikTok) vs "longform" (16:9 multi-chapter
  // YouTube). Drives publish routing — long-form must never post as a Reel.
  // "ingested" = a user-supplied video imported via Pillar 5 (videoPath = the
  // normalized source); it flows through the same evidence/timeline/caption/render
  // machinery as a generated run.
  kind: z.enum(["short", "longform", "static_image", "carousel", "ingested"]).optional(),
  // Format-builder selections from /new, carried so later stages (static-image /
  // carousel generation) honour the chosen layout + slide count.
  layoutVariant: z.string().optional(),
  slideCount: z.number().int().optional(),
  seedIdea: z.string(),
  idea: Idea.optional(),
  script: Script.optional(),
  storyboard: Storyboard.optional(),
  qa: QAReport.optional(),
  pkg: PostPackage.optional(),
  videoPath: z.string().optional(),
  thumbPath: z.string().optional(),
  // Resolved music bed (public-relative), set on a run that carries one — e.g. an
  // ingested EDIT given an instrumental bed (creative/edit-music.ts). The hybrid
  // audio path (render.ts buildFootageAudio) ducks + masters it under the footage.
  musicSrc: z.string().optional(),
  // For kind="static_image": path to the generated PNG
  staticImagePath: z.string().optional(),
  // For kind="carousel": array of per-slide rendered PNG paths
  carouselSlides: z.array(z.string()).optional(),
  // The carousel spec (layout/content plan)
  carousel: CarouselSpec.optional(),
  // The static image spec
  staticImage: StaticImageSpec.optional(),
  derivatives: z.object({ square: z.string().optional(), wide: z.string().optional() }).optional(),
  publish: z
    .object({ platform: z.string(), id: z.string().optional(), url: z.string().optional(), at: z.string(), status: z.string() })
    .array()
    .optional(),
  mix: Mix.optional(),
  // ── DaVinci spine §4.2: the Pro NLE timeline (trim-precise realization layer,
  //    non-destructive). Optional → every legacy run (no timeline) parses. ──
  timeline: Timeline.optional(),
  // ── Pillar 5 (Ingest & Understand) §7.1.2: an ingested user video. `source`
  //    is the import record + ffprobe (N1); `understanding` is the structured
  //    index the agent reads — transcript/shots/speakers/highlights/dead-air (N2).
  //    Both optional → every legacy run (no ingest) parses unchanged. ──
  source: SourceVideo.optional(),
  understanding: Understanding.optional(),
  // ── Creative-editing layer (editorial judgement, non-destructive) ──
  brief: EditBrief.optional(), // what the cut is for
  concepts: z.array(EditConcept).optional(), // explored editorial directions
  chosenConcept: z.string().optional(), // selected EditConcept id
  edl: Edl.optional(), // the Edit Decision List (editorial spine)
  reviews: z.array(CreativeReview).optional(), // self-review history
  clipAnalysis: z.record(z.string(), ClipAnalysis).optional(), // source perception keyed by sceneId/source
  mood: z.string().optional(), // resolved mood preset for this post
  ledger: CostLedger,
  log: z.array(z.object({ at: z.string(), msg: z.string() })),
  // Non-fatal render degradations (caption/music/voice fallbacks). Surfaced in
  // the dashboard run log and propagated to the device's job result.
  warnings: z.array(RunWarning).optional(),
});
export type ContentItem = z.infer<typeof ContentItem>;

export const QA_PASS_THRESHOLD = 7;

/* ─── Autopilot schedule ─────────────────────────────────────────────────────
   File-based posting schedule (data/schedule.json). Cadence-based: each channel
   carries a list of local HH:MM slots; a launchd tick fires a slot when the
   clock enters its window and it hasn't fired yet today. No materialized queue.
   The publish[].status vocabulary on a ContentItem is, by convention:
     "published" | "ready" (bundle) | "processing" | "needs-auth" | "error". */
export const ScheduleSlot = z.object({
  time: z.string().regex(/^\d{2}:\d{2}$/), // local "HH:MM"
  channel: z.string(),
  mood: z.string().optional(),
  seed: z.string().optional(), // empty/absent → autopilot selects the concept
  public: z.boolean().default(false),
  // Optional weekday filter (0=Sun … 6=Sat). Absent/empty → fires every day.
  // Lets the posting-time strategy schedule a slot only on its best days.
  days: z.array(z.number().int().min(0).max(6)).optional(),
});
export type ScheduleSlot = z.infer<typeof ScheduleSlot>;

export const ChannelCadence = z.object({
  channel: z.string(),
  enabled: z.boolean().default(true),
  slots: z.array(ScheduleSlot).default([]),
});
export type ChannelCadence = z.infer<typeof ChannelCadence>;

export const Schedule = z.object({
  enabled: z.boolean().default(false), // global kill switch — off until the user opts in
  timezone: z.string().default("UTC"), // IANA tz; slots are local to this
  graceMinutes: z.number().default(10), // a slot fires within [time, time+grace)
  channels: z.array(ChannelCadence).default([]),
  oneOff: z
    .array(z.object({ itemId: z.string(), at: z.string(), public: z.boolean().default(false), firedAt: z.string().optional() }))
    .default([]),
  // per-slot fire state, keyed `${channel}@${time}` — prevents same-day double-fire
  state: z.record(z.string(), z.object({ lastFiredDate: z.string(), lastItemId: z.string().optional(), lastResult: z.string().optional() })).default({}),
  updatedAt: z.string().default(""),
});
export type Schedule = z.infer<typeof Schedule>;

/* ─── Brand Genome (Agent Harness v2 §1) ─────────────────────────────────── */
export const GenomeTrait = z.object({
  value: z.string(),          // e.g. a hook pattern, topic, format id
  weight: z.number(),         // 0..1 affinity learned from performance
  evidence: z.array(z.string()).optional(), // item ids / research ids / notes
});
export type GenomeTrait = z.infer<typeof GenomeTrait>;

export const GenomeMutation = z.object({
  id: z.string(),
  at: z.string(),
  kind: z.enum(["auto", "approved", "manual"]),
  path: z.string(),           // trait path mutated, e.g. "traits.hooks"
  mutation: z.string(),       // human-readable description
  cause: z.string(),          // why (analytics signal, research finding…)
  evidence: z.array(z.string()).optional(),
});
export type GenomeMutation = z.infer<typeof GenomeMutation>;

export const PendingMutation = z.object({
  id: z.string(),
  proposedAt: z.string(),
  path: z.string(),
  mutation: z.string(),
  rationale: z.string(),
  confidence: z.number(),     // 0..1
  apply: z.unknown(),         // machine-applicable patch payload
});
export type PendingMutation = z.infer<typeof PendingMutation>;

export const PlatformPlaybook = z.object({
  platform: z.string(),       // youtube | instagram | tiktok | x | linkedin
  cadence: z.string().optional(),       // e.g. "5/week"
  bestTimes: z.array(z.string()).optional(),
  levers: z.array(z.string()),          // current algorithm levers to pull
  updatedAt: z.string(),
  researchId: z.string().optional(),    // provenance
});
export type PlatformPlaybook = z.infer<typeof PlatformPlaybook>;

export const BrandGenome = z.object({
  ...TenantFields,
  channel: z.string(),
  version: z.number(),        // bumps on every applied mutation
  updatedAt: z.string(),
  traits: z.object({
    hooks: z.array(GenomeTrait),       // hook patterns that work
    topics: z.array(GenomeTrait),      // topic affinities
    formats: z.array(GenomeTrait),     // format affinities
    visual: z.array(GenomeTrait),      // pacing/density/motion notes
    voice: z.array(GenomeTrait),       // delivery notes
  }),
  audienceModel: z.object({
    summary: z.string(),
    segments: z.array(z.object({ name: z.string(), notes: z.string() })),
  }).optional(),
  platformPlaybooks: z.array(PlatformPlaybook),
  evolution: z.array(GenomeMutation),  // capped at 100, newest first
  pending: z.array(PendingMutation),   // approval queue
  locks: z.array(z.string()),          // trait paths the user pinned
});
export type BrandGenome = z.infer<typeof BrandGenome>;

/* ─── Research harness (Agent Harness v2 §2) ─────────────────────────────── */
export const ResearchSource = z.object({
  id: z.string(), url: z.string(), title: z.string(),
  fetchedAt: z.string(), excerpt: z.string().optional(),
});
export type ResearchSource = z.infer<typeof ResearchSource>;

export const ResearchClaim = z.object({
  text: z.string(),
  sourceIds: z.array(z.string()),
  status: z.enum(["verified", "single-source", "disputed"]),
});
export type ResearchClaim = z.infer<typeof ResearchClaim>;

export const ResearchRun = z.object({
  ...TenantFields,
  id: z.string(),
  kind: z.enum(["trend", "algo", "topic", "competitor", "deep"]),
  query: z.string(),
  channel: z.string().optional(),
  depth: z.enum(["quick", "standard", "deep"]),
  status: z.enum(["running", "done", "failed"]),
  steps: z.array(z.object({ at: z.string(), label: z.string(), detail: z.string().optional() })),
  sources: z.array(ResearchSource),
  claims: z.array(ResearchClaim),
  report: z.string().optional(),   // final cited markdown
  usd: z.number().default(0),
  createdAt: z.string(),
  ttlHours: z.number(),            // cache freshness window
});
export type ResearchRun = z.infer<typeof ResearchRun>;

/* ─── Missions — the orchestrator (Agent Harness v2 §4) ──────────────────── */
export const MissionTask = z.object({
  id: z.string(), role: z.string(), goal: z.string(),
  status: z.enum(["queued", "running", "done", "failed", "skipped"]),
  dueAt: z.string().optional(), startedAt: z.string().optional(),
  finishedAt: z.string().optional(), resultSummary: z.string().optional(),
  usd: z.number().default(0),
});
export type MissionTask = z.infer<typeof MissionTask>;

export const Mission = z.object({
  ...TenantFields,
  id: z.string(),
  channel: z.string(),
  goal: z.string(),                  // "grow IG to 10k with daily premium reels"
  status: z.enum(["active", "paused", "done"]),
  cadence: z.object({                // which loops run, how often
    research: z.string().optional(),    // e.g. "weekly"
    plan: z.string().optional(),        // e.g. "weekly"
    generate: z.string().optional(),    // e.g. "daily"
    analyze: z.string().optional(),     // e.g. "daily"
    evolve: z.string().optional(),      // e.g. "weekly"
  }),
  approvalPolicy: z.object({
    publish: z.enum(["auto", "gate"]).default("gate"),
    dnaMutations: z.enum(["auto", "gate"]).default("gate"),
  }),
  budget: z.object({
    usdPerDay: z.number().optional(),
    postsPerDay: z.number().optional(),
  }),
  queue: z.array(MissionTask),
  log: z.array(z.object({ at: z.string(), event: z.string() })),
  state: z.record(z.string()).default({}),  // lastRun per loop
  createdAt: z.string(), updatedAt: z.string(),
});
export type Mission = z.infer<typeof Mission>;

/* ── Admin control store (SMM Admin cockpit) ─────────────────────────────────
   Per-workspace cross-brand control state: a workspace-wide kill-switch that
   HARD-halts all autonomous sending/posting, plus per-brand admin pause flags
   and advisory budget caps. Persisted at data/admin/<workspaceId>.json (atomic
   tmp+rename), owned solely by packages/engine/src/admin.ts. Carries NO secrets. */
export const AdminBrandControl = z.object({
  paused: z.boolean().default(false),            // admin per-brand pause (halts missions+autopilot+responder+sends for this brand)
  budgetCap: z.object({
    usdPerDay: z.number().optional(),
    postsPerDay: z.number().optional(),
  }).optional(),                                  // cockpit-visible cap; also pushed into the mission via mission_update
  updatedAt: z.string().optional(),
}).strict();
export type AdminBrandControl = z.infer<typeof AdminBrandControl>;

export const AdminControl = z.object({
  workspaceId: z.string(),
  killSwitch: z.boolean().default(false),         // workspace-wide HALT of all autonomous sending/posting
  killSwitchReason: z.string().optional(),
  killSwitchAt: z.string().optional(),
  killSwitchBy: z.string().optional(),            // Clerk user id (or "system") who flipped it
  brands: z.record(z.string(), AdminBrandControl).default({}), // keyed by channel id
  updatedAt: z.string().default(""),
}).strict();
export type AdminControl = z.infer<typeof AdminControl>;

/* ─── Creative Observation (content intelligence inventory) ─────────────────
   Stores analysed creative references scraped from Instagram / YouTube / TikTok.
   Powers the observation inventory, deep-scan harness, and inspiration engine. */

export const ObservationCreator = z.object({
  handle: z.string(),
  name: z.string().optional(),
  bio: z.string().optional(),
  bioLinks: z.array(z.string()).optional(),
  followers: z.number().optional(),
  platform: z.enum(["instagram", "youtube", "tiktok", "x", "other"]),
  profileUrl: z.string().optional(),
});
export type ObservationCreator = z.infer<typeof ObservationCreator>;

export const ObservationMetrics = z.object({
  views: z.number().optional(),
  likes: z.number().optional(),
  comments: z.number().optional(),
  shares: z.number().optional(),
  saves: z.number().optional(),
  engagementRate: z.number().optional(),
});
export type ObservationMetrics = z.infer<typeof ObservationMetrics>;

export const ObservationAnalysis = z.object({
  // Visual
  visualLanguage: z.string().describe("overall visual style description"),
  colorPalette: z.array(z.string()).optional(),
  typography: z.string().optional(),
  backgrounds: z.string().optional(),
  sceneTypes: z.array(z.string()).optional(),
  // Motion & edit
  editRhythm: z.string().optional().describe("pacing, cut freq, transitions"),
  avgSceneDuration: z.number().optional(),
  // Audio
  musicStyle: z.string().optional(),
  musicEnergy: z.enum(["low","medium","high","very_high"]).optional(),
  // Narrative
  tone: z.string().optional(),
  narrativeFormat: z.string().optional(),
  hookPattern: z.string().optional(),
  // Creative intel
  keyInsights: z.array(z.string()).optional().describe("actionable creative insights"),
  socheliMoodMapping: z.string().optional().describe("closest Socheli mood preset"),
  inspirationScore: z.number().min(0).max(10).optional(),
  rawAnalysis: z.string().optional(),
});
export type ObservationAnalysis = z.infer<typeof ObservationAnalysis>;

export const ContentObservation = z.object({
  id: z.string(),
  url: z.string(),
  platform: z.enum(["instagram", "youtube", "tiktok", "x", "other"]),
  kind: z.enum(["reel", "video", "post", "carousel", "profile"]),
  title: z.string().optional(),
  description: z.string().optional(),
  duration: z.number().optional(),
  creator: ObservationCreator.optional(),
  metrics: ObservationMetrics.optional(),
  // Local assets
  videoPath: z.string().optional(),
  thumbnailPath: z.string().optional(),
  frames: z.array(z.string()).optional(),
  // AI analysis
  analysis: ObservationAnalysis.optional(),
  // Top comments
  topComments: z.array(z.object({ text: z.string(), likes: z.number().optional() })).optional(),
  // Tags & meta
  tags: z.array(z.string()).default([]),
  notes: z.string().optional(),
  channelId: z.string().optional(),
  createdAt: z.string(),
  scannedAt: z.string().optional(),
  deepScanned: z.boolean().default(false),
});
export type ContentObservation = z.infer<typeof ContentObservation>;

export const ProfileObservation = z.object({
  id: z.string(),
  profileUrl: z.string(),
  platform: ObservationCreator.shape.platform,
  creator: ObservationCreator,
  metrics: ObservationMetrics.optional(),
  topPosts: z.array(z.object({
    url: z.string(),
    views: z.number().optional(),
    likes: z.number().optional(),
    title: z.string().optional(),
    observationId: z.string().optional(),
  })).optional(),
  contentPatterns: z.array(z.string()).optional(),
  overallStyle: z.string().optional(),
  postFrequency: z.string().optional(),
  createdAt: z.string(),
  channelId: z.string().optional(),
  tags: z.array(z.string()).default([]),
});
export type ProfileObservation = z.infer<typeof ProfileObservation>;
