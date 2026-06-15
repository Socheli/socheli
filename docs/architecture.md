# Architecture

Socheli is an API-first distributed content engine: one idea becomes a finished vertical video. The system is deliberately structured as a layer cake — a node-only **engine** at the bottom, a single **REST API** as the public backbone, and three uniform **clients** (SDK, CLI, MCP) on top — joined to a fleet of render devices by a **control-plane / data-plane split**. There is no database; all state lives in flat `data/*.json` files. One static Bearer key (`SOCHELI_API_KEY`) authenticates every public surface.

This page explains how those pieces compose, where state lives, and exactly what happens when you ask Socheli to generate a video.

## The layer cake

```
        ┌──────────────┐   ┌──────────────┐   ┌──────────────┐
clients │ @socheli/cli │   │ @socheli/mcp │   │  dashboard   │
        │  (socheli)   │   │  (6 tools)   │   │ (Next+Clerk) │
        └──────┬───────┘   └──────┬───────┘   └──────┬───────┘
               │  built on        │  built on        │
               └────────┬─────────┴──────────────────┘
                        ▼
                ┌──────────────────┐    SocheliClient: health / items /
   typed client │   @socheli/sdk   │    generate / jobs / fleet / schedule
                │  createSocheli() │    fetch → `${baseUrl}/v1${path}`, Bearer
                └────────┬─────────┘
                         │  HTTPS  Authorization: Bearer <SOCHELI_API_KEY>
                         ▼
   control-plane  ┌──────────────────────┐
   backbone       │  @socheli/api (Hono) │  api.socheli.com  (:8787 behind Caddy)
                  │  /v1/* Bearer auth    │
                  └───┬──────────────┬────┘
            reads     │              │   writes
        ┌─────────────┘              └──────────────┐
        ▼                                           ▼
 ┌───────────────┐                        ┌───────────────────────┐
 │  file store   │                        │  POST /v1/generate    │
 │ data/runs/*   │                        │  match.ts → pickDevice│
 │ jobs.json     │                        │  → MQTT dispatch      │
 │ fleet.json    │                        │  POST .../publish     │
 │ schedule.json │                        │  → spawn engine CLI   │
 └───────────────┘                        └───────────┬───────────┘
                                                       │ MQTT qos:1
                              socheli/device/<id>/jobs │ (control-plane)
                                                       ▼
                          ┌──────────────────────────────────────────┐
                          │  render device (your render machine) — fleet agent   │
                          │  runs the full engine pipeline LOCALLY     │
                          │  research→script→storyboard→QA→voice→      │
                          │  captions→music→b-roll→package             │
                          └───────┬───────────────────────┬───────────┘
                progress (MQTT)   │                       │  rsync data/ up
                                  ▼                       ▼  (data-plane)
                          ┌──────────────┐      ┌────────────────────────┐
                          │ content      │      │  Caddy media file srv  │
                          │ bridge →     │      │  media.socheli.com/    │
                          │ jobs.json    │      │  <id>.mp4              │
                          │ fleet.json   │      └────────────────────────┘
                          └──────────────┘
```

The arrows that matter most: **tiny control messages flow over MQTT; heavy artifacts (mp4s) never touch the message bus** — they travel by `rsync` and are served over HTTPS. The API server itself never renders.

## Engine core

The engine (`packages/engine`) is a node-only TypeScript pipeline plus the fleet agent, scheduler, and publisher. The pipeline takes an idea through: research → concept board → hook → script → storyboard → fact-check → QA council → scene-synced voice + karaoke captions → ducked music → graded b-roll → outro → per-platform packaging → publish.

Every engine capability is unified into a single **canonical tool registry** at `packages/engine/src/tools/registry.ts`. This is the one source of truth that every other surface consumes. Each registry tool carries:

| Field | Purpose |
| --- | --- |
| `name` / `description` / `inputSchema` | The advertised tool contract (hand-authored JSON Schema) |
| zod schema | Real argument validation inside `callTool` |
| `kind` | `"read"` \| `"mutate"` \| `"long"` |

`kind: "long"` tools (`generate`, `longform`, `autopilot`, `publish`, `render`, `board`) do **not** block: their handler spawns a detached `node --import tsx` engine process and returns a started/job result immediately. Callers poll jobs for completion.

The registry exports the surface every adapter builds on:

```ts
allTools                                  // the full tool list
callTool(name: string, input: unknown):   // → ToolResult { ok; data?; message? }
  Promise<ToolResult>
toolsManifest():                          // → { name, description, inputSchema, kind }[]
  ToolManifestEntry[]
```

Two thin adapters expose this registry in-process (node-only, no API key required):

- **`packages/engine/src/socheli-mcp.ts`** — a comprehensive stdio JSON-RPC MCP server with full registry parity. It maps `toolsManifest()` → `tools/list` and `callTool()` → `tools/call`, adds a `ping` method, and attaches a non-standard `_meta.kind` hint per tool. This is the server that powers the in-repo agent.
- **`packages/engine/src/tool.ts`** — a spawn-friendly CLI runner the dashboard and API invoke: `tool --manifest` or `tool <name> [jsonInput]`. **Stdout carries only JSON** (the manifest or a `ToolResult`); diagnostics go to stderr; the exit code reflects `result.ok`.

A shared curl wrapper (`packages/engine/src/http.ts`) sits at this layer for outbound calls. Google APIs route through a SOCKS5 proxy (`proxy: true`, `socks5h://127.0.0.1:11080`) because they are geo-blocked in some regions; Meta, TikTok, and object storage go direct. A `proxyReachable()` preflight guards the tunnel — if it's down, YouTube uploads silently no-op.

> **Two MCP servers, easy to confuse.** The engine's `socheli-mcp.ts` is the comprehensive, in-process, node-only superset. The published `@socheli/mcp` package (below) is the *lean* server with 6 tools that talks to the REST API over HTTP. Quickstarts wire up the lean one.

## REST API — the control-plane backbone

`@socheli/api` (`packages/api/src/server.ts`) is the Hono server every public client talks to. It runs on port `8787` (`SOCHELI_API_PORT`) behind Caddy as `https://api.socheli.com`. Every route lives under `/v1` and returns JSON. CORS is fully open (`app.use("*", cors())` → `Access-Control-Allow-Origin: *`).

### Auth

A single middleware on `/v1/*` enforces a static Bearer key with strict equality:

```ts
app.use("/v1/*", async (c, next) => {
  if (c.req.path === "/v1/health") return next();       // only exempt route
  const key = (c.req.header("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!API_KEY) return c.json({ error: "API not configured (no SOCHELI_API_KEY)" }, 503);
  if (key !== API_KEY) return c.json({ error: "unauthorized" }, 401);
  return next();
});
```

There are no per-user keys, scopes, or rotation. If `SOCHELI_API_KEY` is unset the server still boots (logging a warning) but returns `503` for every authenticated route. Because CORS is wide open and the key is static, **the key must never be embedded in browser-facing code**. The production key lives in `/opt/socheli/.env`.

### Endpoints

| Method | Path | Effect |
| --- | --- | --- |
| `GET` | `/v1/health` | Unauthenticated liveness: `{ ok, version, uptime }` |
| `GET` | `/v1/items?limit&channel` | Lists `ItemSummary[]` from `data/runs/*.json` (newest first) |
| `GET` | `/v1/items/:id` | Full `Item` (idea/script/storyboard/pkg/videoUrl) or `404` |
| `POST` | `/v1/generate` | Builds a job, routes it, dispatches over MQTT |
| `GET` | `/v1/jobs` | 30 most recent `JobRow[]` from `data/jobs.json` |
| `GET` | `/v1/fleet` | `FleetState { devices, jobs, online }` (offline computed at read time) |
| `POST` | `/v1/items/:id/publish` | Spawns the detached engine publish CLI |
| `GET` / `PUT` | `/v1/schedule` | Read / replace the autopilot `Schedule` |

Reads are served synchronously from the file store. Writes either dispatch a job over MQTT (`POST /v1/generate`) or spawn the engine CLI (`POST .../publish`, which runs `node --import tsx packages/engine/src/cli.ts publish <id>` detached, `stdio: "ignore"`, returning `{ dispatched: true }` immediately — failures are invisible to the caller).

## State model — flat files, no database

`packages/api/src/store.ts` is the entire read layer. There is no DB; the API never owns one.

| File / dir | Holds | Read by |
| --- | --- | --- |
| `data/runs/<id>.json` | One content item per file | `listItems`, `getItem` |
| `data/jobs.json` | `{ jobs: JobRow[] }` | `getJobs` |
| `data/fleet.json` | `{ devices: Record<string, Device> }` | `getFleet` |
| `data/schedule.json` | Autopilot `Schedule` | `getSchedule`; written by `PUT /v1/schedule` |

`DATA_DIR` is overridable via `SOCHELI_DATA_DIR`, renders via `SOCHELI_RENDERS_DIR`, and the public media base via `HOST_PUBLIC_BASE` (default `https://media.socheli.com`).

Two behaviors are worth internalizing:

**Device liveness is inferred, not pushed.** `getFleet()` overrides any stored status to `offline` when `lastSeen` is older than `STALE_MS = 70_000`:

```ts
const STALE_MS = 70_000;
const stale = now - new Date(d.lastSeen).getTime() > STALE_MS;
return stale && d.status !== "offline" ? { ...d, status: "offline" as const } : d;
```

A device that stops heart-beating silently drops out of routing, so heartbeats must be more frequent than 70 s.

**Internal items are projected to lean public DTOs.** `toSummary()` / `toItem()` map raw run files into the stable contract in `packages/sdk/src/types.ts` — `qa` comes from `it.qa.overall`, `costUsd` from `it.ledger.totalUsd`, and `videoUrl` is computed as `${HOST_PUBLIC_BASE}/<id>.mp4` only when a render exists. The public DTOs are deliberately decoupled from the engine's internal zod schemas, so the API never returns raw engine objects. Reads are forgiving: a corrupt JSON file degrades to defaults (`readJson` catches and returns the fallback) rather than erroring.

An item moves through a defined status lifecycle:

```ts
type ItemStatus =
  | "idea_proposed" | "script_ready" | "storyboard_ready"
  | "qa_passed" | "qa_failed" | "rendered" | "packaged" | "failed";
```

## SDK, CLI, and MCP — three uniform clients

All three public clients share one contract and one auth model.

### @socheli/sdk

The zero-dependency, fetch-based TypeScript client (`packages/sdk/src/index.ts`). `createSocheli()` resolves the key (`opts.apiKey` → `SOCHELI_API_KEY`), base URL (`opts.baseUrl` → `SOCHELI_API_URL` → `https://api.socheli.com`, trailing slash stripped), and a fetch impl. Every call goes through a private `req<T>` helper that injects the `/v1` prefix and the Bearer header, and throws `SocheliError(message, status, body)` on non-2xx.

```ts
import { createSocheli } from "@socheli/sdk";
const socheli = createSocheli({ apiKey: process.env.SOCHELI_API_KEY });

const { online, devices } = await socheli.fleet();
const { dispatched, job } = await socheli.generate({
  seed: "why we procrastinate", channel: "concept_lab", type: "auto",
});
const rows = await socheli.jobs();              // poll for completion
await socheli.items.publish(job.id, { public: true });
```

The client groups item/schedule operations under nested objects and exposes `health`, `generate`, `jobs`, `fleet` at the top level. The `/v1` prefix is injected inside `req` — pass the **host root** as `baseUrl`, never include `/v1` yourself.

### Socheli CLI

`@socheli/cli` (`packages/cli/src/index.ts`) is a thin remote control built **on** the SDK — a single ~107-line file run directly as TypeScript (`#!/usr/bin/env -S node --import tsx`, `bin.socheli` points at the source). It resolves credentials env-first (`SOCHELI_API_URL` / `SOCHELI_API_KEY`), then `~/.socheli/config.json` (written by `socheli login`).

```bash
socheli login --key sk_live_xxx --url https://api.socheli.com   # writes ~/.socheli/config.json
socheli fleet                                                   # render devices online
socheli generate "why we procrastinate" --channel concept_lab --auto
socheli jobs                                                    # watch it render
socheli publish <id> --public                                  # ship it
```

> This published `socheli` CLI is **not** `pnpm content` / the engine CLI (`packages/engine/src/cli.ts`). The former is a thin SDK-over-API remote control; the latter is the local in-process engine the API spawns for publishing. Don't conflate them.

### @socheli/mcp

The lean stdio JSON-RPC MCP server (`packages/mcp/src/index.ts`), also built on the SDK, exposing 6 high-level tools so any agent can drive Socheli: `socheli_list_items`, `socheli_get_item`, `socheli_generate`, `socheli_jobs`, `socheli_fleet_status`, `socheli_publish`. It speaks LSP-style `Content-Length`-framed JSON-RPC and passes `SOCHELI_API_KEY` / `SOCHELI_API_URL` straight into `createSocheli`.

```json
{ "mcpServers": { "socheli": {
  "command": "node", "args": ["--import", "tsx", "packages/mcp/src/index.ts"],
  "env": { "SOCHELI_API_URL": "https://api.socheli.com", "SOCHELI_API_KEY": "sk_live_xxx" }
} } }
```

Handler errors (e.g. a `SocheliError` 401) are returned as *soft* tool results (`isError: true`, text `error: <msg>`), not JSON-RPC protocol errors — only an unknown tool name yields a real `-32601`.

## Control plane vs data plane

This split is the system's defining design decision.

| | Control plane | Data plane |
| --- | --- | --- |
| **Carries** | Job dispatch, device presence, render progress | Rendered `.mp4` artifacts |
| **Transport** | MQTT (Mosquitto, `wss://mqtt.socheli.com`; server dispatch via `mqtt://127.0.0.1:1883`) | `rsync` device → server, then HTTPS via Caddy |
| **Topics / endpoints** | `socheli/device/<id>/jobs` (dispatch), progress/presence | `media.socheli.com/<id>.mp4` |
| **Size** | Tiny JSON messages | Heavy video files |

The API dispatches jobs to a device's MQTT topic (one fresh connection per request: `connectAsync → publishAsync → endAsync`, QoS 1, 8 s connect timeout — no pooled connection). A server-side **content bridge** projects MQTT presence/progress back into `data/fleet.json` and `data/jobs.json`. Meanwhile, render devices generate locally and `rsync` their `data/` up to the server, where a Caddy file server publishes the mp4. **The server never renders, and video never crosses the message bus.**

### Capability-aware scheduling

`packages/api/src/match.ts` is the central scheduler. `jobRequirements()` derives a job's needs — generation jobs require the hard cap `render` and *prefer* `voice:eleven` (when `voice: true`), `music:musicgen`, `broll:sdturbo`, `broll:pexels`. `pickDevice()` then filters to online devices that hold all hard caps and scores them:

```ts
const score = (d: Device) => {
  let s = d.status === "idle" ? 100 : 0;                 // strongly prefer idle
  for (const c of reqs.prefer) if ((d.caps ?? []).includes(c)) s += 10;
  s += (d.profile?.ramGb ?? 0) / 8;                      // tie-break: more RAM
  return s;
};
```

The highest-scoring device wins; the `reason` ("idle · 4/4 caps", or why no device matched) is returned to the caller.

## Lifecycle of a generate request

Tracing `POST /v1/generate` from client to live video:

1. **Client → API.** An SDK/CLI/MCP/dashboard client sends `POST /v1/generate` (body `GenerateInput { seed, channel?, mood?, voice?, type? }`) to `api.socheli.com` over HTTPS with the Bearer key. Only `seed` is required.
2. **Auth + job build.** The `/v1/*` middleware authorizes the key. The handler builds a job, generating a server-side id (`job_<base36 time><random>`), defaulting `channel` to `concept_lab` and coercing `type` to `auto` or `new`.
3. **Capability routing.** `jobRequirements(job)` derives `{ hard: ["render"], prefer: [...] }`; `pickDevice(getFleet().devices, reqs)` picks the best-fit *online* device.

   ```ts
   const reqs  = jobRequirements(job);                 // hard:[render], prefer:[voice/music/broll]
   const match = pickDevice(getFleet().devices, reqs); // idle > busy, +RAM tiebreak
   if (!match.device) return c.json({ error: match.reason, requirements: reqs }, 503);
   await dispatch(`socheli/device/${match.device.device}/jobs`, job); // MQTT qos:1
   return c.json({ dispatched: true, job, device: match.device.device, routing: match.reason });
   ```
4. **Dispatch over MQTT.** The job JSON is published to `socheli/device/<device>/jobs` at QoS 1, and the API returns `{ dispatched, job, device, routing }` *immediately*. It does not wait for the render.
5. **Device renders locally.** The chosen device's fleet agent claims the job and runs the full engine pipeline on its own hardware (e.g. a Mac with enough CPU/RAM), streaming progress events back over MQTT. The content bridge records them into `data/jobs.json` and `data/fleet.json`.
6. **Artifact published.** On completion the device `rsync`s its `data/` up to the server. Caddy serves the result at `media.socheli.com/<id>.mp4`, and `data/runs/<id>.json` is written so the API can serve item detail with a computed `videoUrl`.
7. **Caller polls.** Because generation is fire-and-forget, the caller polls `GET /v1/jobs` (or `socheli jobs`) and reads `progress` until the `JobRow.status` reaches `done`.
8. **Publish (optional).** `type: "auto"` publishes after render; otherwise `POST /v1/items/:id/publish` spawns the engine publish CLI server-side, which pushes to YouTube/IG/TikTok using the public media URL.

### Generate failure modes

`POST /v1/generate` can fail at three distinct layers, each with its own status code:

| Code | Cause | Body |
| --- | --- | --- |
| `400` | `seed` missing | `{ error: "seed required" }` |
| `503` | No online device with the required `render` cap | `{ error: <reason>, requirements }` |
| `502` | MQTT broker unreachable | `{ error: "broker unreachable: <msg>" }` |

## Three separate auth systems

Don't assume one credential covers everything:

| System | Surfaces | Credential |
| --- | --- | --- |
| Static Bearer key | API, SDK, CLI, MCP | `SOCHELI_API_KEY` (`/opt/socheli/.env`) |
| MQTT broker | Server-side dispatch only | `SOCHELI_BROKER_URL`, `SOCHELI_MQTT_USER`, `SOCHELI_MQTT_PASS` |
| Clerk | Dashboard (`apps/dashboard`) | Separate, user-facing |

The in-process engine MCP server (`socheli-mcp.ts`) needs no API key at all — it runs against the engine directly via local filesystem access.
