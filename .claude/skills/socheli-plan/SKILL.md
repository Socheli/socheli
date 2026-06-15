---
name: socheli-plan
description: Run the algorithm-hacking planner to fill the content calendar, and manage planned posts (list/create/move/edit/archive). Use for "plan content", "fill the calendar", "what's scheduled", or rescheduling requests.
---

# Content planning: algo plan → calendar CRUD

Prefer the MCP tools on the `socheli` server. The plan lives in
`data/content-plan.json`; per-channel strategy briefs are saved alongside.

## Run the planner

1. **Check what exists.** `plan_list` `{channel?}` — never double-book dates or
   duplicate angles already planned. `plan_strategy` `{channel}` shows the saved
   research brief from the last plan run (null if never planned).
2. **Run it.** `plan_run` `{channel, days: 14, platforms?, time?}` —
   LONG-RUNNING: deep channel/subject research + per-platform algorithm
   playbooks → dated posts appended to the calendar. Returns
   `{status:"started", pid, logPath}`; watch progress by re-calling `plan_list`.
3. **Review.** Each planned post carries topic, angle, format, hook, platform,
   date/time, `algoLever` (the ranking signal it pulls) and scores. Summarize
   the plan for the user.

CLI fallback (foreground, streams research steps as NDJSON):

```sh
pnpm content algo-plan --channel <id> [--days 14] [--platforms instagram,tiktok] \
  [--time 09:00] [--dry]
```

## Calendar CRUD

- `plan_day` `{date: "YYYY-MM-DD"}` — everything on one day.
- `plan_get` `{id}` — one post in full.
- `plan_create` `{channel, date, time, platform, topic, …}` — hand-add a post.
- `plan_update` `{id, patch}` — edit fields (status, topic, hook, mood…).
- `plan_move` `{id, date, time?}` — reschedule (the drag-and-drop API).
- `plan_archive` `{id}` — reversible hide; `plan_delete` `{id}` — permanent.

## Related

- Freeform day ideas: `pnpm content brainstorm "<prompt>" [--channel] [--date]`.
- Posting-time strategy: `pnpm content besttimes` and
  `pnpm content schedule:auto --channel <id> --platform <p>` (writes weekday
  slots; autopilot stays OFF until explicitly enabled).
- Building a planned post into a video → `socheli-post` skill (pass the planned
  topic/angle/mood as the idea).
