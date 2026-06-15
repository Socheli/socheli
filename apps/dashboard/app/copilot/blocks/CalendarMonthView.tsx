"use client";
import Link from "next/link";
import type { CSSProperties } from "react";
import type { UICalendarMonth, MonthEvent } from "../../../lib/agent/ui-spec";
import { BlockFrame } from "./BlockFrame";
import { TodayInk } from "./TodayInk";

/* Proper month grid (weeks × 7, Sun-first like the week strip). Each day cell
   shows its number plus up to two tiny event chips and a "+n" overflow; chips
   with a post id deep-link to /post/<id>, today gets the ink highlight, and
   the header's "open →" goes to the full /calendar.

   Sketch-deep: cells cascade in reading order (.blk-in — the CSS caps the
   total delay so a full month never waits) and today's day number gets a
   hand-drawn ink circle that draws around it in ~600ms. */

const WEEKDAYS = ["S", "M", "T", "W", "T", "F", "S"];

/* Only RENDERED items have a /post/<id> page; planned-post entries (idea/planned/
   approved/scheduled) carry a plan id with no /post route and would 404. */
const RUN_STATUSES = new Set(["rendered", "generated", "published", "posted", "packaged", "draft", "scheduled-render"]);
const isOpenableRun = (status?: string) => !!status && RUN_STATUSES.has(status.trim().toLowerCase());

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

const MAX_CHIPS_PER_DAY = 2;

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

export function CalendarMonthView({ b }: { b: UICalendarMonth }) {
  const year = Number(b.month.slice(0, 4));
  const monthIdx = Number(b.month.slice(5, 7)) - 1; // 0-based
  const first = new Date(year, monthIdx, 1);
  const daysInMonth = new Date(year, monthIdx + 1, 0).getDate();
  const lead = first.getDay(); // blanks before day 1 (Sun-first)

  // Bucket events by day-of-month; tolerate full ISO timestamps in `date`.
  const byDay = new Map<number, MonthEvent[]>();
  for (const ev of b.events) {
    const m = ev.date.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!m || m[1] !== b.month.slice(0, 4) || m[2] !== b.month.slice(5, 7)) continue;
    const dom = Number(m[3]);
    if (dom < 1 || dom > daysInMonth) continue;
    const list = byDay.get(dom) ?? [];
    list.push(ev);
    byDay.set(dom, list);
  }

  const now = new Date();
  const today =
    now.getFullYear() === year && now.getMonth() === monthIdx ? now.getDate() : null;

  const cells: (number | null)[] = [
    ...Array.from({ length: lead }, () => null),
    ...Array.from({ length: daysInMonth }, (_, i) => i + 1),
  ];
  while (cells.length % 7 !== 0) cells.push(null);

  const monthLabel = `${MONTHS[monthIdx] ?? b.month} ${year}`;

  return (
    <BlockFrame eyebrow="calendar · month" href={b.href} meta={monthLabel}>
      <div className="blk-cm">
        <div className="blk-cm-grid blk-cm-wds">
          {WEEKDAYS.map((wd, i) => (
            <span className="blk-cm-wd" key={i}>
              {wd}
            </span>
          ))}
        </div>
        <div className="blk-cm-grid">
          {cells.map((dom, i) => {
            if (dom == null) return <span className="blk-cm-cell blank" key={i} />;
            const evs = byDay.get(dom) ?? [];
            const overflow = evs.length - MAX_CHIPS_PER_DAY;
            const dateIso = `${b.month}-${pad2(dom)}`;
            return (
              <div
                className={`blk-cm-cell blk-in${dom === today ? " today" : ""}`}
                key={i}
                style={{ "--i": i } as CSSProperties}
              >
                {dom === today ? (
                  <span className="blk-today">
                    <span className="blk-cm-dom">{dom}</span>
                    <TodayInk delayMs={450} />
                  </span>
                ) : (
                  <span className="blk-cm-dom">{dom}</span>
                )}
                {evs.slice(0, MAX_CHIPS_PER_DAY).map((ev, ei) => {
                  const cls = `blk-cm-ev k-${ev.kind ?? "post"}${
                    ev.status ? ` st-${ev.status.toLowerCase().replace(/[^a-z0-9]+/g, "-")}` : ""
                  }`;
                  const chip = (
                    <>
                      <span className="blk-cm-dot" />
                      <span className="blk-cm-ev-title">{ev.title}</span>
                    </>
                  );
                  const tip = `${dateIso} · ${ev.title}${ev.status ? ` · ${ev.status}` : ""}`;
                  // rendered post → its /post page; planned-post entry → the calendar
                  // (its plan id has no /post route, which is what was 404-ing).
                  const openable = ev.id && (ev.kind ?? "post") === "post" && isOpenableRun(ev.status);
                  const href = openable ? `/post/${encodeURIComponent(ev.id!)}` : (b.href ?? "/calendar");
                  return (
                    <Link className={cls} key={ei} href={href} title={tip}>
                      {chip}
                    </Link>
                  );
                })}
                {overflow > 0 ? <span className="blk-cm-more">+{overflow}</span> : null}
              </div>
            );
          })}
        </div>
      </div>
    </BlockFrame>
  );
}
