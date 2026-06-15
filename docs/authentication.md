# Authentication

Socheli authenticates every public surface with **one static Bearer API key**. The same `SOCHELI_API_KEY` value authorizes the REST API at `api.socheli.com`, the `@socheli/sdk` TypeScript client, the `socheli` CLI, and the `@socheli/mcp` server. There is a single source of truth, a single header on the wire, and a single secret to rotate.

```
SOCHELI_API_KEY ──┬─▶ HTTP    Authorization: Bearer <key>   (api.socheli.com)
                  ├─▶ SDK     createSocheli({ apiKey })     (sent as the same header)
                  ├─▶ CLI     env or ~/.socheli/config.json  (delegated to the SDK)
                  └─▶ MCP      env on the server process      (delegated to the SDK)
```

> **Scope of this key.** It authenticates the Socheli **content-engine control plane** — listing/inspecting items, dispatching render jobs, reading the fleet, and publishing. It is *not* the dashboard login (that is Clerk) and *not* the MQTT broker credentials (`SOCHELI_MQTT_USER` / `SOCHELI_MQTT_PASS`, used only server-side). Those are three independent auth systems; this page covers only the API key.

## The key

The key is a single opaque string (documented example form: `sk_live_xxx`). It is compared on the server with strict equality — there are no per-user keys, scopes, or token classes. Possession of the key is full access to the API surface.

On the production host the key lives in `/opt/socheli/.env` as `SOCHELI_API_KEY`. The API server (`packages/api/src/server.ts`) reads it once at boot:

```ts
const API_KEY = process.env.SOCHELI_API_KEY || "";
```

If the server boots without a key set, it logs a warning and **rejects every authenticated route with `503`** until a key is configured (see [Failure modes](#failure-modes)).

## How the server checks it

A single Hono middleware mounted on `/v1/*` gates the entire API. It strips the `Bearer ` prefix (case-insensitive) from the `Authorization` header and compares the remainder to the configured key with `===`:

```ts
app.use("/v1/*", async (c, next) => {
  if (c.req.path === "/v1/health") return next();          // health is exempt
  const auth = c.req.header("Authorization") || "";
  const key = auth.replace(/^Bearer\s+/i, "");
  if (!API_KEY) return c.json({ error: "API not configured (no SOCHELI_API_KEY)" }, 503);
  if (key !== API_KEY) return c.json({ error: "unauthorized" }, 401);
  return next();
});
```

| Property | Behavior |
| --- | --- |
| Header | `Authorization: Bearer <key>` |
| Prefix match | `Bearer ` stripped case-insensitively (`bearer`, `BEARER` all work) |
| Comparison | strict `===` against `process.env.SOCHELI_API_KEY` |
| Exempt route | `GET /v1/health` only — it returns `next()` before the check |
| No key on server | `503 { "error": "API not configured (no SOCHELI_API_KEY)" }` |
| Wrong / missing key | `401 { "error": "unauthorized" }` |

`GET /v1/health` is the **only** unauthenticated route. Every other `/v1/*` endpoint — `/items`, `/items/:id`, `/generate`, `/items/:id/publish`, `/jobs`, `/fleet`, `/schedule` — requires the key.

## Consuming the key per surface

### HTTP (direct)

Send the key as a Bearer header on every request except health. All routes live under the `/v1` prefix at `https://api.socheli.com`.

```bash
# Health needs no auth
curl -s https://api.socheli.com/v1/health
# → {"ok":true,"version":"0.1.0","uptime":1234}

# Everything else does
curl -s 'https://api.socheli.com/v1/items?channel=concept_lab&limit=10' \
  -H "Authorization: Bearer $SOCHELI_API_KEY"

curl -s -X POST https://api.socheli.com/v1/generate \
  -H "Authorization: Bearer $SOCHELI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"seed":"why we procrastinate","channel":"concept_lab","type":"auto"}'
```

A wrong or absent key returns `401 {"error":"unauthorized"}`.

### SDK (`@socheli/sdk`)

The client resolves the key from `opts.apiKey`, falling back to `process.env.SOCHELI_API_KEY`. When a key is present it is attached as `Authorization: Bearer <apiKey>` on every request; the `/v1` prefix is injected internally.

```ts
import { createSocheli } from "@socheli/sdk";

// Explicit
const socheli = createSocheli({ apiKey: "sk_live_xxx" });

// Or rely on the env fallback — equivalent to the above when SOCHELI_API_KEY is set
const socheli2 = createSocheli();

await socheli.fleet(); // → GET https://api.socheli.com/v1/fleet with Bearer auth
```

The resolution and header logic, verbatim from `packages/sdk/src/index.ts`:

```ts
const apiKey = opts.apiKey ?? (typeof process !== "undefined" ? process.env?.SOCHELI_API_KEY : undefined);
// ...
headers: {
  ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
  ...(body ? { "Content-Type": "application/json" } : {}),
},
```

| SDK option | Env fallback | Default |
| --- | --- | --- |
| `apiKey` | `SOCHELI_API_KEY` | *(none — header omitted if unresolved)* |
| `baseUrl` | `SOCHELI_API_URL` | `https://api.socheli.com` |
| `fetch` | — | global `fetch` |

> **`process` is accessed defensively** (`typeof process !== "undefined"`), so the SDK is safe in browsers, Deno, and edge runtimes. But in those runtimes there is no env to fall back to — you **must** pass `apiKey` explicitly.

#### Failing on auth errors

When the server returns a non-2xx response, the SDK throws `SocheliError` carrying the HTTP status and parsed body. A bad key surfaces as a `401`:

```ts
import { SocheliError } from "@socheli/sdk";

try {
  await socheli.items.list();
} catch (e) {
  if (e instanceof SocheliError && e.status === 401) {
    // unauthorized — key missing, wrong, or rotated out
    console.error(e.message, e.body);
  }
}
```

### CLI (`socheli`)

The CLI is a thin remote control built on the SDK. It resolves credentials **env-first**, then falls back to a config file written by `socheli login`. The resolution, verbatim from `packages/cli/src/index.ts`:

```ts
function client() {
  const cfg = loadCfg(); // ~/.socheli/config.json or {}
  return createSocheli({
    baseUrl: process.env.SOCHELI_API_URL || cfg.apiUrl,
    apiKey:  process.env.SOCHELI_API_KEY || cfg.apiKey,
  });
}
```

| Source | Key | Base URL | Precedence |
| --- | --- | --- | --- |
| Environment | `SOCHELI_API_KEY` | `SOCHELI_API_URL` | **wins** |
| Config file | `apiKey` in `~/.socheli/config.json` | `apiUrl` in same file | fallback |
| SDK default | — | `https://api.socheli.com` | last resort |

**Persist credentials** with `socheli login` (this is the one command with no network call — it just writes the file):

```bash
socheli login --key sk_live_xxx --url https://api.socheli.com
# ✓ saved → /Users/you/.socheli/config.json

socheli health   # verify
# { "ok": true, "version": "0.1.0", "uptime": 12345 }
```

The file written is plain JSON:

```json
{ "apiUrl": "https://api.socheli.com", "apiKey": "sk_live_xxx" }
```

**One-off / CI usage** with env vars (no `login`, env overrides any saved config):

```bash
SOCHELI_API_KEY=sk_live_xxx SOCHELI_API_URL=https://api.socheli.com \
  socheli publish concept_2026_xyz --public
```

Auth failures print to stderr with the HTTP status and exit code `1`:

```
✗ 401: unauthorized
```

### MCP (`@socheli/mcp`)

The MCP server has **no auth code of its own** — it constructs one SDK client at startup and passes the two env vars straight through. The MCP client (Claude Desktop / Claude Code) supplies them in the server's `env` block:

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

From there it is identical to the SDK: every tool call (`socheli_generate`, `socheli_list_items`, …) becomes a Bearer-authenticated `/v1` request.

> **Auth errors are soft in MCP.** Because the server delegates to the SDK, a `401` is thrown as a `SocheliError` and caught by the tool handler — it is returned to the model as a tool *result* with `isError: true` (text `error: GET /items → 401`), **not** as a JSON-RPC protocol error. There is no startup failure for a missing key; the first tool call simply comes back unauthorized.

### Surface summary

| Surface | Where the key goes | Wire form | Env fallback |
| --- | --- | --- | --- |
| HTTP | `Authorization` header you set | `Bearer <key>` | — |
| SDK | `createSocheli({ apiKey })` | `Bearer <key>` (auto) | `SOCHELI_API_KEY` |
| CLI | `socheli login` → `~/.socheli/config.json`, or env | `Bearer <key>` (via SDK) | `SOCHELI_API_KEY` (overrides config) |
| MCP | `env.SOCHELI_API_KEY` in `.mcp.json` | `Bearer <key>` (via SDK) | `SOCHELI_API_KEY` |

The `SOCHELI_API_URL` env var (and CLI `--url` / SDK `baseUrl`) configures the API base independently of the key — useful for pointing at a local server (e.g. `http://localhost:8787`). Any trailing slash is stripped, and the `/v1` prefix is always added by the client, so set this to the **host root** without `/v1`.

## Failure modes

| Situation | Where | Result |
| --- | --- | --- |
| No `Authorization` header | server | `401 {"error":"unauthorized"}` |
| Wrong key | server | `401 {"error":"unauthorized"}` |
| Server has no `SOCHELI_API_KEY` configured | server | `503 {"error":"API not configured (no SOCHELI_API_KEY)"}` on every `/v1/*` except health |
| Client can't resolve a key | SDK / CLI / MCP | **No local error.** The `Authorization` header is silently omitted and the request reaches the server unauthenticated → `401` |

> **The clients fail late, not fast.** `createSocheli` does **not** throw when no key resolves — it just omits the header. Likewise the CLI and MCP server start fine without a key. You only discover the problem when the first authenticated call returns `401`. If you need a fail-fast guard, check for the key yourself before constructing the client.

The `503` vs `401` distinction is worth internalizing: `401` means *your* key is wrong; `503 (no SOCHELI_API_KEY)` means the *server* has no key configured and is effectively unusable until an operator sets one.

## Rotation

The API key is a single static secret. There is **no built-in rotation endpoint, key list, or expiry** — rotation is an operational procedure:

1. **Set the new key on the server.** Update `SOCHELI_API_KEY` in `/opt/socheli/.env` and restart the API process. The middleware re-reads `process.env.SOCHELI_API_KEY` at boot only (`const API_KEY = process.env.SOCHELI_API_KEY || ""`), so the new value takes effect on restart. During the restart window, requests with the old key get `401`.
2. **Update every client.** Roll the new key into:
   - Server/host env where the API runs (`/opt/socheli/.env`).
   - Any CI/deploy env exporting `SOCHELI_API_KEY`.
   - CLI users: re-run `socheli login --key <new> --url https://api.socheli.com` (overwrites `~/.socheli/config.json`), or update the `SOCHELI_API_KEY` env they use.
   - MCP clients: update `env.SOCHELI_API_KEY` in each `.mcp.json` and restart the MCP server.
3. **Verify** with an unauthenticated-tolerant probe and then an authenticated one:
   ```bash
   curl -s https://api.socheli.com/v1/health                       # always works
   curl -s https://api.socheli.com/v1/fleet \
     -H "Authorization: Bearer $SOCHELI_API_KEY" | head            # 401 ⇒ key not rolled
   ```

Because the comparison is strict equality against a single value, there is **no overlap window** where both old and new keys are valid. Plan rotation as a brief coordinated cutover.

## Security notes

- **The key is a full-access bearer token.** Anyone holding it can generate, publish, and inspect content. Treat it like a root credential, not a public API token.
- **Never embed the key in browser-facing code.** The API enables CORS with a fully open policy (`Access-Control-Allow-Origin: *`, no allowlist). Combined with a static Bearer key, putting the key in any client-side JavaScript exposes it to every origin. Keep it server-side. The SDK supports browser/edge runtimes for *trusted* server contexts (workers, edge functions) — not for shipping to end-user browsers.
- **Prefer env vars over the CLI config file for shared/CI machines.** `~/.socheli/config.json` stores the key in plaintext. On multi-user or ephemeral hosts, pass `SOCHELI_API_KEY` via the environment (it overrides the file) and avoid writing it to disk.
- **Health is intentionally open.** `GET /v1/health` leaks only `{ ok, version, uptime }` and is the only unauthenticated route. Use it for liveness probes without provisioning a key.
- **The MQTT broker and dashboard use separate credentials.** Compromise of the API key does not expose the broker (`SOCHELI_MQTT_USER`/`SOCHELI_MQTT_PASS`) or dashboard (Clerk). Conversely, securing those does not protect the API — rotate this key on its own schedule.
- **Auth failures are not always loud.** A missing client key produces a silent unauthenticated request (→ `401`), and in MCP a `401` is surfaced as tool text rather than an error. Monitor for `401` responses and `isError` tool results to catch a stale or unset key.

## Relevant source

| File | Role |
| --- | --- |
| `packages/api/src/server.ts` | The `/v1/*` Bearer middleware, the `503`/`401` responses, and the health exemption |
| `packages/sdk/src/index.ts` | `createSocheli` key resolution (`apiKey ?? SOCHELI_API_KEY`) and the `Authorization: Bearer` header |
| `packages/cli/src/index.ts` | Env-first credential resolution, `socheli login`, and `~/.socheli/config.json` |
| `packages/mcp/src/index.ts` | MCP server passing `SOCHELI_API_KEY` / `SOCHELI_API_URL` through to the SDK |
