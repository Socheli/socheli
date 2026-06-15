# Deployment

This page documents Socheli's **hosted topology** — the production split between a fleet of
render devices and a single always-on control-plane + media host — and exactly how code,
configuration, and finished videos move between them.

Socheli is deliberately structured around one defining decision: **renders run on capable
devices; a small server only dispatches work, observes the fleet, and serves the resulting
mp4s.** There is no database — all state lives in flat `data/*.json` files, control travels
over MQTT, and heavy artifacts travel by `rsync` and are served over HTTPS.

- **Render fleet** — one or more render devices (and any other capable device). Each runs the
  *entire* engine pipeline locally (research → script → storyboard → QA → voice → captions →
  music → b-roll → package → publish) and ships the mp4 back.
- **Control plane (your VPS, your-server.example.com)** — the Next.js dashboard, the `@socheli/api`
  Hono server, the fleet bridge, the Mosquitto broker, and the Caddy reverse proxy. It also
  doubles as the **public media host** (`media.socheli.com`), serving rendered mp4s for
  IG/TikTok ingestion.
- **launchd scheduler** — runs on the Mac(s), firing the autopilot/posting timer every 60 s.

---

## Hosted topology

```text
                          RENDER FLEET (a render device, + any others)
            ┌───────────────────────────────────────────────────────────────┐
            │  content agent  (packages/engine/src/agent.ts)                 │
            │    • probes caps (render/voice/music/broll) + hardware profile │
            │    • runs the FULL engine pipeline locally                     │
            │    • renders mp4 with Remotion + ffmpeg                        │
            │  content tick   (launchd, every 60s) → autopilot/posting timer │
            └──────┬──────────────────────────────────────────────┬─────────┘
                   │  CONTROL  (tiny JSON)                         │  DATA  (heavy mp4 + data/)
                   │  MQTT over TLS                                │  rsync -az over SSH
                   │  wss://mqtt.socheli.com                       │  scripts/sync-to-server.sh
                   ▼                                               ▼
   ════════════════════════════════ PRODUCTION HOST  your-server.example.com ════════════════════════════════
        ┌──────────────────────────────────────────────────────────────────────────┐
        │  Caddy (reverse proxy + automatic HTTPS)                                  │
        │   app.socheli.com   → :4040   media.socheli.com → file_server /data/renders│
        │   api.socheli.com   → :8787   mqtt.socheli.com   → :9001 (ws)              │
        ├──────────────┬──────────────┬──────────────┬───────────────┬─────────────┤
        │  Dashboard   │  @socheli/api│  fleet bridge │  Mosquitto    │  media host │
        │  Next.js     │  Hono (Hono) │  content      │  broker       │  Caddy      │
        │  :4040       │  :8787       │  bridge       │  :1883 tcp    │  file_server│
        │  Clerk auth  │  Bearer key  │  MQTT→json    │  :9001 ws     │  data/renders│
        │  Polar bill. │  /v1/*       │  fleet/jobs   │               │  /<id>.mp4  │
        └──────┬───────┴──────┬───────┴───────┬───────┴───────┬───────┴─────────────┘
               │ reads/writes │ dispatch+read │ writes        │ dispatch
               ▼              ▼               ▼               ▼
        ┌───────────────────────────────────────────────────────────────────┐
        │  file store  /opt/socheli/data/  (no database)                     │
        │    runs/<id>.json   jobs.json   fleet.json   schedule.json         │
        │    renders/<id>.mp4  ← served publicly by Caddy                    │
        └───────────────────────────────────────────────────────────────────┘
```

**The server never renders, and video never crosses the message bus.** Job dispatch, device
presence, and render progress flow over MQTT; the finished mp4 (and the rest of `data/`)
flows by `rsync` and is published over HTTPS by Caddy.

---

## Services

The control plane is a set of long-running services on the production host, plus two engine
processes on each render device.

| Service | What it runs | Host | Port | Started by |
| --- | --- | --- | --- | --- |
| **Dashboard** | `next start --port 4040` (Next.js 15.5, Clerk auth, Polar billing) | the server | `4040` | `socheli-dashboard.service` (systemd) |
| **API** | `@socheli/api` Hono server (`packages/api/src/server.ts`) | the server | `8787` (`SOCHELI_API_PORT`) | `socheli-api.service` (systemd) |
| **Fleet bridge** | `content bridge` — MQTT → `data/fleet.json` + `data/jobs.json` | the server | — (MQTT client) | `socheli-bridge.service` (systemd) |
| **Broker** | Mosquitto MQTT broker | the server | `1883` tcp (localhost) + `9001` ws | `mosquitto.service` (systemd) |
| **Web/TLS** | Caddy reverse proxy + automatic HTTPS + media file server | the server | `80`/`443` | `caddy.service` (systemd) |
| **Media host** | Caddy `file_server` over `/opt/socheli/data/renders` | the server | (via Caddy `443`) | `caddy.service` |
| **Render agent** | `content agent` — MQTT worker, runs the full pipeline | render device(s) | — (MQTT client) | manual / `caffeinate -is` / launchd |
| **Scheduler** | `content tick` — autopilot/posting timer, every 60 s | render device(s) | — | `com.socheli.scheduler` (launchd) |

> The **agent** is the MQTT render worker; the **scheduler** is the autopilot/posting timer.
> They are different processes with different jobs — don't conflate them.

---

## Per-service detail

### Dashboard (`apps/dashboard`)

Next.js 15.5 app, run as `next start --port 4040` (`apps/dashboard/package.json` → `start`).
Fronted by Caddy at `https://app.socheli.com`. Auth is **Clerk** (`@clerk/nextjs` v7;
`clerkMiddleware` in `apps/dashboard/middleware.ts`, `<ClerkProvider>` in
`apps/dashboard/app/layout.tsx`). Billing is **Polar** (no Stripe), via `apps/dashboard/lib/billing.ts`.

The dashboard's own API routes proxy to the Socheli API rather than reimplementing the
control plane:

- `POST /api/generate` (`apps/dashboard/app/api/generate/route.ts`) — when `SOCHELI_API_KEY`
  is set (`fleetEnabled()`), it forwards to `${SOCHELI_API_URL}/v1/generate` with the Bearer
  key. On a local dev box with no fleet it falls back to spawning the engine CLI in-process.
- `GET /api/jobs` (`apps/dashboard/app/api/jobs/route.ts`) — reads from the API and the broker
  (`SOCHELI_BROKER_URL`, `SOCHELI_MQTT_USER`/`PASS`).
- `POST /api/agent` (`apps/dashboard/app/api/agent/route.ts`) — the in-app Copilot, streaming
  via OpenRouter (`apps/dashboard/lib/agent/openrouter.ts`).

### API (`@socheli/api`)

The Hono control-plane backbone (`packages/api/src/server.ts`). Listens on
`SOCHELI_API_PORT` (default `8787`), fronted by Caddy at `https://api.socheli.com`. Every
route is under `/v1`; CORS is wide open (`app.use("*", cors())`). A single middleware enforces
a **static Bearer key** with strict equality — `/v1/health` is the only exempt route. If
`SOCHELI_API_KEY` is unset the server still boots (logs a warning) but returns `503` for
every authenticated route.

Reads (`/v1/items`, `/v1/jobs`, `/v1/fleet`, `/v1/schedule`) are served synchronously from the
file store. Writes either **dispatch a job over MQTT** (`POST /v1/generate`) or **spawn the
engine CLI detached** (`POST /v1/items/:id/publish` → `node --import tsx packages/engine/src/cli.ts publish <id>`).
`POST /v1/generate` opens a fresh broker connection per request
(`connectAsync → publishAsync → endAsync`, QoS 1, 8 s connect timeout — no pooled connection)
and returns immediately; a broker failure returns `502`, no capable device returns `503`.

### Fleet bridge (`content bridge`)

`packages/engine/src/bridge.ts`, run as `content bridge` on the server (a systemd service).
It is an MQTT client that subscribes to `socheli/jobs`, `socheli/jobs/+/result`,
`socheli/jobs/+/progress`, and `socheli/workers/+/presence`, and projects everything into two
file views the dashboard and API read:

- `data/fleet.json` — `{ devices: Record<id, Presence>, updatedAt }` (written on presence)
- `data/jobs.json` — `{ jobs: JobRow[], updatedAt }` (written on job/result/progress)

It caps `data/jobs.json` at `MAX_JOBS = 60` rows and each job's progress tail at
`MAX_PROGRESS = 40` lines. It connects with `reconnectPeriod: 5000`.

### Broker (Mosquitto)

The MQTT broker is the control plane's transport. It listens on `1883` (tcp, localhost) for
**server-side** dispatch/subscription and on `9001` (websockets) for **device** connections,
exposed by Caddy as `wss://mqtt.socheli.com`. Broker config lives in `packages/engine/src/fleet.ts`
(`brokerConfig()`): server-side clients use `mqtt://127.0.0.1:1883`; devices set
`SOCHELI_BROKER_URL=wss://mqtt.socheli.com`. Credentials are managed with
`mosquitto_passwd` (per-device users). The broker, the API Bearer key, and Clerk are three
independent auth systems.

### Scheduler (`content tick` via launchd)

On each Mac, a launchd LaunchAgent (`com.socheli.scheduler`,
`packages/engine/assets/com.socheli.scheduler.plist`) runs `content tick` every
**60 s** (`StartInterval=60`, `RunAtLoad=true`), logging to `data/scheduler.log` with
`PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin` so Homebrew binaries (ffmpeg, node)
resolve. The plist is templated — `installAgent()` (`packages/engine/src/scheduler.ts`)
substitutes `__NODE__` (`process.execPath`) and `__REPO__` (the repo root) at install time.

`tick()` takes a lockfile (`data/scheduler.lock`, stale after `LOCK_STALE_MS = 45 min`) so a
1-minute interval never overlaps a minutes-long render, then processes **at most one** due
slot (or one-off) per tick and marks it fired so a QA-fail doesn't retry all day. It is
managed via the engine CLI:

```bash
pnpm content scheduler install     # bootstrap LaunchAgent (falls back to launchctl load -w)
pnpm content scheduler status      # installed? loaded? next slot? log tail
pnpm content scheduler uninstall   # bootout + unload + remove the plist
```

### Media host (Caddy file server)

The rendered mp4s land in `/opt/socheli/data/renders` after `rsync`. Caddy serves that
directory as a static file server at `https://media.socheli.com/<id>.mp4`. This public URL is
required because Instagram (Graph API `video_url`) and TikTok (`PULL_FROM_URL`) ingest a
publicly-reachable https video, never a local file. The publisher's **local uploader**
(`packages/engine/src/host.ts` → `localUploader()`) detects this deploy: with
`HOST_LOCAL_DIR=/opt/socheli/data/renders` + `HOST_PUBLIC_BASE=https://media.socheli.com` set,
it copies the render into the Caddy-served dir (if not already there) and returns its public
URL — no upload. (S3/R2 and signed-PUT backends exist as alternatives, picked by env;
`localUploader()` wins when configured.)

---

## Build & deploy

### pnpm workspace

The repo is a pnpm workspace (`pnpm-workspace.yaml`): `packages/*` and `apps/*`, with
`apps/mobile` explicitly **excluded** (the Expo app does its own install). Node `>=22`,
`pnpm@11.3.0` (`package.json`). Everything runs as TypeScript via `tsx` — there is no compile
step for the engine/API/CLI/MCP. The dashboard is the one thing that builds
(`next build`). Root scripts:

| Script | Runs |
| --- | --- |
| `pnpm content <cmd>` | engine CLI (`tsx packages/engine/src/cli.ts`) — `agent`, `bridge`, `tick`, `new`, `publish`, `scheduler …` |
| `pnpm api` | the Hono API server |
| `pnpm dev` | dashboard dev (`next dev --port 4040`) |
| `pnpm typecheck` | `tsc --noEmit` |

### What `scripts/sync-to-server.sh` does

This is the **data plane** push. The render device generates + renders; this script ships the latest
state up to the server. Step by step (`scripts/sync-to-server.sh`):

1. Resolves the SSH key from `SOCHELI_KEY` (default `~/.ssh/id_socheli`) and the host from
   `SOCHELI_HOST` (default `deploy@your-server.example.com`); destination is `/opt/socheli`.
2. Builds an SSH command: `ssh -i $KEY -o BatchMode=yes -o StrictHostKeyChecking=accept-new`.
3. `rsync -az --stats` pushes `data/` (runs + renders + concepts + schedule) to
   `$HOST:/opt/socheli/data/`, **excluding** `exports/`, `props/`, `*.log`, and `.DS_Store`.
4. With `--with-preview`, additionally syncs `packages/remotion/public/` (voice/music/broll
   media) so the live in-browser editor preview works on the server (large; usually not needed).
5. Prints the live URLs (`app.socheli.com`, `media.socheli.com`).

The render agent calls this automatically after a successful build (best-effort — a non-zero
sync exit is logged, not fatal).

### Deploying a code change

The render device is the source of truth. Data is pushed with rsync; **code** is pushed separately, then
rebuilt and restarted on the server:

```bash
# 1. push generated content/state (data plane)
./scripts/sync-to-server.sh

# 2. push code (exclude node_modules, .next, data, secrets), then on the server:
ssh deploy@your-server.example.com 'cd /opt/socheli \
  && pnpm install \
  && pnpm --filter dashboard build \
  && systemctl restart socheli-dashboard socheli-api socheli-bridge'
```

Restart Caddy/Mosquitto only if their config changed. The API, bridge, CLI, and MCP run
directly as TypeScript via `tsx`, so they need no build — `pnpm install` + a service restart
is enough; only the dashboard requires `next build`.

---

## Environment variables

Server-side engine/API/bridge vars are loaded from the repo-root `.env` by the minimal loader
in `packages/engine/src/env.ts` (it fills `process.env` for any key not already set — existing
env wins). In production that file is `/opt/socheli/.env`. The dashboard additionally reads
`apps/dashboard/.env.local`.

### Core / API / fleet (`SOCHELI_*`)

| Var | Default | Set where | Purpose |
| --- | --- | --- | --- |
| `SOCHELI_API_KEY` | — | `/opt/socheli/.env` (+ dashboard env) | Static Bearer key for all `/v1/*` routes; the dashboard sends it to the API. Unset → API returns `503`. Never embed in browser code. |
| `SOCHELI_API_PORT` | `8787` | server `.env` | Port the Hono API listens on. |
| `SOCHELI_API_URL` | `https://api.socheli.com` (SDK); `http://127.0.0.1:8787` (dashboard routes) | clients / dashboard | Base URL of the API. The SDK strips a trailing slash and injects `/v1`. |
| `SOCHELI_BROKER_URL` | `mqtt://127.0.0.1:1883` | server `.env`; devices `wss://mqtt.socheli.com` | MQTT broker URL for dispatch (API), subscription (bridge), and the agent. |
| `SOCHELI_MQTT_USER` | — | server `.env` + device | Broker username. |
| `SOCHELI_MQTT_PASS` | — | server `.env` + device | Broker password. |
| `SOCHELI_DEVICE_ID` | _auto_ | device | Unique device id (presence + direct-dispatch topics). If unset, an auto-generated codename is persisted to `~/.socheli/device-id`. |
| `SOCHELI_DATA_DIR` | `<repo>/data` | server `.env` | Location of `runs/`, `jobs.json`, `fleet.json`, `schedule.json`. |
| `SOCHELI_RENDERS_DIR` | `<DATA_DIR>/renders` | server `.env` | Where rendered mp4s land. |
| `SOCHELI_PLAN` | `free` | dashboard env | Pins the active plan id (`free`/`creator`/`studio`/`team`) until real Polar subscription records exist. |
| `SOCHELI_HOST` | `deploy@your-server.example.com` | device | rsync target host (`scripts/sync-to-server.sh`). |
| `SOCHELI_KEY` | `~/.ssh/id_socheli` | device | SSH key for rsync. |

### Media host (`HOST_*`)

The publisher picks the first configured backend: local dir → S3 → signed PUT
(`packages/engine/src/host.ts`).

| Var | Default | Set where | Purpose |
| --- | --- | --- | --- |
| `HOST_LOCAL_DIR` | — | server `.env` | Caddy-served dir (e.g. `/opt/socheli/data/renders`). With `HOST_PUBLIC_BASE`, enables the local uploader (copy-in, no upload). |
| `HOST_PUBLIC_BASE` | `https://media.socheli.com` | server `.env` | Public base for the computed `videoUrl` and for every host backend. |
| `HOST_S3_BUCKET` / `HOST_S3_PUBLIC_BASE` / `HOST_S3_ENDPOINT` / `HOST_S3_REGION` | — | optional | S3/R2/Bunny/MinIO backend via the `aws` CLI. |
| `HOST_UPLOAD_URL` | — | optional | Generic signed-PUT backend (with `HOST_PUBLIC_BASE`). |

### Pipeline / capability keys

| Var | Set where | Purpose |
| --- | --- | --- |
| `ELEVENLABS_API_KEY` | device | Presence advertises `voice:eleven` when set. |
| `PEXELS_API_KEY` | device | Presence advertises `broll:pexels` when set. |

(`.venv-music` in the repo + a GPU drive `music:musicgen` / `broll:sdturbo` — these are
filesystem/hardware probes in `probeCapabilities()`, not env vars.)

### Dashboard — Clerk (auth)

Standard `@clerk/nextjs` v7 variables, set in `apps/dashboard/.env.local` (server) / Clerk
production instance:

| Var | Purpose |
| --- | --- |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | Clerk publishable (frontend) key. |
| `CLERK_SECRET_KEY` | Clerk backend secret key (used by `clerkMiddleware`). |

### Dashboard — Polar (billing)

`apps/dashboard/lib/billing.ts` — billing is enabled once `POLAR_*` is configured:

| Var | Purpose |
| --- | --- |
| `POLAR_ACCESS_TOKEN` | Polar API access token (presence of this or `POLAR_ORGANIZATION_ID` marks billing configured). |
| `POLAR_ORGANIZATION_ID` | Polar organization id. |
| `POLAR_CHECKOUT_URL` | Checkout base URL. |
| `POLAR_PORTAL_URL` | Customer portal URL. |

### Dashboard — OpenRouter (Copilot)

`apps/dashboard/lib/agent/openrouter.ts`:

| Var | Default | Purpose |
| --- | --- | --- |
| `OPENROUTER_API_KEY` | — | Enables the in-app Copilot; unset → graceful one-line fallback stream. |
| `OPENROUTER_MODEL` | `google/gemma-4-26b-a4b-it` | Model id (fallbacks `google/gemma-4-31b-it`, `deepseek/deepseek-v4-flash`). |
| `OPENROUTER_FALLBACK_MODELS` | — | Comma-separated fallback model ids. |
| `OPENROUTER_SITE_URL` | `https://app.socheli.com` | `HTTP-Referer` header. |
| `OPENROUTER_APP_NAME` | `Soli` | `X-Title` header. |

---

## DNS & domains

DNS is on Cloudflare, **DNS-only** (not proxied) pointing at the server; Caddy issues the TLS
certificates and reverse-proxies each host.

| Host | → | Served by |
| --- | --- | --- |
| `socheli.com` | marketing / root | (apex) |
| `app.socheli.com` | dashboard (`:4040`) | Caddy `reverse_proxy 127.0.0.1:4040` (encode gzip) |
| `api.socheli.com` | API (`:8787`) | Caddy `reverse_proxy 127.0.0.1:8787` |
| `media.socheli.com` | rendered mp4s | Caddy `root * /opt/socheli/data/renders; file_server` |
| `mqtt.socheli.com` | broker websockets (`:9001`) | Caddy `reverse_proxy 127.0.0.1:9001` → `wss://` |
| `clerk.app.socheli.com` / `accounts.app.socheli.com` / `clkmail.app.socheli.com` | Clerk production | Clerk-managed CNAMEs |

Caddy config (excerpt):

```caddyfile
api.socheli.com   { reverse_proxy 127.0.0.1:8787 }
app.socheli.com   { encode gzip; reverse_proxy 127.0.0.1:4040 }
media.socheli.com { root * /opt/socheli/data/renders; file_server }
mqtt.socheli.com  { reverse_proxy 127.0.0.1:9001 }
```

---

## End-to-end data flow for a published video

Tracing one idea from a client request to a live, served, posted mp4:

1. **Request.** A client (dashboard, SDK, CLI, or MCP) calls `POST /v1/generate` on
   `api.socheli.com` over HTTPS with the Bearer key. The dashboard's `/api/generate` route
   forwards to `${SOCHELI_API_URL}/v1/generate` when `SOCHELI_API_KEY` is set.
2. **Route by capability.** The API builds a `Job` (`job_<base36 time><random>`),
   `jobRequirements(job)` derives `{ hard: ["render"], prefer: […] }`, and
   `pickDevice(getFleet().devices, reqs)` picks the best-fit **online** device (idle > busy,
   more matching preferred caps, more RAM as tie-break). No capable device → `503`.
3. **Dispatch (control plane).** The API publishes the job JSON to
   `socheli/device/<device>/jobs` at QoS 1 over `mqtt://127.0.0.1:1883`, then returns
   `{ dispatched, job, device, routing }` immediately. A broker failure → `502`.
4. **Device claims + renders.** The chosen agent (over `wss://mqtt.socheli.com`) receives the
   job, sets presence `busy`, emits an `ack` result, and runs the **full engine pipeline on
   its own hardware** (Remotion + ffmpeg, optional local ML). Every log line streams to
   `socheli/jobs/<id>/progress`.
5. **Ship the artifact (data plane).** On success the agent runs `scripts/sync-to-server.sh`,
   `rsync -az`-ing `data/` (runs + renders + concepts + schedule) up to
   `deploy@your-server.example.com:/opt/socheli/data/`. The mp4 lands in `/opt/socheli/data/renders` and
   `data/runs/<id>.json` lands so the API can serve item detail with a computed `videoUrl`.
6. **Bridge projects state.** The server-side `content bridge` records presence/progress/
   results into `data/fleet.json` and `data/jobs.json` throughout.
7. **Serve publicly.** Caddy publishes the render at `https://media.socheli.com/<id>.mp4`.
8. **Publish.** For `type: "auto"` the device publishes after render; otherwise the scheduler
   (or `POST /v1/items/:id/publish`) runs the engine publish CLI server-side. IG and TikTok
   ingest the `media.socheli.com` URL via the local uploader (no re-upload, since the file is
   already in the Caddy-served dir).
9. **Caller polls.** Generation is fire-and-forget, so the caller polls `GET /v1/jobs` (or
   `socheli jobs`) until `JobRow.status` reaches `done`.

---

## Standing up a new render device

1. **Clone + install.** Clone the repo on the device and `pnpm install` (Node `>=22`).
2. **Broker creds (on the server).** `mosquitto_passwd -b /etc/mosquitto/passwd <device> <pass>`,
   then `systemctl restart mosquitto`.
3. **SSH key for rsync.** Ensure the device can `ssh deploy@your-server.example.com` with the key at
   `$SOCHELI_KEY` (default `~/.ssh/id_socheli`).
4. **Env.** Set the broker + identity vars (and any quality keys):

   ```bash
   export SOCHELI_BROKER_URL=wss://mqtt.socheli.com
   export SOCHELI_MQTT_USER=<device-user>
   export SOCHELI_MQTT_PASS=<device-pass>
   export SOCHELI_DEVICE_ID=<unique-name>     # optional — else auto-generated & persisted to ~/.socheli/device-id
   # optional: ELEVENLABS_API_KEY, PEXELS_API_KEY (advertise premium caps)
   ```

5. **Run the agent.** `pnpm content agent` (or `content agent --device <id>`). On startup it
   probes its caps + hardware profile, connects, advertises presence, and subscribes to both
   its **direct** topic (`socheli/device/<id>/jobs`) and the **shared queue**
   (`$share/render/socheli/jobs`). It auto-joins the fleet, load-balanced by the matcher.
6. **Keep it awake / persistent.** To stop the Mac sleeping while it serves jobs, run the
   worker under `caffeinate -is`. For the posting timer, install the launchd scheduler with
   `pnpm content scheduler install`.

A device must heartbeat (every 20 s) more often than the `STALE_MS = 70_000` read-time
staleness window or it silently drops out of routing.

---

## Operational notes

### Health checks

```bash
# API liveness (unauthenticated)
curl -s https://api.socheli.com/v1/health         # { ok, version, uptime }

# Fleet state (authenticated) — who's online, their caps, current jobs
curl -s -H "Authorization: Bearer $SOCHELI_API_KEY" https://api.socheli.com/v1/fleet
socheli fleet                                      # same via the CLI

# Dashboard / media reachability
curl -sI https://app.socheli.com
curl -sI https://media.socheli.com/<id>.mp4
```

`GET /v1/health` is the only route exempt from the Bearer middleware, so it's the safe
liveness probe. `getFleet()` forces any device with `lastSeen` older than 70 s to `offline`,
so an empty/stale `/v1/fleet` means heartbeats aren't arriving (broker or agent down).

### Logs

| Where | What |
| --- | --- |
| `journalctl -u socheli-api -f` (server) | API logs (`[socheli-api …] listening on :8787`) |
| `journalctl -u socheli-bridge -f` (server) | bridge connect/subscribe + per-job dispatch lines |
| `journalctl -u socheli-dashboard -f` (server) | Next.js runtime logs |
| `journalctl -u mosquitto -f` / `journalctl -u caddy -f` (server) | broker / proxy logs |
| `data/scheduler.log` (device) | launchd `content tick` output (last 25 lines via `scheduler status`) |
| `data/generate.log` (device, dev fallback) | in-process engine generate output |

### Restart

```bash
# server (systemd)
systemctl restart socheli-api socheli-bridge socheli-dashboard
systemctl restart mosquitto caddy            # only if their config changed

# device (launchd scheduler)
pnpm content scheduler uninstall && pnpm content scheduler install
# render agent: Ctrl-C (publishes a clean `offline` presence) then re-run `pnpm content agent`
```

### Failure modes

- `POST /v1/generate` → `400` (`seed` missing on a `new` build), `503` (no online device with
  the `render` cap — includes the routing reason + requirements), `502` (broker unreachable).
- The rsync step is best-effort: a non-zero exit is logged (`sync exited <code>`) and does
  **not** flip the job to `error`.
- `POST /v1/items/:id/publish` spawns a detached CLI with `stdio: "ignore"` — failures are
  invisible to the caller; check the engine/scheduler logs.
