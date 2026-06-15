# Agent Editor Tools

This repo exposes the video editor through one shared tool registry with two entry points:

- CLI: `pnpm editor ...`
- MCP stdio server: `pnpm editor:mcp`

Both entry points call the same tools in `packages/engine/src/editor-tools.ts`, so Codex, Claude Code, and shell scripts see the same editor surface.

## MCP Setup

Use this command from the repo root:

```json
{
  "mcpServers": {
    "socheli-editor": {
      "command": "pnpm",
      "args": ["editor:mcp"],
      "cwd": "the repo root"
    }
  }
}
```

The server supports standard MCP `initialize`, `tools/list`, and `tools/call` over stdio.

## CLI Examples

List runs:

```sh
pnpm editor list
```

Read the full editor state for a post:

```sh
pnpm editor state claude_20260605080644
```

Clone a run for safe agent edits:

```sh
pnpm editor clone claude_20260605080644 --new-id claude_agent_draft
```

Inspect the rendered video. This returns ffprobe metadata, scene timing, sampled JPEG frames, and a contact sheet path under `data/agent-vision`.

```sh
pnpm editor watch claude_20260605080644 --frames 6
pnpm editor watch claude_20260605080644 --scene 1
pnpm editor frame claude_20260605080644 --time 12.4
```

Watch the entire rendered video as an agent-readable frame stream. This samples the whole MP4 at low FPS, writes every JPEG frame to disk, and creates chunked contact sheets:

```sh
pnpm editor scan-video claude_20260605080644 --sample-fps 2 --width 360 --frames-per-sheet 24
```

For a 45-second video at 2 FPS, this gives about 90 ordered frames plus 4 contact sheets. Increase `--sample-fps` up to 8 when inspecting fast motion, cuts, cursor movement, subtitles, or animation timing.

Analyze audio/video continuity:

```sh
pnpm editor analyze-av claude_20260605080644
```

This returns:

- waveform PNG path
- mean/max audio volume
- silence intervals
- freeze intervals
- black-frame intervals
- detected scene-change timestamps
- ffprobe metadata

Build a full timecoded evidence timeline for model review:

```sh
pnpm editor video-evidence claude_20260605080644 --sample-fps 1 --width 320 --max-ocr-frames 80
```

This is the practical answer to "let the model watch the whole video." It creates one durable artifact with ordered frame paths, contact sheets, AV diagnostics, OCR samples, optional local Whisper word timestamps, pixel metrics, motion deltas, scene summaries, and issue tags for exact ranges to inspect or patch.

Generate the deeper competitor-aware review pack:

```sh
pnpm editor competitive-intel
pnpm editor deep-review claude_20260605080644 --sample-fps 2 --width 360
```

`competitive-intel` returns the sourced market matrix, opportunity scores, unmet jobs, strategic edge, and roadmap without running video analysis.

`deep-review` creates durable review artifacts under `data/agent-reviews/` and `data/agent-vision/`, including the sourced competitor matrix, opportunity scores, strategic gaps, detected issues, frame evidence, diagnostics, and the next executable edit commands.

Compare two renders after an agent edit:

```sh
pnpm editor compare-renders claude_before claude_after --samples 8 --width 360
```

This creates a before/after evidence pack with sampled frames, a contact sheet, timeline deltas, audio/video diagnostic deltas, visual similarity, and a regression verdict.

Review rendered text readability:

```sh
pnpm editor readability claude_20260605080644 --width 360
pnpm editor visual-readability claude_20260605080644 --width 240
pnpm editor ocr-review claude_20260605080644 --width 540
pnpm editor competitive-suite claude_20260605080644 --width 360
pnpm editor suite-autofix claude_20260605080644 --new-id claude_autofix_draft
pnpm editor accept-autofix claude_20260605080644 claude_autofix_draft --width 360
pnpm editor recipe claude_20260605080644 tighten_pacing --new-id claude_tight_draft
```

This scores every scene for text density, words per second, chars per second, line length, text-block count, and mobile reading risk. It also captures representative evidence frames and suggests exact edit commands.

`visual-readability` goes one layer deeper and inspects actual rendered pixels for safe-area and contrast risk. It is dependency-free: ffmpeg extracts raw RGB frames, then the tool measures bright/dark/edge density and unsafe-edge activity.

`ocr-review` checks what text actually appears in representative rendered frames. On macOS it uses the local Vision framework through `packages/engine/scripts/vision-ocr.swift`; if OCR is unavailable, it still writes the frame evidence and reports that OCR could not run.

`competitive-suite` runs the professional regression stack as one scorecard: schema precision, text clarity, creator pacing, visual polish, packaging, agent evidence, and AV continuity.

`suite-autofix` creates a cloned draft and applies conservative suite-driven fixes. It does not mutate the source run. Rerender and compare the draft before accepting it.

`accept-autofix` is the closed-loop gate after rerender. It compares source vs draft, runs `competitive-suite` on both, checks score/gate deltas, flags render regressions, and writes an accept/reject/needs-review report without mutating the source.

`recipe` creates a cloned draft with reusable professional edits. Available recipes are `tighten_pacing`, `make_terminal_clearer`, `raise_retention`, and `fix_audio_ducking`. Each recipe writes a patch report and next commands for rerendering, generating video evidence, running the suite, and acceptance-gating the draft.

Edit nested terminal content:

```sh
pnpm editor terminal-line claude_agent_draft 1 add --line '{"kind":"ok","text":"Root cause found"}'
pnpm editor terminal-line claude_agent_draft 1 update --line-index 0 --line '{"text":"claude src/invoice.ts src/parser.ts"}'
```

Edit any JSON path:

```sh
pnpm editor set claude_agent_draft storyboard.scenes.0.text '"Sharper hook text"'
pnpm editor set claude_agent_draft mix.musicVol 0.65
```

Patch a full component:

```sh
pnpm editor patch-scene claude_agent_draft 4 '{"caption":"Noise vs signal","durationSec":7}'
```

Timeline operations:

```sh
pnpm editor duplicate-scene claude_agent_draft 1
pnpm editor move-scene claude_agent_draft 2 5
pnpm editor split-scene claude_agent_draft 1 3.5
pnpm editor delete-scene claude_agent_draft 3
```

Style and effects:

```sh
pnpm editor style claude_agent_draft 0 '{"accent":"#38bdf8","fontScale":1.1,"transition":"wipe"}'
pnpm editor effect claude_agent_draft 0 grain true
```

Validate and rerender:

```sh
pnpm editor validate claude_agent_draft
pnpm editor rerender claude_agent_draft --broll
```

## Tool Coverage

Current MCP tools:

- `editor_list_items`
- `editor_get_state`
- `editor_clone_item`
- `editor_get_scene`
- `editor_set_path`
- `editor_unset_path`
- `editor_patch_scene`
- `editor_add_scene`
- `editor_delete_scene`
- `editor_duplicate_scene`
- `editor_move_scene`
- `editor_split_scene`
- `editor_terminal_line`
- `editor_set_style`
- `editor_set_effect`
- `editor_watch_video`
- `editor_extract_frame`
- `editor_scan_entire_video`
- `editor_analyze_av`
- `editor_video_evidence`
- `editor_competitive_deep_review`
- `editor_competitive_intel`
- `editor_compare_renders`
- `editor_readability_review`
- `editor_visual_readability_review`
- `editor_ocr_review`
- `editor_competitive_suite`
- `editor_suite_autofix`
- `editor_accept_autofix`
- `editor_apply_recipe`
- `editor_start_rerender`
- `editor_validate`

The broad `editor_set_path` and `editor_patch_scene` tools intentionally expose editor-only fields that are not part of the strict renderer schema yet, such as brightness, contrast, opacity, hue, saturation, lightness, text animation settings, and effect toggles. Validation reports renderer-contract issues without stripping those fields.

## How Models Watch Full Videos

Do not stream raw MP4 bytes through MCP. The useful pattern is:

1. `editor_video_evidence` for the main timecoded video memory.
2. Inspect the generated JSON, contact sheets, and `issueTags`.
3. Use `editor_frame --time ...` for any suspicious timestamp that needs closer inspection.
4. Patch scenes, terminal lines, text, style, or timeline operations.
5. `editor_start_rerender`.
6. `editor_accept_autofix` to prove the revision improved before accepting it.

This gives Codex/Claude a practical full-video perception loop while keeping tool outputs small enough to reason over.
