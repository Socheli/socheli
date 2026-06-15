import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { RENDERS_DIR } from "./store.ts";

/* A strong cover frame for YouTube/thumbnails — grabbed from the hook beat. */
export function makeThumbnail(id: string, mp4: string, atSec = 2.5): string | null {
  const out = join(RENDERS_DIR, `${id}_thumb.jpg`);
  const r = spawnSync("ffmpeg", ["-y", "-ss", String(atSec), "-i", mp4, "-frames:v", "1", "-q:v", "2", out], { encoding: "utf8" });
  return r.status === 0 && existsSync(out) ? out : null;
}

/* Cross-platform aspect ratios from one 1080x1920 master:
   square (1:1 centered crop) + wide (16:9 with blurred-fill background). */
export function makeAspects(id: string, mp4: string): { square?: string; wide?: string } {
  const square = join(RENDERS_DIR, `${id}_1x1.mp4`);
  const wide = join(RENDERS_DIR, `${id}_16x9.mp4`);
  const rs = spawnSync(
    "ffmpeg",
    ["-y", "-i", mp4, "-vf", "crop=1080:1080:0:420", "-c:a", "copy", "-c:v", "h264", "-crf", "20", square],
    { encoding: "utf8" },
  );
  const rw = spawnSync(
    "ffmpeg",
    ["-y", "-i", mp4, "-filter_complex",
      "[0:v]scale=1920:1080,boxblur=24:2[bg];[0:v]scale=-1:1080[fg];[bg][fg]overlay=(W-w)/2:0",
      "-c:a", "copy", "-c:v", "h264", "-crf", "20", wide],
    { encoding: "utf8" },
  );
  return {
    square: rs.status === 0 && existsSync(square) ? square : undefined,
    wide: rw.status === 0 && existsSync(wide) ? wide : undefined,
  };
}

/* P6: aspect identifiers a platform can prefer for publishing. "9:16" is always
   the rendered master (item.videoPath); the others come from makeAspects. */
export type Aspect = "9:16" | "1:1" | "16:9";

/* Resolve the file for a requested aspect from an item's derivatives, falling
   back to the 9:16 master when that derivative wasn't rendered. Mirrors the
   publisher's videoPathFor so the dashboard and engine agree on availability. */
export function derivativeForAspect(
  aspect: Aspect,
  master?: string,
  derivatives?: { square?: string; wide?: string },
): string | undefined {
  if (aspect === "1:1" && derivatives?.square) return derivatives.square;
  if (aspect === "16:9" && derivatives?.wide) return derivatives.wide;
  return master;
}

/* Which aspects are actually publishable for an item right now — used to gate the
   per-platform "use derivative" choice in the dashboard so we never offer an
   aspect that has no rendered file. */
export function availableAspects(master?: string, derivatives?: { square?: string; wide?: string }): Aspect[] {
  const out: Aspect[] = [];
  if (master) out.push("9:16");
  if (derivatives?.square) out.push("1:1");
  if (derivatives?.wide) out.push("16:9");
  return out;
}
