#!/usr/bin/env node
/* One-time YouTube connect for Socheli.

   Mints a long-lived REFRESH TOKEN for a Google Cloud OAuth *Desktop* client and
   writes it into .env as YOUTUBE_REFRESH_TOKEN. After this, `content publish <id>`
   (and the dashboard/API publish action) uploads Shorts to your channel for real.

   No app verification needed — you're the developer/test user on your own account,
   uploading to your OWN channel.

   Prereqs (one-time, Google Cloud Console):
     1. APIs & Services → Library → enable **YouTube Data API v3**
     2. APIs & Services → Credentials → Create credentials → OAuth client ID
          → Application type: **Desktop app**
        Copy the Client ID + Client secret into .env:
          YOUTUBE_CLIENT_ID=...
          YOUTUBE_CLIENT_SECRET=...
     (Use the Google account that OWNS the Labrinox YouTube channel.)

   Then run:   node scripts/mint-youtube-token.mjs

   The consent screen opens in YOUR browser (reaches Google normally); the
   code→token exchange runs through the SOCKS tunnel when ELEVEN_PROXY is set
   (Google is geo-blocked in some regions; direct on the server). */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createServer } from "node:http";
import { spawnSync, spawn } from "node:child_process";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ENV_PATH = join(ROOT, ".env");
const SCOPES = ["https://www.googleapis.com/auth/youtube.upload", "https://www.googleapis.com/auth/youtube.readonly", "https://www.googleapis.com/auth/yt-analytics.readonly"];
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";

function parseEnv(text) {
  const out = {};
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return out;
}
function upsertEnv(key, value) {
  let text = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, "utf8") : "";
  const line = `${key}=${value}`;
  const re = new RegExp(`^\\s*${key}\\s*=.*$`, "m");
  if (re.test(text)) text = text.replace(re, line);
  else text = text.replace(/\n*$/, "\n") + line + "\n";
  writeFileSync(ENV_PATH, text);
}

const env = { ...parseEnv(existsSync(ENV_PATH) ? readFileSync(ENV_PATH, "utf8") : ""), ...process.env };
const CLIENT_ID = env.YOUTUBE_CLIENT_ID;
const CLIENT_SECRET = env.YOUTUBE_CLIENT_SECRET;
const PROXY = (env.GOOGLE_PROXY || env.ELEVEN_PROXY || env.HTTPS_PROXY || "").replace(/^socks5h?:\/\//, "");

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error(
    "\n✗ Missing YOUTUBE_CLIENT_ID / YOUTUBE_CLIENT_SECRET in .env\n\n" +
      "  Create a *Desktop* OAuth client in Google Cloud Console (enable YouTube\n" +
      "  Data API v3 first), then add to .env:\n\n" +
      "    YOUTUBE_CLIENT_ID=...\n    YOUTUBE_CLIENT_SECRET=...\n\n  and re-run this script.\n",
  );
  process.exit(1);
}

function exchange(code, redirectUri) {
  const base = ["-s", "-X", "POST", TOKEN_ENDPOINT,
    "-d", `code=${encodeURIComponent(code)}`,
    "-d", `client_id=${CLIENT_ID}`,
    "-d", `client_secret=${CLIENT_SECRET}`,
    "-d", `redirect_uri=${encodeURIComponent(redirectUri)}`,
    "-d", "grant_type=authorization_code"];
  const args = PROXY ? ["--socks5-hostname", PROXY, ...base] : base;
  const r = spawnSync("curl", args, { encoding: "utf8", timeout: 60_000, maxBuffer: 1024 * 1024 * 16 });
  try {
    return JSON.parse(r.stdout);
  } catch {
    throw new Error(`token exchange failed: ${r.stdout || r.stderr}`);
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  if (url.pathname !== "/") { res.writeHead(404).end(); return; }
  const code = url.searchParams.get("code");
  const err = url.searchParams.get("error");
  const reply = (msg) => { res.writeHead(200, { "Content-Type": "text/html" }); res.end(`<html><body style="font-family:system-ui;background:#0a0a0a;color:#eee;display:grid;place-items:center;height:100vh;margin:0"><div>${msg}</div></body></html>`); };
  if (err) { reply(`❌ ${err} — you can close this tab.`); console.error(`\n✗ consent failed: ${err}`); server.close(); process.exit(1); }
  if (!code) { reply("Waiting for the authorization code…"); return; }
  const port = server.address().port;
  try {
    const tok = exchange(code, `http://127.0.0.1:${port}`);
    if (!tok.refresh_token) {
      reply("⚠️ No refresh token returned. Revoke prior access at myaccount.google.com/permissions and retry.");
      console.error("\n✗ No refresh_token in response:", JSON.stringify(tok, null, 2));
      server.close(); process.exit(1);
    }
    upsertEnv("YOUTUBE_REFRESH_TOKEN", tok.refresh_token);
    reply("✅ YouTube connected — refresh token saved to .env. You can close this tab.");
    console.log("\n✓ Connected. YOUTUBE_REFRESH_TOKEN written to .env.");
    console.log("  Copy YOUTUBE_CLIENT_ID/SECRET/REFRESH_TOKEN to the server .env, then publish.\n");
  } catch (e) {
    reply("❌ Token exchange failed — check the terminal.");
    console.error("\n✗", e.message); process.exit(1);
  } finally {
    server.close();
  }
});

server.listen(0, "127.0.0.1", () => {
  const port = server.address().port;
  const redirectUri = `http://127.0.0.1:${port}`;
  // select_account forces Google's account/channel chooser so you can pick a
  // Brand Account channel (e.g. Labrinox) rather than the bare Google login.
  const q = new URLSearchParams({ client_id: CLIENT_ID, redirect_uri: redirectUri, response_type: "code", scope: SCOPES.join(" "), access_type: "offline", prompt: "select_account consent" });
  const authUrl = `${AUTH_ENDPOINT}?${q.toString()}`;
  console.log("\nOpening Google consent in your browser…");
  console.log("If it doesn't open, paste this URL:\n\n  " + authUrl + "\n");
  const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  spawn(opener, [authUrl], { stdio: "ignore", detached: true, shell: process.platform === "win32" }).on("error", () => {});
});
