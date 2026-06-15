---
name: socheli-publish
description: Publish a finished Socheli run to YouTube/Instagram/TikTok with the proper gates, platform checks and derivatives. Use when the user asks to publish, post, or export a rendered video.
---

# Publish flow (gated)

Publishing is the most gated action in Socheli. Prefer the MCP tools on the
`socheli` server. CLI fallback: `pnpm content publish <id> [--public] [--no-aigc]`.

## Pre-flight (do all of these BEFORE publishing)

1. **The item is actually finished.** `runs_get` `{id}` — status must be
   `packaged` with a `videoPath`. Never publish a draft or a failed render.
2. **Platforms are live.** `publish_platform_status` — reports which targets
   (youtube, instagram, tiktok, host) are configured. Don't attempt a platform
   that isn't; report it as blocked instead.
3. **Derivatives.** If a platform prefers a different aspect:
   `derivatives_available_aspects` `{id}` → `derivatives_make_aspects` `{id}`
   (1:1 + 16:9 from the 9:16 master) and `derivatives_make_thumbnail`
   `{id, atSec}` as needed. Publishing uses the preferred-aspect derivative
   per platform automatically once it exists.

## Publish

- `publish_item` `{id, public: false, aigc: true}` — LONG-RUNNING background
  job; returns `{status:"started", pid, logPath}`. Defaults are the safe ones:
  `public: false` keeps YouTube private; `aigc: true` keeps AI-content labels on.
- **The gate:** only pass `public: true` when the user explicitly approved going
  public. When a channel/mission's `approvalPolicy.publish` is `"gate"`, prepare
  everything (derivatives, captions, bundle) and stop at ready/private — that IS
  the deliverable; a human flips it public.
- Already-published platforms are skipped automatically (idempotent per platform).

## Verify

- Re-read `runs_get` `{id}` — `item.publish[]` records per-platform
  `{platform, status, url}`. Report each as published / processing / skipped /
  blocked-and-why, with URLs.
- Stats later: `publish_pull_stats` `{id}` (views/likes).

## Alternatives & notes

- No live creds for a platform? `publish_export_bundle` `{id}` produces a
  self-contained upload bundle directory for manual posting.
- Some platforms may be routed through the phone-publishing path (an Android
  device posts natively); the same `publish_item` call covers it — the engine
  picks the route.
- Captions/hashtags come from the item's package; regenerate with
  `tools_generate_package` (or `pnpm content package <id>`) before publishing
  if they need work.
