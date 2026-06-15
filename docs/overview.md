# Overview

**Socheli is an agentic faceless-video engine.** You give it one idea — `"why we procrastinate"` — and it returns a finished, premium vertical video, packaged and published to YouTube, Instagram, and TikTok. Research, scripting, storyboarding, fact-checking, scene-synced voice, karaoke captions, ducked music, graded b-roll, per-platform packaging, and publishing all happen end to end.

The product motto is the shape of the whole system: **Create. Publish. Grow.**

- **Create** — one seed becomes a rendered, QA-passed video.
- **Publish** — ship it to every configured platform, or schedule it on autopilot.
- **Grow** — track items, jobs, the render fleet, and the posting cadence as a managed system.

Socheli is **API-first**. There is one backbone — a single REST API at `api.socheli.com` — and everything else (the typed SDK, the `socheli` CLI, the MCP server, the dashboard) is a client of it. One Bearer key, one contract, one set of endpoints, four ways to drive them.

```bash
# the whole product in four lines
socheli login --key sk_live_xxx --url https://api.socheli.com
socheli fleet                                              # render devices online?
socheli generate "why we procrastinate" --channel concept_lab --auto
socheli publish <id> --public                              # ship it
```

## The product stack

Socheli is a strict layer cake. Pick the surface that fits how you build — they all speak the same `/v1` REST contract and share the same data shapes.

| Surface | Package | What it is | Reach for it when |
|---|---|---|---|
| **REST API** | `@socheli/api` | Hono server on `:8787` behind Caddy → `api.socheli.com`. The backbone everything else consumes. | You're integrating from any language, or want raw `curl`. |
| **TypeScript SDK** | `@socheli/sdk` | Zero-dependency, `fetch`-based typed client: `createSocheli()`. | You're in TypeScript/JavaScript (Node 18+, Bun, Deno, edge). |
| **CLI** | `@socheli/cli` | The `socheli` command — a thin remote control built on the SDK. | You want to drive Socheli from a shell or a script. |
| **MCP server** | `@socheli/mcp` | A stdio JSON-RPC Model Context Protocol server exposing 6 tools. | You want an agent (Claude Desktop / Claude Code) to operate Socheli. |

Every surface resolves the same two environment variables:

| Variable | Default | Meaning |
|---|---|---|
| `SOCHELI_API_KEY` | — | Bearer API key. Sent as `Authorization: Bearer <key>`. |
| `SOCHELI_API_URL` | `https://api.socheli.com` | API base URL. The `/v1` prefix is added by the client; do **not** include it here. |

## What you can build

The control-plane surface is small and uniform. These are the operations available through every client:

| Capability | REST | SDK | What it does |
|---|---|---|---|
| Health | `GET /v1/health` | `client.health()` | Liveness + version + uptime. The only unauthenticated route. |
| List items | `GET /v1/items` | `client.items.list()` | Recent content items (id, status, QA score, title), filterable by `channel`. |
| Get item | `GET /v1/items/:id` | `client.items.get(id)` | Full item: idea, script, storyboard, package, and `videoUrl`. |
| Generate | `POST /v1/generate` | `client.generate(input)` | Dispatch a render job to the device fleet from a seed idea. |
| Publish | `POST /v1/items/:id/publish` | `client.items.publish(id, input)` | Push a finished item to YouTube / IG / TikTok. |
| Jobs | `GET /v1/jobs` | `client.jobs()` | Live job queue/history with status and which device ran each. |
| Fleet | `GET /v1/fleet` | `client.fleet()` | Render devices and how many are online. |
| Schedule | `GET` / `PUT /v1/schedule` | `client.schedule.get()` / `.set(s)` | Read or replace the autopilot posting schedule. |

### Generate a video, from code

```ts
import { createSocheli } from "@socheli/sdk";

// apiKey falls back to SOCHELI_API_KEY, baseUrl to SOCHELI_API_URL || https://api.socheli.com
const socheli = createSocheli({ apiKey: process.env.SOCHELI_API_KEY });

// who can render right now?
const { online, devices } = await socheli.fleet();

// type "auto" renders AND publishes; "new" builds only (default)
const { dispatched, job } = await socheli.generate({
  seed: "the science of habit",
  channel: "concept_lab",
  mood: "cinematic",
  voice: true,
  type: "auto",
});

// poll for completion — generation is asynchronous
const rows = await socheli.jobs();
const mine = rows.find((r) => r.id === job.id);
console.log(mine?.status, mine?.progress.at(-1)?.line);
```

### Let an agent drive it (MCP)

Wire `@socheli/mcp` into any MCP client and the model gets six high-level tools — `socheli_list_items`, `socheli_get_item`, `socheli_generate`, `socheli_jobs`, `socheli_fleet_status`, `socheli_publish`.

```json
{
  "mcpServers": {
    "socheli": {
      "command": "node",
      "args": ["--import", "tsx", "packages/mcp/src/index.ts"],
      "env": {
        "SOCHELI_API_URL": "https://api.socheli.com",
        "SOCHELI_API_KEY": "sk_live_xxx"
      }
    }
  }
}
```

### Hit it raw (REST)

```bash
curl -s -X POST https://api.socheli.com/v1/generate \
  -H "Authorization: Bearer $SOCHELI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"seed":"why we procrastinate","channel":"concept_lab","type":"auto","voice":false}'
# → {"dispatched":true,"job":{...},"device":"render-01","routing":"idle · 4/4 caps"}
```

## How it works

Under the surfaces, Socheli is a **distributed system with a clean control/data split**. Two facts explain almost everything about its behavior.

**The server never renders.** Generation and Remotion rendering happen only on **render devices** (e.g. a Mac with enough CPU/RAM) that have the CPU/RAM/GPU for it. When you call `POST /v1/generate`, the API derives the job's capability requirements, picks the best-fit online device with a capability-aware scheduler (hard requirement: the `render` cap; preferences for voice/music/b-roll; scored idle-first, then by RAM), and publishes the job to that device's **MQTT** topic. The device runs the full pipeline locally, streaming progress back over MQTT.

**Video never crosses the message bus.** Tiny control messages — job dispatch, device presence, render progress — flow over MQTT. Heavy artifacts (rendered mp4s) are produced on the device and **rsync'd** to the server's public media host, where a file server serves them at `media.socheli.com/<id>.mp4` for IG/TikTok pull and dashboard playback. That URL is the item's `videoUrl`.

```
   you / agents ─► control plane (always-on server)
   SDK · CLI · MCP ──► @socheli/api ──dispatch job (MQTT)──► render fleet
                              ▲                                   │
                              └────────rsync data / serve mp4─────┘
```

There is **no database** — all state lives in flat JSON files (one file per content item, plus job/fleet/schedule files) that the API reads directly. The publicly returned data shapes are deliberately decoupled from the engine's internals, so the contract stays stable across versions.

A note on liveness: a device is reported **offline** if it hasn't sent a heartbeat in the last **70 seconds**, regardless of its last stored status. A device that stops heart-beating silently drops out of routing — which is why `generate` can return `503` with the derived requirements when no capable device is online.

## Authentication

Every surface authenticates with a **single static Bearer API key** (`SOCHELI_API_KEY`). The API middleware guards all `/v1/*` routes:

- **`GET /v1/health`** is the only exempt route — always open.
- A **missing or wrong** key returns `401`.
- If the server itself has **no key configured**, every `/v1` route returns `503`.

Because CORS is open and the key is static with no scopes or per-user rotation, the key must **never** be embedded in browser-facing code.

> The dashboard's auth is separate (Clerk), and the MQTT broker has its own credentials. The API/SDK/CLI/MCP share the one Bearer key.

## Errors

Across the typed surfaces, any non-2xx HTTP response throws a `SocheliError` carrying the HTTP `status` and the parsed `body`:

```ts
import { SocheliError } from "@socheli/sdk";

try {
  await socheli.items.get("does-not-exist");
} catch (e) {
  if (e instanceof SocheliError) {
    console.error(e.status, e.message, e.body); // e.g. 404, error text, parsed body
  }
}
```

`POST /v1/generate` is the one call with multiple distinct failure layers worth knowing:

| Status | Meaning |
|---|---|
| `400` | `seed` is missing. |
| `503` | No online device has the required `render` capability (the body includes the derived requirements). |
| `502` | The MQTT broker is unreachable. |

## Where to go next

| You want to… | Go to |
|---|---|
| Call the REST endpoints directly | **API reference** |
| Build in TypeScript | **SDK** (`@socheli/sdk`) |
| Drive Socheli from a shell | **CLI** (`socheli`) |
| Give an agent control | **MCP** (`@socheli/mcp`) |
| Understand the control/data split and job lifecycle | **Architecture** |
