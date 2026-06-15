/* Output geometry — the ONE source of truth for aspect presets → dimensions.
 *
 * The renderer sizes the composition straight off `storyboard.width/height`
 * (Remotion `calculateMetadata` in packages/remotion/src/Root.tsx), so setting
 * those two numbers is all it takes to render any shape. Presets are just named
 * conveniences over a free-form W×H canvas — custom dimensions are first-class.
 */

export type AspectId = "9:16" | "1:1" | "16:9";

/** Named presets. Even, h264-friendly, 1080 on the short side. */
export const ASPECT_PRESETS: Record<AspectId, { width: number; height: number }> = {
  "9:16": { width: 1080, height: 1920 }, // vertical — Reels / Shorts / TikTok
  "1:1": { width: 1080, height: 1080 }, // square — feed
  "16:9": { width: 1920, height: 1080 }, // wide — YouTube / long-form
};

/** The default shape when nothing is specified (short-form vertical). */
export const DEFAULT_ASPECT: AspectId = "9:16";

export type Format = { width: number; height: number; aspect?: AspectId };

/** h264 requires even dimensions. */
function even(n: number): number {
  return Math.max(2, Math.round(n / 2) * 2);
}

/** Nearest named aspect for arbitrary dimensions — used for labelling and to
 *  bias b-roll orientation. Width/height stay authoritative for a custom canvas. */
export function aspectOf(width: number, height: number): AspectId {
  if (width > height) return "16:9";
  if (width === height) return "1:1";
  return "9:16";
}

/** Resolve output geometry from a preset and/or explicit dimensions.
 *  Precedence: an explicit custom W×H wins; else a named aspect; else the fallback.
 *  A custom canvas keeps its exact W×H and is tagged with its closest aspect. */
export function resolveFormat(
  opts: { aspect?: AspectId; width?: number; height?: number } = {},
  fallback: Format = { aspect: DEFAULT_ASPECT, ...ASPECT_PRESETS[DEFAULT_ASPECT] },
): Format {
  const { aspect, width, height } = opts;
  if (width && height && width > 0 && height > 0) {
    const w = even(width);
    const h = even(height);
    return { width: w, height: h, aspect: aspectOf(w, h) };
  }
  if (aspect && ASPECT_PRESETS[aspect]) return { aspect, ...ASPECT_PRESETS[aspect] };
  return fallback;
}

/** Parse a CLI `--aspect` value into a known preset id (or undefined). */
export function parseAspect(s?: string): AspectId | undefined {
  const k = s?.trim();
  return k && k in ASPECT_PRESETS ? (k as AspectId) : undefined;
}

/** Parse a CLI `--size` value: "1080x1920" | "1080X1920" | "1080:1920" | "1080×1920". */
export function parseSize(s?: string): { width: number; height: number } | undefined {
  const m = s?.trim().match(/^(\d{2,5})\s*[xX:×]\s*(\d{2,5})$/);
  return m ? { width: Number(m[1]), height: Number(m[2]) } : undefined;
}

/** True when the target shape is taller than wide (drives b-roll orientation). */
export function isPortrait(fmt: { width: number; height: number }): boolean {
  return fmt.height > fmt.width;
}
