# socheli-phone-agent

Local operator agent that drives the **real social apps on a docked Android**
(via ADB) to **post finished Socheli videos** — Instagram Reels, TikTok, and
YouTube Shorts. It's a publishing *backend*: instead of an approved app + a
public host (which IG Reels and TikTok both gate behind App Review), it pushes
the rendered `.mp4` to the phone and walks the app's create flow the way a human
would. Zero dependencies, runs on the same Mac that renders.

It only ever posts runs you've already **packaged** (QA-gated upstream), one at
a time, at human pace. It's automation of *your* posting — not a spam bot.

## Setup

1. Install platform-tools (`adb`): `brew install android-platform-tools`.
2. On the phone: **Developer options → enable USB debugging.**
3. **MIUI/Xiaomi only (required for taps):** also enable
   **"USB debugging (Security settings)"** in Developer options. Without it ADB
   can read the screen but can't inject taps/typing (`SecurityException:
   INJECT_EVENTS`).
4. Plug in via USB, accept the "Allow USB debugging" prompt.
5. `cp .env.example .env` and (optionally) set `DEVICE_PIN` for unattended
   auto-unlock. Log into Instagram / TikTok / YouTube in the phone apps once.

## Use (standalone)

```bash
node src/run.mjs doctor                          # device + store check
node src/run.mjs test --video clip.mp4 --platform instagram --send   # smoke test
node src/run.mjs publish                          # DRY RUN of all packaged runs
node src/run.mjs publish --send                   # actually post (human-paced)
node src/run.mjs publish --send --platform tiktok --limit 2
node src/run.mjs post --id <runId> --platform instagram --send       # one run, one platform
```

The phone must be **unlocked** during a run (set `DEVICE_PIN` to auto-unlock).
`publish` walks every run with `status: "packaged"` that still has an un-posted
platform, posts it, and records the post on the run's publish ledger.

## Use (via the Socheli pipeline — the easy path)

Set `PHONE_PUBLISH=1` in the **repo root** `.env`. From then on the normal
publish path routes through the phone for the configured platforms — no other
change needed:

```bash
PHONE_PUBLISH=1 pnpm content publish <runId>    # IG + TikTok go via the phone
```

…and the same applies to **autopilot** and the **scheduler** (`content tick`),
since both call `publishItem()`. `PHONE_PLATFORMS=instagram,tiktok,youtube`
controls which platforms the phone handles (default `instagram,tiktok`; YouTube
keeps using the Data API unless you add it here). The dashboard "Connections"
card reads `platformStatus().phone` to show device readiness.

## Scheduled posting (launchd)

`scripts/scheduled-post.sh` + `scripts/com.socheli.phone-agent.plist` post a few
times/day while the phone is docked + unlocked.

```bash
cp scripts/com.socheli.phone-agent.plist ~/Library/LaunchAgents/
launchctl load -w ~/Library/LaunchAgents/com.socheli.phone-agent.plist
```

## How it works

- **Stage:** `adb push` the rendered mp4 into the gallery + a MediaStore scan so
  apps see it immediately (`adb.mjs`).
- **Hand off:** an `ACTION_SEND` share intent (`--eu …STREAM <content-uri>`)
  preloads the video into the app's composer — more robust than navigating a
  gallery picker.
- **Drive:** find the caption field + post button by `resource-id` → `text` →
  `content-desc` (robust to version drift), type the caption, tap post
  (`post.mjs`).
- **Source of truth:** reads `data/runs/*.json` directly and resolves the same
  per-platform caption / title / preferred-aspect file the API path uses
  (`store.mjs` mirrors the engine's `publish-types.ts`).

UI element ids drift across app versions; every step uses ordered candidate
specs and polls, so a moved id degrades to an honest "button not found" rather
than a wrong tap. Instagram is the most exercised flow.
