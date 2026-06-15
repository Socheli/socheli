"use client";
import Link from "next/link";
import type { CSSProperties } from "react";
import type { UICalendarWeek } from "../../../lib/agent/ui-spec";
import { BlockFrame } from "./BlockFrame";
import { TodayInk, todayIso } from "./TodayInk";

/* 7-column mini week strip. Each post chip deep-links to /post/<id> and shows
   a tiny mono platform glyph + time under the title; the header's "open →"
   goes to the full /calendar.

   Sketch-deep: day columns cascade in left to right (.blk-in) and today's
   day number gets a hand-drawn ink circle that draws around it (~600ms). */

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/* Tiny mono platform badges — text glyphs, no icon dep. */
const PLATFORM_GLYPH: Record<string, string> = {
  youtube: "YT",
  yt: "YT",
  shorts: "YT",
  instagram: "IG",
  ig: "IG",
  reels: "IG",
  tiktok: "TT",
  tt: "TT",
  x: "X",
  twitter: "X",
  facebook: "FB",
  fb: "FB",
  linkedin: "LI",
};

function platformGlyph(p: string): string {
  return PLATFORM_GLYPH[p.trim().toLowerCase()] ?? p.slice(0, 2).toUpperCase();
}

/* Only RENDERED content items have a /post/<id> page. Planned-post entries from the
   content plan (idea/planned/approved/scheduled) carry a plan id with no /post route,
   so linking them to /post 404s — they belong on /calendar instead. */
const RUN_STATUSES = new Set(["rendered", "generated", "published", "posted", "packaged", "draft", "scheduled-render"]);
function isOpenableRun(status?: string): boolean {
  return !!status && RUN_STATUSES.has(status.trim().toLowerCase());
}

function dayLabel(date: string): { wd: string; dom: string } {
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(date) ? `${date}T00:00:00` : date);
  if (Number.isNaN(d.getTime())) return { wd: "", dom: date };
  return { wd: WEEKDAYS[d.getDay()], dom: String(d.getDate()) };
}

export function CalendarWeekView({ b }: { b: UICalendarWeek }) {
  const today = todayIso();
  return (
    <BlockFrame eyebrow="calendar · week" href={b.href}>
      <div className="blk-cal" style={{ gridTemplateColumns: `repeat(${b.days.length}, minmax(0, 1fr))` }}>
        {b.days.map((day, di) => {
          const { wd, dom } = dayLabel(day.date);
          const isToday = day.date.slice(0, 10) === today;
          return (
            <div className="blk-cal-day blk-in" key={di} style={{ "--i": di } as CSSProperties}>
              <div className="blk-cal-date">
                {wd ? <span className="blk-cal-wd">{wd}</span> : null}
                {isToday ? (
                  <span className="blk-today">
                    <span className="blk-cal-dom">{dom}</span>
                    <TodayInk delayMs={350 + di * 55} />
                  </span>
                ) : (
                  <span className="blk-cal-dom">{dom}</span>
                )}
              </div>
              <div className="blk-cal-posts">
                {day.posts.map((p, pi) => {
                  const chip = (
                    <>
                      <span className="blk-cal-title">{p.title}</span>
                      {(p.time || p.platform) ? (
                        <span className="blk-cal-sub">
                          {p.platform ? (
                            <span className="blk-cal-pf" title={p.platform}>
                              {platformGlyph(p.platform)}
                            </span>
                          ) : null}
                          {p.time ? <span className="blk-cal-time">{p.time}</span> : null}
                        </span>
                      ) : null}
                    </>
                  );
                  const cls = `blk-cal-post${p.status ? ` st-${p.status.toLowerCase().replace(/[^a-z0-9]+/g, "-")}` : ""}`;
                  // rendered item → its /post page; planned-post entry → the calendar
                  // (its plan id has no /post route, which is what was 404-ing).
                  const href = p.id && isOpenableRun(p.status)
                    ? `/post/${encodeURIComponent(p.id)}`
                    : (b.href ?? "/calendar");
                  return (
                    <Link className={cls} key={pi} href={href} title={p.title}>
                      {chip}
                    </Link>
                  );
                })}
                {!day.posts.length ? <span className="blk-cal-empty">—</span> : null}
              </div>
            </div>
          );
        })}
      </div>
    </BlockFrame>
  );
}
