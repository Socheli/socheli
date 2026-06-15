/* Per-DNA typography. Each channel theme (tokens/video.ts → themes[].font) gets
   its OWN typeface pairing so the channels read as different studios, not one
   template recoloured. Families are loaded here at module import so they resolve
   during render; the CSS family strings in tokens reference these names. */
import { delayRender, continueRender } from "remotion";
import { loadFont as loadSaira } from "@remotion/google-fonts/SairaSemiCondensed";
import { loadFont as loadInter } from "@remotion/google-fonts/Inter";
import { loadFont as loadJetBrains } from "@remotion/google-fonts/JetBrainsMono";
import { loadFont as loadSora } from "@remotion/google-fonts/Sora";
import { loadFont as loadSpaceGrotesk } from "@remotion/google-fonts/SpaceGrotesk";
import { loadFont as loadSpaceMono } from "@remotion/google-fonts/SpaceMono";
import { loadFont as loadManrope } from "@remotion/google-fonts/Manrope";
import { loadFont as loadArchivo } from "@remotion/google-fonts/Archivo";
import { loadFont as loadFraunces } from "@remotion/google-fonts/Fraunces";
import { loadFont as loadNewsreader } from "@remotion/google-fonts/Newsreader";
// Additional fonts for mood-specific display overrides
import { loadFont as loadOswald } from "@remotion/google-fonts/Oswald";
import { loadFont as loadCormorant } from "@remotion/google-fonts/CormorantGaramond";
import { loadFont as loadIBMPlexMono } from "@remotion/google-fonts/IBMPlexMono";
import { loadFont as loadDMSans } from "@remotion/google-fonts/DMSans";
import { loadFont as loadExo2 } from "@remotion/google-fonts/Exo2";
import { loadFont as loadBarlowCondensed } from "@remotion/google-fonts/BarlowCondensed";
// World-class caption display faces (docs/WORLD-CLASS-EDITING.md §1): Anton = heavy
// single-weight caps (School A / Hormozi-clean); Montserrat 900 = the springy School B.
import { loadFont as loadAnton } from "@remotion/google-fonts/Anton";
import { loadFont as loadMontserrat } from "@remotion/google-fonts/Montserrat";

const saira = loadSaira("normal", { weights: ["300", "400", "500", "600"], subsets: ["latin"] });
const inter = loadInter("normal", { weights: ["400", "500", "600", "700"], subsets: ["latin"] });
const jb = loadJetBrains("normal", { weights: ["400", "500", "600"], subsets: ["latin"] });
const sora = loadSora("normal", { weights: ["400", "500", "600", "700", "800"], subsets: ["latin"] });
const spaceG = loadSpaceGrotesk("normal", { weights: ["400", "500", "600", "700"], subsets: ["latin"] });
const spaceM = loadSpaceMono("normal", { weights: ["400", "700"], subsets: ["latin"] });
const manrope = loadManrope("normal", { weights: ["400", "500", "600", "700", "800"], subsets: ["latin"] });
const archivo = loadArchivo("normal", { weights: ["500", "600", "700", "800", "900"], subsets: ["latin"] });
const fraunces = loadFraunces("normal", { weights: ["400", "500", "600", "700"], subsets: ["latin"] });
const newsreader = loadNewsreader("normal", { weights: ["400", "500", "600"], subsets: ["latin"] });
const oswald = loadOswald("normal", { weights: ["400", "600", "700"], subsets: ["latin"] });
const cormorant = loadCormorant("normal", { weights: ["400", "600", "700"], subsets: ["latin"] });
const ibmPlexMono = loadIBMPlexMono("normal", { weights: ["400", "700"], subsets: ["latin"] });
const dmSans = loadDMSans("normal", { weights: ["400", "500", "700"], subsets: ["latin"] });
const exo2 = loadExo2("normal", { weights: ["400", "600", "700", "800"], subsets: ["latin"] });
const barlowCondensed = loadBarlowCondensed("normal", { weights: ["400", "600", "700", "800", "900"], subsets: ["latin"] });
const anton = loadAnton("normal", { weights: ["400"], subsets: ["latin"] }); // Anton ships a single heavy weight
const montserrat = loadMontserrat("normal", { weights: ["700", "800", "900"], subsets: ["latin"] });

/* Family names, exported so tokens can reference the exact loaded family. */
export const FONTS = {
  saira: saira.fontFamily,
  inter: inter.fontFamily,
  mono: jb.fontFamily,
  sora: sora.fontFamily,
  spaceGrotesk: spaceG.fontFamily,
  spaceMono: spaceM.fontFamily,
  manrope: manrope.fontFamily,
  archivo: archivo.fontFamily,
  fraunces: fraunces.fontFamily,
  newsreader: newsreader.fontFamily,
  oswald: oswald.fontFamily,
  cormorant: cormorant.fontFamily,
  ibmPlexMono: ibmPlexMono.fontFamily,
  dmSans: dmSans.fontFamily,
  exo2: exo2.fontFamily,
  barlowCondensed: barlowCondensed.fontFamily,
  anton: anton.fontFamily,
  montserrat: montserrat.fontFamily,
  // back-compat aliases
  display: saira.fontFamily,
  sans: inter.fontFamily,
};

/* World-class CAPTION fonts by school (docs/WORLD-CLASS-EDITING.md §1). The Karaoke
   component overrides the per-mood display face with one of these for captions only. */
export const CAPTION_FONTS = {
  clean: `'${anton.fontFamily}', '${archivo.fontFamily}', system-ui, sans-serif`, // School A — Anton caps
  springy: `'${montserrat.fontFamily}', '${archivo.fontFamily}', system-ui, sans-serif`, // School B — Montserrat 900
} as const;
export const captionFontFor = (school: "clean" | "springy"): string => CAPTION_FONTS[school];

/* Per-mood display font overrides — each maps to the loaded fontFamily CSS string.
   Falls back to Space Grotesk (modern, broadly premium) for unmapped moods. */
export const MOOD_DISPLAY_FONTS: Record<string, string> = {
  // ops_room: tactical intelligence — Space Grotesk (geometric, authoritative)
  ops_room: spaceG.fontFamily,
  // war_economy: newsroom impact — Oswald (condensed, aggressive)
  war_economy: oswald.fontFamily,
  // cinematic: editorial elegance — Cormorant Garamond (serif, premium)
  cinematic: cormorant.fontFamily,
  // tech: terminal engineering — Space Mono for display
  tech: spaceM.fontFamily,
  // business: modern financial — DM Sans (clean, readable)
  business: dmSans.fontFamily,
  // motion_graphics: clean geometric — Manrope (modern, expressive)
  motion_graphics: manrope.fontFamily,
  // mindfulness: elegant serif — Cormorant Garamond
  mindfulness: cormorant.fontFamily,
};

/* Per-mood mono font overrides for data/terminal/teletype text. */
export const MOOD_MONO_FONTS: Record<string, string> = {
  ops_room: ibmPlexMono.fontFamily,
  war_economy: ibmPlexMono.fontFamily,
  tech: ibmPlexMono.fontFamily,
  // cinematic subtitles stay clean with Inter
  cinematic: inter.fontFamily,
};

export const DEFAULT_DISPLAY_FONT = spaceG.fontFamily;
export const DEFAULT_MONO_FONT = ibmPlexMono.fontFamily;
export const DEFAULT_SANS_FONT = inter.fontFamily;

/** Get the display font for a mood (or default). */
export function getMoodDisplayFont(moodId?: string): string {
  return (moodId && MOOD_DISPLAY_FONTS[moodId]) ?? DEFAULT_DISPLAY_FONT;
}

/** Get the mono font for a mood (for data/terminal/teletype text). */
export function getMoodMonoFont(moodId?: string): string {
  return (moodId && MOOD_MONO_FONTS[moodId]) ?? DEFAULT_MONO_FONT;
}

export const waitForFonts = () =>
  Promise.all([
    saira.waitUntilDone(), inter.waitUntilDone(), jb.waitUntilDone(), sora.waitUntilDone(),
    spaceG.waitUntilDone(), spaceM.waitUntilDone(), manrope.waitUntilDone(),
    archivo.waitUntilDone(), fraunces.waitUntilDone(), newsreader.waitUntilDone(),
    oswald.waitUntilDone(), cormorant.waitUntilDone(), ibmPlexMono.waitUntilDone(),
    dmSans.waitUntilDone(), exo2.waitUntilDone(), barlowCondensed.waitUntilDone(),
    anton.waitUntilDone(), montserrat.waitUntilDone(),
  ]);

/* All font wait promises — importable for tests/benchmarks if needed. */
export const allFontWaiters = [
  saira.waitUntilDone,
  inter.waitUntilDone,
  jb.waitUntilDone,
  sora.waitUntilDone,
  spaceG.waitUntilDone,
  spaceM.waitUntilDone,
  manrope.waitUntilDone,
  archivo.waitUntilDone,
  fraunces.waitUntilDone,
  newsreader.waitUntilDone,
  oswald.waitUntilDone,
  cormorant.waitUntilDone,
  ibmPlexMono.waitUntilDone,
  dmSans.waitUntilDone,
  exo2.waitUntilDone,
  barlowCondensed.waitUntilDone,
  anton.waitUntilDone,
  montserrat.waitUntilDone,
];

/* Block every frame's capture until all faces are ready — with 16 families a
   side-effect import alone can FOUT into the system fallback on frame 0. */
const fontHandle = delayRender("load-fonts");
waitForFonts().then(() => continueRender(fontHandle)).catch(() => continueRender(fontHandle));
