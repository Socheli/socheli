import { z } from "zod";
import { think } from "./brain.ts";
import { webSearch, searchContext, type SearchResult } from "./websearch.ts";

export type CompetitorIntel = {
  name: string;
  category: string;
  sources: { label: string; url: string; observed: string }[];
  strengths: string[];
  exposedSurface: "closed_ui" | "partial_api" | "template_tool" | "agentic_ui";
  gaps: string[];
  opportunity: string;
  scores: Record<string, number>;
};

export const COMPETITIVE_DIMENSIONS = [
  "agent_external_control",
  "evidence_artifacts",
  "deterministic_editability",
  "schema_contract",
  "closed_loop_review",
  "component_depth",
  "platform_packaging",
  "creative_generation",
] as const;

export const COMPETITOR_INTEL: CompetitorIntel[] = [
  {
    name: "CapCut",
    category: "creator-speed editor",
    sources: [
      {
        label: "CapCut Desktop AI-powered Video Editor",
        url: "https://www.capcut.com/tools/desktop-ai-power/",
        observed: "Markets Script to Video, AI Writer, Smart Generation, subtitles, voiceover, music, Auto Reframe, and Auto Captions.",
      },
      {
        label: "CapCut Auto Video Editor",
        url: "https://www.capcut.com/tools/auto-video-editor",
        observed: "Offers one-click automatic cutting, AI scene detection, short-form clipping, subtitles, music sync, and templates.",
      },
    ],
    strengths: ["short-form speed", "templates", "auto captions", "script-to-video", "auto reframe", "mass creator familiarity"],
    exposedSurface: "closed_ui",
    gaps: [
      "No evidence-first external model review loop.",
      "No durable frame/waveform/diagnostic artifacts for agent decisions.",
      "No schema-backed component editing contract exposed to outside coding agents.",
    ],
    opportunity: "Beat CapCut on professional repeatability: every AI edit should become a command, artifact, and review trail.",
    scores: {
      agent_external_control: 1,
      evidence_artifacts: 1,
      deterministic_editability: 2,
      schema_contract: 1,
      closed_loop_review: 1,
      component_depth: 3,
      platform_packaging: 8,
      creative_generation: 7,
    },
  },
  {
    name: "Adobe Premiere Pro",
    category: "professional NLE",
    sources: [
      {
        label: "Adobe Text-Based Editing",
        url: "https://helpx.adobe.com/premiere-pro/using/text-based-editing.html",
        observed: "Text-Based Editing transcribes media and lets editors create rough cuts from transcript text.",
      },
      {
        label: "Adobe Generative Extend overview",
        url: "https://helpx.adobe.com/in/premiere/desktop/edit-projects/edit-with-generative-ai/generative-extend-overview.html",
        observed: "Generative Extend adds frames/audio to cover transitions, reaction holds, cue timing, background sound, or unwanted motion.",
      },
      {
        label: "Adobe Generative Extend known issues",
        url: "https://helpx.adobe.com/premiere-pro/using/generative-extend-known-issues.html",
        observed: "Known limitations include unsupported speech-to-text on extended clips, media intelligence indexing exclusions, speed adjustment limitations, multicam flattening, and music extension problems.",
      },
    ],
    strengths: ["professional timeline", "ecosystem trust", "text-based editing", "captions", "Generative Extend", "media management"],
    exposedSurface: "closed_ui",
    gaps: [
      "Strong UI automation but no repo-native storyboard/component contract.",
      "Generative features have media eligibility limitations that can break downstream transcript/search workflows.",
      "Model review artifacts are not the center of the editing loop.",
    ],
    opportunity: "Beat Premiere on agent-native precision: exact JSON scene patches, validation, and review artifacts instead of only app-resident edits.",
    scores: {
      agent_external_control: 2,
      evidence_artifacts: 4,
      deterministic_editability: 6,
      schema_contract: 3,
      closed_loop_review: 2,
      component_depth: 6,
      platform_packaging: 5,
      creative_generation: 7,
    },
  },
  {
    name: "Descript",
    category: "transcript-first AI editor",
    sources: [
      {
        label: "Descript Underlord AI co-editor",
        url: "https://help.descript.com/hc/en-us/articles/36803785502221-Underlord-beta-Your-AI-co-editor-in-Descript",
        observed: "Underlord is an agentic co-editor that can perform video editing tasks through chat, including captions, clips, animation, translation, music, sound, and slides-to-video.",
      },
      {
        label: "Descript Get Started",
        url: "https://help.descript.com/hc/en-us/articles/10601763396493-Get-started-with-Descript",
        observed: "Highlights Studio Sound, Eye Contact, Create clips, Underlord, comments, publishing links, and integrations.",
      },
      {
        label: "Descript animations",
        url: "https://help.descript.com/hc/en-us/articles/10255972601485-Applying-and-adjusting-animations",
        observed: "Underlord can apply animation and generate keyframes, but bulk animation editing is documented as unsupported.",
      },
    ],
    strengths: ["transcript editing", "AI co-editor", "studio sound", "filler cleanup", "clip creation", "collaboration"],
    exposedSurface: "agentic_ui",
    gaps: [
      "Agent is inside Descript, not an external MCP/CLI that coding models can operate reproducibly.",
      "Less suited to structured generated components like terminal/code/before-after scenes.",
      "Review evidence is collaboration-oriented, not a machine-readable render QA pack.",
    ],
    opportunity: "Beat Descript by being agent-native outside the app and by treating every visual component as structured editable data.",
    scores: {
      agent_external_control: 3,
      evidence_artifacts: 4,
      deterministic_editability: 5,
      schema_contract: 2,
      closed_loop_review: 4,
      component_depth: 5,
      platform_packaging: 7,
      creative_generation: 8,
    },
  },
  {
    name: "Runway",
    category: "generative video studio",
    sources: [
      {
        label: "Runway Aleph 2.0 and Edit Studio",
        url: "https://runwayml.com/news/introducing-aleph-2-and-edit-studio",
        observed: "Aleph 2.0 and Edit Studio target existing-video transformation with up to 30s 1080p clips and localized edits with input preservation.",
      },
      {
        label: "Runway Creating with Edit Studio",
        url: "https://help.runwayml.com/hc/en-us/articles/51683104370451-Creating-with-Edit-Studio",
        observed: "Edit Studio lets users transform footage with prompts, swap products/characters, remove objects, add effects, relight, restyle, and guide motion.",
      },
    ],
    strengths: ["generative video quality", "localized edits", "VFX/restyle workflows", "prompt-driven shot transformation"],
    exposedSurface: "closed_ui",
    gaps: [
      "Excellent media generation, but not a deterministic storyboard-to-render operating system.",
      "Model output quality is central; auditability and exact structured edit commands are secondary.",
      "Not optimized for code/terminal/component-rich technical shorts.",
    ],
    opportunity: "Use Runway-like generation as a module later, but win on reproducible production control, evidence, and domain-specific components.",
    scores: {
      agent_external_control: 2,
      evidence_artifacts: 3,
      deterministic_editability: 4,
      schema_contract: 1,
      closed_loop_review: 3,
      component_depth: 4,
      platform_packaging: 4,
      creative_generation: 10,
    },
  },
  {
    name: "Kapwing",
    category: "browser AI editor",
    sources: [
      {
        label: "Kapwing AI",
        url: "https://www.kapwing.com/ai",
        observed: "Combines AI generation and AI editing in a browser workspace with AI Assistant guidance.",
      },
      {
        label: "Kapwing Video Editor",
        url: "https://www.kapwing.com/video-editor",
        observed: "Includes AI Assistant, clip maker, resizing/social workflows, assets, sound effects, and music.",
      },
    ],
    strengths: ["browser collaboration", "assistant guidance", "subtitles", "clip maker", "social formats"],
    exposedSurface: "agentic_ui",
    gaps: [
      "Assistant is UX-centric, not a reproducible external command protocol.",
      "No first-class evidence pack for model QA decisions.",
      "General-purpose browser editor rather than domain-specific generated scenes.",
    ],
    opportunity: "Beat Kapwing by giving agents exact production-grade state control and durable QA artifacts, while keeping social packaging.",
    scores: {
      agent_external_control: 2,
      evidence_artifacts: 2,
      deterministic_editability: 4,
      schema_contract: 2,
      closed_loop_review: 2,
      component_depth: 4,
      platform_packaging: 8,
      creative_generation: 7,
    },
  },
  {
    name: "Canva",
    category: "brand/template creative OS",
    sources: [
      {
        label: "TechRadar Canva Creative Operating System report",
        url: "https://www.techradar.com/ai-platforms-assistants/canva-just-launched-its-creative-operating-system-a-massive-upgrade-built-to-supercharge-creativity-with-ai",
        observed: "Reports Magic Video, Ask Canva, design suggestions, copy edits, style matching, video generation, and AI inside the editor.",
      },
    ],
    strengths: ["brand kits", "templates", "broad creative suite", "Ask Canva", "design accessibility"],
    exposedSurface: "agentic_ui",
    gaps: [
      "Optimized for accessible design breadth, not precise rendered-video QA.",
      "Does not expose a local scene/component renderer contract for coding agents.",
      "Less focused on faceless technical-video component depth.",
    ],
    opportunity: "Beat Canva on technical precision and agent-controlled render iteration, not template breadth.",
    scores: {
      agent_external_control: 2,
      evidence_artifacts: 2,
      deterministic_editability: 3,
      schema_contract: 2,
      closed_loop_review: 2,
      component_depth: 4,
      platform_packaging: 8,
      creative_generation: 8,
    },
  },
  {
    name: "VEED",
    category: "browser AI editor",
    sources: [
      {
        label: "VEED Video Editor",
        url: "https://www.veed.io/tools/video-editor",
        observed: "Positions itself as an online video editor for creators with AI editing interface and browser workflow.",
      },
      {
        label: "VEED AI Playground help",
        url: "https://support.veed.io/en/articles/11712887-ai-playground",
        observed: "Documents AI Playground as an in-editor surface for advanced AI models.",
      },
    ],
    strengths: ["browser editing", "AI playground", "captions", "creator workflow", "simple exports"],
    exposedSurface: "agentic_ui",
    gaps: [
      "AI model surface is inside the editor, not a durable external review/edit protocol.",
      "Less transparent about exact state changes and QA artifacts.",
      "Not specialized for structured technical scenes.",
    ],
    opportunity: "Beat VEED with transparent state, local artifacts, and model-to-model review reproducibility.",
    scores: {
      agent_external_control: 2,
      evidence_artifacts: 2,
      deterministic_editability: 3,
      schema_contract: 2,
      closed_loop_review: 2,
      component_depth: 4,
      platform_packaging: 7,
      creative_generation: 7,
    },
  },
  {
    name: "OpusClip",
    category: "repurposing/clipping",
    sources: [
      {
        label: "OpusClip changelog",
        url: "https://opusclip.canny.io/changelog",
        observed: "Shows ongoing work on duplicating clips, platform posting, generated titles/descriptions/hashtags, scheduling, and mobile workflows.",
      },
    ],
    strengths: ["long-to-short clipping", "social packaging", "titles/descriptions/hashtags", "scheduling", "repurposing"],
    exposedSurface: "template_tool",
    gaps: [
      "Clip discovery is not the same as full editor ownership.",
      "Does not expose a structured generated scene stack with component-level patches.",
      "Context understanding is broad; domain-specific technical judgment remains a gap.",
    ],
    opportunity: "Beat OpusClip by combining platform packaging with full generated-video construction and evidence-backed revision.",
    scores: {
      agent_external_control: 2,
      evidence_artifacts: 3,
      deterministic_editability: 3,
      schema_contract: 2,
      closed_loop_review: 3,
      component_depth: 3,
      platform_packaging: 9,
      creative_generation: 5,
    },
  },
];

export const OUR_STRATEGIC_EDGE = [
  "External MCP/CLI control of exact editor state instead of UI-only AI buttons.",
  "Evidence artifacts for model review: ordered frames, contact sheets, waveform, diagnostics, timestamps, and ffprobe metadata.",
  "Timecoded video memory: sampled frames mapped to scenes, OCR text, transcript words, motion deltas, pixel metrics, and issue tags.",
  "Schema-backed storyboard/component contract that agents can patch deterministically.",
  "Safe clone/edit/rerender loop for experiments without damaging source runs.",
  "Review packs that preserve what the model saw and exactly what commands it should run next.",
  "Structured technical-video components: terminal, code, before/after, kinetic text, warning, CTA.",
  "Local-first inspectability: every artifact can be opened, diffed, stored, and referenced by a model.",
];

export const UNMET_JOBS = [
  {
    job: "Let a coding agent operate the editor without UI babysitting.",
    whyCompetitorsMiss: "Most AI features live as buttons or chat inside proprietary UI surfaces.",
    productMove: "Expose all editor state and operations through CLI/MCP with schema validation.",
  },
  {
    job: "Make video QA evidence-based rather than vibe-based.",
    whyCompetitorsMiss: "Assistants often produce suggestions without machine-readable frame/audio evidence.",
    productMove: "Generate review packs with frames, contact sheets, waveform, diagnostics, timestamps, and exact scene ids.",
  },
  {
    job: "Make generated technical videos deeply editable as structured objects.",
    whyCompetitorsMiss: "General editors treat terminal/code screens as pixels, clips, or text layers.",
    productMove: "Represent terminal/code/before-after scenes as typed components with nested fields.",
  },
  {
    job: "Close the loop after rerender.",
    whyCompetitorsMiss: "Many tools generate or edit once, then rely on manual human review.",
    productMove: "Compare prior review issues against new render artifacts until defects disappear.",
  },
];

export function competitorOpportunityScores() {
  return COMPETITIVE_DIMENSIONS.map((dimension) => {
    const competitorAvg = COMPETITOR_INTEL.reduce((sum, c) => sum + (c.scores[dimension] ?? 0), 0) / COMPETITOR_INTEL.length;
    const ourTarget = targetScore(dimension);
    return {
      dimension,
      competitorAvg: Number(competitorAvg.toFixed(2)),
      ourTarget,
      gap: Number((ourTarget - competitorAvg).toFixed(2)),
    };
  }).sort((a, b) => b.gap - a.gap);
}

export function strategicRoadmap() {
  return [
    {
      id: "render_compare",
      priority: "P0",
      reason: "Turns rerender into measurable improvement instead of manual inspection.",
      commandShape: "pnpm editor compare-renders <beforeId> <afterId>",
    },
    {
      id: "closed_loop_reviewer",
      priority: "P0",
      reason: "What competitors rarely do: prove the next render fixed the previous defects.",
      commandShape: "pnpm editor review-loop <id> --max-rounds 3",
    },
    {
      id: "publish_feedback_loop",
      priority: "P1",
      reason: "Turns platform results into future creative choices, not one-off editing guesses.",
      commandShape: "pnpm editor learn-from-post <id> --metrics <json>",
    },
    {
      id: "recipe_acceptance_benchmarks",
      priority: "P2",
      reason: "Scores which reusable edit recipes actually improve videos by channel and content type.",
      commandShape: "pnpm editor benchmark-recipes <id> --recipes all",
    },
  ];
}

/* ─── G6: title + hashtag suggestions ──────────────────────────────────────
   Generate platform-tailored title and hashtag options from an item's topic +
   script, reusing the engine brain (`think`). Returns a few ranked variants per
   platform so the UI can offer choices instead of a single take. Additive /
   non-breaking: nothing calls this until UI is wired; exported for that wiring.
   Falls back to a deterministic local suggestion if the brain is unavailable. */
const PLATFORM_TITLE_PLATFORMS = ["youtube", "instagram", "tiktok", "x"] as const;
export type TitlePlatform = (typeof PLATFORM_TITLE_PLATFORMS)[number];

const TitleHashtagSuggestion = z.object({
  platform: z.enum(PLATFORM_TITLE_PLATFORMS),
  titles: z.array(z.string()).min(1).max(5),
  hashtags: z.array(z.string()).min(1).max(15),
});
export type TitleHashtagSuggestion = z.infer<typeof TitleHashtagSuggestion>;

const TitleHashtagResult = z.object({ suggestions: z.array(TitleHashtagSuggestion).min(1) });
export type TitleHashtagResult = z.infer<typeof TitleHashtagResult>;

export type TitleHashtagInput = {
  topic: string;
  hook?: string;
  cta?: string;
  narration?: string[];
  platforms?: TitlePlatform[];
};

/* Deterministic, offline fallback — never throws, so callers always get options. */
function fallbackTitleHashtags(input: TitleHashtagInput): TitleHashtagResult {
  const topic = input.topic.trim() || "this build";
  const slug = topic
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .split(/\s+/)
    .filter(Boolean);
  const tag = (w: string) => `#${w}`;
  const base = [...new Set([...slug.slice(0, 3), "coding", "ai", "devtools", "labrinox"])].map(tag).slice(0, 8);
  const titles = [
    input.hook?.trim() || topic,
    `How ${topic} actually works`,
    `${topic} in 60 seconds`,
  ].filter(Boolean);
  const platforms = input.platforms?.length ? input.platforms : [...PLATFORM_TITLE_PLATFORMS];
  return {
    suggestions: platforms.map((platform) => ({
      platform,
      titles: titles.slice(0, platform === "x" ? 2 : 3),
      hashtags: platform === "x" ? base.slice(0, 3) : base,
    })),
  };
}

export async function suggestTitlesAndHashtags(
  input: TitleHashtagInput,
  tier: "cheap" | "smart" | "best" = "smart",
): Promise<{ data: TitleHashtagResult; usd: number }> {
  const platforms = input.platforms?.length ? input.platforms : [...PLATFORM_TITLE_PLATFORMS];
  const context = [
    `TOPIC: ${input.topic}`,
    input.hook ? `HOOK: ${input.hook}` : "",
    input.cta ? `CTA: ${input.cta}` : "",
    input.narration?.length ? `SCRIPT:\n${input.narration.join("\n")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  const prompt =
    `You are packaging a short faceless technical video for the Labrinox channel.\n` +
    `For EACH of these platforms: ${platforms.join(", ")}, write platform-native title options and hashtags.\n` +
    `Rules: titles are scroll-stopping but not clickbait; X titles are punchy (<=2). ` +
    `Hashtags are a sized mix (broad + niche + branded), lowercase, no spaces, include the # ; ` +
    `x gets <=3 hashtags, others up to ~8.\n\n${context}\n\n` +
    `Return ONLY JSON: {"suggestions":[{"platform","titles":[...],"hashtags":["#..."]}]}.`;
  try {
    const res = await think(TitleHashtagResult, prompt, tier);
    return { data: res.data, usd: res.usd };
  } catch {
    return { data: fallbackTitleHashtags({ ...input, platforms }), usd: 0 };
  }
}

/* ─── G4: trend + competitor intel for the generation brain ────────────────
   Surface (a) trending sounds/audio and (b) top competitor "winner" formats for
   a topic/platform into ONE structured object the ideation brain can consume.
   Reuses the engine's existing webSearch (open-websearch MCP) + think (brain)
   patterns. Tolerant: web/brain failures degrade to empty arrays, never throw.
   Additive — nothing calls this until ideation is wired to it. */
const TrendPlatform = z.enum(["tiktok", "instagram", "youtube"]);
export type TrendPlatform = z.infer<typeof TrendPlatform>;

const TrendingSound = z.object({
  name: z.string(),
  artist: z.string().optional(),
  vibe: z.string().optional(), // e.g. "tense build", "upbeat", "lofi calm"
  whyTrending: z.string().optional(),
});
export type TrendingSound = z.infer<typeof TrendingSound>;

const CompetitorWinner = z.object({
  source: z.string(), // creator/brand or outlet
  format: z.string(), // the format/structure that won
  hookStyle: z.string().optional(),
  why: z.string(), // why it worked
  url: z.string().optional(),
});
export type CompetitorWinner = z.infer<typeof CompetitorWinner>;

export const TrendIntel = z.object({
  topic: z.string(),
  platform: TrendPlatform,
  trendingSounds: z.array(TrendingSound).default([]),
  competitorWinners: z.array(CompetitorWinner).default([]),
  /** Concrete, copy-able angle suggestions for THIS topic. */
  suggestedAngles: z.array(z.string()).default([]),
  sources: z.array(z.object({ title: z.string(), url: z.string() })).default([]),
});
export type TrendIntel = z.infer<typeof TrendIntel>;

export type TrendIntelInput = {
  topic: string;
  platform?: TrendPlatform;
  niche?: string; // optional vertical hint, e.g. "AI coding", "neuroscience"
};

/* Empty-but-valid result so callers always get the shape. */
function emptyTrendIntel(topic: string, platform: TrendPlatform, sources: SearchResult[] = []): TrendIntel {
  return {
    topic,
    platform,
    trendingSounds: [],
    competitorWinners: [],
    suggestedAngles: [],
    sources: sources.map((s) => ({ title: s.title, url: s.url })).filter((s) => s.url).slice(0, 8),
  };
}

export async function getTrendIntel(
  input: TrendIntelInput,
  tier: "cheap" | "smart" | "best" = "smart",
): Promise<{ data: TrendIntel; usd: number }> {
  const platform = input.platform ?? "tiktok";
  const niche = input.niche?.trim();
  // Live web context: trending sounds + recent competitor winners for the niche.
  const soundQ = `trending ${platform} sounds ${new Date().getFullYear()} ${niche ?? input.topic}`;
  const winnerQ = `most viral ${platform} ${niche ?? input.topic} videos format hook ${new Date().getFullYear()}`;
  const soundResults = webSearch(soundQ, 5);
  const winnerCtx = searchContext(winnerQ, 6);
  const soundCtx = soundResults.length
    ? `TRENDING-SOUND SEARCH ("${soundQ}"):\n` + soundResults.map((r, i) => `${i + 1}. ${r.title} — ${r.description.slice(0, 200)} [${r.url}]`).join("\n")
    : "";

  // If web context is empty we still try the brain on its own knowledge; if that
  // also fails the catch below returns an empty valid object.
  const allSources = [...soundResults];

  const prompt =
    `You are a short-form growth strategist for the Labrinox brand.\n` +
    `TOPIC: ${input.topic}\nPLATFORM: ${platform}${niche ? `\nNICHE: ${niche}` : ""}\n\n` +
    `Using the web context below (when present) plus your own knowledge, return:\n` +
    `- trendingSounds: audio currently trending on ${platform} that would fit this topic (name, artist if known, vibe, whyTrending).\n` +
    `- competitorWinners: recent high-performing videos in this niche and the FORMAT/hook that made them win (source, format, hookStyle, why, url if known).\n` +
    `- suggestedAngles: 3-6 concrete angles for THIS topic informed by the above.\n` +
    `Be specific and current; do not invent fake URLs (omit url if unsure).\n\n` +
    `${[soundCtx, winnerCtx].filter(Boolean).join("\n\n")}\n\n` +
    `Return ONLY JSON: {"trendingSounds":[...],"competitorWinners":[...],"suggestedAngles":[...]}.`;

  // Brain returns the creative arrays; we attach topic/platform/sources ourselves.
  const Partial = z.object({
    trendingSounds: z.array(TrendingSound).default([]),
    competitorWinners: z.array(CompetitorWinner).default([]),
    suggestedAngles: z.array(z.string()).default([]),
  });
  try {
    const res = await think(Partial, prompt, tier, 2, "trend_scan");
    return {
      data: {
        topic: input.topic,
        platform,
        trendingSounds: res.data.trendingSounds,
        competitorWinners: res.data.competitorWinners,
        suggestedAngles: res.data.suggestedAngles,
        sources: allSources.map((s) => ({ title: s.title, url: s.url })).filter((s) => s.url).slice(0, 8),
      },
      usd: res.usd,
    };
  } catch {
    return { data: emptyTrendIntel(input.topic, platform, allSources), usd: 0 };
  }
}

/* Compact prompt block so ideation can splice trend intel into its own prompt. */
export function trendIntelContext(intel: TrendIntel): string {
  const lines: string[] = [];
  if (intel.trendingSounds.length)
    lines.push(`TRENDING SOUNDS (${intel.platform}): ` + intel.trendingSounds.map((s) => `${s.name}${s.artist ? ` — ${s.artist}` : ""}${s.vibe ? ` (${s.vibe})` : ""}`).join("; "));
  if (intel.competitorWinners.length)
    lines.push(`COMPETITOR WINNERS: ` + intel.competitorWinners.map((w) => `${w.format} via ${w.source} — ${w.why}`).join("; "));
  if (intel.suggestedAngles.length) lines.push(`SUGGESTED ANGLES: ${intel.suggestedAngles.join("; ")}`);
  return lines.join("\n");
}

function targetScore(dimension: string) {
  switch (dimension) {
    case "agent_external_control":
    case "evidence_artifacts":
    case "deterministic_editability":
    case "schema_contract":
    case "closed_loop_review":
    case "component_depth":
      return 10;
    case "platform_packaging":
      return 8;
    case "creative_generation":
      return 7;
    default:
      return 8;
  }
}
