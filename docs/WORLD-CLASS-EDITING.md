# World-Class Short-Form Editing — Build Spec

Distilled from 4 cross-verified deep-research passes (captions, music/audio, retention
editing craft, AI-editor landscape). Every number here is implementable on our
Remotion + ffmpeg stack. Confidence flags inline. Frame = 1080×1920 @ 30fps.

This is the gap between "auto-captioned trim" and "reads professionally produced."

---

## 1. CAPTIONS — pick a SCHOOL, then nail the specs

The #1 finding: there is no single world-class look — there are **two opposed schools**,
and amateur captions die *between* them. Ship both as presets; default per content type.

- **School A — Clean / Hormozi / Iman (business, pitch, education):** heavy font, ALL-CAPS
  or clean lowercase, near-zero animation (snap, ≤1.05× scale), white text, ONE keyword
  colored. The 2024–26 meta moved *toward* this. Bouncy-yellow-everything is now the
  amateur tell.
- **School B — Springy / MrBeast (entertainment):** spring scale-in 0.8→1.0 overshoot,
  green/yellow keyword + glow, SFX.

**Codeable constants (high confidence):**
- Font: **Montserrat 900 / Anton / Bebas Neue / TheBoldFont** (Montserrat = 61% of 2M
  analyzed videos). Weight 800–900 for caps, 600–800 sentence-case.
- Size: **80–120px (~10–15% of frame height)**; amateur captions are almost always too small.
- Stroke: **2–3px normal, 8–12px (≈0.2em) for the big Hormozi look**, black `#000`.
- Color: white `#FFFFFF` fill; ONE keyword/phrase in **`#f7c204` gold** or `#FFD93D`, or
  green `#39FF14`. Highlight must contrast text AND background. Never colour every word.
- Reveal: **word-by-word or 3–5 word phrase, synced to speech, 200–500ms/word**, hold
  phrase 1.2–3s. Static full-sentence blocks = dead.
- Spring (our stack): **Remotion `spring({damping:10, mass:0.5})`** = "snappy, not bouncy".
  CSS entrance: `cubic-bezier(0.16,1,0.3,1)`, 200–300ms.
- On screen: **1–3 words/beat or ≤4–6 words / 2 lines.**
- Position: centered, baseline **25–35% from bottom**, inside the **900×1400** universal
  safe box, NEVER bottom 15–20% (platform UI) and never over the face (lower-third default,
  upper-third fallback when face is low).
- Emphasis heuristic: meaning-bearing **noun/verb + numbers + proper names**, biased to the
  **vocally-stressed** word.
- Extras (last, sparingly): ONE context emoji per phrase; optional active-word pill; curated
  whoosh/pop SFX on emphasis lines only (NOT every word).

## 2. MUSIC & AUDIO — currently absent; biggest single jump

- **Add an instrumental bed at all.** Instrumental only (sung lyrics fight the VO — proven
  mechanism). BPM by content: interview 60–90, **pitch/explainer 100–120**, hype 120–180.
- **Levels (dBFS):** VO peak ~−6; music bed ~−16 in no-talk gaps; **duck to ~−26 under
  speech** (WCAG 1.4.7: non-speech ≥20 dB under speech).
- **Sidechain duck under VO:** ratio 4:1, attack ~15ms, release ~300ms, **6–10 dB** gain
  reduction. (Don't hardcode −24dB — use −12 to −18.)
- **Frequency-carve:** high-pass bed ~120Hz, −2 to −4 dB dip at 1–3kHz so it never masks speech.
- **Master to −14 LUFS / −1 dBTP** (cross-platform safe; we already master to −14).
- **Energy curve:** bed UP in sentence gaps / b-roll / outro, DOWN under dense speech;
  build to the payoff.
- SFX: whoosh on topic transitions only (−12 to −18 dBFS, synced to the cut); riser→impact
  into the payoff. ≤3–5 simultaneous audio layers. Never SFX every cut.

## 3. EDITING / RETENTION — make it feel "scored," not trimmed

- **Pacing governor:** a visual change (cut / punch-in / b-roll / caption pop) **every 2–4s**
  (body), 1.5–2s high-energy; clamp **5–7 changes / 10s**; hard-fail any static element >5–8s.
- **Emphasis punch-ins:** on the vocally-stressed word, **108–120% eased (8–15 frames,
  ease-in-out)**; ≤3 big zooms/min, ≥6–8s apart, jittered (even spacing = robotic tell).
- **Silence/filler removal:** cut gaps >300–500ms + um/uh/like/you-know/so/actually; keep
  ~80–150ms pad/side; 2-frame audio crossfade at splices; "avoid harsh cuts" guard. (We have
  `tightenFootage` — extend it.)
- **J/L cuts** (audio leads/trails picture) as the default cut style — the single biggest
  "premium" upgrade over butt-cuts.
- **Keyword b-roll, "show what's named":** transcript→entity→clip, 1.5–2.5s each, pre-rolled
  0.2–0.5s before the word, ≤30–40% of runtime, per-keyword cooldown, speaker audio continuous.
- **Hook (first 1–3s):** in-media-res first frame (no logo), 2–3 micro-cuts (0.3–1.2s), ≤7-word
  text hook on screen by sec 1 / held 2–4s; whole hook done by ~2.5s.
- **Beat-sync:** snap hard cuts + zoom-punch final frame to **downbeats**; place the cut/zoom
  **1–2 frames BEFORE the beat** (anticipation). `frames_per_beat = fps*60/BPM`.
- **Ken Burns** on stills/b-roll: 5–10% drift, eased, constant direction.
- Hard cuts default; kill flashy whip/spin transitions unless motivated (then + whoosh).

## 4. LANDSCAPE — table-stakes we must match, gaps we can win

Table-stakes every serious AI editor ships: animated word-captions, AI highlight/clip pick,
auto-reframe + speaker track, silence/filler removal, caption templates + brand styling,
stock b-roll/music/SFX, multi-aspect export + publish.

Differentiators only the best have: multimodal scene understanding (Opus ClipAnything),
chat-first agentic re-edit (Odysser, Descript Underlord), auto motion-graphics w/o keyframing
(Odysser), premium animated captions + beat-synced zooms + auto-SFX (Captions, Submagic),
grammar-aware/intentional-pause cutting (Gling), steerable reviewable AI decisions (AutoCut).

Biggest market complaints = our wedge: (1) bad context-blind clip selection, (2) robotic/
irrelevant b-roll, (3) caption errors/clutter, (4) unreliable virality scores, (5) black-box/
no steerability. A tool with scene-level understanding + steerable chat re-edit + real
per-element control + genuinely relevant b-roll hits the top 5 at once — no competitor does all four.

---

## BUILD ORDER (impact × tractability on our stack)

1. **Music bed + auto-duck on the footage/edit path** — fixes "there is no music". We have
   `ensureMusic` + `duckMusic`; wire an instrumental bed into `buildFootageAudio` with sidechain
   ducking + −14 LUFS master.
2. **Caption spec to School A** — heavier font (Anton/Montserrat-900), size to 80–120px,
   8–12px stroke for big looks, confirm ONE keyword/phrase, spring(damping 10, mass 0.5),
   ≤4–6 words. (Stroke + lower-third + choreography already shipped.)
3. **Emphasis punch-ins** — RMS/pitch peak per word → 110–118% eased zoom on the spine clip,
   jittered, ≤3/min.
4. **Beat-sync** — analyzeMusic already yields beats; snap cuts/zoom-final-frame to downbeats,
   1–2 frames early.
5. **Keyword b-roll over the talking head** — entity extraction → footage → 1.5–2.5s inserts,
   audio continuous.
6. **Hook engine + pacing governor** — enforce the cadence + a templated hook.

Sources: ~150 cross-verified URLs across the 4 research passes (Submagic/Opus/Captions/AutoCut
docs, creator breakdowns, WCAG 1.4.7, Remotion caption builds, izotope mastering, beat-edit guides).
