# Fleet

The **Fleet** is Socheli's distributed render layer: a pool of **render devices** (an a render device, and any others you add) that pick up generation jobs over MQTT, run the *entire* engine pipeline locally on their own hardware, and ship the finished mp4 back to the server. The always-on server never renders — it only dispatches jobs, observes the fleet, and serves the resulting artifacts.

This design exists because rendering is heavy (Remotion + ffmpeg, optional local ML for voice/music/b-roll) and the server (a small VPS) is not. By pushing every render onto capable devices, the server stays cheap and the system scales by adding hardware, not by upgrading the box.

The whole subsystem is built on one defining split:

| | Control plane | Data plane |
| --- | --- | --- |
| **Carries** | Job dispatch, device presence/heartbeat, render progress, terminal results | Rendered `.mp4` artifacts + `data/` state |
| **Transport** | MQTT (Mosquitto) — `wss://mqtt.socheli.com` for devices, `mqtt://127.0.0.1:1883` for server-side dispatch/bridge | `rsync` over SSH (device → server), then HTTPS via Caddy |
| **Message size** | Tiny JSON | Heavy video files |
| **Topics / endpoints** | `socheli/jobs`, `socheli/device/<id>/jobs`, `socheli/workers/<id>/presence`, `socheli/jobs/<id>/progress`, `socheli/jobs/<id>/result` | `scripts/sync-to-server.sh` → `media.socheli.com/<id>.mp4` |

**Video never crosses the message bus.** Only tiny control messages flow over MQTT. Heavy artifacts travel by `rsync` and are served over HTTPS.

---

## Topology

```
server (small VPS, your-server.example.com / app.socheli.com)
  ├─ Mosquitto broker        :1883 (tcp localhost) + :9001 (websockets) → wss://mqtt.socheli.com
  ├─ @socheli/api (Hono)     dispatches jobs over MQTT, reads file store
  ├─ content bridge          subscribes to MQTT, projects → data/fleet.json + data/jobs.json
  └─ Caddy media file server media.socheli.com/<id>.mp4

devices ("content agent" workers — render-01, …)
  └─ connect to wss://mqtt.socheli.com, advertise presence + caps,
     pull jobs, render locally, rsync data/ up
```

Three engine processes implement the fleet, each launched from the engine CLI (`pnpm content <cmd>`):

| Process | Command | Where | Role |
| --- | --- | --- | --- |
| **Agent** | `content agent` | render device | Connects to broker, advertises caps, pulls jobs, renders, rsyncs (`packages/engine/src/agent.ts`) |
| **Bridge** | `content bridge` | server | Subscribes to all control topics, writes `data/fleet.json` + `data/jobs.json` (`packages/engine/src/bridge.ts`) |
| **Dispatch** | `content dispatch <type>` | anywhere (testing) | Publishes one job to the shared queue (`packages/engine/src/cli.ts`) |

The production dispatch path is **not** `content dispatch` — it is the API's `POST /v1/generate`, which routes to a device's *direct* topic. `content dispatch` exists for manual testing against the shared queue.

---

## MQTT topics & message shapes

All topics and payload types live in `packages/engine/src/fleet.ts` (`TOPICS`, and the `Job` / `Presence` / `JobResult` types). They are the single source of truth — the agent, bridge, and API all import them.

```ts
export const SHARE_GROUP = "render";

export const TOPICS = {
  jobs:         "socheli/jobs",                            // shared work queue (dispatch in)
  jobsShared:   "$share/render/socheli/jobs",              // workers subscribe via this share group
  device:       (d) => `socheli/device/${d}/jobs`,         // central-scheduler DIRECT dispatch
  presence:     (d) => `socheli/workers/${d}/presence`,    // retained presence + Last-Will
  presenceWild: "socheli/workers/+/presence",
  progress:     (id) => `socheli/jobs/${id}/progress`,     // streamed log lines while running
  progressWild: "socheli/jobs/+/progress",
  result:       (id) => `socheli/jobs/${id}/result`,       // terminal: ack / done / error
  resultWild:   "socheli/jobs/+/result",
};
```

### Topic reference

| Topic | Direction | QoS | Retain | Payload | Purpose |
| --- | --- | --- | --- | --- | --- |
| `socheli/jobs` | publisher → broker | 1 | no | `Job` | Shared work queue. Used by `content dispatch` and any unrouted publisher. |
| `$share/render/socheli/jobs` | broker → one worker | 1 | — | `Job` | The MQTT **shared subscription** form of `socheli/jobs`; the broker delivers each message to exactly one subscriber in the `render` group (load balancing). |
| `socheli/device/<id>/jobs` | API → one device | 1 | no | `Job` | **Direct** capability-routed dispatch from `POST /v1/generate`. The agent subscribes to its own id. |
| `socheli/workers/<id>/presence` | device → broker | 1 | **yes** | `Presence` | Retained presence; refreshed every 20 s and set to `offline` by Last-Will on disconnect. |
| `socheli/jobs/<id>/progress` | device → broker | 0 | no | `{ at, line }` | Streamed pipeline log lines while the job runs. |
| `socheli/jobs/<id>/result` | device → broker | 1 | no | `JobResult` | Terminal lifecycle: `ack` (claimed/running), `done` (+ `itemId`), `error` (+ `message`). |

### Message payloads

```ts
// socheli/jobs and socheli/device/<id>/jobs
type Job = {
  id: string;          // job_<base36 time><random>
  type: "auto" | "new" | "ping";
  channel?: string;    // default "concept_lab"
  seed?: string;       // the idea/topic
  mood?: string;
  voice?: boolean;     // prefer premium voice
  public?: boolean;    // publish publicly after render (auto)
  createdAt: string;
  by?: string;         // "api" | "cli" | "dashboard" | clerk user
};

// socheli/workers/<id>/presence  (retained)
type Presence = {
  device: string;
  status: "online" | "idle" | "busy" | "offline";
  caps?: string[];     // capability vocabulary (below)
  profile?: DeviceProfile;
  currentJob?: string | null;
  lastSeen: string;    // ISO; the freshness clock
};

// socheli/jobs/<id>/result
type JobResult = {
  jobId: string;
  device: string;
  status: "ack" | "done" | "error";
  itemId?: string;     // on done
  message?: string;    // on error
  at: string;
};

// socheli/jobs/<id>/progress  (qos 0)
{ at: string; line: string }
```

### Dispatch: shared vs direct

There are two ways a job reaches a device, and both are live:

- **Direct (production).** `POST /v1/generate` runs the central scheduler, picks one device, and publishes to that device's **direct** topic `socheli/device/<id>/jobs`. The agent subscribes to `TOPICS.device(deviceId)`.
- **Shared queue (testing / unrouted).** A publisher sends to `socheli/jobs`. Workers subscribe via `$share/render/socheli/jobs`, so the broker delivers each job to **exactly one** worker in the `render` share group — round-robin load balancing with no scheduler involved.

The agent subscribes to **both** at connect time:

```ts
client.subscribe([TOPICS.device(deviceId), TOPICS.jobsShared], { qos: 1 });
```

---

## End-to-end render job flow

Tracing one job from `POST /v1/generate` to a live, served mp4:

1. **Generate request.** A client (SDK/CLI/MCP/dashboard) calls `POST /v1/generate` with `GenerateInput { seed, channel?, mood?, voice?, type? }`. The handler builds a `Job` with a server-side id `job_<base36 time><random>`, defaults `channel` to `concept_lab`, coerces `type` to `auto` or `new`, and tags `by: "api"`. For `type: "new"`, `seed` is required (else `400`).

2. **Capability routing.** `jobRequirements(job)` derives `{ hard: ["render"], prefer: [...] }`. `pickDevice(getFleet().devices, reqs)` filters to online devices holding every hard cap and scores the rest. If none match, the API returns `503` with the reason and the requirements.

3. **Dispatch over MQTT.** The API opens a fresh broker connection (`connectAsync` → `publishAsync` → `endAsync`, QoS 1, 8 s connect timeout — no pooled connection), publishes the job JSON to `socheli/device/<id>/jobs`, and immediately returns `{ dispatched, job, device, routing }`. It does **not** wait for the render. A broker failure here returns `502`.

   ```ts
   const reqs  = jobRequirements(job);                  // hard:[render], prefer:[voice/music/broll]
   const match = pickDevice(getFleet().devices, reqs);  // idle > busy, +RAM tiebreak
   if (!match.device) return c.json({ error: match.reason, requirements: reqs }, 503);
   await dispatch(`socheli/device/${match.device.device}/jobs`, job); // qos 1
   return c.json({ dispatched: true, job, device: match.device.device, routing: match.reason });
   ```

4. **Device claims the job.** The chosen agent receives the message, pushes it onto an in-memory queue, and drains **serially** (one render at a time — rendering is heavy). On claim it sets presence `busy`, sets `currentJob`, and emits a `result` with `status: "ack"`.

5. **Render locally.** `runJob()` runs the full engine pipeline on the device's own hardware:
   - `type: "auto"` → `autopilot(channel, { seed, voice, public, publish: true })` (generate **and** publish).
   - `type: "new"`  → `generate(seed, channel, { voice, mood })` (build only).
   - `type: "ping"` → emits a `pong` progress line and returns (no render). Every pipeline log line is streamed to `socheli/jobs/<id>/progress`.

6. **rsync the result up (data plane).** After a successful build the agent runs `scripts/sync-to-server.sh`, which `rsync -az` pushes `data/` (runs + renders + concepts + schedule) to `deploy@your-server.example.com:/opt/socheli/data/` over SSH. Caddy then serves the mp4 at `media.socheli.com/<id>.mp4`, and `data/runs/<id>.json` lands so the API can return item detail with a computed `videoUrl`.

7. **Terminal result.** The agent emits a final `result` — `done` (with `itemId`) or `error` (with `message`) — then returns to presence `idle`, `currentJob: null`.

8. **Bridge projects state.** Throughout, the **content bridge** on the server is subscribed to jobs/results/progress/presence and writes everything into `data/jobs.json` and `data/fleet.json`.

9. **Caller polls.** Because generation is fire-and-forget, the caller polls `GET /v1/jobs` (or `socheli jobs`) and reads `JobRow.progress` until `status` reaches `done` (or `error`).

---

## Data model

### `Device` (`packages/sdk/src/types.ts`) — a device row in `data/fleet.json`

This is the public DTO the API serves. It is the same shape the agent advertises as `Presence`.

| Field | Type | Notes |
| --- | --- | --- |
| `device` | `string` | Unique device id (`SOCHELI_DEVICE_ID`, or an auto-generated codename persisted to `~/.socheli/device-id`). |
| `status` | `"online" \| "idle" \| "busy" \| "offline"` | Liveness/work state. Forced to `offline` at read time if stale (below). |
| `caps` | `string[]?` | Capability vocabulary the device probed at startup. |
| `profile` | `DeviceProfile?` | Hardware profile (below). |
| `currentJob` | `string \| null?` | Id of the job currently rendering, if any. |
| `lastSeen` | `string` | ISO timestamp; the freshness clock for offline detection. |

### `DeviceProfile`

| Field | Type | Example | Detected by |
| --- | --- | --- | --- |
| `arch` | `string` | `arm64`, `x64` | `process.arch` |
| `platform` | `string` | `darwin`, `linux` | `process.platform` |
| `cpus` | `number` | `10` | `os.cpus().length` |
| `ramGb` | `number` | `17` | `Math.round(os.totalmem() / 1e9)` |
| `gpu` | `string` | `metal`, `cuda`, `none` | `darwin+arm64 → metal`; else `nvidia-smi → cuda`; else `none` |

### `JobRow` (extends `Job`) — a row in `data/jobs.json`

| Field | Type | Notes |
| --- | --- | --- |
| `id` | `string` | Job id. |
| `type` | `"auto" \| "new" \| "ping"` | |
| `channel` / `seed` / `by` | `string?` | From the dispatched `Job`. |
| `createdAt` | `string` | |
| `status` | `"dispatched" \| "running" \| "done" \| "error"` | `dispatched` on first sight; `running` on `ack`; `done`/`error` on terminal result. |
| `device` | `string?` | Which device claimed it (from `JobResult`). |
| `itemId` | `string?` | Resulting content item id (on `done`). |
| `message` | `string?` | Error text (on `error`). |
| `progress` | `{ at, line }[]` | Streamed log tail, capped at 40 lines in the bridge. |
| `updatedAt` | `string` | |

### `FleetState` — the `GET /v1/fleet` response

| Field | Type | Notes |
| --- | --- | --- |
| `devices` | `Device[]` | All known devices, with stale ones forced to `offline`. |
| `jobs` | `JobRow[]` | 30 most recent jobs. |
| `online` | `number` | Count of devices whose status is not `offline`. |

### File store

| File | Shape | Written by | Read by |
| --- | --- | --- | --- |
| `data/fleet.json` | `{ devices: Record<id, Presence>, updatedAt }` | bridge (`onPresence`) | `getFleet()` → `GET /v1/fleet`, `/devices` page |
| `data/jobs.json` | `{ jobs: JobRow[], updatedAt }` | bridge (`onJob`/`onResult`/`onProgress`) | `getJobs()` → `GET /v1/jobs` |

The bridge caps `data/jobs.json` at `MAX_JOBS = 60` rows and each job's progress tail at `MAX_PROGRESS = 40` lines.

---

## Capabilities & job-to-device matching

### Capability vocabulary

Each device **probes itself** at agent startup via `probeCapabilities()` (`packages/engine/src/fleet.ts`) and advertises the result in its presence. The server-side matcher (`packages/api/src/match.ts`) routes by these caps — keep the two in sync.

| cap | means | detected by |
| --- | --- | --- |
| `render` | Remotion + ffmpeg available (every generation job needs this) | `command -v ffmpeg` succeeds (chromium is auto-fetched) |
| `voice:kokoro` | local Kokoro voice | always (bundled `kokoro-js`) |
| `voice:eleven` | ElevenLabs premium voice | `ELEVENLABS_API_KEY` set |
| `music:musicgen` | local MusicGen | `.venv-music` directory exists in the repo |
| `broll:pexels` | Pexels stock b-roll | `PEXELS_API_KEY` set |
| `broll:sdturbo` | local SD-Turbo image b-roll | `.venv-music` exists **and** a GPU (`gpu !== "none"`) |

A device's advertised profile looks like:

```jsonc
{ "arch": "arm64", "platform": "darwin", "cpus": 10, "ramGb": 17, "gpu": "metal",
  "caps": ["render", "voice:kokoro", "voice:eleven", "music:musicgen", "broll:sdturbo", "broll:pexels"] }
```

### Requirements

`jobRequirements(job)` derives what a job needs:

| Job type | `hard` | `prefer` |
| --- | --- | --- |
| `ping` | `[]` | `[]` |
| `auto` / `new` | `["render"]` | `["music:musicgen", "broll:sdturbo", "broll:pexels"]`, prepended with `"voice:eleven"` when `voice: true` |

`render` is the only **hard** requirement — a minimal device still renders; premium voice/music/b-roll are quality **preferences** and the pipeline degrades gracefully without them.

### Scoring

`pickDevice(devices, reqs)` filters to online devices that hold **all** hard caps, then scores the rest and returns the winner plus a human-readable `reason`:

```ts
const online  = devices.filter(d => d.status !== "offline");
const capable = online.filter(d => reqs.hard.every(c => (d.caps ?? []).includes(c)));
if (!capable.length) return { reason: `no online device with required cap(s): ${reqs.hard.join(", ")}`, matched: [] };

const score = (d) => {
  let s = d.status === "idle" ? 100 : 0;                 // strongly prefer idle
  for (const c of reqs.prefer) if ((d.caps ?? []).includes(c)) s += 10;
  s += (d.profile?.ramGb ?? 0) / 8;                      // tie-break: more RAM
  return s;
};
```

So: an **idle** device always beats a busy one; among ties, more matching **preferred** caps win; final tie-break is **more RAM**. The returned `reason` reads like `"idle · 4/4 caps"`. Adding a beefy GPU box automatically makes it the preferred target for ML-heavy jobs, while a small box can still take plain renders. If no online device meets the hard requirements, `POST /v1/generate` returns `503`.

---

## Heartbeat, presence & offline handling

The fleet's liveness model is **retained presence + periodic heartbeat + Last-Will + read-time staleness**:

- **Connect.** On connect the agent publishes presence `idle` (retained, QoS 1) so a late-joining bridge immediately sees the device.
- **Heartbeat.** Every **20 s** the agent re-publishes its current presence (`setInterval(... 20_000)`), refreshing `lastSeen`.
- **Last-Will.** The agent registers an MQTT Last-Will on `socheli/workers/<id>/presence` (`status: "offline"`, retained, QoS 1). If the device drops without a clean disconnect, the broker publishes it automatically and the bridge marks it offline.
- **Clean shutdown.** On `SIGINT`/`SIGTERM` the agent publishes presence `offline` before ending the connection.
- **Read-time staleness.** Even if a device dies hard and the will somehow doesn't land, `getFleet()` (`packages/api/src/store.ts`) overrides any stored status to `offline` when `lastSeen` is older than `STALE_MS = 70_000` (70 s):

  ```ts
  const STALE_MS = 70_000;
  const stale = now - new Date(d.lastSeen).getTime() > STALE_MS;
  return stale && d.status !== "offline" ? { ...d, status: "offline" as const } : d;
  ```

Because the heartbeat is 20 s and the stale window is 70 s, a device must miss roughly three heartbeats before it drops out of routing. A device that stops heart-beating silently disappears from `pickDevice()`'s candidate set.

**Job failure** is reported in-band: any exception in `runJob()` becomes a `JobResult { status: "error", message }`, which the bridge records on the `JobRow` (`status: "error"`, `message`). The rsync step is best-effort — `runSync()` resolves even on a non-zero exit, logging `sync exited <code>`, so a sync hiccup does not flip the job to `error`.

---

## REST endpoints (control-plane surface)

The fleet is observed and driven through `@socheli/api` (`packages/api/src/server.ts`). All routes are under `/v1` and require the static Bearer key (`SOCHELI_API_KEY`), except `/v1/health`.

| Method | Path | Effect |
| --- | --- | --- |
| `GET` | `/v1/fleet` | `FleetState { devices, jobs, online }`. Stale devices forced `offline` at read time. |
| `GET` | `/v1/jobs` | 30 most recent `JobRow[]` from `data/jobs.json`. |
| `POST` | `/v1/generate` | Build a job, route by capability, dispatch over MQTT (fire-and-forget). |

### `POST /v1/generate`

Request body (`GenerateInput`):

| Field | Type | Default | Notes |
| --- | --- | --- | --- |
| `seed` | `string` | — | The idea/topic. Required when `type: "new"`. |
| `channel` | `string` | `concept_lab` | |
| `mood` | `string` | — | |
| `voice` | `boolean` | `false` | When `true`, adds `voice:eleven` to preferred caps. |
| `type` | `"auto" \| "new"` | `new` | `auto` also publishes after render. |

Success → `{ dispatched: true, job, device, routing }`. Failure modes:

| Code | Cause | Body |
| --- | --- | --- |
| `400` | `seed` missing on a `new` build | `{ error: "seed required for a 'new' build" }` |
| `503` | No online device with the required `render` cap | `{ error: <reason>, requirements }` |
| `502` | MQTT broker unreachable at dispatch | `{ error: "broker unreachable: <msg>" }` |

---

## Observing the fleet via SDK / CLI

### SDK (`@socheli/sdk`)

```ts
import { createSocheli } from "@socheli/sdk";
const socheli = createSocheli({ apiKey: process.env.SOCHELI_API_KEY });

const { online, devices, jobs } = await socheli.fleet();   // GET /v1/fleet
for (const d of devices) {
  console.log(d.device, d.status, d.profile?.gpu, (d.caps ?? []).join(","));
}

const { dispatched, job, device, routing } = await socheli.generate({
  seed: "why we procrastinate", channel: "concept_lab", type: "auto", voice: true,
});

let rows = await socheli.jobs();                            // GET /v1/jobs — poll for completion
```

### CLI (`socheli`)

```bash
socheli fleet                         # render devices online (GET /v1/fleet)
socheli generate "why we procrastinate" --channel concept_lab --auto
socheli jobs                          # watch it render (GET /v1/jobs)
```

`Device.status` is one of `online`, `idle`, `busy`, `offline`. The `/devices` dashboard page renders the same `FleetState`, showing each device's profile, caps, current job, and last-seen.

---

## Running a render device

On the device, in the repo, set the broker creds and a unique id, then run the agent:

```bash
export SOCHELI_BROKER_URL=wss://mqtt.socheli.com
export SOCHELI_MQTT_USER=<device-user>
export SOCHELI_MQTT_PASS=<device-pass>
export SOCHELI_DEVICE_ID=<unique-name>      # optional — else an auto-generated codename, persisted to ~/.socheli/device-id
pnpm content agent                          # or: content agent --device <id>
```

On startup the agent probes its capabilities, connects to the broker, advertises presence + caps, and subscribes to both its direct topic and the shared queue. It then claims jobs, runs `generate()` / `autopilot()`, rsyncs `data/` up, and reports back over MQTT. `Ctrl-C` triggers a clean `offline` presence.

### Add a new device

1. Clone the repo and `pnpm install` on the device.
2. On the server, create broker creds: `mosquitto_passwd -b /etc/mosquitto/passwd <device> <pass>`, then restart Mosquitto.
3. Set the four `SOCHELI_*` env vars (broker `wss://mqtt.socheli.com`, the new creds, a unique `SOCHELI_DEVICE_ID`).
4. `pnpm content agent` (or install a launchd/systemd copy).

It auto-joins the shared queue and becomes eligible for direct dispatch, load-balanced across the whole fleet by the matcher.

### Keep a Mac always-available (launchd)

A launchd agent keeps the device reachable. The shipped LaunchAgent is `com.socheli.scheduler` (`packages/engine/assets/com.socheli.scheduler.plist`), managed via the engine CLI:

```bash
pnpm content scheduler install     # bootstrap the LaunchAgent (falls back to launchctl load -w)
pnpm content scheduler status      # installed? loaded? next slot? log tail
pnpm content scheduler uninstall   # bootout + unload + remove the plist
```

The plist runs `content tick` every **60 s** (`StartInterval=60`, `RunAtLoad=true`), logging to `data/scheduler.log`, with `PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin` so Homebrew binaries (ffmpeg, node) resolve. `tick()` (`packages/engine/src/scheduler.ts`) takes a lockfile (`data/scheduler.lock`, stale after 45 min) so a 1-minute interval never overlaps a minutes-long render, then processes at most **one** due slot per tick. The scheduler is the autopilot/posting timer; the **agent** is the MQTT render worker. To keep the Mac from sleeping while it serves jobs, run the worker under `caffeinate -is` (it reverts to normal sleep when the worker stops).

---

## Test the loop

```bash
pnpm content dispatch ping     # publish a no-op job to socheli/jobs (shared queue)
pnpm content dispatch new --channel concept_lab --seed "why we procrastinate"
pnpm content dispatch auto --channel concept_lab --public
```

`content dispatch` publishes a `Job` to `socheli/jobs` at QoS 1 and exits; watch a device pick it up (its presence flips to `busy`, then `idle`) and the `JobRow` advance through `dispatched → running → done` in `data/jobs.json`.

---

## Config / env reference

### Render device (agent)

| Var | Default | Purpose |
| --- | --- | --- |
| `SOCHELI_BROKER_URL` | `mqtt://127.0.0.1:1883` | MQTT broker URL. Devices use `wss://mqtt.socheli.com`. |
| `SOCHELI_MQTT_USER` | — | Broker username. |
| `SOCHELI_MQTT_PASS` | — | Broker password. |
| `SOCHELI_DEVICE_ID` | _auto_ | Unique device id (presence + direct-dispatch topics). If unset, an evocative codename is generated from the hardware and persisted to `~/.socheli/device-id`. |
| `ELEVENLABS_API_KEY` | — | Presence advertises `voice:eleven` when set. |
| `PEXELS_API_KEY` | — | Presence advertises `broll:pexels` when set. |
| `SOCHELI_HOST` | `deploy@your-server.example.com` | rsync target (used by `scripts/sync-to-server.sh`). |
| `SOCHELI_KEY` | `~/.ssh/id_socheli` | SSH key for rsync. |

(`.venv-music` in the repo + a GPU drive `music:musicgen` / `broll:sdturbo`; these are filesystem/hardware probes, not env vars.)

### Server (API + bridge)

| Var | Default | Purpose |
| --- | --- | --- |
| `SOCHELI_BROKER_URL` | `mqtt://127.0.0.1:1883` | Broker for dispatch (API) and subscription (bridge). |
| `SOCHELI_MQTT_USER` / `SOCHELI_MQTT_PASS` | — | Broker creds (server-side only). |
| `SOCHELI_API_KEY` | — | Static Bearer key for all `/v1/*` routes. |
| `SOCHELI_DATA_DIR` | `<repo>/data` | Location of `fleet.json` / `jobs.json` / `runs`. |
| `SOCHELI_RENDERS_DIR` | `<DATA_DIR>/renders` | Where rendered mp4s land. |
| `HOST_PUBLIC_BASE` | `https://media.socheli.com` | Base for the computed `videoUrl`. |

The MQTT broker credentials, the API Bearer key, and the dashboard's Clerk auth are **three independent** auth systems — compromise of one does not expose the others.
