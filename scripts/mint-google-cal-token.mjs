#!/usr/bin/env node
/* One-time Google Calendar connect for Socheli.

   Mints a long-lived REFRESH TOKEN for a Google Cloud OAuth *Desktop* client and
   writes it into .env as GOOGLE_CAL_REFRESH_TOKEN. After this, the dashboard's
   "Sync now" pushes the content calendar straight into your Google Calendar.

   No app verification needed — you're the developer/test user on your own account.

   Prereqs (one-time, in Google Cloud Console for the project with the Calendar
   API enabled — we enabled it on `<your-gcp-project>`):
     APIs & Services → Credentials → Create credentials → OAuth client ID
       → Application type: Desktop app
     Copy the Client ID + Client secret into .env:
       GOOGLE_CAL_CLIENT_ID=...
       GOOGLE_CAL_CLIENT_SECRET=...

   Then run:   node scripts/mint-google-cal-token.mjs

   The consent screen opens in YOUR browser (reaches Google normally); the
   code→token exchange runs through the SOCKS tunnel (Google is geo-blocked on
   this host) using the same ELEVEN_PROXY the engine uses for YouTube. */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createServer } from "node:http";
import { spawnSync, spawn } from "node:child_process";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ENV_PATH = join(ROOT, ".env");
const SCOPES = ["openid", "email", "https://www.googleapis.com/auth/calendar"];
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";

// ── .env parse / patch ───────────────────────────────────────────────────────
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
const CLIENT_ID = env.GOOGLE_CAL_CLIENT_ID;
const CLIENT_SECRET = env.GOOGLE_CAL_CLIENT_SECRET;
const PROXY = (env.GOOGLE_PROXY || env.ELEVEN_PROXY || env.HTTPS_PROXY || "socks5h://127.0.0.1:11080").replace(/^socks5h?:\/\//, "");

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error(
    "\n✗ Missing GOOGLE_CAL_CLIENT_ID / GOOGLE_CAL_CLIENT_SECRET in .env\n\n" +
      "  Create a *Desktop* OAuth client in Google Cloud Console (project `<your-gcp-project>`,\n" +
      "  Calendar API already enabled), then add to .env:\n\n" +
      "    GOOGLE_CAL_CLIENT_ID=...\n    GOOGLE_CAL_CLIENT_SECRET=...\n\n  and re-run this script.\n",
  );
  process.exit(1);
}

// ── exchange code → tokens through the SOCKS tunnel (curl) ───────────────────
function exchange(code, redirectUri) {
  const r = spawnSync(
    "curl",
    [
      "-s", "--socks5-hostname", PROXY,
      "-X", "POST", TOKEN_ENDPOINT,
      "-d", `code=${encodeURIComponent(code)}`,
      "-d", `client_id=${CLIENT_ID}`,
      "-d", `client_secret=${CLIENT_SECRET}`,
      "-d", `redirect_uri=${encodeURIComponent(redirectUri)}`,
      "-d", "grant_type=authorization_code",
    ],
    { encoding: "utf8", timeout: 60_000, maxBuffer: 1024 * 1024 * 16 },
  );
  try {
    return JSON.parse(r.stdout);
  } catch {
    throw new Error(`token exchange failed: ${r.stdout || r.stderr}`);
  }
}

// ── loopback server to catch the redirect ────────────────────────────────────
const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  if (url.pathname !== "/") {
    res.writeHead(404).end();
    return;
  }
  const code = url.searchParams.get("code");
  const err = url.searchParams.get("error");
  const reply = (msg) => {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(`<html><body style="font-family:system-ui;background:#0a0a0a;color:#eee;display:grid;place-items:center;height:100vh;margin:0"><div>${msg}</div></body></html>`);
  };
  if (err) {
    reply(`❌ ${err} — you can close this tab.`);
    console.error(`\n✗ consent failed: ${err}`);
    server.close();
    process.exit(1);
  }
  if (!code) {
    reply("Waiting for the authorization code…");
    return;
  }
  const port = server.address().port;
  try {
    const tok = exchange(code, `http://127.0.0.1:${port}`);
    if (!tok.refresh_token) {
      reply("⚠️ No refresh token returned. Revoke prior access at myaccount.google.com/permissions and retry.");
      console.error("\n✗ No refresh_token in response:", JSON.stringify(tok, null, 2));
      server.close();
      process.exit(1);
    }
    upsertEnv("GOOGLE_CAL_REFRESH_TOKEN", tok.refresh_token);
    reply("✅ Google Calendar connected — refresh token saved to .env. You can close this tab.");
    console.log("\n✓ Connected. GOOGLE_CAL_REFRESH_TOKEN written to .env.");
    console.log("  Open the dashboard → /calendar → Connect → Google Calendar → Sync now.\n");
  } catch (e) {
    reply("❌ Token exchange failed — check the terminal.");
    console.error("\n✗", e.message);
    process.exit(1);
  } finally {
    server.close();
  }
});

server.listen(0, "127.0.0.1", () => {
  const port = server.address().port;
  const redirectUri = `http://127.0.0.1:${port}`;
  const q = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent",
  });
  const authUrl = `${AUTH_ENDPOINT}?${q.toString()}`;
  console.log("\nOpening Google consent in your browser…");
  console.log("If it doesn't open, paste this URL:\n\n  " + authUrl + "\n");
  // best-effort auto-open (mac/linux/win)
  const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  spawn(opener, [authUrl], { stdio: "ignore", detached: true, shell: process.platform === "win32" }).on("error", () => {});
});
