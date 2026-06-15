---
name: socheli-research
description: Run Socheli's verified deep-research harness (plan → web sweep → fetch → extract → cross-verify → cited report) and deliver findings. Use for trend/algorithm/topic/competitor research questions about content strategy.
---

# Verified research run

Prefer the MCP tools on the `socheli` server. CLI fallback: `pnpm content
research` (synchronous, streams steps to the terminal).

## Workflow

1. **Check the cache first — always.** `research_fresh` `{kind, query, maxAgeH,
   channel?}`. Kinds: `trend | algo | topic | competitor | deep`. Sensible
   maxAgeH: trend 24, algo 72, topic/competitor 168. If `fresh: true`, use the
   cached run's report — zero cost, zero wait.
2. **Start a run.** `research_run` `{query, kind, depth, channel?}` — depth
   `quick` ≈ 3 queries/5 sources, `standard` ≈ 5/10, `deep` ≈ 8/20 (deep also
   synthesizes on the best brain tier). LONG-RUNNING: returns the run `id`
   immediately. You can also pass `maxAgeH` here to make the cache check
   transparent.
3. **Poll.** `research_get` `{id}` until `status` is `done` (or `failed`).
   While running it exposes the live step log.
4. **Report.** Deliver the cited markdown `report`. Distinguish claim statuses:
   `verified` (≥2 sources) vs `single-source` vs `disputed` — never present a
   single-source or disputed claim as fact. `[S1]`-style citations map to the
   run's `sources`.
5. **Browse history.** `research_list` `{kind?, channel?, limit}` for prior runs.

## CLI fallback

```sh
pnpm content research "<query>" [--kind trend|algo|topic|competitor|deep] \
  [--depth quick|standard|deep] [--channel <id>]
```

Runs in the foreground and prints the report when done.

## Rules

- Scope with `channel` whenever the research is for a specific brand — it steers
  the report and scopes the cache.
- Don't start duplicate runs; one `research_run` per question, then poll.
- Findings that should change strategy belong in the genome or plan — hand off
  to `socheli-dna` / `socheli-plan` rather than letting them evaporate.
