# Real Frame-by-Frame Editor — Vision + Structure + Time Control (Phases B & C)

The goal: turn the engine into a real video editor where both a human (UI) and the
agent (Soli) can SEE and CONTROL a video frame-by-frame, grounded in consistent
per-frame vision + transcript + music understanding, exposed on every surface.

Derived from a full read-only code map. Reuse-first; cite real symbols. Auto-propagation
confirmed: a tool added to `packages/engine/src/tools/registry.ts` is AUTOMATICALLY on
MCP (`harness/mcp-stdio.ts asMcpTools`), HTTP API, SDK, CLI (`content tool <name>`), and
Soli (`apps/dashboard/lib/agent/graph.ts getToolManifest`). So Phase C surface-wiring is
mostly free — the work is the engine tools (B) + the UI (C).

---

## PHASE B — per-frame vision + frame-indexed structure + time control

### B1. Dense per-frame VISION (consistent, indexed)
Today vision is shot-level keyframe only (`understanding-vision.ts describeShots`, stored
`item.understanding.perShot`). Add a DENSE grid:
- New schema `FrameVision { frameIndex, atSec, description?, subjects?, motionScore?, quality?, brightness?, onScreenText?, confidence? }` and `DenseFrameVision { sampleFps, frameCount, startSec, endSec, frames[] }` on `Understanding`.
- New `packages/engine/src/dense-vision.ts`: extend `denseFrameScan` (editor-tools.ts:204) to sample at N fps → batch frames through `describeFrames` (understanding-vision.ts) for descriptions/subjects/text, and reuse the cheap per-frame metrics (`analyzeFramePixels`/`perRegionRms`) for motion/quality/brightness. Persist indexed by frameIndex for O(1) lookup.
- Detached worker `understanding-run-dense.ts`; tool `editor_understand_dense_vision { id, sampleFps:0.5|1|2 }` (kind long).
- Bloat control: ~500B/frame; at 1fps a 2-min clip ≈ 60KB. Fine. Optionally delta-encode.

### B2. Frame-indexed STRUCTURE (the timeline already exists; make it frame-addressable)
`Timeline/Track/Clip` (schemas/index.ts) store seconds + `timeline.fps`. Add frame units so
every frame is addressable:
- Clip: optional `inFrame/outFrame/startFrame` (computed from `sec*fps`).
- Timeline: optional `frameMetadata` (clipId → per-frame index) lazily built.
- New `creative/frame-index.ts`: `buildFrameIndex(id)`, `queryFrameOnTimeline(id, atFrame|atSec)`, `queryFrameRange(id, start, end)`, `seekTimelineFrame(id, frameIndex)` (returns the clip + source window + vision + words + music at that frame).

### B3. Frame-precise CONTROL (edit ops)
New `creative/frame-edit.ts`: `trimClipByFrames`, `splitClipAtFrame` (razor), `moveClipByFrames` — all frame-exact, locked-safe, idempotent, validate against schema min-duration.

### B4. Cross-modal ALIGNMENT at a frame
- `creative/frame-transcript.ts wordsInFrameRange(id, start, end)` — transcript words mapped through the clip source windows to timeline frames.
- `creative/frame-music.ts queryMusicInFrameRange(id, start, end)` — beats/sections/energy (from `understanding.music` + `musicBeatFrames`) inside a frame range. (Shares the beat grid with the beat-sync pillar.)

### B5. New engine tools (timeline-tools.ts / understanding-tools.ts) — all auto-propagate
- `editor_understand_dense_vision` (long) — build the dense grid.
- `timeline_frame_index` (mutate) — build/persist the index.
- `timeline_query_frame` / `timeline_seek_frame` (read) — "what's at frame N / sec T": clip, source window, vision, words, music.
- `timeline_frame_range` (read) — clips+metadata over [start,end] for a scrubber.
- `timeline_words_at_frame` (read) — transcript words in a frame range.
- `timeline_music_context` (read) — beats/sections/energy in a frame range.
- `timeline_trim_clip_frame` / `timeline_split_clip_frame` (mutate) — frame-exact edits.

---

## PHASE C — editor UI + Soli chat-to-edit (surfaces are auto-wired)

### C1. New `/editor/[id]` route (apps/dashboard/app/editor/)
- `page.tsx` (server: resolve tenant, load ingested item) → `Editor.tsx` (client layout).
- `VideoScrubber.tsx` — frame scrubber over the rendered/source video; on seek calls `timeline_seek_frame`.
- `TimelineView.tsx` — interactive tracks/clips from `timeline_get` + `timeline_frame_index`; click-to-jump, drag-to-trim → `timeline_trim_clip_frame`, razor → `timeline_split_clip_frame`.
- `FrameInspector.tsx` — at-frame panel: vision (description/subjects/motion/quality), transcript words, music beats/sections — from `timeline_seek_frame` + `timeline_words_at_frame` + `timeline_music_context`.
- `EditChatPanel.tsx` — chat-to-edit; routes to Soli / `creative/edit-router.ts` → EditPlan → approval card → apply.
- Reuse: `apps/dashboard/app/VideoPlayer.tsx` (extend with frame seek), the studio API (`/api/studio/[id]`), the copilot tool path.

### C2. Soli chat-to-edit
Soli already binds all registry tools (`graph.ts`). The new frame tools appear automatically.
Add a few intent-level Soli tools (`lib/agent/edit-tools.ts`) that compose them: "cut the dead
air" → query frames → trim; "make a reel of the key moments" → dense-vision filter → keep; "cut
on the drop" → `timeline_music_context` → split on the beat. Add `FrameInspectorBlock`/
`TimelineBlock` renderers to `lib/agent/tool-result-viz.ts`.

### C3. Surfaces (free)
MCP/CLI/SDK/API/Soli get every B-tool automatically via the registry. Only the dashboard UI
needs hand-built components (C1) + the result-viz blocks (C2). Verify each tool over MCP/CLI
first, then build the UI on stable tools.

---

## BUILD ORDER
1. Schema additions (FrameVision/DenseFrameVision/Clip frames/Timeline.frameMetadata) — one commit.
2. Engine modules + tools (dense-vision, frame-index, frame-edit, frame-transcript, frame-music) — verify over CLI/MCP.
3. Dashboard `/editor` UI + result-viz blocks.
4. Soli intent tools + chat-to-edit wiring.

Biggest gaps: dense vision cost (opt-in + cache), lazy frame index (build async after timeline),
no existing frame-scrubber/timeline UI (build new on VideoPlayer), EditPlan approval UX (reuse
review.ts scorecard + gates).
