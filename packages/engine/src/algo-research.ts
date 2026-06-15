import { z } from "zod";
import { think } from "./brain.ts";
import { webSearch, type SearchResult } from "./websearch.ts";
import { resolveChannel, channelMoods } from "./channels.ts";
import { proposeConcepts, type Concept } from "./stages.ts";
import { avoidListForChannel } from "./concept-board.ts";
import { getLearnings } from "./learnings.ts";
import { findFresh } from "./research/store.ts";
import { runResearch } from "./research/orchestrator.ts";
import { getGenome, saveGenome, genomeContextSafe } from "./dna.ts";
import type { ChannelDNA } from "@os/schemas";
import { DEFAULT_WORKSPACE } from "@os/schemas";

/* ─── Algo-hacking research + content planner ──────────────────────────────
   Turns a channel (brand) into a DATED content plan grounded in a per-platform
   "algorithm playbook": what each destination platform actually rewards right
   now, mined from live web search + the brain, then a slate of concrete concepts
   spread across the channel's platforms and laid onto upcoming days.

   Every meaningful unit of work is reported through an `onStep` callback so the
   UI can visualize the research as it happens (search → signals → playbook →
   ranked ideas → schedule). All web/brain calls degrade gracefully — the plan
   still lands if search is down or the brain hiccups. */

/* ── Platform model ──────────────────────────────────────────────────────── */
export type PlatformKey = "youtube" | "instagram" | "tiktok" | "x" | "linkedin" | "telegram";

export type PlatformMeta = {
  key: PlatformKey;
  label: string;
  color: string;
  /** Native short-form vertical video vs. feed/text-first — shapes the plan. */
  medium: "vertical_video" | "long_video" | "text_social";
  /** Sensible default posts-per-week when planning cadence for this surface. */
  defaultPerWeek: number;
};

export const PLATFORMS: Record<PlatformKey, PlatformMeta> = {
  youtube: { key: "youtube", label: "YouTube", color: "#ff4e45", medium: "long_video", defaultPerWeek: 2 },
  instagram: { key: "instagram", label: "Instagram", color: "#e1306c", medium: "vertical_video", defaultPerWeek: 5 },
  tiktok: { key: "tiktok", label: "TikTok", color: "#25f4ee", medium: "vertical_video", defaultPerWeek: 6 },
  x: { key: "x", label: "X", color: "#e7e9ea", medium: "text_social", defaultPerWeek: 5 },
  linkedin: { key: "linkedin", label: "LinkedIn", color: "#0a66c2", medium: "text_social", defaultPerWeek: 3 },
  telegram: { key: "telegram", label: "Telegram", color: "#29a9eb", medium: "text_social", defaultPerWeek: 4 },
};

/* Normalize the free-text socials on a ChannelDNA into canonical platform keys. */
export function channelPlatforms(c: ChannelDNA): PlatformMeta[] {
  const raw = c.socials?.length ? c.socials : ["Instagram", "X"];
  const seen = new Set<PlatformKey>();
  const out: PlatformMeta[] = [];
  for (const s of raw) {
    const k = canonPlatform(s);
    if (k && !seen.has(k)) {
      seen.add(k);
      out.push(PLATFORMS[k]);
    }
  }
  return out.length ? out : [PLATFORMS.instagram, PLATFORMS.x];
}

function canonPlatform(s: string): PlatformKey | null {
  const t = s.trim().toLowerCase();
  if (/youtube|yt\b|shorts/.test(t)) return "youtube";
  if (/instagram|insta|\big\b|reels?/.test(t)) return "instagram";
  if (/tiktok|tik tok/.test(t)) return "tiktok";
  if (/^x$|twitter|x\.com/.test(t)) return "x";
  if (/linkedin/.test(t)) return "linkedin";
  if (/telegram/.test(t)) return "telegram";
  return null;
}

/* ── Step events (the visualization feed) ────────────────────────────────── */
export type StepKind =
  | "init"
  | "search"
  | "signals"
  | "playbook"
  | "brief" // deep channel + topic research
  | "subject" // subject-specific hook/caption/CTA/comment/post-type playbook
  | "cadence" // per-cluster posting frequency
  | "ideate"
  | "schedule"
  | "done"
  | "error";
export type ResearchStep = {
  id: string;
  kind: StepKind;
  /** Short headline rendered in the timeline. */
  label: string;
  /** Optional longer description / status detail. */
  detail?: string;
  platform?: PlatformKey;
  /** Arbitrary structured payload the UI can render (sources, signals, etc.). */
  data?: unknown;
  at: string;
};
export type OnStep = (s: ResearchStep) => void | Promise<void>;

let _seq = 0;
const step = (s: Omit<ResearchStep, "id" | "at">): ResearchStep => ({
  ...s,
  id: `s${++_seq}`,
  at: new Date().toISOString(),
});

/* ── The per-platform algorithm playbook ─────────────────────────────────── */
// Models often return objects/numbers where we want a string (e.g. a lever as
// {lever, why}). Coerce gracefully so a good answer never fails validation.
const fStr = z.preprocess((v) => {
  if (typeof v === "string") return v;
  if (v && typeof v === "object") return Object.values(v).filter((x) => typeof x === "string" || typeof x === "number").join(" — ");
  return v == null ? "" : String(v);
}, z.string());
const fStrArr = z.array(fStr).transform((a) => a.filter((s) => s.trim().length));
const fWeight = z.preprocess((v) => {
  const s = String(v ?? "").toLowerCase();
  if (/decis|critical|primary|top/.test(s)) return "decisive";
  if (/high|major|strong/.test(s)) return "high";
  return "medium";
}, z.enum(["decisive", "high", "medium"]));
const fLen = z.preprocess((v) => {
  const n = typeof v === "number" ? v : parseInt(String(v ?? "").replace(/[^0-9]/g, ""), 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}, z.number().int().positive().optional());

const RankingSignal = z.object({
  signal: fStr, // e.g. "watch-time / average view duration"
  weight: fWeight,
  howToHack: fStr, // a concrete production move that pushes this signal
});
export type RankingSignal = z.infer<typeof RankingSignal>;

const PlatformPlaybook = z.object({
  rankingSignals: z.array(RankingSignal).min(1),
  postingCadence: fStr, // human note: how often / when wins here
  optimalLengthSec: fLen,
  formatLevers: fStrArr, // structural moves that win on this platform
  hookPatterns: fStrArr, // opening patterns proven on this platform
  doNow: fStrArr, // specific, immediately-actionable plays
});
export type PlatformPlaybook = z.infer<typeof PlatformPlaybook>;

export type PlatformResearch = {
  platform: PlatformKey;
  playbook: PlatformPlaybook;
  sources: { title: string; url: string }[];
};

/* ── Channel + topic deep research (the strategy brief) ───────────────────── */
const NamedWhy = z.object({ name: fStr, why: fStr });
const ChannelBrief = z.object({
  audienceProfile: fStr, // who the audience is + what they actually want
  audienceInsights: fStrArr, // 3-6 specific, non-obvious truths about this audience
  nicheLandscape: fStr, // the competitive/content landscape right now
  topAccounts: z.array(NamedWhy).default([]), // accounts/creators winning in this niche + why
  contentGaps: fStrArr, // underserved angles / whitespace opportunities
  bestSubtopics: fStrArr, // the highest-potential subtopics to focus on
  positioning: fStr, // how THIS channel should position vs the field
});
export type ChannelBrief = z.infer<typeof ChannelBrief>;

/* ── Subject-specific content playbook (what ELEMENTS win for this subject) ── */
const SubjectPlaybook = z.object({
  winningHooks: fStrArr, // hook patterns that work for THIS subject (not generic)
  bestPostTypes: z.array(NamedWhy).default([]), // post/format types that perform for this subject
  captionStyle: fStr, // how captions should read for this subject
  captionExamples: fStrArr, // 2-4 ready-to-use example captions
  ctaPatterns: fStrArr, // CTAs that convert for this subject + audience
  commentStrategy: fStrArr, // pinned-comment / reply tactics that grow this niche
  engagementPrompts: fStrArr, // question/prompt patterns that drive meaningful comments
});
export type SubjectPlaybook = z.infer<typeof SubjectPlaybook>;

/* ── Per-cluster cadence (how often each content category should post) ─────── */
const fNum = z.preprocess((v) => {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? "").replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) ? n : 0;
}, z.number());
const ClusterCadence = z.object({
  clusters: z.array(
    z.object({
      mood: fStr, // the content cluster (mood id)
      postsPerWeek: fNum, // recommended posts per week for this cluster
      bestPlatforms: fStrArr, // which platforms this cluster fits best
      bestPostType: fStr, // the format that works best for this cluster
      rationale: fStr,
    }),
  ),
});
export type ClusterCadence = z.infer<typeof ClusterCadence>;

/* ── A single planned, dated post ────────────────────────────────────────── */
export type PlannedPost = {
  id: string;
  date: string; // YYYY-MM-DD
  time: string; // HH:MM
  channel: string;
  platform: PlatformKey;
  topic: string;
  angle: string;
  format: string;
  mood?: string;
  hook?: string;
  rationale: string;
  /** Which algorithm lever from the playbook this idea is built to exploit. */
  algoLever?: string;
  scores?: Record<string, number>;
  overall?: number;
  status: "idea" | "approved" | "scheduled" | "generated" | "dropped" | "archived";
  planRunId: string;
  createdAt: string;
  updatedAt?: string;
  /** Tenancy: which workspace owns this post and which user authored it. */
  workspaceId?: string;
  createdBy?: string;
  /** Clerk user id of the teammate this post is assigned to (optional). */
  assignee?: string;
  /** Admin sign-off gate (Calendar Admin). Absent = not yet gated (legacy/auto). Only an 'approved' post may be promoted to status 'scheduled' / enter the autopilot queue. Written ONLY by setApprovalField — never via plan_update/EDITABLE. */
  approval?: { status: "pending" | "approved" | "rejected"; by: string; at: string };
};

export type AlgoPlanResult = {
  channel: string;
  channelName: string;
  planRunId: string;
  brief?: ChannelBrief; // deep channel + topic research
  subject?: SubjectPlaybook; // subject-specific hook/caption/CTA/comment playbook
  cadence?: ClusterCadence; // per-cluster posting frequency
  platforms: PlatformResearch[];
  posts: PlannedPost[];
  sources: { title: string; url: string }[];
  usd: number;
};

export type PlanOptions = {
  /** How many days forward to spread the plan across. Default 14. */
  days?: number;
  /** Total posts to plan across all platforms. Default: derived from cadence. */
  count?: number;
  /** Restrict to a subset of the channel's platforms (canonical keys). */
  onlyPlatforms?: PlatformKey[];
  /** Default time-of-day for planned slots. */
  time?: string;
  /** Tenancy: stamp every planned post with this workspace + author. */
  workspaceId?: string;
  createdBy?: string;
};

const dna = (c: ChannelDNA) =>
  `CHANNEL: ${c.name}\naudience: ${c.audience}${c.domain ? `\nDOMAIN (stay strictly inside this): ${c.domain}` : ""}\ntone: ${c.tone}\nbanned: ${c.bannedPatterns.join(", ")}`;

/* Research one platform's algorithm for this channel's niche. Two live searches
   (how the algo ranks + what's winning in the niche) feed a structured playbook. */
async function researchPlatform(
  c: ChannelDNA,
  pm: PlatformMeta,
  onStep: OnStep,
): Promise<{ research: PlatformResearch; usd: number }> {
  const year = new Date().getFullYear();
  const niche = (c.domain ?? c.audience).slice(0, 120);
  const qAlgo = `${pm.label} algorithm ranking signals how to grow ${year}`;
  const qNiche = `viral ${pm.label} ${niche} format hook ${year}`;

  // §2 research harness: one cached/verified research run per platform replaces
  // the two raw searches. CACHE KEY DISCIPLINE: the query string must be
  // `${pm.key} algorithm ranking signals` (niche differentiation comes from the
  // channel arg in the hash) because dna.ts evolveGenome looks up exactly
  // "<platform> algorithm ranking signals" @72h for the same channel.
  let researchRunId: string | undefined;
  let sources: { title: string; url: string }[] = [];
  let ctx = "";
  try {
    const cacheQ = `${pm.key} algorithm ranking signals`;
    const run = findFresh("algo", cacheQ, 72, c.id) ?? (await runResearch({ kind: "algo", query: cacheQ, channel: c.id, depth: "standard" }, onStep));
    researchRunId = run.id;
    sources = run.sources.map((s) => ({ title: s.title, url: s.url }));
    ctx = (run.report ?? "").slice(0, 6000);
  } catch {
    /* harness down → legacy raw-search path below */
  }
  if (!ctx) {
    await onStep(step({ kind: "search", platform: pm.key, label: `Searching ${pm.label} algorithm`, detail: qAlgo }));
    const algoHits = safeSearch(qAlgo, 5);
    await onStep(step({ kind: "search", platform: pm.key, label: `Searching ${pm.label} niche winners`, detail: qNiche, data: { results: trim(algoHits) } }));
    const nicheHits = safeSearch(qNiche, 5);
    sources = [...algoHits, ...nicheHits].filter((r) => r.url).slice(0, 8).map((r) => ({ title: r.title, url: r.url }));
    ctx = [ctxBlock(qAlgo, algoHits), ctxBlock(qNiche, nicheHits)].filter(Boolean).join("\n\n");
  }

  await onStep(step({ kind: "signals", platform: pm.key, label: `Distilling ${pm.label} ranking signals`, detail: "Synthesizing playbook from live results" }));

  const prompt =
    `You are a short-form growth strategist reverse-engineering the ${pm.label} algorithm for a faceless brand.\n` +
    `${dna(c)}\nPLATFORM: ${pm.label} (${pm.medium.replace("_", " ")}).\n` +
    `${ctx ? `LIVE WEB CONTEXT (ground every claim in these real, current results):\n${ctx}\n\n` : ""}` +
    `Produce a concrete, current ${pm.label} "algorithm playbook" for THIS channel's niche:\n` +
    `- rankingSignals: the 3-5 signals ${pm.label} actually optimizes for right now, each with weight ` +
    `(decisive|high|medium) and a SPECIFIC production move that pushes it (howToHack).\n` +
    `- postingCadence: how often + when posting wins on ${pm.label} for this niche.\n` +
    `- optimalLengthSec: ideal content length in seconds (omit for text platforms).\n` +
    `- formatLevers: 3-5 structural moves that win on ${pm.label}.\n` +
    `- hookPatterns: 3-5 opening patterns proven on ${pm.label}.\n` +
    `- doNow: 2-4 immediately-actionable plays for this channel on ${pm.label}.\n` +
    `Be specific and current. No generic advice. Return ONLY JSON matching that shape.`;

  try {
    const r = await think(PlatformPlaybook, prompt, "smart", 2, "platform_playbook");
    // §2: persist the playbook onto the brand genome with research provenance.
    try {
      const g = getGenome(c.id);
      const pb = {
        platform: pm.key,
        cadence: r.data.postingCadence,
        levers: [...r.data.formatLevers, ...r.data.doNow].slice(0, 10),
        updatedAt: new Date().toISOString(),
        researchId: researchRunId,
      };
      const i = g.platformPlaybooks.findIndex((x) => x.platform === pm.key);
      if (i >= 0) g.platformPlaybooks[i] = pb;
      else g.platformPlaybooks.push(pb);
      saveGenome(g);
    } catch { /* genome unavailable — the playbook is still returned to the plan */ }
    await onStep(step({ kind: "playbook", platform: pm.key, label: `${pm.label} playbook ready`, detail: `${r.data.rankingSignals.length} ranking signals, ${r.data.doNow.length} plays`, data: { playbook: r.data, sources } }));
    return { research: { platform: pm.key, playbook: r.data, sources }, usd: r.usd };
  } catch (e) {
    const playbook = fallbackPlaybook(pm);
    await onStep(step({ kind: "playbook", platform: pm.key, label: `${pm.label} playbook (fallback)`, detail: `Brain unavailable (${String(e).slice(0, 80)}) — used baseline`, data: { playbook, sources } }));
    return { research: { platform: pm.key, playbook, sources }, usd: 0 };
  }
}

/* Build a compact playbook context block to steer ideation toward levers. */
function playbookContext(pr: PlatformResearch[]): string {
  return pr
    .map((p) => {
      const pm = PLATFORMS[p.platform];
      const sig = p.playbook.rankingSignals.map((s) => `${s.signal} [${s.weight}]: ${s.howToHack}`).join("; ");
      return `${pm.label} → signals: ${sig}\n  levers: ${p.playbook.formatLevers.join(", ")}\n  hooks: ${p.playbook.hookPatterns.join(" | ")}`;
    })
    .join("\n");
}

/* ── Deep channel + topic research → a strategy brief ─────────────────────── */
async function researchChannelBrief(c: ChannelDNA, onStep: OnStep): Promise<{ brief?: ChannelBrief; sources: { title: string; url: string }[]; usd: number }> {
  const year = new Date().getFullYear();
  const niche = (c.domain ?? c.audience).slice(0, 120);
  const qAudience = `${niche} audience interests what they want ${year}`;
  const qLandscape = `best ${niche} creators accounts content ${year}`;
  const qGaps = `${niche} underserved content gaps untapped angles ${year}`;

  await onStep(step({ kind: "search", label: `Researching the audience`, detail: qAudience }));
  const aHits = safeSearch(qAudience, 5);
  await onStep(step({ kind: "search", label: `Mapping the niche landscape`, detail: qLandscape, data: { results: trim(aHits) } }));
  const lHits = safeSearch(qLandscape, 5);
  await onStep(step({ kind: "search", label: `Hunting content gaps`, detail: qGaps }));
  const gHits = safeSearch(qGaps, 4);

  const sources = [...aHits, ...lHits, ...gHits].filter((r) => r.url).slice(0, 8).map((r) => ({ title: r.title, url: r.url }));
  const ctx = [ctxBlock(qAudience, aHits), ctxBlock(qLandscape, lHits), ctxBlock(qGaps, gHits)].filter(Boolean).join("\n\n");

  await onStep(step({ kind: "brief", label: "Building the channel brief", detail: "Audience, landscape, gaps, positioning" }));
  const prompt =
    `You are a content strategist building a deep brief for a faceless brand before planning its content.\n${dna(c)}\n` +
    `${ctx ? `LIVE WEB CONTEXT (ground every claim in these real, current results):\n${ctx}\n\n` : ""}` +
    `Produce a sharp, specific strategy brief for THIS channel's subject. Be concrete — no platitudes.\n` +
    `- audienceProfile: who the audience really is + what they actually want from this content.\n` +
    `- audienceInsights: 3-6 NON-OBVIOUS truths about this audience that should shape the content.\n` +
    `- nicheLandscape: the current competitive/content landscape in this niche, honestly.\n` +
    `- topAccounts: 3-6 real accounts/creators winning in this niche, each with WHY they win.\n` +
    `- contentGaps: 3-6 underserved angles / whitespace this channel could own.\n` +
    `- bestSubtopics: 4-8 highest-potential subtopics to focus on first.\n` +
    `- positioning: one sharp sentence on how THIS channel should position vs the field.\n` +
    `Return ONLY JSON matching that shape.`;
  try {
    const r = await think(ChannelBrief, prompt, "best", 2, "channel_brief");
    await onStep(step({ kind: "brief", label: "Channel brief ready", detail: `${r.data.audienceInsights.length} insights, ${r.data.contentGaps.length} gaps`, data: { brief: r.data, sources } }));
    return { brief: r.data, sources, usd: r.usd };
  } catch (e) {
    await onStep(step({ kind: "error", label: "Brief degraded", detail: String(e).slice(0, 120) }));
    return { sources, usd: 0 };
  }
}

/* ── Subject playbook: what hooks/captions/CTAs/comments/post-types win HERE ─ */
async function researchSubjectPlaybook(c: ChannelDNA, research: PlatformResearch[], brief: ChannelBrief | undefined, onStep: OnStep): Promise<{ subject?: SubjectPlaybook; usd: number }> {
  await onStep(step({ kind: "subject", label: "Engineering the subject playbook", detail: "Hooks, captions, CTAs, comments, post-types" }));
  const platformCtx = playbookContext(research);
  const briefCtx = brief ? `CHANNEL BRIEF:\n- audience: ${brief.audienceProfile}\n- insights: ${brief.audienceInsights.join("; ")}\n- gaps: ${brief.contentGaps.join("; ")}` : "";
  const prompt =
    `You are the content lead for a faceless brand. Design the SUBJECT-SPECIFIC playbook — the hooks,\n` +
    `captions, CTAs, comments, and post-types that actually perform for THIS subject and audience\n` +
    `(not generic platform advice).\n${dna(c)}\n` +
    `${briefCtx ? briefCtx + "\n\n" : ""}${platformCtx ? `PLATFORM ALGORITHM LEVERS:\n${platformCtx}\n\n` : ""}` +
    `- winningHooks: 5-8 hook openings proven to work for THIS subject (concrete templates, fill-in-the-blank).\n` +
    `- bestPostTypes: 3-5 post/format types that perform best for this subject, each with WHY.\n` +
    `- captionStyle: how captions should read for this subject (length, voice, structure).\n` +
    `- captionExamples: 2-4 ready-to-post example captions in this channel's voice.\n` +
    `- ctaPatterns: 4-6 CTAs that convert for THIS audience (save/share/follow/comment drivers).\n` +
    `- commentStrategy: 3-5 pinned-comment / reply tactics that grow this niche.\n` +
    `- engagementPrompts: 3-5 question/prompt patterns that drive MEANINGFUL comments (not "what do you think?").\n` +
    `Return ONLY JSON matching that shape.`;
  try {
    const r = await think(SubjectPlaybook, prompt, "best", 2, "subject_playbook");
    await onStep(step({ kind: "subject", label: "Subject playbook ready", detail: `${r.data.winningHooks.length} hooks, ${r.data.ctaPatterns.length} CTAs`, data: { subject: r.data } }));
    return { subject: r.data, usd: r.usd };
  } catch (e) {
    await onStep(step({ kind: "error", label: "Subject playbook degraded", detail: String(e).slice(0, 120) }));
    return { usd: 0 };
  }
}

/* ── Per-cluster cadence: how often each content category should post ──────── */
async function planClusterCadence(c: ChannelDNA, platforms: PlatformMeta[], onStep: OnStep): Promise<{ cadence?: ClusterCadence; usd: number }> {
  const clusters = channelMoods(c);
  if (clusters.length <= 1) return { usd: 0 }; // nothing to differentiate
  await onStep(step({ kind: "cadence", label: "Tuning per-category cadence", detail: "How often each cluster should post" }));
  const clusterList = clusters.map((m) => `- ${m.id}${m.domain ? `: ${m.domain.slice(0, 120)}` : ""}`).join("\n");
  const platformList = platforms.map((p) => `${p.label} (${p.medium.replace("_", " ")}, ~${p.defaultPerWeek}/wk)`).join(", ");
  const prompt =
    `You are planning posting cadence for a faceless brand across content CLUSTERS (categories).\n${dna(c)}\n` +
    `PLATFORMS: ${platformList}.\nCONTENT CLUSTERS:\n${clusterList}\n\n` +
    `For EACH cluster, recommend how to weight it. Consider audience demand + how well each cluster\n` +
    `fits each platform. Total weekly volume should be realistic for a faceless operation.\n` +
    `For each cluster return: mood (the id), postsPerWeek (number), bestPlatforms (which platforms it\n` +
    `fits), bestPostType (the format that works for it), rationale (one line).\n` +
    `Return ONLY JSON: {"clusters":[{"mood","postsPerWeek","bestPlatforms":[...],"bestPostType","rationale"}]}`;
  try {
    const r = await think(ClusterCadence, prompt, "smart", 2, "cluster_cadence");
    await onStep(step({ kind: "cadence", label: "Cadence plan ready", detail: `${r.data.clusters.length} clusters weighted`, data: { cadence: r.data } }));
    return { cadence: r.data, usd: r.usd };
  } catch (e) {
    await onStep(step({ kind: "error", label: "Cadence degraded", detail: String(e).slice(0, 120) }));
    return { usd: 0 };
  }
}

/* The full pipeline: research every platform, then plan a dated slate. */
export async function runAlgoPlan(channelId: string, opts: PlanOptions = {}, onStep: OnStep = () => {}): Promise<AlgoPlanResult> {
  const c = resolveChannel(channelId);
  const planRunId = `plan_${new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14)}`;
  let allPlatforms = channelPlatforms(c);
  if (opts.onlyPlatforms?.length) allPlatforms = allPlatforms.filter((p) => opts.onlyPlatforms!.includes(p.key));
  if (!allPlatforms.length) allPlatforms = [PLATFORMS.instagram];

  await onStep(step({ kind: "init", label: `Planning ${c.name}`, detail: `${allPlatforms.length} platform(s): ${allPlatforms.map((p) => p.label).join(", ")}`, data: { channel: c.id, channelName: c.name, platforms: allPlatforms } }));

  let usd = 0;

  // ── Phase 1: deep channel + topic research → the strategy brief ──
  const briefR = await researchChannelBrief(c, onStep);
  usd += briefR.usd;

  // ── Phase 2: per-platform algorithm playbooks ──
  const research: PlatformResearch[] = [];
  for (const pm of allPlatforms) {
    const r = await researchPlatform(c, pm, onStep);
    research.push(r.research);
    usd += r.usd;
  }

  // ── Phase 3: subject-specific playbook (hooks/captions/CTAs/comments/types) ──
  const subjR = await researchSubjectPlaybook(c, research, briefR.brief, onStep);
  usd += subjR.usd;

  // ── Phase 4: per-cluster cadence ──
  const cadR = await planClusterCadence(c, allPlatforms, onStep);
  usd += cadR.usd;

  // ── Phase 5: ideation — a scored concept slate, steered by ALL the research ──
  await onStep(step({ kind: "ideate", label: "Generating concept slate", detail: "Scoring ideas against the research + algorithm playbooks" }));
  const days = Math.max(1, opts.days ?? 14);
  const weeks = days / 7;
  const cadenceCount = Math.round(allPlatforms.reduce((sum, p) => sum + p.defaultPerWeek * weeks, 0));
  const count = Math.min(40, Math.max(allPlatforms.length, opts.count ?? cadenceCount));

  const briefSteer = briefR.brief
    ? `CHANNEL RESEARCH (ground concepts in these gaps + subtopics):\n- content gaps to own: ${briefR.brief.contentGaps.join("; ")}\n- best subtopics: ${briefR.brief.bestSubtopics.join("; ")}\n- audience insights: ${briefR.brief.audienceInsights.slice(0, 4).join("; ")}`
    : "";
  const hookSteer = subjR.subject?.winningHooks?.length ? `PROVEN HOOK PATTERNS for this subject (use these shapes):\n${subjR.subject.winningHooks.join(" | ")}` : "";
  let context = [getLearnings(c.id), genomeContextSafe(c.id)].filter(Boolean).join("\n\n");
  context = [context, briefSteer, hookSteer, `ALGORITHM PLAYBOOKS (engineer every concept to exploit one named lever below):\n${playbookContext(research)}`].filter(Boolean).join("\n\n");

  let concepts: Concept[] = [];
  try {
    const r = await proposeConcepts(c, context, count, avoidListForChannel(c.id));
    usd += r.usd;
    concepts = r.data.concepts;
  } catch (e) {
    await onStep(step({ kind: "error", label: "Ideation degraded", detail: String(e).slice(0, 120) }));
    concepts = buildFallbackConcepts(c, count);
  }
  await onStep(step({ kind: "ideate", label: `${concepts.length} concepts scored`, detail: "Top picks lead the schedule", data: { concepts: concepts.slice(0, 12) } }));

  // ── Schedule: spread concepts across platforms × upcoming days ──
  const posts = scheduleConcepts(c, concepts, research, planRunId, opts);
  await onStep(step({ kind: "schedule", label: `${posts.length} posts placed on the calendar`, detail: `Across ${days} days, ${allPlatforms.length} platform(s)`, data: { posts } }));

  const sources = dedupeSources([...research.flatMap((r) => r.sources), ...briefR.sources]);
  await onStep(step({ kind: "done", label: "Plan ready", detail: `${posts.length} posts · $${usd.toFixed(3)}`, data: { planRunId, count: posts.length } }));

  return { channel: c.id, channelName: c.name, planRunId, brief: briefR.brief, subject: subjR.subject, cadence: cadR.cadence, platforms: research, posts, sources, usd };
}

/* Round-robin scored concepts onto platforms (best concepts → highest-cadence
   platform first), lay them on upcoming days at a steady drip, and attach the
   algo lever each idea is built to exploit on its destination platform. */
function scheduleConcepts(
  c: ChannelDNA,
  concepts: Concept[],
  research: PlatformResearch[],
  planRunId: string,
  opts: PlanOptions,
): PlannedPost[] {
  const ranked = [...concepts].sort((a, b) => b.overall - a.overall);
  if (!ranked.length || !research.length) return [];
  const days = Math.max(1, opts.days ?? 14);
  const time = /^\d{2}:\d{2}$/.test(opts.time ?? "") ? opts.time! : "09:00";

  // Weight platforms by cadence so busier surfaces get proportionally more posts.
  const weighted: PlatformResearch[] = [];
  for (const r of research) {
    const reps = Math.max(1, Math.round(PLATFORMS[r.platform].defaultPerWeek / 2));
    for (let i = 0; i < reps; i++) weighted.push(r);
  }

  const base = startOfTomorrow();
  const perPlatformCount: Record<string, number> = {};
  return ranked.map((concept, i) => {
    const pr = weighted[i % weighted.length];
    const pm = PLATFORMS[pr.platform];
    const n = (perPlatformCount[pr.platform] = (perPlatformCount[pr.platform] ?? 0) + 1);
    // Drip this platform's posts evenly across the window.
    const dayOffset = Math.min(days - 1, Math.round((n - 1) * (days / Math.max(1, Math.ceil(ranked.length / weighted.length)))));
    const date = ymd(new Date(base.getTime() + dayOffset * 86_400_000));
    const lever = pr.playbook.rankingSignals[0]?.signal || pr.playbook.formatLevers[0];
    return {
      id: `${planRunId}_${i}`,
      date,
      time,
      channel: c.id,
      platform: pr.platform,
      topic: concept.topic,
      angle: concept.angle,
      format: concept.format,
      mood: concept.mood,
      rationale: concept.rationale,
      algoLever: lever,
      scores: concept.scores,
      overall: concept.overall,
      status: "idea" as const,
      planRunId,
      createdAt: new Date().toISOString(),
      workspaceId: opts.workspaceId || DEFAULT_WORKSPACE,
      ...(opts.createdBy ? { createdBy: opts.createdBy } : {}),
    };
  });
}

function startOfTomorrow(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return new Date(d.getTime() + 86_400_000);
}
function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function dedupeSources(list: { title: string; url: string }[]): { title: string; url: string }[] {
  const seen = new Set<string>();
  return list.filter((s) => s.url && !seen.has(s.url) && seen.add(s.url)).slice(0, 16);
}

/* ── helpers ─────────────────────────────────────────────────────────────── */
function safeSearch(q: string, n: number): SearchResult[] {
  try {
    return webSearch(q, n);
  } catch {
    return [];
  }
}
function trim(rs: SearchResult[]) {
  return rs.slice(0, 5).map((r) => ({ title: r.title, url: r.url, description: r.description.slice(0, 160) }));
}
function ctxBlock(q: string, rs: SearchResult[]): string {
  if (!rs.length) return "";
  return `SEARCH ("${q}"):\n` + rs.map((r, i) => `${i + 1}. ${r.title} — ${r.description.slice(0, 180)} [${r.url}]`).join("\n");
}

function fallbackPlaybook(pm: PlatformMeta): PlatformPlaybook {
  const vid = pm.medium !== "text_social";
  return {
    rankingSignals: [
      { signal: vid ? "average watch time / retention" : "early engagement velocity", weight: "decisive", howToHack: vid ? "Front-load the payoff; cut dead air in the first 2 seconds." : "Open with a stance that invites replies within the first hour." },
      { signal: "completion / save rate", weight: "high", howToHack: "End on a loop or a concrete takeaway worth saving." },
      { signal: "shares", weight: "high", howToHack: "Make one line quotable enough to send to a friend." },
    ],
    postingCadence: `${pm.defaultPerWeek}× per week, consistent times`,
    optimalLengthSec: vid ? (pm.medium === "long_video" ? 480 : 30) : undefined,
    formatLevers: vid ? ["pattern-interrupt hook", "one idea per scene", "text-on-screen reinforcement"] : ["strong first line", "numbered structure", "one image or chart"],
    hookPatterns: ["The real reason X", "What nobody tells you about X", "Stop doing X"],
    doNow: ["Lead with the most surprising fact.", "Cut the intro — start mid-action."],
  };
}

/* Deterministic offline slate so a plan still lands when the brain is down. */
function buildFallbackConcepts(c: ChannelDNA, n: number): Concept[] {
  const moods = channelMoods(c);
  const fmt = ((c.formats && c.formats[0]) || "before_after") as Concept["format"];
  return Array.from({ length: n }, (_, i) => {
    const m = moods[i % moods.length];
    return {
      topic: `${c.name} idea ${i + 1}`,
      angle: `A specific, concrete take inside ${c.name}'s domain.`,
      format: fmt,
      rationale: "Baseline concept (brain unavailable).",
      scores: { hook_potential: 6, trend_fit: 6, novelty: 6, channel_fit: 7, retention: 6 },
      overall: 6.2,
      mood: m.id,
    };
  });
}
