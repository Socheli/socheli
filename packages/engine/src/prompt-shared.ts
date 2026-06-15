/* Shared prompt fragments used by BOTH the shorts (stages.ts) and long-form
   (longform-chapter.ts) storyboard/script agents, so narration and b-roll
   guidance stay identical across the two pipelines. Pure strings + one pure
   deterministic seed helper — no pipeline state, no side effects. */

/* Numbers/acronyms read correctly + speakable clause shaping. The PIPELINE
   normalizes currency/percent and per-channel acronyms at synth time
   (normalizeForTTS), so the script must NOT pre-spell acronyms — that pollutes
   the on-screen captions. Just write naturally and speak-ably. */
export const SPEAKABLE = `SPEAKABLE NARRATION — every "say" line will be read aloud by a voice actor:
- Write numbers as a person would SAY them when it changes the reading (e.g. "nineteen seventy-one", "about twelve thousand"), not bare digits that get misread. Plain small numbers are fine as digits.
- One idea per breath: short clauses with natural commas where a speaker pauses. No nested subclauses, no em dashes, no parentheticals.
- Do NOT spell acronyms with spaces in the text (write "USDC", not "U S D C") — pronunciation is handled downstream; spaced letters would corrupt the captions.
- No "in this video", no meta narration, no AI clichés.`;

/* A small set of cinematographic "lenses". A video deterministically picks one
   as its visual through-line (seeded by topic/chapter) so different videos get
   different treatment language instead of the same look every time. */
const SHOT_LENSES = [
  "slow cinematic locked-off shots with shallow depth of field",
  "handheld documentary motion, real textures, natural light",
  "macro extreme close-ups of materials, hands, and surfaces",
  "wide establishing shots with strong negative space",
  "moody low-key interiors lit by a single source, deep shadows",
  "clean overhead / top-down compositions and geometry",
  "golden-hour exteriors with atmospheric haze",
  "high-contrast night scenes, practical neon and reflections",
];

const hashSeed = (s: string): number => {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
};

export const shotLensFor = (seed: string): string => SHOT_LENSES[hashSeed(seed) % SHOT_LENSES.length];

/* Generic AI-slop stock clichés to steer away from — these are the shots that
   make faceless videos look machine-made and interchangeable. */
const BROLL_BANNED =
  "AVOID generic AI-slop stock clichés: glowing blue digital brains, swirling binary or matrix code, a businessman pointing at floating charts, rotating globes or networks of glowing dots, a faceless hooded hacker, generic plexus particle backgrounds, stock handshakes.";

/* The full b-roll guidance block. Seed it per-video (topic) or per-chapter so
   the through-line and the no-repeat instruction are stable across re-renders. */
export const brollGuidance = (seed: string, footageStyle?: string): string => {
  // A mood with an explicit footageStyle (e.g. "cinematic") pins the through-line
  // so its look stays consistent; otherwise pick a seeded lens for per-video variety.
  const lens = footageStyle ?? shotLensFor(seed);
  return `VISUAL THROUGH-LINE for this video: favour ${lens}. Keep that look consistent, but every scene's "broll" query MUST be DISTINCT from the others — no repeats, no near-duplicates, vary subject and framing scene to scene. ${BROLL_BANNED}`;
};
