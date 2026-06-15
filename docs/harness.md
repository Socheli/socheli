# Agent Harness

Socheli is built to sit on **both sides** of an agent harness:

1. **Inbound — drive Socheli from any harness.** Claude Code, Codex, Claude Desktop, or any MCP/HTTP-capable agent can operate the full content engine: every one of the registry's 130+ tools (`draft_*`, `plan_*`, `dna_*`, `research_*`, `mission_*`, `editor_*`, `publish_*`, …) is exposed over MCP stdio, REST, the SDK, and the CLI.
2. **Outbound — Socheli drives harnesses as worker brains.** The engine's `HarnessRuntime` layer (`packages/engine/src/harness/`) spawns multi-turn, tool-using agents on the Claude Agent SDK, headless Claude Code, the Codex CLI, or a plain OpenRouter tool loop — each one scoped to a role's tool allowlist and budget. This is what powers `agent_run_task` and the missions orchestrator.

The full design contract lives in the [Agent Harness spec](/docs/agent-harness) (`docs/AGENT-HARNESS.md`). This page is the operator's guide.

```
any agent harness ──MCP / HTTP / CLI──►  Socheli tool registry  ──agent_run_task──►  harness runtimes
(Claude Code, Codex, …)                  (one canonical surface)                     (claude-sdk · claude-code · codex · openrouter)
```

---

## Part 1 — Drive Socheli from any harness

### Pick an entry point

| Entry point | Scope | Where it runs | Auth |
|---|---|---|---|
| **Full-registry MCP** (`packages/engine/src/harness/mcp-stdio.ts`) | Every registry tool (~133) | Locally, next to the repo | none (local stdio) |
| **Framed MCP twin** (`packages/engine/src/socheli-mcp.ts`) | Same registry | Locally | none (local stdio) |
| **Remote MCP** ([`@socheli/mcp`](/docs/mcp)) | 15 curated tools, incl. a generic registry passthrough | Anywhere — speaks to `api.socheli.com` | `SOCHELI_API_KEY` |
| **HTTP API** ([`/v1/tools`](/docs/api)) | Every registry tool | Anywhere | Bearer API key |
| **CLI** ([`socheli`](/docs/cli) / `pnpm content`) | Curated commands + tool passthrough | Anywhere / locally | API key / none |

### MCP stdio — the full local registry

The engine ships **two** stdio MCP servers over the *same* canonical registry (`packages/engine/src/tools/registry.ts`). They differ only in wire framing, and picking the right one matters:

| Server | Framing | Use when |
|---|---|---|
| `packages/engine/src/harness/mcp-stdio.ts` | **One JSON-RPC envelope per line** | Claude Code (`.mcp.json` / `--mcp-config`), Codex, and other current MCP stdio clients. This is the one you almost always want. |
| `packages/engine/src/socheli-mcp.ts` (`pnpm mcp:socheli`) | **`Content-Length`-framed** (LSP-style) | Clients that speak the framed stdio dialect (mirrors the repo's internal `editor-mcp` wire pattern). |

> **Why two?** The current MCP stdio transport — what Claude Code's MCP client actually speaks — is newline-delimited JSON-RPC. Pointed at the `Content-Length`-framed server, Claude Code reports the server "still connecting" forever (verified empirically). The line-delimited twin connects instantly. Same registry, same tool names, same dispatch — only the framing differs.

Both servers implement the minimal MCP surface (`initialize`, `notifications/initialized`, `ping`, `tools/list`, `tools/call`) and serve the **entire** registry — pipeline, editor, plan/calendar, dna, research, mission, agent, publish, analytics. Nothing is filtered out by default.

#### Claude Code (`.mcp.json`)

Add to your project's `.mcp.json` (or user-level MCP config):

```json
{
  "mcpServers": {
    "socheli": {
      "command": "node",
      "args": ["--import", "tsx", "/path/to/socheli/packages/engine/src/harness/mcp-stdio.ts"]
    }
  }
}
```

Tools arrive namespaced as `mcp__socheli__<tool>` (e.g. `mcp__socheli__draft_create`, `mcp__socheli__agent_run_task`).

**Trim the toolset for small models.** The full registry is ~133 tools; large toolsets get deferred behind tool-search in some clients, where smaller models reliably fail to invoke the resolved tool. Set `SOCHELI_MCP_TOOLS` to a comma-separated allowlist and the server only *advertises* (and accepts calls for) those names:

```json
{
  "mcpServers": {
    "socheli": {
      "command": "node",
      "args": ["--import", "tsx", "/path/to/socheli/packages/engine/src/harness/mcp-stdio.ts"],
      "env": { "SOCHELI_MCP_TOOLS": "draft_create,draft_get,draft_generate_step,plan_list,plan_day,agent_run_task,agent_task_events" }
    }
  }
}
```

(This is exactly how Socheli's own `claude-code` runtime scopes a worker to its role — see Part 2.)

#### Codex CLI (`~/.codex/config.toml`)

```toml
[mcp_servers.socheli]
command = "node"
args = ["--import", "tsx", "/path/to/socheli/packages/engine/src/harness/mcp-stdio.ts"]
```

#### Any other harness

If your harness speaks newline-delimited MCP stdio, launch `node --import tsx <repo>/packages/engine/src/harness/mcp-stdio.ts` and you get the full registry; if it speaks `Content-Length` framing, launch `packages/engine/src/socheli-mcp.ts` instead. Tool results come back as a single JSON text block (`{ ok, data?, message? }`); errors set `isError: true` so the model can read and recover rather than aborting the turn.

For **hosted** instances, use the published [`@socheli/mcp`](/docs/mcp) package instead — it wraps the REST API and needs only `SOCHELI_API_KEY` (and optionally `SOCHELI_API_URL`). Its generic `socheli_call_tool` passthrough still reaches every registry tool remotely.

### HTTP API

Everything the MCP servers expose is also one REST call away — the same key flow as the rest of the [API](/docs/api): a single Bearer key, `GET /v1/tools` for the manifest, `POST /v1/tools/:name` to run one.

```bash
# what can I call?
curl -s https://api.socheli.com/v1/tools \
  -H "Authorization: Bearer $SOCHELI_API_KEY" | jq '.[].name'

# run a verified research run
curl -s -X POST https://api.socheli.com/v1/tools/research_run \
  -H "Authorization: Bearer $SOCHELI_API_KEY" -H "Content-Type: application/json" \
  -d '{"query":"what is working on TikTok for dev-tool brands","kind":"algo","depth":"standard"}'

# delegate deep work to Socheli's OWN harness (Part 2) from the outside
curl -s -X POST https://api.socheli.com/v1/tools/agent_run_task \
  -H "Authorization: Bearer $SOCHELI_API_KEY" -H "Content-Type: application/json" \
  -d '{"role":"analyst","goal":"audit last week of IG performance and record learnings"}'
```

That last call is the loop closing: an external harness driving Socheli, which spins up its *own* internal harness worker for the heavy lifting.

### CLI

The published [`socheli` CLI](/docs/cli) covers the remote surface. Locally, the engine CLI (`pnpm content …`) exposes the harness-era commands directly:

```bash
pnpm content dna <channel>                      # genome summary
pnpm content dna evolve <channel>               # propose/apply genome mutations
pnpm content research "<query>" --kind algo --depth deep
pnpm content mission create --channel concept_lab --goal "grow IG to 10k"
pnpm content mission tick                       # advance due mission loops
pnpm content agent-task --role researcher "audit our IG hook performance"
```

---

## Part 2 — Socheli driving harnesses as worker brains

Where `brain.ts` is the one-shot JSON brain, the `harness/` layer is the **multi-turn, tool-using agent runtime**. A runtime takes an `AgentTask` — role + goal + injected context + a registry-tool allowlist — and streams `AgentEvent`s (`token`, `tool_call`, `tool_result`, `step`, `done`, `error`) while the underlying agent works the goal with real Socheli tools.

### The four runtimes

All four implement one `HarnessRuntime` interface (`harness/types.ts`); the router picks whichever is available per tier.

| Runtime | Drives | Available when | Auth & cost | Registry tools | Budget (`budgetUsd`) enforcement |
|---|---|---|---|---|---|
| `claude-sdk` *(premium default)* | `@anthropic-ai/claude-agent-sdk` `query()` with an **in-process** MCP server wrapping the role's tools | SDK package installed **and** (`ANTHROPIC_API_KEY` *or* the Claude Code CLI is present — subscription auth) | API key or Claude subscription; cost read from the result | Yes — in-process, same `callTool` dispatch as every other surface | Delegated — forwarded to the SDK as `maxBudgetUsd` |
| `claude-code` | Headless `claude -p … --output-format stream-json`, with a generated `--mcp-config` pointing at `harness/mcp-stdio.ts` and `--allowedTools` from the role preset | Claude Code CLI found (`CLAUDE_BIN` or well-known install paths) | Claude subscription — **zero keys needed**; cost from the final `total_cost_usd` | Yes — over stdio MCP, advertised tools restricted via `SOCHELI_MCP_TOOLS`; built-in Bash/Edit/Write/Web tools are disallowed so the worker stays on the registry | **Post-hoc** — total cost is only known at the final result event; a breach is logged loudly for missions' per-day accounting |
| `codex` | `codex exec --json` | Codex CLI found (`CODEX_BIN` or on `PATH`) | ChatGPT/Codex subscription; cost recorded as $0 | **No** — cannot mount the registry, so it degrades gracefully to a one-shot advisory run: it states exactly which tools/args an operator (or tool-capable agent) should execute | n/a (subscription, $0/call) |
| `openrouter` | A plain-`fetch` OpenAI-compatible tool loop (no LangChain in the engine) | `OPENROUTER_API_KEY` set | OpenRouter credit; per-call cost read from the `usage` block | Yes — manifest schemas sent as function tools, calls dispatched through `callTool`, allowlist re-enforced server-side | **Live** — the only runtime that hard-stops *between steps* the moment spend reaches the budget |

Two model knobs to know:

- **Claude tiers** map `cheap → haiku / smart → sonnet / best → opus` (same scale as `brain.ts`).
- **OpenRouter** uses `HARNESS_OPENROUTER_MODEL` (or `HARNESS_OPENROUTER_MODEL_<TIER>`), falling back to `OPENROUTER_MODEL`, then tool-capable Gemini Flash defaults. The override exists for a sharp reason: the brain's `OPENROUTER_MODEL` is tuned for cheap one-shot JSON and **may not support tool calling at all** (some models have no tool-capable OpenRouter endpoints and the API returns "No endpoints found that support tool use"). The harness loop is useless without tools — give it its own, tool-capable model.

### The router

`harness/router.ts` resolves the runtime per task from two env preference lists — first **available** runtime wins, probed per pick (env keys, binary presence, dynamic-import success), so a missing SDK or unset key degrades to the next entry instead of failing:

```
HARNESS_PREMIUM=claude-sdk,claude-code,openrouter   # used for tier smart/best
HARNESS_DEFAULT=openrouter,claude-code              # used for tier cheap
```

`codex` is deliberately **not** in either default (it can't use tools); list it explicitly to opt in. Any task can also force a runtime via `agent_run_task`'s `runtime` arg or `content agent-task --runtime <id>`.

### Role presets

Every task runs as one of seven roles (`harness/roles.ts`). A preset bundles a real system prompt, a registry-tool **allowlist** (prefix patterns like `research_*`), and a default tier. The allowlist is the security boundary: the runtime only exposes the expanded names to its agent, so a publisher can never mutate DNA and a researcher can never publish.

| Role | Default tier | Allowlist size* | Focus |
|---|---|---|---|
| `researcher` | smart | 17 | Verified research, trends, competitor/algorithm intel |
| `strategist` | smart | 27 | The content plan — what to make, where, when, why |
| `creative` | smart | 30 | Ideas, hooks, scripts, storyboards, full generations |
| `editor` | smart | 44 | Take a render from "good" to ship-ready (scene edits, AV review, rerender) |
| `publisher` | cheap | 14 | Package + ship approved content; hard-stops at the publish gate |
| `analyst` | smart | 22 | Close the learning loop: analytics → learnings → DNA proposals |
| `channel_manager` | best | 100 | The autonomous manager — owns the whole loop, delegates depth via `agent_run_task` |

\* Expanded against the current ~133-tool registry; counts grow automatically as matching tools land (unknown patterns silently drop out, so presets can reference families before they exist).

### Budgets & limits

Three independent guard layers, outermost first:

1. **`maxSteps`** (default 16) — the agent's turn/loop limit, passed to every runtime (`--max-turns`, SDK `maxTurns`, or the loop counter).
2. **Belt-and-braces in `runAgentTask`** (`harness/run.ts`) — aborts any run that exceeds `2 × maxSteps` tool calls, guarding against a runtime that doesn't enforce its own limit or a model stuck in a tool loop.
3. **`budgetUsd`** — a per-task USD stop. Enforcement varies by runtime (see table above): *live between steps* on `openrouter`, *delegated* (`maxBudgetUsd`) on `claude-sdk`, *post-hoc with a loud log entry* on `claude-code`, moot on `codex`. Missions add a fourth layer on top: `budget.usdPerDay` sums each day's task spend and skips further tasks once crossed.

### Running tasks: `agent_run_task` + `agent_task_events`

`agent_run_task` is a **long** registry tool — it spawns the task as a detached engine process and returns immediately; callers poll the event log instead of blocking. It is available on every surface (MCP, HTTP, SDK, CLI, the Soli copilot), which means *any* harness can delegate deep work to Socheli's internal workers.

```jsonc
// tools/call → agent_run_task
{
  "role": "researcher",
  "goal": "What hook styles are outperforming on IG reels for dev-tool brands this month?",
  "tier": "smart",            // optional — override the role's default
  "maxSteps": 16,             // optional
  "budgetUsd": 0.50,          // optional hard stop
  "runtime": "claude-code"    // optional — force a runtime
}
// → { ok, data: { status: "started", taskId: "agent_…", role, eventsPath, logPath } }
```

Poll with `agent_task_events`:

```jsonc
{ "taskId": "agent_20260610…", "tail": 50 }
// → { events: [...], finished: true|false, last: { type: "result", summary, usd, toolCalls, ok } }
```

### Task logs — `data/agent/*.jsonl`

Every task writes an append-only JSONL event stream to `data/agent/<taskId>.jsonl` — one timestamped event per line, readable by the dashboard job feed and `tail -f` alike:

```
{"at":"…","type":"task","id":"agent_…","role":"researcher","tier":"smart","runtime":"claude-code","goal":"…","maxSteps":16,"budgetUsd":null,…}
{"at":"…","type":"step","label":"claude-code · claude-sonnet-4-6 · 17 tools · ≤16 turns"}
{"at":"…","type":"tool_call","id":"…","name":"research_fresh","args":{…}}
{"at":"…","type":"tool_result","id":"…","name":"research_fresh","ok":true,"result":…}
{"at":"…","type":"token","text":"…"}
{"at":"…","type":"done","summary":"…","usd":0.0312}
{"at":"…","type":"result","summary":"…","usd":0.0312,"toolCalls":4,"ok":true}
```

The first line is always the `task` descriptor and the last is the `result` verdict — `agent_task_events` reports `finished: true` once the `result` line lands. A human-readable stdout mirror sits alongside at `data/agent/<taskId>.log`.

### Missions

The missions orchestrator (`packages/engine/src/missions.ts`) is the standing consumer of all of the above: each scheduler tick advances at most one due loop task (research / plan / generate / analyze / evolve) per mission by calling `runAgentTask` with the right role, within `budget.usdPerDay`. Publishes and DNA mutations stay behind their approval gates. See the [spec](/docs/agent-harness) §4 and `content mission --help`.

---

## Environment reference

| Variable | Default | Purpose |
|---|---|---|
| `HARNESS_PREMIUM` | `claude-sdk,claude-code,openrouter` | Runtime preference for tier `smart`/`best` (first available wins) |
| `HARNESS_DEFAULT` | `openrouter,claude-code` | Runtime preference for tier `cheap` |
| `ANTHROPIC_API_KEY` | — | Optional; `claude-sdk` falls back to Claude Code CLI (subscription) auth |
| `CLAUDE_BIN` | auto-resolved | Explicit Claude Code CLI path (else well-known install locations, then `PATH`) |
| `CODEX_BIN` | auto-resolved | Explicit Codex CLI path (else `PATH`) |
| `OPENROUTER_API_KEY` | — | Enables the `openrouter` runtime |
| `HARNESS_OPENROUTER_MODEL[_CHEAP\|_SMART\|_BEST]` | tool-capable Gemini Flash | **Tool-capable** model for the harness loop; overrides `OPENROUTER_MODEL` (which may be a no-tools model picked for the one-shot brain) |
| `SOCHELI_MCP_TOOLS` | unset (all tools) | Comma allowlist restricting what `harness/mcp-stdio.ts` advertises/accepts |
| `RESEARCH_MAX_USD` | unset (unlimited) | Per-run research budget; when crossed mid-run the orchestrator synthesizes with what it has |
| `ICOG_API_KEY` | — | Optional: mirror applied genome mutations to external memory |

All of these are documented in `.env.example` with the same defaults.

## See also

- [Agent Harness spec](/docs/agent-harness) — the full design contract (genome, research, runtimes, missions)
- [MCP Server](/docs/mcp) — the published remote MCP package
- [API Reference](/docs/api) — the `/v1/tools` bridge and key flow
- [CLI](/docs/cli) — the `socheli` command-line
