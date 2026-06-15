import type { ChannelDNA, ChannelId } from "@os/schemas";
import { getMood, parseMoodSpec } from "@os/tokens";
import { readBrandRegistry, writeBrandRegistry } from "./brands-store.ts";

export const CHANNELS: Record<ChannelId, ChannelDNA> = {
  claude_code_lab: {
    id: "claude_code_lab",
    name: "Code Labrinox",
    audience: "developers, AI coding users, Cursor/Claude Code users",
    domain: "Claude Code, AI coding agents, MCP, CLI workflows, prompting, context management, dev tools, IDEs — strictly software / AI-engineering topics.",
    formats: ["mistake_fix", "terminal_tip", "before_after", "architecture_warning"],
    tone: "serious, technical, anti-hype, precise",
    visualStyle: "dark terminal, mono font, subtle glow, precision motion",
    archetype: "THE BUILDER'S WHITEBOARD. Conceive each video as a live engineering explanation: show the mechanism, not the marketing. Reach first for diagrams, terminal/code blocks, and architecture flows that make the plumbing legible. Pace is brisk and exact; every scene answers 'how does this actually work under the hood.' Favor before/after of a wrong vs right approach. No motivational beats, no metaphors-for-their-own-sake — the diagram IS the argument.",
    theme: "lab",
    logo: "logos/claude-labrato-icon.png",
    handle: "@code.labrinox",
    socials: ["Instagram", "X"],
    voice: "am_michael",
    elevenVoice: "IKne3meq5aSn9XLyUdCD",
    voiceSpeed: 1.18,
    sayAs: { MCP: "M C P", CLI: "C L I", IDE: "I D E", LLM: "L L M", API: "A P I", SDK: "S D K" },
    bannedPatterns: ["get rich quick", "fake benchmarks", "overpromising", "hype", "🚀 spam"],
    preferredHooks: ["Stop doing X", "Never do X", "This is why X fails", "X is not the problem"],
    moods: [
      { id: "tech", note: "sharp, futuristic — the default for this channel" },
      { id: "explainer", domain: "how AI coding tools, agents, MCP and LLM workflows ACTUALLY work under the hood — explained clearly for a broad technical-curious audience, less insider jargon." },
    ],
  },
  // General-purpose concept explainer — animate and explain ANY idea, not just dev tools.
  labrinox: {
    id: "labrinox",
    name: "Labrinox",
    audience: "curious people who want a complex idea explained clearly",
    domain: "psychology, neuroscience, the body, history, money, productivity, philosophy, nature, and how everyday things work — general curiosity for a BROAD audience. NEVER software, coding, AI engineering, dev tools, or programming.",
    formats: ["mistake_fix", "before_after"],
    sceneTypes: ["hook_text", "before_after", "kinetic_text", "warning", "cta", "big_number", "quote", "image_focus", "grid", "chart", "diagram", "timeline", "map", "dialogue"], // general-audience vocabulary; terminal/code_block excluded

    tone: "clear, friendly, vivid, plain-language but never dumbed-down",
    visualStyle: "premium cool-neutral, electric-blue accent, clean motion, one idea per scene",
    archetype: "THE LUCID ESSAYIST. Conceive each video as a single clear argument unfolding one idea per scene, the way a great explainer essay builds. Open with a vivid everyday hook, then carry a through-line with analogies, one striking number at a time, and clean before/after contrasts. Calm authority, never lecture-y. The viewer should feel a complex thing click into place — generosity and clarity over flash, but every reveal earns its moment.",
    theme: "concept",
    logo: "logos/labrato-icon.png",
    handle: "@labrinox",
    socials: ["Instagram", "X", "YouTube"],
    voice: "af_bella",
    elevenVoice: "cgSgspJ2msm6clMCkdW9",
    voiceSpeed: 1.2,
    bannedPatterns: ["clickbait", "hype", "fake urgency", "condescension"],
    preferredHooks: ["How X actually works", "The real reason X", "X, explained simply", "What nobody tells you about X"],
    moods: [
      { id: "explainer", note: "general curiosity — the default cluster" },
      { id: "mindfulness", domain: "mindfulness, focus, habits, sleep, stress and emotional regulation, calm productivity and everyday self-development — practical and evidence-based, never woo." },
      { id: "motivational", domain: "discipline, resilience, ambition, overcoming fear and building momentum — grounded in real psychology and the words of respected thinkers, never empty hype." },
      { id: "business", domain: "money, personal finance, economics, markets, careers and how business and wealth actually work — for a broad NON-expert audience, never insider finance jargon." },
      { id: "tech", domain: "how technology, the internet, phones and AI actually work in everyday life — explained simply for NON-engineers. Consumer curiosity, NEVER coding, dev tools, or programming." },
      { id: "cinematic", domain: "high-stakes intellectual ideas — philosophy, civilizational shifts, historical turning points, big-picture science — told in a premium filmic register." },
      { id: "ops_room", domain: "geopolitics, international relations, military strategy, global power competition, trade wars, sanctions, and how nations use infrastructure and finance as weapons." },
      { id: "war_economy", domain: "economic warfare, financial sanctions, trade flow disruption, supply chain geopolitics, market crises caused by political actors — the intersection of money and power." },
    ],
  },
  // MoltJobs — API-first, blockchain-powered job marketplace for autonomous AI agents.
  moltjobs: {
    id: "moltjobs",
    name: "MoltJobs",
    audience: "AI agent developers and autonomous-agent builders, plus businesses seeking verifiable AI labor",
    domain: "the AI agent economy, autonomous agents that find work and get paid in USDC, on-chain escrow on Base, proof-of-execution, agent reputation — strictly the agentic-work + web3-payments space.",
    formats: ["mistake_fix", "before_after", "architecture_warning", "terminal_tip"],
    tone: "technical-authoritative, terse, confrontational-confident. Treats agents as economic peers, not tools. Opposition framing (old vs new). Proof, not promises. Zero corporate warmth.",
    visualStyle: "dark industrial magma — warm near-black, single orange-red lava accent, gold heat on key lines, code/terminal windows, on-chain/network motifs, subtle grain.",
    archetype: "THE ON-CHAIN OPERATOR. Conceive each video as a terse dispatch from a live agent economy — momentum, opposition framing (old broken way vs the on-chain way), proof over promises. Reach for terminal/code windows, escrow/network motifs, hard numbers, and stark before/after of a 20%-middleman vs USDC-on-Base settlement. Heavy, confident, urgent rhythm; every scene asserts. No warmth, no hedging, no speculation — show the receipt.",
    theme: "magma",
    logo: "logos/moltjobs.svg",
    handle: "@moltjobs",
    site: "moltjobs.io",
    socials: ["X", "LinkedIn", "Telegram"],
    voice: "am_michael",
    elevenVoice: "IKne3meq5aSn9XLyUdCD",
    voiceSpeed: 1.15,
    sayAs: { USDC: "U S D C", API: "A P I", ROI: "R O I" },
    bannedPatterns: ["get rich quick", "vague AI hype", "could/might/imagine speculation", "warm casual tone", "emoji spam", "human-freelancer sympathy framing"],
    preferredHooks: ["Your agent is already late", "Stop paying 20%. Agents earn on-chain", "AI theater is over", "This is proof-of-execution"],
    moods: [
      { id: "tech", note: "technical walkthroughs — the default", domain: "how autonomous agents connect to the API, bid on jobs, execute work, and receive USDC via on-chain escrow — concrete builder walkthroughs." },
      { id: "business", domain: "why verifiable AI labor + on-chain escrow beats traditional outsourcing — ROI and strategy for job posters and AI-forward companies." },
      { id: "explainer", domain: "blockchain escrow in plain terms, how Base settles USDC, and the MoltJobs marketplace lifecycle step by step." },
      { id: "motivational", domain: "the agent economy is live — builders who ship autonomous earning agents now are positioning for a future where AI earns independently." },
    ],
  },
  // CognitiveX / iCog — a portable, persistent memory + cognition layer for AI tools.
  cognitivx: {
    id: "cognitivx",
    name: "iCog by CognitivX",
    audience: "developers and power users who live inside AI tools daily and lose context between sessions and agents",
    domain: "persistent cross-session AI memory, cross-agent continuity, the cognition loop (activation-ranked recall + nightly dream consolidation), memory as the product — strictly personal-AI-memory + cognitive-infrastructure topics.",
    formats: ["mistake_fix", "before_after", "architecture_warning", "terminal_tip"],
    tone: "clipped, high-signal, cinematic-intimate, anti-hype, mechanism-first. Declarative sentences that land hard. Names mechanisms, not adjectives. Rejects 'smarter AI' framing — it's about continuity and being remembered.",
    visualStyle: "ultra-dark blue-black, single violet accent (#8b5cf6), warm off-white text, near-zero saturation except the accent; strong typographic hierarchy; indigo memory glow; film-grade texture.",
    archetype: "THE QUIET MEMOIRIST. Conceive each video as restrained, typographic, almost literary — memory and continuity as the recurring theme. Slow, deliberate reveals; a lot of negative space; one violet glow as the only ornament. Reach for declarative single-line statements, the named mechanism (recall, decay, dream consolidation), and intimate before/after of starting-from-zero vs being-remembered. Cinematic stillness over motion — let one sentence hold the frame. No feature lists, no hype, no clutter.",
    theme: "cognitivx",
    logo: "logos/cognitivx.png",
    handle: "@CognitivX",
    site: "cognitivx.io",
    socials: ["X", "LinkedIn", "Instagram"],
    voice: "am_adam",
    elevenVoice: "JBFqnCBsd6RMkjVDRZzb",
    voiceSpeed: 1.1,
    sayAs: { iCog: "eye cog", BM25: "B M twenty-five", API: "A P I" },
    bannedPatterns: ["smarter AI / AI assistant framing", "bright warm palettes", "feature-list enumeration", "rainbow gradients", "casual Gen-Z tone", "hype without mechanism"],
    preferredHooks: ["Every AI tool starts from zero", "It's not smarter AI", "What if it remembered the reason", "The machine stops being a stranger"],
    moods: [
      { id: "tech", note: "mechanism-first — the default", domain: "how memory architectures actually work: vector + BM25 recall, PageRank/decay weighting, nightly dream consolidation, cross-agent continuity — show the mechanism." },
      { id: "explainer", domain: "what cross-session AI memory really is, and how iCog differs from built-in vendor memory (portable vs locked-in)." },
      { id: "mindfulness", domain: "the cognitive tax of re-explaining your context to every AI tool every session — naming that overhead, and the relief of being remembered." },
      { id: "business", domain: "founder/market positioning: why single-vendor labs are structurally disincentivized from building a portable memory layer, and why timing favors it now." },
    ],
  },
};

/* The EFFECTIVE brand registry: the persisted `data/brands.json` (managed via
   the dashboard's brand-settings CRUD) when present, else the built-in CHANNELS.
   Seeded from the built-ins on first run so the dashboard always has data.
   Cached for the process lifetime — a CLI run never mutates brands mid-flight;
   the dashboard edits in its own process and the next engine run reads fresh. */
let _effective: Record<string, ChannelDNA> | null = null;
export function effectiveChannels(): Record<string, ChannelDNA> {
  if (_effective) return _effective;
  const reg = readBrandRegistry();
  if (reg) {
    _effective = reg.brands;
    return _effective;
  }
  // no registry yet → seed it from the built-ins (best-effort), return built-ins
  try {
    writeBrandRegistry(CHANNELS as Record<string, ChannelDNA>);
  } catch {
    /* read-only fs is fine — fall through to built-ins */
  }
  _effective = CHANNELS as Record<string, ChannelDNA>;
  return _effective;
}

export const resolveChannel = (id: string): ChannelDNA => {
  const all = effectiveChannels();
  const c = all[id];
  if (!c) throw new Error(`unknown channel '${id}'. Known: ${Object.keys(all).join(", ")}`);
  return c;
};

/* All registered channel ids — used by the growth scorecard to enumerate
   channels for the dashboard even before any analytics have been ingested. */
export const channelIds = (): ChannelId[] => Object.keys(effectiveChannels()) as ChannelId[];

/* Human-readable channel name, safe for unknown ids (returns the id itself). */
export const channelName = (id: string): string => effectiveChannels()[id]?.name ?? id;

/* The content clusters (moods) a channel offers; first is its default. */
export const channelMoods = (c: ChannelDNA) => c.moods?.length ? c.moods : [{ id: c.defaultMood ?? "explainer" }];
export const defaultMoodFor = (c: ChannelDNA) => channelMoods(c)[0].id;

/* Resolve a channel + mood into the effective DNA for that content cluster:
   the cluster's own domain/formats override the channel's base. Unknown moods
   fall back to the channel default cluster. */
export function channelForMood(c: ChannelDNA, moodId?: string): ChannelDNA {
  const list = channelMoods(c);
  const cluster = list.find((m) => m.id === moodId) ?? list[0];
  return { ...c, domain: cluster.domain ?? c.domain, formats: cluster.formats ?? c.formats };
}

/* ─── Voice resolution ─────────────────────────────────────────────────────
   One place that resolves the spoken delivery for a (channel, mood) pair so
   run.ts / rerender.ts / longform-run.ts never drift. Returns ElevenLabs
   voice_settings (merge: DEFAULT < mood register < channel override), a blended
   Kokoro pacing, and the channel's pronunciation map. */
export type ElevenSettings = { stability: number; similarity_boost: number; style: number; use_speaker_boost: boolean };

const DEFAULT_VOICE: ElevenSettings = { stability: 0.45, similarity_boost: 0.85, style: 0.4, use_speaker_boost: true };

// Mood register → expressiveness. Calmer moods read steadier (higher stability,
// less style); urgent moods read more dynamic (lower stability, more style).
const MOOD_VOICE: Record<string, Partial<ElevenSettings>> = {
  mindfulness: { stability: 0.62, style: 0.22 },
  explainer: { stability: 0.48, style: 0.34 },
  business: { stability: 0.46, style: 0.4 },
  tech: { stability: 0.42, style: 0.44 },
  motivational: { stability: 0.32, style: 0.56 },
};

const clamp = (lo: number, hi: number, v: number) => Math.max(lo, Math.min(hi, v));

export function resolveVoiceSettings(c: ChannelDNA, moodId?: string): { eleven: ElevenSettings; kokoroSpeed: number; sayAs?: Record<string, string> } {
  const mood = getMood(moodId);
  // Blend the per-mood expressiveness register across a mixture (weighted), so a
  // "cinematic*0.7+motivational*0.3" reads steadier-but-a-bit-punchier, not
  // flat-default. Single moods resolve to exactly their own register as before.
  const parts = parseMoodSpec(moodId);
  const reg = (k: "stability" | "style") => parts.reduce((a, p) => a + ((MOOD_VOICE[p.id]?.[k] ?? DEFAULT_VOICE[k])) * p.weight, 0);
  const eleven: ElevenSettings = { ...DEFAULT_VOICE, stability: reg("stability"), style: reg("style"), ...(c.voiceSettings ?? {}) };
  // Kokoro honours speed (Eleven ignores it on v2); blend the mood rate by the
  // channel's own pacing anchor so e.g. a terse dev channel reads a touch faster.
  const kokoroSpeed = clamp(0.9, 1.25, (mood.voiceSpeed ?? 1) * ((c.voiceSpeed ?? 1.15) / 1.15));
  return { eleven, kokoroSpeed, sayAs: c.sayAs };
}
