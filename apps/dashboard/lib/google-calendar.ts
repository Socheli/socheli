import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { REPO_ROOT } from "./data";
import { gatherEvents, isoLocal } from "./calendar-events";

/* Google Calendar auto-connect — Desktop-client + refresh-token model (same shape
   as the engine's YouTube auth). One Google account (the operator's), connected
   once via `node scripts/mint-google-cal-token.mjs`, which mints a refresh token
   into .env. From then on Socheli WRITES the content calendar straight into
   Google via the Calendar API: a dedicated "Socheli Content" calendar, reconciled
   on every sync.

   No app verification is needed — you're the developer/test user on your own
   account. Google APIs are geo-blocked in some regions, so every call routes through
   the SOCKS5 tunnel when ELEVEN_PROXY / GOOGLE_PROXY / HTTPS_PROXY is set.

   Env: GOOGLE_CAL_CLIENT_ID, GOOGLE_CAL_CLIENT_SECRET, GOOGLE_CAL_REFRESH_TOKEN. */

const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const CAL_API = "https://www.googleapis.com/calendar/v3";
const CAL_NAME = "Socheli Content";
const TIMEZONE = process.env.SOCHELI_TZ || "UTC";

const STORE = join(REPO_ROOT, "data", "google-calendar.json");
const PROXY = process.env.GOOGLE_PROXY || process.env.ELEVEN_PROXY || process.env.HTTPS_PROXY || "";

// ── tiny store for the resolved calendar id (single-tenant) ──────────────────
function readCalendarId(): string | null {
  try {
    if (existsSync(STORE)) return (JSON.parse(readFileSync(STORE, "utf8")) as { calendarId?: string }).calendarId ?? null;
  } catch {
    /* corrupt → ignore */
  }
  return null;
}
function writeCalendarId(calendarId: string) {
  mkdirSync(dirname(STORE), { recursive: true });
  writeFileSync(STORE, JSON.stringify({ calendarId }, null, 2));
}

// ── google http (curl, optional SOCKS proxy) ────────────────────────────────
function gcurl(args: string[]): { status: number; body: string } {
  const base = ["-s", "-w", "\n%{http_code}"];
  if (PROXY) base.push("--socks5-hostname", PROXY.replace(/^socks5h?:\/\//, ""));
  const r = spawnSync("curl", [...base, ...args], { encoding: "utf8", timeout: 60_000, maxBuffer: 1024 * 1024 * 32 });
  const out = r.stdout || "";
  const nl = out.lastIndexOf("\n");
  if (nl < 0) return { status: 0, body: out };
  return { status: Number(out.slice(nl + 1).trim()) || 0, body: out.slice(0, nl) };
}
function gjson<T>(res: { status: number; body: string }): T | null {
  try {
    return JSON.parse(res.body) as T;
  } catch {
    return null;
  }
}

// ── config / auth ─────────────────────────────────────────────────────────--
function creds() {
  return {
    clientId: process.env.GOOGLE_CAL_CLIENT_ID || "",
    clientSecret: process.env.GOOGLE_CAL_CLIENT_SECRET || "",
    refreshToken: process.env.GOOGLE_CAL_REFRESH_TOKEN || "",
  };
}
export function configured(): boolean {
  const c = creds();
  return !!(c.clientId && c.clientSecret);
}

function accessToken(): string | null {
  const { clientId, clientSecret, refreshToken } = creds();
  if (!clientId || !clientSecret || !refreshToken) return null;
  const res = gcurl([
    "-X", "POST", TOKEN_ENDPOINT,
    "-d", `client_id=${clientId}`,
    "-d", `client_secret=${clientSecret}`,
    "-d", `refresh_token=${refreshToken}`,
    "-d", "grant_type=refresh_token",
  ]);
  return gjson<{ access_token?: string }>(res)?.access_token ?? null;
}

// ── calendar management ──────────────────────────────────────────────────────
function ensureCalendar(token: string): string {
  const cached = readCalendarId();
  if (cached) {
    const check = gcurl(["-H", `Authorization: Bearer ${token}`, `${CAL_API}/calendars/${encodeURIComponent(cached)}`]);
    if (check.status === 200) return cached;
  }
  // reuse an existing "Socheli Content" calendar if present
  const list = gjson<{ items?: { id: string; summary?: string }[] }>(
    gcurl(["-H", `Authorization: Bearer ${token}`, `${CAL_API}/users/me/calendarList?maxResults=250`]),
  );
  const found = list?.items?.find((c) => c.summary === CAL_NAME);
  if (found) {
    writeCalendarId(found.id);
    return found.id;
  }
  // otherwise create it
  const created = gjson<{ id?: string }>(
    gcurl([
      "-X", "POST", `${CAL_API}/calendars`,
      "-H", `Authorization: Bearer ${token}`,
      "-H", "Content-Type: application/json",
      "-d", JSON.stringify({ summary: CAL_NAME, description: "Socheli content plan, schedule, published posts and reminders.", timeZone: TIMEZONE }),
    ]),
  );
  if (!created?.id) throw new Error("could not create the Socheli calendar");
  writeCalendarId(created.id);
  return created.id;
}

type GEvent = { id: string; extendedProperties?: { private?: { socheliUid?: string } } };

function listManaged(token: string, calId: string): Map<string, string> {
  // uid → google event id, across all our managed events
  const map = new Map<string, string>();
  let pageToken = "";
  for (let i = 0; i < 20; i++) {
    const url = `${CAL_API}/calendars/${encodeURIComponent(calId)}/events?privateExtendedProperty=${encodeURIComponent("socheliManaged=1")}&maxResults=2500&showDeleted=false${pageToken ? `&pageToken=${pageToken}` : ""}`;
    const page = gjson<{ items?: GEvent[]; nextPageToken?: string }>(gcurl(["-H", `Authorization: Bearer ${token}`, url]));
    for (const ev of page?.items ?? []) {
      const uid = ev.extendedProperties?.private?.socheliUid;
      if (uid) map.set(uid, ev.id);
    }
    if (!page?.nextPageToken) break;
    pageToken = page.nextPageToken;
  }
  return map;
}

function eventBody(e: ReturnType<typeof gatherEvents>[number]) {
  return JSON.stringify({
    summary: e.summary,
    description: e.description,
    start: { dateTime: isoLocal(e.date, e.time), timeZone: TIMEZONE },
    end: { dateTime: isoLocal(e.date, e.time, e.durationMin), timeZone: TIMEZONE },
    extendedProperties: { private: { socheliManaged: "1", socheliUid: e.uid } },
    ...(e.alarm ? { reminders: { useDefault: false, overrides: [{ method: "popup", minutes: 0 }] } } : {}),
  });
}

/* Reconcile the Socheli calendar to match the current event set:
   upsert every gathered event, delete managed events that no longer exist. */
export async function syncToGoogle(): Promise<{ created: number; updated: number; removed: number; error?: string }> {
  if (!configured()) return { created: 0, updated: 0, removed: 0, error: "GOOGLE_CAL_CLIENT_ID + GOOGLE_CAL_CLIENT_SECRET required" };
  const token = accessToken();
  if (!token) return { created: 0, updated: 0, removed: 0, error: "not connected — run scripts/mint-google-cal-token.mjs" };
  let calId: string;
  try {
    calId = ensureCalendar(token);
  } catch (e) {
    return { created: 0, updated: 0, removed: 0, error: e instanceof Error ? e.message : "calendar setup failed" };
  }

  const existing = listManaged(token, calId);
  const events = gatherEvents();
  const wanted = new Set(events.map((e) => e.uid));
  let created = 0, updated = 0, removed = 0;

  for (const e of events) {
    const body = eventBody(e);
    const id = existing.get(e.uid);
    if (id) {
      const r = gcurl([
        "-X", "PATCH", `${CAL_API}/calendars/${encodeURIComponent(calId)}/events/${encodeURIComponent(id)}`,
        "-H", `Authorization: Bearer ${token}`, "-H", "Content-Type: application/json", "-d", body,
      ]);
      if (r.status >= 200 && r.status < 300) updated++;
    } else {
      const r = gcurl([
        "-X", "POST", `${CAL_API}/calendars/${encodeURIComponent(calId)}/events`,
        "-H", `Authorization: Bearer ${token}`, "-H", "Content-Type: application/json", "-d", body,
      ]);
      if (r.status >= 200 && r.status < 300) created++;
    }
  }

  // delete managed events that fell out of the plan
  for (const [uid, id] of existing) {
    if (wanted.has(uid)) continue;
    const r = gcurl([
      "-X", "DELETE", `${CAL_API}/calendars/${encodeURIComponent(calId)}/events/${encodeURIComponent(id)}`,
      "-H", `Authorization: Bearer ${token}`,
    ]);
    if (r.status >= 200 && r.status < 300) removed++;
  }

  return { created, updated, removed };
}

// ── status ────────────────────────────────────────────────────────────────--
export type GoogleStatus = { connected: boolean; configured: boolean; calendarName?: string };
export function googleStatus(): GoogleStatus {
  const { refreshToken } = creds();
  return {
    configured: configured(),
    connected: configured() && !!refreshToken,
    calendarName: readCalendarId() ? CAL_NAME : undefined,
  };
}
