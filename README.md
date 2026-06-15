<div align="center">

<img src="packages/remotion/public/logos/socheli-mark-light.png" width="76" alt="Socheli" />

# Socheli

**The agentic content engine.** One idea in → a premium, faceless vertical video, end to end —
researched, written, storyboarded, QA-gated, rendered, packaged, and published across YouTube,
Instagram, and TikTok.

[Quickstart](docs/quickstart.md) · [Architecture](docs/architecture.md) · [API](docs/api.md) · [SDK](docs/sdk.md) · [CLI](docs/cli.md) · [MCP](docs/mcp.md) · [Harness](docs/harness.md) · [Fleet](docs/fleet.md)

</div>

---

## What it is

Socheli turns a single prompt into a finished, on-brand short. The pipeline is fully agentic:
trends → scored concept board → hook → script → storyboard → fact-check → QA council →
scene-synced voice + karaoke captions → ducked music bed → graded b-roll → branded outro →
per-platform captions → thumbnail → publish.

It runs as a **distributed system**: an always-on control plane (dashboard + API + scheduler) and
a **fleet** of render devices that pick up jobs over MQTT, render locally, and sync results back.
Add a machine, it joins the pool.

## Surfaces

Socheli is built API-first. Every surface speaks to the same control plane.

| Surface | Package | What it's for |
|---|---|---|
| **HTTP API** | [`@socheli/api`](packages/api) | The backbone. REST, API-key auth. Everything else consumes it. |
| **SDK** | [`@socheli/sdk`](packages/sdk) | Typed TypeScript client. Zero deps. `createSocheli({ apiKey })`. |
| **CLI** | [`@socheli/cli`](packages/cli) | `socheli generate "…"`, `socheli fleet`, `socheli publish …`. |
| **MCP** | [`@socheli/mcp`](packages/mcp) | Model Context Protocol server — let Claude (or any agent) drive Socheli. |
| **Dashboard** | [`apps/dashboard`](apps/dashboard) | The web app (Next.js + Clerk) — War Room, Queue, Autopilot, Devices. |
| **Engine** | [`@os/engine`](packages/engine) | The generation/render pipeline + fleet agent + scheduler. |

## 60-second quickstart

```bash
# install the CLI config (one-time)
socheli login --key <YOUR_API_KEY> --url https://api.socheli.com

socheli fleet                       # see your render devices
socheli generate "why we procrastinate" --channel concept_lab --auto
socheli jobs                        # watch it render on a device
socheli publish <id> --public       # ship it
```

Or from code:

```ts
import { createSocheli } from "@socheli/sdk";

const socheli = createSocheli({ apiKey: process.env.SOCHELI_API_KEY });
const { job } = await socheli.generate({ seed: "the science of habit", channel: "concept_lab", type: "auto" });
const fleet = await socheli.fleet();
```

## Agent Harness

Socheli is agent-native in both directions. Point **any harness** (Claude Code, Codex, any MCP
client) at the full tool registry — 130+ tools over MCP stdio, REST, SDK, and CLI. And Socheli
**drives harnesses back**: channels carry a learned **Brand Genome** that evolves from performance,
a verified deep-**research** loop feeds strategy, and standing **missions** advance the whole
research → plan → create → publish → analyze loop autonomously — each step delegated to a
role-scoped worker on one of four **runtimes** (Claude Agent SDK, headless Claude Code, Codex,
or an OpenRouter tool loop), budgeted and logged. See [docs/harness.md](docs/harness.md).

## Architecture at a glance

```
                   ┌─────────────── control plane (always-on server) ───────────────┐
   you / agents ─► │  Dashboard (Clerk)  @socheli/api  Scheduler  MQTT  media host   │
                   └─────────┬──────────────────┬──────────────────────┬────────────┘
   SDK · CLI · MCP ──────────┘     dispatch job (MQTT)         serve renders (https)
                                            │                          ▲
                                  ┌─────────▼─────────┐   rsync data    │
                                  │   render fleet    │ ────────────────┘
                                  │  M4 · device · …  │  generate + render locally
                                  └───────────────────┘
```

Control travels over MQTT (jobs, presence, progress — tiny). Heavy data (mp4s) is rendered on
devices and rsync'd to the server's public media host. See [docs/architecture.md](docs/architecture.md).

## Repo layout

```
packages/
  engine/    @os/engine     pipeline, fleet agent, scheduler, publisher
  schemas/   @os/schemas    zod single-source-of-truth
  remotion/  @os/remotion   cinematic render components
  tokens/    @os/tokens     design tokens
  sdk/       @socheli/sdk   typed API client (public)
  api/       @socheli/api   HTTP API server (public)
  cli/       @socheli/cli   `socheli` command-line (public)
  mcp/       @socheli/mcp   MCP server (public)
apps/
  dashboard/                Next.js web app
docs/                       architecture, quickstart, api, sdk, cli, mcp, fleet, deployment
```

## Develop

```bash
pnpm install
pnpm dev          # dashboard at http://localhost:4040
pnpm typecheck    # whole workspace
pnpm content      # the engine CLI (local generation)
```

## License

**Open core.** The engine, dashboard, and Remotion compositions are
**AGPL-3.0** (see [LICENSE](LICENSE)); the client packages you build with —
`cli`, `sdk`, `mcp`, `api`, `schemas`, `tokens`, and the mobile app — are
**MIT**. Full breakdown in [LICENSING.md](LICENSING.md).
