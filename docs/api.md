# API Reference

The Socheli REST API (`@socheli/api`) is the control-plane backbone of the entire system. The [SDK](/docs/sdk), [CLI](/docs/cli), [MCP server](/docs/mcp), the dashboard, and any third-party integration all speak to this one surface. It is a small [Hono](https://hono.dev) server (Node, ESM) that reads content, job, and fleet state from a flat JSON file store and dispatches render jobs to the device fleet over MQTT.

- **Base URL:** `https://api.socheli.com`
- **API version prefix:** `/v1`
- **Current build:** `0.1.0`
- **Auth:** static Bearer API key (one key across every surface)
- **Content type:** `application/json` for all requests and responses
- **CORS:** enabled on every route (`*`)

```
https://api.socheli.com/v1/{resource}
```

## Authentication

Every `/v1/*` route except `/v1/health` requires a Bearer token in the `Authorization` header. The token is matched against the server's `SOCHELI_API_KEY` with an exact string comparison — there is a single key shared across the SDK, CLI, and MCP.

```bash
curl https://api.socheli.com/v1/fleet \
  -H "Authorization: Bearer $SOCHELI_API_KEY"
```

The `Bearer` scheme prefix is matched case-insensitively and stripped before comparison:

```ts
const auth = c.req.header("Authorization") || "";
const key = auth.replace(/^Bearer\s+/i, "");
```

### Auth failure modes

| Condition | Status | Body |
| --- | --- | --- |
| Server has no `SOCHELI_API_KEY` configured | `503` | `{ "error": "API not configured (no SOCHELI_API_KEY)" }` |
| Token missing or does not match | `401` | `{ "error": "unauthorized" }` |
| `/v1/health` (always public) | — | never requires auth |

> When the server boots without a key it logs `WARNING: no SOCHELI_API_KEY set` and rejects every authenticated route with `503` until the key is provided.

## Endpoint overview

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| `GET` | `/v1/health` | No | Liveness, version, uptime |
| `GET` | `/v1/items` | Yes | List content items (summaries) |
| `GET` | `/v1/items/:id` | Yes | Get one item (full detail) |
| `POST` | `/v1/items/:id/publish` | Yes | Publish a finished item to platforms |
| `POST` | `/v1/generate` | Yes | Dispatch a generation job to the fleet |
| `GET` | `/v1/jobs` | Yes | Recent job rows (latest 30) |
| `GET` | `/v1/fleet` | Yes | Live fleet state (devices + jobs) |
| `GET` | `/v1/schedule` | Yes | Read the autopilot schedule |
| `PUT` | `/v1/schedule` | Yes | Replace the autopilot schedule |
| `GET` | `/v1/tools` | Yes | The canonical tool manifest (every registry tool) |
| `POST` | `/v1/tools/:name` | Yes | Call any registry tool — incl. the `plan_*` calendar CRUD |

The tool bridge (`/v1/tools`) exposes the **whole** registry (editor + pipeline + plan/calendar) over REST: `GET` returns `{ name, description, kind, inputSchema }[]`; `POST /v1/tools/:name` runs one with the JSON body as input and returns `{ ok, data?, message? }` (`400` when `ok` is false). It's how the SDK, CLI and MCP reach every capability — see [Calendar & Plan](calendar.md) for the `plan_*` set.

```bash
curl -s -X POST https://api.socheli.com/v1/tools/plan_day \
  -H "Authorization: Bearer $SOCHELI_API_KEY" -H "Content-Type: application/json" \
  -d '{"date":"2026-06-20"}'
```

Reads come straight from the file store. Writes either dispatch a job over MQTT (`/v1/generate`), spawn the engine CLI in the background (`/v1/items/:id/publish`), or persist to disk (`PUT /v1/schedule`).

---

## Reads

### `GET /v1/health`

Liveness probe. The only unauthenticated route. Use it for uptime checks and to confirm the deployed version.

**Response `200`**

| Field | Type | Description |
| --- | --- | --- |
| `ok` | `boolean` | Always `true` when serving |
| `version` | `string` | API build, e.g. `"0.1.0"` |
| `uptime` | `number` | Seconds since process start (rounded) |

```bash
curl https://api.socheli.com/v1/health
```

```json
{ "ok": true, "version": "0.1.0", "uptime": 8124 }
```

### `GET /v1/items`

List content items as lean summaries, newest first (sorted by `createdAt` descending).

**Query parameters**

| Param | Type | Required | Description |
| --- | --- | --- | --- |
| `limit` | `number` | No | Cap the number of returned summaries |
| `channel` | `string` | No | Filter to one channel (e.g. `concept_lab`) |

**Response `200`** — an array of [`ItemSummary`](#itemsummary).

```bash
curl "https://api.socheli.com/v1/items?channel=concept_lab&limit=5" \
  -H "Authorization: Bearer $SOCHELI_API_KEY"
```

```json
[
  {
    "id": "run_lq8x3a",
    "channel": "concept_lab",
    "status": "packaged",
    "title": "Why we procrastinate",
    "createdAt": "2026-06-08T04:11:02.000Z",
    "updatedAt": "2026-06-08T04:19:47.000Z",
    "qa": 0.94,
    "costUsd": 0.21,
    "publish": [
      { "platform": "youtube", "status": "live", "url": "https://youtu.be/…", "at": "2026-06-08T05:00:00.000Z" }
    ]
  }
]
```

### `GET /v1/items/:id`

Fetch one item with full detail — idea, script, storyboard, package, and the public video URL when rendered.

**Path parameters**

| Param | Type | Description |
| --- | --- | --- |
| `id` | `string` | The item id (run id) |

**Response `200`** — a single [`Item`](#item). **`404`** `{ "error": "not found" }` if no item with that id exists.

```bash
curl https://api.socheli.com/v1/items/run_lq8x3a \
  -H "Authorization: Bearer $SOCHELI_API_KEY"
```

```json
{
  "id": "run_lq8x3a",
  "channel": "concept_lab",
  "status": "packaged",
  "title": "Why we procrastinate",
  "createdAt": "2026-06-08T04:11:02.000Z",
  "updatedAt": "2026-06-08T04:19:47.000Z",
  "qa": 0.94,
  "costUsd": 0.21,
  "idea": { "topic": "Why we procrastinate", "angle": "the present-bias trap", "format": "explainer" },
  "script": {
    "hook": "Your brain isn't lazy — it's biased toward now.",
    "narration": ["Procrastination is an emotion-regulation problem…", "…"],
    "cta": "Follow for more on how your mind works."
  },
  "storyboard": {
    "topic": "Why we procrastinate",
    "format": "explainer",
    "scenes": [{ "id": "s1", "type": "title", "durationSec": 2.5 }]
  },
  "pkg": {
    "title": "Why we procrastinate",
    "caption": "Your brain isn't lazy…",
    "hashtags": ["#psychology", "#focus"],
    "altText": "Animated explainer on present bias"
  },
  "videoUrl": "https://media.socheli.com/run_lq8x3a.mp4"
}
```

> **`videoUrl` resolution.** A public URL is returned when the item has a `videoPath` or a rendered file exists at `data/renders/{id}.mp4`. The URL is built against `HOST_PUBLIC_BASE` (default `https://media.socheli.com`). Videos are rendered on the fleet and rsynced back to the public media host; the API never serves the bytes itself.

### `GET /v1/jobs`

Return the most recent job rows — capped at **30**, newest first.

**Response `200`** — an array of [`JobRow`](#jobrow).

```bash
curl https://api.socheli.com/v1/jobs \
  -H "Authorization: Bearer $SOCHELI_API_KEY"
```

```json
[
  {
    "id": "job_lq8x3akf2p9",
    "type": "new",
    "channel": "concept_lab",
    "seed": "why we procrastinate",
    "by": "api",
    "createdAt": "2026-06-08T04:10:55.000Z",
    "status": "done",
    "device": "render-01",
    "itemId": "run_lq8x3a",
    "progress": [{ "at": "2026-06-08T04:11:02.000Z", "line": "idea proposed" }],
    "updatedAt": "2026-06-08T04:19:47.000Z"
  }
]
```

### `GET /v1/fleet`

Live fleet state: every known render device, the 30 most recent jobs, and an online count. Devices whose `lastSeen` is older than **70 seconds** are reported as `offline` regardless of their last self-reported status.

**Response `200`** — a [`FleetState`](#fleetstate).

```bash
curl https://api.socheli.com/v1/fleet \
  -H "Authorization: Bearer $SOCHELI_API_KEY"
```

```json
{
  "devices": [
    {
      "device": "render-01",
      "status": "idle",
      "host": "studio.local",
      "caps": ["render", "voice:eleven", "music:musicgen", "broll:pexels"],
      "profile": { "arch": "arm64", "platform": "darwin", "cpus": 12, "ramGb": 64, "gpu": "apple-silicon" },
      "currentJob": null,
      "lastSeen": "2026-06-08T04:19:50.000Z"
    }
  ],
  "jobs": [],
  "online": 1
}
```

### `GET /v1/schedule`

Read the autopilot posting schedule. Returns a default disabled schedule (`{ enabled: false, timezone: "UTC", graceMinutes: 10, channels: [] }`) if none has been persisted.

**Response `200`** — a [`Schedule`](#schedule).

```bash
curl https://api.socheli.com/v1/schedule \
  -H "Authorization: Bearer $SOCHELI_API_KEY"
```

---

## Writes

### `POST /v1/generate`

Dispatch a generation job. This is the heart of the API: it takes one idea (`seed`), derives the job's capability requirements, picks the best-fit online device from the live fleet, and publishes the job to that device over MQTT.

**Request body** ([`GenerateInput`](#generateinput))

| Field | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `seed` | `string` | **Yes** | — | The idea to turn into a video |
| `channel` | `string` | No | `"concept_lab"` | Target channel |
| `mood` | `string` | No | — | Mood preset or mixture (e.g. `cinematic`, `"cinematic*0.7+tech*0.3"`) |
| `voice` | `boolean` | No | `false` | Request premium voice; adds `voice:eleven` as a preferred capability |
| `type` | `"auto" \| "new"` | No | `"new"` | `"new"` builds only; `"auto"` also publishes after render |

**Response `200`**

| Field | Type | Description |
| --- | --- | --- |
| `dispatched` | `boolean` | `true` when the job was published to a device |
| `job` | [`Job`](#job) | The created job (server-assigned `id`, `createdAt`, `by: "api"`) |
| `device` | `string` | The device the job was routed to |
| `routing` | `string` | Human-readable routing reason, e.g. `"idle · 4/4 caps"` |

```bash
curl -X POST https://api.socheli.com/v1/generate \
  -H "Authorization: Bearer $SOCHELI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "seed": "why we procrastinate", "channel": "concept_lab", "mood": "cinematic", "voice": true }'
```

```json
{
  "dispatched": true,
  "job": {
    "id": "job_lq8x3akf2p9",
    "type": "new",
    "channel": "concept_lab",
    "seed": "why we procrastinate",
    "mood": "cinematic",
    "voice": true,
    "createdAt": "2026-06-08T04:10:55.000Z",
    "by": "api"
  },
  "device": "render-01",
  "routing": "idle · 4/4 caps"
}
```

#### How a job is routed

Scheduling is capability-aware. `jobRequirements()` derives the job's needs, then `pickDevice()` scores the online fleet:

- **Hard requirement:** every generation job requires the `render` capability. A device without it is never eligible.
- **Preferred capabilities:** `music:musicgen`, `broll:sdturbo`, `broll:pexels` — and `voice:eleven` first when `voice` is `true`. These are quality preferences; a minimal device still renders and degrades gracefully.
- **Scoring:** an `idle` device starts at `100` (strongly preferred over busy), `+10` per matched preferred cap, plus a RAM tie-break (`ramGb / 8`). The highest-scoring capable device wins.

The job is published to `socheli/device/{device}/jobs` with QoS 1.

**Errors**

| Status | Body | When |
| --- | --- | --- |
| `400` | `{ "error": "seed required" }` | `seed` missing from body |
| `503` | `{ "error": "<reason>", "requirements": { "hard": [...], "prefer": [...] } }` | No online device satisfies the hard `render` cap |
| `502` | `{ "error": "broker unreachable: <message>" }` | MQTT broker could not be reached |

### `POST /v1/items/:id/publish`

Publish a finished item to its target platforms. The API spawns the engine CLI (`packages/engine/src/cli.ts publish <id>`) detached in the background and returns immediately — publishing is fire-and-forget. Poll the item's `publish` array (via `GET /v1/items/:id`) to observe progress.

**Path parameters**

| Param | Type | Description |
| --- | --- | --- |
| `id` | `string` | The item id to publish |

**Request body** ([`PublishInput`](#publishinput))

| Field | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `public` | `boolean` | No | `false` | When `true`, passes `--public` (publishes publicly rather than unlisted/private) |
| `aigc` | `boolean` | No | `true` | When `false`, passes `--no-aigc` to suppress the AI-generated-content declaration |

**Response `200`** — `{ "dispatched": true }` (always; the call only confirms the spawn, not the outcome).

```bash
curl -X POST https://api.socheli.com/v1/items/run_lq8x3a/publish \
  -H "Authorization: Bearer $SOCHELI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "public": true }'
```

```json
{ "dispatched": true }
```

### `PUT /v1/schedule`

Replace the autopilot schedule wholesale. The submitted object is stamped with a fresh `updatedAt` and persisted to `data/schedule.json`. There is no partial update — send the complete [`Schedule`](#schedule).

**Request body** — a [`Schedule`](#schedule) object.

**Response `200`** — the persisted schedule (with the new `updatedAt`). **`400`** `{ "error": "bad schedule" }` if the body is missing or not an object.

```bash
curl -X PUT https://api.socheli.com/v1/schedule \
  -H "Authorization: Bearer $SOCHELI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "enabled": true,
    "timezone": "Europe/Berlin",
    "graceMinutes": 10,
    "channels": [
      {
        "channel": "concept_lab",
        "enabled": true,
        "slots": [
          { "time": "09:00", "channel": "concept_lab", "mood": "cinematic", "seed": "auto", "public": true }
        ]
      }
    ]
  }'
```

---

## Errors

All errors are JSON of the shape `{ "error": string }`. Some carry extra context fields (e.g. `/v1/generate` returns `requirements` on a `503`).

| Status | Meaning | Example body |
| --- | --- | --- |
| `400` | Bad request — missing or malformed input | `{ "error": "seed required" }` |
| `401` | Unauthorized — missing or invalid Bearer key | `{ "error": "unauthorized" }` |
| `404` | Not found — unknown item id or route | `{ "error": "not found" }` |
| `502` | Bad gateway — MQTT broker unreachable | `{ "error": "broker unreachable: …" }` |
| `503` | Unavailable — API not configured, or no capable device | `{ "error": "no online device with required cap(s): render", "requirements": { "hard": ["render"], "prefer": ["music:musicgen","broll:sdturbo","broll:pexels"] } }` |

Unmatched routes return `404` `{ "error": "not found" }`.

### Client-side error handling

The [SDK](/docs/sdk) maps any non-2xx response to a thrown `SocheliError` carrying the HTTP `status` and parsed `body`, using the response's `error` field as the message:

```ts
import { createSocheli, SocheliError } from "@socheli/sdk";

const socheli = createSocheli({ apiKey: process.env.SOCHELI_API_KEY });
try {
  await socheli.generate({ seed: "why we procrastinate" });
} catch (e) {
  if (e instanceof SocheliError) {
    console.error(e.status, e.message, e.body);
  }
}
```

---

## Data model

These are the public DTOs the API returns. They are intentionally decoupled from the engine's internal schemas so the public contract stays stable while internals evolve. (Exported from `@socheli/sdk`.)

### `ItemStatus`

```ts
type ItemStatus =
  | "idea_proposed"
  | "script_ready"
  | "storyboard_ready"
  | "qa_passed"
  | "qa_failed"
  | "rendered"
  | "packaged"
  | "failed";
```

### `ItemSummary`

Returned by `GET /v1/items`.

| Field | Type | Description |
| --- | --- | --- |
| `id` | `string` | Item / run id |
| `channel` | `string` | Channel the item belongs to |
| `status` | `ItemStatus \| string` | Pipeline stage |
| `title` | `string` | Resolved title (package title → idea topic → seed → id) |
| `createdAt` | `string` | ISO 8601 timestamp |
| `updatedAt` | `string` | ISO 8601 timestamp |
| `qa` | `number?` | Overall QA score |
| `costUsd` | `number?` | Total ledger cost in USD |
| `publish` | `PublishEntry[]?` | Per-platform publish records |

### `Item`

Returned by `GET /v1/items/:id`. Extends `ItemSummary` with detail blocks; each is present only once that stage has been reached.

| Field | Type | Description |
| --- | --- | --- |
| `idea` | `{ topic, angle, format }?` | The generated idea |
| `script` | `{ hook, narration[], cta }?` | Script — hook line, narration lines, CTA |
| `storyboard` | `{ topic, format, scenes[] }?` | Scenes as `{ id, type, durationSec }` |
| `pkg` | `{ title, caption, hashtags[], altText? }?` | Publishable package |
| `videoUrl` | `string?` | Public mp4 URL when rendered |

### `PublishEntry`

| Field | Type | Description |
| --- | --- | --- |
| `platform` | `string` | e.g. `youtube`, `instagram`, `tiktok` |
| `status` | `string` | Publish status |
| `url` | `string?` | Live URL once published |
| `id` | `string?` | Platform-side post id |
| `at` | `string` | ISO 8601 timestamp |

### `Job`

Created by `POST /v1/generate` and returned in its `job` field.

| Field | Type | Description |
| --- | --- | --- |
| `id` | `string` | Server-assigned, e.g. `job_lq8x3akf2p9` |
| `type` | `"auto" \| "new" \| "ping"` | Job kind |
| `channel` | `string?` | Target channel |
| `seed` | `string?` | The idea |
| `by` | `string?` | Origin; `"api"` for API-created jobs |
| `createdAt` | `string` | ISO 8601 timestamp |

### `JobRow`

Returned by `GET /v1/jobs` and embedded in `FleetState.jobs`. Extends `Job` with live execution state.

| Field | Type | Description |
| --- | --- | --- |
| `status` | `"dispatched" \| "running" \| "done" \| "error"` | Lifecycle state |
| `device` | `string?` | Device executing the job |
| `itemId` | `string?` | The produced item's id |
| `message` | `string?` | Status / error message |
| `progress` | `{ at, line }[]` | Progress log entries |
| `updatedAt` | `string` | ISO 8601 timestamp |

### `Device` / `DeviceProfile`

| `Device` field | Type | Description |
| --- | --- | --- |
| `device` | `string` | Device id |
| `status` | `"online" \| "idle" \| "busy" \| "offline"` | Live status (forced to `offline` if stale > 70s) |
| `host` | `string?` | Hostname |
| `caps` | `string[]?` | Capabilities, e.g. `render`, `voice:eleven`, `music:musicgen`, `broll:pexels`, `broll:sdturbo` |
| `profile` | `DeviceProfile?` | Hardware profile |
| `currentJob` | `string \| null?` | Job currently running |
| `lastSeen` | `string` | ISO 8601 heartbeat timestamp |

| `DeviceProfile` field | Type |
| --- | --- |
| `arch` | `string` |
| `platform` | `string` |
| `cpus` | `number` |
| `ramGb` | `number` |
| `gpu` | `string` |

### `FleetState`

| Field | Type | Description |
| --- | --- | --- |
| `devices` | `Device[]` | All known devices (stale ones marked offline) |
| `jobs` | `JobRow[]` | 30 most recent job rows |
| `online` | `number` | Count of devices not `offline` |

### `Schedule`

| Field | Type | Description |
| --- | --- | --- |
| `enabled` | `boolean` | Master autopilot switch |
| `timezone` | `string` | IANA timezone, e.g. `Europe/Berlin` |
| `graceMinutes` | `number` | Allowed lateness window for a slot |
| `channels` | `{ channel, enabled, slots[] }[]` | Per-channel schedules |

Each slot: `{ time: string; channel: string; mood?: string; seed?: string; public: boolean }`.

### `GenerateInput`

```ts
interface GenerateInput {
  seed: string;
  channel?: string;
  mood?: string;
  voice?: boolean;
  /** "auto" also publishes after render; "new" builds only. Default "new". */
  type?: "auto" | "new";
}
```

### `PublishInput`

```ts
interface PublishInput {
  public?: boolean;
  /** Declare AI-generated content (defaults true). */
  aigc?: boolean;
}
```

---

## Server configuration

The API reads its configuration from environment variables. Reads resolve against a flat JSON file store under `data/`; writes dispatch over MQTT or spawn the engine.

| Env var | Default | Description |
| --- | --- | --- |
| `SOCHELI_API_KEY` | — | The Bearer key. Without it, all authed routes return `503`. |
| `SOCHELI_API_PORT` | `8787` | Listen port |
| `SOCHELI_DATA_DIR` | `<root>/data` | JSON store root (items in `runs/`, plus `jobs.json`, `fleet.json`, `schedule.json`) |
| `SOCHELI_RENDERS_DIR` | `<data>/renders` | Where rendered mp4s land |
| `HOST_PUBLIC_BASE` | `https://media.socheli.com` | Public base for `videoUrl` |
| `SOCHELI_BROKER_URL` | `mqtt://127.0.0.1:1883` | MQTT broker for job dispatch |
| `SOCHELI_MQTT_USER` | — | MQTT username |
| `SOCHELI_MQTT_PASS` | — | MQTT password |

Start the server:

```bash
SOCHELI_API_KEY=… node --import tsx packages/api/src/server.ts
```

## Consuming the API

You rarely call these endpoints by hand. Higher-level surfaces wrap this exact contract:

- **[SDK](/docs/sdk)** (`@socheli/sdk`) — the typed `createSocheli()` client; every method above maps 1:1 to a route, with `SocheliError` on failure.
- **[CLI](/docs/cli)** (`socheli`) — thin command wrapper over the SDK.
- **[MCP server](/docs/mcp)** (`@socheli/mcp`) — exposes the read/dispatch/publish surface as MCP tools for agents.
