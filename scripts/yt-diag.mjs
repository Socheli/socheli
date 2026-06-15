import fs from "node:fs";
import { spawnSync } from "node:child_process";

const env = {};
for (const l of fs.readFileSync(".env", "utf8").split("\n")) {
  const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const P = (env.ELEVEN_PROXY || "socks5h://127.0.0.1:11080").replace(/^socks5h?:\/\//, "");
const curl = (a) => spawnSync("curl", ["-s", "--socks5-hostname", P, ...a], { encoding: "utf8", timeout: 120000, maxBuffer: 1 << 25 }).stdout;
const J = (s) => { try { return JSON.parse(s); } catch { return { __raw: (s || "").slice(0, 400) }; } };

const tok = J(curl(["-X", "POST", "https://oauth2.googleapis.com/token",
  "-d", "client_id=" + env.YOUTUBE_CLIENT_ID, "-d", "client_secret=" + env.YOUTUBE_CLIENT_SECRET,
  "-d", "refresh_token=" + env.YOUTUBE_REFRESH_TOKEN, "-d", "grant_type=refresh_token"]));
const at = tok.access_token;
if (!at) { console.log("TOKEN ERROR:", JSON.stringify(tok).slice(0, 300)); process.exit(0); }
console.log("token ok");

// recent uploads on the channel
const ch = J(curl(["-H", "Authorization: Bearer " + at, "https://www.googleapis.com/youtube/v3/channels?part=contentDetails&mine=true"]));
const uploads = ch.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
console.log("uploads playlist:", uploads || "(none)");
if (uploads) {
  const pl = J(curl(["-H", "Authorization: Bearer " + at, `https://www.googleapis.com/youtube/v3/playlistItems?part=snippet&maxResults=5&playlistId=${uploads}`]));
  console.log("recent uploads:");
  for (const it of pl.items || []) {
    const s = it.snippet;
    console.log(`  ${s?.resourceId?.videoId}  ${s?.publishedAt}  ${s?.title}`);
  }
  if (!(pl.items || []).length) console.log("  (none yet)");
}
