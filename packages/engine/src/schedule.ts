import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { Schedule, type ScheduleSlot } from "@os/schemas";
import { DATA_DIR, ensureDir, nowIso } from "./store.ts";

/* File-based posting schedule (data/schedule.json). Cadence-based, not a
   materialized queue: a launchd tick (see scheduler.ts) fires a channel's HH:MM
   slot when the local clock enters [time, time+grace) and the slot hasn't fired
   yet today. Self-heals after the Mac sleeps; never double-fires within a day. */

export const SCHEDULE_FILE = join(DATA_DIR, "schedule.json");

const DEFAULT: Schedule = {
  enabled: false,
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
  graceMinutes: 10,
  channels: [],
  oneOff: [],
  state: {},
  updatedAt: "",
};

export function loadSchedule(): Schedule {
  if (!existsSync(SCHEDULE_FILE)) return { ...DEFAULT };
  try {
    return Schedule.parse(JSON.parse(readFileSync(SCHEDULE_FILE, "utf8")));
  } catch {
    return { ...DEFAULT };
  }
}

export function saveSchedule(s: Schedule): Schedule {
  ensureDir(DATA_DIR);
  s.updatedAt = nowIso();
  writeFileSync(SCHEDULE_FILE, JSON.stringify(s, null, 2));
  return s;
}

export const slotKey = (channel: string, time: string) => `${channel}@${time}`;

/* Local wall-clock for the schedule's timezone, as { date:"YYYY-MM-DD",
   minutes: minutes-since-midnight }. Uses Intl so DST is handled without a dep. */
const WDAY: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
function localClock(tz: string, now: Date): { date: string; minutes: number; weekday: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    weekday: "short",
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  const hour = get("hour") === "24" ? "00" : get("hour"); // some envs emit 24 for midnight
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    minutes: Number(hour) * 60 + Number(get("minute")),
    weekday: WDAY[get("weekday")] ?? 0,
  };
}

const toMinutes = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
};

/* Slots whose window is open right now and that haven't fired today. */
export function dueSlots(s: Schedule, now: Date = new Date()): ScheduleSlot[] {
  if (!s.enabled) return [];
  const { date, minutes, weekday } = localClock(s.timezone, now);
  const due: ScheduleSlot[] = [];
  for (const ch of s.channels) {
    if (!ch.enabled) continue;
    for (const slot of ch.slots) {
      // Weekday-filtered slots (from the posting-time strategy) only fire on their
      // chosen days; an absent/empty `days` keeps the old fire-every-day behaviour.
      if (slot.days?.length && !slot.days.includes(weekday)) continue;
      const start = toMinutes(slot.time);
      const open = minutes >= start && minutes < start + s.graceMinutes;
      if (!open) continue;
      if (s.state[slotKey(slot.channel, slot.time)]?.lastFiredDate === date) continue;
      due.push(slot);
    }
  }
  return due;
}

/* Explicitly-scheduled single posts whose time has arrived and haven't fired. */
export function dueOneOffs(s: Schedule, now: Date = new Date()): Schedule["oneOff"] {
  if (!s.enabled) return [];
  const t = now.getTime();
  return s.oneOff.filter((o) => !o.firedAt && new Date(o.at).getTime() <= t);
}

export function markFired(s: Schedule, channel: string, time: string, itemId?: string, result?: string): Schedule {
  const { date } = localClock(s.timezone, new Date());
  s.state[slotKey(channel, time)] = { lastFiredDate: date, lastItemId: itemId, lastResult: result };
  return s;
}

export function markOneOffFired(s: Schedule, itemId: string): Schedule {
  const o = s.oneOff.find((x) => x.itemId === itemId && !x.firedAt);
  if (o) o.firedAt = nowIso();
  return s;
}

/* The next slot that will fire after `now`, for the dashboard status card. */
export function nextDue(s: Schedule, now: Date = new Date()): { slot: ScheduleSlot; at: string } | null {
  if (!s.enabled) return null;
  const { minutes } = localClock(s.timezone, now);
  let best: { slot: ScheduleSlot; delta: number } | null = null;
  for (const ch of s.channels) {
    if (!ch.enabled) continue;
    for (const slot of ch.slots) {
      const start = toMinutes(slot.time);
      const delta = start >= minutes ? start - minutes : start - minutes + 1440; // wrap to tomorrow
      if (!best || delta < best.delta) best = { slot, delta };
    }
  }
  if (!best) return null;
  const at = new Date(now.getTime() + best.delta * 60_000).toISOString();
  return { slot: best.slot, at };
}
