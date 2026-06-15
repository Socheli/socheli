import { DEFAULT_WORKSPACE } from "@os/schemas";
import { gatherEvents, isoLocal, type VEvent } from "../../../../lib/calendar-events";

/* Public iCalendar (.ics) feed of the content calendar so Google Calendar / Notion
   / Apple Calendar can SUBSCRIBE to it (they poll a URL and render VEVENTs).

   This route is allow-listed in middleware so external calendar apps can fetch it
   without a session — it CANNOT call currentContext(). Instead the workspace is
   carried IN the feed URL as `?ws=<workspaceId>` (the per-workspace feed token a
   member copies from the calendar UI). An unknown/absent ws falls back safely to
   DEFAULT_WORKSPACE, so the legacy single-tenant feed keeps working unchanged.
   Optionally also gate the whole feed with CALENDAR_ICS_TOKEN (?token=...). */

export const dynamic = "force-dynamic";

/* Only allow workspace ids we recognise as feed tokens — a Clerk org (`org_…`),
   a personal space (`user_…`), or the default. Anything else → default, so a
   malformed/probing token can never reach into another tenant's data. */
function workspaceFromToken(raw: string | null): string {
  const ws = (raw ?? "").trim();
  if (!ws) return DEFAULT_WORKSPACE;
  if (ws === DEFAULT_WORKSPACE || /^(org_|user_|ws_)[A-Za-z0-9_-]+$/.test(ws)) return ws;
  return DEFAULT_WORKSPACE;
}

function esc(s: string): string {
  return (s ?? "").replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
}
function stampUTC(d = new Date()): string {
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
}
/* shared isoLocal → compact iCal DTSTART/DTEND "YYYYMMDDTHHMMSS" */
function compact(date: string, time: string, addMin = 0): string {
  return isoLocal(date, time, addMin).replace(/[-:]/g, "");
}

function toIcs(events: VEvent[]): string {
  const now = stampUTC();
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Socheli//Content Calendar//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "X-WR-CALNAME:Socheli Content",
    "X-WR-TIMEZONE:UTC",
  ];
  for (const e of events) {
    lines.push("BEGIN:VEVENT");
    lines.push(`UID:${e.uid}`);
    lines.push(`DTSTAMP:${now}`);
    lines.push(`DTSTART:${compact(e.date, e.time)}`);
    lines.push(`DTEND:${compact(e.date, e.time, e.durationMin)}`);
    lines.push(`SUMMARY:${esc(e.summary)}`);
    lines.push(`DESCRIPTION:${esc(e.description)}`);
    if (e.alarm) {
      lines.push("BEGIN:VALARM", "ACTION:DISPLAY", `DESCRIPTION:${esc(e.summary)}`, "TRIGGER:-PT0M", "END:VALARM");
    }
    lines.push("END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  // RFC5545 line folding is optional for most clients; keep it simple.
  return lines.join("\r\n");
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const need = process.env.CALENDAR_ICS_TOKEN;
  if (need) {
    const token = url.searchParams.get("token");
    if (token !== need) return new Response("forbidden", { status: 403 });
  }
  const workspaceId = workspaceFromToken(url.searchParams.get("ws"));
  const ics = toIcs(gatherEvents(workspaceId));
  return new Response(ics, {
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": 'inline; filename="socheli-content.ics"',
      "Cache-Control": "no-cache",
    },
  });
}
