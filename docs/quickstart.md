# Quickstart

Socheli turns one idea into a finished vertical video. You describe a topic, the control plane dispatches a render job to a device in the fleet, that device runs the full pipeline (research → script → storyboard → QA → voice + captions → music → b-roll → package), and the rendered `.mp4` goes live at `media.socheli.com/<id>.mp4` — ready to publish to YouTube, Instagram, and TikTok.

Every surface — the **CLI**, the **SDK**, and the **MCP server** — talks to the same REST backbone at `https://api.socheli.com/v1`, authenticated with **one Bearer API key**. Pick the surface that fits how you work:

| Surface | Package | Best for | Auth input |
| --- | --- | --- | --- |
| **CLI** | `@socheli/cli` (`socheli`) | Humans at a terminal, scripts, CI | `socheli login` or env vars |
| **SDK** | `@socheli/sdk` | TypeScript apps, backend services | `createSocheli({ apiKey })` or env vars |
| **MCP** | `@socheli/mcp` | Claude Desktop / Claude Code agents | `env` block in MCP config |

All three follow the identical lifecycle: **generate → poll jobs → publish**.

## Prerequisites

| Requirement | Detail |
| --- | --- |
| **Node** | 18+ (the SDK is `fetch`-based and ESM-only; CLI/MCP run TypeScript directly via `tsx`) |
| **API key** | A Bearer key (e.g. `sk_live_xxx`). Sent as `Authorization: Bearer <key>` |
| **Base URL** | Defaults to `https://api.socheli.com`; override with `SOCHELI_API_URL` |

> The key authenticates every `/v1/*` route except `GET /v1/health`. A missing or wrong key returns `401`; if the server itself has no key configured it returns `503`. CORS is wide open on the API and the key grants full access, so **never embed it in browser-facing code**.

### The two shared environment variables

Across all three surfaces, auth and routing resolve from the same pair of env vars (each surface also accepts inline config that you'll see below):

| Variable | Meaning | Default |
| --- | --- | --- |
| `SOCHELI_API_KEY` | Bearer API key | _(none — requests go unauthenticated and 401)_ |
| `SOCHELI_API_URL` | API base URL (host root, **not** including `/v1`) | `https://api.socheli.com` |

> The `/v1` prefix is injected by the client automatically. Set `SOCHELI_API_URL` to the host root only — including `/v1` yields broken `/v1/v1/...` paths.

A quick unauthenticated sanity check that the API is reachable:

```bash
curl -s https://api.socheli.com/v1/health
# → {"ok":true,"version":"0.1.0","uptime":1234}
```

---

## Path 1 — CLI

`socheli` is a thin remote control over the API. It has no build step and ships a single command surface.

### 1. Authenticate

`socheli login` writes your credentials to `~/.socheli/config.json`:

```bash
socheli login --key sk_live_xxx --url https://api.socheli.com
# ✓ saved → /Users/you/.socheli/config.json
```

`--url` defaults to `https://api.socheli.com`, so for the hosted API you can pass just `--key`. The key may also be given as the first positional argument.

Environment variables override the config file, which is handy for CI or one-off calls:

```bash
SOCHELI_API_KEY=sk_live_xxx SOCHELI_API_URL=https://api.socheli.com socheli health
```

Verify auth and connectivity:

```bash
socheli health
# { "ok": true, "version": "...", "uptime": 12345 }
```

### 2. Check the fleet

A video can only render if a capable device is online. Confirm one is available:

```bash
socheli fleet
# 1 device(s) online
#   render-01           idle     render-01.local
```

### 3. Generate a video

```bash
socheli generate "why we procrastinate" --channel concept_lab --auto --voice --mood cinematic
# ✓ dispatched job_abc (auto) → concept_lab
```

| Flag / arg | Effect | Default |
| --- | --- | --- |
| `"<idea>"` (positional) | The seed/topic. Multi-word ideas are joined; quote to be safe | _required_ |
| `--channel <id>` | Target channel | `concept_lab` |
| `--auto` | Render **and** publish after (`type: "auto"`). Omit to only build (`type: "new"`) | build only |
| `--voice` | Generate narration voiceover | off |
| `--mood <id>` | Mood preset — shapes background, typography, transitions, and b-roll style. See [MOODS.md](./MOODS.md) for the full list. | _(none)_ |

### 4. Watch it render

`generate` returns immediately — the job runs asynchronously on a device. Poll the queue:

```bash
socheli jobs
# job_abc  running     auto  render-01   concept_2026_xyz
```

The status column moves `dispatched → running → done` (or `error`). Once `done`, list and inspect the item:

```bash
socheli items --limit 5 --channel concept_lab
# concept_2026…  packaged       QA8.4  How Money Really Works
socheli get concept_2026_xyz        # full item JSON incl. videoUrl
```

### 5. Publish

If you used `--auto`, publishing already happened. Otherwise ship it explicitly:

```bash
socheli publish concept_2026_xyz --public
# ✓ publishing concept_2026_xyz (public)
```

Without `--public` the item publishes privately. Errors print to stderr with a `✗` prefix and set exit code `1`; `SocheliError`s include the HTTP status (e.g. `✗ 401: unauthorized`).

### CLI command reference

| Command | Description |
| --- | --- |
| `socheli login --key <k> [--url <api>]` | Save credentials to `~/.socheli/config.json` (no network call) |
| `socheli health` | API status |
| `socheli items [--limit n] [--channel id]` | List content items |
| `socheli get <id>` | Full item JSON |
| `socheli generate "<idea>" [--channel id] [--auto] [--voice] [--mood id]` | Dispatch a render job |
| `socheli jobs` | Recent fleet jobs |
| `socheli fleet` | Connected devices |
| `socheli publish <id> [--public]` | Publish an item |

---

## Path 2 — SDK

`@socheli/sdk` is the zero-dependency, typed TypeScript client. It's ESM-only and ships raw TypeScript source (the published `main`/`types`/`exports` all point at `src/index.ts`), targeting Node 18+, Bun, Deno, and edge runtimes.

### 1. Install

```bash
npm install @socheli/sdk
```

### 2. Initialize the client

```ts
import { createSocheli } from "@socheli/sdk";

// apiKey falls back to process.env.SOCHELI_API_KEY,
// baseUrl falls back to process.env.SOCHELI_API_URL then https://api.socheli.com
const socheli = createSocheli({
  apiKey: process.env.SOCHELI_API_KEY,
  baseUrl: "https://api.socheli.com",
});

// the default export works too:
// import createSocheli from "@socheli/sdk";
```

`createSocheli` accepts:

| Option | Type | Fallback |
| --- | --- | --- |
| `apiKey` | `string` | `process.env.SOCHELI_API_KEY` |
| `baseUrl` | `string` | `process.env.SOCHELI_API_URL` → `https://api.socheli.com` (trailing slash stripped) |
| `fetch` | `typeof fetch` | global `fetch` |

> If no key resolves, `createSocheli` does **not** throw — it silently omits the `Authorization` header, so calls will `401` at runtime. In browsers/edge there is no env to read from, so pass `apiKey` and `baseUrl` explicitly.

### 3. Generate a video and read back the job

```ts
// type 'auto' also publishes after render; 'new' builds only (default 'new')
const { dispatched, job } = await socheli.generate({
  seed: "the science of habit",
  channel: "concept_lab",
  mood: "cinematic",
  voice: true,
  type: "auto",
});
console.log(dispatched, job.id, job.type);

// poll the queue for completion
const rows = await socheli.jobs();            // JobRow[]
const mine = rows.find((r) => r.id === job.id);
console.log(mine?.status, mine?.progress.at(-1)?.line);
```

`GenerateInput`:

| Field | Type | Notes |
| --- | --- | --- |
| `seed` | `string` | **Required** — the idea/topic |
| `channel` | `string?` | Target channel (server default `concept_lab`) |
| `mood` | `string?` | Mood preset |
| `voice` | `boolean?` | Generate narration |
| `type` | `'auto' \| 'new'?` | `'auto'` renders + publishes; `'new'` builds only. Default `'new'` (applied server-side) |

### 4. List, inspect, publish

```ts
const items = await socheli.items.list({ limit: 10, channel: "concept_lab" });
const item = await socheli.items.get(items[0].id);
console.log(item.title, item.videoUrl);

const { dispatched } = await socheli.items.publish(item.id, {
  public: true,
  aigc: true, // declare AI-generated content (defaults true)
});
```

### 5. Inspect the fleet (before you generate)

```ts
const { ok, version, uptime } = await socheli.health();

const { devices, jobs, online } = await socheli.fleet();
console.log(`${online} devices online`);
for (const d of devices) console.log(d.device, d.status, d.profile?.gpu);
```

### SDK client surface

| Method | HTTP | Returns |
| --- | --- | --- |
| `health()` | `GET /v1/health` | `{ ok, version, uptime }` |
| `items.list(params?)` | `GET /v1/items?limit&channel` | `ItemSummary[]` |
| `items.get(id)` | `GET /v1/items/:id` | `Item` |
| `items.publish(id, input?)` | `POST /v1/items/:id/publish` | `{ dispatched }` |
| `generate(input)` | `POST /v1/generate` | `{ dispatched, job }` |
| `jobs()` | `GET /v1/jobs` | `JobRow[]` |
| `fleet()` | `GET /v1/fleet` | `FleetState` |
| `schedule.get()` | `GET /v1/schedule` | `Schedule` |
| `schedule.set(schedule)` | `PUT /v1/schedule` | `Schedule` |

### Error handling

Every non-2xx response throws a `SocheliError`:

```ts
import { SocheliError } from "@socheli/sdk";

try {
  await socheli.items.get("does-not-exist");
} catch (e) {
  if (e instanceof SocheliError) {
    console.error(e.status, e.message, e.body); // e.g. 404, error text, parsed body
    if (e.status === 404) {
      // not found
    }
  }
}
```

`SocheliError` carries `status` (the HTTP code) and `body` (the parsed response). Its `message` is the response body's `error` field when present, otherwise `${method} ${path} → ${status}` (e.g. `GET /items/x → 404`).

### Custom fetch (testing / local API)

```ts
const socheli = createSocheli({
  apiKey: "sk_test_123",
  baseUrl: "http://localhost:8787", // hits http://localhost:8787/v1/...
  fetch: myMockFetch,               // any fetch-compatible impl
});
```

---

## Path 3 — MCP

`@socheli/mcp` is a stdio JSON-RPC Model Context Protocol server. Point an MCP client (Claude Desktop, Claude Code) at it and your agent can list items, dispatch renders, check the fleet, and publish — all backed by the same API via the SDK.

### 1. Configure the client

Add a `socheli` entry to your MCP client config (e.g. `.mcp.json`). Auth is entirely env-driven — the server passes `SOCHELI_API_URL` and `SOCHELI_API_KEY` straight into the SDK:

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

> The server runs TypeScript directly, so the `node --import tsx` command (which the package's shebang also uses) must have `tsx` available. Use an absolute path to `packages/mcp/src/index.ts` if your client's working directory differs. `npx @socheli/mcp` is planned for a future published release.

On startup the server constructs a single SDK client and registers six tools. It speaks JSON-RPC 2.0 over stdin/stdout with LSP-style `Content-Length` framing, handling `initialize`, `notifications/initialized`, `tools/list`, and `tools/call`. `serverInfo` is `{ name: "socheli", version: "0.1.0" }`.

### 2. The six tools

All tool names are prefixed `socheli_`:

| Tool | Arguments | Maps to |
| --- | --- | --- |
| `socheli_list_items` | `{ limit?, channel? }` (limit default 20) | `items.list` |
| `socheli_get_item` | `{ id }` (required) | `items.get` |
| `socheli_generate` | `{ seed (required), channel?, type?, mood?, voice? }` | `generate` |
| `socheli_jobs` | `{}` | `jobs` |
| `socheli_fleet_status` | `{}` | `fleet` |
| `socheli_publish` | `{ id (required), public? }` | `items.publish` |

### 3. Drive it from an agent

Once the server is wired up, prompt the model naturally — it picks the tools:

> "Check which render devices are online, then generate a cinematic narrated video about the science of habit on the concept_lab channel and publish it publicly when it's done."

Under the hood that becomes `socheli_fleet_status`, then `socheli_generate` with `{ "seed": "the science of habit", "channel": "concept_lab", "type": "auto", "mood": "cinematic", "voice": true }`, then `socheli_publish`.

A `tools/call` request and response look like:

```json
// request
{
  "jsonrpc": "2.0",
  "id": 7,
  "method": "tools/call",
  "params": {
    "name": "socheli_generate",
    "arguments": {
      "seed": "the science of habit",
      "channel": "concept_lab",
      "type": "auto",
      "mood": "cinematic",
      "voice": true
    }
  }
}

// response — handler return value JSON-stringified into a text content block
{
  "jsonrpc": "2.0",
  "id": 7,
  "result": {
    "content": [
      { "type": "text", "text": "{\n  \"dispatched\": true,\n  \"job\": { \"id\": \"job_...\", \"type\": \"auto\", \"channel\": \"concept_lab\" }\n}" }
    ]
  }
}
```

> **API failures surface as tool results, not protocol errors.** If a handler throws (e.g. a `401` because `SOCHELI_API_KEY` is unset or wrong), the response is a normal tool result with `isError: true` and the message as text — so the model sees and can react to it. Only an unknown tool name yields a real JSON-RPC `-32601` error.

---

## The shared lifecycle

Whichever path you take, the same flow runs underneath:

1. **Generate** — `socheli generate` / `socheli.generate(...)` / `socheli_generate`. The API derives the job's capability requirements, picks the best-fit online device, and dispatches the job over MQTT. The call returns immediately with a `job`.
2. **Poll** — `socheli jobs` / `socheli.jobs()` / `socheli_jobs`. Generation is asynchronous; watch the job's status move to `done`. The server never renders — devices do, then sync the finished `.mp4` up to `media.socheli.com/<id>.mp4`.
3. **Publish** — `socheli publish` / `socheli.items.publish(...)` / `socheli_publish` (or skip it by passing `type: "auto"` at generate time).

### Common failure modes

| Symptom | Cause | Fix |
| --- | --- | --- |
| `401 unauthorized` | Missing or wrong API key | Set `SOCHELI_API_KEY` (or `socheli login` / `env` block) |
| `503` on every route | Server has no key configured | Server-side issue, not your key |
| `503` on `generate` (with `requirements`) | No online device with the required render capability | Check `fleet` — bring a device online |
| `502` on `generate` | The job-dispatch broker is unreachable | Server-side / transient; retry |
| `400` on `generate` | Missing `seed` | Provide a non-empty idea |
| `404` on `get`/`publish` | Item id doesn't exist | Verify the id via `items` |

## Next steps

- **Schedule autopilot posting** with `schedule.get()` / `schedule.set()` (SDK) or `GET`/`PUT /v1/schedule` (API) to drive recurring per-channel posting slots.
- **Go deeper on each surface** in the SDK, CLI, MCP, and API reference docs — every endpoint, type, and flag is documented there.
