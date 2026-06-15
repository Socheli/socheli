# Socheli — Mobile

A real native iOS/Android app (Expo / React Native, SDK 56) that's a **client for the
Socheli platform**. It talks to the same `api.socheli.com` backend as the web dashboard,
SDK, CLI, and MCP server — via a vendored copy of the Socheli SDK.

## What it does

- **Connect** to your workspace with an API key (stored in the device keychain via SecureStore).
- **War Room** — live stats, fleet status, recent content (pull to refresh).
- **Library** — browse all content items.
- **Item detail** — native video playback (`expo-video`), QA/cost, storyboard, script, caption,
  and **publish** to every platform.
- **Fleet** — connected render devices, capabilities, recent jobs.
- **Generate** — dispatch a render job to the capability-matched fleet from your phone.
- **Settings** — workspace, quick links to dashboard/docs/billing, disconnect.

Dark, monochrome, native — matching the web platform's design.

## Run it

This is a **standalone** Expo app (excluded from the pnpm workspace — Expo prefers a hoisted
`node_modules`). Install with its own resolver:

```bash
cd apps/mobile
pnpm install --ignore-workspace --config.node-linker=hoisted   # (or: npm install)
npx expo start
```

Then press `i` (iOS simulator), `a` (Android), or scan the QR with **Expo Go** on your phone.

On first launch, tap **Connect** and enter:
- API URL: `https://api.socheli.com`
- API key: your `SOCHELI_API_KEY` (Dashboard → Settings → API & Developers)

## Build a real installable app

```bash
npm i -g eas-cli && eas login
eas build --platform ios       # or android
```

Bundle id / package: `com.socheli`.

## Architecture

The app is a **credentialed API client** (like the CLI): the API key authenticates every
request to the Socheli API. The heavy pipeline runs on your render fleet — the phone only
displays state and dispatches jobs. Control is the API; media streams from `media.socheli.com`.
