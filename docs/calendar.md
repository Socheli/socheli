# Content Calendar & Plan

The calendar is the dated content plan: brand- and platform-aware posts the
algorithm-hacking planner produces, reviewed and curated on the `/calendar` page,
then promoted to a real run. Every post lives in `data/content-plan.json` as a
`PlannedPost`.

This page documents the **`plan_*` tools** — one canonical CRUD that every surface
(MCP, SDK, CLI, HTTP) shares, so an agent can read and curate the calendar the same
way the dashboard's day dialog does (open a day → open an event → edit / move /
archive / delete).

## The `PlannedPost`

```ts
type PlannedPost = {
  id: string;
  date: string;        // YYYY-MM-DD
  time: string;        // HH:MM
  channel: string;     // brand / channel id
  platform: "youtube" | "instagram" | "tiktok" | "x" | "linkedin" | "telegram";
  topic: string;
  angle: string;
  format: string;      // short | explainer | …
  mood?: string;
  hook?: string;
  rationale: string;
  algoLever?: string;  // which algorithm lever this idea exploits
  scores?: Record<string, number>;
  overall?: number;
  status: "idea" | "approved" | "scheduled" | "generated" | "dropped" | "archived";
  planRunId: string;
  createdAt: string;
  updatedAt?: string;
};
```

## Tools

| Tool | Kind | Description |
|---|---|---|
| `plan_list` | read | List planned posts (newest plan-run first). Args: `channel?`, `status?`, `includeArchived?` (default false). |
| `plan_get` | read | One full post by `id`. |
| `plan_day` | read | Every post for one date, sorted by time — the day-view data. Args: `date`, `includeArchived?`. |
| `plan_create` | mutate | Hand-add a post. Args: `channel`, `date`, `time?`, `platform`, `topic`, `angle?`, `format?`, `mood?`, `hook?`, `rationale?`, `algoLever?`, `status?`. |
| `plan_update` | mutate | Edit fields on a post. Args: `id`, `patch` (any of date/time/status/platform/mood/topic/angle/format/hook/rationale/algoLever). |
| `plan_move` | mutate | Reschedule a post (drag-and-drop equivalent). Args: `id`, `date`, `time?`. |
| `plan_archive` | mutate | Soft-hide a post (status → `archived`; reversible). Args: `id`. |
| `plan_delete` | mutate | Permanently delete a post. Args: `id`. |
| `plan_strategy` | read | The saved strategy brief for a channel (channel brief + subject playbook + per-cluster cadence). Args: `channel`. |
| `plan_run` | long | Run the algo planner for a channel and append a dated plan. Args: `channel`, `days?` (default 14), `platforms?`, `time?`. Returns a started job. |

All mutations return the affected post; `archive` is reversible (`plan_update` the
status back to `idea`), `delete` is not.

## By surface

### CLI (engine, in-process)

```bash
pnpm content tool plan_list '{"channel":"claude_code_lab"}'
pnpm content tool plan_day  '{"date":"2026-06-20"}'
pnpm content tool plan_update '{"id":"plan_…","patch":{"status":"approved","hook":"Stop doing X"}}'
pnpm content tool plan_move '{"id":"plan_…","date":"2026-06-25","time":"14:30"}'
pnpm content tool plan_archive '{"id":"plan_…"}'
pnpm content algo-plan --channel claude_code_lab --days 14   # the planner behind plan_run
```

### HTTP (REST API)

Every registry tool — including the whole `plan_*` set — is callable on the public
API at `POST /v1/tools/<name>` (Bearer auth), with the args as the JSON body. `GET
/v1/tools` lists the manifest.

```bash
curl -s -X POST https://api.socheli.com/v1/tools/plan_day \
  -H "Authorization: Bearer $SOCHELI_API_KEY" -H "Content-Type: application/json" \
  -d '{"date":"2026-06-20"}'
```

The dashboard also bridges the same registry at `POST /api/tools/<name>`, and the
calendar UI uses a thin REST route, `/api/plan`:

- `GET /api/plan` → the full plan; `?channel=` filter; `?id=` one full post; `?date=YYYY-MM-DD` a day.
- `PATCH /api/plan` `{ id, ...patch }` → edit / move / archive (`{ status:"archived" }`).
- `DELETE /api/plan?id=` → delete.

### SDK

The public client has a typed `plan` namespace (plus generic `tool()` / `tools()`):

```ts
import { createSocheli } from "@socheli/sdk";
const socheli = createSocheli({ apiKey: process.env.SOCHELI_API_KEY });

const posts = await socheli.plan.day("2026-06-20");
await socheli.plan.update(id, { status: "approved", hook: "Stop doing X" });
await socheli.plan.move(id, "2026-06-25", "14:30");
await socheli.plan.archive(id);

// or call any registry tool generically:
const { data } = await socheli.tool("plan_list", { channel: "claude_code_lab" });
```

In-process (on a device, inside the engine) the same registry is reachable via
`callTool` from `@os/engine` tools.

### MCP

Discrete plan tools are exposed over MCP — `socheli_plan_list`, `socheli_plan_day`,
`socheli_plan_update`, `socheli_plan_move`, `socheli_plan_archive`,
`socheli_plan_delete`, `socheli_plan_run` — plus a generic `socheli_call_tool` /
`socheli_list_tools` passthrough for the rest of the registry. So an agent can say
*"archive the low-scoring posts on the 20th"* and the client calls `socheli_plan_day`
then `socheli_plan_archive`. See [MCP](mcp.md).

## The day dialog

On `/calendar`, clicking a day (or a single event chip) opens a comprehensive
master-detail dialog: the left rail lists every event on the day grouped by kind;
clicking one opens it on the right with its full fields and inline **Edit / Move /
Archive / Delete** for planned posts (real runs link out to their own page). These
controls call exactly the `plan_*` tools documented above.
