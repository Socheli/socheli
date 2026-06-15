import { spawnSync } from "node:child_process";
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { getItem, videoFile, REPO_ROOT } from "../../../../../lib/data";

export const dynamic = "force-dynamic";
const TR = 9, FPS = 30;

/* Poster frame for scene #i, sampled from the rendered video at that scene's time;
   so the editor timeline shows each scene as a real video segment. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string; i: string }> }) {
  const { id, i } = await params;
  const idx = parseInt(i, 10) || 0;
  const it = getItem(id);
  const vf = videoFile(it);
  if (!vf || !it?.storyboard) return new Response("no video", { status: 404 });

  const durs = it.storyboard.scenes.map((s: any) => Math.max(2 * TR + 4, Math.round((s.durationSec || 2) * FPS)));
  let start = 0;
  for (let j = 0; j < idx && j < durs.length; j++) start += durs[j] - TR;
  const t = (start + (durs[idx] ?? 60) * 0.45) / FPS;

  const dir = join(REPO_ROOT, "data", "thumbs");
  mkdirSync(dir, { recursive: true });
  const out = join(dir, `${id}_s${idx}.jpg`);
  if (!existsSync(out)) {
    spawnSync("ffmpeg", ["-y", "-ss", t.toFixed(2), "-i", vf, "-frames:v", "1", "-vf", "scale=160:-1", out], { encoding: "utf8" });
  }
  if (!existsSync(out)) return new Response("no thumb", { status: 404 });
  return new Response(new Uint8Array(readFileSync(out)), { headers: { "Content-Type": "image/jpeg", "Cache-Control": "no-cache" } });
}
