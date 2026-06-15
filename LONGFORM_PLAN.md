# Socheli — Long-form 16:9 YouTube Pipeline (architecture)

A SEPARATE pipeline from the 9:16 shorts. Same brain/render/media infra, new
content strategy + 16:9 layouts + chapter structure. Goal: production-grade,
deep, accurate, consistently-styled 6–10 min YouTube videos. Clean outputs.

## Core model (chapter-first)
A long-form video = an **outline** of 4–8 **chapters**. Each chapter is an
independent production unit (its own sub-mood, research, script, storyboard,
voice, render). Chapters render separately and concat (ffmpeg concat demuxer) —
keeps render memory low, enables per-chapter QA + re-roll of one chapter.

```
topic
 → outlineLongform()      title + thesis + 4-8 chapters (each: title, purpose, sub-mood, points)
 → researchLongform()     ONE shared research cache (web-grounded passages + sources) for the whole video
 → per chapter (pipeline):
      writeChapter()       narration from outline points + the shared cache (factually grounded)
      buildChapter()       16:9 storyboard scenes for the chapter (varied scene types)
      qaChapter()          per-chapter QA (accuracy, coverage of points, pacing)
 → assembleLongform()      intro + chapter cards + transitions + outro; resolve voice/music/broll
 → renderChapters()        render each chapter to an intermediate mp4 (bounded length)
 → concat()               ffmpeg concat → final 16:9 video + chapter timestamps
 → packageLongform()       title, description (with chapter markers), tags, thumbnail (16:9 cover)
```

## Key decisions (from iCog consult + shorts learnings)
1. **Shared research cache** — the #1 anti-slop lever. Research the topic ONCE
   (web search → vetted passages + source list), feed it to EVERY chapter's
   script call. Prevents script drift + factual contradictions across chapters.
   A cross-chapter consistency QA pass before assembly.
2. **Hierarchical sub-moods** — the channel mood is the base; each chapter gets a
   **sub-mood** (hook / context / mechanism / case-study / counterpoint / payoff /
   future) that overrides layout, pacing, and scene-type bias while inheriting the
   mood's accent/grade/voice. Drives variety chapter-to-chapter.
3. **16:9 layouts** — DO NOT reuse 9:16 graphics in a wide frame (empty margins =
   slideshow feel). Components read width/height and adapt: full-bleed b-roll +
   lower-thirds, split-screen, centered hero, wide charts/diagrams.
4. **Anti-monotony rule** — within a chapter, switch scene TYPE every ~25-40s; the
   storyboard agent is told the chapter's allowed types + "never repeat back-to-back".
5. **Chapter anchors** — new scene types: `chapter_title` (animated card with #/title),
   `chapter_transition` (bridge between sub-moods), `section_summary`.
6. **Voice** — keep one narrator voice for v1 (dual-voice is a v2 upgrade); per-chapter
   scene-synced VO + karaoke captions as in shorts, positioned for 16:9 safe area.
7. **Render discipline** — chapters render SERIALLY (shared public dir + Chrome OOM
   under load — learned from the MoltJobs crash). Bounded chapter length keeps each
   render stable; concat avoids re-encoding the whole thing.
8. **Pacing curve** — hook chapter snappy, mechanism chapters breathe, payoff builds.

## What flexes for 16:9
- Storyboard schema: width/height/fps stop being `z.literal(1080/1920/30)` → accept
  1920×1080. Add `aspect`/orientation. A `Longform` schema wraps chapters.
- Remotion Root: register a `Longform`/16:9 composition sized from props.
- Scene components: responsive to `useVideoConfig()` width/height (center + safe
  margins + use the wide space) instead of fixed 9:16 positions.
- Cover: a 16:9 thumbnail variant.

## Sub-mood matrix (base mood inherits; sub-mood overrides)
hook · context · mechanism · evidence · case_study · counterpoint · implication · payoff
Each: preferred scene types, pacing (avgSceneSec), layout bias (full-bleed / split / hero),
transition style. Sub-moods live in @os/tokens alongside moods.

## CLI / surface
`content longform "<topic>" --channel <id> --mood <id>` → full long-form build.
Dashboard: long-form runs appear in War Room/Queue (per-project filter already added).

## Build phases (this session)
- P1 foundation: schema (flex dims + Longform/Chapter), sub-moods in tokens.
- P2 generation: longform.ts stages + generateLongform orchestrator + CLI.
- P3 render: 16:9 responsive components, Longform composition, chapter cards/transitions, render+concat, 16:9 cover.
- P4 verify: real long-form render end-to-end; iterate on style.

Built with dynamic workflows + subagent teams; foundation/shared files done serially.
