# Socheli Agent Harness v2 — "Soli OS"

> The contract for the agentic upgrade: persistent Brand Genome (DNA), a real
> research harness, pluggable agent-harness runtimes (Claude Agent SDK,
> headless Claude Code, Codex CLI, OpenRouter), and a missions orchestrator
> that runs multi-channel social media management autonomously.

Status: SPEC — implemented in phases A–D. Each section names exact files.

---

## 0. Principles

1. **Engine-first.** Every capability lands in `packages/engine` so all five
   surfaces (CLI, HTTP API, MCP, SDK, dashboard copilot) get it for free via
   the unified tool registry (`packages/engine/src/tools/registry.ts`).
2. **One brain abstraction, two call shapes.** `brain.ts` stays the one-shot
   JSON brain (claude -p / codex / openrouter). The NEW `harness/` layer is the
   multi-turn, tool-using agent runtime. Both are provider-agnostic and
   subscription-friendly (zero-key default via Claude Code auth).
3. **DNA is versioned, evidence-backed, and gated.** The genome only mutates
   with recorded cause + evidence; high-impact mutations queue for approval.
4. **Research is cached, cited, verified.** No raw web-search dumps into
   prompts; research runs produce verified, cited reports with TTL caches.
5. **Tenancy preserved.** Everything carries `workspaceId`/`createdBy` and is
   gated by the existing role matrix (`@os/schemas` TenantContext).
6. **Hybrid-architecture safe.** Nothing here weakens the security model in
   docs/HYBRID-ARCHITECTURE.md — missions run device-side; publish stays
   behind the device-side publish gate; no new spawn-env exposure.

---

## 1. Brand Genome — persistent DNA (`packages/engine/src/dna.ts`)

The static `ChannelDNA` (data/brands.json) becomes the *base genome*. A new
**BrandGenome** layers learned, evolving traits on top, persisted per channel.

### Schema (add to `packages/schemas/src/index.ts`)

```ts
export const GenomeTrait = z.object({
  value: z.string(),          // e.g. a hook pattern, topic, format id
  weight: z.number(),         // 0..1 affinity learned from performance
  evidence: z.array(z.string()).optional(), // item ids / research ids / notes
});

export const GenomeMutation = z.object({
  id: z.string(),
  at: z.string(),
  kind: z.enum(["auto", "approved", "manual"]),
  path: z.string(),           // trait path mutated, e.g. "traits.hooks"
  mutation: z.string(),       // human-readable description
  cause: z.string(),          // why (analytics signal, research finding…)
  evidence: z.array(z.string()).optional(),
});

export const PendingMutation = z.object({
  id: z.string(),
  proposedAt: z.string(),
  path: z.string(),
  mutation: z.string(),
  rationale: z.string(),
  confidence: z.number(),     // 0..1
  apply: z.unknown(),         // machine-applicable patch payload
});

export const PlatformPlaybook = z.object({
  platform: z.string(),       // youtube | instagram | tiktok | x | linkedin
  cadence: z.string().optional(),       // e.g. "5/week"
  bestTimes: z.array(z.string()).optional(),
  levers: z.array(z.string()),          // current algorithm levers to pull
  updatedAt: z.string(),
  researchId: z.string().optional(),    // provenance
});

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
```

### Storage & API (`dna.ts`)

- Files: `data/dna/<channel>.json` (+ `data/dna/` in repo with .gitkeep).
- `getGenome(channel, ws?)` — load or seed a default genome from ChannelDNA
  (preferredHooks → traits.hooks at weight .6, learnings.json wins → evidence).
- `saveGenome(genome)` — atomic write, version bump on trait change.
- `genomeContext(channel)` — compact markdown block for prompt injection:
  top-weighted hooks/topics/formats, audience summary, platform levers,
  recent avoid-list. **≤ 60 lines.** Used by `stages.ts` ideate/writeScript,
  `selection.ts`, `algo-research.ts`.
- `evolveGenome(channel, opts)` — the evolution engine:
  1. Gather signals: `learnings.json`, analytics scorecards, fresh research
     (via §2 `findFresh`), recent item QA verdicts.
  2. Brain (tier `smart`) proposes mutations with confidence + rationale +
     machine-applicable patch.
  3. Mutations with `confidence ≥ 0.8` AND path not in `locks` AND
     approvalPolicy `auto` → applied + logged to `evolution`.
     Otherwise → `pending` (approval gate).
  4. If `ICOG_API_KEY` set, mirror each applied mutation to iCog via
     `remember()` (memory_type `fact`, prefixed `[genome:<channel>]`).
- `applyMutation(channel, pendingId)` / `rejectMutation(channel, pendingId)`.
- `setTrait(channel, path, value, weight)` / `lockTrait(channel, path)`.

### Tools (`packages/engine/src/tools/dna-tools.ts`, wired into registry)

`dna_get`, `dna_context`, `dna_evolve` (long), `dna_pending_list`,
`dna_mutation_approve`, `dna_mutation_reject`, `dna_set_trait`,
`dna_lock_trait`, `dna_history`.

### CLI

`content dna <channel>` (print genome summary), `content dna evolve <channel>`,
`content dna pending <channel>`, `content dna approve <channel> <id>`.

---

## 2. Research harness (`packages/engine/src/research/`)

Multi-step, multi-source, **verified** research replacing ad-hoc
`webSearch()` sprinkles. The deep-research pattern: plan → fan out → fetch →
extract → cross-verify → synthesize with citations.

### Schema (schemas/index.ts)

```ts
export const ResearchSource = z.object({
  id: z.string(), url: z.string(), title: z.string(),
  fetchedAt: z.string(), excerpt: z.string().optional(),
});
export const ResearchClaim = z.object({
  text: z.string(),
  sourceIds: z.array(z.string()),
  status: z.enum(["verified", "single-source", "disputed"]),
});
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
```

### Modules

- `research/orchestrator.ts` — `runResearch(spec, onStep?)`:
  - **plan**: brain(cheap) → 3–8 sub-queries depending on depth.
  - **sweep**: `webSearch()` per sub-query (existing websearch.ts), then fetch
    top pages via `http.ts` (proxy-aware), concurrency 4, 15s timeout, strip
    to readable text (simple tag-strip, ≤ 8k chars/source).
  - **extract**: brain(cheap) per source → candidate claims/findings.
  - **verify**: claims seen in ≥2 sources → `verified`; else `single-source`;
    contradictions → `disputed`. One brain(smart) pass adjudicates.
  - **synthesize**: brain(smart; `best` when depth=deep) → cited markdown
    report (`[S1]`-style citations mapping to sources).
  - Emits step events shaped like algo-research's `ResearchStep` so the
    existing live-step UI pattern renders it.
- `research/store.ts` — `data/research/index.json` (id, kind, query, hash,
  channel, createdAt, ttlHours, status) + `data/research/<id>.json`.
  `findFresh(kind, query, maxAgeH, channel?)` → cached run or null.
- Depth budget: quick ≈ 3 queries/5 sources, standard ≈ 5/10, deep ≈ 8/20.

### Consumers (rewire, minimal diffs)

- `algo-research.ts`: platform playbook step uses
  `findFresh("algo", platform-query, 72h) ?? runResearch(...)`; writes the
  resulting playbook into the genome's `platformPlaybooks` (provenance id).
- `stages.ts` `scanTrends()`: backed by `findFresh("trend", …, 24h)`.
- `longform-outline.ts` chapter research: `runResearch({kind:"topic"})`.
- `dna.ts` `evolveGenome`: consumes fresh algo/trend runs as evidence.

### Tools & CLI

`research_run` (long), `research_get`, `research_list`, `research_fresh`.
CLI: `content research "<query>" [--kind topic] [--depth deep] [--channel x]`.

---

## 3. Harness runtimes — the "cord" (`packages/engine/src/harness/`)

Multi-turn, tool-using agent runtimes behind one interface. This is what lets
Socheli *use* Claude Code / Codex / the Agent SDK as worker brains, and what
external harnesses drive back through MCP.

### Interface (`harness/types.ts`)

```ts
export type AgentRole = "researcher" | "strategist" | "creative" | "editor"
  | "publisher" | "analyst" | "channel_manager";

export type AgentTask = {
  id: string;
  role: AgentRole;
  goal: string;                 // the instruction
  context?: string;             // injected context (genome, plan, item…)
  tools?: string[];             // registry-tool allowlist (default: role preset)
  tier?: "cheap" | "smart" | "best";
  maxSteps?: number;            // default 16
  budgetUsd?: number;           // hard stop
  tenant?: TenantContext;
};

export type AgentEvent =
  | { type: "token"; text: string }
  | { type: "tool_call"; id: string; name: string; args: unknown }
  | { type: "tool_result"; id: string; name: string; ok: boolean; result: unknown }
  | { type: "step"; label: string }
  | { type: "done"; summary: string; usd: number }
  | { type: "error"; message: string };

export interface HarnessRuntime {
  id: string;                   // "claude-sdk" | "claude-code" | "codex" | "openrouter"
  available(): boolean | Promise<boolean>;
  run(task: AgentTask): AsyncGenerator<AgentEvent>;
}
```

### Runtimes

- `harness/claude-sdk.ts` — **premium default.** `@anthropic-ai/claude-agent-sdk`
  `query()` with an in-process MCP server (`createSdkMcpServer` + `tool()`)
  wrapping the registry tools allowed for the role (dispatch via the same
  `runTool` the engine runner uses, tenant-scoped). Uses CC subscription auth
  or ANTHROPIC_API_KEY; tier → haiku/sonnet/opus (same map as brain.ts).
- `harness/claude-code.ts` — spawn `claude -p <goal> --output-format
  stream-json --verbose --max-turns <n>` with `--mcp-config` pointing at the
  socheli MCP server and `--allowedTools` from the role preset. Reuse
  `resolveClaudeBin()` from brain.ts. Parse stream-json → AgentEvent.
- `harness/codex.ts` — spawn `codex exec --json <goal>`; map events; tools via
  MCP config when supported, else degrade to one-shot+context.
- `harness/openrouter.ts` — engine-side minimal tool loop (OpenAI-compatible
  /chat/completions with `tools`, loop ≤ maxSteps). No LangChain dependency in
  the engine; plain fetch.

### Router & roles

- `harness/router.ts` — `pickRuntime(task)`:
  `HARNESS_PREMIUM` env (default `claude-sdk,claude-code,openrouter` — first
  available wins) for tier smart/best; `HARNESS_DEFAULT`
  (default `openrouter,claude-code`) for cheap. Per-task override allowed.
- `harness/roles.ts` — role presets: system prompt + registry-tool allowlist +
  default tier. Examples: researcher → research_*/intel_*/dna_context, smart;
  creative → draft_*/concept_*/pipeline_generate_post, smart;
  publisher → publish_*/derivatives_*, cheap; analyst →
  analytics_*/learnings_*/dna_evolve, smart; channel_manager → broad, best.
- `harness/run.ts` — `runAgentTask(task)` convenience: pick runtime, stream
  events to a log file under `data/agent/<task.id>.jsonl`, return summary.

### Tool & CLI

`agent_run_task` (long; role, goal, tier) in registry — this is how the
dashboard copilot and MCP clients delegate deep work to a premium harness.
CLI: `content agent-task --role researcher "audit our IG hook performance"`.

### Dashboard bridge (Phase B)

`apps/dashboard/lib/agent/` keeps LangGraph+OpenRouter for interactive copilot
turns. New: when Soli calls `agent_run_task`, the engine harness executes it
as a background job in the existing job tree (queue_enqueue semantics), so
deep work streams into the same SSE job feed.

---

## 4. Missions — the orchestrator (`packages/engine/src/missions.ts`)

A mission is a standing goal for a channel that the system advances on a
cadence — the autonomous social-media-manager loop.

### Schema

```ts
export const MissionTask = z.object({
  id: z.string(), role: z.string(), goal: z.string(),
  status: z.enum(["queued", "running", "done", "failed", "skipped"]),
  dueAt: z.string().optional(), startedAt: z.string().optional(),
  finishedAt: z.string().optional(), resultSummary: z.string().optional(),
  usd: z.number().default(0),
});
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
```

### Runner

- Storage `data/missions.json`. CRUD + `missionTick()`.
- `scheduler.ts tick()` calls `missionTick()` after the existing slot logic
  (same lock; missions never run concurrently with a render slot — renders
  stay serial per device).
- `missionTick()`: for each active mission, enqueue due loop tasks (cadence vs
  `state.lastRun`), then execute AT MOST ONE queued task via
  `runAgentTask({role, goal, …})`, respecting `budget.usdPerDay` (sum of
  today's task usd). Standard loop tasks:
  - research: refresh algo/trend research for the channel's platforms.
  - plan: re-run algo plan → update content-plan (respecting existing posts).
  - generate: pick today's planned post → `pipeline_generate_post` (or draft
    for gated channels).
  - analyze: `analytics_ingest` + scorecards → learnings.
  - evolve: `dna_evolve` (gated by approvalPolicy.dnaMutations).
- Publish stays behind the existing autopilot/publish gate; `approvalPolicy.
  publish === "gate"` keeps items at ready/private until approved.

### Tools & CLI

`mission_create`, `mission_list`, `mission_get`, `mission_update`,
`mission_pause`, `mission_resume`, `mission_tick` (long), `mission_task_log`.
CLI: `content mission create|list|tick …`.

---

## 5. Dashboard surfaces (Phase C)

Match the existing premium dark design language (one accent, mono eyebrows,
lucide icons). All data via existing dashboard API route patterns.

- **/missions** — mission cards (goal, channel, cadence, budget burn, last
  events), live task feed (reuse SSE job stream), **approvals inbox**: pending
  DNA mutations + gated publishes with approve/reject.
- **/research** — list runs (kind/depth/age/status), run detail with live
  steps, sources, claims (verified/disputed badges), cited report rendering;
  "new research" composer.
- **/channels/[id] DNA panel** — genome traits with weights (bar viz),
  evolution timeline, pending mutations with approve/reject, lock toggles.
- Soli copilot picks up all new tools automatically via the manifest; add the
  mission/dna/research tools to role gating in `tenancy.ts` (mutations =
  editor+, approvals = admin+).

---

## 6. External harness integrations (Phase D)

Make Socheli a first-class *target* for any agent harness:

- **`.claude/` project dir**: `CLAUDE.md` (repo map, commands, conventions),
  skills: `socheli-post` (idea→rendered post via draft tools), `socheli-research`,
  `socheli-plan`, `socheli-dna`, `socheli-publish` — thin instruction files
  steering Claude Code through the MCP tools / CLI. `settings.json` with the
  socheli MCP servers pre-wired.
- **`AGENTS.md`** — Codex-style harness guide (same content shape as CLAUDE.md).
- **docs/harness.md** — how to point ANY harness (Claude Code, Codex, Hermes,
  OpenClaw) at Socheli: MCP stdio config, HTTP API + key, CLI. Plus how
  Socheli itself spawns harness runtimes (env: HARNESS_PREMIUM/HARNESS_DEFAULT,
  CLAUDE_BIN, CODEX_BIN).
- MCP server: new tools are auto-exposed via the registry; verify + document.
- README: new "Agent Harness" section.

---

## 7. Env additions (document in .env.example)

```
HARNESS_PREMIUM=claude-sdk,claude-code,openrouter   # runtime preference, smart/best tier
HARNESS_DEFAULT=openrouter,claude-code              # cheap tier
BRAIN_FALLBACK=openrouter     # brain provider fallback chain (comma list, after the primary)
ANTHROPIC_API_KEY=            # optional; claude-sdk falls back to CC auth
CODEX_BIN=                    # optional codex CLI path
ICOG_API_KEY=                 # optional genome→iCog mirroring
RESEARCH_MAX_USD=             # optional per-run research budget
```

Fallback semantics (`harness/errors.ts` classifies provider errors as
unavailable/auth/quota/transient/model): the brain walks primary →
`BRAIN_FALLBACK`, rotating immediately on unavailable/auth/quota or a bare
nonzero exit, retrying the same provider on transient (once) and model/parse
errors (existing zod-retry budget), capped at 6 attempts total. The harness
does the same at runtime level: a run that dies on a fatal rotatable error
*before any tool call or token* restarts on the next available runtime from
the same `HARNESS_*` list (max 2 fallbacks), carrying spend into the budget cap.

## 7b. Music (the video music bed)

The music bed is a **pluggable provider** resolved by `ensureMusic()` in
`packages/engine/src/media.ts`. Two real backends, then guaranteed-safe fallbacks:

```
MUSIC_PROVIDER=auto    # auto | api | musicgen | none  (default auto)
MUSIC_API_KEY=         # optional; falls back to ELEVENLABS_API_KEY
MUSIC_API_MODEL=music_v1
MUSICGEN_MODEL=facebook/musicgen-medium   # small|medium|large|melody
SOCHELI_EXT_VOLUME=    # external drive root; HF cache lands under .../Socheli/hf-cache
```

Selection (`resolveMusicProvider`): `none` → no bed · `api` → hosted API only ·
`musicgen` → local only (and only if the model is already cached) · `auto` →
the **hosted API** if a key is present, else **local MusicGen** if cached, else
neither. Whatever the backend, the chain then falls through curated loops →
synthesized ambient bed, so a render is **never shipped silent** unless
`MUSIC_PROVIDER=none`.

- **API (recommended, no local RAM):** default is **ElevenLabs Music** —
  `POST https://api.elevenlabs.io/v1/music` with `xi-api-key` and a JSON body
  `{prompt, music_length_ms, model_id}`; returns raw mp3, transcoded to wav and
  tiled to length. Reuses the existing `ELEVENLABS_API_KEY` and the same SOCKS
  egress as TTS. Just set `MUSIC_PROVIDER=api` (or leave `auto` with the key set).
- **Local MusicGen:** runs offline only. It **never downloads in the render
  path** (that froze the machine before). Warm the cache **once**, in a terminal
  you control:

  ```sh
  bash packages/engine/scripts/warm-musicgen.sh
  # or a bigger model:
  MUSICGEN_MODEL=facebook/musicgen-large bash packages/engine/scripts/warm-musicgen.sh
  ```

  The render path preflights the cache, serializes concurrent renders with a
  lockfile (`data/.musicgen.lock`), points HF cache at `data/hf-cache` (the
  external-drive symlink target), and caps generation at 4 min — if the model
  isn't cached it logs a hint and skips to the next provider.

## 8. Non-goals (this build)

- No replacement of the interactive LangGraph copilot loop.
- No new publish targets; missions reuse the existing publisher/phone path.
- No cloud-side mission execution (device-side only, per HYBRID-ARCHITECTURE).
- No engagement/comment management (future phase).
