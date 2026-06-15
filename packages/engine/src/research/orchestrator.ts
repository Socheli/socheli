import { spawn } from "node:child_process";
import { z } from "zod";
import {
  ResearchClaim,
  ResearchRun,
  ResearchSource,
  stampOwnership,
  systemContext,
} from "@os/schemas";
import { think, type BrainTier } from "../brain.ts";
import { webSearch, type SearchResult } from "../websearch.ts";
import { proxyReachable, socksProxyArgs } from "../http.ts";
import { nowIso } from "../store.ts";
import { newResearchId, saveRun } from "./store.ts";
import type { OnStep, ResearchStep, StepKind } from "../algo-research.ts";

/* ════════════════════════════════════════════════════════════════════════
   Research orchestrator — the deep-research loop behind the harness.

       plan → sweep → fetch → extract → verify → synthesize

   - plan        brain(cheap) turns one question into focused sub-queries.
   - sweep       webSearch() per sub-query (existing open-websearch MCP).
   - fetch       top pages, 4 concurrent, 15s timeout, stripped to ≤8k chars.
   - extract     brain(cheap) per source → atomic candidate findings.
   - verify      one brain(smart) pass merges duplicates + adjudicates; a
                 deterministic post-pass enforces the status rule (≥2 sources
                 → verified, 1 → single-source, contradictions → disputed).
   - synthesize  brain(smart; `best` at depth=deep) → cited markdown report
                 with [S1]-style citations mapping back to sources.

   Every milestone is persisted via research/store.ts so research_get shows
   live progress, and step events are emitted in algo-research's ResearchStep
   shape so the existing live-step UI renders this feed unchanged.

   Cost guard: RESEARCH_MAX_USD (env, optional). When the accumulated brain
   spend crosses it we stop EXPANDING (no more extraction calls, skip the
   smart verify pass) but always synthesize with what we have — a cheap,
   slightly-less-verified report beats a failed run.
   ════════════════════════════════════════════════════════════════════════ */

export type ResearchSpec = {
  kind: ResearchRun["kind"];
  query: string;
  channel?: string;
  depth?: ResearchRun["depth"];
  /** Cache freshness window written onto the run; defaults per kind. */
  ttlHours?: number;
  /** Pre-allocated id (the tool layer passes one so callers can poll while the detached worker runs). */
  id?: string;
  /** Tenancy: stamp the run for this workspace/author (defaults to system/default workspace). */
  workspaceId?: string;
  createdBy?: string;
};

/* Depth budgets per the contract: quick ≈ 3 queries / 5 sources,
   standard ≈ 5 / 10, deep ≈ 8 / 20. */
const DEPTH_BUDGET: Record<NonNullable<ResearchRun["depth"]>, { queries: number; sources: number }> = {
  quick: { queries: 3, sources: 5 },
  standard: { queries: 5, sources: 10 },
  deep: { queries: 8, sources: 20 },
};

/* Default TTLs per kind — how long this class of answer stays trustworthy.
   Trends rot in a day; algorithm levers hold for ~3; topic/competitor facts
   a bit longer; a deep dive is worth keeping a week. */
const KIND_TTL: Record<ResearchRun["kind"], number> = {
  trend: 24,
  algo: 72,
  topic: 48,
  competitor: 72,
  deep: 168,
};

const FETCH_CONCURRENCY = 4;
const FETCH_TIMEOUT_S = 15;
const SOURCE_TEXT_CAP = 8000;

/* ─── Step events (algo-research ResearchStep shape) ─────────────────────── */

let _seq = 0;
const mkStep = (kind: StepKind, label: string, detail?: string, data?: unknown): ResearchStep => ({
  id: `r${++_seq}`,
  kind,
  label,
  detail,
  data,
  at: nowIso(),
});

/* ─── Budget guard ───────────────────────────────────────────────────────── */

class Budget {
  usd = 0;
  readonly max = Number(process.env.RESEARCH_MAX_USD || 0); // 0/unset = unlimited
  add(usd: number) {
    this.usd += usd;
  }
  exceeded(): boolean {
    return this.max > 0 && this.usd >= this.max;
  }
}

/* ─── Fetch: async curl, proxy-aware ─────────────────────────────────────────
   http.ts's httpCurl is spawnSync — it blocks the event loop, so four
   CONCURRENT fetches are impossible through it. This async twin keeps the
   exact same proxy convention as httpCurl by reusing http.ts's shared
   socksProxyArgs(): proxy is opt-in per URL because only Google properties are
   geo-blocked in some regions; everything else goes direct. */

function needsProxy(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return /(^|\.)google\.[a-z.]+$|(^|\.)googleapis\.com$|(^|\.)youtube\.com$|(^|\.)ytimg\.com$/.test(host);
  } catch {
    return false;
  }
}

function fetchPage(url: string): Promise<string> {
  return new Promise((resolve) => {
    const args = ["-sL", "--max-time", String(FETCH_TIMEOUT_S), "--compressed",
      "-A", "Mozilla/5.0 (Macintosh) SocheliResearch/1.0"];
    // Only route through the tunnel when the target needs it AND it's up —
    // a down tunnel must degrade to a skipped source, not a hung fetch.
    if (needsProxy(url) && proxyReachable()) args.push(...socksProxyArgs());
    args.push(url);
    const child = spawn("curl", args, { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    // Belt-and-braces kill: curl's --max-time should fire first, but never
    // trust a child process to honor its own timeout.
    const timer = setTimeout(() => child.kill("SIGKILL"), (FETCH_TIMEOUT_S + 3) * 1000);
    child.stdout.on("data", (d) => {
      out += d;
      if (out.length > 2_000_000) child.kill("SIGKILL"); // 2MB cap — we only keep 8k anyway
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve("");
    });
    child.on("close", () => {
      clearTimeout(timer);
      resolve(out);
    });
  });
}

/* Strip HTML to readable text. Deliberately simple (regex tag-strip, no DOM
   dependency): drop non-content blocks, keep block boundaries as newlines,
   decode the common entities, collapse whitespace, cap at 8k chars. */
export function htmlToText(html: string): string {
  let s = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(nav|header|footer|aside|form)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article|blockquote)>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  s = s
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)));
  return s.replace(/[ \t]+/g, " ").replace(/\s*\n\s*/g, "\n").replace(/\n{2,}/g, "\n").trim().slice(0, SOURCE_TEXT_CAP);
}

/* Run an async mapper over items with a concurrency cap. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

/* ─── Brain output shapes (response envelopes, not domain schemas) ────────── */

const PlanOut = z.object({ queries: z.array(z.string().min(3)).min(1).max(12) });
const ExtractOut = z.object({ claims: z.array(z.string().min(8)).max(10) });
const VerifyOut = z.object({ claims: z.array(ResearchClaim).default([]) });
const ReportOut = z.object({ report: z.string().min(50) });

type Candidate = { text: string; sourceId: string };
type FetchedSource = z.infer<typeof ResearchSource> & { text: string };

/* Kind-specific planning guidance: a trend sweep and an algorithm audit want
   very different sub-queries, and the planner is a cheap model that needs the
   steer spelled out. */
const KIND_GUIDANCE: Record<ResearchRun["kind"], string> = {
  trend: "Find what is trending/resonating RIGHT NOW: recent discussions, viral posts, news, community chatter. Bias queries toward recency (add the current month/year).",
  algo: "Reverse-engineer platform ranking algorithms: ranking signals, recent algorithm changes, creator growth tactics, official platform guidance.",
  topic: "Build deep factual understanding of the topic: definitions, mechanisms, numbers, expert analysis, counterpoints, recent developments.",
  competitor: "Map the competitive landscape: who the top players are, what they ship/post, their positioning, strengths, weaknesses, and audience reception.",
  deep: "Exhaustive multi-angle investigation: fundamentals, current state, data/statistics, expert opinions, contrarian takes, and future outlook.",
};

/* ════════════════════════════════════════════════════════════════════════
   runResearch — the whole loop. Persists at every milestone; emits live
   steps; never throws for partial failures (a dead search server or a few
   unreachable pages degrade the report, not the run). Only a failure to
   produce ANY report marks the run failed (and then it throws so callers'
   existing fallback paths fire).
   ════════════════════════════════════════════════════════════════════════ */
export async function runResearch(spec: ResearchSpec, onStep?: OnStep): Promise<ResearchRun> {
  const depth = spec.depth ?? "standard";
  const budgetPlan = DEPTH_BUDGET[depth];
  const budget = new Budget();

  const run: ResearchRun = ResearchRun.parse({
    id: spec.id || newResearchId(spec.kind),
    kind: spec.kind,
    query: spec.query,
    channel: spec.channel,
    depth,
    status: "running",
    steps: [],
    sources: [],
    claims: [],
    usd: 0,
    createdAt: nowIso(),
    ttlHours: spec.ttlHours ?? KIND_TTL[spec.kind],
  });
  // Stamp tenancy like every other record: explicit workspace wins, otherwise
  // the system context (default workspace) so legacy single-tenant reads work.
  const tenantCtx = systemContext(spec.workspaceId);
  stampOwnership(run, spec.createdBy ? { ...tenantCtx, userId: spec.createdBy } : tenantCtx);

  const emit = async (kind: StepKind, label: string, detail?: string, data?: unknown) => {
    run.steps.push({ at: nowIso(), label, detail });
    run.usd = Number(budget.usd.toFixed(6));
    saveRun(run); // every step persists → research_get is always live
    await onStep?.(mkStep(kind, label, detail, data));
  };

  try {
    await emit("init", `Researching: ${run.query}`, `kind=${run.kind} depth=${depth} budget=${budget.max > 0 ? `$${budget.max}` : "unlimited"}`);

    /* ── 1. PLAN — cheap brain → focused sub-queries ─────────────────────── */
    let queries: string[] = [run.query];
    try {
      const r = await think(
        PlanOut,
        `You are a research planner. Break ONE research question into ${budgetPlan.queries} focused web-search queries.\n` +
          `QUESTION: ${run.query}\n` +
          `${run.channel ? `CONTEXT: research is for the "${run.channel}" channel/brand.\n` : ""}` +
          `RESEARCH MODE: ${KIND_GUIDANCE[run.kind]}\n` +
          `Rules: each query must be a real search-engine query (3-10 words), each must attack a DIFFERENT facet, ` +
          `no near-duplicates, current year is ${new Date().getFullYear()}.\n` +
          `Return ONLY JSON: {"queries":["...", ...]}`,
        "cheap",
        2,
        "research_plan",
      );
      budget.add(r.usd);
      queries = r.data.queries.slice(0, budgetPlan.queries);
    } catch (e) {
      // Planner down → degrade to the raw query as the single sweep. The rest
      // of the loop still produces a (narrower) verified report.
      await emit("error", "Planner degraded", `${String(e).slice(0, 120)} — sweeping the raw query only`);
    }
    await emit("init", `${queries.length} sub-quer${queries.length === 1 ? "y" : "ies"} planned`, queries.join(" · "));

    /* ── 2. SWEEP — webSearch per sub-query, dedupe by URL ───────────────── */
    // Run the sub-query searches through the same mapLimit concurrency cap as
    // the fetch stage instead of one-at-a-time: webSearch is spawnSync, so a
    // sequential loop pays each sub-query's full latency back-to-back. mapLimit
    // returns results indexed by query, so we still merge them in PLAN order
    // (first-seen URL wins, identical to the old loop). Per-query step events
    // fire from inside each task; emit() appends to run.steps, so the labels may
    // interleave but every "Searching: q" is still recorded.
    const perQuery = await mapLimit(queries, FETCH_CONCURRENCY, async (q): Promise<SearchResult[]> => {
      await emit("search", `Searching: ${q}`);
      // webSearch returns [] on any failure — a down search server degrades
      // to fewer sources, never an exception.
      return webSearch(q, 6);
    });
    const hitByUrl = new Map<string, SearchResult>();
    for (const hits of perQuery) {
      for (const hit of hits) {
        if (hit.url && /^https?:\/\//.test(hit.url) && !hitByUrl.has(hit.url)) hitByUrl.set(hit.url, hit);
      }
    }
    // Prefer domain diversity: round-robin across domains so one SEO-heavy
    // site can't occupy the whole source budget.
    const byDomain = new Map<string, SearchResult[]>();
    for (const hit of hitByUrl.values()) {
      const d = (() => { try { return new URL(hit.url).hostname; } catch { return hit.url; } })();
      (byDomain.get(d) ?? byDomain.set(d, []).get(d)!).push(hit);
    }
    const picked: SearchResult[] = [];
    while (picked.length < budgetPlan.sources && byDomain.size) {
      for (const [d, hits] of byDomain) {
        const h = hits.shift();
        if (h) picked.push(h);
        if (!hits.length) byDomain.delete(d);
        if (picked.length >= budgetPlan.sources) break;
      }
    }
    if (!picked.length) {
      await emit("error", "Web search unavailable", "open-websearch returned no results — synthesizing from model knowledge, uncited");
    }

    /* ── 3. FETCH — 4 concurrent, 15s timeout, strip to ≤8k chars ────────── */
    await emit("search", `Fetching ${picked.length} source page(s)`, `concurrency ${FETCH_CONCURRENCY}, ${FETCH_TIMEOUT_S}s timeout`);
    const fetched = (
      await mapLimit(picked, FETCH_CONCURRENCY, async (hit, i): Promise<FetchedSource | null> => {
        const text = htmlToText(await fetchPage(hit.url));
        // A page that yields almost no text (paywall, JS-only shell, block
        // page) still counts as a source if the search snippet has substance.
        const body = text.length >= 200 ? text : [hit.description, text].filter(Boolean).join("\n").trim();
        if (body.length < 80) return null;
        return {
          id: `S${i + 1}`,
          url: hit.url,
          title: hit.title || hit.url,
          fetchedAt: nowIso(),
          excerpt: body.slice(0, 280),
          text: body,
        };
      })
    ).filter((s): s is FetchedSource => !!s);
    // Re-id sequentially after drops so citations are gapless S1..Sn.
    fetched.forEach((s, i) => (s.id = `S${i + 1}`));
    run.sources = fetched.map(({ text: _text, ...src }) => ResearchSource.parse(src));
    await emit("search", `${fetched.length}/${picked.length} sources readable`, fetched.map((s) => s.title).join(" · ").slice(0, 300), { sources: run.sources });

    /* ── 4. EXTRACT — cheap brain per source → candidate claims ──────────── */
    const candidates: Candidate[] = [];
    if (fetched.length) {
      await emit("signals", `Extracting findings from ${fetched.length} source(s)`);
      // Concurrency 2 (not 4): each extract spawns a brain subprocess; four
      // concurrent claude/codex children invites rate limits and load spikes.
      await mapLimit(fetched, 2, async (src) => {
        if (budget.exceeded()) return; // stop expanding — budget gate
        try {
          const r = await think(
            ExtractOut,
            `You are a research analyst. Extract the 3-6 most useful ATOMIC findings from this source, ` +
              `strictly relevant to the research question.\n` +
              `RESEARCH QUESTION: ${run.query}\n` +
              `SOURCE (${src.title} — ${src.url}):\n${src.text}\n\n` +
              `Rules: each finding is ONE self-contained factual sentence (numbers/names/dates kept), ` +
              `no opinions about the source itself, skip boilerplate/ads.\n` +
              `Return ONLY JSON: {"claims":["...", ...]}`,
            "cheap",
            2,
            "research_extract",
          );
          budget.add(r.usd);
          for (const text of r.data.claims) candidates.push({ text, sourceId: src.id });
        } catch {
          // One unreadable/garbled source must not kill the run.
        }
      });
      if (budget.exceeded())
        await emit("signals", "Budget cap reached during extraction", `$${budget.usd.toFixed(3)} ≥ RESEARCH_MAX_USD — synthesizing with findings so far`);
      else await emit("signals", `${candidates.length} candidate finding(s) extracted`);
    }

    /* ── 5. VERIFY — merge + adjudicate (smart), deterministic post-pass ──── */
    let claims: z.infer<typeof ResearchClaim>[] = [];
    if (candidates.length) {
      if (!budget.exceeded()) {
        await emit("signals", "Cross-verifying claims", `${candidates.length} candidates across ${fetched.length} sources`);
        try {
          const r = await think(
            VerifyOut,
            `You are an adversarial fact-checker. Merge and adjudicate these candidate research findings.\n` +
              `RESEARCH QUESTION: ${run.query}\n` +
              `CANDIDATES (each tagged with its source id):\n` +
              candidates.slice(0, 60).map((c) => `- [${c.sourceId}] ${c.text}`).join("\n") +
              `\n\nRules:\n` +
              `- MERGE findings that state the same fact (even in different words) into one claim whose sourceIds is the UNION of their source ids.\n` +
              `- status "verified" = independently supported by 2+ sources; "single-source" = only one source; "disputed" = sources CONTRADICT each other (keep the claim text neutral, citing both sides' sources).\n` +
              `- Keep at most 20 claims, most decision-relevant first. Do not invent claims or source ids.\n` +
              `Return ONLY JSON: {"claims":[{"text":"...","sourceIds":["S1","S3"],"status":"verified"}]}`,
            "smart",
            2,
            "research_verify",
          );
          budget.add(r.usd);
          claims = r.data.claims;
        } catch (e) {
          await emit("error", "Verify pass degraded", `${String(e).slice(0, 120)} — falling back to mechanical dedupe`);
        }
      }
      if (!claims.length) {
        // Budget-capped or verify-brain down: mechanical fallback — exact-ish
        // text dedupe with source unioning, statuses from the count rule.
        const seen = new Map<string, { text: string; sourceIds: Set<string> }>();
        for (const c of candidates) {
          const key = c.text.toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();
          const e = seen.get(key) ?? { text: c.text, sourceIds: new Set<string>() };
          e.sourceIds.add(c.sourceId);
          seen.set(key, e);
        }
        claims = [...seen.values()].slice(0, 20).map((e) => ({
          text: e.text,
          sourceIds: [...e.sourceIds],
          status: (e.sourceIds.size >= 2 ? "verified" : "single-source") as z.infer<typeof ResearchClaim>["status"],
        }));
      }
      // Deterministic guardrail over whatever the brain said: the ≥2-sources
      // rule is OURS, not the model's. Disputed verdicts are trusted (the
      // model saw the contradiction; we can't re-derive it mechanically).
      const validIds = new Set(fetched.map((s) => s.id));
      claims = claims
        .map((c) => ({ ...c, sourceIds: c.sourceIds.filter((id) => validIds.has(id)) }))
        .filter((c) => c.sourceIds.length > 0 || fetched.length === 0)
        .map((c) =>
          c.status === "disputed" ? c : { ...c, status: (c.sourceIds.length >= 2 ? "verified" : "single-source") as typeof c.status },
        );
      run.claims = claims.map((c) => ResearchClaim.parse(c));
      const v = run.claims.filter((c) => c.status === "verified").length;
      const d = run.claims.filter((c) => c.status === "disputed").length;
      await emit("signals", `${run.claims.length} claim(s) adjudicated`, `${v} verified · ${run.claims.length - v - d} single-source · ${d} disputed`, { claims: run.claims });
    }

    /* ── 6. SYNTHESIZE — cited markdown report (always runs) ─────────────── */
    const synthTier: BrainTier = depth === "deep" ? "best" : "smart";
    await emit("brief", "Synthesizing report", `tier=${synthTier}`);
    const sourceList = fetched.map((s) => `${s.id}: ${s.title} — ${s.url}`).join("\n");
    const claimList = run.claims
      .map((c) => `- (${c.status}) ${c.text} [${c.sourceIds.join(",")}]`)
      .join("\n");
    // Short per-source excerpts give the writer texture beyond the claims
    // without blowing the prompt: 600 chars × ≤20 sources ≤ 12k.
    const excerpts = fetched.map((s) => `${s.id} (${s.title}):\n${s.text.slice(0, 600)}`).join("\n\n");
    const r = await think(
      ReportOut,
      `You are a senior research analyst writing the final report for this research run.\n` +
        `QUESTION: ${run.query}\n` +
        `MODE: ${run.kind} — ${KIND_GUIDANCE[run.kind]}\n` +
        `${run.channel ? `AUDIENCE: the operator of the "${run.channel}" channel/brand.\n` : ""}` +
        (fetched.length
          ? `SOURCES:\n${sourceList}\n\nADJUDICATED CLAIMS (your factual backbone — verified > single-source; flag disputed ones):\n${claimList || "(none)"}\n\nSOURCE EXCERPTS:\n${excerpts}\n\n` +
            `Write a decision-ready markdown report (300-700 words):\n` +
            `- "## Key findings" — the answer, lead with what matters.\n` +
            `- "## Details" — supporting analysis, numbers, mechanics.\n` +
            `- "## Caveats" — disputed/single-source items and gaps.\n` +
            `- Cite EVERY factual statement with [S#] markers matching SOURCES. No uncited facts. No fabricated sources.\n`
          : `No web sources could be fetched (search backend unavailable). Write the best report you can from ` +
            `model knowledge, clearly opening with: "_No live sources were reachable — uncited, from model knowledge as of training._"\n`) +
        `Return ONLY JSON: {"report":"<the markdown>"}`,
      synthTier,
      2,
      "research_synthesize",
    );
    budget.add(r.usd);
    run.report = r.data.report;
    run.status = "done";
    await emit("done", "Research ready", `${run.sources.length} sources · ${run.claims.length} claims · $${budget.usd.toFixed(3)}`, { id: run.id });
    return run;
  } catch (e) {
    // Total failure (couldn't even synthesize). Persist the failed run for
    // postmortems, then rethrow so callers' existing fallback paths fire.
    run.status = "failed";
    run.steps.push({ at: nowIso(), label: "Research failed", detail: String(e).slice(0, 300) });
    run.usd = Number(budget.usd.toFixed(6));
    saveRun(run);
    await onStep?.(mkStep("error", "Research failed", String(e).slice(0, 200)));
    throw e;
  }
}
