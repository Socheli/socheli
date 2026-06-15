# Socheli CLI

The **`socheli`** command (`@socheli/cli`) is a single-file, zero-build TypeScript CLI that remote-controls the hosted Socheli content engine over the `api.socheli.com/v1` HTTP API. It is a thin wrapper around [`@socheli/sdk`](/docs/sdk): every command turns into one authenticated REST call, so the CLI inherits the same surface, the same single Bearer API key, and the same typed contract as the SDK and [MCP server](/docs/mcp).

One idea becomes a finished vertical video without leaving your shell — `socheli generate "<idea>"` dispatches a render job to the device fleet, `socheli jobs`/`socheli fleet` show progress, and `socheli publish` ships the result.

```bash
socheli login --key sk_live_...
socheli generate "why we procrastinate" --channel concept_lab --auto
socheli jobs
```

## Install

The CLI ships as an ESM package whose `bin` entry points straight at the TypeScript source (`src/index.ts`), executed via the `node --import tsx` shebang. It declares a single dependency — `@socheli/sdk` — and has no build step.

```json
{
  "name": "@socheli/cli",
  "version": "0.1.0",
  "type": "module",
  "bin": { "socheli": "src/index.ts" },
  "dependencies": { "@socheli/sdk": "workspace:*" }
}
```

Install it globally to get the `socheli` binary on your `PATH`:

```bash
npm install -g @socheli/cli
socheli health
```

Or run it without a global install:

```bash
npx @socheli/cli health
```

> The shebang is `#!/usr/bin/env -S node --import tsx`, so a Node 18+ runtime with `tsx` available is all that's required — there is nothing to compile.

## Authentication & configuration

Every command builds its client from two values — the API **base URL** and the **API key** — resolved in a fixed precedence order. Environment variables always win over the on-disk config file written by `socheli login`.

```ts
function client() {
  const cfg = loadCfg();
  return createSocheli({
    baseUrl: process.env.SOCHELI_API_URL || cfg.apiUrl,
    apiKey:  process.env.SOCHELI_API_KEY || cfg.apiKey,
  });
}
```

### Resolution order

| Setting  | 1. Environment        | 2. Config file (`~/.socheli/config.json`) | 3. SDK default            |
| -------- | --------------------- | ----------------------------------------- | ------------------------- |
| Base URL | `SOCHELI_API_URL`     | `apiUrl`                                   | `https://api.socheli.com` |
| API key  | `SOCHELI_API_KEY`     | `apiKey`                                   | _(none → unauthenticated)_ |

The default base URL of `https://api.socheli.com` is supplied by the SDK itself, so the config file's `apiUrl` is only needed when pointing the CLI at a non-production deployment.

### Environment variables

| Variable           | Description                                                         |
| ------------------ | ------------------------------------------------------------------ |
| `SOCHELI_API_KEY`  | Bearer API key. Sent as `Authorization: Bearer <key>` on every request. |
| `SOCHELI_API_URL`  | Override the API base URL (e.g. a staging host). Defaults to `https://api.socheli.com`. |

```bash
export SOCHELI_API_KEY="sk_live_..."
export SOCHELI_API_URL="https://api.socheli.com"   # optional override
socheli items --limit 5
```

Environment variables are ideal for CI, ephemeral shells, and any context where you don't want credentials written to disk. They override the config file entirely.

### `socheli login` — persist credentials

`login` writes a `config.json` under `~/.socheli/`, creating the directory if needed. This is the one-time, interactive-machine setup; afterwards every command picks the key up automatically.

```bash
socheli login --key sk_live_abc123
# ✓ saved → /Users/you/.socheli/config.json
```

| Flag / arg     | Default                     | Description                                   |
| -------------- | --------------------------- | --------------------------------------------- |
| `--key <KEY>`  | — _(required)_              | Your Bearer API key. May also be passed positionally as the first argument. |
| `--url <URL>`  | `https://api.socheli.com`   | API base URL to store alongside the key.      |

The key can be passed either with the flag or positionally — both forms below are equivalent:

```bash
socheli login --key sk_live_abc123
socheli login sk_live_abc123
```

Omitting the key prints the usage line and exits non-zero:

```text
usage: socheli login --key <API_KEY> [--url https://api.socheli.com]
```

The resulting file is plain JSON:

```json
{
  "apiUrl": "https://api.socheli.com",
  "apiKey": "sk_live_abc123"
}
```

## Command reference

`socheli` parses `argv` positionally: the first token is the command, the rest are its arguments and flags. Boolean flags (`--auto`, `--voice`, `--public`) are presence-only; valued options (`--limit`, `--channel`, `--mood`, `--url`, `--key`) take the following token as their value. Running `socheli` with no command — or any unknown command — prints the built-in help.

| Command    | Arguments                                                  | Summary                                  |
| ---------- | --------------------------------------------------------- | ---------------------------------------- |
| `login`    | `--key <KEY> [--url <api>]`                                | Save credentials to `~/.socheli/config.json`. |
| `health`   | —                                                          | Print API status JSON.                   |
| `items`    | `[--limit n] [--channel id]`                              | List content items (one line each).      |
| `get`      | `<id>`                                                     | Print the full item JSON.                |
| `generate` | `"<idea>" [--channel id] [--auto] [--voice] [--mood id]`  | Dispatch a render job to the fleet.      |
| `jobs`     | —                                                          | List recent fleet jobs.                  |
| `fleet`    | —                                                          | List connected render devices.           |
| `publish`  | `<id> [--public]`                                          | Publish an item.                         |
| `tools`    | —                                                          | List every registry tool (name / kind / desc). |
| `tool`     | `<name> [json]`                                            | Call any registry tool with a JSON input. |
| `plan`     | `<list\|day\|get\|move\|archive\|delete\|run> …`           | Curate the content calendar/plan ([Calendar & Plan](calendar.md)). |

### `health`

Pings `GET /v1/health` and prints the response verbatim. Useful as a connectivity / auth smoke test.

```bash
socheli health
```

```json
{
  "ok": true,
  "version": "1.4.0",
  "uptime": 53412
}
```

### `items` — list content

Lists content items as a compact, scriptable table: `id`, padded `status`, an optional `QA<score>` column, then the `title`.

| Flag             | Default | Description                                       |
| ---------------- | ------- | ------------------------------------------------- |
| `--limit <n>`    | `20`    | Maximum number of items to return.                |
| `--channel <id>` | _(all)_ | Filter to a single channel (e.g. `concept_lab`).  |

```bash
socheli items --limit 10 --channel concept_lab
```

```text
itm_8fa2  packaged       QA9.2  Why we procrastinate
itm_8fb0  rendered            Â  The myth of multitasking
itm_8fc1  qa_failed      QA4.1  Dopamine, explained
```

The `status` column is one of the engine's `ItemStatus` values: `idea_proposed`, `script_ready`, `storyboard_ready`, `qa_passed`, `qa_failed`, `rendered`, `packaged`, or `failed`. The `QA<n>` column is only shown when the item has a QA score.

### `get <id>` — inspect one item

Fetches a single item and pretty-prints its full JSON, including the nested `idea`, `script`, `storyboard`, `pkg`, and `videoUrl` fields when present.

```bash
socheli get itm_8fa2
```

```json
{
  "id": "itm_8fa2",
  "channel": "concept_lab",
  "status": "packaged",
  "title": "Why we procrastinate",
  "qa": 9.2,
  "script": { "hook": "...", "narration": ["..."], "cta": "..." },
  "videoUrl": "https://media.socheli.com/itm_8fa2.mp4"
}
```

Pipe it into `jq` to pull out exactly the field you need (see [Scripting](#scripting--automation)).

### `generate "<idea>"` — dispatch a render

The headline command. It takes a free-text idea (all remaining positional tokens are joined into the `seed`) and dispatches a render job to the device fleet. On success it prints the dispatched job's id, type, and target channel.

| Flag             | Default        | Description                                                                 |
| ---------------- | -------------- | --------------------------------------------------------------------------- |
| `--channel <id>` | `concept_lab`  | Target channel for the generated post.                                      |
| `--mood <id>`    | _(none)_       | Mood preset — shapes background, typography, transitions, b-roll. See [MOODS.md](./MOODS.md). |
| `--auto`         | _off_          | Use job `type: "auto"` — render **and** publish. Without it, `type: "new"` builds only. |
| `--voice`        | _off_          | Enable AI voiceover narration.                                              |

```bash
socheli generate "why we procrastinate" --channel concept_lab --mood cinematic --voice --auto
# ✓ dispatched job_5c1d (auto) → concept_lab
```

Because the seed is built from all leftover arguments, quoting is optional but recommended for multi-word ideas containing shell metacharacters. An empty idea prints usage and exits non-zero:

```text
usage: socheli generate "<idea>" [--channel x] [--auto] [--voice]
```

> **`--auto` vs default:** the underlying `GenerateInput.type` is `"new"` by default (build only) and `"auto"` when `--auto` is passed (build then publish). Use `--auto` for fully unattended idea→post pipelines; omit it when you want to review before publishing.

### `jobs` — recent fleet jobs

Lists recent render jobs across the fleet, one line each: `id`, padded `status`, padded `type`, the assigned `device` (or `-`), and the resulting `itemId` once known.

```bash
socheli jobs
```

```text
job_5c1d  running     auto  render-01  itm_8fa2
job_5c0a  done        new   render-01  itm_8fb0
job_5bf3  dispatched  new   -          
```

`status` is one of `dispatched`, `running`, `done`, or `error`; `type` is `auto`, `new`, or `ping`.

### `fleet` — connected devices

Prints how many devices are online, then one line per device with its name, status, host, and current job (if any).

```bash
socheli fleet
```

```text
1 device(s) online
  render-01    online   your-server.example.com  job job_5c1d
```

Device `status` is one of `online`, `idle`, `busy`, or `offline`. The control plane dispatches jobs to these devices over MQTT; finished mp4s are rsynced back to the public media host.

### `publish <id>` — ship an item

Publishes an already-rendered item. By default it publishes privately/unlisted; `--public` publishes publicly.

| Flag        | Default | Description                                    |
| ----------- | ------- | ---------------------------------------------- |
| `--public`  | _off_   | Publish the item publicly rather than private. |

```bash
socheli publish itm_8fa2 --public
# ✓ publishing itm_8fa2 (public)
```

The corresponding API request declares AI-generated content by default (`aigc: true` in the SDK's `PublishInput`); the CLI sends only the `public` flag and lets the engine apply its defaults.

## End-to-end workflow

A complete idea→published-post loop from the terminal:

```bash
# 1. Authenticate once.
socheli login --key sk_live_...

# 2. Confirm the API and fleet are healthy.
socheli health
socheli fleet

# 3. Dispatch a render (build only — no auto-publish yet).
socheli generate "the myth of multitasking" --channel concept_lab --voice
# ✓ dispatched job_5c20 (new) → concept_lab

# 4. Watch it move through the fleet.
socheli jobs

# 5. Once it's packaged, inspect and publish.
socheli items --channel concept_lab --limit 5
socheli get itm_9001
socheli publish itm_9001 --public
```

## Scripting & automation

The CLI is designed to compose cleanly in shells and CI. A few patterns:

**JSON commands pipe into `jq`.** `health` and `get` emit pretty-printed JSON; pull out a single field directly:

```bash
socheli get itm_8fa2 | jq -r '.videoUrl'
socheli health | jq -e '.ok'   # exit 0 only when the API reports ok
```

**Table commands are line-oriented** and whitespace-delimited — slice them with `awk`:

```bash
# All packaged item ids, ready to publish.
socheli items --limit 100 | awk '$2 == "packaged" { print $1 }'

# Every job currently running.
socheli jobs | awk '$2 == "running"'
```

**Fan out generation over a list of ideas:**

```bash
while IFS= read -r idea; do
  socheli generate "$idea" --channel concept_lab --mood cinematic --auto
done < ideas.txt
```

**Use env vars for credentials in CI** so nothing is written to disk:

```bash
SOCHELI_API_KEY="$CI_SOCHELI_KEY" socheli generate "$TOPIC" --auto
```

### Exit codes & error handling

Every invocation runs through a top-level `catch`. Two failure shapes are distinguished:

- **API errors** surface as `SocheliError` and print the HTTP status with the engine's error message:

  ```text
  ✗ 401: invalid api key
  ```

- **Other errors** (network, bad input) print the raw message:

  ```text
  ✗ fetch failed
  ```

Usage errors (missing required argument) print the `usage:` line. In all error cases `process.exitCode` is set to `1`, so shell `&&`/`||` chaining and CI gating work as expected:

```bash
socheli health && socheli generate "$TOPIC" --auto || echo "engine unreachable"
```

A `0` exit code means the command's single API call returned a non-error HTTP status.

### `moods` — list mood presets

Prints all available mood presets with their visual identity (background variant, transitions, accent, whether b-roll is stock or native).

```bash
content moods             # human-readable table
content moods --json      # JSON (for scripting / agents)
```

See [MOODS.md](./MOODS.md) for the full reference including named blends and typography mappings.

### `broll-sources` — show active b-roll providers

Reports which b-roll / AI-video providers are configured (API keys present) and which are gated.

```bash
content broll-sources
# ■ b-roll / AI-video sources
#   Active sources:   pexels, pixabay
#   Gated (key req.): kling_ai, pika_v2, minimax_hailuo, luma_dream_machine
```

Set `KLING_API_KEY`, `PIKA_API_KEY`, `MINIMAX_API_KEY`, or `LUMALABS_API_KEY` in your `.env` to activate AI video generation for abstract b-roll scenes.

## Related surfaces

The CLI is one of several clients over the same control-plane API. They share one Bearer key and the same `/v1` contract:

- **[`@socheli/sdk`](/docs/sdk)** — the typed TypeScript client the CLI wraps; use it to embed the engine in your own app.
- **[`@socheli/mcp`](/docs/mcp)** — a Model Context Protocol server exposing the engine as tools for AI agents.
- **[`@socheli/api`](/docs/api)** — the underlying Hono REST API served at `api.socheli.com/v1`.

Because all four sit on the same key and the same endpoints, anything you do in the CLI is reflected immediately across the SDK, MCP, and dashboard.
