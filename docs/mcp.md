# MCP Server — `@socheli/mcp`

A [Model Context Protocol](https://modelcontextprotocol.io) server that exposes the Socheli content engine as a set of agent-callable tools. Point Claude Desktop, Claude Code, or any MCP client at it and the model can list and inspect content items, dispatch render jobs to the device fleet, check fleet/device status, and publish finished videos — all over the same `api.socheli.com/v1` REST surface the SDK and CLI use.

It is intentionally tiny: a **dependency-free stdio JSON-RPC server** (its only dependency is [`@socheli/sdk`](/docs/sdk)) that speaks the Model Context Protocol over `Content-Length`-framed messages on stdin/stdout, mirroring the repo's internal `editor-mcp` wire pattern. Every tool is a thin wrapper over a typed SDK call.

```
Claude / MCP client  ──stdio JSON-RPC──►  @socheli/mcp  ──HTTPS /v1──►  api.socheli.com  ──MQTT──►  render fleet
```

## What it is

| | |
|---|---|
| **Package** | `@socheli/mcp` |
| **Binary** | `socheli-mcp` (maps to `src/index.ts`) |
| **Transport** | stdio, JSON-RPC 2.0 with `Content-Length` framing |
| **Protocol version** | `2024-11-05` (echoes the client's requested version on `initialize`) |
| **Server identity** | `name: "socheli"`, `version: "0.1.0"` |
| **Capabilities** | `tools` only |
| **Dependencies** | [`@socheli/sdk`](/docs/sdk) (which itself is zero-runtime-dependency `fetch`) |
| **Tools exposed** | 15 — 6 core + 7 calendar/plan + 2 generic passthrough; see [Tools](#tools) |

The server is created at startup with a single SDK client:

```ts
const socheli = createSocheli({
  baseUrl: process.env.SOCHELI_API_URL,
  apiKey: process.env.SOCHELI_API_KEY,
});
```

That means all authentication and routing is driven by two environment variables, set in your MCP client config (below). One Bearer API key authorizes every tool.

## Configuration

The server reads exactly two environment variables. Both are passed by the SDK to `createSocheli`; if `SOCHELI_API_URL` is omitted the SDK defaults to `https://api.socheli.com`.

| Env var | Required | Default | Description |
|---|---|---|---|
| `SOCHELI_API_KEY` | Yes | — | Bearer API key sent as `Authorization: Bearer <key>` on every request. Provision one from your Socheli deployment (`/opt/socheli/.env` on the host, or your dashboard). |
| `SOCHELI_API_URL` | No | `https://api.socheli.com` | Base URL of the Socheli REST API. The SDK appends `/v1` and strips a trailing slash, so `https://api.socheli.com` and `https://api.socheli.com/` are equivalent. Point this at a self-hosted instance if needed. |

## Install & run

The server runs `src/index.ts` directly via `tsx` — there is no build step. The package shebang is `#!/usr/bin/env -S node --import tsx`, and the canonical client invocation is `node --import tsx packages/mcp/src/index.ts`.

### Claude Code

Add an entry to your project's `.mcp.json` (or your user-level MCP config). Claude Code launches the server on stdio:

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

If you are running from outside the repo, use an absolute path to `packages/mcp/src/index.ts`. Once the package is published to npm you can swap the command to `npx`:

```json
{
  "mcpServers": {
    "socheli": {
      "command": "npx",
      "args": ["-y", "@socheli/mcp"],
      "env": {
        "SOCHELI_API_URL": "https://api.socheli.com",
        "SOCHELI_API_KEY": "sk_live_xxx"
      }
    }
  }
}
```

### Claude Desktop

Claude Desktop uses the same schema. Edit `claude_desktop_config.json` (Settings → Developer → Edit Config), add the `socheli` server under `mcpServers`, then fully restart Claude Desktop:

```json
{
  "mcpServers": {
    "socheli": {
      "command": "node",
      "args": ["--import", "tsx", "/absolute/path/to/packages/mcp/src/index.ts"],
      "env": {
        "SOCHELI_API_URL": "https://api.socheli.com",
        "SOCHELI_API_KEY": "sk_live_xxx"
      }
    }
  }
}
```

After restart you should see the `socheli` tools available in the client. The tools are namespaced with a `socheli_` prefix so they're unambiguous alongside other MCP servers.

## Tools

All tools are declared statically and advertised via `tools/list`. Each tool's `run` maps directly to a typed SDK method (the calendar tools use the SDK's `plan` namespace; the generic passthrough uses `tool()` / `tools()`). Tool results are returned as a single text content block — structured results are JSON-stringified (`JSON.stringify(value, null, 2)`); errors are returned as a text block with `isError: true` rather than a JSON-RPC error, so the model can read and react to them.

| Tool | Maps to | Required args | Optional args |
|---|---|---|---|
| `socheli_list_items` | `socheli.items.list()` | — | `limit` (number, default 20), `channel` (string) |
| `socheli_get_item` | `socheli.items.get()` | `id` (string) | — |
| `socheli_generate` | `socheli.generate()` | `seed` (string) | `channel`, `type` (`new`\|`auto`), `mood`, `voice` (boolean), `abStoryboard` (boolean, default true), `maxQaPasses` (1–5, default 3) |
| `socheli_jobs` | `socheli.jobs()` | — | — |
| `socheli_fleet_status` | `socheli.fleet()` | — | — |
| `socheli_publish` | `socheli.items.publish()` | `id` (string) | `public` (boolean) |
| `socheli_plan_list` | `socheli.plan.list()` | — | `channel`, `status`, `includeArchived` |
| `socheli_plan_day` | `socheli.plan.day()` | `date` (YYYY-MM-DD) | `includeArchived` |
| `socheli_plan_update` | `socheli.plan.update()` | `id`, `patch` (object) | — |
| `socheli_plan_move` | `socheli.plan.move()` | `id`, `date` | `time` (HH:MM) |
| `socheli_plan_archive` | `socheli.plan.archive()` | `id` | — |
| `socheli_plan_delete` | `socheli.plan.remove()` | `id` | — |
| `socheli_plan_run` | `socheli.plan.run()` | `channel` | `days`, `platforms`, `time` |
| `socheli_list_tools` | `socheli.tools()` | — | — |
| `socheli_call_tool` | `socheli.tool()` | `name` | `input` (object) |
| `socheli_moods_list` | `socheli.tool("tools_moods_list")` | — | `includeBlends` (boolean, default true) |
| `socheli_broll_sources` | `socheli.tool("tools_broll_sources")` | — | — |

The calendar/plan tools curate the dated content plan; see [Calendar & Plan](calendar.md) for the data model and the same CRUD on every other surface.

### `socheli_list_items`

> List recent content items (id, status, QA score, title). Optionally filter by channel or limit.

| Arg | Type | Default | Description |
|---|---|---|---|
| `limit` | number | `20` | Max items to return. |
| `channel` | string | — | Filter to a single channel id. |

Returns an array of `ItemSummary`:

```ts
interface ItemSummary {
  id: string;
  channel: string;
  status: ItemStatus | string;   // "idea_proposed" | "script_ready" | "storyboard_ready"
                                  // | "qa_passed" | "qa_failed" | "rendered" | "packaged" | "failed"
  title: string;
  createdAt: string;
  updatedAt: string;
  qa?: number;
  costUsd?: number;
  publish?: PublishEntry[];
}
```

**Example call**

```json
{
  "name": "socheli_list_items",
  "arguments": { "limit": 5, "channel": "concept_lab" }
}
```

### `socheli_get_item`

> Get the full detail of one content item by id (idea, script, storyboard, package, video URL, publish state).

| Arg | Type | Required | Description |
|---|---|---|---|
| `id` | string | Yes | The content item id. |

Returns a full `Item` (an `ItemSummary` plus the generated artifacts):

```ts
interface Item extends ItemSummary {
  idea?: { topic: string; angle: string; format: string };
  script?: { hook: string; narration: string[]; cta: string };
  storyboard?: { topic: string; format: string; scenes: { id: string; type: string; durationSec: number }[] };
  pkg?: { title: string; caption: string; hashtags: string[]; altText?: string };
  videoUrl?: string;
}
```

**Example call**

```json
{
  "name": "socheli_get_item",
  "arguments": { "id": "itm_8f3a21" }
}
```

### `socheli_generate`

> Dispatch a new render job to the device fleet from an idea/seed. type 'auto' also publishes; 'new' builds only.

| Arg | Type | Required | Default | Description |
|---|---|---|---|---|
| `seed` | string | Yes | — | The idea/topic to make a video about. |
| `channel` | string | No | `concept_lab` | Channel id to attribute the job to. |
| `type` | `"new"` \| `"auto"` | No | `new` | `new` builds only; `auto` also publishes after render. |
| `mood` | string | No | — | Mood preset (e.g. `cinematic`, or a blend like `cinematic*0.7+tech*0.3`). |
| `voice` | boolean | No | — | Whether to generate a voiceover. |

Returns `{ dispatched: boolean; job: Job }`, where `Job` describes the dispatched fleet job:

```ts
interface Job {
  id: string;
  type: "auto" | "new" | "ping";
  channel?: string;
  seed?: string;
  by?: string;
  createdAt: string;
}
```

**Example call**

```json
{
  "name": "socheli_generate",
  "arguments": {
    "seed": "why we procrastinate",
    "channel": "concept_lab",
    "type": "auto",
    "mood": "cinematic",
    "voice": true
  }
}
```

### `socheli_jobs`

> List recent fleet jobs and their status (dispatched/running/done/error) and which device ran them.

Takes no arguments. Returns an array of `JobRow`:

```ts
interface JobRow extends Job {
  status: "dispatched" | "running" | "done" | "error";
  device?: string;
  itemId?: string;
  message?: string;
  progress: { at: string; line: string }[];
  updatedAt: string;
}
```

**Example call**

```json
{ "name": "socheli_jobs", "arguments": {} }
```

### `socheli_fleet_status`

> Show connected render devices and how many are online/idle/busy.

Takes no arguments. Returns the `FleetState`:

```ts
interface FleetState {
  devices: Device[];
  jobs: JobRow[];
  online: number;
}

interface Device {
  device: string;
  status: "online" | "idle" | "busy" | "offline";
  host?: string;
  caps?: string[];
  profile?: { arch: string; platform: string; cpus: number; ramGb: number; gpu: string };
  currentJob?: string | null;
  lastSeen: string;
}
```

**Example call**

```json
{ "name": "socheli_fleet_status", "arguments": {} }
```

### `socheli_publish`

> Publish a finished item to every configured platform (YouTube/IG/TikTok + bundle). Set public to go public.

| Arg | Type | Required | Description |
|---|---|---|---|
| `id` | string | Yes | The content item id to publish. |
| `public` | boolean | No | If `true`, publish publicly; otherwise unlisted/private per platform defaults. |

Returns `{ dispatched: boolean }`.

**Example call**

```json
{
  "name": "socheli_publish",
  "arguments": { "id": "itm_8f3a21", "public": true }
}
```

## Protocol details

The server implements the minimum MCP surface needed for tool use. Method handling:

| JSON-RPC method | Behavior |
|---|---|
| `initialize` | Returns `protocolVersion` (echoing the client's, defaulting to `2024-11-05`), `capabilities: { tools: {} }`, and `serverInfo: { name: "socheli", version: "0.1.0" }`. |
| `notifications/initialized` | Acknowledged silently (no response). |
| `tools/list` | Returns the 6 tools as `{ name, description, inputSchema }`. |
| `tools/call` | Looks up the tool by `params.name`, runs it with `params.arguments` (defaulting to `{}`), and returns a text content block. Unknown tool → JSON-RPC error `-32601`. Thrown errors → text block with `isError: true`. |
| any other (with id) | JSON-RPC error `-32601` `method not found`. |

Messages are framed with `Content-Length: <n>\r\n\r\n<body>` on both stdin and stdout — the standard stdio MCP framing. Malformed frames are ignored.

### Error semantics

There are two distinct error paths:

- **Protocol errors** (unknown method, unknown tool) return a JSON-RPC `error` object with code `-32601`.
- **Tool execution errors** (e.g. a `SocheliError` from a failed HTTP call) are *not* surfaced as JSON-RPC errors. Instead they return a normal result containing `{ content: [{ type: "text", text: "error: <message>" }], isError: true }`. This lets the model read the failure (e.g. an auth or 404 message) and decide how to recover, rather than aborting the turn.

Under the hood, a failed API call throws a `SocheliError` carrying the HTTP `status` and response `body`; the MCP layer renders its `message` into the text block.

## Relationship to the other surfaces

The MCP server is one of four interchangeable front-ends over the same control plane:

- **[REST API](/docs/api)** (`@socheli/api`) — the Bearer-authenticated `/v1` backbone at `api.socheli.com` that everything below consumes.
- **[SDK](/docs/sdk)** (`@socheli/sdk`) — the typed `createSocheli()` client the MCP server wraps directly.
- **[CLI](/docs/cli)** (`@socheli/cli`) — the `socheli` command, also a thin SDK wrapper, for humans and scripts.
- **MCP** (this page) — the same SDK calls exposed as agent tools.

Because all four share one API key and one REST surface, anything you can do via the CLI or SDK, an agent can do through these MCP tools — and the results (`Item`, `JobRow`, `FleetState`, …) are the exact same typed shapes documented in the [SDK reference](/docs/sdk).

## The other direction: connecting MCP servers TO Soli

Everything above exposes Socheli *as* an MCP server. The dashboard copilot (Soli) can also act as an MCP **client**: under **Settings → MCP connections** an admin/owner can register external MCP servers, and their tools join Soli's toolbox as `mcp_<serverId>_<toolName>` next to the engine registry (refreshed within ~60s, no restart).

- Config lives in `data/mcp-servers.json` (gitignored); managed via `/api/mcp-servers` (admin/owner only, audited).
- `http` transport (streamable-HTTP JSON-RPC POSTs) is always available. `stdio` transport spawns a local command, so it is **disabled unless the deployment sets `MCP_ALLOW_STDIO=1`** — on a shared server it would be remote code execution.
- A stdio server's `env` field lists the *names* of host env vars to pass through; values are never stored or shown.
- External tools are gated as mutations by default (member+), with an obvious `list/get/read` name prefix classed read-only.

Client implementation: `apps/dashboard/lib/agent/mcp.ts` (speaks both newline-delimited and `Content-Length`-framed stdio dialects).
