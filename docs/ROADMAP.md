# Socheli Pro-Editor Roadmap

> Socheli becomes the only tool that generates a premium faceless short end-to-end AND lets you finish it in a pro-grade editor that rivals CapCut, then publishes and learns from it — closing a loop generic editors and generic schedulers can't. The wedge is the closed feedback loop (own creation + publish + analytics), plus a Remotion-native editor that gives keyframe motion, real per-clip trimming, true auto-captions/auto-broll/auto-ducking, and reliable multi-platform AIGC-compliant publishing. We win on velocity (one idea to finished, on-brand, beat-synced post in minutes) and on the learning moat, not on having every desktop-NLE feature.

## Pillars
- Create — editor + canvas + generation quality (keyframes, trimming, captions, audio, on-canvas manipulation, auto-edit)
- Publish — reliable AIGC-compliant multi-platform posting, scheduling, per-platform metadata, derivatives
- Grow — unified analytics, retention metrics, trend/competitor intel, A/B hooks, learning loop back into the brain
- Foundation — cross-cutting infra: aspect-ratio/dimension flexibility, keyframe data model, editor file decomposition, waveform/proxy performance, asset library

## Backlog

| ID | Pri | Eff | Pillar | Title | Files |
|---|---|---|---|---|---|
| F1 | P0 | L | Foundation | Keyframe data model in schema + Remotion interpolator | packages/schemas/src/index.ts, packages/remotion/src/Post.tsx, packages/remotion/src/lib/motion.ts |
| F2 | P1 | L | Foundation | Aspect-ratio / dimension flexibility (remove hardcoded 1080x1920) | packages/schemas/src/index.ts, packages/remotion/src/Root.tsx, packages/remotion/src/Post.tsx |
| F3 | P0 | M | Foundation | Real audio waveform peaks on timeline lanes | apps/dashboard/app/api/waveform/route.ts, apps/dashboard/app/post/[id]/edit/page.tsx, packages/engine/src/media.ts |
| F4 | P1 | M | Foundation | Decompose the 1189-line editor page into modules | apps/dashboard/app/post/[id]/edit/page.tsx, apps/dashboard/app/post/[id]/edit/ |
| C1 | P0 | M | Create | Clip in/out trimming and ripple delete on the timeline | apps/dashboard/app/post/[id]/edit/page.tsx, packages/schemas/src/index.ts |
| C2 | P0 | L | Create | Keyframe editor UI (Ken Burns / pan-zoom on canvas) | apps/dashboard/app/post/[id]/edit/page.tsx, packages/remotion/src/Post.tsx, packages/schemas/src/index.ts |
| C3 | P0 | M | Create | Auto-captions as a first-class editable karaoke track | apps/dashboard/app/post/[id]/edit/page.tsx, packages/remotion/src/Post.tsx, packages/schemas/src/index.ts |
| C4 | P0 | M | Create | Automatic music ducking under voice (sidechain) in the mixer | apps/dashboard/app/post/[id]/edit/page.tsx, packages/engine/src/media.ts, packages/schemas/src/index.ts |
| C5 | P1 | L | Create | On-canvas direct manipulation for all elements (8-handle box + alignment guides + safe zones) | apps/dashboard/app/post/[id]/edit/page.tsx, packages/schemas/src/index.ts |
| C6 | P1 | M | Create | Transition duration + easing controls (de-hardcode TR frames) | packages/schemas/src/index.ts, packages/remotion/src/Post.tsx, apps/dashboard/app/post/[id]/edit/page.tsx |
| C7 | P1 | M | Create | Beat detection markers + snap-cuts-to-beat | apps/dashboard/app/post/[id]/edit/page.tsx, packages/engine/src/media.ts, packages/remotion/src/Post.tsx |
| C8 | P1 | M | Create | Expose the 8 unedited scene types in the editor | apps/dashboard/app/post/[id]/edit/page.tsx, packages/schemas/src/index.ts |
| C9 | P2 | M | Create | Effect intensity sliders + per-scene color grade controls | apps/dashboard/app/post/[id]/edit/page.tsx, packages/remotion/src/Post.tsx, packages/remotion/src/lib/grade.tsx |
| C10 | P1 | M | Create | One-click full auto-edit pass in the editor | apps/dashboard/app/post/[id]/edit/page.tsx, packages/engine/src/editor-tools.ts, packages/engine/src/rerender.ts |
| C11 | P2 | L | Create | Layers panel + z-order + lock/hide per element | packages/schemas/src/index.ts, packages/remotion/src/scenes.tsx, apps/dashboard/app/post/[id]/edit/page.tsx |
| C12 | P2 | M | Create | In-editor asset/b-roll browser with previews | apps/dashboard/app/post/[id]/edit/page.tsx, apps/dashboard/app/api/broll/route.ts, packages/engine/src/broll.ts |
| C13 | P2 | S | Create | Comprehensive keyboard shortcut overlay + missing pro shortcuts | apps/dashboard/app/post/[id]/edit/page.tsx |
| P1 | P0 | M | Publish | TikTok AIGC + branded-content compliance guardrails at publish | packages/engine/src/tiktok.ts, packages/engine/src/publisher.ts, packages/engine/src/instagram.ts |
| P2 | P0 | M | Publish | Publish reliability: status polling, retries, token-expiry alerts | packages/engine/src/publisher.ts, packages/engine/src/instagram.ts, packages/engine/src/tiktok.ts |
| P3 | P1 | M | Publish | Per-platform metadata composer with non-destructive overrides | apps/dashboard/app/post/[id]/PublishPanel.tsx, packages/engine/src/stages.ts, packages/engine/src/publish-types.ts |
| P4 | P1 | S | Publish | TikTok sandbox/unaudited-client state surfacing + rate-limit awareness | packages/engine/src/tiktok.ts, packages/engine/src/publisher.ts, apps/dashboard/app/post/[id]/PublishPanel.tsx |
| P5 | P1 | L | Publish | Visual content calendar with drag-reschedule + grid preview | apps/dashboard/app/autopilot/page.tsx, apps/dashboard/app/queue/page.tsx, apps/dashboard/app/api/schedule/route.ts |
| P6 | P2 | S | Publish | Aspect derivatives wired to per-platform publish | packages/engine/src/publisher.ts, packages/engine/src/derivatives.ts, apps/dashboard/app/post/[id]/PublishPanel.tsx |
| G1 | P0 | M | Grow | Instagram + TikTok analytics ingestion into the learning loop | packages/engine/src/instagram.ts, packages/engine/src/tiktok.ts, packages/engine/src/publisher.ts |
| G2 | P0 | L | Grow | Unified cross-platform analytics dashboard with retention metrics | apps/dashboard/app/analytics/page.tsx, apps/dashboard/app/api/analytics/route.ts, packages/engine/src/publisher.ts |
| G3 | P1 | L | Grow | Hook A/B testing loop tied to the editor | packages/engine/src/stages.ts, packages/engine/src/run.ts, apps/dashboard/app/post/[id]/edit/page.tsx |
| G4 | P1 | M | Grow | Trending-sound + competitor-winner intel feeding generation | packages/engine/src/competitive-intel.ts, packages/engine/src/stages.ts, apps/dashboard/app/concepts/ConceptBoard.tsx |
| G5 | P2 | M | Grow | Channel performance scorecard | apps/dashboard/app/channels/page.tsx, packages/engine/src/learnings.ts, apps/dashboard/app/api/analytics/route.ts |
| G6 | P2 | S | Grow | Auto title/hashtag generation surfaced + first-comment hashtags | apps/dashboard/app/post/[id]/PublishPanel.tsx, packages/engine/src/stages.ts, packages/engine/src/publisher.ts |

## Details
### F1 — Keyframe data model in schema + Remotion interpolator  (P0/L, Foundation)

Add a generic keyframe track to the scene style schema: keyframes?: { prop: 'x'|'y'|'scale'|'rotation'|'opacity', points: {t:number(0-1), v:number, ease:'linear'|'easeInOut'|'hold'}[] }[]. Build a resolveKf(frame) helper in Post.tsx that interpolates each property over the scene's frame span using Remotion interpolate + Easing, falling back to the existing static style.x/y/rotation/scale when no keyframes exist. This is the single biggest editor gap (even CapCut free has keyframes) and is the substrate every motion feature below depends on.

**Files:** packages/schemas/src/index.ts, packages/remotion/src/Post.tsx, packages/remotion/src/lib/motion.ts

**Acceptance:** A scene with two x/scale keyframes animates smoothly in the live Player and in a final render, and a scene with none renders identically to today.

### F2 — Aspect-ratio / dimension flexibility (remove hardcoded 1080x1920)  (P1/L, Foundation)

Replace the z.literal(1080)/z.literal(1920) in Storyboard with width/height numbers defaulting to 1080x1920, plumb dimensions through Root.tsx Composition, Post.tsx useVideoConfig consumers, and the editor stage measurement. Add an aspect switcher (9:16 / 1:1 / 16:9) that reflows scene safe-zones. Unlocks magic-resize repurposing (Grow) and removes a structural ceiling.

**Files:** packages/schemas/src/index.ts, packages/remotion/src/Root.tsx, packages/remotion/src/Post.tsx, apps/dashboard/app/post/[id]/edit/page.tsx

**Acceptance:** Switching aspect to 1:1 in the editor re-lays out the canvas and a render produces a correct 1080x1080 MP4.

### F3 — Real audio waveform peaks on timeline lanes  (P0/M, Foundation)

Replace the placeholder waveform div in the three audio lanes with real peak data. Add an /api/waveform route that decodes music/voice/sfx audio (ffmpeg/audiowaveform or web-audio offline) into a downsampled peaks JSON, cached per item; render peaks as an SVG/canvas in each lane. Prerequisite for beat-sync, manual cut-to-beat, ducking visualization, and trusting audio edits.

**Files:** apps/dashboard/app/api/waveform/route.ts, apps/dashboard/app/post/[id]/edit/page.tsx, packages/engine/src/media.ts

**Acceptance:** Each audio lane shows accurate amplitude peaks aligned to the timeline, loaded from a cached peaks file.

### F4 — Decompose the 1189-line editor page into modules  (P1/M, Foundation)

Extract the monolithic edit/page.tsx into a hooks + panels structure (useEditorState/history, useKeyboard, Timeline, AudioLanes, InspectorTabs, CanvasOverlay) under edit/. Pure refactor with no behavior change; required before keyframe UI, layers panel, and multi-select can be added without the file becoming unmaintainable.

**Files:** apps/dashboard/app/post/[id]/edit/page.tsx, apps/dashboard/app/post/[id]/edit/

**Acceptance:** Editor behaves identically after refactor; page.tsx is under ~300 lines and imports extracted components/hooks.

### C1 — Clip in/out trimming and ripple delete on the timeline  (P0/M, Create)

Add edge-drag trimming to scene blocks (drag head/tail to set in/out within the scene's source span) and ripple delete (Shift+Del removes a scene and auto-collapses downstream). Today scenes only have duration/speed and razor/stitch; frame-precise edge trim with snapping is the single most-used pro edit op and is missing. Add snapping to playhead and adjacent edges.

**Files:** apps/dashboard/app/post/[id]/edit/page.tsx, packages/schemas/src/index.ts

**Acceptance:** Dragging a scene's tail shortens it with a live frame readout and snapping; Shift+Del removes a scene and closes the gap.

### C2 — Keyframe editor UI (Ken Burns / pan-zoom on canvas)  (P0/L, Create)

On top of F1, add a per-scene keyframe lane and on-canvas keyframe authoring: scrub the playhead, move/scale the element on canvas, hit 'add keyframe' to record x/y/scale/rotation/opacity at that time; a small ease toggle per point. Ship a one-click 'Ken Burns / auto-zoom' preset that drops two keyframes. This makes animated pans/punch-ins — table stakes for premium short-form — authorable.

**Files:** apps/dashboard/app/post/[id]/edit/page.tsx, packages/remotion/src/Post.tsx, packages/schemas/src/index.ts

**Acceptance:** User sets two scale keyframes on a scene and the preview + render show a smooth eased zoom; the Ken Burns preset works in one click.

### C3 — Auto-captions as a first-class editable karaoke track  (P0/M, Create)

The pipeline already produces word-level WordCue[] and the editor has a subtitles panel; close the gap by making captions editable on the timeline: fix a mistranscribed word, retime a word, and toggle per-word keyword emphasis (color/scale). Add named presets (Hormozi all-caps + yellow keyword, TikTok classic, glow) mapped to existing render styling. Add a caption safe-zone overlay on the canvas.

**Files:** apps/dashboard/app/post/[id]/edit/page.tsx, packages/remotion/src/Post.tsx, packages/schemas/src/index.ts

**Acceptance:** User edits a wrong caption word and marks a keyword; the change persists, re-renders correctly, and a Hormozi preset is applied in one click.

### C4 — Automatic music ducking under voice (sidechain) in the mixer  (P0/M, Create)

duckMusic() exists in the engine but there is no editor control or guaranteed default. Add an 'auto-duck music under voice' toggle (default on) with duck-amount/attack/release, driven by the voice envelope/word cues, applied at render via the existing ducking path and previewed by lowering music gain during voice spans. Highest-value audio feature for a VO-driven faceless tool.

**Files:** apps/dashboard/app/post/[id]/edit/page.tsx, packages/engine/src/media.ts, packages/schemas/src/index.ts, packages/remotion/src/Post.tsx

**Acceptance:** With auto-duck on, music audibly drops under narration in both preview and render with adjustable depth.

### C5 — On-canvas direct manipulation for all elements (8-handle box + alignment guides + safe zones)  (P1/L, Create)

Extend the existing on-canvas text move/scale to a full bounding box: 8 resize handles, Shift=aspect-lock, Alt=from-center, rotation handle with 15-degree snap, smart alignment guides to canvas center/edges and 1px/10px arrow nudge, plus toggleable TikTok/Reels/Shorts safe-zone overlays. Brings the canvas to Canva/Figma direct-manipulation parity for the vertical use case.

**Files:** apps/dashboard/app/post/[id]/edit/page.tsx, packages/schemas/src/index.ts

**Acceptance:** Any element shows an 8-handle box with aspect-lock, rotation snap, alignment snap lines, and safe-zone overlays toggle on.

### C6 — Transition duration + easing controls (de-hardcode TR frames)  (P1/M, Create)

Transitions are 4 presets with a hardcoded 9-frame overlap and no timing control. Add per-cut transition duration and an easing picker in schema + the style panel, and consume them in Post.tsx's TransitionSeries instead of the constant TR. Add dip-to-color and zoom transitions.

**Files:** packages/schemas/src/index.ts, packages/remotion/src/Post.tsx, apps/dashboard/app/post/[id]/edit/page.tsx

**Acceptance:** User sets a 20-frame eased cross-dissolve on one cut and it renders at that length while other cuts keep defaults.

### C7 — Beat detection markers + snap-cuts-to-beat  (P1/M, Create)

musicBeatFrames() already analyzes beats; surface beat markers on the timeline (over the F3 waveform) and let scene boundaries / transitions / razor cuts snap to the nearest beat. Add a one-click 'sync scene starts to beats' that nudges scene durations to land cuts on beats. Beat-synced cutting is a core 'professionally edited' signal.

**Files:** apps/dashboard/app/post/[id]/edit/page.tsx, packages/engine/src/media.ts, packages/remotion/src/Post.tsx

**Acceptance:** Beat markers appear on the timeline and cuts snap to them; 'sync to beats' lands scene boundaries on beat frames.

### C8 — Expose the 8 unedited scene types in the editor  (P1/M, Create)

The renderer supports 15 scene types but the editor only exposes 7. Add inspector field UIs and the add-scene menu entries for big_number, quote, image_focus, grid, chart, diagram, timeline, map so users stop needing JSON edits or API bypass.

**Files:** apps/dashboard/app/post/[id]/edit/page.tsx, packages/schemas/src/index.ts

**Acceptance:** All 15 scene types can be added and have their type-specific fields edited in the inspector.

### C9 — Effect intensity sliders + per-scene color grade controls  (P2/M, Create)

Effects are boolean toggles (grain/vignette/blur/etc.) and the render-side ColorGrade/FilmGrain/LightLeak have no editor control. Add intensity sliders (grain amount, blur radius, vignette strength) and wire the existing HSL/brightness/contrast sliders into the render grade pipeline per scene with keyframe support (via F1).

**Files:** apps/dashboard/app/post/[id]/edit/page.tsx, packages/remotion/src/Post.tsx, packages/remotion/src/lib/grade.tsx, packages/schemas/src/index.ts

**Acceptance:** Adjusting grain intensity on a scene visibly changes grain density in preview and render.

### C10 — One-click full auto-edit pass in the editor  (P1/M, Create)

Wire a single 'Auto-edit' button that orchestrates existing engine capabilities on the current storyboard: auto-captions on, auto-duck on (C4), Ken Burns/punch-in on emphasis scenes (C2), beat-snapped cuts (C7), and contextual b-roll (already in resolveBroll). Matches Submagic/InVideo's one-pass expectation and showcases Socheli's orchestration edge.

**Files:** apps/dashboard/app/post/[id]/edit/page.tsx, packages/engine/src/editor-tools.ts, packages/engine/src/rerender.ts

**Acceptance:** Clicking Auto-edit applies captions, ducking, zoom-on-emphasis, and beat-snapping in one action producing a near-final edit.

### C11 — Layers panel + z-order + lock/hide per element  (P2/L, Create)

Introduce a per-scene element list (text, b-roll, overlays) with reorderable z-index, visibility toggle, and lock. Requires a small multi-element model in the scene schema beyond the single primary text. Needed once scenes hold overlapping elements (lower-thirds, watermark, stickers).

**Files:** packages/schemas/src/index.ts, packages/remotion/src/scenes.tsx, apps/dashboard/app/post/[id]/edit/page.tsx

**Acceptance:** A scene with two elements shows them in a layers panel where reorder, hide, and lock affect the canvas.

### C12 — In-editor asset/b-roll browser with previews  (P2/M, Create)

b-roll today is a free-text query resolved only at render; add a searchable in-editor browser (Pexels stock + generated images via existing broll.ts) that shows thumbnails and lets the user pick a specific clip per scene, plus an SFX library. Closes the 'never leave the app' gap with CapCut.

**Files:** apps/dashboard/app/post/[id]/edit/page.tsx, apps/dashboard/app/api/broll/route.ts, packages/engine/src/broll.ts

**Acceptance:** User searches b-roll, sees thumbnails, and assigns a chosen clip to a scene without re-rendering to preview the choice.

### C13 — Comprehensive keyboard shortcut overlay + missing pro shortcuts  (P2/S, Create)

Editor already has ~25 shortcuts; add the remaining pro muscle-memory (JKL shuttle, I/O in/out, ripple-delete Shift+Del, M markers) and a discoverable shortcut cheat-sheet overlay. Cheap velocity win.

**Files:** apps/dashboard/app/post/[id]/edit/page.tsx

**Acceptance:** JKL shuttle and I/O in/out work and a '?' overlay lists all shortcuts.

### P1 — TikTok AIGC + branded-content compliance guardrails at publish  (P0/M, Publish)

Socheli publishes AI-generated faceless video, so TikTok's AIGC label is policy-mandatory and missing it risks takedowns/shadowbans. Add publish-time enforcement: set TikTok AIGC flag by default, block publish if commercial/branded toggle is on without a disclosure choice, plumb YouTube altered/synthetic-content + madeForKids and IG branded-content flags through the composer and platform clients.

**Files:** packages/engine/src/tiktok.ts, packages/engine/src/publisher.ts, packages/engine/src/instagram.ts, apps/dashboard/app/post/[id]/PublishPanel.tsx, packages/engine/src/publish-types.ts

**Acceptance:** Every TikTok post carries the AIGC flag and publish is blocked with a clear message when a required disclosure is missing.

### P2 — Publish reliability: status polling, retries, token-expiry alerts  (P0/M, Publish)

Direct posting fails in practice (token expiry, spec rejection, processing errors). Add an async publish pipeline that polls IG container / TikTok status, auto-retries transient failures, records a per-post audit log, and surfaces actionable errors + per-channel token-health/reconnect prompts in the dashboard. Trustworthy delivery is the #1 reason creators pay over manual posting.

**Files:** packages/engine/src/publisher.ts, packages/engine/src/instagram.ts, packages/engine/src/tiktok.ts, apps/dashboard/app/api/publish/route.ts, apps/dashboard/app/autopilot/page.tsx

**Acceptance:** A simulated transient failure auto-retries and an expired token shows a reconnect prompt instead of a silent failure.

### P3 — Per-platform metadata composer with non-destructive overrides  (P1/M, Publish)

packagePost() already tailors captions per platform; surface an editable composer in the dashboard with per-platform overrides (YouTube title/desc/tags/#Shorts/madeForKids; TikTok caption/privacy/duet-stitch toggles; IG caption/cover/collaborators) where editing one platform never clobbers the others, plus per-platform cover-frame selection from the timeline.

**Files:** apps/dashboard/app/post/[id]/PublishPanel.tsx, packages/engine/src/stages.ts, packages/engine/src/publish-types.ts, packages/engine/src/publisher.ts

**Acceptance:** User overrides the TikTok caption and IG cover independently and each platform publishes with its own metadata.

### P4 — TikTok sandbox/unaudited-client state surfacing + rate-limit awareness  (P1/S, Publish)

Make the TikTok audit lifecycle (unaudited = SELF_ONLY/private up to 5 users) and per-platform daily caps (IG 100/24h, TikTok ~15, YouTube quota) explicit in the UI: show current audit state, force private when unaudited, and queue/warn before exceeding documented limits instead of hitting silent API rejections.

**Files:** packages/engine/src/tiktok.ts, packages/engine/src/publisher.ts, apps/dashboard/app/post/[id]/PublishPanel.tsx, packages/engine/src/schedule.ts

**Acceptance:** An unaudited TikTok account shows a private-only badge and a post that would exceed a daily cap is queued with a warning.

### P5 — Visual content calendar with drag-reschedule + grid preview  (P1/L, Publish)

schedule.json + scheduler exist but the dashboard only shows status/cadence. Build a month/week calendar that spans concepts→drafts→rendered→scheduled→published, drag-to-reschedule, and a TikTok/IG-style feed grid preview, tied into /concepts and /queue. Scheduling UX is half the 'Publish' promise.

**Files:** apps/dashboard/app/autopilot/page.tsx, apps/dashboard/app/queue/page.tsx, apps/dashboard/app/api/schedule/route.ts, packages/engine/src/schedule.ts

**Acceptance:** User drags a scheduled post to a new day/time on a calendar and the schedule.json updates and fires at the new time.

### P6 — Aspect derivatives wired to per-platform publish  (P2/S, Publish)

derivatives.ts already makes 1:1 and 16:9 crops; let the publisher send the right derivative per destination (16:9 to YouTube landscape, 1:1 to IG feed) instead of the 9:16 master everywhere, and expose the choice in the composer. Leverages existing code for a real repurposing win once F2 lands for true reframes.

**Files:** packages/engine/src/publisher.ts, packages/engine/src/derivatives.ts, apps/dashboard/app/post/[id]/PublishPanel.tsx

**Acceptance:** Publishing to a landscape destination uploads the 16:9 derivative automatically.

### G1 — Instagram + TikTok analytics ingestion into the learning loop  (P0/M, Grow)

pullStats() only reads YouTube viewCount/likeCount, so the learning loop is blind to IG/TikTok. Add IG Graph API insights (views, reach, saves, avg watch) and TikTok analytics ingestion, feed them into recordPerformance()/learnings.json so the brain optimizes for all three platforms. Without this, two-thirds of the moat's feedback is missing.

**Files:** packages/engine/src/instagram.ts, packages/engine/src/tiktok.ts, packages/engine/src/publisher.ts, packages/engine/src/learnings.ts

**Acceptance:** An IG and a TikTok post each pull their metrics and produce a win/avoid learning entry.

### G2 — Unified cross-platform analytics dashboard with retention metrics  (P0/L, Grow)

Build a dashboard view that aggregates per-post metrics from all three platforms (views, avg view duration, saves, shares, follower delta) and surfaces the short-form-critical retention signals: 3-second hook retention, swipe-away rate, and the per-second drop-off curve where available. This is the foundation of 'Grow' that creators won't switch three native apps to get.

**Files:** apps/dashboard/app/analytics/page.tsx, apps/dashboard/app/api/analytics/route.ts, packages/engine/src/publisher.ts, packages/engine/src/learnings.ts

**Acceptance:** One dashboard shows each post's metrics across platforms side by side with a hook-retention indicator.

### G3 — Hook A/B testing loop tied to the editor  (P1/L, Grow)

The brain already generates 5 scored hooks (pickHook). Let the user keep 2-3 hook variants, render derivative versions that differ only in the opening scene, publish them as a test, and track view-through/avg-view-duration per variant with an auto-recommended winner. The unique generate→test→learn loop few all-in-one tools close.

**Files:** packages/engine/src/stages.ts, packages/engine/src/run.ts, apps/dashboard/app/post/[id]/edit/page.tsx, packages/engine/src/learnings.ts, apps/dashboard/app/analytics/page.tsx

**Acceptance:** Two hook variants of one post publish and the dashboard reports which variant retained better.

### G4 — Trending-sound + competitor-winner intel feeding generation  (P1/M, Grow)

scanTrends() and competitive-intel.ts exist but are static/text-only. Add ingestion of trending audio/hashtags and a competitor account tracker that flags above-median posts, then surface those as one-click concepts on the /concepts board so niche winners become Socheli ideas.

**Files:** packages/engine/src/competitive-intel.ts, packages/engine/src/stages.ts, apps/dashboard/app/concepts/ConceptBoard.tsx, packages/engine/src/concept-board.ts

**Acceptance:** A flagged competitor winner appears as a proposed concept the user can generate in one click.

### G5 — Channel performance scorecard  (P2/M, Grow)

Per-channel learnings exist but there's no aggregate view. Add a channel scorecard: total views, avg retention, best-performing scene types/hooks/formats, and posting-time performance, so operators running multiple channels see channel health at a glance and the brain biases toward proven patterns.

**Files:** apps/dashboard/app/channels/page.tsx, packages/engine/src/learnings.ts, apps/dashboard/app/api/analytics/route.ts

**Acceptance:** Each channel page shows aggregate metrics and its top-performing hook/scene-type patterns.

### G6 — Auto title/hashtag generation surfaced + first-comment hashtags  (P2/S, Grow)

Leverage the brain to (re)generate platform-tailored titles and hashtag groups on demand in the composer, with IG first-comment hashtag placement and saved hashtag sets. packagePost already does the core generation; this exposes regeneration and saved groups in the UI.

**Files:** apps/dashboard/app/post/[id]/PublishPanel.tsx, packages/engine/src/stages.ts, packages/engine/src/publisher.ts

**Acceptance:** User regenerates hashtags for one platform and saves a reusable hashtag group applied to future posts.

## Recommended first steps
1. F1 — Add the keyframe data model to packages/schemas/src/index.ts (scene style.keyframes) and a resolveKf interpolator in packages/remotion/src/Post.tsx that animates x/y/scale/rotation/opacity, defaulting to today's static transforms. Ship as schema+render only (no editor UI yet) so it lands independently and unblocks all motion work.
2. C3 — Make auto-captions a first-class editable karaoke track in apps/dashboard/app/post/[id]/edit/page.tsx + Post.tsx: word-level edit/retime, keyword emphasis toggle, and a Hormozi/TikTok/glow preset set, building on the existing WordCue[] and subtitles panel. Independently shippable and the highest-expectation Create feature.
3. P1 — Add TikTok AIGC + branded-content compliance guardrails in packages/engine/src/tiktok.ts and publisher.ts (default AIGC flag, block publish on missing required disclosure) with the toggle in PublishPanel.tsx. Independently shippable, legally/policy-critical for an AI-video tool, and small enough to land now.