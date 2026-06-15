# Posting Times

*When* a post goes out matters as much as what it is. Socheli treats posting time
as a first-class, self-tuning strategy rather than a fixed cron.

## Two layers

1. **Default playbook** — high-engagement windows per platform and weekday
   (audience-local time), used cold-start before there's any data. Tuned for
   short-form: Instagram leans midday + evening (peak ~19:00), TikTok early
   morning + late evening, YouTube early afternoon on weekdays and late mornings
   on weekends.

2. **Learned feedback** — every published post's actual post time (from the
   publish ledger's `at`) is joined with its measured engagement
   (`data/analytics/<id>.json`, populated by `content stats`). Hours that
   historically over-perform nudge the playbook's rankings up; under-performers
   down. Once an hour has ≥3 samples it's trusted and the data starts to win — so
   the schedule literally learns the channel's best times from results.

The blend lives in `packages/engine/src/posting-times.ts`.

## See the strategy

```bash
content besttimes                 # all platforms
content besttimes --platform tiktok
```

Prints the recommended weekly windows plus, once enough posts are measured, the
learned best hours with their engagement score and sample count.

## Apply it to the autopilot schedule

```bash
content schedule:auto --channel concept_lab --platform instagram --per-day 1
```

This writes **weekday-aware** slots into `data/schedule.json`: one `HH:MM` slot
per recommended time, each carrying the `days` (0=Sun … 6=Sat) it's best on. A
slot only fires on its chosen days (an absent `days` keeps the old fire-every-day
behaviour, so existing schedules are unaffected).

`--per-day N` schedules the top N windows per day; `--public` posts publicly;
`--mood <id>` pins a mood. The command **does not** flip the global autopilot
kill switch — enabling autopilot stays a deliberate opt-in
(`schedule.enabled`, or the dashboard).

> One slot posts the channel to *all* its configured platforms when it fires;
> `--platform` only selects which playbook drives the times. Use `content besttimes`
> to compare per-platform optima.

## Feedback loop

```
post (ledger records `at`) → content stats (fetch engagement → analytics/<id>.json)
   → learnedHours() ranks hours by score → besttimes / schedule:auto shift toward
   what actually worked
```

Run `content stats` regularly (or on a timer) to keep the feedback signal fresh.
