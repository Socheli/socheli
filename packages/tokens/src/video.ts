/* ════════════════════════════════════════════════════════════════════════
   VIDEO DESIGN TOKENS — 3 layers: primitives → semantic → per-channel themes.
   Components read ONLY semantic tokens via a resolved theme. Never a raw hex.
   Tone is monochrome: near-black surfaces, white accents, gray text.
   ════════════════════════════════════════════════════════════════════════ */

/* ─── Layer 1: primitives (raw scales — never used directly in components) ─ */
export const primitive = {
  color: {
    ink900: "#070707",
    ink850: "#0a0806",
    ink800: "#0b0d16",
    ink750: "#101019",
    ink700: "#130f0c",
    ink650: "#15151f",
    line: "#201a17",
    lineCool: "#20243a",
    bone: "#FAF7F5",
    fog: "#cbd2e0",
    ash: "#8A7D75",
    ashCool: "#8b93a7",
    orange: "#f5f5f5",
    amber: "#c7c7c7",
    blue: "#e5e5e5",
    indigo: "#d4d4d4",
    violet: "#bdbdbd",
    green: "#ededed",
    red: "#a3a3a3",
    pink: "#d4d4d4",
  },
  space: [0, 6, 10, 16, 24, 32, 48, 64, 96, 128] as const,
  radius: { sm: 6, md: 10, lg: 16, pill: 999 },
  font: {
    display: "'Saira SemiCondensed','Saira','Inter',system-ui,sans-serif",
    sans: "'Inter',system-ui,-apple-system,sans-serif",
    mono: "'JetBrains Mono','SF Mono','IBM Plex Mono',ui-monospace,monospace",
  },
  // px sizes tuned for a 1080×1920 vertical canvas
  size: { xs: 26, sm: 32, base: 38, md: 46, lg: 60, xl: 84, xxl: 116, hero: 150 },
  weight: { regular: 400, medium: 500, semibold: 600, bold: 700 },
} as const;

/* ─── Layer 3: per-channel themes resolve the semantic layer ───────────── */
export type Theme = {
  name: string;
  bg: string;
  bgGradTop: string;
  bgGradBottom: string;
  surface: string;
  surfaceRaised: string;
  border: string;
  text: { primary: string; secondary: string; muted: string };
  accent: { brand: string; info: string; ai: string };
  status: { ok: string; warning: string; danger: string };
  grid: string;
  font: { display: string; sans: string; mono: string };
};

const P = primitive.color;

export const themes: Record<string, Theme> = {
  // Claude Code Lab: monochrome terminal-forward
  lab: {
    name: "lab",
    bg: "#080808",
    bgGradTop: "#101010",
    bgGradBottom: "#050505",
    surface: P.ink700,
    surfaceRaised: "#151515",
    border: "#242424",
    text: { primary: P.bone, secondary: "#d8d8d8", muted: "#8a8a8a" },
    accent: { brand: P.orange, info: P.blue, ai: P.violet },
    status: { ok: P.green, warning: P.amber, danger: P.red },
    grid: P.orange,
    // Code Labrinox — engineered grotesk + true mono accents (dev/terminal).
    font: {
      display: "'Space Grotesk','Saira SemiCondensed',system-ui,sans-serif",
      sans: "'Inter',system-ui,-apple-system,sans-serif",
      mono: "'Space Mono','JetBrains Mono',ui-monospace,monospace",
    },
  },
  // Agentic Builder: monochrome architecture dark
  builder: {
    name: "builder",
    bg: P.ink800,
    bgGradTop: "#0b0d16",
    bgGradBottom: "#050611",
    surface: P.ink750,
    surfaceRaised: "#15151f",
    border: P.lineCool,
    text: { primary: P.bone, secondary: P.fog, muted: P.ashCool },
    accent: { brand: P.indigo, info: P.blue, ai: P.violet },
    status: { ok: P.green, warning: P.amber, danger: P.red },
    grid: P.indigo,
    // Agentic Builder — clean geometric systems sans, mono for structure.
    font: {
      display: "'Manrope','Inter',system-ui,sans-serif",
      sans: "'Inter',system-ui,-apple-system,sans-serif",
      mono: "'Space Mono','JetBrains Mono',ui-monospace,monospace",
    },
  },
  // Concept: general-purpose premium explainer, monochrome.
  concept: {
    name: "concept",
    bg: "#0a0b0e",
    bgGradTop: "#0c0e13",
    bgGradBottom: "#060708",
    surface: "#12141a",
    surfaceRaised: "#171a22",
    border: "#222633",
    text: { primary: P.bone, secondary: "#c6ccd8", muted: "#8089a0" },
    accent: { brand: P.blue, info: "#d4d4d4", ai: P.violet },
    status: { ok: P.green, warning: P.amber, danger: P.red },
    grid: P.blue,
    // Labrinox — modern geometric flagship, confident and broadly premium.
    font: {
      display: "'Sora','Inter',system-ui,sans-serif",
      sans: "'Inter',system-ui,-apple-system,sans-serif",
      mono: "'JetBrains Mono','SF Mono',ui-monospace,monospace",
    },
  },
  // MoltJobs — "Obsidian / Magma": warm near-black + orange-red lava accent.
  magma: {
    name: "magma",
    bg: "#0B0908",
    bgGradTop: "#120D0A",
    bgGradBottom: "#070504",
    surface: "#110E0D",
    surfaceRaised: "#171311",
    border: "#272220",
    text: { primary: "#FAF9F8", secondary: "#C9BDB5", muted: "#8C7C72" },
    accent: { brand: "#FF4400", info: "#3B82F6", ai: "#8B5CF6" },
    status: { ok: "#22C55E", warning: "#FF9400", danger: "#EF4444" },
    grid: "#FF4400",
    // MoltJobs — heavy industrial grotesk + mono; weight = on-chain machinery.
    font: {
      display: "'Archivo','Saira SemiCondensed',system-ui,sans-serif",
      sans: "'Inter',system-ui,-apple-system,sans-serif",
      mono: "'Space Mono','JetBrains Mono',ui-monospace,monospace",
    },
  },
  // CognitiveX / iCog — deep blue-black + single violet accent, cinematic-intimate.
  cognitivx: {
    name: "cognitivx",
    bg: "#07070A",
    bgGradTop: "#0D0B16",
    bgGradBottom: "#040409",
    surface: "#141417",
    surfaceRaised: "#1A1A20",
    border: "#22222B",
    text: { primary: "#EDEDF0", secondary: "#B4B4BD", muted: "#6E6E78" },
    accent: { brand: "#8B5CF6", info: "#3B82F6", ai: "#9AA8FF" },
    status: { ok: "#22C55E", warning: "#FBBF24", danger: "#F87171" },
    grid: "#8B5CF6",
    // iCog / CognitiveX — literary serif identity; intimate, memory-as-theme.
    font: {
      display: "'Fraunces','Newsreader',Georgia,serif",
      sans: "'Newsreader',Georgia,'Inter',serif",
      mono: "'JetBrains Mono','SF Mono',ui-monospace,monospace",
    },
  },
  // Inkline (PAPER) — black ink on warm off-white. Editorial sketchbook / field-manual.
  // Truly monochrome: the "accent" is the ink itself. Pairs with hand-drawn ink strokes.
  ink_paper: {
    name: "ink_paper",
    bg: "#f5f1e8",
    bgGradTop: "#f8f5ee",
    bgGradBottom: "#ece4d4",
    surface: "#ece6d8",
    surfaceRaised: "#f2ede1",
    border: "#d8cfbc",
    text: { primary: "#14110c", secondary: "#3a352c", muted: "#6b655c" },
    accent: { brand: "#14110c", info: "#3a352c", ai: "#6b655c" },
    status: { ok: "#2f2a22", warning: "#5c5345", danger: "#1a1714" },
    grid: "#d8cfbc",
    // Inkline — editorial serif display + clean sans body; the line work carries the identity.
    font: {
      display: "'Fraunces','Spectral',Georgia,serif",
      sans: "'Inter',system-ui,-apple-system,sans-serif",
      mono: "'JetBrains Mono','SF Mono',ui-monospace,monospace",
    },
  },
  // Inkline (NOIR) — chalk-white ink on near-black. Dark variant of the same identity.
  ink_noir: {
    name: "ink_noir",
    bg: "#0a0a0a",
    bgGradTop: "#0f0f0f",
    bgGradBottom: "#050505",
    surface: "#121212",
    surfaceRaised: "#181818",
    border: "#262626",
    text: { primary: "#f4f1ea", secondary: "#cfcabf", muted: "#8a8a8a" },
    accent: { brand: "#f4f1ea", info: "#cfcabf", ai: "#bdbdbd" },
    status: { ok: "#ededed", warning: "#c7c7c7", danger: "#a3a3a3" },
    grid: "#2a2a2a",
    font: {
      display: "'Fraunces','Spectral',Georgia,serif",
      sans: "'Inter',system-ui,-apple-system,sans-serif",
      mono: "'JetBrains Mono','SF Mono',ui-monospace,monospace",
    },
  },
  // Socheli (house brand) — "Field Manual": near-black + warm bone accent (#ECE6D8).
  // Monochrome with field-manual warmth; the bone tone is Socheli's signature.
  socheli: {
    name: "socheli",
    bg: "#0a0a0a",
    bgGradTop: "#101010",
    bgGradBottom: "#050505",
    surface: "#161616",
    surfaceRaised: "#1e1e1e",
    border: "#262626",
    text: { primary: "#ECE6D8", secondary: "#B8B2A6", muted: "#87827A" },
    accent: { brand: "#ECE6D8", info: "#B8B2A6", ai: "#f5f5f5" },
    status: { ok: "#ECE6D8", warning: "#B8B2A6", danger: "#87827A" },
    grid: "#262626",
    // Socheli — engineered grotesk display + true mono; precise, field-manual.
    font: {
      display: "'Space Grotesk','Saira SemiCondensed',system-ui,sans-serif",
      sans: "'Inter',system-ui,-apple-system,sans-serif",
      mono: "'Space Mono','JetBrains Mono',ui-monospace,monospace",
    },
  },
};

export const getTheme = (t: string): Theme => themes[t] ?? themes.lab;

/* ─── Motion tokens ────────────────────────────────────────────────────── */
export const motion = {
  fps: 30,
  crossfadeFrames: 10,
  intensity: {
    calm: { revealDur: 22, slideDist: 18, slamFrom: 1.6 },
    standard: { revealDur: 16, slideDist: 28, slamFrom: 2.6 },
    punchy: { revealDur: 10, slideDist: 40, slamFrom: 3.5 },
  },
} as const;
export type MotionIntensity = keyof typeof motion.intensity;

/* ─── Typography presets (composed styles components consume) ───────────── */
export const type = (t: Theme) => ({
  hero: {
    fontFamily: t.font.display,
    fontSize: primitive.size.hero,
    fontWeight: primitive.weight.semibold,
    lineHeight: 1.02,
    letterSpacing: "-0.01em",
    color: t.text.primary,
  },
  title: {
    fontFamily: t.font.display,
    fontSize: primitive.size.xxl,
    fontWeight: primitive.weight.semibold,
    lineHeight: 1.06,
    letterSpacing: "-0.005em",
    color: t.text.primary,
  },
  heading: {
    fontFamily: t.font.display,
    fontSize: primitive.size.lg,
    fontWeight: primitive.weight.medium,
    lineHeight: 1.14,
    letterSpacing: "0",
    color: t.text.primary,
  },
  body: {
    fontFamily: t.font.sans,
    fontSize: primitive.size.md,
    fontWeight: primitive.weight.medium,
    lineHeight: 1.3,
    color: t.text.secondary,
  },
  mono: {
    fontFamily: t.font.mono,
    fontSize: primitive.size.base,
    fontWeight: primitive.weight.regular,
    lineHeight: 1.5,
    color: t.text.primary,
  },
  eyebrow: {
    fontFamily: t.font.mono,
    fontSize: primitive.size.xs,
    fontWeight: primitive.weight.medium,
    letterSpacing: "0.14em",
    textTransform: "uppercase" as const,
    color: t.text.muted,
  },
  subtitle: {
    fontFamily: t.font.sans,
    fontSize: primitive.size.md,
    fontWeight: primitive.weight.semibold,
    lineHeight: 1.25,
    color: t.text.primary,
  },
});
