# Pluggable memory providers

Socheli's long-term memory is **provider-agnostic**. A channel/agent can be
backed by CognitiveX (iCog), [mem0](https://github.com/mem0ai/mem0), an
[Obsidian](https://github.com/coddingtonbear/obsidian-local-rest-api) vault, or a
zero-dependency local JSON store — selected by one env var, swappable without
touching a line of engine, tool, harness, or copilot code.

This is the same seam the two leading open-source agent harnesses converged on
independently — Hermes' Python `MemoryProvider` ABC and OpenClaw's `MemoryBackend`
"slot". The lesson from both (and from mem0/LangChain/Letta): **keep the record
shape tiny and let each adapter own everything behind it.**

## Why it's pluggable (the requirement)

Memory is the most opinionated, most personal part of an agent. Forcing one
backend is the fastest way to lose a user who already runs mem0, lives in
Obsidian, or refuses to send data to any external service. So:

- **Zero-config default.** `local-json` needs no key, no server, no network —
  the repo does `remember → recall` out of the box. This is load-bearing for the
  npx-zero-creds launch (see [VIRAL-PATH.md](./VIRAL-PATH.md)).
- **Upgrade in place.** Drop in a key and `MEMORY_PROVIDER=auto` transparently
  promotes to a semantic/cognitive backend — no migration, same tools.
- **Own your memory.** `obsidian` keeps memory as human-readable, git-versioned
  markdown you fully control; self-hosted `mem0` keeps it in your own vector db.

## The contract

The transport shapes live in `@os/schemas` (`MemoryRecord`, `MemoryScope`,
`MemoryKind`). The behaviour interface lives in
`packages/engine/src/memory/types.ts`:

```ts
interface MemoryProvider {
  readonly name: string;
  available(): boolean;                                   // cheap, network-free

  // core verbs — every backend implements these
  remember(input: RememberInput): Promise<MemoryRecord>;
  recall(query: string, opts?: RecallOpts): Promise<MemoryRecord[]>;
  update(id: string, content: string): Promise<MemoryRecord>;
  forget(id: string): Promise<void>;

  // cognitive verbs — OPTIONAL, capability-detected (`if (provider.learn)`)
  learn?(signal: { outcome: string; scope?: MemoryScope }): Promise<void>;
  reflect?(): Promise<ReflectResult>;
}
```

Four core verbs every backend must implement; two optional cognitive verbs a
dumb store omits and a cognitive backend (iCog, Letta) lights up. Capability
detection at the call site keeps both valid — the same trick the Vercel AI SDK
uses to stay minimal.

`MemoryKind` (`fact | event | howto | identity | trait`) is backend-neutral;
each adapter maps it onto its own taxonomy. `MemoryScope`
(`workspaceId / channelId / userId`) partitions memory so one brand's recall
never bleeds into another's.

## Built-in providers

| provider | backend | semantic recall | `learn`/`reflect` | needs |
|---|---|:--:|:--:|---|
| `local-json` *(default)* | flat JSON under `data/memory/`, lexical rank | – | – | nothing |
| `cogx` | CognitiveX / iCog REST | ✅ | ✅ | `ICOG_API_KEY` |
| `mem0` | managed `api.mem0.ai` **or** self-hosted server | ✅ | – | `MEM0_API_KEY` or `MEM0_BASE_URL` |
| `obsidian` | Obsidian vault via Local REST API | lexical | – | `OBSIDIAN_API_KEY` |

All four live in `packages/engine/src/memory/`. Adding a fifth is a one-file add
implementing `MemoryProvider`, registered in `index.ts`.

## Configuration

```sh
MEMORY_PROVIDER=auto          # default: first configured external, else local-json
MEMORY_PROVIDER=local-json    # force the zero-dep local store
MEMORY_PROVIDER=cogx          # CognitiveX / iCog
MEMORY_PROVIDER=mem0          # mem0
MEMORY_PROVIDER=obsidian      # Obsidian vault
```

`auto` prefers a configured cognitive backend (`cogx → mem0 → obsidian`) and
falls back to `local-json`. An explicit value is honoured even if its env is
missing — the actionable error then surfaces on first use instead of silently
degrading.

Per-backend env is documented at the top of each adapter file
(`cogx.ts`, `mem0.ts`, `obsidian.ts`).

## The tools (all five surfaces)

`memory-tools.ts` spreads into the one registry, so CLI/API/MCP/SDK/copilot all
get them:

| tool | kind | notes |
|---|---|---|
| `memory_recall` | read | search; optional `channel` scope + `kind` filter |
| `memory_remember` | mutate | persist a durable fact |
| `memory_update` | mutate | correct by id |
| `memory_forget` | mutate | delete by id (idempotent) |
| `memory_learn` | mutate | outcome signal — **cognitive backends only** (clear error otherwise) |
| `memory_reflect` | read | active provider + capability flags + backend self-state |

```sh
pnpm content tool memory_remember '{"content":"…","kind":"fact","channel":"labrinox"}'
pnpm content tool memory_recall   '{"query":"…","channel":"labrinox"}'
pnpm content tool memory_reflect  '{}'
```

## The deeper play — memory as the substrate behind the harness

Today the Brand Genome's learning loop is a thin, capped window (`learnings.json`
read as `.slice(0, 8)`; evolution capped at 100; traits at 24). Backing it with a
real memory provider turns "agents with amnesia" into a system that *compounds*:

1. **Genome evolution** (`dna.ts evolveGenome`) — ✅ **wired**. Each evolve
   `recall`s accumulated channel memory as evidence (a real signal that flips the
   no-op gate), `remember`s every applied mutation as a recallable `trait` fact,
   and emits a `learn(outcome)` of the post-performance (scorecard) that drove it
   — on cognitive backends. This replaced the old hardwired iCog mirror, so the
   loop now compounds across runs through whatever backend is selected instead of
   being capped at `learnings.json`'s window. (When `MEMORY_PROVIDER=cogx` it
   preserves the old "mirror genome drift to iCog" behaviour exactly.)
2. **Harness roles** (`harness/roles.ts`) — give `researcher`/`analyst`/
   `strategist` the `memory_*` tools so deep agent tasks accumulate context
   across sessions instead of starting cold. *(next)*
3. **Research** (`research/orchestrator.ts`) — `remember` verified claims so the
   fact graph accrues across runs. *(next)*

Because every one of these goes through `getMemoryProvider()`, the user's choice
of backend (local, iCog, mem0, Obsidian) flows through the whole agent for free.

> The CogX/iCog SDK wiring is a related but separate workstream —
> see [cognitivx-sdk-integration.md](./cognitivx-sdk-integration.md). The `cogx`
> adapter here is the engine-side, REST-based path; it can later sit on the typed
> SDK without changing the `MemoryProvider` contract.
