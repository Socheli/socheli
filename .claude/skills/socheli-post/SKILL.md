---
name: socheli-post
description: Take one idea to a finished rendered Socheli post, step by step (idea → script → storyboard → render) with human review between stages. Use when the user wants to create/generate a video post from an idea or topic.
---

# Create a post: idea → rendered video

Prefer the MCP tools on the `socheli` server (`mcp__socheli__*`). CLI fallback:
`pnpm content …` from the repo root.

## Workflow (stepwise draft — preferred, reviewable)

1. **Ground in the brand.** Call `dna_context` with `{channel}` and skim
   `channels_list` if the channel id is unknown. Write everything inside the
   genome's hooks/voice/avoid-list.
2. **Ideas.** `draft_ideas` `{channel, seed, n: 3}` — present the options
   (topic/angle/format/mood) to the user; nothing is saved yet.
3. **Lock the idea.** `draft_set_idea` `{channel, idea: {topic, angle, format,
   rationale, mood?}, seed?}` — this CREATES the draft and returns its `id`.
   Carry that id through every later step.
4. **Script.** `draft_script` `{id, guidance?}` → review hook/beats/narration/cta
   with the user. Hand-edits go through `draft_set_script` `{id, script}`.
   Regenerate with different `guidance` rather than editing blind.
5. **Storyboard.** `draft_storyboard` `{id, guidance?}` → then QA it:
   `tools_qa_storyboard` and fix flagged issues via `tools_revise_storyboard`
   or `draft_set_storyboard`. Optionally `tools_fact_check` claims.
6. **Render.** `draft_render` `{id, voice: true, music: true, broll: true}` —
   LONG-RUNNING: it returns `{status:"started", pid, logPath}` immediately.
   Do not call it twice.
7. **Verify.** Poll `runs_get` `{id}` until `status` is `packaged` (renders take
   minutes). Confirm `videoPath` is set; report it plus the ledger cost. If the
   run stalls, read the returned `logPath`.

## One-shot alternative

- Full pipeline without review stops: `pipeline_generate_post` (long), or CLI
  `pnpm content new "<idea>" --channel <id> [--mood <id>] [--voice] [--preview]`.
- Long-form 16:9: `pipeline_generate_longform` / `pnpm content longform "<topic>"`.
- Inspect any run later: `runs_list`, `runs_get` / `pnpm content list`,
  `pnpm content show <id>`.

## Rules

- One render job at a time per draft; check `runs_get` before re-firing.
- Renders cost real money — confirm with the user before `draft_render` unless
  they already asked for a finished video.
- This skill ends at a rendered, packaged post. Publishing is a separate gated
  flow — use the `socheli-publish` skill.
