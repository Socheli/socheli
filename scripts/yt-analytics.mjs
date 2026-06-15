// Direct (no-proxy) YouTube diag + analytics for the latest N videos.
// Runs wherever Google is reachable directly (e.g. the Socheli server).
import fs from "node:fs";
import { spawnSync } from "node:child_process";

const N = Number(process.argv[2] || 2);
const ENV_PATH = process.argv[3] || ".env";

const env = {};
for (const l of fs.readFileSync(ENV_PATH, "utf8").split("\n")) {
  const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const curl = (a) => spawnSync("curl", ["-s", ...a], { encoding: "utf8", timeout: 60000, maxBuffer: 1 << 25 }).stdout;
const J = (s) => { try { return JSON.parse(s); } catch { return { __raw: (s || "").slice(0, 400) }; } };

const t0 = Date.now();
const tok = J(curl(["-X", "POST", "https://oauth2.googleapis.com/token",
  "-d", "client_id=" + env.YOUTUBE_CLIENT_ID, "-d", "client_secret=" + env.YOUTUBE_CLIENT_SECRET,
  "-d", "refresh_token=" + env.YOUTUBE_REFRESH_TOKEN, "-d", "grant_type=refresh_token"]));
const at = tok.access_token;
if (!at) { console.log("TOKEN ERROR:", JSON.stringify(tok).slice(0, 300)); process.exit(1); }
console.log(`token ok (direct Google, ${Date.now() - t0}ms — no proxy)`);

const auth = ["-H", "Authorization: Bearer " + at];
const ch = J(curl([...auth, "https://www.googleapis.com/youtube/v3/channels?part=contentDetails,snippet,statistics&mine=true"]));
const c = ch.items?.[0];
const uploads = c?.contentDetails?.relatedPlaylists?.uploads;
console.log(`channel: ${c?.snippet?.title}  subs:${c?.statistics?.subscriberCount}  totalViews:${c?.statistics?.viewCount}  videos:${c?.statistics?.videoCount}`);

const pl = J(curl([...auth, `https://www.googleapis.com/youtube/v3/playlistItems?part=snippet,contentDetails&maxResults=${N}&playlistId=${uploads}`]));
const ids = (pl.items || []).map((i) => i.contentDetails.videoId);
if (!ids.length) { console.log("no uploads found"); process.exit(0); }

const vids = J(curl([...auth, `https://www.googleapis.com/youtube/v3/videos?part=snippet,statistics,contentDetails,status&id=${ids.join(",")}`]));
console.log(`\n=== latest ${ids.length} videos ===`);
for (const v of vids.items || []) {
  const s = v.snippet, st = v.statistics || {};
  console.log(`\n• ${s.title}`);
  console.log(`  id:${v.id}  published:${s.publishedAt}  privacy:${v.status?.privacyStatus}  dur:${v.contentDetails?.duration}`);
  console.log(`  views:${st.viewCount ?? 0}  likes:${st.likeCount ?? 0}  comments:${st.commentCount ?? 0}  url:https://youtu.be/${v.id}`);
}

// Deeper analytics (watch time, avg view duration) — needs yt-analytics.readonly scope.
console.log(`\n=== YouTube Analytics API (watch time / CTR-grade) ===`);
const since = "2020-01-01";
const today = new Date().toISOString().slice(0, 10);
const a = J(curl([...auth,
  "https://youtubeanalytics.googleapis.com/v2/reports?ids=channel%3D%3DMINE" +
  `&startDate=${since}&endDate=${today}` +
  "&metrics=views,estimatedMinutesWatched,averageViewDuration,averageViewPercentage,likes,subscribersGained" +
  "&dimensions=video&filters=video%3D%3D" + encodeURIComponent(ids.join(",")) +
  "&sort=-views"]));
if (a.error) {
  console.log(`  (unavailable: ${a.error.code} ${a.error.message?.slice(0, 160)})`);
  console.log(`  → likely missing scope 'yt-analytics.readonly'; re-mint token with it to get watch-time/retention.`);
} else if (a.rows?.length) {
  const cols = (a.columnHeaders || []).map((h) => h.name);
  for (const row of a.rows) {
    const o = Object.fromEntries(cols.map((k, i) => [k, row[i]]));
    console.log(`  ${o.video}  views:${o.views}  minsWatched:${o.estimatedMinutesWatched}  avgDur:${o.averageViewDuration}s  avg%:${o.averageViewPercentage}  likes:${o.likes}  subs+:${o.subscribersGained}`);
  }
} else {
  console.log("  (no analytics rows — videos may be too new / private, or no traffic yet)");
}
