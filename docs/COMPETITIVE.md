# Socheli vs. the field — competitive scorecard

Socheli's category is **AI faceless short-form video: one idea → premium vertical post, then publish & grow** — a closed Create→Publish→Grow loop. It is deliberately *not* a general-purpose NLE for raw footage. The scorecard judges per category.

Legend: ✅ leads / 🟰 matches / 🔻 trails / — N/A to its model.

## vs. AI short-form tools (its home turf): Opus Clip · Submagic · Veed
| Capability | Opus/Submagic/Veed | Socheli |
|---|---|---|
| Generate a whole video from an idea (script→scenes→VO→b-roll→music) | 🔻 mostly *repurpose* existing long video | ✅ full generation from one idea |
| Word-level karaoke captions + presets (Hormozi/glow/pop/bounce/phrase) + keyword emphasis | 🟰 | 🟰 (C3) |
| Auto B-roll | 🟰 | 🟰 (engine broll) |
| Auto-duck music under voice | 🟰 | 🟰 (C4, render+engine) |
| Keyframe motion / Ken Burns | partial | ✅ full keyframes (x/y/scale/rot/opacity, eased) + 1-click Ken Burns (F1/C2) |
| Premium designed scene library | template packs | ✅ 15 Remotion scene types + brand DNA/moods |
| Multi-platform publish w/ **AIGC compliance** + reliability (retries/polling/token-expiry) | 🟰 publish, 🔻 compliance depth | ✅ (P1/P2/P4) |
| Scheduling + content calendar | 🟰 | 🟰 (P5) |
| Cross-platform analytics → **learning loop** back into generation | 🔻 | ✅ (G1/G2/G5 + brain) |
| Hook A/B testing tied to analytics | 🔻 | ✅ (G3) |
| Trend/competitor intel feeding generation | 🔻 | ✅ (G4) |
**Verdict: Socheli matches them on editing/captions and *leads* on generation + the closed grow loop.**

## vs. pro NLEs: CapCut · Premiere · DaVinci
| Capability | NLEs | Socheli |
|---|---|---|
| Timeline, trim/ripple/snap, razor/stitch, speed | ✅ | 🟰 (C1) for scene-based timeline |
| Keyframes + easing | ✅ | 🟰 (F1/C2) |
| Per-transition duration/ease | ✅ | 🟰 (C6) |
| Multi-track raw-footage layering, masking, multicam, node color grading | ✅ | 🔻 / — not its model |
| Idea→finished on-brand post in minutes | 🔻 manual | ✅ |
| Built-in publish + analytics + scheduling | 🔻 | ✅ |
**Verdict: not competing on raw-footage NLE depth (by design); wins decisively on time-to-finished-post + distribution.**

## vs. canvas/design: Canva · Adobe Express
| Capability | Canva | Socheli |
|---|---|---|
| On-canvas direct manipulation (drag/resize/rotate, 8 handles, alignment guides, safe zones) | ✅ | 🟰 (C5) |
| Free-form shapes/images/stickers anywhere | ✅ | 🔻 (scene-typed model) |
| Brand kit / templates | ✅ | 🟰 (brand DNA + moods + themes) |
| Video-native motion + render pipeline | 🔻 | ✅ |
| Aspect resize (9:16/1:1/16:9) | ✅ | 🟰 (F2) |
**Verdict: matches the video-relevant canvas ops; trails on free-form static design (out of scope).**

## vs. Descript
| Capability | Descript | Socheli |
|---|---|---|
| Transcript-based editing | ✅ | ✅ (Transcript tab: per-segment edit, click-word-to-seek, drag-reorder, ripple-delete, find&replace) |
| Edit text → **regenerate** the voiceover from corrected text | 🔻 (can only cut fixed recordings) | ✅ (Save&Render re-synthesizes VO) |
| Captions | 🟰 | 🟰 |
| Generation + publish + grow loop | 🔻 | ✅ |
**Verdict: matches Descript on transcript editing and exceeds it — Socheli regenerates the voiceover from edited text; Descript can only cut the original recording.**

## Gap-closure status (exceed wave)
1. ✅ **Text stroke/outline + drop-shadow** (captions & titles) — shipped (`style.stroke`/`style.shadow`), render-verified.
2. ✅ **Free-form overlay layer** — shipped: emoji/shape(rect/circle/triangle/star/arrow/line)/text/logo/image placed anywhere, drag/scale/rotate on canvas, asset catalog API. Render-verified (star + 🔥 overlays render correctly).
3. ✅ **More transitions** — added zoom/push/cover/spin/glitch (was slide/fade/wipe/slamzoom).
4. ✅ **Transcript-based editing** (Descript parity + exceed via VO regeneration) — done.
5. ✅ **F4** editor decomposition — done (16 modules).

**Net: no named editor is better than Socheli at any capability within its scope.** It leads the AI short-form category (Opus/Submagic/Veed) on generation + the grow loop, matches/exceeds them on captions/overlays/motion/transitions, matches+exceeds Descript on transcript editing, and beats the general NLEs (CapCut/Premiere/DaVinci) and Canva on time-to-finished-post + distribution. The general NLEs retain raw-footage/multicam/node-grading depth — a different product category Socheli deliberately does not target (it generates premium shorts, it is not a footage-assembly NLE).
