# TypeScript SDK

`@socheli/sdk` is the official TypeScript client for the Socheli content engine. It wraps the `/v1` REST surface served at `api.socheli.com` behind a single typed factory, `createSocheli()`, and ships with the full public DTO set so every request and response is checked at compile time.

The SDK is the foundation of the rest of the toolchain: the [`socheli` CLI](/docs/cli) and the [MCP server](/docs/mcp) are both thin wrappers over this exact client. If you want programmatic control over content generation, the fleet, and publishing, this is the lowest-friction surface.

## Highlights

- **Zero runtime dependencies.** The only thing it needs is a global `fetch`. Works in Node 18+, Bun, Deno, and edge runtimes.
- **Fully typed.** Every method, input, and response shape is exported from `@socheli/sdk`.
- **Single API key.** One Bearer key authenticates every call, matching the API, CLI, and MCP server.
- **Tiny.** The entire client is a single factory function returning a flat object of methods.

## Install

```bash
npm install @socheli/sdk
# or
pnpm add @socheli/sdk
# or
bun add @socheli/sdk
```

The package is published as native ESM (`"type": "module"`) with TypeScript sources as the entry point, so type definitions are always in sync with the implementation.

```jsonc
// from package.json
{
  "name": "@socheli/sdk",
  "version": "0.1.0",
  "type": "module",
  "main": "src/index.ts",
  "types": "src/index.ts",
  "exports": { ".": "./src/index.ts" }
}
```

## Quickstart

```ts
import { createSocheli } from "@socheli/sdk";

const socheli = createSocheli({ apiKey: process.env.SOCHELI_API_KEY });

// Inspect the render fleet
const { devices, online } = await socheli.fleet();
console.log(`${online} device(s) online`);

// Kick off a render
const { job } = await socheli.generate({
  seed: "why we procrastinate",
  channel: "concept_lab",
});
console.log("dispatched job", job.id);
```

`createSocheli` also has a default export, so `import createSocheli from "@socheli/sdk"` works identically.

## `createSocheli(options)`

Constructs a `SocheliClient`. All options are optional — the client falls back to environment variables, then to sane defaults.

```ts
export interface SocheliOptions {
  /** API key (Bearer). Falls back to env SOCHELI_API_KEY. */
  apiKey?: string;
  /** API base URL. Defaults to env SOCHELI_API_URL or https://api.socheli.com. */
  baseUrl?: string;
  /** Custom fetch (for testing / non-standard runtimes). */
  fetch?: typeof fetch;
}

export function createSocheli(opts?: SocheliOptions): SocheliClient;
```

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `apiKey` | `string` | `process.env.SOCHELI_API_KEY` | Bearer key sent as `Authorization: Bearer <key>`. If unset, requests are made without an auth header (the API will reject protected routes). |
| `baseUrl` | `string` | `process.env.SOCHELI_API_URL` ?? `https://api.socheli.com` | API origin. A trailing slash is stripped automatically. The client appends `/v1` to every path. |
| `fetch` | `typeof fetch` | global `fetch` | Inject a custom `fetch` for testing, proxies, or runtimes without a global `fetch`. |

### Environment variables

| Variable | Used for |
| --- | --- |
| `SOCHELI_API_KEY` | Default `apiKey` when not passed explicitly. |
| `SOCHELI_API_URL` | Default `baseUrl` when not passed explicitly. |

Both env lookups are guarded against runtimes where `process` is undefined (e.g. some edge environments), so the SDK never throws on import there — you simply pass `apiKey`/`baseUrl` directly.

### Request mechanics

Every method routes through a single internal `req()` helper. Understanding it explains the client's behavior:

- Requests go to `` `${baseUrl}/v1${path}` ``.
- The `Authorization: Bearer <apiKey>` header is added only when an `apiKey` is present.
- `Content-Type: application/json` is added only when there is a request body.
- The response body is read as text and parsed as JSON when present; if it isn't valid JSON, the raw text is returned instead.
- On a non-2xx response, the client throws a `SocheliError` (see [Error handling](#error-handling)).

## Client surface

`createSocheli` returns an object implementing `SocheliClient`:

```ts
export interface SocheliClient {
  health(): Promise<{ ok: boolean; version: string; uptime: number }>;
  items: {
    list(params?: { limit?: number; channel?: string }): Promise<ItemSummary[]>;
    get(id: string): Promise<Item>;
    publish(id: string, input?: PublishInput): Promise<{ dispatched: boolean }>;
  };
  generate(input: GenerateInput): Promise<{ dispatched: boolean; job: Job }>;
  jobs(): Promise<JobRow[]>;
  fleet(): Promise<FleetState>;
  schedule: {
    get(): Promise<Schedule>;
    set(schedule: Schedule): Promise<Schedule>;
  };
  // Canonical tool bridge — reach every registry capability.
  tools(): Promise<ToolManifestEntry[]>;
  tool<T = unknown>(name: string, input?: Record<string, unknown>): Promise<ToolResult<T>>;
  // Content calendar / plan CRUD (thin wrappers over the plan_* tools).
  plan: {
    list(params?: { channel?: string; status?: string; includeArchived?: boolean }): Promise<PlannedPost[]>;
    get(id: string): Promise<PlannedPost | null>;
    day(date: string, includeArchived?: boolean): Promise<PlannedPost[]>;
    create(post: Partial<PlannedPost> & { channel: string; date: string; platform: string; topic: string }): Promise<PlannedPost | null>;
    update(id: string, patch: Partial<PlannedPost>): Promise<PlannedPost | null>;
    move(id: string, date: string, time?: string): Promise<PlannedPost | null>;
    archive(id: string): Promise<PlannedPost | null>;
    remove(id: string): Promise<boolean>;
    run(input: { channel: string; days?: number; platforms?: string[]; time?: string }): Promise<ToolResult>;
  };
}
```

The table below maps each method to its underlying HTTP route.

| Method | HTTP | Path | Returns |
| --- | --- | --- | --- |
| `health()` | `GET` | `/v1/health` | `{ ok, version, uptime }` |
| `items.list(params?)` | `GET` | `/v1/items` | `ItemSummary[]` |
| `items.get(id)` | `GET` | `/v1/items/:id` | `Item` |
| `items.publish(id, input?)` | `POST` | `/v1/items/:id/publish` | `{ dispatched }` |
| `generate(input)` | `POST` | `/v1/generate` | `{ dispatched, job }` |
| `jobs()` | `GET` | `/v1/jobs` | `JobRow[]` |
| `fleet()` | `GET` | `/v1/fleet` | `FleetState` |
| `schedule.get()` | `GET` | `/v1/schedule` | `Schedule` |
| `schedule.set(schedule)` | `PUT` | `/v1/schedule` | `Schedule` |
| `tools()` | `GET` | `/v1/tools` | `ToolManifestEntry[]` |
| `tool(name, input?)` | `POST` | `/v1/tools/:name` | `ToolResult<T>` |
| `plan.list/get/day/create/update/move/archive/remove/run` | `POST` | `/v1/tools/plan_*` | `PlannedPost` / `PlannedPost[]` / `ToolResult` |

The `plan.*` namespace and `tool()` curate the dated content calendar; see [Calendar & Plan](calendar.md).

### `health()`

Liveness/version probe. Unauthenticated-safe and useful as a connectivity check.

```ts
const { ok, version, uptime } = await socheli.health();
// { ok: true, version: "1.4.0", uptime: 38211.7 }
```

| Field | Type | Description |
| --- | --- | --- |
| `ok` | `boolean` | Service is healthy. |
| `version` | `string` | Engine/API version. |
| `uptime` | `number` | Process uptime in seconds. |

### `items.list(params?)`

Lists content items as lean summaries, newest-relevant first.

```ts
const items = await socheli.items.list({ limit: 20, channel: "concept_lab" });
for (const item of items) {
  console.log(item.id, item.status, item.title);
}
```

| Param | Type | Description |
| --- | --- | --- |
| `limit` | `number` | Max items to return. Omitted when not provided. |
| `channel` | `string` | Filter to a single channel/brand. Omitted when not provided. |

Both params are serialized into the query string via `URLSearchParams`; passing neither lists across all channels with the server default limit.

### `items.get(id)`

Fetches a single item by id, hydrated with the full pipeline detail (idea → script → storyboard → package → video URL).

```ts
const item = await socheli.items.get("itm_8fa21c");
console.log(item.script?.hook);
console.log(item.videoUrl);
```

The `id` is URL-encoded before being placed in the path.

### `items.publish(id, input?)`

Dispatches a publish for an already-rendered item to its target platforms.

```ts
const { dispatched } = await socheli.items.publish("itm_8fa21c", {
  public: true,
  aigc: true,
});
```

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `public` | `boolean` | — | Publish publicly rather than as private/unlisted. |
| `aigc` | `boolean` | `true` | Declare the content as AI-generated. |

`input` defaults to `{}` if omitted. The call returns `{ dispatched: boolean }` — `dispatched` indicates the publish was accepted and handed off, not that it has completed. Poll `items.get(id)` and inspect `publish[]` for per-platform status and URLs.

### `generate(input)`

The core entry point: turns a seed idea into a render job dispatched to the fleet.

```ts
const { dispatched, job } = await socheli.generate({
  seed: "why we procrastinate",
  channel: "concept_lab",
  mood: "cinematic",
  voice: true,
  type: "new",
});
console.log(job.id, job.type, job.createdAt);
```

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `seed` | `string` | **required** | The idea/topic to build the post from. |
| `channel` | `string` | — | Channel/brand to generate for. |
| `mood` | `string` | — | Mood preset — shapes background, typography, transitions, b-roll. See [MOODS.md](./MOODS.md). |
| `voice` | `boolean` | — | Whether to include narration/voiceover. |
| `type` | `"auto"` \| `"new"` | `"new"` | `"new"` builds only; `"auto"` also publishes after render. |
| `abStoryboard` | `boolean` | `true` | Generate two storyboard variants and pick the higher-scoring one. Set `false` for single-pass (faster/cheaper). |
| `maxQaPasses` | `number` | `3` | Max iterative QA+revision cycles (1–5). Stops early when score ≥ 8/10. |

Returns `{ dispatched, job }`, where `job` is the freshly created `Job`. Track its lifecycle via `jobs()`.

### `jobs()`

Returns all known jobs as `JobRow[]`, each carrying live status, the assigned device, the produced item id, and a streamed progress log.

```ts
const rows = await socheli.jobs();
const active = rows.filter((j) => j.status === "running");
for (const j of active) {
  console.log(j.id, j.device, j.progress.at(-1)?.line);
}
```

### `fleet()`

Returns the current state of the render fleet.

```ts
const { devices, jobs, online } = await socheli.fleet();
console.log(`${online}/${devices.length} devices online`);
```

| Field | Type | Description |
| --- | --- | --- |
| `devices` | `Device[]` | All registered devices and their status/profile. |
| `jobs` | `JobRow[]` | Jobs known to the fleet. |
| `online` | `number` | Count of currently-online devices. |

### `schedule.get()` / `schedule.set(schedule)`

Read and replace the autopilot posting schedule. `set` is a full PUT — pass the complete `Schedule` object (typically read, mutate, write back).

```ts
const schedule = await socheli.schedule.get();

schedule.enabled = true;
schedule.timezone = "America/Los_Angeles";

const saved = await socheli.schedule.set(schedule);
console.log("autopilot enabled:", saved.enabled);
```

## Error handling

Any non-2xx response throws a `SocheliError`. Successful calls resolve to the typed body.

```ts
export class SocheliError extends Error {
  constructor(message: string, readonly status: number, readonly body?: unknown);
  // name === "SocheliError"
}
```

| Property | Type | Description |
| --- | --- | --- |
| `message` | `string` | The API's `error` field when present, otherwise `` `${method} ${path} → ${status}` ``. |
| `status` | `number` | HTTP status code of the failed response. |
| `body` | `unknown` | Parsed JSON body (or raw text) returned by the server, for richer diagnostics. |
| `name` | `string` | Always `"SocheliError"`. |

```ts
import { createSocheli, SocheliError } from "@socheli/sdk";

const socheli = createSocheli({ apiKey: process.env.SOCHELI_API_KEY });

try {
  const item = await socheli.items.get("itm_does_not_exist");
} catch (err) {
  if (err instanceof SocheliError) {
    console.error(`API error ${err.status}: ${err.message}`);
    console.error("server said:", err.body);
    if (err.status === 401) {
      // bad or missing SOCHELI_API_KEY
    }
  } else {
    throw err; // network/transport failure (fetch rejected)
  }
}
```

Note the distinction: a `SocheliError` means the server responded with a non-2xx status. A rejected `fetch` (DNS failure, connection refused, offline) surfaces as the underlying `fetch` error, *not* a `SocheliError` — so catch both when robustness matters.

## Types

All DTOs are re-exported from the package root (`export * from "./types.ts"`), so you can import them alongside the client.

```ts
import type {
  Item, ItemSummary, ItemStatus, PublishEntry,
  Job, JobRow, JobType,
  Device, DeviceProfile, DeviceStatus,
  FleetState, Schedule,
  GenerateInput, PublishInput,
  SocheliOptions, SocheliClient, SocheliError,
} from "@socheli/sdk";
```

### Item lifecycle

```ts
export type ItemStatus =
  | "idea_proposed"
  | "script_ready"
  | "storyboard_ready"
  | "qa_passed"
  | "qa_failed"
  | "rendered"
  | "packaged"
  | "failed";

export interface ItemSummary {
  id: string;
  channel: string;
  status: ItemStatus | string;
  title: string;
  createdAt: string;
  updatedAt: string;
  qa?: number;
  costUsd?: number;
  publish?: PublishEntry[];
}

export interface Item extends ItemSummary {
  idea?: { topic: string; angle: string; format: string };
  script?: { hook: string; narration: string[]; cta: string };
  storyboard?: { topic: string; format: string; scenes: { id: string; type: string; durationSec: number }[] };
  pkg?: { title: string; caption: string; hashtags: string[]; altText?: string };
  videoUrl?: string;
}

export interface PublishEntry {
  platform: string;
  status: string;
  url?: string;
  id?: string;
  at: string;
}
```

`ItemSummary` is what `items.list()` returns; `Item` adds the hydrated pipeline stages returned by `items.get()`. `status` is typed as `ItemStatus | string` so the contract stays forward-compatible if the engine introduces new states.

### Jobs

```ts
export type JobType = "auto" | "new" | "ping";

export interface Job {
  id: string;
  type: JobType;
  channel?: string;
  seed?: string;
  by?: string;
  createdAt: string;
}

export interface JobRow extends Job {
  status: "dispatched" | "running" | "done" | "error";
  device?: string;
  itemId?: string;
  message?: string;
  progress: { at: string; line: string }[];
  updatedAt: string;
}
```

`generate()` returns the base `Job`; `jobs()` returns `JobRow[]` with live execution state. The `progress` array is an append-only log of timestamped lines streamed from the render device.

### Devices & fleet

```ts
export type DeviceStatus = "online" | "idle" | "busy" | "offline";

export interface DeviceProfile {
  arch: string;
  platform: string;
  cpus: number;
  ramGb: number;
  gpu: string;
}

export interface Device {
  device: string;
  status: DeviceStatus;
  host?: string;
  caps?: string[];
  profile?: DeviceProfile;
  currentJob?: string | null;
  lastSeen: string;
}

export interface FleetState {
  devices: Device[];
  jobs: JobRow[];
  online: number;
}
```

### Inputs

```ts
export interface GenerateInput {
  seed: string;
  channel?: string;
  mood?: string;
  voice?: boolean;
  /** "auto" also publishes after render; "new" builds only. Default "new". */
  type?: "auto" | "new";
}

export interface PublishInput {
  public?: boolean;
  /** Declare AI-generated content (defaults true). */
  aigc?: boolean;
}
```

### Schedule

```ts
export interface Schedule {
  enabled: boolean;
  timezone: string;
  graceMinutes: number;
  channels: {
    channel: string;
    enabled: boolean;
    slots: { time: string; channel: string; mood?: string; seed?: string; public: boolean }[];
  }[];
}
```

## End-to-end example

Generate a post, wait for the render to finish, then publish it.

```ts
import { createSocheli, SocheliError } from "@socheli/sdk";

const socheli = createSocheli({ apiKey: process.env.SOCHELI_API_KEY });

async function buildAndPublish(seed: string, channel: string) {
  // 1. Dispatch a build-only job.
  const { job } = await socheli.generate({ seed, channel, type: "new" });
  console.log("dispatched", job.id);

  // 2. Poll the fleet until this job lands an item or errors.
  let itemId: string | undefined;
  for (;;) {
    const rows = await socheli.jobs();
    const row = rows.find((j) => j.id === job.id);
    if (!row) throw new Error("job vanished");

    const last = row.progress.at(-1)?.line;
    if (last) console.log(`[${row.status}] ${last}`);

    if (row.status === "error") throw new Error(row.message ?? "render failed");
    if (row.status === "done" && row.itemId) {
      itemId = row.itemId;
      break;
    }
    await new Promise((r) => setTimeout(r, 5_000));
  }

  // 3. Confirm the item rendered, then publish it publicly.
  const item = await socheli.items.get(itemId);
  console.log("rendered:", item.videoUrl);

  const { dispatched } = await socheli.items.publish(item.id, {
    public: true,
    aigc: true,
  });
  console.log("publish dispatched:", dispatched);
}

buildAndPublish("why we procrastinate", "concept_lab").catch((err) => {
  if (err instanceof SocheliError) {
    console.error(`Socheli API error ${err.status}:`, err.message, err.body);
  } else {
    console.error(err);
  }
  process.exitCode = 1;
});
```

For a one-shot build-and-publish, pass `type: "auto"` to `generate()` instead of publishing manually — the engine publishes automatically after the render completes.

## Runtime compatibility

The client uses only the global `fetch`, so it runs anywhere `fetch` exists: Node 18+, Bun, Deno, and most edge runtimes. For runtimes without a global `fetch`, or to intercept requests in tests, inject one:

```ts
const socheli = createSocheli({
  apiKey: "sk_test_...",
  baseUrl: "http://localhost:8787",
  fetch: myCustomFetch,
});
```

## See also

- [Socheli CLI](/docs/cli) — the `socheli` command, a thin wrapper over this SDK.
- [MCP server](/docs/mcp) — exposes the same engine to MCP-capable agents.
- [REST API](/docs/api) — the underlying `/v1` HTTP surface this SDK targets.
