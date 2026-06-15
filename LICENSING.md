# Licensing

Socheli is **open core**. The product engine is copyleft; the things you
integrate against are permissive.

## AGPL-3.0 (copyleft) — the product

These are licensed under the **GNU Affero General Public License v3.0**
(see [`LICENSE`](./LICENSE)):

- `packages/engine` — the pipeline, brain, render, publisher, tool registry
- `apps/dashboard` — the platform UI + copilot
- `packages/remotion` — the video compositions
- everything else not listed below

If you run a modified version of these as a network service, the AGPL requires
you to offer your users the corresponding source of your modifications. This
keeps the engine open for everyone — you can self-host, fork, and modify freely;
you just can't take the product closed and rent it back.

## MIT (permissive) — the things you build with

These are licensed under the **MIT License** (see each package's `LICENSE`),
so you can embed them in any project, including closed-source ones:

- `packages/cli` — the `socheli` command line
- `packages/sdk` — the typed TypeScript client
- `packages/mcp` — the Model Context Protocol server
- `packages/api` — the HTTP API client/server package
- `packages/schemas` — the shared zod schemas (`@os/schemas`)
- `packages/tokens` — the design tokens
- `apps/mobile` — the Expo/React Native app

These four packages are also published to npm under the `@socheli` scope.

## Why this split

The clients, SDK, and schemas are MIT so the ecosystem can build on Socheli with
zero friction. The engine and dashboard are AGPL so a SaaS provider can't take
the work closed-source — the spirit of the project is **own your fleet**, not
rent it.

Questions: contact@socheli.com
