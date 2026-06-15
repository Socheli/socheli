import "./env.ts";
import { existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { loadItem, RENDERS_DIR } from "./store.ts";
import { resolveChannel } from "./channels.ts";
import { Storyboard } from "@os/schemas";

/* Reconstruct a render-props sidecar from a stored item + existing public assets,
   WITHOUT re-generating anything. Enough for the dashboard live preview. */
const PUBLIC = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "remotion", "public");
const h = (s: string) => createHash("sha1").update(s).digest("hex").slice(0, 16);

function brollAsset(b?: { query: string; kind: string }) {
  if (!b) return null;
  const id = h(`${b.kind}:${b.query}`);
  if (existsSync(join(PUBLIC, "broll", `${id}.mp4`))) return { src: `broll/${id}.mp4`, type: "video" };
  if (existsSync(join(PUBLIC, "broll", `${id}.png`))) return { src: `broll/${id}.png`, type: "image" };
  return null;
}

const id = process.argv[2];
if (!id) {
  console.error("usage: dump-props <id>");
  process.exit(1);
}
const item = loadItem(id);
const board = Storyboard.parse(item.storyboard);
const channel = resolveChannel(item.channel);

const voice = existsSync(join(PUBLIC, `${id}_voice.mp3`)) ? `${id}_voice.mp3` : undefined;
const music = existsSync(join(PUBLIC, `${id}_music.wav`)) ? `${id}_music.wav` : undefined;

const props = {
  storyboard: board,
  subtitles: [],
  words: [],
  brolls: board.scenes.map((s: any) => brollAsset(s.broll)),
  beatFrames: [],
  sfx: [],
  mix: item.mix,
  voiceSrc: voice,
  musicSrc: music,
  channelLabel: channel.name.toLowerCase(),
  channelLogo: channel.logo,
  channelHandle: channel.handle,
  channelSite: (channel as any).site,
};

const dir = join(RENDERS_DIR, "..", "props");
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, `${id}.json`), JSON.stringify(props));
console.log(`✓ wrote props sidecar for ${id} (voice:${!!voice} music:${!!music} broll:${props.brolls.filter(Boolean).length}/${board.scenes.length})`);
