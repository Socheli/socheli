# Mood System

Every Socheli post is driven by a **mood preset** — a complete visual + audio + editorial identity that flows from the CLI flag all the way to the Remotion renderer.

```
content new "<idea>" --mood <id>
```

---

## Available moods

| id | Name | Background | Transitions | B-roll | Accent |
|---|---|---|---|---|---|
| `explainer` | Explainer | mesh | fade | stock | #4f8ff7 |
| `motivational` | Motivational | mesh | slamzoom | stock | #ff8a3d |
| `business` | Business & Finance | **financial** | wipe→slide→wipe | native | #3ec98a |
| `tech` | Tech & AI | **network_tech** | terminal_wipe→wipe | native | #3ad6ff |
| `mindfulness` | Mindfulness | soft | dissolve | stock | #6fc7ba |
| `cinematic` | Cinematic | mesh | fade→zoom | stock | #3a4ea3 |
| `ops_room` | Ops Room | **tactical** | scan_wipe→fade | native | #00c9a7 |
| `war_economy` | War Economy | **newsroom** | smash→smash→wipe | native | #e63946 |
| `motion_graphics` | Motion Graphics | mesh | slide | native | #6d5cff |

**native** = fully self-generated animated background (zero stock footage, see below)

---

## Native animated backgrounds

Four moods render a premium self-generated animated background instead of stock b-roll. Set automatically when using the mood — no flag needed.

### `tactical` (ops_room)
Intelligence-briefing aesthetic modelled on operations-room visual language. Seven animated layers:
- Drifting coordinate grid (lat/lon labels)
- SVG radar sweep with arc sector trail + center crosshair + pips
- Continent silhouettes (SVG paths, slow drift)
- Hotspot pulse rings (4 locations)
- Satellite scan gradient sweeping top→bottom
- Dual teletype columns (SITREP / SIGINT feeds)
- HUD overlay (LIVE blink, OPS ROOM // EP.NNN, CLASSIFICATION footer)

### `newsroom` (war_economy)
Economic-warfare newsroom. Four animated layers:
- Animated compound sine sparklines (4 traces)
- Bloomberg-style economic grid
- Halftone dot pattern (CSS radial-gradient, accent-tinted)
- Blinking alert circles + ticker strip

### `network_tech` (tech)
Futuristic tech grid. Four layers:
- Network node graph with hub highlighting and connection arcs
- Matrix hex-rain columns
- Terminal coordinate grid (0x-style labels)
- Blinking cursor prompt

### `financial` (business)
Bloomberg-style financial data environment. Four layers:
- Animated price sparklines
- Data price grid (tickers + prices)
- Scrolling data rows
- Bottom data strip

---

## Fonts (per mood)

Mood determines typography automatically via `@remotion/google-fonts`. No config required.

| Mood | Display font | Mono font |
|---|---|---|
| `ops_room` | Space Grotesk | IBM Plex Mono |
| `war_economy` | Oswald | IBM Plex Mono |
| `cinematic` | Cormorant Garamond | Inter |
| `tech` | Space Mono | IBM Plex Mono |
| `business` | DM Sans | — |
| `motion_graphics` | Manrope | — |
| `mindfulness` | Cormorant Garamond | — |
| default | Space Grotesk | IBM Plex Mono |

---

## Transitions (per mood)

Transitions are picked in a rotating cycle from the mood's `transitions` array. New presentations:

| id | Mood | Description |
|---|---|---|
| `scan_wipe` | ops_room | Left-to-right scan with bright leading edge |
| `smash` | war_economy | Hard cut with brief flash |
| `terminal_wipe` | tech | 16-strip horizontal wipe (staggered) |
| `fade` | any | Standard dissolve |
| `wipe` | any | Left-to-right wipe |
| `slamzoom` | motivational | Scale slam with zoom |

---

## Named blends

Compose moods for in-between aesthetics. Use anywhere a mood id is accepted.

| id | Recipe | Description |
|---|---|---|
| `saas` | `cinematic*0.6+tech*0.4` | Premium SaaS-explainer: filmic base, electric pace |
| `founder` | `cinematic*0.6+motivational*0.4` | Thought-leader with drive |
| `docu` | `cinematic*0.65+mindfulness*0.35` | Slow, weighty documentary |
| `keynote` | `business*0.55+cinematic*0.45` | Data-forward but filmic |
| `geo_intel` | `ops_room*0.7+cinematic*0.3` | Serialized geopolitics: tactical + filmic quality |
| `market_intel` | `war_economy*0.65+business*0.35` | Economic warfare: urgency + data credibility |
| `conflict` | `ops_room*0.5+war_economy*0.5` | Full-spectrum crisis: military + economic |

Custom blends also work: `--mood "cinematic*0.7+tech*0.3"`

---

## Generation quality controls

Two quality mechanisms run automatically on every `content new`. Both are controllable via flags:

### A/B storyboard selection
Two storyboard variants are generated in parallel (Variant A: data-lean, Variant B: narrative tension). Both are QA-scored and the higher-scoring one is used.

- Disabled in `--preview` (cost saving)
- Disable manually: `--no-ab`
- Controlled via tool: `pipeline_generate_post` param `abStoryboard: false`

### Iterative QA loop
Up to 3 QA+revision passes before render. Stops when score ≥ 8/10.

- Default: 3 passes
- Change: `--qa-passes <1-5>`
- Controlled via tool: `pipeline_generate_post` param `maxQaPasses: 1`

---

## B-roll sources

Run `content broll-sources` to see which providers are active. AI video generation is available when provider keys are set (see `.env.example`).

| Provider | env key | Quality | Notes |
|---|---|---|---|
| Pexels | `PEXELS_API_KEY` | stock video | primary source |
| Pixabay | `PIXABAY_API_KEY` | stock video | secondary source |
| Kling v2.6-pro | `KLING_API_KEY` | AI generated | best for abstract |
| Pika v2.2 | `PIKA_API_KEY` or `FAL_API_KEY` | AI generated | fast queue via fal.ai |
| Minimax T2V | `MINIMAX_API_KEY` | AI generated | Hailuo model |
| Luma Dream Machine | `LUMALABS_API_KEY` | AI generated | ray-2 model |

AI providers are tried in cascade order: Kling → Pika → Minimax → Luma. The first successful result is used and cached.

---

## CLI discovery

```sh
content moods                  # list all moods with accent, bgVariant, transitions, blurb
content moods --json           # full JSON (for scripting)
content broll-sources          # show active providers + which keys are missing
content tool tools_moods_list '{}'      # same via tool bridge
content tool tools_broll_sources '{}'   # same via tool bridge
```
