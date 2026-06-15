import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "../../../lib/data";

export const dynamic = "force-dynamic";

/* F3 — WAVEFORM PEAKS.
   GET /api/waveform?id=<itemId>&track=music|voice|sfx
   Returns downsampled amplitude peaks for that item's audio so the editor can
   draw a real waveform under each track. Decodes via ffmpeg (the same toolchain
   the engine uses) to raw mono PCM, buckets to ~1000 normalized peaks, and
   caches the result to disk per item+track under the data dir. */

const REMOTION_PUBLIC = join(REPO_ROOT, "packages", "remotion", "public");
const CACHE_DIR = join(REPO_ROOT, "data", "waveforms");
const BUCKETS = 1000;
const SAMPLE_RATE = 8000; // enough for an amplitude envelope; keeps PCM tiny

type Track = "music" | "voice" | "sfx";
const TRACKS: Track[] = ["music", "voice", "sfx"];

/* Resolve the on-disk audio file for an item's track. Mirrors media.ts naming:
   `${id}_music.wav`, `${id}_voice.mp3`, and the shared procedural sfx clips. */
function audioFileFor(id: string, track: Track): string | null {
  if (track === "music") {
    for (const c of [`${id}_musicduck.wav`, `${id}_music.wav`]) {
      const p = join(REMOTION_PUBLIC, c);
      if (existsSync(p)) return p;
    }
    return null;
  }
  if (track === "voice") {
    for (const c of [`${id}_voice.mp3`, `${id}_voice.wav`]) {
      const p = join(REMOTION_PUBLIC, c);
      if (existsSync(p)) return p;
    }
    return null;
  }
  // sfx is a shared bed (impact); use it as a representative clip if present.
  const sfx = join(REMOTION_PUBLIC, "sfx", "impact.wav");
  return existsSync(sfx) ? sfx : null;
}

/* Decode an audio file → normalized peaks (0..1). Returns null if ffmpeg is
   missing or the file can't be decoded. */
function decodePeaks(absPath: string): { peaks: number[]; sampleRate: number; duration: number } | null {
  if (!existsSync(absPath) || spawnSync("which", ["ffmpeg"]).status !== 0) return null;
  const r = spawnSync(
    "ffmpeg",
    ["-v", "error", "-i", absPath, "-ac", "1", "-ar", String(SAMPLE_RATE), "-f", "s16le", "-acodec", "pcm_s16le", "pipe:1"],
    { encoding: "buffer", maxBuffer: 1 << 28 },
  );
  if (r.status !== 0 || !r.stdout || r.stdout.length < 2) return null;
  const buf = r.stdout as Buffer;
  const n = Math.floor(buf.length / 2);
  const duration = n / SAMPLE_RATE;
  const out = new Array<number>(BUCKETS).fill(0);
  const per = Math.max(1, Math.floor(n / BUCKETS));
  for (let b = 0; b < BUCKETS; b++) {
    const start = b * per;
    if (start >= n) break;
    const end = Math.min(n, start + per);
    let peak = 0;
    for (let i = start; i < end; i++) {
      const v = Math.abs(buf.readInt16LE(i * 2));
      if (v > peak) peak = v;
    }
    out[b] = Number((peak / 32768).toFixed(4));
  }
  return { peaks: out, sampleRate: SAMPLE_RATE, duration: Number(duration.toFixed(3)) };
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const id = (url.searchParams.get("id") ?? "").trim();
  const track = (url.searchParams.get("track") ?? "voice").trim() as Track;
  if (!id) return Response.json({ error: "id required" }, { status: 400 });
  if (!TRACKS.includes(track)) return Response.json({ error: "invalid track" }, { status: 400 });

  const src = audioFileFor(id, track);
  if (!src) return Response.json({ error: "audio not found" }, { status: 404 });

  // disk cache keyed by item+track; invalidated when the source file is newer.
  mkdirSync(CACHE_DIR, { recursive: true });
  const cacheFile = join(CACHE_DIR, `${id}_${track}.json`);
  try {
    if (existsSync(cacheFile)) {
      if (statSync(cacheFile).mtimeMs >= statSync(src).mtimeMs) {
        return new Response(readFileSync(cacheFile, "utf8"), {
          headers: { "Content-Type": "application/json" },
        });
      }
    }
  } catch {
    /* fall through to recompute */
  }

  const decoded = decodePeaks(src);
  if (!decoded) return Response.json({ error: "decode failed" }, { status: 500 });

  const payload = JSON.stringify(decoded);
  try {
    writeFileSync(cacheFile, payload);
  } catch {
    /* cache is best-effort */
  }
  return new Response(payload, { headers: { "Content-Type": "application/json" } });
}
