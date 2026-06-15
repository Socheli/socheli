/**
 * filmstrip.ts — generate a horizontal THUMBNAIL STRIP for the frame editor.
 *
 * The /editor scrubber can step + trim frames, but you can't SEE the cut laid out.
 * A filmstrip (the signature of every real NLE) fixes that: one tiled jpg of N
 * evenly-spaced frames across the whole video, displayed full-width under the
 * scrubber with a playhead riding over it. Generated once via ffmpeg (sample →
 * scale → tile), cached by source mtime so a re-open is instant. Fail-open → null.
 */

import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { existsSync, statSync } from "node:fs";

import { RENDERS_DIR, loadItem, ensureDir } from "./store.ts";
import { resolveVideoFile } from "./editor-tools.ts";

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.round(n)));

function probe(video: string): { durSec: number; w: number; h: number } {
  const r = spawnSync(
    "ffprobe",
    ["-v", "error", "-select_streams", "v:0", "-show_entries", "format=duration:stream=width,height", "-of", "json", video],
    { encoding: "utf8" },
  );
  try {
    const j = JSON.parse(r.stdout || "{}");
    const s = (j.streams ?? [])[0] ?? {};
    return { durSec: Number(j.format?.duration) || 0, w: Number(s.width) || 0, h: Number(s.height) || 0 };
  } catch {
    return { durSec: 0, w: 0, h: 0 };
  }
}

/** Build (or reuse a cached) filmstrip jpg for a run. Returns its absolute path +
 *  the tile geometry, or null when there's no video / ffmpeg fails. */
export function filmstripFor(
  id: string,
  opts: { count?: number; height?: number } = {},
): { path: string; count: number; tileW: number; tileH: number } | null {
  let item;
  try { item = loadItem(id); } catch { return null; }
  const video = resolveVideoFile(item as never);
  if (!video || !existsSync(video)) return null;

  const count = clamp(opts.count ?? 28, 6, 60);
  const tileH = clamp(opts.height ?? 56, 32, 120);
  const { durSec, w, h } = probe(video);
  const tileW = w > 0 && h > 0 ? clamp(tileH * (w / h), 16, 320) : Math.round(tileH * (16 / 9));

  ensureDir(RENDERS_DIR);
  const out = join(RENDERS_DIR, `${id}_strip.jpg`);
  // cache: reuse when the strip is at least as new as the source video.
  if (existsSync(out) && statSync(out).mtimeMs >= statSync(video).mtimeMs) {
    return { path: out, count, tileW, tileH };
  }
  if (!(durSec > 0)) return null;

  // sample ~count frames over the whole clip, scale to tileH, lay them in one row.
  const fps = count / durSec;
  const r = spawnSync(
    "ffmpeg",
    ["-y", "-i", video, "-frames:v", "1", "-vf", `fps=${fps.toFixed(5)},scale=-1:${tileH},tile=${count}x1`, "-q:v", "4", out],
    { encoding: "utf8" },
  );
  if (r.status !== 0 || !existsSync(out)) return null;
  return { path: out, count, tileW, tileH };
}
