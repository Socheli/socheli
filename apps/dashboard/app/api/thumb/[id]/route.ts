import { spawnSync } from "node:child_process";
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { getItem, videoFile, coverFile, REPO_ROOT } from "../../../../lib/data";

export const dynamic = "force-dynamic";

/* Poster for a post. Prefers the DESIGNED cover / AI thumbnail (`<id>_thumb.jpg`)
   when one exists; otherwise a cached representative video frame. (Poster images
   aren't workspace-sensitive, so this resolves by id directly.) */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const item = getItem(id);

  // 1. Designed cover / AI thumbnail wins — serve it directly (already a JPG).
  const cover = coverFile(item);
  if (cover) {
    return new Response(new Uint8Array(readFileSync(cover)), {
      headers: { "Content-Type": "image/jpeg", "Cache-Control": "no-cache" },
    });
  }

  // 2. Fallback: a representative frame grabbed from the rendered video.
  const vf = videoFile(item);
  if (!vf) return new Response("no video", { status: 404 });
  const dir = join(REPO_ROOT, "data", "thumbs");
  mkdirSync(dir, { recursive: true });
  const out = join(dir, `${id}.jpg`);
  if (!existsSync(out)) {
    // Pick a *representative* frame, not a fixed timestamp. These videos open on a
    // dark intro/fade, so a fixed -ss 2.5 grab lands on a near-black frame and the
    // poster looks empty. The `thumbnail` filter scans a window and picks the most
    // representative frame (skipping the dark lead-in). -ss 1 skips the very first
    // frames; -update 1 lets ffmpeg write a single image to a fixed filename.
    spawnSync(
      "ffmpeg",
      ["-y", "-ss", "1", "-i", vf, "-frames:v", "1", "-update", "1", "-vf", "thumbnail=n=150,scale=200:-1", out],
      { encoding: "utf8" },
    );
    // Fallback: if the smart pick produced nothing (very short clip / odd codec),
    // grab a plain frame so we still return a poster instead of 404.
    if (!existsSync(out)) {
      spawnSync("ffmpeg", ["-y", "-ss", "2.5", "-i", vf, "-frames:v", "1", "-update", "1", "-vf", "scale=200:-1", out], { encoding: "utf8" });
    }
  }
  if (!existsSync(out)) return new Response("no thumb", { status: 404 });
  return new Response(new Uint8Array(readFileSync(out)), { headers: { "Content-Type": "image/jpeg", "Cache-Control": "no-cache" } });
}
