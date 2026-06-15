# SOCHELI LANDING — FINAL BUILD SPEC
## DOC SOC-000 · REV A — "The Field Manual" (SOC-001 spine + judged grafts)

**Status:** approved for build. One engineer, one pass. Static HTML/CSS/vanilla JS, no build tooling except a single deploy-time stamp script (§9). Target: Lighthouse 100/100/100/100, measured CLS 0.00, LCP < 1.0s, total page < 60KB before fonts.

---

## 1. Creative direction summary

The page is a printed technical document — "SOCHELI — FIELD MANUAL, DOCUMENT SOC-001, REV A" — typeset in bone ink on near-black paper, using print grammar (running head, numbered chapters, figure plates, real footnotes, a colophon) instead of SaaS grammar, and it never shows a product screenshot: it reprints primary sources (an unedited terminal log, real storyboard JSON, a hand-drafted fleet schematic, a publish receipt). The star+spark logo is the document's fleuron and its single motion verb — ink draws itself, then the spark detaches — with one narrative arc grafted from the competition: the spark detaches in the hero and docks back into a star at chapter 5.0, stamped "published ✦". The close is the document's last page printed on slightly lighter stock (one ramp-step dawn) with the site's only solid-fill element: an inverse-video bone CTA.

---

## 2. Design tokens

### 2.1 Color (the only colors that exist)

```css
:root {
  color-scheme: dark;
  /* paper */
  --bg:        #0a0a0a;   /* base page */
  --bg-dawn:   #121210;   /* colophon section only — the "lighter stock" */
  --surface:   #101010;   /* code/command blocks */
  --surface-2: #111111;   /* figure plates */
  /* rules & borders — bone-tinted alpha, never solid white */
  --rule:        #1e1e1e;
  --border:      rgba(236,230,216,0.07);
  --border-mid:  rgba(236,230,216,0.10);
  --border-hi:   rgba(236,230,216,0.15);
  --nav-border:  rgba(236,230,216,0.06);
  /* ink ramp — exactly 4 steps, warm, never raw hex in components */
  --ink-1: #ECE6D8;   /* primary — 15.7:1 on bg, AAA */
  --ink-2: #B8B2A6;   /* secondary */
  --ink-3: #87827A;   /* tertiary — ≥4.5:1, floor for body-size text */
  --ink-4: #5C5851;   /* quaternary — metadata/folio/colophon only, never body */
  /* stroke ramp for sketch SVGs */
  --stroke-1: #ECE6D8;                  /* primary strokes, 100% */
  --stroke-2: rgba(236,230,216,0.60);   /* secondary/detail strokes */
  --stroke-3: rgba(236,230,216,0.32);   /* hachure + construction lines */
}
```

Rules: zero hue anywhere. No box-shadows — elevation is lighter surface + 1px `--border`. The one inverse-video element on the entire site is the colophon CTA: `background:#ECE6D8; color:#0a0a0a`.

### 2.2 Typography

Faces (all self-hosted latin-subset woff2, §7.5):

- **Inter** (variable or 400 + 600 statics; semibold via `font-variation-settings:"wght" 590` where variable) — body, headings, UI
- **JetBrains Mono 400** — eyebrows, code, folios, captions, spec values, footnotes
- **Caveat 600** — marginalia ONLY, ≤6 words per instance, hard cap 4 instances on the landing page, 0 on legal pages

Scale (px / line-height / letter-spacing):

| Token | Spec | Use |
|---|---|---|
| `--t-display` | clamp(40px, 8vw, 72px) / 1.02 / -0.022em, Inter 650 | h1 only |
| `--t-h2` | 36px / 1.1 / -0.022em, Inter 600 | chapter titles |
| `--t-h3` | 24px / 1.33 / -0.012em, Inter 600 | sub-blocks, FAQ questions at 17px exception below |
| `--t-colophon` | 28px / 1.2 / -0.022em, Inter 600 | colophon line |
| `--t-body` | 15px / 1.6 / -0.011em, Inter 400 | all prose (NOT 16px) |
| `--t-sub` | 17px / 1.6 / -0.011em, Inter 400 | hero subhead, FAQ questions (600) |
| `--t-small` | 14px / 1.5 / -0.013em | footer links |
| `--t-eyebrow` | 12px / 1 / 0.22em, JBMono 400, uppercase | section eyebrows |
| `--t-folio` | 11px / 1 / 0.2em, JBMono, uppercase | running head, captions ticks |
| `--t-mono` | 13px / 1.7 / 0, JBMono | logs, code, spec values, evidence strip, footnotes |
| `--t-mono-cmd` | 14px / 1.5, JBMono | command blocks |
| `--t-caveat` | 19px / 1.3, Caveat 600 | marginalia (1.25× body — Caveat runs small) |

Eyebrow class:

```css
.eyebrow{font:400 12px/1 "JetBrains Mono",var(--mono-fb);text-transform:uppercase;
letter-spacing:.22em;color:var(--ink-3);display:flex;gap:10px;align-items:center}
/* every eyebrow is prefixed by the 12px single-pass-rough star glyph (inline <svg><use>) */
```

### 2.3 Spacing, grid, breakpoints

- Base unit **8px**. Spacing scale: 8 / 16 / 24 / 32 / 48 / 64 / 96 / 112 / 160.
- `--page-max: 1344px; --prose-max: 680px; --measure-legal: 64ch; --pad-inline: 24px; --nav-h: 64px;`
- Section block padding: 96–112px desktop, 64px mobile.
- Layout is **left-anchored everywhere**; exactly one centered moment (the colophon).
- Sketch elements align to the 8px grid — the strokes wobble, their bounding boxes never do.
- Breakpoints: `480px` (compact), `768px` (stack sticky spread, single-column footer→2col), `1024px` (full two-column spread + page margins for marginalia), `1344px` (container cap). Design 375px first for the pipeline spread (§3.5 mobile fallback).
- Buttons/links: ghost CTA = 40px height pill, 1px `--border-hi`; links underlined, `text-underline-offset:3px; text-decoration-color:var(--ink-3)` brightening to `--ink-1` on hover. Touch targets ≥48×48 with ≥8px gaps. `:focus-visible{outline:1px solid var(--ink-1);outline-offset:2px}`.
- `scrollbar-gutter: stable both` on `html`.

---

## 3. Page structure — `/` (DOC SOC-001), in order

> Global: `<a class="skip-link" href="#main">Skip to content</a>` first in `<body>`. One `<h1>`. Eyebrows are `<p class="eyebrow">`, never headings. All decorative SVGs `aria-hidden="true"`.

### 3.0 Running head + nav (document chrome)

**Visual.** 64px sticky bar, `background:rgba(10,10,10,0.8); backdrop-filter:blur(12px) saturate(1.2)`; 1px bottom border `--nav-border` class-toggled on after `scrollY > 8` (100ms transition). Left: clean (un-roughened) 20px star+spark mark + "SOCHELI" Inter 600 14px (the mark is an `<a href="/">` with visually-hidden text — not a heading). Center-left, JBMono 11px/0.2em uppercase `--ink-4`: `DOC SOC-001 · REV A` plus a live folio (`§ 3.0 — STORYBOARD`) that swaps as sections pass. Right: `Manual · Spec · Source · GitHub ★ 2.4k` (star count: one fetch to `api.github.com/repos/Socheli/socheli`, static fallback baked in, width pre-reserved via `min-width:4ch` so arrival shifts nothing) + ghost CTA `$ clone` linking to `#colophon`. Along the very top edge: a 2px bone scroll-progress hairline, **terminating in a 6px spark diamond riding its leading edge** (graft: Night Studio).

**Copy.** Links exactly: `Manual` (→#ch-1) · `Spec` (→#spec) · `Source` (→ github.com/Socheli/socheli) · `GitHub ★ <n>`.

**Motion.** Hairline: `transform-origin:left; animation:grow linear; animation-timeline:scroll(root)` inside `@supports`; 6-line passive-scroll+rAF fallback. The spark tip is a child positioned at the hairline's right end (`right:0` of the scaling element's wrapper, translated by the same timeline). Folio swaps with a 150ms opacity crossfade (textContent swap inside a fade). Nav spark: ONE 2px drift+settle on load, 600ms `cubic-bezier(.22,1,.36,1)`, never again. Nav star carries `view-transition-name: brand-mark`.

### 3.1 Hero — the title page

**Visual.** Asymmetric, left-anchored. Behind everything: 560px stroke-only two-pass-rough star+spark watermark at 3.5% opacity, `aria-hidden`. Right page-margin (≥1024px only): ONE Caveat annotation rotated -2° with a hand-bowed ink arrow pointing at the command block. Hero is pure text — **the h1 is the LCP element**; zero hero imagery.

**Copy — exact.**

- Eyebrow: `✦ FIELD MANUAL — OWN YOUR FLEET`
- H1 (two manually broken lines, `<span>` per line):
  Line 1: `One idea in.`
  Line 2: `Published video out.`
- Subhead (17px `--ink-2`, max-width 30rem): `Socheli is the open-source content engine that doesn't just generate — it scripts, voices, renders, and publishes autonomously. Your Mac renders. Your phone posts. Your disk keeps the data.`
- Primary CTA — copyable command block (graft: THE LINE — `npx`, not clone):
  `$ npx socheli` — `#101010` surface, 1px `--border-mid`, 6px radius, JBMono 14px, `$` in `--ink-3`, copy button right-aligned.
- Secondary: underlined text link `Read the architecture →` (→ /docs or repo docs/AGENT-HARNESS.md).
- Marginalia (Caveat, 5 words): `runs on the laptop you already own` → trim to `runs on what you own` (≤6 words).

**Motion.** H1 lines exist at first paint; decoration only: per-line `clip-path: inset(0 0 100% 0) → inset(0)` + 8px translateY, 700ms `cubic-bezier(.22,1,.36,1)`, line 2 +120ms — pure CSS, no JS gate, fonts metric-matched so zero reflow. Eyebrow: 200ms fade. **The hero performs the DETACH half of the bookend (graft):** the watermark star draws nothing (static), but the nav-adjacent hero star glyph beside the eyebrow plays the detach — spark `translate(5px,-5px)` + opacity pulse, 240ms, at 1.0s after load. The marginalia arrow draws itself (`pathLength="1"`, dashoffset 1→0, 700ms) starting 400ms after the H1 lands; Caveat note fades as the arrowhead finishes. Watermark drifts at 0.88× scroll speed via `scroll(root)` timeline (`translateY(-12%)` over full scroll); static in Firefox. Total hero choreography ≤1.2s.

**Copy button behavior (graft: THE LINE).** `navigator.clipboard.writeText("npx socheli")`; label swaps to `✦ copied` for 1.2s while the button's spark glyph detaches 4px top-right + opacity pulse, 240ms. This is the site's only success state.

### 3.2 Evidence strip — numbers, not logos

**Visual.** One mono line, JBMono 13px `--ink-3`, 1px `--rule` hairlines above/below, items separated by 8px star glyphs (`aria-hidden`):

`GitHub ★ <live> · ~130 tools, one registry · 5 surfaces: CLI / API / MCP / SDK / copilot · AGPL-3.0 core · renders on your Mac · posts from your phone · flat JSON, no database`

(License named in plain mono — graft: THE LINE.)

**Motion.** Single 500ms opacity + translateY(16px) reveal as one unit via the shared IO. No counters, no per-item stagger. Star separators are static ink.

### 3.3 Chapter 0 — Fig. 1, the reprinted run

**Visual.** Full-width figure plate: real `content new` run reprinted as a log. JBMono 13px/1.7 bone on `#111`, 1px `--border`, four corner registration ticks (tiny L-marks, `--stroke-3`). Caption beneath, JBMono 11px `--ink-4`: `Fig. 1 — Pipeline run, unedited. M-series base spec.` Caveat margin note with leader line (annotation 2 of 4): `run it yourself`.

**Copy — the log (real output, scrubbed of hostnames/IPs/keys per repo security rule; durations must be true measured values from an actual run):**

```
$ content new "why RAID is not a backup" --channel labrinox
  script ......... 14s
  voice .......... 22s
  storyboard ..... 31s
  broll .......... 48s
  render ......... 3m41s   1080×1920 · Remotion
  → gate: WAITING FOR HUMAN
  → approve to publish
█
```

**Motion.** Lines reveal with 70ms staggered `transition-delay: min(calc(var(--i)*70ms), 420ms)` at IO threshold 0.15; `@supports` path binds the same keyframes to `view()` with `animation-range: entry 0% entry 60%`. Block cursor blinks via `steps(1)` only after the cascade completes. Reduced motion: log fully printed, cursor static.

### 3.4 Chapters 1.0–5.0 — the pipeline as a sticky figure plate

**Visual.** Two-column spread, total container ~340vh. LEFT scrolls five chapter blocks; RIGHT is `position:sticky; top:10vh; height:80vh` holding ONE hand-drafted SVG schematic (Fig. 2): baked rough paths (§4), five stage boxes, hachure fills, dotted construction lines, mono measurement labels (`9:16`, `24fps`, `M-series`), curved open-V ink arrows. Caption: `Fig. 2 — The loop. Plate 1 of 1.`

**Chapter copy — exact.**

**`✦ 1.0 — IDEA`** — Title: `It starts as one sentence.`
Body: `You give Socheli an idea — a topic, a take, a question. That's the whole input. The channel's Brand Genome — learned hooks, topics, formats — shapes everything that follows.` Artifact: the idea as a Caveat note pinned to the plate (annotation 3 of 4, counts as the marginalia for this section): `why RAID is not a backup` — rendered inside the sticky plate, not the text column.

**`✦ 2.0 — SCRIPT`** — Title: `The engine writes like the channel.`
Body: `The brain drafts hooks and scenes against the genome. Every field is readable, every shape is a zod schema.◆¹ You can open the file.` Artifact: six lines of real storyboard/script JSON (actual schema fields: `say`, `emphasis`, `broll`) in a bordered mono block, caption `Fig. 2a — script, as the engine writes it.`

**`✦ 3.0 — STORYBOARD`** — Title: `Frame-accurate before a single pixel renders.`
Body: `Scenes, timings, emphasis, b-roll queries — locked in JSON, validated at the boundary, rendered exactly as written.` Artifact: three real 9:16 storyboard frames (AVIF, explicit width/height, `loading="lazy"`) inside rough rectangles with registration ticks and mono leader labels.

**`✦ 4.0 — RENDER (ON YOUR MAC)`** — Title: `Your hardware does the work.`
Body: `Remotion compositions render locally. Your GPU, your filesystem, your media. Nothing uploads to a render farm, because there isn't one.◆²` Artifact: render log excerpt ending `render 3m41s · 1080×1920 · Remotion`, plus one click-to-load 9:16 `<video preload="none" muted playsinline>` behind an AVIF poster (<80KB) in a rough frame. Caption: `Fig. 2b — actual output, unretouched.`

**`✦ 5.0 — PUBLISH (FROM YOUR DEVICES)`** — Title: `Nothing posts without your gate.`
Body: `The mission loop runs until you stop it. Publishing drives your own phone, on your own accounts, over your own IP. The gate is yours.` Artifact (graft: THE LINE — publish receipt as primary source):

```
queued
→ gate: APPROVED by you
→ posted 09:41 · your account · your IP
published ✦
```

…with a baked wobbly ink circle around the word `gate` (two-pass rough ellipse, draws when the receipt is 60% in view) and the `published ✦` stamp set as the dock target.

**Motion.** Shared IO at threshold 0.5 on each left block sets `data-step="n"` on the plate; CSS draws the corresponding arrow + stage group (stroke-dashoffset, 600ms `cubic-bezier(.65,0,.35,1)`, shaft first, open-V head +150ms) and dims the previous stage's strokes to 60%. In `@supports (animation-timeline: view())` browsers the arrows bind to view() timelines for reversible scrubbed drawing. **At step 5 the bookend completes (graft):** the plate's star tip's spark — detached since the hero — translates 6px and **docks**, snapping into the star beside the receipt's `published ✦` line (240ms, opacity pulse). Native scroll only; no wheel handlers.

**Mobile (<768px).** The spread stacks: plate becomes a static fully-drawn horizontal mini-schematic above each chapter's text (5 small per-stage SVG crops), drawing on IO not scrub. No sticky at narrow viewports.

### 3.5 Fig. 3 — the trust boundary

**Visual.** Full-width hand-drafted two-region map in a figure plate. LEFT region, mono label `THEIR CLOUD`: deliberately near-empty — one hachured box struck through by two diagonal ink strokes; Caveat annotation (4 of 4, final allowed): `nothing of yours lives here`. RIGHT region `YOUR FLEET`: rough-drawn Mac (`renders`), phone (`posts`), disk (`flat JSON`), key (`your tokens`), bowed ink arrows, mono leader labels. Caption: `Fig. 3 — Trust boundary.`

**Copy beneath the plate** — three star-bulleted lines: `nothing publishes without your gate · the mission loop runs until you stop it · your machines do the work`.

**Motion.** IO 0.3, one-shot: boundary line draws first (900ms), YOUR FLEET strokes stagger 150ms apart in pen order; THEIR CLOUD's strike-through draws LAST, +400ms — the punchline beat. Bullet sparks pop 3px out 200ms after text lands.

### 3.6 §6.0 — Specification (the datasheet)

**Visual.** Eyebrow `✦ 6.0 — SPECIFICATION`. A plain ruled table (1px `--rule`, zero cards, zero icons) in the **explicit two-column DOES / DOES NOT framing** (graft: THE LINE, promoted from the trust plate):

| SOCHELI DOES | SOCHELI DOES NOT |
|---|---|
| output: 9:16 vertical + 16:9 long-form | render in our cloud |
| pipeline: idea → script → storyboard → voice → render → publish | hold your tokens |
| render target: your macOS device ◆¹ | post without your gate |
| publish path: your phone, your accounts, your IP | phone home |
| surfaces: CLI / HTTP / MCP / SDK / copilot — ~130 tools, one registry | run analytics on this page ◆³ |
| persistence: flat JSON on your disk — no database | require a database |
| gates: human approval before publish and before DNA mutation | — |
| license: AGPL-3.0 core ◆² · github.com/Socheli/socheli | — |

Keys Inter 15px, values JBMono 13px. Three superscript spark-diamond footnote markers (`◆¹ ◆² ◆³`) resolve to the footnote block (§3.8).

**Motion.** Outer rule draws via scaleX (400ms) first; rows fade up 12px, 60ms stagger, capped 420ms. Footnote markers pop in 150ms after their row — the spark arriving late, on-motif. Otherwise the stillest section on the page.

### 3.7 §7.0 — Questions (open FAQ, no accordion)

**Visual.** Eyebrow `✦ 7.0 — QUESTIONS`. Five Q&As typeset open as editorial text, 64ch measure, separated by short 80px wobbled-rule + star dividers. Questions Inter 600 17px; answers ≤3 sentences, 15px/1.6 `--ink-2`. Zero accordion JS. FAQPage JSON-LD attached silently (§7.3) — no SERP feature expected (dead May 2026); the visible copy is what AI surfaces quote.

**Copy — exact.**

- **Does it need my API keys?** `Yes — your own. Model and voice providers are called with keys you supply, stored in a local .env on your machine. There is no Socheli server in the loop to send them to.`
- **Why my own devices?** `Rendering is compute you already own, and publishing from your own phone on your own IP means your accounts behave like accounts — not like an API farm. Ownership is the architecture, not a feature flag.`
- **What does Meta App Review see?** `Socheli requests Instagram permissions through Meta's standard OAuth, per workspace. Tokens are stored as flat JSON on the user's own device and are deletable by the user at any time — see /privacy and /data-deletion.`
- **What happens when I stop it?** `The mission loop halts at the next tick. Nothing renders, nothing posts, nothing phones home. Your data is flat JSON on your disk — delete the folder and it's gone.`
- **What's the license?** `AGPL-3.0 for the core engine. Commercial extensions are licensed separately — the terms are written in plain language at /terms.`

**Motion.** Single quiet 500ms section reveal. Wobbled mini-rules draw (400ms) only in `@supports` browsers; present-by-default elsewhere. Near-stillness is intentional.

### 3.8 Footnotes + colophon (the dawn close)

**Visual.** Footnote block above the footer — the spark diamond IS the footnote glyph:

- `◆¹ render time measured on M-series base spec, unedited log at Fig. 1 — repo commit <hash, stamped at deploy>` (graft: Night Studio — commit-hash provenance)
- `◆² AGPL-3.0 core; commercial terms at /terms`
- `◆³ verify in your DevTools network tab — this claim is checkable`

Then **the colophon — the page's one centered moment, set on the dawn surface** (graft: Night Studio): the `<section>` background steps to `#121210` with a 1px bone-alpha top rule. Pre-painted, never animated — the document's last page is printed on lighter stock.

**Copy — exact.**

- Fleuron: the star+spark, 48px, two-pass rough.
- H2 (28px Inter 600): `Don't take our word. Take the repo.` (graft: THE LINE — sharpest line wins the close)
- **The inverse-video CTA** (graft: Night Studio — only solid fill on the site): a copyable command block rendered as solid `#ECE6D8` with `#0a0a0a` text, JBMono 14px: `$ git clone https://github.com/Socheli/socheli` (the committed reader gets the full clone here; the casual one already got `npx socheli` in the hero). Copy behavior identical: `✦ copied` + spark detach.
- Beneath, JBMono 12px `--ink-4`: `This page is <n>KB, makes <n> requests, and loads no trackers. Set in Inter & JetBrains Mono. ✦ END OF DOCUMENT SOC-001` — `<n>` values computed by the deploy script and inlined (§9); never hand-written, never stale.

**Motion.** The full logo ritual, performed once: fleuron star outline draws (700ms), spark detaches 200ms after completion (translate 5px,-5px / 240ms) and settles. Colophon text fades 500ms. The inverse CTA gets the page's only magnetic treatment: ~25-line lerp, strength 0.3, ≤6px travel, 0.1px deadband self-termination, gated `(hover:hover) and (prefers-reduced-motion: no-preference)`.

### 3.9 Footer — sitemap + compliance surface

**Visual.** Four columns, Inter 14px: **Product** (Manual · Specification · Questions) / **Open source** (GitHub · npm: @socheli · Docs · llms.txt) / **Legal** (Privacy Policy · Terms of Service · Data Deletion — full words, plain text links, ctrl-F-able) / **Contact** (contact@socheli.com). Behind the columns: 720px stroke-only star+spark watermark at 3% opacity, `aria-hidden`. Bottom line JBMono 11px `--ink-4`: `© Socheli · github.com/Socheli · DOC SOC-001 REV A`.

**Motion.** None. The footer is still. Cross-document `@view-transition { navigation: auto }` (≤300ms; `::view-transition-old(root){animation-duration:.2s} ::view-transition-new(root){animation-duration:.3s}`) with the nav star morphing via `view-transition-name: brand-mark`; disabled under reduced motion.

### 3.10 404 page (graft: THE LINE, rewritten for the manual)

Same shell. A lone two-pass rough star whose spark has wandered off toward the page edge; mono caption: `PAGE NOT IN THIS DOCUMENT` · sub-line `return to SOC-001 →` linking home. Real HTTP 404 status. ~1KB of extra content.

---

## 4. The sketch system

**Restraint ratio: 90/10.** All type, grid, nav, tables, and layout are machined-clean. Sketch appears in exactly four roles: (1) annotation marks (the ink circle on `gate`, underline-free), (2) the two big plates (Fig. 2 loop, Fig. 3 trust boundary) + small artifact frames, (3) dividers/bullets/fleurons, (4) marginalia arrows. Max one sketch motif per viewport-height. **Never** wobble running text, UI containers, the spec table, or anything on legal pages (one star divider only there).

**Wobble production — baked, never runtime.**
- Run rough.js ONCE offline (scratch HTML page), paste generated `<path d>` into the source SVGs. Fixed seed per icon (document seeds in `art/SEEDS.md`); reloads never reshuffle.
- Settings: `roughness ≤ 1.2`, `bowing ≤ 1`, exactly **two passes** per primary stroke (the offset second pass is what reads as ink; pass 2 animates +350ms after pass 1).
- NO runtime `feTurbulence`/`feDisplacementMap` on anything that animates or on the page body. Optional: one static `filter:url(#wobble)` (`type="fractalNoise" baseFrequency="0.02" numOctaves="2" scale="3"`, 2px viewBox padding) on small static inline icons only — prefer baked geometry everywhere.

**Stroke discipline.**
- One weight family: **1.5px primary**, 1px secondary/hachure, 2px only for the logo star ≤24px. `vector-effect="non-scaling-stroke"`, `stroke-linecap="round"`, `stroke-linejoin="round"`, `fill="none"` on every path.
- Hierarchy by gray ramp, not weight: primary `--stroke-1`, details `--stroke-2`, hachure/construction `--stroke-3`.
- Hachure fills: 45° parallel lines, 4–6px gap, 1px, opacity .32, clipped via `<clipPath>` to the rough shape. Never flat fills inside rough outlines.
- Drafting layer: dotted construction lines `stroke-dasharray="1 4"` at `--stroke-3`; corner registration ticks on every figure plate; mono measurement labels attached by hand-drawn leader lines.
- Arrows: never `<marker>`. Bowed cubic-bezier shaft (4–8px bow per ~120px) + separate open-V head whose strokes overshoot the tip 2–3px; entry angles 20–40°, curved, never axis-straight. Animate shaft, then head +150ms.
- Optical rule: nudge sketch icons up 1px against text baselines (wobble reads bottom-heavy).

**Annotation font.** Caveat 600, woff2 subset (~15KB, subset to the exact glyphs of the 4 annotations + a–z fallback). ≤6 words per note, rotated -1.5° to -4°, color `--ink-2` or `--ink-3`, never in headings/nav/buttons, always `aria-hidden` (decorative — meaning lives in clean type). **Hard cap: 4 instances on `/`, 0 on legal pages.** The four: hero (`runs on what you own`), Fig. 1 (`run it yourself`), Ch. 1 plate (the idea note), Fig. 3 (`nothing of yours lives here`).

**Paper tooth.** Pre-baked 200×200 noise PNG data-URI (~3KB; generated once from `feTurbulence baseFrequency="0.8" numOctaves="4"` → alpha): `body::after{position:fixed;inset:0;background:url(data:image/png;base64,…) repeat;opacity:.04;mix-blend-mode:overlay;pointer-events:none}`. Felt, never seen. No live filter on the body, ever.

**Self-drawing recipe (everywhere).** Every drawable path carries `pathLength="1"`; CSS: `stroke-dasharray:1; stroke-dashoffset:1` → `.in { stroke-dashoffset:0 }` with `transition/animation 600–900ms cubic-bezier(.65,0,.35,1)`. Multi-stroke figures stagger 120–150ms in pen order: outline → details → hachure. Zero measuring JS.

---

## 5. Logo system — the star+spark as fleuron

One inline `<svg><defs>` per page defines the mark as **two addressable paths** (star body + spark diamond, ~200 bytes), instanced via `<use>`. Three fidelities:

**Clean geometric (≤14px — wobble dies small):**
1. `favicon.svg` — square viewBox, fill `#0a0a0a` default with embedded `@media(prefers-color-scheme:dark){path{fill:#ECE6D8}}`
2. `favicon.ico` (16/32/48), `apple-touch-icon.png` 180×180 on SOLID `#0a0a0a`, ~20% padding
3. Nav mark, 20px, `view-transition-name: brand-mark` (morphs across pages)
4. `og.png` centerpiece; `logo-512.png` for the Organization schema (solid bg, never transparent)

**Single-pass rough (14–32px):**
5. Eyebrow prefix glyph on every section label
6. List bullets — `li::before` masked star at 0.7em `--ink-3`; spark translates 3px out at `transition-delay: calc(var(--i)*70ms + 200ms)` after the li's reveal
7. Evidence-strip separators (static, `aria-hidden`)
8. **The footnote glyph** — the spark diamond ALONE (`◆¹ ◆² ◆³`) as superscript marker and footnote-block bullet: the logo's broken-away piece literally becomes the page's footnote symbol (the deepest cut — keep it)
9. Copy-button glyph + `✦ copied` confirmation state
10. Progress-hairline tip — 6px spark riding the leading edge

**Two-pass rough display (≥48px):**
11. Section dividers — wobbled 1px rule draws in via scaleX with star at center, spark detaching 3px as the rule completes
12. 560px hero watermark @3.5% + 720px footer watermark @3%, stroke-only, `aria-hidden`
13. Colophon fleuron — performs the full draw-then-detach ritual once
14. 404 star with wandered spark
15. The Fig. 2 plate's star tip — releases its spark at the hero (detach) and **docks it at chapter 5.0** onto `published ✦` (the page's narrative arc, told by the mark)

**Motion grammar of the mark:** spark-detach is THE brand verb — always `translate(5px,-5px)` (or 4px variants) + opacity pulse, 240ms. Deployments: nav drift once on load · copy success · divider completions · bullet pops · hero detach → ch. 5.0 dock · colophon ritual. Never two animated marks in the same viewport at once; ≥1 instance per viewport-height.

---

## 6. Motion system

**One verb: things DRAW themselves in ink, then the spark DETACHES (and finally docks).**

**Standard numbers (no exceptions):**
- Entrances: opacity 0→1 + translateY 12–20px, 500–700ms, `cubic-bezier(.22,1,.36,1)`
- Strokes: dashoffset 1→0, 600–900ms, `cubic-bezier(.65,0,.35,1)`
- Spark detach/dock: 240ms; stagger 60–90ms via `--i`, total cascade ≤420ms (`transition-delay:min(calc(var(--i)*70ms),420ms)`)
- Animated properties: **transform, opacity, clip-path only.** Nothing else, ever (Lighthouse non-composited audit stays clean).
- `will-change` on exactly two persistent layers: progress hairline + hero watermark.

**Layered enhancement stack:**
1. **Base (universal, no-JS, Firefox):** everything visible by default. Hidden-initial states exist ONLY under `html.js` (set by 1-line inline `<script>document.documentElement.classList.add('js')</script>`) AND inside `@media (prefers-reduced-motion: no-preference)`. No unconditioned `opacity:0` anywhere.
2. **IO layer:** ONE shared `IntersectionObserver({threshold:.15, rootMargin:'0px 0px -10% 0px'})`, observing section containers, `unobserve` after fire, toggling `.in`. (Pipeline steps use a second threshold-0.5 observer entry for `data-step`.) Reveals play once — never re-trigger on scroll-up.
3. **`@supports (animation-timeline: view())` layer (Chromium/Safari):** scrubbed reversible upgrades — Fig. 1 log cascade, pipeline arrows (`view()`, `animation-range: entry 0% entry 60%`), progress hairline + watermark drift (`scroll(root)`). Firefox degrades to layer 2 with zero blank states.

**Scroll-driven vs IO split (explicit):**

| Element | Chromium/Safari | Firefox / fallback |
|---|---|---|
| Progress hairline + spark tip | `scroll(root)` scaleX | passive scroll + rAF (stores number only, writes in rAF) |
| Hero watermark 0.88× drift | `scroll(root)` | static |
| Folio swapper | IO (both) | IO |
| Fig. 1 log lines | `view()` scrub | IO stagger |
| Pipeline arrows + spark dock | `view()` scrub | IO-triggered draw, discrete 400ms spark hop |
| Everything else | IO | IO |

**JS budget: < 8KB, one deferred file** — `js` class setter (inline), shared IO + folio swapper, copy buttons, GitHub-star fetch (with reserved width), magnetic colophon CTA (deadband-terminated rAF), Firefox hairline fallback. No scroll listeners that read layout. No canvas. No libraries.

**prefers-reduced-motion — a designed variant, not a kill switch:** motion is the opt-in (`@media (prefers-reduced-motion: no-preference)` wraps every keyframe, timeline, and hidden state). Under reduce: all strokes ship pre-drawn (`stroke-dashoffset:0`), spark attached/docked, log fully printed, ≤300ms opacity fades only, magnetic listeners never attach, view transitions disabled (`@media (prefers-reduced-motion: reduce){ @view-transition{navigation:none} }`). JS checks `matchMedia('(prefers-reduced-motion: no-preference)')` before initializing motion and listens for live `change`.

**Legal pages:** one ≤200ms fade via the view transition; zero scroll-bound motion.

---

## 7. SEO implementation block

### 7.1 Per-page meta

| Page | `<title>` | meta description |
|---|---|---|
| `/` | `Socheli — Open-Source Autonomous Content Engine` (48) | `Socheli is an open-source content engine: one idea in, a scripted, voiced, rendered vertical video out — published autonomously from your own devices and accounts.` |
| `/privacy` | `Privacy Policy — Socheli` | `How Socheli handles data: OAuth tokens and media live as flat JSON on your own devices. What we collect (nothing on this site), what we never hold, and how to reach us.` |
| `/terms` | `Terms of Service — Socheli` | `Terms for using Socheli, the open-source autonomous content engine. License (AGPL-3.0 core), acceptable use, and your responsibilities when publishing.` |
| `/data-deletion` | `Data Deletion — Socheli` | `How to delete all Socheli data: numbered steps, the full data inventory (OAuth tokens, media, flat JSON on your devices), deletion timeline, and contact.` |

Head order: charset → viewport (`width=device-width, initial-scale=1` — NO maximum-scale) → title → description → canonical (absolute, self-referential, e.g. `https://socheli.com/`) → `<meta name="robots" content="max-image-preview:large, max-snippet:-1">` (no cargo-cult index,follow) → `<meta name="theme-color" content="#0a0a0a">` → `<meta name="color-scheme" content="dark">` → OG/Twitter → font preloads → inlined CSS → JSON-LD. `<html lang="en">`.

### 7.2 OG / Twitter

```html
<meta property="og:title" content="Socheli — the open-source content engine that publishes itself">
<meta property="og:description" content="One idea in. Published video out — from your own Macs, phones, accounts, and IP.">
<meta property="og:url" content="https://socheli.com/">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Socheli">
<meta property="og:locale" content="en_US">
<meta property="og:image" content="https://socheli.com/og.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="Bone four-pointed star with a breakaway spark on near-black; Socheli — one idea in, published video out.">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:image:alt" content="Socheli — one idea in, published video out.">
```

`og.png`: 1200×630 **PNG** (never SVG/WebP), <300KB — bone star + wordmark + one set line on `#0a0a0a`, all content inside a centered 1200×600 safe area (X's 2:1 crop). Per-page og:title/og:url on legal pages.

### 7.3 JSON-LD — one `@graph` per page, `@id`-stitched

Landing (`/`):

```json
{"@context":"https://schema.org","@graph":[
 {"@type":"Organization","@id":"https://socheli.com/#org","name":"Socheli",
  "url":"https://socheli.com/",
  "logo":{"@type":"ImageObject","url":"https://socheli.com/logo-512.png"},
  "email":"contact@socheli.com",
  "sameAs":["https://github.com/Socheli","https://www.npmjs.com/org/socheli"]},
 {"@type":"WebSite","@id":"https://socheli.com/#website","name":"Socheli",
  "url":"https://socheli.com/","publisher":{"@id":"https://socheli.com/#org"}},
 {"@type":"SoftwareApplication","@id":"https://socheli.com/#app","name":"Socheli",
  "description":"Open-source content engine that scripts, voices, renders, and autonomously publishes vertical video from the user's own devices and accounts.",
  "url":"https://socheli.com/","applicationCategory":"MultimediaApplication",
  "operatingSystem":"macOS, Android, Linux",
  "offers":{"@type":"Offer","price":"0","priceCurrency":"USD"},
  "license":"https://github.com/Socheli/socheli/blob/main/LICENSE",
  "downloadUrl":"https://github.com/Socheli/socheli",
  "author":{"@id":"https://socheli.com/#org"}},
 {"@type":"SoftwareSourceCode","codeRepository":"https://github.com/Socheli/socheli",
  "programmingLanguage":"TypeScript","runtimePlatform":"Node.js",
  "targetProduct":{"@id":"https://socheli.com/#app"},
  "license":"https://github.com/Socheli/socheli/blob/main/LICENSE"},
 {"@type":"WebPage","@id":"https://socheli.com/#page","url":"https://socheli.com/",
  "isPartOf":{"@id":"https://socheli.com/#website"},"about":{"@id":"https://socheli.com/#app"}},
 {"@type":"FAQPage","mainEntity":[
   {"@type":"Question","name":"Does Socheli need my API keys?","acceptedAnswer":{"@type":"Answer","text":"Yes — your own. Model and voice providers are called with keys you supply, stored in a local .env on your machine. There is no Socheli server in the loop."}},
   {"@type":"Question","name":"Why does Socheli run on my own devices?","acceptedAnswer":{"@type":"Answer","text":"Rendering uses compute you already own, and publishing from your own phone on your own IP means your accounts behave like accounts, not an API farm."}},
   {"@type":"Question","name":"What does Meta App Review see?","acceptedAnswer":{"@type":"Answer","text":"Socheli requests Instagram permissions through Meta's standard OAuth per workspace. Tokens are stored as flat JSON on the user's own device and are deletable at any time."}},
   {"@type":"Question","name":"What happens when I stop Socheli?","acceptedAnswer":{"@type":"Answer","text":"The mission loop halts at the next tick. Nothing renders, nothing posts, nothing phones home. Data is flat JSON on your disk — delete the folder and it's gone."}},
   {"@type":"Question","name":"What is Socheli's license?","acceptedAnswer":{"@type":"Answer","text":"AGPL-3.0 for the core engine; commercial extensions are licensed separately."}}
 ]}
]}
```

Notes: **OMIT `aggregateRating`** (GitHub stars are not ratings; fabrication = manual-action risk). **No `potentialAction`/SearchAction** (deprecated). FAQPage included knowing it earns zero SERP feature — it costs nothing and feeds non-Google consumers; the visible §7.0 copy is the real play. Legal pages: WebPage + **BreadcrumbList** (`Home → Privacy Policy` etc., so SERPs show `socheli.com › privacy`).

### 7.4 LCP / CLS / INP

- Hero h1 = LCP, paints with the HTML. **All CSS inlined in `<head>`** per page (<20KB) — zero render-blocking requests, no external stylesheet. Inline brand SVGs (inline `<svg>` can't be an LCP candidate).
- Every `<img>`: explicit `width`/`height`, AVIF, `loading="lazy" decoding="async"` below the fold; nothing lazy above it; no above-the-fold raster at all on `/`.
- No cookie banner (no tracking → no consent UI). Measured CLS target 0.00.
- HTML `Cache-Control: no-cache`; hashed assets `max-age=31536000, immutable`.
- INP: <15KB total JS, deferred, passive listeners, clipboard + class toggles only.
- Speculation Rules prerender for instant legal-page nav: `<script type="speculationrules">{"prerender":[{"where":{"href_matches":"/*"},"eagerness":"moderate"}]}</script>`.

### 7.5 Fonts

Self-hosted latin-subset woff2, exactly four files: `inter-400`, `inter-600` (~18KB each), `jbmono-400` (~15KB), `caveat-600` (subset, ~12KB). **Never the Google Fonts `<link>`.** Preload ONLY `inter-600` + `inter-400` (hero faces). `font-display: swap` with metric-matched fallbacks generated via `npx fontaine`/Capsize:

```css
@font-face{font-family:"Inter-fb";src:local("Arial");size-adjust:107%;
ascent-override:90%;descent-override:22.5%;line-gap-override:0%}
/* font-family: Inter, "Inter-fb", system-ui, sans-serif */
```

JBMono: `font-display: optional` + size-adjusted local Menlo/Consolas fallback (eyebrows survive). Caveat: `swap`, used only on absolutely-positioned annotations so arrival can't shift layout.

### 7.6 robots.txt / sitemap / extras

```
User-agent: *
Allow: /

Sitemap: https://socheli.com/sitemap.xml
```

Deliberately do NOT block GPTBot/ClaudeBot/PerplexityBot/CCBot/Google-Extended — AI citations are distribution. **Never block `facebookexternalhit` / `meta-externalagent`** (App Review fetches /privacy and /data-deletion); verify host bot-protection whitelists them. Sitemap: 4 `<url>` entries with truthful `<lastmod>` (W3C dates, updated only on real edits), **no changefreq/priority**. Redirect `/index.html → /`; 301 all host variants to the canonical apex-https form. `llms.txt`: 10-line nicety (product one-liner + 4 URLs) — zero Google effect, fine for other agents. Day one: Search Console + Bing Webmaster Tools, IndexNow ping in deploy. `rel="me"` link to the GitHub org in the footer.

Favicon/manifest set: `favicon.svg` (square, scheme-aware), `favicon.ico` (16/32/48), `apple-touch-icon.png` (180, solid bg), `site.webmanifest` `{"name":"Socheli","icons":[{"src":"/icon-192.png","sizes":"192x192","type":"image/png"},{"src":"/icon-512.png","sizes":"512x512","type":"image/png","purpose":"maskable"}],"theme_color":"#0a0a0a","background_color":"#0a0a0a","display":"standalone"}`.

---

## 8. Legal pages — DOC SOC-002 / SOC-003 / SOC-004

**Shared treatment.** Exact landing shell: same nav (running head reads `DOC SOC-002 · PRIVACY` / `SOC-003 · TERMS` / `SOC-004 · DATA DELETION`), same footer, same tokens. Content: 64ch measure, Inter 15px/1.6, numbered h2 ladder (`1. Scope` …), **exactly one star divider per page, zero other sketch, zero Caveat.** Motion: the ≤200ms view-transition fade only. Fully indexable, no auth, no JS dependency for content, BreadcrumbList JSON-LD. Sober documents in the same editorial voice — an App-Review asset, not boilerplate.

**`/privacy` (SOC-002).** Sections: 1. Scope (this website + the Socheli software) · 2. Data this website collects (`none — no analytics, no cookies, no tracking; verify in your network tab`) · 3. Data the software handles (OAuth tokens, generated media, flat JSON — all stored on the user's own devices) · 4. **Data we never hold** (your tokens, your media, your account credentials — there is no Socheli cloud storing user content) · 5. Third-party platforms (Meta/Google/TikTok per their own policies, via standard OAuth) · 6. Contact: contact@socheli.com.

**`/terms` (SOC-003).** 1. The software (AGPL-3.0 core; commercial extensions separate) · 2. Your responsibilities (your accounts, your content, platform ToS compliance) · 3. The gates (publishing requires your explicit approval; you operate the fleet) · 4. Warranty disclaimer (plain AGPL language) · 5. Changes · 6. Contact.

**`/data-deletion` (SOC-004) — lifted verbatim from the Night Studio spec (graft):**
1. **Data inventory** — a ruled table: OAuth tokens (flat JSON, your device) · generated media (your disk) · run/mission records (flat JSON, your device) · this website (nothing — no accounts, no analytics).
2. **Numbered deletion steps** — Step 1: revoke the app's access in your Meta/Google/TikTok account settings (exact menu paths). Step 2: delete the local `data/` directory (one command, printed). Step 3 (cloud-workspace users): emailed deletion request.
3. **Stated SLA**: deletion requests to contact@socheli.com are completed within 30 days; local deletion is immediate and under your control.
4. **"Data we never hold"** subsection restating the architecture.
5. Contact: contact@socheli.com.

---

## 9. File manifest

```
site/
├── index.html                  # DOC SOC-001 — full landing, CSS inlined, JSON-LD @graph + FAQPage
├── privacy/index.html          # DOC SOC-002 — BreadcrumbList JSON-LD
├── terms/index.html            # DOC SOC-003 — BreadcrumbList JSON-LD
├── data-deletion/index.html    # DOC SOC-004 — BreadcrumbList JSON-LD
├── 404.html                    # star with wandered spark — "PAGE NOT IN THIS DOCUMENT"
├── assets/
│   ├── js/manual.js            # ONE deferred file, <8KB: shared IO, folio swapper,
│   │                           #   copy buttons (✦ copied + spark detach), star fetch,
│   │                           #   magnetic colophon CTA, Firefox hairline fallback
│   ├── fonts/inter-400.woff2
│   ├── fonts/inter-600.woff2
│   ├── fonts/jbmono-400.woff2
│   ├── fonts/caveat-600.woff2  # subset to annotation glyphs
│   └── media/
│       ├── run-poster.avif     # <80KB, 9:16, ch. 4 poster
│       ├── run.mp4             # one real unretouched render, preload=none, click-to-load
│       └── storyboard-{1,2,3}.avif  # ch. 3 frames, explicit w/h
├── og.png                      # 1200×630, <300KB
├── logo-512.png                # Organization logo, solid #0a0a0a bg
├── favicon.svg                 # scheme-aware clean star
├── favicon.ico                 # 16/32/48
├── apple-touch-icon.png        # 180×180, solid bg
├── icon-192.png / icon-512.png # manifest icons (512 maskable)
├── site.webmanifest
├── robots.txt
├── sitemap.xml                 # 4 URLs, truthful lastmod only
└── llms.txt

art/                            # source-of-truth, not deployed
├── fig-2-loop.svg              # hand-drafted pipeline plate, baked rough paths, pathLength=1
├── fig-3-trust.svg             # trust-boundary plate
├── star-spark.svg              # the two-path mark, 3 fidelities
├── gate-circle.svg             # baked wobbly ellipse for the receipt
├── arrows-marginalia.svg       # the 2 Caveat-note arrows
├── bake-rough.html             # scratch page that runs rough.js once → copy paths out
└── SEEDS.md                    # fixed seed per asset (reloads never reshuffle)

scripts/
└── stamp.mjs                   # deploy-time only (~60 lines, node, no bundling):
                                #   measures total KB + request count → inlines colophon line,
                                #   stamps repo commit hash into footnote ◆¹,
                                #   refreshes GitHub-star static fallback,
                                #   updates sitemap lastmod on changed pages,
                                #   fires IndexNow ping
```

**Build acceptance checklist (engineer signs off before ship):**
1. Lighthouse 100×4 on mobile profile; CLS 0.00; LCP <1.0s; idle main-thread trace clean.
2. JS disabled → every section fully visible; Firefox → no blank states, discrete spark hops.
3. `prefers-reduced-motion` → strokes pre-drawn, spark docked, fades only.
4. 375px viewport: pipeline spread stacked, plates legible, no sticky breakage.
5. `curl -A facebookexternalhit https://socheli.com/privacy` → 200, full HTML.
6. Colophon KB/request numbers match DevTools exactly; footnote commit hash matches HEAD.
7. Grep deployed output for hostnames/IPs/emails (other than contact@socheli.com)/keys → zero hits; all reprinted artifacts are real runs, scrubbed.
8. Banned vocabulary audit: no "autopilot", "viral", "AI-powered", "10x", "revolutionize", superlatives, or exclamation marks anywhere.
9. Caveat count: exactly 4 on `/`, 0 elsewhere. Two-pass rough plates reviewed at 1× on a real display before motion work begins.

✦ END OF SPEC SOC-000