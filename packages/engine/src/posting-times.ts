/* ─── Posting-time strategy ──────────────────────────────────────────────────
   "When to post" as a first-class, self-tuning thing. Two layers:

   1. A DEFAULT playbook of high-engagement windows per platform/weekday (general
      short-form best practice, audience-local time). This is the cold-start.
   2. A LEARNED layer: join each published post's actual post time (the publish
      ledger's `at`) with its measured engagement (data/analytics/<id>.json, fed
      by `content stats`). Hours that historically over-performed nudge the
      playbook's rankings up; under-performers down. With enough samples the data
      wins — the schedule literally learns the channel's best times from feedback.

   The output feeds the autopilot schedule (data/schedule.json) as weekday-aware
   HH:MM slots, and a `content besttimes` report so a human can see the call. */

import type { ContentItem } from "@os/schemas";
import { listItems } from "./store.ts";
import { loadAnalytics } from "./learnings.ts";
import { loadSchedule, saveSchedule } from "./schedule.ts";

export type Platform = "instagram" | "tiktok" | "youtube";
type Window = { time: string; days: number[]; w: number }; // days: 0=Sun … 6=Sat

/* Cold-start windows. days = weekdays the window applies to; w = base strength.
   Times are LOCAL to the schedule's timezone (audience-local). */
const PLAYBOOK: Record<Platform, Window[]> = {
  instagram: [
    { time: "07:00", days: [1, 2, 3, 4, 5], w: 0.7 },
    { time: "11:00", days: [1, 2, 3, 4], w: 0.85 },
    { time: "13:00", days: [1, 2, 3, 4, 5], w: 0.8 },
    { time: "19:00", days: [0, 1, 2, 3, 4, 5, 6], w: 1.0 },
    { time: "21:00", days: [0, 2, 3, 4, 5, 6], w: 0.9 },
  ],
  tiktok: [
    { time: "06:00", days: [1, 2, 3, 4, 5], w: 0.75 },
    { time: "10:00", days: [1, 2, 3, 4, 5], w: 0.85 },
    { time: "12:00", days: [2, 3, 4], w: 0.8 },
    { time: "19:00", days: [1, 2, 3, 4], w: 1.0 },
    { time: "22:00", days: [3, 4, 5, 6], w: 0.9 },
  ],
  youtube: [
    { time: "10:00", days: [0, 6], w: 0.85 }, // weekend late-morning
    { time: "12:00", days: [1, 2, 3, 4, 5], w: 0.85 },
    { time: "14:00", days: [2, 3, 4, 5], w: 0.95 }, // ahead of the evening watch
    { time: "15:00", days: [0, 6], w: 0.8 },
    { time: "16:00", days: [4, 5], w: 0.9 }, // Thu/Fri, into the weekend
  ],
};

export const PLATFORMS = Object.keys(PLAYBOOK) as Platform[];
export const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const MIN_SAMPLES = 3; // per hour before learned data is trusted
const LEARN_ALPHA = 0.6; // how hard learned signal bends the base weight

const hourOf = (hhmm: string) => Number(hhmm.split(":")[0]);

/* Local hour/weekday of an ISO instant in a given IANA tz (no deps). */
function localHourWeekday(iso: string, tz: string): { hour: number; weekday: number } | null {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "2-digit",
    hour12: false,
    weekday: "short",
  }).formatToParts(d);
  const hourStr = parts.find((p) => p.type === "hour")?.value ?? "0";
  const wd = parts.find((p) => p.type === "weekday")?.value ?? "Sun";
  return { hour: hourStr === "24" ? 0 : Number(hourStr), weekday: DAY_NAMES.indexOf(wd) };
}

export type HourStat = { hour: number; avgScore: number; samples: number };

/**
 * Observed engagement by hour-of-day for a platform: every published post's
 * ledger time joined with its analytics score. This is the feedback signal.
 */
export function learnedHours(platform: Platform, items: ContentItem[] = listItems()): HourStat[] {
  const tz = loadSchedule().timezone;
  const buckets = new Map<number, { sum: number; n: number }>();
  for (const item of items) {
    const snap = loadAnalytics(item.id);
    if (!snap) continue;
    const metric = snap.metrics.find((m) => m.platform === platform);
    if (!metric) continue;
    for (const e of item.publish ?? []) {
      if (e.platform !== platform || e.status !== "published" || !e.at) continue;
      const lc = localHourWeekday(e.at, tz);
      if (!lc) continue;
      const b = buckets.get(lc.hour) ?? { sum: 0, n: 0 };
      b.sum += metric.score; // 0..100 composite engagement score
      b.n += 1;
      buckets.set(lc.hour, b);
    }
  }
  return [...buckets.entries()]
    .map(([hour, b]) => ({ hour, avgScore: b.sum / b.n, samples: b.n }))
    .sort((a, b) => b.avgScore - a.avgScore);
}

/* Normalize learned hour scores to 0..1 (only hours with enough samples). */
function learnedNorm(platform: Platform, items?: ContentItem[]): Map<number, number> {
  const trusted = learnedHours(platform, items).filter((h) => h.samples >= MIN_SAMPLES);
  const out = new Map<number, number>();
  if (trusted.length < 2) return out; // not enough signal to bend anything yet
  const scores = trusted.map((h) => h.avgScore);
  const lo = Math.min(...scores);
  const hi = Math.max(...scores);
  for (const h of trusted) out.set(h.hour, hi > lo ? (h.avgScore - lo) / (hi - lo) : 0.5);
  return out;
}

/* Base weight bent by the learned signal for that window's hour (neutral 0.5 →
   no change; >0.5 boosts, <0.5 dampens). */
function effectiveWeight(w: Window, norm: Map<number, number>): number {
  const n = norm.get(hourOf(w.time));
  if (n === undefined) return w.w;
  return w.w * (1 + LEARN_ALPHA * (n - 0.5));
}

/** Ranked best post times for a platform on a given weekday. */
export function bestTimes(platform: Platform, weekday: number, n = 1, items?: ContentItem[]): string[] {
  const norm = learnedNorm(platform, items);
  return PLAYBOOK[platform]
    .filter((w) => w.days.includes(weekday))
    .map((w) => ({ time: w.time, score: effectiveWeight(w, norm) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, n)
    .map((x) => x.time)
    .sort();
}

export type DayPlan = { weekday: number; times: string[] };

/** Full weekly plan: the top `perDay` windows for each weekday. */
export function recommendedWeek(platform: Platform, perDay = 1, items?: ContentItem[]): DayPlan[] {
  const cached = items ?? listItems();
  return DAY_NAMES.map((_, weekday) => ({ weekday, times: bestTimes(platform, weekday, perDay, cached) }));
}

/**
 * Write the recommended plan into data/schedule.json for a channel as
 * weekday-aware slots (one slot per unique time, carrying the weekdays it's best
 * on). Does NOT flip the global `enabled` kill switch — opt-in stays manual.
 * `platform` only selects which playbook drives the times; one slot still posts
 * the channel to all its configured platforms when it fires.
 */
export function applyToSchedule(opts: {
  channel: string;
  platform?: Platform;
  perDay?: number;
  public?: boolean;
  mood?: string;
}): { channel: string; slots: { time: string; days: number[] }[] } {
  const platform = opts.platform ?? "instagram";
  const perDay = opts.perDay ?? 1;
  const week = recommendedWeek(platform, perDay);

  // Collapse the day×time grid into one slot per time carrying its weekdays.
  const byTime = new Map<string, Set<number>>();
  for (const day of week)
    for (const t of day.times) (byTime.get(t) ?? byTime.set(t, new Set()).get(t)!).add(day.weekday);

  const slots = [...byTime.entries()]
    .map(([time, days]) => ({ time, days: [...days].sort((a, b) => a - b) }))
    .sort((a, b) => a.time.localeCompare(b.time));

  const s = loadSchedule();
  const cadenceSlots = slots.map((sl) => ({
    time: sl.time,
    channel: opts.channel,
    days: sl.days,
    public: opts.public ?? false,
    seed: "", // autopilot selects the concept
    ...(opts.mood ? { mood: opts.mood } : {}),
  }));
  const existing = s.channels.find((c) => c.channel === opts.channel);
  if (existing) existing.slots = cadenceSlots;
  else s.channels.push({ channel: opts.channel, enabled: true, slots: cadenceSlots });
  saveSchedule(s);
  return { channel: opts.channel, slots };
}

/** Human-readable strategy report (defaults blended with learned feedback). */
export function describe(platform?: Platform): string {
  const items = listItems();
  const platforms = platform ? [platform] : PLATFORMS;
  const lines: string[] = [];
  for (const p of platforms) {
    const learned = learnedHours(p, items);
    const trusted = learned.filter((h) => h.samples >= MIN_SAMPLES);
    lines.push(`\n${p.toUpperCase()} — recommended posting times (local):`);
    for (const { weekday, times } of recommendedWeek(p, 1, items))
      lines.push(`  ${DAY_NAMES[weekday]}  ${times.join(", ") || "—"}`);
    if (trusted.length) {
      const top = trusted.slice(0, 3).map((h) => `${String(h.hour).padStart(2, "0")}:00 (score ${h.avgScore.toFixed(0)}, n=${h.samples})`);
      lines.push(`  ↳ learned best hours: ${top.join(" · ")}`);
    } else {
      const n = learned.reduce((a, h) => a + h.samples, 0);
      lines.push(`  ↳ learning: ${n} post(s) measured so far — need ≥${MIN_SAMPLES}/hour to tune (run \`content stats\`).`);
    }
  }
  return lines.join("\n");
}
