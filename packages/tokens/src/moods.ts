/* ─── Moods ──────────────────────────────────────────────────────────────
   A Mood is a named preset that retunes the WHOLE post at once — colour
   temperature + accent + grade, music BPM/energy, pacing, and content tone.
   Orthogonal to channel: any channel can use any mood. Resolved by both the
   engine (generation: music, voice, tone) and Remotion (render: grade, accent). */

export type GradeParams = {
  shadow: string; // soft-light shadow tint (cool lifts, warm warms)
  highlight: string; // radial highlight wash colour
  bloom: number; // 0..1 halation glow opacity
  edge: number; // 0..0.6 crushed-black vignette strength
  contrast: number; // global contrast multiplier on the image
  // ── M1 real-primaries seed (roadmap §4.1) ────────────────────────────────
  // OPTIONAL primary-colourist intent a mood/studio can carry so that the new
  // per-scene/global ColorGrade (lift/gamma/gain) can be SEEDED from the same
  // mood that already owns the gradient-overlay "look" above. All optional so
  // every legacy mood/studio (which sets none of these) still type-checks and
  // resolveStudio keeps preserving the existing look untouched.
  master?: number; // overall exposure-ish lift on master, ±1 (maps to gain.master ≈ 1+master)
  lift?: number; // shadow lift, ±1 (raises/crushes blacks)
  gamma?: number; // midtone gamma bias, ±1 (>0 brighter mids)
  temperature?: number; // ±100 — warm (+) / cool (−)
  tint?: number; // ±100 — magenta (+) / green (−)
  saturation?: number; // 0..3 absolute saturation (1 = neutral)
};

export type MotionProfile = {
  entrance: "fade_up" | "slam" | "dissolve" | "type" | "slide"; // how scene content enters
  pace: number; // multiplier on entrance duration (>1 slow/calm, <1 fast/punchy)
  transition: "fade" | "slide" | "wipe" | "slamzoom"; // default between-scene transition
};
export type TreatmentProfile = {
  letterbox: boolean; // cinematic bars
  scanlines: boolean; // CRT scanline overlay
  grainScale: number; // multiply the base grain
  bloomScale: number; // multiply the grade bloom
};

export type Mood = {
  id: string;
  name: string;
  blurb: string;
  // optional render THEME override (e.g. "ink_paper"). When set, a post using this
  // mood renders in that theme regardless of the channel's default theme — so a
  // single look (like the white ink sketchbook) is selectable from ANY channel.
  theme?: string;
  // visual
  accent: string; // hex — the single accent colour
  grade: GradeParams;
  grain: number; // 0..1 film-grain opacity
  beatIntensity: number; // 0..2 emphasis-punch scale
  damping: number; // transition spring damping (lower = snappier whip)
  motion: MotionProfile; // per-mood entrance + transition signature
  treatment: TreatmentProfile; // per-mood film treatment
  components: string[]; // scene types the storyboard agent should favour for this mood
  // audio + pacing
  bpm: [number, number];
  musicStyle: string; // instruments/energy descriptors fed to MusicGen
  voiceSpeed: number; // narration rate
  // content (generation tone)
  tone: string; // injected into hook/script prompts
  quotes: boolean; // weave in a real, attributed motivational quote
  // footage direction (b-roll). footageStyle pins the storyboard agent's visual
  // through-line (overrides the random per-video lens); footageSearch is short
  // extra terms appended to the stock-video search to bias what's actually
  // downloaded. Both optional — unset moods keep the seeded random lens.
  footageStyle?: string;
  footageSearch?: string;
  // When true, this mood is PURE motion graphics: the pipeline skips b-roll
  // resolution entirely and scenes render on clean generated backgrounds.
  noBroll?: boolean;
  // Per-mood transition cycle — cycled across scene boundaries when no studio-level
  // transitions override. Studio transitions take priority (see resolveStudio).
  transitions?: string[];
};

export const moods: Record<string, Mood> = {
  explainer: {
    id: "explainer",
    name: "Explainer",
    blurb: "Calm, premium, informative — one idea explained clearly.",
    accent: "#4f8ff7",
    grade: { shadow: "#0b141c", highlight: "rgba(255,226,188,0.5)", bloom: 0.5, edge: 0.34, contrast: 1.0 },
    grain: 0.06,
    beatIntensity: 0.9,
    damping: 200,
    motion: { entrance: "fade_up", pace: 1.0, transition: "fade" },
    treatment: { letterbox: true, scanlines: false, grainScale: 1.0, bloomScale: 1.0 },
    components: ["before_after", "kinetic_text", "big_number", "image_focus", "grid", "warning", "chart", "diagram", "timeline", "map"],
    bpm: [70, 90],
    musicStyle: "warm mellow lo-fi, soft piano and gentle pads, hopeful and light, major key, easy and pleasant, uplifting — NOT dark, dramatic, tense or eerie",
    voiceSpeed: 1.2,
    tone: "Clear, friendly, vivid plain-language. Explain one idea simply, never dumbed-down.",
    quotes: false,
  },
  motivational: {
    id: "motivational",
    name: "Motivational",
    blurb: "Energetic, warm, driving — push the viewer to act.",
    accent: "#ff8a3d",
    grade: { shadow: "#1a120a", highlight: "rgba(255,210,150,0.62)", bloom: 0.72, edge: 0.3, contrast: 1.16 },
    grain: 0.05,
    beatIntensity: 1.55,
    damping: 90,
    motion: { entrance: "slam", pace: 0.65, transition: "slamzoom" },
    treatment: { letterbox: true, scanlines: false, grainScale: 0.9, bloomScale: 1.3 },
    components: ["quote", "big_number", "kinetic_text", "warning", "hook_text"],
    bpm: [100, 128],
    musicStyle: "epic motivational build, driving drums, rising strings, cinematic and triumphant",
    voiceSpeed: 1.16,
    tone: "Bold, direct, second-person urgency. Short declarative punches that build momentum.",
    quotes: true,
  },
  business: {
    id: "business",
    name: "Business & Finance",
    blurb: "Authoritative, clean, data-forward.",
    accent: "#3ec98a",
    grade: { shadow: "#0a1318", highlight: "rgba(220,235,255,0.42)", bloom: 0.35, edge: 0.36, contrast: 1.1 },
    grain: 0.04,
    beatIntensity: 1.0,
    damping: 160,
    motion: { entrance: "slide", pace: 0.9, transition: "wipe" },
    treatment: { letterbox: true, scanlines: false, grainScale: 0.7, bloomScale: 0.9 },
    components: ["big_number", "before_after", "kinetic_text", "image_focus", "grid", "chart", "diagram", "timeline", "map"],
    bpm: [85, 100],
    musicStyle: "confident corporate, clean light electronic, steady and credible",
    voiceSpeed: 1.18,
    tone: "Authoritative and precise. Concrete numbers, credible framing, no hype.",
    quotes: false,
    noBroll: true,
    transitions: ["wipe", "slide", "wipe"],
  },
  tech: {
    id: "tech",
    name: "Tech & AI",
    blurb: "Sharp, electric, futuristic.",
    accent: "#3ad6ff",
    grade: { shadow: "#091018", highlight: "rgba(190,230,255,0.46)", bloom: 0.46, edge: 0.4, contrast: 1.12 },
    grain: 0.05,
    beatIntensity: 1.2,
    damping: 110,
    motion: { entrance: "type", pace: 0.95, transition: "wipe" },
    treatment: { letterbox: true, scanlines: true, grainScale: 1.0, bloomScale: 1.0 },
    components: ["terminal", "code_block", "kinetic_text", "big_number", "grid", "before_after", "diagram"],
    bpm: [105, 120],
    musicStyle: "futuristic synthwave, arpeggios, pulsing bass, crisp electronic",
    voiceSpeed: 1.2,
    tone: "Sharp, precise, forward-looking. Crisp technical clarity, no fluff.",
    quotes: false,
    noBroll: true,
    transitions: ["terminal_wipe", "wipe", "terminal_wipe"],
  },
  mindfulness: {
    id: "mindfulness",
    name: "Mindfulness",
    blurb: "Gentle, warm, spacious — slow and present.",
    accent: "#6fc7ba",
    grade: { shadow: "#15120c", highlight: "rgba(255,234,205,0.55)", bloom: 0.6, edge: 0.26, contrast: 0.95 },
    grain: 0.035,
    beatIntensity: 0.5,
    damping: 220,
    motion: { entrance: "dissolve", pace: 1.6, transition: "fade" },
    treatment: { letterbox: false, scanlines: false, grainScale: 0.6, bloomScale: 1.2 },
    components: ["image_focus", "quote", "kinetic_text", "big_number", "timeline"],
    bpm: [58, 72],
    musicStyle: "calm meditation, soft piano, warm pads, spacious and gentle, warm major key, soothing — never eerie or tense",
    voiceSpeed: 1.1,
    tone: "Gentle, warm, spacious, reassuring. Slow and present; let ideas breathe.",
    quotes: false,
  },
  // Cinematic — the "thought-leader reel" look (deep indigo cards intercut with
  // moody graded b-roll, phrase-by-phrase captions, fast hard cuts). Modelled on
  // premium agency reels: a bold intellectual hook → reframe → named mechanism →
  // numbered framework → one-line close.
  cinematic: {
    id: "cinematic",
    name: "Cinematic",
    blurb: "Premium, filmic, authoritative — moody b-roll + bold indigo cards.",
    accent: "#3a4ea3", // deep indigo (cards render near #2c3c72; this pops as the highlight)
    grade: { shadow: "#0a1024", highlight: "rgba(200,212,255,0.4)", bloom: 0.4, edge: 0.44, contrast: 1.18 },
    grain: 0.07,
    beatIntensity: 1.25,
    damping: 120, // snappy cuts
    motion: { entrance: "fade_up", pace: 0.7, transition: "fade" }, // quick, hard-cut feel
    treatment: { letterbox: true, scanlines: false, grainScale: 1.1, bloomScale: 1.0 },
    components: ["image_focus", "kinetic_text", "big_number", "quote", "hook_text", "before_after"],
    bpm: [70, 92],
    musicStyle: "cinematic ambient bed, deep sub pad, sparse piano, restrained tension and awe, modern documentary score — never busy, never eerie",
    voiceSpeed: 1.12,
    tone: "Authoritative, cinematic, thought-leader. Open on a bold intellectual hook (history, science, or philosophy), reframe the problem, anchor a named mechanism, deliver a tight numbered framework, close on a short memorable maxim. Second person, declarative.",
    quotes: true,
    footageStyle:
      "moody low-key CINEMATIC footage: shallow depth of field, single-source dramatic lighting, deep crushed shadows, slow deliberate camera moves, atmospheric haze, film grain, real human faces, hands and textures — emotive and filmic, never bright corporate stock or graphics",
    footageSearch: "cinematic moody",
    transitions: ["fade", "fade", "zoom"],
  },
  // Ops Room — Conflictly "Operations Room" visual language: dark tactical
  // intelligence briefing, satellite imagery, OPERATOR/COMMANDER dialogue,
  // teal/cyan accent on near-black, slow dissolves, ominous ambient score.
  ops_room: {
    id: "ops_room",
    name: "Ops Room",
    blurb: "Tactical intelligence briefing — dark, serialized, authoritative geopolitical analysis.",
    accent: "#00c9a7",
    grade: { shadow: "#050c0f", highlight: "rgba(0,180,150,0.18)", bloom: 0.28, edge: 0.52, contrast: 1.24 },
    grain: 0.055,
    beatIntensity: 0.82,
    damping: 185,
    motion: { entrance: "dissolve", pace: 1.25, transition: "fade" },
    treatment: { letterbox: true, scanlines: true, grainScale: 1.15, bloomScale: 0.65 },
    components: ["map", "image_focus", "kinetic_text", "big_number", "timeline", "chart", "dialogue", "terminal"],
    bpm: [60, 78],
    musicStyle: "ominous low-frequency military drone, sparse deep percussion, tactical tension — no melody, just dark atmosphere and cold rhythmic pulse",
    voiceSpeed: 1.08,
    tone: "Cold, authoritative, intelligence-briefing register. Voice of a seasoned geopolitical analyst delivering a classified operations briefing. Use the OPERATOR/COMMANDER dialogue format for critical reveals. Short declarative sentences. No opinion — only analysis, context, and consequence. Reference real events, specific dates, named actors. Serialized format: open with episode context, end with a hard briefing close.",
    quotes: false,
    footageStyle: "dark satellite imagery, tactical maps, military hardware, night-vision surveillance footage, command center interiors, aerial reconnaissance — cold surveillance aesthetic, near-monochrome",
    footageSearch: "satellite imagery military surveillance",
    noBroll: true,
    transitions: ["scan_wipe", "fade", "scan_wipe"],
  },
  // War Economy — ExLiq Media visual language: economic warfare analysis,
  // fast hard cuts, halftone newspaper aesthetic, high-contrast B&W + danger red,
  // stock charts as weapons, staccato newsroom energy.
  war_economy: {
    id: "war_economy",
    name: "War Economy",
    blurb: "Economic warfare analysis — fast cuts, newspaper halftone, high-contrast financial intelligence.",
    accent: "#e63946",
    grade: { shadow: "#08090a", highlight: "rgba(230,57,70,0.16)", bloom: 0.22, edge: 0.44, contrast: 1.3 },
    grain: 0.065,
    beatIntensity: 1.42,
    damping: 92,
    motion: { entrance: "slam", pace: 0.58, transition: "wipe" },
    treatment: { letterbox: true, scanlines: false, grainScale: 1.25, bloomScale: 0.72 },
    components: ["hook_text", "chart", "kinetic_text", "big_number", "image_focus", "warning", "before_after", "timeline"],
    bpm: [95, 118],
    musicStyle: "tense economic thriller, percussive newsroom energy, staccato strings, heavy industrial drums, urgent data-driven rhythm — no melody, only pressure",
    voiceSpeed: 1.28,
    tone: "Economic warfare journalist. Hard-hitting, data-first, adversarial framing. Lead with the number or the shock — cut to the mechanism immediately. Use precise financial and geopolitical terminology: sanctions, trade flows, GDP impact, supply chains as weapons. Short punchy sentences, like a Reuters flash alert turned editorial. Every claim has a number behind it.",
    quotes: false,
    footageStyle: "newspaper front pages, trading floor footage, stock ticker screens, economic charts, factory shutdowns, port congestion — halftone texture, high-contrast near-monochrome, harsh flash photography",
    footageSearch: "trading floor economic crisis newspaper",
    noBroll: true,
    transitions: ["smash", "smash", "wipe"],
  },
  // Motion Graphics — premium SaaS-explainer look: NO b-roll, pure animated
  // graphics (device mockups, bento grids, kinetic type, charts, diagrams).
  // Clean flat grade (minimal vignette/grain), crisp product accent, snappy
  // spring motion. The renderer skips footage entirely (noBroll).
  motion_graphics: {
    id: "motion_graphics",
    name: "Motion Graphics",
    blurb: "Premium SaaS-explainer — pure animated graphics, no footage. Clean, snappy, product-grade.",
    accent: "#6d5cff", // crisp product violet-blue
    grade: { shadow: "#0c0e1a", highlight: "rgba(220,224,255,0.32)", bloom: 0.28, edge: 0.18, contrast: 1.04 },
    grain: 0.025, // near-clean — graphics, not film
    beatIntensity: 1.15,
    damping: 130, // snappy springs
    motion: { entrance: "slide", pace: 0.7, transition: "slide" },
    treatment: { letterbox: false, scanlines: false, grainScale: 0.5, bloomScale: 0.8 },
    components: ["device_mockup", "bento", "stats", "compare", "kinetic_text", "big_number", "chart", "diagram", "before_after"],
    bpm: [100, 120],
    musicStyle: "clean modern tech, crisp light electronic, bright plucks and soft pads, confident and product-forward — never dark or eerie",
    voiceSpeed: 1.18,
    tone: "Crisp, confident, product-forward. Explain clearly with momentum; each scene shows one concrete UI, feature, or number. Second person.",
    quotes: false,
    noBroll: true,
  },
  // Ink — white editorial sketchbook: black ink on warm paper, typographic,
  // hand-drawn marks. Carries a THEME OVERRIDE (ink_paper) so ANY channel can
  // render in the white look via `--mood ink`. Pure typographic, no b-roll.
  ink: {
    id: "ink",
    name: "Ink",
    blurb: "White editorial sketchbook — black ink on warm paper, typographic, hand-drawn marks.",
    theme: "ink_paper",
    accent: "#14110c", // the ink itself is the accent (monochrome on paper)
    grade: { shadow: "#d8cfbc", highlight: "rgba(20,17,12,0.10)", bloom: 0.12, edge: 0.1, contrast: 1.02 },
    grain: 0.03,
    beatIntensity: 0.85,
    damping: 180,
    motion: { entrance: "fade_up", pace: 0.95, transition: "fade" },
    treatment: { letterbox: false, scanlines: false, grainScale: 0.6, bloomScale: 0.5 },
    components: ["hook_text", "before_after", "kinetic_text", "quote", "big_number", "image_focus", "cta"],
    bpm: [70, 92],
    musicStyle: "calm editorial, warm acoustic textures and soft piano, considered and tasteful, light — never dark or tense",
    voiceSpeed: 1.12,
    tone: "Considered, tasteful, quietly confident. Show the craft; one clear idea per scene, never hype.",
    quotes: false,
    noBroll: true,
  },
};

export const MOOD_IDS = Object.keys(moods);
export const DEFAULT_MOOD = "explainer";

/* ─── Mood mixtures ────────────────────────────────────────────────────────
   A mood "spec" is either a single id ("cinematic"), a WEIGHTED BLEND
   ("cinematic*0.7+tech*0.3", or "cinematic+tech" for equal parts), or a NAMED
   blend from MOOD_BLENDS ("saas") which expands to its underlying spec — and
   named blends compose, so "saas+mindfulness" or "saas*0.8+motivational*0.2"
   work too. Blending lets a post sit between cluster identities. Numeric fields
   lerp by weight; categorical fields (entrance/transition/letterbox/scanlines/
   quotes) take the DOMINANT (highest-weight) mood; components merge weighted;
   footage direction takes the strongest mood that defines it. getMood() parses a
   spec, so a mixture works everywhere a mood id flows — including the Remotion
   render side, because the normalised spec string round-trips deterministically. */
export type MoodPart = { id: string; weight: number };

/* Curated, named blends — first-class shortcuts for combinations worth reusing.
   They expand inside parseMoodSpec, so they're usable anywhere a mood id is and
   can themselves be mixed. Keep the right side to base mood ids. */
export const MOOD_BLENDS: Record<string, string> = {
  saas: "cinematic*0.6+tech*0.4", // premium SaaS-explainer: filmic base, electric pace
  founder: "cinematic*0.6+motivational*0.4", // thought-leader with drive
  docu: "cinematic*0.65+mindfulness*0.35", // slow, weighty documentary
  keynote: "business*0.55+cinematic*0.45", // data-forward but filmic
  geo_intel: "ops_room*0.7+cinematic*0.3", // serialized geopolitics: tactical briefing + filmic quality
  market_intel: "war_economy*0.65+business*0.35", // economic warfare: urgency + data credibility
  conflict: "ops_room*0.5+war_economy*0.5", // full-spectrum crisis: military + economic in equal measure
};

export function parseMoodSpec(spec?: string): MoodPart[] {
  const acc = new Map<string, number>();
  // expand a token into base-mood weight, following named blends (bounded depth).
  const add = (id: string, weight: number, depth: number): void => {
    if (weight <= 0) return;
    if (moods[id]) {
      acc.set(id, (acc.get(id) ?? 0) + weight);
    } else if (MOOD_BLENDS[id] && depth < 5) {
      for (const sub of normParts(MOOD_BLENDS[id])) add(sub.id, weight * sub.weight, depth + 1);
    }
    // unknown id → ignored
  };
  // parse one level of "a*w+b*w" into normalised parts (no expansion).
  function normParts(s: string): MoodPart[] {
    const raw: MoodPart[] = [];
    for (const tok of s.split("+").map((t) => t.trim()).filter(Boolean)) {
      const [id, w] = tok.split("*").map((t) => t.trim());
      const weight = w !== undefined && !Number.isNaN(parseFloat(w)) ? Math.max(0, parseFloat(w)) : 1;
      if (weight > 0) raw.push({ id, weight });
    }
    const t = raw.reduce((a, p) => a + p.weight, 0) || 1;
    return raw.map((p) => ({ id: p.id, weight: p.weight / t }));
  }

  for (const tok of (spec ?? "").split("+").map((s) => s.trim()).filter(Boolean)) {
    const [id, w] = tok.split("*").map((s) => s.trim());
    const weight = w !== undefined && !Number.isNaN(parseFloat(w)) ? Math.max(0, parseFloat(w)) : 1;
    add(id, weight, 0);
  }
  if (!acc.size) return [{ id: DEFAULT_MOOD, weight: 1 }];
  const sum = [...acc.values()].reduce((a, w) => a + w, 0);
  return [...acc.entries()].map(([id, w]) => ({ id, weight: w / sum }));
}

const _dominant = (parts: MoodPart[]): Mood => moods[parts.reduce((a, b) => (b.weight > a.weight ? b : a)).id];
const _lerp = (parts: MoodPart[], pick: (m: Mood) => number): number => parts.reduce((a, p) => a + pick(moods[p.id]) * p.weight, 0);
const _hex = (h: string): [number, number, number] => {
  const n = parseInt(h.replace("#", ""), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const _blendHex = (parts: MoodPart[], pick: (m: Mood) => string): string => {
  const [r, g, b] = parts.reduce(
    (a, p) => {
      const [r2, g2, b2] = _hex(pick(moods[p.id]));
      return [a[0] + r2 * p.weight, a[1] + g2 * p.weight, a[2] + b2 * p.weight];
    },
    [0, 0, 0] as [number, number, number],
  );
  const hx = (v: number) => Math.round(v).toString(16).padStart(2, "0");
  return `#${hx(r)}${hx(g)}${hx(b)}`;
};
const _blendRgba = (parts: MoodPart[], pick: (m: Mood) => string): string => {
  const comps = parts.reduce(
    (a, p) => {
      const m = pick(moods[p.id]).match(/[\d.]+/g)?.map(Number) ?? [255, 255, 255, 0.5];
      return [a[0] + m[0] * p.weight, a[1] + m[1] * p.weight, a[2] + m[2] * p.weight, a[3] + (m[3] ?? 1) * p.weight];
    },
    [0, 0, 0, 0],
  );
  return `rgba(${Math.round(comps[0])},${Math.round(comps[1])},${Math.round(comps[2])},${comps[3].toFixed(2)})`;
};

/* Synthesize one Mood from a parsed spec. A single part returns its base mood
   object unchanged (identity preserved, zero behaviour change). */
export function blendMoods(parts: MoodPart[]): Mood {
  if (parts.length === 1) return moods[parts[0].id];
  const dom = _dominant(parts);
  const N = (pick: (m: Mood) => number) => _lerp(parts, pick);
  // components: weighted union, ranked by summed weight (tiny rank penalty so a
  // mood's earlier-listed favourites still lead), de-duplicated.
  const score = new Map<string, number>();
  for (const p of parts) moods[p.id].components.forEach((c, i) => score.set(c, (score.get(c) ?? 0) + p.weight * (1 - i * 0.02)));
  // keep the favoured list focused — too many "preferred" types makes the
  // storyboard agent pick at random and lose the blend's character.
  const components = [...score.entries()].sort((a, b) => b[1] - a[1]).map(([c]) => c).slice(0, 9);
  const footPart = parts.filter((p) => moods[p.id].footageStyle).sort((a, b) => b.weight - a.weight)[0];
  const searchPart = parts.filter((p) => moods[p.id].footageSearch).sort((a, b) => b.weight - a.weight)[0];
  const secondaries = parts.filter((p) => moods[p.id].id !== dom.id && p.weight >= 0.2);
  return {
    id: parts.map((p) => `${p.id}*${p.weight.toFixed(2)}`).join("+"),
    name: parts.map((p) => moods[p.id].name).join(" × "),
    blurb: `Blend: ${parts.map((p) => `${moods[p.id].name} ${Math.round(p.weight * 100)}%`).join(", ")}.`,
    accent: _blendHex(parts, (m) => m.accent),
    grade: {
      shadow: _blendHex(parts, (m) => m.grade.shadow),
      highlight: _blendRgba(parts, (m) => m.grade.highlight),
      bloom: N((m) => m.grade.bloom),
      edge: N((m) => m.grade.edge),
      contrast: N((m) => m.grade.contrast),
    },
    grain: N((m) => m.grain),
    beatIntensity: N((m) => m.beatIntensity),
    damping: N((m) => m.damping),
    motion: { entrance: dom.motion.entrance, pace: N((m) => m.motion.pace), transition: dom.motion.transition },
    treatment: { letterbox: dom.treatment.letterbox, scanlines: dom.treatment.scanlines, grainScale: N((m) => m.treatment.grainScale), bloomScale: N((m) => m.treatment.bloomScale) },
    components,
    bpm: [Math.round(N((m) => m.bpm[0])), Math.round(N((m) => m.bpm[1]))],
    musicStyle: dom.musicStyle + (secondaries.length ? `, with elements of ${secondaries.map((p) => moods[p.id].musicStyle.split(",")[0]).join(" and ")}` : ""),
    voiceSpeed: N((m) => m.voiceSpeed),
    tone: dom.tone + (secondaries.length ? ` Blend in a touch of ${secondaries.map((p) => moods[p.id].name).join(" and ")} energy.` : ""),
    quotes: dom.quotes,
    theme: dom.theme, // theme override follows the dominant mood

    footageStyle: footPart ? moods[footPart.id].footageStyle : undefined,
    footageSearch: searchPart ? moods[searchPart.id].footageSearch : undefined,
    // a blend is pure motion-graphics only if its dominant mood is.
    noBroll: dom.noBroll,
    // transitions: dominant mood's cycle wins for blends.
    transitions: dom.transitions,
  };
}

const _moodCache = new Map<string, Mood>();
export const getMood = (id?: string): Mood => {
  if (id && moods[id]) return moods[id]; // base-mood fast path (unchanged)
  const key = id ?? "";
  const hit = _moodCache.get(key);
  if (hit) return hit;
  const m = blendMoods(parseMoodSpec(id));
  _moodCache.set(key, m);
  return m;
};

export const MOOD_BLEND_IDS = Object.keys(MOOD_BLENDS);

/* Everything a mood picker can offer: base moods + curated named blends. Each
   entry carries the resolved name/blurb so the UI needn't know the difference. */
export function listMoods(): { id: string; name: string; blurb: string; blend?: string }[] {
  return [
    ...MOOD_IDS.map((id) => ({ id, name: moods[id].name, blurb: moods[id].blurb })),
    ...MOOD_BLEND_IDS.map((id) => {
      const m = getMood(id);
      return { id, name: m.name, blurb: m.blurb, blend: MOOD_BLENDS[id] };
    }),
  ];
}

/* Convenience: mix two (or more) moods at a given ratio into a spec string.
   mixSpec(["cinematic","tech"], [0.7,0.3]) → "cinematic*0.7+tech*0.3". */
export function mixSpec(ids: string[], weights?: number[]): string {
  return ids.map((id, i) => `${id}*${(weights?.[i] ?? 1).toFixed(2)}`).join("+");
}

/* ─── Music profile per mood ────────────────────────────────────────────────
   So the procedural / safety beds stop being mood-blind. Differentiated ONLY by
   tonal centre (root Hz), tremolo movement, and brightness/lowpass cutoff — all
   voicings stay consonant major (root + maj3 + fifth + octave), so no mood ever
   reproduces the eerie/droney artifact. Calm moods sit low & dark & still;
   energetic moods sit higher, brighter, with more movement. */
export type MusicProfile = { root: number; tremHz: number; lowpass: number };
// NOTE: tremHz must stay >= 0.1 (ffmpeg tremolo's minimum frequency).
const MUSIC: Record<string, MusicProfile> = {
  explainer: { root: 110.0, tremHz: 0.1, lowpass: 2200 }, // A2, neutral
  business: { root: 98.0, tremHz: 0.1, lowpass: 2000 }, // G2, composed/low
  tech: { root: 130.81, tremHz: 0.14, lowpass: 2600 }, // C3, brighter/moving
  motivational: { root: 87.31, tremHz: 0.16, lowpass: 2400 }, // F2, warm & driving
  mindfulness: { root: 73.42, tremHz: 0.1, lowpass: 1600 }, // D2, deep & soft
  cinematic: { root: 65.41, tremHz: 0.1, lowpass: 1500 }, // C2, deep, dark, still ambient bed
  ops_room: { root: 41.2, tremHz: 0.1, lowpass: 1100 },   // E1, sub-bass ominous drone, very dark
  war_economy: { root: 110.0, tremHz: 0.2, lowpass: 2500 }, // A2, sharp percussive energy
  motion_graphics: { root: 130.81, tremHz: 0.16, lowpass: 2800 }, // C3, bright, crisp, moving
};
export const musicProfileFor = (id?: string): MusicProfile => {
  const parts = parseMoodSpec(id);
  if (parts.length === 1) return MUSIC[parts[0].id] ?? MUSIC.explainer;
  const w = (pick: (p: MusicProfile) => number) => parts.reduce((a, p) => a + pick(MUSIC[p.id] ?? MUSIC.explainer) * p.weight, 0);
  return { root: w((p) => p.root), tremHz: Math.max(0.1, w((p) => p.tremHz)), lowpass: Math.round(w((p) => p.lowpass)) };
};

/* ─── B-roll grade per mood ─────────────────────────────────────────────────
   The footage used to be crushed to a near-grayscale dark wash on EVERY mood
   ("grayscale technique everywhere"). Now each mood grades its b-roll with its
   own character: tech/motivational keep more colour and punch; mindfulness stays
   soft and desaturated. brightness floor 0.78 keeps burned-in captions legible. */
export type BrollGrade = { gray: number; bright: number; sat: number; con: number };
const BROLL_GRADE: Record<string, BrollGrade> = {
  explainer: { gray: 0.1, bright: 0.8, sat: 1.05, con: 1.06 },
  business: { gray: 0.08, bright: 0.82, sat: 1.06, con: 1.08 },
  tech: { gray: 0.05, bright: 0.84, sat: 1.12, con: 1.1 },
  motivational: { gray: 0.04, bright: 0.86, sat: 1.18, con: 1.12 },
  mindfulness: { gray: 0.14, bright: 0.78, sat: 0.95, con: 0.98 },
  cinematic: { gray: 0.12, bright: 0.8, sat: 0.9, con: 1.18 }, // desaturated, crushed, contrasty, cool
  ops_room: { gray: 0.42, bright: 0.72, sat: 0.55, con: 1.28 },  // heavy desaturation + crush, near surveillance BW + teal cast
  war_economy: { gray: 0.3, bright: 0.75, sat: 0.6, con: 1.35 }, // near-halftone, punchy contrast, newspaper aesthetic
  motion_graphics: { gray: 0.0, bright: 0.9, sat: 1.1, con: 1.05 }, // clean & bright (rarely used — noBroll)
};
export const brollGradeFor = (id?: string): BrollGrade => {
  const parts = parseMoodSpec(id);
  if (parts.length === 1) return BROLL_GRADE[parts[0].id] ?? BROLL_GRADE.explainer;
  const w = (pick: (g: BrollGrade) => number) => parts.reduce((a, p) => a + pick(BROLL_GRADE[p.id] ?? BROLL_GRADE.explainer) * p.weight, 0);
  return { gray: w((g) => g.gray), bright: w((g) => g.bright), sat: w((g) => g.sat), con: w((g) => g.con) };
};
export const brollFilter = (id?: string): string => {
  const g = brollGradeFor(id);
  return `grayscale(${g.gray}) contrast(${g.con}) brightness(${g.bright}) saturate(${g.sat})`;
};

/* ─── Per-DNA studio profiles ───────────────────────────────────────────────
   The MOOD sets the cluster identity (accent/pace/components); the STUDIO is the
   CHANNEL's directorial signature layered over it — motion personality, grade
   tint, film treatment, background character, transition grammar. Keyed by the
   render `theme` (lab/builder/concept/magma/cognitivx → 1:1 per channel).

   Every override is PARTIAL over the mood's full profile, so a field a studio
   omits always falls back to a real number — no NaN. `locked` studios own their
   brand accent (the mood hue must not stomp it); broad studios take the mood
   accent for per-cluster variety. resolveStudio is pure + deterministic. */
export type BgVariant = "grid" | "mesh" | "soft" | "memory" | "network" | "tactical" | "newsroom" | "network_tech" | "financial";

export type StudioProfile = {
  locked?: boolean; // brand accent wins over the mood hue
  motion?: Partial<MotionProfile>;
  beatIntensity?: number;
  damping?: number;
  grain?: number;
  grade?: Partial<GradeParams>;
  treatment?: Partial<TreatmentProfile>;
  tint?: string; // colour blended over the frame for a per-DNA cast
  tintOpacity?: number; // capped at 0.35 so it never reads as a colour gel
  tintBlend?: "soft-light" | "overlay";
  bloomHue?: string; // halation colour (replaces the hardcoded warm glow)
  bgVariant?: BgVariant;
  transitions?: string[]; // per-DNA transition cycle (overrides mood default)
};

export type ResolvedStudio = {
  accent: string;
  motion: MotionProfile;
  beatIntensity: number;
  damping: number;
  grain: number;
  grade: GradeParams;
  treatment: TreatmentProfile;
  tint?: string;
  tintOpacity: number;
  tintBlend: "soft-light" | "overlay";
  bloomHue?: string;
  bgVariant: BgVariant;
  transitions?: string[];
};

const studios: Record<string, StudioProfile> = {
  // Labrinox — clean modern flagship; mood drives, with a faint cool premium cast.
  concept: { tint: "#7fb0ff", tintOpacity: 0.09, tintBlend: "soft-light", bloomHue: "rgba(210,228,255,0.5)", bgVariant: "mesh" },
  // Code Labrinox — engineered/terminal: snappy type-on, scanlines, network field.
  lab: { locked: true, motion: { entrance: "type", transition: "wipe", pace: 0.9 }, treatment: { scanlines: true }, tint: "#ff9a3d", tintOpacity: 0.1, bloomHue: "rgba(255,210,170,0.5)", bgVariant: "network", transitions: ["wipe", "slide"] },
  // Agentic Builder — systems architect: calm slide, indigo cast, structured grid.
  builder: { motion: { entrance: "slide", transition: "wipe", pace: 1.05 }, tint: "#8a9bff", tintOpacity: 0.12, bloomHue: "rgba(200,210,255,0.5)", bgVariant: "grid" },
  // MoltJobs — industrial magma: slam, heavier grain + scanlines, warm halation.
  magma: { locked: true, motion: { entrance: "slam", transition: "slamzoom", pace: 0.7 }, treatment: { scanlines: true, grainScale: 1.25 }, grain: 0.06, tint: "#ff5a2a", tintOpacity: 0.16, tintBlend: "overlay", bloomHue: "rgba(255,150,90,0.55)", bgVariant: "network", transitions: ["slamzoom", "wipe"] },
  // iCog — quiet memoirist: slow dissolve, NO letterbox, soft grain, violet memory glow.
  cognitivx: { locked: true, motion: { entrance: "dissolve", transition: "fade", pace: 1.5 }, treatment: { letterbox: false, grainScale: 0.8 }, damping: 220, tint: "#8b5cf6", tintOpacity: 0.14, bloomHue: "rgba(160,140,255,0.5)", bgVariant: "memory", transitions: ["fade"] },
};

export function resolveStudio(themeName: string, mood: Mood, brandAccent: string): ResolvedStudio {
  const s = studios[themeName] ?? {};
  const moodBg: BgVariant = mood.id === "mindfulness" ? "soft" : mood.id === "ops_room" ? "tactical" : mood.id === "war_economy" ? "newsroom" : mood.id === "tech" ? "network_tech" : mood.id === "business" ? "financial" : "mesh";
  return {
    accent: s.locked ? brandAccent : mood.accent,
    motion: { ...mood.motion, ...s.motion },
    beatIntensity: s.beatIntensity ?? mood.beatIntensity,
    damping: s.damping ?? mood.damping,
    grain: s.grain ?? mood.grain,
    grade: { ...mood.grade, ...s.grade },
    treatment: { ...mood.treatment, ...s.treatment },
    tint: s.tint,
    tintOpacity: Math.min(0.35, s.tintOpacity ?? 0),
    tintBlend: s.tintBlend ?? "soft-light",
    bloomHue: s.bloomHue,
    bgVariant: s.bgVariant ?? moodBg,
    transitions: s.transitions ?? mood.transitions,
  };
}

/* ─── Sub-moods (chapter-level, for long-form) ─────────────────────────────
   A long-form video's base MOOD sets the visual identity (accent/grade/voice).
   Each CHAPTER gets a SUB-MOOD that shapes its purpose, 16:9 layout bias,
   pacing, and preferred scene types — so chapters vary and never feel monotone. */
export type SubMood = {
  id: string;
  name: string;
  purpose: string; // guidance for the outline + chapter agents
  layout: "hero" | "fullbleed" | "split" | "data"; // 16:9 layout bias
  pace: number; // target average seconds per scene
  components: string[]; // scene types this sub-mood favours
};

export const subMoods: Record<string, SubMood> = {
  hook: { id: "hook", name: "Hook", purpose: "Open with a provocative question or claim that frames the whole video.", layout: "hero", pace: 3.5, components: ["hook_text", "big_number", "image_focus", "quote", "kinetic_text"] },
  context: { id: "context", name: "Context", purpose: "Set up the background and why this matters now.", layout: "fullbleed", pace: 4.5, components: ["kinetic_text", "image_focus", "timeline", "before_after", "map"] },
  mechanism: { id: "mechanism", name: "Mechanism", purpose: "Explain HOW it actually works, step by step.", layout: "data", pace: 5.0, components: ["diagram", "chart", "grid", "kinetic_text", "before_after"] },
  evidence: { id: "evidence", name: "Evidence", purpose: "Prove it with data, numbers, and concrete comparisons.", layout: "data", pace: 5.0, components: ["chart", "big_number", "grid", "before_after", "timeline"] },
  case_study: { id: "case_study", name: "Case study", purpose: "Ground it in one concrete real example or story.", layout: "fullbleed", pace: 4.5, components: ["image_focus", "before_after", "quote", "kinetic_text", "big_number"] },
  counterpoint: { id: "counterpoint", name: "Counterpoint", purpose: "The catch, the objection, what most people get wrong.", layout: "split", pace: 4.5, components: ["warning", "before_after", "kinetic_text", "quote"] },
  implication: { id: "implication", name: "Implication", purpose: "Zoom out: what this means and where it leads.", layout: "hero", pace: 5.0, components: ["kinetic_text", "big_number", "image_focus", "map", "quote"] },
  payoff: { id: "payoff", name: "Payoff", purpose: "Land the through-line and the one thing to remember.", layout: "hero", pace: 5.5, components: ["quote", "section_summary", "kinetic_text", "big_number", "cta"] },
};
export const SUBMOOD_IDS = Object.keys(subMoods);
export const getSubMood = (id?: string): SubMood => subMoods[id ?? ""] ?? subMoods.context;

/* ─── Named grade presets → ColorGrade (roadmap §4.1) ───────────────────────
   The Colorist subsystem (§4.1) replaces advisory-only `colorIntent` prose with
   a real, validated per-scene / global grade. The BRAIN should be able to reach
   for a *named intent* ("teal_orange", "warm_film") and get back structured
   primaries (numbers), not prose — so a render can apply real lift/gamma/gain.

   `gradeToColorGrade()` is the token-side mapping for that. Its output is —
   STRUCTURALLY — a `@os/schemas` ColorGrade (per roadmap §107):
     { lift, gamma, gain } each { r, g, b, master }, plus
       temperature/tint ±100, saturation 0..3, contrast 0..3, pivot ~0.435,
       exposure ±2.
   We MIRROR that field shape here as `ColorGradeShape` rather than importing
   `@os/schemas` — tokens is a leaf design package and must not take an upward
   dependency on schemas (which would create a cycle: schemas-creative work
   reads tokens). The numbers are the contract; the consumer (edl bridge / the
   render `GradePipeline`) re-parses through the real zod ColorGrade at its edge.

   Presets are deliberately RESTRAINED — the brand is dark/cinematic with one
   accent, so a "grade" here is a tasteful primary push, never a LUT-bomb. Bands
   match the schema (§107): lift/gamma/gain channels ~0.5..1.5 around 1 (gain) or
   ±0.2 (lift), temperature/tint ±100, saturation 0..3, contrast 0..3. */

type GradeChannel = { r: number; g: number; b: number; master: number };
export type ColorGradeShape = {
  lift: GradeChannel; // intercept lift per channel — additive, ±0.2 sane band
  gamma: GradeChannel; // midtone exponent per channel — 1 = neutral
  gain: GradeChannel; // slope/gain per channel — 1 = neutral
  temperature: number; // ±100 warm(+) / cool(−)
  tint: number; // ±100 magenta(+) / green(−)
  saturation: number; // 0..3, 1 = neutral
  contrast: number; // 0..3, 1 = neutral
  pivot: number; // contrast pivot, ~0.435 (scene-linear mid-grey)
  exposure: number; // ±2 stops, master exposure trim
};

// Neutral identity grade — every preset is authored as a sparse delta merged
// over this so a partial author only states what it changes (no NaN, no
// half-defined channels).
const NEUTRAL_GRADE: ColorGradeShape = {
  lift: { r: 0, g: 0, b: 0, master: 0 },
  gamma: { r: 1, g: 1, b: 1, master: 1 },
  gain: { r: 1, g: 1, b: 1, master: 1 },
  temperature: 0,
  tint: 0,
  saturation: 1,
  contrast: 1,
  pivot: 0.435,
  exposure: 0,
};

type DeepPartialGrade = {
  lift?: Partial<GradeChannel>;
  gamma?: Partial<GradeChannel>;
  gain?: Partial<GradeChannel>;
  temperature?: number;
  tint?: number;
  saturation?: number;
  contrast?: number;
  pivot?: number;
  exposure?: number;
};

export type GradePresetId =
  | "neutral"
  | "teal_orange"
  | "cool_crush"
  | "warm_film"
  | "high_contrast"
  | "muted_cinematic";

/* The restrained premium set. Authored as deltas over NEUTRAL_GRADE.
   - teal_orange: the classic complementary push — warm skin/highs, teal shadows.
   - cool_crush:  cold, crushed blacks, slightly desaturated — surveillance/ops.
   - warm_film:   gentle warm filmic lift, soft lifted blacks, kept-down sat.
   - high_contrast: punchy contrast about pivot, neutral hue, modest sat.
   - muted_cinematic: low-sat, lifted-then-rolled blacks, calm flat filmic. */
export const GRADE_PRESETS: Record<GradePresetId, DeepPartialGrade> = {
  neutral: {},
  teal_orange: {
    lift: { r: -0.01, b: 0.03 }, // teal-bias the shadows
    gain: { r: 1.05, b: 0.96 }, // warm the highlights
    temperature: 14,
    saturation: 1.08,
    contrast: 1.06,
  },
  cool_crush: {
    lift: { r: -0.02, g: -0.01, b: 0.02, master: -0.02 }, // crush + cool the blacks
    gain: { b: 1.04 },
    temperature: -22,
    tint: -4,
    saturation: 0.82,
    contrast: 1.16,
  },
  warm_film: {
    lift: { r: 0.02, b: -0.01, master: 0.015 }, // soft lifted, warm blacks
    gamma: { master: 1.04 },
    gain: { r: 1.03, b: 0.98 },
    temperature: 18,
    tint: 3,
    saturation: 0.94,
    contrast: 1.02,
  },
  high_contrast: {
    saturation: 1.04,
    contrast: 1.34,
    gain: { master: 1.04 },
    lift: { master: -0.015 }, // deepen blacks for the punch
  },
  muted_cinematic: {
    lift: { master: 0.02, b: 0.01 }, // gentle lifted blacks, faint cool
    gamma: { master: 0.98 },
    saturation: 0.78,
    temperature: -6,
    contrast: 1.08,
  },
};
export const GRADE_PRESET_IDS = Object.keys(GRADE_PRESETS) as GradePresetId[];

// Schema bands (§107) — clamp at the edge so a hand-written preset, a blended
// result, or a mood seed can never emit an out-of-band number. Mirrors the
// engine's bridge discipline (clamp to band, never throw).
const cl = (v: number, lo: number, hi: number) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : (lo + hi) / 2);
const clampLift = (c: GradeChannel): GradeChannel => ({ r: cl(c.r, -0.2, 0.2), g: cl(c.g, -0.2, 0.2), b: cl(c.b, -0.2, 0.2), master: cl(c.master, -0.2, 0.2) });
const clampMul = (c: GradeChannel): GradeChannel => ({ r: cl(c.r, 0.4, 1.6), g: cl(c.g, 0.4, 1.6), b: cl(c.b, 0.4, 1.6), master: cl(c.master, 0.4, 1.6) });

const mergeChannel = (base: GradeChannel, over?: Partial<GradeChannel>): GradeChannel => ({
  r: over?.r ?? base.r,
  g: over?.g ?? base.g,
  b: over?.b ?? base.b,
  master: over?.master ?? base.master,
});

// Apply a mood's OPTIONAL primary seed (GradeParams §4.1 fields) as a delta over
// a base grade. Lets `gradeToColorGrade(intent, mood)` carry the mood's primary
// character into a named preset without the mood having to restate channels.
function applyMoodSeed(g: ColorGradeShape, mood?: Partial<GradeParams>): ColorGradeShape {
  if (!mood) return g;
  const out: ColorGradeShape = { ...g, lift: { ...g.lift }, gamma: { ...g.gamma }, gain: { ...g.gain } };
  if (typeof mood.lift === "number") out.lift.master += mood.lift * 0.2; // ±1 → ±0.2 band
  if (typeof mood.gamma === "number") out.gamma.master *= 1 + mood.gamma * 0.25; // ±1 → ×0.75..1.25
  if (typeof mood.master === "number") out.gain.master *= 1 + mood.master * 0.2; // exposure-ish master gain
  if (typeof mood.temperature === "number") out.temperature += mood.temperature;
  if (typeof mood.tint === "number") out.tint += mood.tint;
  if (typeof mood.saturation === "number") out.saturation = mood.saturation; // absolute, mood wins
  // mood.contrast is the gradient-overlay look multiplier; fold it gently in.
  if (typeof (mood as GradeParams).contrast === "number" && (mood as GradeParams).contrast > 0) {
    out.contrast *= (mood as GradeParams).contrast;
  }
  return out;
}

/**
 * Map a named grade intent (a `GradePresetId`, or any unknown string → neutral)
 * to a structured grade. The result is STRUCTURALLY a `@os/schemas` ColorGrade
 * (lift/gamma/gain · temperature/tint/saturation/contrast/pivot/exposure), all
 * clamped to the schema bands (§107) so the consumer can parse it through the
 * real zod ColorGrade without rejection.
 *
 * @param intent  named preset id (unknown ⇒ "neutral")
 * @param mood    OPTIONAL mood/studio primary seed (GradeParams §4.1 optional
 *                fields) whose primary character is layered onto the preset.
 */
export function gradeToColorGrade(intent?: GradePresetId | string, mood?: Partial<GradeParams>): ColorGradeShape {
  const preset = GRADE_PRESETS[(intent ?? "neutral") as GradePresetId] ?? GRADE_PRESETS.neutral;
  let g: ColorGradeShape = {
    ...NEUTRAL_GRADE,
    lift: mergeChannel(NEUTRAL_GRADE.lift, preset.lift),
    gamma: mergeChannel(NEUTRAL_GRADE.gamma, preset.gamma),
    gain: mergeChannel(NEUTRAL_GRADE.gain, preset.gain),
    temperature: preset.temperature ?? NEUTRAL_GRADE.temperature,
    tint: preset.tint ?? NEUTRAL_GRADE.tint,
    saturation: preset.saturation ?? NEUTRAL_GRADE.saturation,
    contrast: preset.contrast ?? NEUTRAL_GRADE.contrast,
    pivot: preset.pivot ?? NEUTRAL_GRADE.pivot,
    exposure: preset.exposure ?? NEUTRAL_GRADE.exposure,
  };
  g = applyMoodSeed(g, mood);
  // Clamp every field to its schema band before handing back.
  return {
    lift: clampLift(g.lift),
    gamma: clampMul(g.gamma),
    gain: clampMul(g.gain),
    temperature: cl(g.temperature, -100, 100),
    tint: cl(g.tint, -100, 100),
    saturation: cl(g.saturation, 0, 3),
    contrast: cl(g.contrast, 0, 3),
    pivot: cl(g.pivot, 0.1, 0.9),
    exposure: cl(g.exposure, -2, 2),
  };
}
