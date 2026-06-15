import { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
  BrandGenome,
  PlatformPlaybook,
  type GenomeMutation,
  type GenomeTrait,
  type PendingMutation,
  type ChannelDNA,
  type ResearchRun,
  type MemoryRecord,
} from "@os/schemas";
import { DATA_DIR, ensureDir, listItems, nowIso } from "./store.ts";
import { resolveChannel, channelMoods } from "./channels.ts";
import { getLearnings, channelScorecard, type ChannelScorecard } from "./learnings.ts";
import { think, type BrainTier } from "./brain.ts";
import { findFresh } from "./research/store.ts";
import { getMemoryProvider } from "./memory/index.ts";

/* The Brand Genome — persistent, evolving DNA per channel.

   The static ChannelDNA in data/brands.json is the *base genome*: hand-authored
   identity (tone, hooks, formats). This module layers LEARNED traits on top —
   what actually works, weighted by evidence — and persists them per channel at
   data/dna/<channel>.json. The genome only mutates with a recorded cause +
   evidence (analytics, research, QA verdicts); high-impact / low-confidence
   mutations queue in `pending` for human approval instead of auto-applying.

   Why a separate file per channel (vs one registry): genomes are written by an
   autonomous evolution loop AND read by every prompt-injection site — per-file
   atomic writes (tmp + rename) mean a crashed evolve run can never corrupt
   another channel's DNA. */

const DNA_DIR = join(DATA_DIR, "dna");

/* Channel ids come from tool input at the boundary — sanitize so a hostile
   "../../x" can never escape data/dna/. */
const safeName = (channel: string) => channel.replace(/[^a-zA-Z0-9._-]/g, "_");

export function genomePath(channel: string): string {
  return join(DNA_DIR, `${safeName(channel)}.json`);
}

/* ─── Trait paths ──────────────────────────────────────────────────────────
   Mutations address traits by dotted path ("traits.hooks", "audienceModel.
   summary", "platformPlaybooks"). Keeping the vocabulary closed makes patches
   machine-applicable and lock checks trivial. */

export const TRAIT_BUCKETS = ["hooks", "topics", "formats", "visual", "voice"] as const;
export type TraitBucket = (typeof TRAIT_BUCKETS)[number];

const TRAIT_PATHS = TRAIT_BUCKETS.map((b) => `traits.${b}`);
const ALL_PATHS = [...TRAIT_PATHS, "audienceModel.summary", "platformPlaybooks"];

/* The machine-applicable patch payload carried in PendingMutation.apply (the
   spec keeps that field z.unknown() so the schema stays patch-format agnostic;
   THIS is the engine's concrete format, validated again at apply time). */
export const ApplyPatch = z.object({
  op: z.enum(["upsert", "reweight", "remove"]),
  path: z.string(),
  value: z.string(),
  weight: z.number().min(0).max(1).optional(),
  evidence: z.array(z.string()).optional(),
});
export type ApplyPatch = z.infer<typeof ApplyPatch>;

/* ─── Raw learnings access ─────────────────────────────────────────────────
   learnings.ts only exports the prompt-formatted string; the genome needs the
   raw wins/avoid arrays (wins seed evidence-backed traits, avoids feed the
   context's avoid-list). Read the documented file format directly rather than
   widening learnings.ts' API (write-new-files-only constraint). */
function rawLearnings(channel: string): { wins: string[]; avoid: string[] } {
  try {
    const j = JSON.parse(readFileSync(join(DATA_DIR, "learnings.json"), "utf8")) as Record<
      string,
      { wins?: string[]; avoid?: string[] }
    >;
    return { wins: j?.[channel]?.wins ?? [], avoid: j?.[channel]?.avoid ?? [] };
  } catch {
    return { wins: [], avoid: [] }; // no learnings yet — seed from DNA alone
  }
}

/* ─── Seeding ──────────────────────────────────────────────────────────────
   First read for a channel builds the genome from what we already know:
   ChannelDNA preferences (weight .6 — trusted but unproven) and learnings.json
   wins (weight .7 — performance-backed, routed to the bucket the note is
   about). Weights are affinities, not probabilities: evolution re-weights. */
function seedGenome(channel: string, ws?: string): BrandGenome {
  const c: ChannelDNA = resolveChannel(channel);
  const seed = (value: string, weight: number, why: string): GenomeTrait => ({
    value,
    weight,
    evidence: [why],
  });

  const hooks = (c.preferredHooks ?? []).map((h) => seed(h, 0.6, "seed: ChannelDNA.preferredHooks"));
  const topics = channelMoods(c)
    .map((m) => m.domain || m.id)
    .filter(Boolean)
    .map((t) => seed(t, 0.5, "seed: ChannelDNA mood clusters"));
  const formats = (c.formats ?? []).map((f) => seed(f, 0.5, "seed: ChannelDNA.formats"));
  const visual = [
    seed(c.visualStyle, 0.5, "seed: ChannelDNA.visualStyle"),
    ...(c.archetype ? [seed(c.archetype, 0.5, "seed: ChannelDNA.archetype")] : []),
  ];
  const voice = [seed(c.tone, 0.5, "seed: ChannelDNA.tone")];

  // Route each performance win to the bucket it describes. recordPerformance()
  // writes notes shaped 'format "x" + hook style "y" performed well' and
  // 'topic angle "z" resonated', so keyword routing is reliable here.
  const { wins } = rawLearnings(channel);
  for (const win of wins.slice(0, 8)) {
    const w = win.toLowerCase();
    const bucket: GenomeTrait[] = w.includes("hook") ? hooks : w.includes("format") ? formats : topics;
    if (!bucket.some((t) => t.value === win)) bucket.push(seed(win, 0.7, "seed: learnings.json win"));
  }

  return BrandGenome.parse({
    workspaceId: ws ?? c.workspaceId,
    createdBy: c.createdBy,
    channel,
    version: 1,
    updatedAt: nowIso(),
    traits: { hooks, topics, formats, visual, voice },
    audienceModel: { summary: c.audience, segments: [] },
    platformPlaybooks: [],
    evolution: [],
    pending: [],
    locks: [],
  });
}

/* ─── Storage ────────────────────────────────────────────────────────────── */

export function getGenome(channel: string, ws?: string): BrandGenome {
  const p = genomePath(channel);
  if (existsSync(p)) {
    try {
      return BrandGenome.parse(JSON.parse(readFileSync(p, "utf8")));
    } catch (e) {
      // Never silently clobber a corrupted genome with a fresh seed — the
      // evolution history is the valuable part. Surface the path so the
      // operator can inspect/repair.
      throw new Error(`genome file invalid at ${p}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  const seeded = seedGenome(channel, ws);
  try {
    saveGenome(seeded);
  } catch {
    /* read-only fs is fine — callers still get the in-memory seed */
  }
  return seeded;
}

/* Atomic write (tmp + rename — readers never see a torn file) with a version
   bump whenever the *learned substance* changed (traits, playbooks, audience).
   Bookkeeping-only saves (locks, pending queue moves) keep the version, so
   `version` stays a meaningful "how many times has this brand's DNA actually
   evolved" counter. */
export function saveGenome(genome: BrandGenome): BrandGenome {
  ensureDir(DNA_DIR);
  const p = genomePath(genome.channel);
  if (existsSync(p)) {
    try {
      const prev = JSON.parse(readFileSync(p, "utf8")) as BrandGenome;
      const changed =
        JSON.stringify(prev.traits) !== JSON.stringify(genome.traits) ||
        JSON.stringify(prev.platformPlaybooks) !== JSON.stringify(genome.platformPlaybooks) ||
        JSON.stringify(prev.audienceModel ?? null) !== JSON.stringify(genome.audienceModel ?? null);
      if (changed) genome.version = Math.max(genome.version, Number(prev.version) || 0) + 1;
    } catch {
      /* unreadable prior file — keep the incoming version */
    }
  }
  genome.updatedAt = nowIso();
  const valid = BrandGenome.parse(genome);
  const tmp = `${p}.tmp`;
  writeFileSync(tmp, JSON.stringify(valid, null, 2));
  renameSync(tmp, p);
  return valid;
}

/* ─── Prompt context ───────────────────────────────────────────────────────
   The compact markdown block prompt-injection sites (ideate/writeScript,
   selection, algo-research) embed. Hard-capped at 60 lines so the genome can
   grow without inflating every downstream prompt — only the top-weighted
   traits make the cut. */
export function genomeContext(channel: string): string {
  const g = getGenome(channel);
  const top = (traits: GenomeTrait[], n: number) =>
    [...traits]
      .sort((a, b) => b.weight - a.weight)
      .slice(0, n)
      .map((t) => `- "${t.value}" (w=${t.weight.toFixed(2)})`);

  const lines: string[] = [`## Brand Genome — ${channel} (v${g.version})`];
  if (g.audienceModel?.summary) lines.push(`Audience: ${g.audienceModel.summary}`);

  const section = (label: string, items: string[]) => {
    if (!items.length) return;
    lines.push(`${label}:`, ...items);
  };
  section("Hooks that work", top(g.traits.hooks, 5));
  section("Topic affinities", top(g.traits.topics, 5));
  section("Formats that work", top(g.traits.formats, 4));
  section("Visual direction", top(g.traits.visual, 3));
  section("Voice / delivery", top(g.traits.voice, 3));

  if (g.platformPlaybooks.length) {
    lines.push("Platform levers:");
    for (const pb of g.platformPlaybooks.slice(0, 5)) {
      const cadence = pb.cadence ? ` (cadence ${pb.cadence})` : "";
      lines.push(`- ${pb.platform}: ${pb.levers.slice(0, 3).join("; ")}${cadence}`);
    }
  }

  const { avoid } = rawLearnings(channel);
  if (avoid.length) {
    lines.push("Avoid (recent flops):", ...avoid.slice(0, 4).map((a) => `- ${a}`));
  }
  return lines.slice(0, 60).join("\n");
}

/* genomeContext that never throws — for prompt-injection sites (ideation,
   selection, algo plan) where a corrupted genome file must degrade to "no
   genome block", never break content generation. Tools/CLI keep the loud
   getGenome() throw so the operator still finds out. */
export function genomeContextSafe(channel: string): string {
  try {
    return genomeContext(channel);
  } catch {
    return "";
  }
}

/* ─── Patch application ──────────────────────────────────────────────────── */

const lockedPath = (g: BrandGenome, path: string) =>
  g.locks.some((l) => path === l || path.startsWith(`${l}.`));

const bucketFor = (path: string): TraitBucket | null => {
  const m = path.match(/^traits\.(\w+)$/);
  return m && (TRAIT_BUCKETS as readonly string[]).includes(m[1]) ? (m[1] as TraitBucket) : null;
};

/* Apply one validated patch in place. Trait buckets are kept weight-sorted and
   capped at 24 entries (the lowest-affinity tail falls off) so the genome can
   evolve indefinitely without unbounded growth. Throws on impossible patches
   so a bad brain proposal is rejected loudly instead of half-applied. */
function applyPatchToGenome(g: BrandGenome, patch: ApplyPatch): string {
  const bucket = bucketFor(patch.path);
  if (bucket) {
    const arr = g.traits[bucket];
    const i = arr.findIndex((t) => t.value.toLowerCase() === patch.value.toLowerCase());
    if (patch.op === "remove") {
      if (i < 0) throw new Error(`trait not found in ${patch.path}: "${patch.value}"`);
      arr.splice(i, 1);
      return `removed "${patch.value}" from ${patch.path}`;
    }
    if (patch.op === "reweight" && i >= 0) {
      if (patch.weight === undefined) throw new Error("reweight requires a weight");
      arr[i].weight = patch.weight;
      if (patch.evidence?.length) arr[i].evidence = [...new Set([...(arr[i].evidence ?? []), ...patch.evidence])];
    } else if (i >= 0) {
      // upsert onto an existing trait: refresh weight + merge evidence
      if (patch.weight !== undefined) arr[i].weight = patch.weight;
      if (patch.evidence?.length) arr[i].evidence = [...new Set([...(arr[i].evidence ?? []), ...patch.evidence])];
    } else {
      arr.push({ value: patch.value, weight: patch.weight ?? 0.6, evidence: patch.evidence });
    }
    arr.sort((a, b) => b.weight - a.weight);
    g.traits[bucket] = arr.slice(0, 24);
    return `${patch.op} "${patch.value}" (w=${(patch.weight ?? 0.6).toFixed(2)}) in ${patch.path}`;
  }

  if (patch.path === "audienceModel.summary") {
    g.audienceModel = { summary: patch.value, segments: g.audienceModel?.segments ?? [] };
    return "audience summary updated";
  }

  if (patch.path === "platformPlaybooks") {
    // value carries a full PlatformPlaybook as JSON — upsert by platform so
    // algo-research provenance (researchId) survives on the genome.
    const pb = PlatformPlaybook.parse(JSON.parse(patch.value));
    const i = g.platformPlaybooks.findIndex((x) => x.platform === pb.platform);
    if (i >= 0) g.platformPlaybooks[i] = pb;
    else g.platformPlaybooks.push(pb);
    return `playbook upserted for ${pb.platform}`;
  }

  throw new Error(`unknown mutation path "${patch.path}" (allowed: ${ALL_PATHS.join(", ")})`);
}

const newMutId = () => `mut_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

const logMutation = (g: BrandGenome, m: GenomeMutation) => {
  g.evolution = [m, ...g.evolution].slice(0, 100); // newest first, capped per spec
};

/* ─── Memory: recall (evidence in) + remember/learn (evidence out) ──────────
   The Brand Genome is backed by the pluggable memory provider (MEMORY_PROVIDER:
   local-json default · cogx/iCog · mem0 · obsidian — see docs/MEMORY-PROVIDERS).
   Evolution RECALLS accumulated outcomes as evidence, then REMEMBERS each applied
   mutation and emits a learn() signal of the post-performance that drove it — so
   the loop compounds across runs instead of being capped at learnings.json's
   window. This is what makes "it learns from its own post performance" literal.

   When MEMORY_PROVIDER=cogx (or auto with ICOG_API_KEY set) this preserves the
   old "mirror genome drift to iCog" behaviour exactly; on the local-json default
   the drift accrues locally and feeds the NEXT evolve's recall. Everything here
   is best-effort: a dead/missing backend never fails an evolve run. */

/** Pull accumulated channel memory to feed evolution as evidence. */
async function recallChannelMemory(channel: string): Promise<MemoryRecord[]> {
  try {
    return await getMemoryProvider().recall(
      `${channel}: which hooks, topics and formats performed well or flopped, and how the brand DNA has drifted`,
      { limit: 8, scope: { channelId: channel } },
    );
  } catch {
    return [];
  }
}

/** Persist an applied mutation as a durable, recallable fact. */
async function rememberMutation(channel: string, m: GenomeMutation): Promise<void> {
  try {
    await getMemoryProvider().remember({
      content: `[genome:${channel}] ${m.path}: ${m.mutation} (cause: ${m.cause})`,
      kind: "trait",
      scope: { channelId: channel },
    });
  } catch {
    /* best-effort — the genome file is the source of truth */
  }
}

/** Record the post-performance outcome that drove this evolution. Only cognitive
    backends (e.g. iCog) implement learn(); on others this is a no-op. */
async function learnFromOutcome(channel: string, applied: GenomeMutation[], scorecard: ChannelScorecard): Promise<void> {
  const mem = getMemoryProvider();
  if (!mem.learn || scorecard.posts < 1) return;
  const outcome = [
    `Channel ${channel}: evolved ${applied.length} genome trait(s) from ${scorecard.posts} measured post(s)`,
    `avg score ${scorecard.avgScore.toFixed(2)}, ${scorecard.totalViews} views, eng ${(scorecard.avgEngagementRate * 100).toFixed(1)}%`,
    scorecard.bestFormat ? `best format: ${scorecard.bestFormat.format}` : "",
    scorecard.worstFormat ? `weakest format: ${scorecard.worstFormat.format}` : "",
  ]
    .filter(Boolean)
    .join("; ");
  try {
    await mem.learn({ outcome, scope: { channelId: channel } });
  } catch {
    /* best-effort */
  }
}

/* ─── Evolution engine ─────────────────────────────────────────────────────
   Gather every learning signal we have → ask the smart brain for a small set
   of evidence-backed mutations → apply the confident ones (when policy allows
   and the path isn't locked), queue the rest for approval. */

export type EvolveOptions = {
  ws?: string;
  /** "auto" applies confident mutations; "gate" (default) queues everything. */
  approvalPolicy?: "auto" | "gate";
  tier?: BrainTier;
  maxMutations?: number;
};

export type EvolveResult = {
  genome: BrandGenome;
  applied: GenomeMutation[];
  queued: PendingMutation[];
  usd: number;
};

/* Fresh research evidence via the §2 research store. Imported statically — both
   modules ship together (missions.ts already pulls the research surface
   statically) so there's no need for a computed dynamic import. Runtime safety
   stays at the CALL site below (a missing/corrupt cache degrades to
   analytics-only signals), not at the import. */
async function freshResearch(
  channel: string,
  c: ChannelDNA,
): Promise<{ id: string; kind: string; query: string; excerpt: string }[]> {
  const platforms = (c.socials?.length ? c.socials : ["instagram", "youtube", "tiktok"]).map((p) =>
    p.toLowerCase(),
  );
  // Query shapes mirror the §2 consumers (algo playbooks @72h, trends @24h) so
  // evolve hits the same cache entries algo-research/scanTrends populate.
  const wanted: [kind: string, query: string, maxAgeH: number][] = [
    ...platforms.slice(0, 3).map((p): [string, string, number] => ["algo", `${p} algorithm ranking signals`, 72]),
    ["trend", `${c.domain ?? c.name} trends`, 24],
  ];
  const out: { id: string; kind: string; query: string; excerpt: string }[] = [];
  for (const [kind, query, maxAgeH] of wanted) {
    try {
      // kind is a plain string here (assembled above); findFresh narrows it to
      // the ResearchRun["kind"] union — a mismatched kind simply misses the cache.
      const run = findFresh(kind as ResearchRun["kind"], query, maxAgeH, channel);
      if (run?.report) out.push({ id: run.id, kind, query, excerpt: run.report.slice(0, 1200) });
    } catch {
      /* cache miss / store unavailable — fine */
    }
  }
  return out;
}

/* What the brain must return — local because it's the brain RESPONSE contract,
   not a persisted record (those live in @os/schemas). */
const EvolutionProposal = z.object({
  mutations: z
    .array(
      z.object({
        path: z.string(),
        mutation: z.string(),
        rationale: z.string(),
        confidence: z.number().min(0).max(1),
        apply: ApplyPatch,
      }),
    )
    .max(12),
});

export async function evolveGenome(channel: string, opts: EvolveOptions = {}): Promise<EvolveResult> {
  const policy = opts.approvalPolicy ?? "gate";
  const maxMutations = Math.max(1, Math.min(12, opts.maxMutations ?? 5));
  const c = resolveChannel(channel);
  const genome = getGenome(channel, opts.ws);

  // 1) Gather signals: learnings, scorecard, fresh research, recent QA verdicts.
  const learnings = getLearnings(channel);
  const scorecard = channelScorecard(channel);
  const research = await freshResearch(channel, c);
  const qaVerdicts = listItems()
    .filter((it) => it.channel === channel && it.qa)
    .slice(0, 10)
    .map((it) => ({
      id: it.id,
      topic: it.idea?.topic ?? it.seedIdea ?? "",
      verdict: it.qa!.verdict,
      overall: it.qa!.overall,
    }));
  // Accumulated memory of past outcomes + prior genome drift — the compounding
  // evidence that lifts evolution above learnings.json's fixed window.
  const memories = await recallChannelMemory(channel);

  const hasSignals =
    !!learnings || scorecard.posts > 0 || research.length > 0 || qaVerdicts.length > 0 || memories.length > 0;
  if (!hasSignals) {
    // Nothing to learn from yet — proposing mutations would be pure
    // hallucination, so evolution is a clean no-op.
    return { genome, applied: [], queued: [], usd: 0 };
  }

  // 2) Brain (tier smart) proposes evidence-backed mutations.
  const prompt = [
    `You evolve the persistent Brand Genome of the social channel "${channel}" (${c.name}).`,
    `Propose at most ${maxMutations} SMALL, evidence-backed mutations grounded ONLY in the signals below. No speculation.`,
    "",
    "CURRENT GENOME:",
    genomeContext(channel),
    "",
    "SIGNALS:",
    learnings ? `Learnings:\n${learnings}` : "",
    scorecard.posts > 0 ? `Scorecard: ${JSON.stringify(scorecard)}` : "",
    qaVerdicts.length ? `Recent QA verdicts: ${JSON.stringify(qaVerdicts)}` : "",
    memories.length
      ? `Memory (accumulated outcomes & prior genome drift across sessions):\n${memories.map((m) => `- ${m.content}`).join("\n")}`
      : "",
    ...research.map((r) => `Research [${r.id}] (${r.kind}: ${r.query}):\n${r.excerpt}`),
    "",
    "RULES:",
    `- Allowed mutation paths: ${ALL_PATHS.join(", ")}.`,
    `- apply.op: "upsert" (add/refresh a trait), "reweight" (change weight of an EXISTING trait value), "remove" (drop an existing trait value).`,
    `- For trait paths, apply.value is the trait text and apply.weight its new 0..1 affinity.`,
    `- For "platformPlaybooks", apply.value is a JSON string of {platform, levers[], cadence?, bestTimes?, updatedAt, researchId?}.`,
    `- confidence is YOUR 0..1 certainty the mutation improves performance; be conservative — only clear signals deserve >= 0.8.`,
    `- mutation is a short human-readable description of the change; rationale cites the signal that motivated it.`,
    "",
    `Return ONLY JSON: {"mutations":[{"path":"traits.hooks","mutation":"…","rationale":"…","confidence":0.85,"apply":{"op":"upsert","path":"traits.hooks","value":"…","weight":0.8}}]}`,
  ]
    .filter(Boolean)
    .join("\n");

  const { data, usd } = await think(EvolutionProposal, prompt, opts.tier ?? "smart", 2, "dna_evolve");

  // Evidence trail: every proposal in this run was informed by these sources.
  const evidence = [...research.map((r) => r.id), ...qaVerdicts.map((q) => q.id)].slice(0, 12);

  // 3) Apply confident mutations (policy auto + unlocked path), queue the rest.
  // We DON'T mutate `genome` (the snapshot loaded before the multi-minute brain
  // call — now possibly stale) directly. Instead we collect the auto-applied
  // patches and the queued items, then merge them onto a FRESH re-read of the
  // genome below, so a concurrent human approve/reject/setTrait/lock that landed
  // while the brain was thinking is preserved rather than clobbered.
  const applied: GenomeMutation[] = [];
  const queued: PendingMutation[] = [];
  const autoPatches: ApplyPatch[] = [];
  for (const m of data.mutations.slice(0, maxMutations)) {
    const auto = m.confidence >= 0.8 && policy === "auto" && !lockedPath(genome, m.path);
    // Normalize: the lock check runs on m.path, so the applied patch MUST
    // target the same path — a disagreeing apply.path could bypass a lock.
    const patch: ApplyPatch = { ...m.apply, path: m.path, evidence: m.apply.evidence ?? evidence };
    if (auto) {
      // Dry-run the patch against the (stale) snapshot to detect machine-
      // unapplicable proposals up front; the real apply happens on the fresh
      // genome below. Applying to the snapshot here is harmless — the snapshot
      // is discarded — and lets us demote a bad patch to pending with the
      // failure noted, exactly as before.
      try {
        applyPatchToGenome(genome, patch);
      } catch (e) {
        // A machine-unapplicable proposal still has value as a suggestion —
        // demote it to the approval queue with the failure noted.
        queued.push({
          id: newMutId(),
          proposedAt: nowIso(),
          path: m.path,
          mutation: m.mutation,
          rationale: `${m.rationale} (auto-apply failed: ${e instanceof Error ? e.message : String(e)})`,
          confidence: m.confidence,
          apply: patch,
        });
        continue;
      }
      autoPatches.push(patch);
      applied.push({
        id: newMutId(),
        at: nowIso(),
        kind: "auto",
        path: m.path,
        mutation: m.mutation,
        cause: m.rationale,
        evidence,
      });
    } else {
      queued.push({
        id: newMutId(),
        proposedAt: nowIso(),
        path: m.path,
        mutation: m.mutation,
        rationale: m.rationale,
        confidence: m.confidence,
        apply: patch,
      });
    }
  }

  // Re-read the genome from disk and merge this run's results onto the FRESH
  // copy — never persist the pre-brain snapshot. Re-applying the auto patches
  // onto fresh state re-runs the lock check against any locks a human added
  // meanwhile (so a freshly-locked path is now respected), and we MERGE pending
  // by id so concurrently approved/rejected mutations aren't resurrected.
  const fresh = getGenome(channel, opts.ws);
  const reallyApplied: GenomeMutation[] = [];
  for (let k = 0; k < autoPatches.length; k++) {
    const patch = autoPatches[k];
    if (lockedPath(fresh, patch.path)) continue; // human locked this path mid-flight — skip
    try {
      applyPatchToGenome(fresh, patch);
    } catch {
      // Lost a race (e.g. a 'remove'/'reweight' target a human already changed)
      // — drop silently rather than corrupting fresh state; the proposal is gone.
      continue;
    }
    logMutation(fresh, applied[k]);
    reallyApplied.push(applied[k]);
  }
  // Append this run's new pending items, de-duped against whatever pending set
  // exists on the fresh genome now (a human may have resolved some meanwhile —
  // those are simply absent from fresh.pending and stay resolved).
  const existingIds = new Set(fresh.pending.map((p) => p.id));
  const newPending = queued.filter((q) => !existingIds.has(q.id));
  fresh.pending = [...newPending, ...fresh.pending].slice(0, 50);

  const saved = saveGenome(fresh);

  // 4) Persist this run to the memory provider: each applied mutation as a
  //    recallable fact, plus a learn() signal of the post-performance that drove
  //    it (cognitive backends only). Awaited so a CLI run flushes before exit;
  //    best-effort so a dead backend never fails the evolve.
  for (const m of reallyApplied) await rememberMutation(channel, m);
  await learnFromOutcome(channel, reallyApplied, scorecard);

  return { genome: saved, applied: reallyApplied, queued, usd };
}

/* ─── Approval gate ──────────────────────────────────────────────────────── */

export function applyMutation(channel: string, pendingId: string): BrandGenome {
  const genome = getGenome(channel);
  const p = genome.pending.find((x) => x.id === pendingId);
  if (!p) throw new Error(`pending mutation not found on ${channel}: ${pendingId}`);
  // Re-validate the stored patch at apply time — it crossed a persistence
  // boundary as z.unknown() and may predate the current patch format.
  const patch = ApplyPatch.parse(p.apply);
  applyPatchToGenome(genome, patch);
  genome.pending = genome.pending.filter((x) => x.id !== pendingId);
  const rec: GenomeMutation = {
    id: p.id,
    at: nowIso(),
    kind: "approved",
    path: p.path,
    mutation: p.mutation,
    cause: p.rationale,
    evidence: patch.evidence,
  };
  logMutation(genome, rec);
  const saved = saveGenome(genome);
  void rememberMutation(channel, rec); // applied via approval → remember too
  return saved;
}

export function rejectMutation(channel: string, pendingId: string): BrandGenome {
  const genome = getGenome(channel);
  if (!genome.pending.some((x) => x.id === pendingId)) {
    throw new Error(`pending mutation not found on ${channel}: ${pendingId}`);
  }
  genome.pending = genome.pending.filter((x) => x.id !== pendingId);
  return saveGenome(genome);
}

/* ─── Manual edits ─────────────────────────────────────────────────────────
   Operator-initiated changes bypass the lock check (locks exist to stop the
   AUTONOMOUS loop from touching pinned traits, not the human) but are still
   logged to the evolution history so provenance never has gaps. */

export function setTrait(channel: string, path: string, value: string, weight = 0.6): BrandGenome {
  const genome = getGenome(channel);
  const desc = applyPatchToGenome(genome, { op: "upsert", path, value, weight });
  logMutation(genome, {
    id: newMutId(),
    at: nowIso(),
    kind: "manual",
    path,
    mutation: desc,
    cause: "manual edit",
  });
  return saveGenome(genome);
}

export function lockTrait(channel: string, path: string, locked = true): BrandGenome {
  if (!ALL_PATHS.some((p) => path === p || path.startsWith(`${p}.`)) && path !== "traits") {
    throw new Error(`unknown trait path "${path}" (allowed: ${ALL_PATHS.join(", ")})`);
  }
  const genome = getGenome(channel);
  genome.locks = locked
    ? [...new Set([...genome.locks, path])]
    : genome.locks.filter((l) => l !== path);
  return saveGenome(genome);
}
