# Handoff: wire `@cognitivx/sdk` into Socheli

`@cognitivx/sdk@0.1.0` is live on npm — a zero-dep, isomorphic, typed client for
`api.cognitivx.io`. This replaces Socheli's hand-rolled fetch against iCog with a
typed surface, and gives the engine/harness a real memory API. This doc is the
integration plan; **no Socheli code has been changed yet.**

Published surface (verified against source):
- `memory` — `recall`, `remember`, `forget`, `update`, `learn`, `talk`, `reflect`
- `memories` — `list`, `get`, `search`, `remove`, `counts`
- `auth`, `keys`, `billing`, `usage`, `profile` (account management)
- `apiClient` (raw get/post/…), `ApiError`, `configureApiClient(opts)`

---

## Step 0 — VERIFY FIRST: the auth-header mismatch (most likely break)

Socheli today sends the `icog_…` key as **`X-API-Key`** (`lib/agent/icog.ts:63`).
The SDK's `configureApiClient({ apiKey })` stores it as the access token and sends
it as **`Authorization: Bearer <key>`** (`client.ts` request() sets
`authorization: Bearer …`). These are different headers.

**Before migrating anything**, confirm `api.cognitivx.io` accepts an `icog_…` key
via Bearer:

```sh
curl -s -X POST https://api.cognitivx.io/api/recall \
  -H "authorization: Bearer $ICOG_API_KEY" \
  -H "content-type: application/json" \
  -d '{"query":"smoke","limit":1}' | head -c 400
```

- **200 → ** the SDK works as-is; proceed.
- **401/403 → ** the backend only reads `X-API-Key` for these keys. Two options:
  (a) make the backend accept Bearer api keys (preferred — it's the SDK's model),
  or (b) until then, configure the SDK with a custom `fetchImpl` that injects the
  `X-API-Key` header, e.g.
  ```ts
  configureApiClient({
    fetchImpl: (url, init) => {
      const h = new Headers(init?.headers);
      h.set("x-api-key", process.env.ICOG_API_KEY!);
      return fetch(url, { ...init, headers: h });
    },
  });
  ```

---

## Step 1 — install (mind the registry)

`@cognitivx/*` lives on **npmjs.org**, but this machine's default registry is the
`npmmirror` proxy. Scope it (same pattern your `~/.npmrc` already uses for
`@moltjobs`) so installs resolve and don't try the mirror:

```
# .npmrc (repo root or ~/.npmrc)
@cognitivx:registry=https://registry.npmjs.org/
```

Then add it where it's used — the engine (genome mirror) and the dashboard (copilot):

```sh
pnpm --filter @os/engine add @cognitivx/sdk
pnpm --filter dashboard add @cognitivx/sdk
```

---

## Step 2 — one server-side init (do it once, at startup)

The SDK holds config in a **module-global** (`configureApiClient` mutates a shared
object). That's correct for Socheli's single-owner server use, but it means you
cannot safely set a *different* key per concurrent request. Initialize once:

```ts
// e.g. packages/engine/src/icog.ts  (new) and the dashboard server entry
import { configureApiClient } from "@cognitivx/sdk";

export function initIcog() {
  const apiKey = process.env.ICOG_API_KEY;
  if (!apiKey) return false;            // degrade: keep tools/mirror disabled
  configureApiClient({
    apiKey,
    baseUrl: process.env.ICOG_API_URL || "https://api.cognitivx.io",
  });
  return true;
}
```

> Multi-tenant note: if Socheli ever needs per-workspace iCog keys, don't use the
> global — construct a request-scoped `fetchImpl` (as in Step 0b) per call, or ask
> CognitiveX for a non-global client factory. Single-owner today: global is fine.

---

## Step 3 — replace the three hand-rolled surfaces

### 3a. `apps/dashboard/lib/agent/icog.ts` (the 4 Soli memory tools)
Keep the tool **specs** (descriptions, gating, `ICOG_TOOLS` withholding) exactly
as they are — only swap the fetch bodies:

| current handler | replace `icogFetch(...)` with |
|---|---|
| `memory_recall` | `memory.recall({ query, limit, memory_type, agent_slug: "socheli-soli" })` |
| `memory_remember` | `memory.remember({ content, memory_type, agent_slug: "socheli-soli" })` |
| `icog_talk` | `memory.talk({ message, current_task, agent_slug: "socheli-soli" })` |
| `icog_reflect` | `memory.reflect()` |

Map `ApiError` → the existing `{ ok:false, error }` shape. The `isIcogConfigured()`
check becomes "did `initIcog()` return true".

### 3b. Engine genome mirror — `packages/engine/src/dna.ts` `mirrorToIcog()`
Swap its raw fetch for:
```ts
import { memory } from "@cognitivx/sdk";
await memory.remember({
  content: `[genome:${channel}] ${mutation}`,
  memory_type: "semantic",          // or "fact" — match what the backend accepts
  agent_slug: "socheli-soli",
});
```
Keep it fire-and-forget with the existing timeout/try-catch so an evolve run never
fails on a mirror hiccup.

### 3c. (optional) retire the bespoke client
Once 3a/3b use the SDK, the `icogFetch`/`baseUrl`/`apiKey` helpers in
`lib/agent/icog.ts` can be deleted. The `ICOG_API_URL`/`ICOG_API_KEY` env stays.

---

## Step 4 — the deeper play (the reason this mattered): harness + missions memory

This is what turns iCog from "Soli's notepad" into the cognitive substrate behind
the Brand Genome and missions (see `docs/AGENT-HARNESS.md`).

1. **Engine memory tools** — add `packages/engine/src/tools/icog-tools.ts`
   (`memory_recall`, `memory_remember`, `memory_learn`, `memory_reflect`) in the
   registry's tool shape (copy `tools/helpers.ts`), backed by the SDK. They then
   appear on CLI/API/MCP/SDK/copilot for free.
2. **Role allowlists** (`harness/roles.ts`) — give `researcher`/`analyst`/
   `strategist` the memory tools so deep agent tasks accumulate context across
   sessions.
3. **Genome evolution** (`dna.ts evolveGenome`) — add a `memory.recall(channel)`
   evidence pass and emit `memory.learn(outcome)` from analytics ingestion, so the
   thin `learnings.json` loop is backed by iCog's Bayesian confidence + dream
   consolidation instead of a 12-item cap.
4. **Research** (`research/orchestrator.ts`) — `memory.remember` verified claims so
   the fact graph accrues knowledge across runs.

---

## Gotchas / facts to carry

- **`remember`/`update` require the `awakened` tier or above** (per the SDK
  docstrings). `recall`/`talk`/`reflect` are lower-tier. Confirm the Socheli key's
  tier or `remember` calls will 403.
- **`agent_slug`** — keep using `socheli-soli` (matches the existing memory
  `[[soli-icog-memory]]`); it scopes recall to Socheli's own context.
- **`memory_type` taxonomy** is the backend's: `semantic | episodic | procedural |
  foundational | error | pattern | insight | reflective | meta | emergent`. The
  genome mirror previously used `"fact"` — verify that's accepted or switch to
  `"semantic"`.
- **`reflect()`** returns `consciousness_level` + `narrative` — nice for a "memory
  health" widget on a channel/agent detail page if you want a visible signal.
- **`memories.list/search/counts`** (the other namespace) is ideal for a dashboard
  "what has Soli learned" browser, separate from the live agent loop.

## Smoke test when done
```sh
pnpm typecheck
pnpm content tool memory_recall '{"query":"test","limit":1}'   # if Step 4 tools added
```
