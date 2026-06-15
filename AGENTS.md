# Socheli — agent harness guide

This file is for ANY coding/agent harness working in this repo (Codex, Claude
Code, or others). It mirrors `CLAUDE.md` and adds MCP connection details.

## What Socheli is

An agentic faceless-video content engine: one idea in, a finished premium
vertical (9:16) or long-form (16:9) post out — idea → script → storyboard →
voice/music/b-roll → Remotion render → package → publish. Channels carry a
persistent Brand Genome (DNA) of learned traits, a verified research harness
feeds strategy, and a missions orchestrator runs the autonomous
social-media-manager loop. Every capability is one engine tool exposed to five
surfaces (CLI, HTTP API, MCP, SDK, dashboard copilot) via a single registry.

## Monorepo map

| Path | What |
| --- | --- |
| `packages/engine` | Core: pipeline, brain, render, publisher; `src/tools/registry.ts` (canonical ~130-tool registry); `src/dna.ts`, `src/research/`, `src/missions.ts`, `src/harness/` (agent runtimes + MCP stdio server); `src/cli.ts` (the `content` CLI) |
| `packages/schemas` | `@os/schemas` — shared zod schemas (Storyboard, ContentItem, BrandGenome, Mission, TenantContext) |
| `packages/api` / `packages/cli` / `packages/sdk` / `packages/mcp` | HTTP API server / `socheli` user CLI / typed client / published MCP package |
| `packages/remotion` / `packages/tokens` | Video compositions / design tokens |
| `apps/dashboard` / `apps/mobile` | Next.js platform UI / Expo app |
| `tools/` | Phone-publishing agents (Android automation) |
| `data/` | ALL persistence — flat JSON (`runs/`, `dna/`, `research/`, `missions.json`, `content-plan.json`, `brands.json`, `agent/`) |
| `docs/` | Specs — start with `docs/AGENT-HARNESS.md` and `docs/HYBRID-ARCHITECTURE.md` |

## Commands (repo root, pnpm workspace)

```sh
pnpm typecheck                 # tsc --noEmit across the workspace
pnpm dev                       # dashboard dev server
pnpm content <cmd>             # engine CLI — see below
pnpm socheli <cmd>             # user-facing CLI
pnpm api                       # HTTP API server
```

Engine CLI highlights: `content new "<idea>" --channel <id>`, `content longform
"<topic>"`, `content list|show <id>|channels`, `content publish <id>
[--public]`, `content dna <channel>` / `dna evolve <channel> [--auto]` / `dna
pending|approve`, `content research "<query>" [--kind …] [--depth …]`,
`content mission create|list|get|pause|resume|tick [--dry]`, `content
agent-task --role <role> "<goal>"`, `content algo-plan --channel <id>`,
`content tools [--json]` (print the tool manifest), `content tool <name>
'<json>'` (call any registry tool directly).

## Conventions

- TypeScript ESM executed by `tsx` — imports carry explicit `.ts` extensions;
  no build step for the engine.
- tsx 4.19 gotcha: a file cannot have BOTH a shebang and a dynamic `import()`
  expression — shebang'd entrypoints use static imports only.
- zod at every boundary (`@os/schemas`); parse at the edges.
- Tenant scoping: records carry `workspaceId`/`createdBy`; access is gated by
  the role matrix (TenantContext).
- Persistence is flat JSON under `data/` — never commit secrets or media.
- New capabilities land as registry tools in `packages/engine/src/tools/` so
  all surfaces inherit them. Long-running tools spawn detached and return
  `{status:"started", pid, logPath}` immediately — poll, don't re-fire.
- Gates (publish approval, DNA-mutation approval) are for the human: prepare
  work to the gate, never jump it.

## Connect via MCP

The full tool registry (~130 tools: `pipeline_*`, `draft_*`, `editor_*`, `plan_*`,
`publish_*`, `research_*`, `dna_*`, `mission_*`, `agent_run_task`, …) is served
over MCP stdio. Two wire framings exist — pick the one your harness speaks:

**Newline-delimited JSON-RPC** (current MCP stdio transport; what Claude Code's
`--mcp-config` and most modern clients speak) — `packages/engine/src/harness/mcp-stdio.ts`:

```json
{
  "mcpServers": {
    "socheli": {
      "command": "node",
      "args": ["--import", "tsx", "packages/engine/src/harness/mcp-stdio.ts"],
      "cwd": "<absolute path to this repo>"
    }
  }
}
```

It implements `initialize`, `ping`, `tools/list`, `tools/call`. Set
`SOCHELI_MCP_TOOLS="tool_a,tool_b"` in its env to restrict which tools it
advertises/accepts (recommended for small models — the full manifest is large).

**Content-Length framed** (LSP-style, for clients that require it) — the
`.mcp.json` in this repo wires it as `pnpm mcp:socheli`
(`packages/engine/src/socheli-mcp.ts`), plus `pnpm editor:mcp` for the
`socheli-editor` video-editing tool set.

Other surfaces:

- **HTTP API**: `pnpm api` serves `@socheli/api`; authenticate with an API key
  header. See `docs/api.md`.
- **CLI**: everything MCP can do, `content tool <name> '<json>'` can do too.
- **Socheli spawning harnesses** (the reverse direction): the engine delegates
  goals to Claude Agent SDK / headless Claude Code / Codex / OpenRouter via
  `agent_run_task` — env knobs `HARNESS_PREMIUM`, `HARNESS_DEFAULT`,
  `CLAUDE_BIN`, `CODEX_BIN` (see `docs/AGENT-HARNESS.md` §3 + §7).

## Security rule (absolute)

Parts of this repo may be published. NEVER write personal information into any
file: no machine hostnames, no server IPs, no SSH details, no personal emails,
no OAuth client ids, no API keys. Brand-voice contact only: contact@socheli.com.
Public-facing commits use the `Socheli <contact@socheli.com>` identity.
