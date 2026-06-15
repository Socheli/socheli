# Socheli — Claude Code project guide

Socheli is an agentic faceless-video content engine: one idea goes in, a finished
premium vertical (9:16) or long-form (16:9) post comes out — idea → script →
storyboard → voice/music/b-roll → Remotion render → package → publish. Channels
carry a persistent **Brand Genome (DNA)** of learned hooks/topics/formats, a
verified **research harness** feeds strategy, **missions** run the autonomous
social-media-manager loop, and every capability is exposed through one canonical
tool registry to five surfaces: CLI, HTTP API, MCP, SDK, and the dashboard copilot.

## Monorepo map

- `packages/engine` — the core: pipeline stages, brain, render, publisher,
  `src/tools/registry.ts` (the ONE tool registry: ~130 tools incl. editor tools), `src/dna.ts`
  (genome), `src/research/` (verified research), `src/missions.ts`,
  `src/harness/` (multi-turn agent runtimes + `mcp-stdio.ts` MCP server),
  `src/cli.ts` (the `content` CLI)
- `packages/schemas` — `@os/schemas`: zod schemas (Storyboard, ContentItem,
  BrandGenome, Mission, TenantContext…) shared by everything
- `packages/api` — HTTP API server · `packages/cli` — the `socheli` user CLI ·
  `packages/sdk` — typed client · `packages/mcp` — published MCP package
- `packages/remotion` — video compositions · `packages/tokens` — design tokens
- `apps/dashboard` — Next.js platform UI (copilot, missions, calendar, library)
- `apps/mobile` — Expo/React Native app
- `tools/` — phone publishing agents (Android automation)
- `data/` — ALL persistence: flat JSON (`runs/`, `dna/`, `research/`,
  `missions.json`, `content-plan.json`, `brands.json`, `agent/` task logs)
- `docs/` — specs; start with `docs/AGENT-HARNESS.md` (agent harness v2:
  DNA/research/harness/missions) and `docs/HYBRID-ARCHITECTURE.md` (security model)

## Key commands (run from repo root)

```sh
pnpm typecheck                      # tsc --noEmit over the whole workspace
pnpm dev                            # dashboard dev server
pnpm content <cmd>                  # engine CLI (tsx packages/engine/src/cli.ts)
pnpm socheli <cmd>                  # user-facing CLI
pnpm api                            # HTTP API server
pnpm mcp:socheli                    # MCP server (Content-Length framed)
```

`content` subcommands you'll use most:

```sh
content new "<idea>" --channel <id> [--mood <id>] [--voice] [--preview]
content longform "<topic>" --channel <id>          # 16:9 multi-chapter
content list | show <id> | channels | publish <id> [--public]
content dna <channel> | dna evolve <channel> [--auto] | dna pending <channel>
content dna approve <channel> <id>
content research "<query>" [--kind trend|algo|topic|competitor|deep]
                           [--depth quick|standard|deep] [--channel <id>]
content mission create --channel <id> --goal "…" [--cadence "generate=daily,…"]
content mission list | get <id> | pause <id> | resume <id> | tick [--dry]
content agent-task --role <researcher|strategist|creative|editor|publisher|analyst|channel_manager> "<goal>"
content algo-plan --channel <id> [--days 14]       # research → dated content plan
content tools [--json]                             # print the full tool manifest
content tool <name> '<jsonInput>'                  # call any registry tool directly
```

## Conventions

- **TypeScript ESM run under tsx** — imports use explicit `.ts` extensions
  (`import { x } from "./dna.ts"`). No build step for the engine; `tsx` executes
  source directly.
- **tsx shebang gotcha**: tsx 4.19 cannot parse a file that has BOTH a shebang
  and a dynamic `import()` expression. Files with `#!/usr/bin/env -S node
  --import tsx` must use static imports only (see the note in `cli.ts`).
- **zod at boundaries** — every persisted/transported shape is a zod schema in
  `@os/schemas`; parse at the edges, trust inside.
- **Tenant scoping** — records carry `workspaceId`/`createdBy` (TenantFields);
  tool access is gated by the role matrix (TenantContext in `@os/schemas`).
- **Persistence is flat JSON under `data/`** — atomic writes, no database.
  Never commit secrets or generated media.
- **One registry** — new capabilities land as engine tools in
  `packages/engine/src/tools/` (spread into `registry.ts` `pipelineTools`), so
  CLI/API/MCP/SDK/copilot all get them for free. Long-running tools follow the
  detached-spawn contract: return `{status:"started", pid, logPath}` immediately.
- **Gates are sacred** — publish and DNA-mutation approval gates exist for the
  human. Prepare work up to the gate; never jump it (see HYBRID-ARCHITECTURE).

## Agent harness

- `.claude/skills/` has step-by-step skills: `socheli-post`, `socheli-research`,
  `socheli-plan`, `socheli-dna`, `socheli-publish`.
- MCP servers are pre-wired in `.mcp.json` (`socheli` = full tool registry,
  `socheli-editor` = video-editor tools). Prefer MCP tools over raw CLI.
- `packages/engine/src/harness/mcp-stdio.ts` is the newline-delimited MCP stdio
  server for harnesses that speak line-framed JSON-RPC (e.g. `claude
  --mcp-config`); `SOCHELI_MCP_TOOLS="a,b,c"` restricts which tools it advertises.
- Harness env (see `docs/AGENT-HARNESS.md` §7): `HARNESS_PREMIUM`,
  `HARNESS_DEFAULT`, `ANTHROPIC_API_KEY` (optional), `CODEX_BIN`, `ICOG_API_KEY`,
  `RESEARCH_MAX_USD`.

## Security rule (absolute)

Parts of this repo may be published. NEVER write personal information into any
file: no machine hostnames, no server IPs, no SSH details, no personal emails,
no OAuth client ids, no API keys. Brand-voice contact only: contact@socheli.com.
Public-facing commits use the `Socheli <contact@socheli.com>` identity.
