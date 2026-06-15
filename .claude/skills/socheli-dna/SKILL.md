---
name: socheli-dna
description: Read and evolve a channel's Brand Genome (learned hooks/topics/formats/voice traits), and work the mutation approval queue. Use for "what has the brand learned", genome evolution, approving/rejecting DNA mutations, or pinning traits.
---

# Brand Genome (DNA)

The genome is the channel's learned, versioned identity: weighted traits
(`hooks/topics/formats/visual/voice`), an audience model, per-platform
playbooks, an evolution history, and a pending-mutation approval queue. Stored
at `data/dna/<channel>.json`. Prefer the MCP tools on the `socheli` server.

## Read

- `dna_get` `{channel}` — the full genome (seeds itself from the channel's
  static ChannelDNA + learnings on first read).
- `dna_context` `{channel}` — the compact ≤60-line markdown block the engine
  injects into ideation/script prompts. Use this to ground ANY creative work.
- `dna_history` `{channel, limit}` — applied mutations, newest first, each with
  kind (auto/approved/manual), cause and evidence.

CLI: `pnpm content dna <channel>` prints the context block + version summary.

## Evolve (gated by design)

- `dna_evolve` `{channel, policy: "gate" | "auto"}` — LONG-RUNNING: gathers
  learnings, analytics scorecards, fresh research and QA verdicts, then a smart
  brain proposes evidence-backed mutations.
  - `policy: "gate"` (default) — EVERY proposal goes to the pending queue.
  - `policy: "auto"` — proposals with confidence ≥ 0.8 on UNLOCKED paths apply
    immediately; the rest queue. Only use auto when the user explicitly wants it.
- CLI: `pnpm content dna evolve <channel> [--auto]` (foreground, prints results).

**What gating means:** nothing mutates the brand's identity without either high
machine confidence on an unlocked path (auto) or explicit human approval. Locks
(`dna_lock_trait`) pin a trait path so auto-evolution can never touch it.

## Approval queue

1. `dna_pending_list` `{channel}` — id, path, proposed change, rationale,
   confidence. Present these with your own read on the evidence.
2. `dna_mutation_approve` `{channel, id}` — applies the patch, logs it to the
   evolution history, bumps the genome version.
3. `dna_mutation_reject` `{channel, id}` — discards; traits untouched.

CLI: `pnpm content dna pending <channel>` / `pnpm content dna approve <channel> <id>`.

## Manual edits

- `dna_set_trait` `{channel, path, value, weight}` — upsert a trait by hand
  (paths: `traits.hooks|topics|formats|visual|voice`, `audienceModel.summary`,
  `platformPlaybooks`). Logged as a manual mutation; works even on locked paths.
- `dna_lock_trait` `{channel, path, locked}` — pin/unpin a path against
  auto-evolution.

## Rules

- Never approve a mutation without showing the user its rationale + confidence.
- Propose with evidence; the gate exists for the human — don't route around it.
