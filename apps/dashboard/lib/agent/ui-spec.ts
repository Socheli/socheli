import type { OpenAITool } from "./tools";

/* Shared, SAFE declarative UI spec for the Socheli copilot's generative UI.

   The agent calls a LOCAL tool `ui_render({ blocks })` to render rich inline UI
   in the chat (concept cards, video previews, stat grids, tables, images,
   callouts, markdown, plus INTERACTIVE action-buttons and forms). The spec is a
   safe declarative union — there is NEVER any raw/unsanitized HTML. The client
   renderer maps these blocks to dark-themed React; markdown is a tiny safe
   subset rendered as React nodes (no dangerouslySetInnerHTML).

   This module is imported by BOTH the server (tool registration + validation in
   graph/orchestration) and the client (renderer), so it must stay free of any
   server-only or engine imports. */

/* ---- Caps to keep rendered specs bounded and the chat snappy. ---- */
const MAX_BLOCKS = 40;
const MAX_STR = 2000;
const MAX_FIELDS = 12;
const MAX_STATS = 12;
const MAX_TABLE_COLS = 12;
const MAX_TABLE_ROWS = 50;
const MAX_BUTTONS = 8;
const MAX_OPTIONS = 30;
const MAX_SVG = 20000;
const MAX_HTML = 20000;
/* domain blocks */
const MAX_CAL_DAYS = 7;
const MAX_CAL_POSTS = 8;
const MAX_SCENES = 12;
const MAX_LOG_LINES = 8;
const MAX_SERIES = 12;
const MAX_GATE_REASONS = 10;
const MAX_CALLS = 6;
const MAX_TRAITS = 24;
const MAX_THREADS = 5;
const MAX_MONTH_EVENTS = 62;
const MAX_SCORE_ROWS = 8;
const MAX_TIMELINE_EVENTS = 10;
const MAX_PUBLISHED_TO = 6;
const MAX_ANNOTATE_TEXT = 400;
const MAX_ANNOTATE_EMPHASIS = 3;
const MAX_BOARD_CHILDREN = 6;
/* widget blocks (v3) */
const MAX_SPARK_POINTS = 60;
const MAX_DONUT_SLICES = 6;
const MAX_HEATMAP_X = 12;
const MAX_HEATMAP_Y = 7;
const MAX_FUNNEL_STAGES = 6;
const MAX_CHECK_ITEMS = 10;
const MAX_QUOTE_TEXT = 280;
const MAX_BADGES = 10;
const MAX_SLOTS = 8;
const MAX_HOOKS = 6;
const MAX_SCRIPT_LINES = 12;
const MAX_TAGS = 12;
const MAX_WAVE_BARS = 48;
const MAX_PALETTE_COLORS = 8;
const MAX_PIPELINE_STAGES = 7;

export type CardField = { label: string; value: string };

export type UICard = {
  type: "card";
  title: string;
  subtitle?: string;
  fields?: CardField[];
  thumbUrl?: string;
  href?: string;
};

export type UIStat = { label: string; value: string; unit?: string };
export type UIStatGrid = { type: "stat_grid"; stats: UIStat[] };

export type UITable = { type: "table"; columns: string[]; rows: string[][] };

export type UIVideo = {
  type: "video";
  id: string;
  title: string;
  thumbUrl?: string;
  status?: string;
};

export type UIConcept = {
  type: "concept";
  id: string;
  title: string;
  score?: number;
  status?: string;
};

export type UIImage = { type: "image"; url: string; caption?: string };

export type CalloutTone = "info" | "warn" | "ok" | "err";
export type UICallout = { type: "callout"; tone: CalloutTone; text: string };

export type UIMarkdown = { type: "markdown"; text: string };

/* An explorable collapsible TREE for arbitrary structured (JSON-serializable)
   data — the rich replacement for a raw pretty-JSON dump when no specific widget
   fits. `data` is any JSON value; the client renders it through JsonTree. */
export type UIJsonTree = { type: "json_tree"; data: unknown; label?: string };

export type UIProgress = { type: "progress"; label?: string; value: number; caption?: string; tone?: CalloutTone; jobId?: string; itemId?: string };

export type StepState = "done" | "active" | "pending" | "error";
export type UIStepItem = { label: string; state: StepState; detail?: string };
export type UISteps = { type: "steps"; title?: string; items: UIStepItem[] };

export type UIKeyValueItem = { key: string; value: string };
export type UIKeyValue = { type: "key_value"; title?: string; items: UIKeyValueItem[] };

export type UIActionButton = { label: string; send: string };
export type UIActions = { type: "actions"; buttons: UIActionButton[] };

export type FormFieldType = "text" | "number" | "textarea" | "select";
export type UIFormField = {
  name: string;
  label: string;
  type: FormFieldType;
  options?: string[];
  placeholder?: string;
};
export type UIForm = {
  type: "form";
  title?: string;
  fields: UIFormField[];
  submitLabel: string;
  sendTemplate?: string;
};

/* A hand-drawn explanatory SVG sketch. The svg string is model-generated and
   therefore UNTRUSTED — the client renders it exclusively through the
   SafeSketch sanitizer (components/sketch/SafeSketch.tsx); the validator below
   is only a cheap server-side pre-filter. */
export type UISketch = { type: "sketch"; svg: string; caption?: string };

/* A custom HTML/CSS/SVG visualization — the escape hatch for when none of the
   fixed block types fit. The html string is model-generated and therefore
   UNTRUSTED; it is rendered EXCLUSIVELY through a locked sandboxed <iframe>
   (components/sketch/SafeHtml.tsx, sandbox="" → no scripts, opaque origin), so
   it is XSS-proof by construction. The validator below only bounds size and
   clamps the height hint. */
export type UIHtml = { type: "html"; html: string; caption?: string; height?: number };

/* ---- Domain blocks: rich inline views of one capability each. Every domain
   block carries an `href` deep-link to its full page — the block is the
   inline glance, the link is the zoomed-in page ("callback" pattern). ---- */

export type CalendarPost = { id: string; title: string; time?: string; platform?: string; status?: string };
export type CalendarDay = { date: string; posts: CalendarPost[] };
export type UICalendarWeek = { type: "calendar_week"; days: CalendarDay[]; href?: string };

export type StoryboardScene = { id: string; caption?: string; thumb?: string; durationSec?: number };
export type UIStoryboard = { type: "storyboard"; itemId: string; scenes: StoryboardScene[]; href?: string };

export type RenderStatus = "running" | "done" | "failed";
export type UIRenderProgress = {
  type: "render_progress";
  itemId: string;
  stage: string;
  pct?: number;
  log?: string[];
  status: RenderStatus;
  href?: string;
};

export type InsightPoint = { label: string; value: number; delta?: number };
export type UIInsightsChart = { type: "insights_chart"; title?: string; series: InsightPoint[]; unit?: string; href?: string };

export type BoostCall = { step: string; path: string };
export type UIBoostPreview = {
  type: "boost_preview";
  adId: string;
  status: string;
  dailyBudgetUsd: number;
  durationDays: number;
  gateReasons: string[];
  calls?: BoostCall[];
  href?: string;
};

export type GenomeTrait = { kind: string; text: string; weight?: number };
export type UIGenome = { type: "genome"; channel: string; traits: GenomeTrait[]; href?: string };

export type InboxCounts = { comments?: number; dms?: number; flagged?: number };
export type InboxThread = { id: string; from: string; preview: string; kind?: string };
export type UIInboxSummary = { type: "inbox_summary"; counts?: InboxCounts; threads: InboxThread[]; href?: string };

export type MonthEventKind = "post" | "event" | "reminder";
export type MonthEvent = { date: string; title: string; id?: string; kind?: MonthEventKind; status?: string };
export type UICalendarMonth = { type: "calendar_month"; month: string; events: MonthEvent[]; href?: string };

export type PostMetrics = { views?: number; likes?: number; comments?: number };
export type UIPostCard = {
  type: "post_card";
  itemId: string;
  title: string;
  status: string;
  thumb?: string;
  durationSec?: number;
  mood?: string;
  channel?: string;
  publishedTo?: string[];
  metrics?: PostMetrics;
  href?: string;
};

export type ScoreVerdict = "strong" | "variable" | "weak";
export type ScoreRow = { label: string; verdict: ScoreVerdict; note?: string };
export type UIScorecard = { type: "scorecard"; title?: string; rows: ScoreRow[]; href?: string };

export type TimelineEvent = { at: string; title: string; detail?: string; kind?: string };
export type UITimeline = { type: "timeline"; events: TimelineEvent[]; href?: string };

/* Hand-annotated statement: a short text in which up to three phrases are
   emphasized with baked wobbled ink (a drawn circle around, or a drawn
   underline beneath), plus an optional small mono margin note. Soli's
   replacement for **bold** when ONE number/phrase carries the message. */
export type AnnotateStyle = "circle" | "underline";
export type AnnotateEmphasis = { phrase: string; style: AnnotateStyle };
export type UIAnnotate = {
  type: "annotate";
  text: string;
  emphasis: AnnotateEmphasis[];
  note?: string;
};

/* Composite layout: a 2- or 3-column grid of nested blocks so Soli can
   compose a small dashboard mid-chat. Depth 1 only — a board can NEVER
   contain another board; children are validated with the same per-block
   validators (silent drops apply). */
export type UIBoard = {
  type: "board";
  title?: string;
  columns: 2 | 3;
  blocks: UIBlock[];
};

/* ---- Widget blocks (v3): small, single-purpose ink-animated views. Charts
   draw themselves (stroke-dashoffset / arc sweep), stats count up, chips and
   swatches pop in — all on the shared sketch grammar, all reduced-motion
   safe. Each carries an optional `href` deep-link like the domain blocks. ---- */

/* charts */
export type UISparkline = { type: "sparkline"; title?: string; points: number[]; unit?: string; startLabel?: string; endLabel?: string; href?: string };
export type DonutSlice = { label: string; value: number };
export type UIDonut = { type: "donut"; title?: string; slices: DonutSlice[]; unit?: string; href?: string };
export type UIGauge = { type: "gauge"; label: string; value: number; target?: number; unit?: string; href?: string };
export type UIHeatmap = { type: "heatmap"; title?: string; xLabels: string[]; yLabels: string[]; cells: number[][]; href?: string };
export type FunnelStage = { label: string; value: number };
export type UIFunnel = { type: "funnel"; title?: string; stages: FunnelStage[]; unit?: string; href?: string };

/* stats & emphasis */
export type UIMetric = { type: "metric"; label: string; value: number; unit?: string; delta?: number; href?: string };
export type VerdictKind = "go" | "hold" | "kill";
export type UIVerdict = { type: "verdict"; verdict: VerdictKind; title: string; reason?: string; href?: string };
export type ChecklistItem = { label: string; done: boolean };
export type UIChecklist = { type: "checklist"; title?: string; items: ChecklistItem[]; href?: string };
export type UIQuote = { type: "quote"; text: string; by?: string; href?: string };
export type BadgeKind = "default" | "accent" | "ok" | "warn" | "err";
export type Badge = { label: string; kind?: BadgeKind };
export type UIBadgeRow = { type: "badge_row"; title?: string; badges: Badge[] };
export type UIRating = { type: "rating"; label?: string; value: number; href?: string };

/* ops */
export type UICountdown = { type: "countdown"; label: string; at: string; href?: string };
export type ScheduleSlotItem = { day: string; time: string; score?: number };
export type UISlots = { type: "slots"; title?: string; slots: ScheduleSlotItem[]; href?: string };
export type MissionStatus = "active" | "paused" | "done";
export type UIMissionCard = { type: "mission_card"; missionId: string; goal: string; status: MissionStatus; cadence?: string; nextRun?: string; href?: string };
export type UIBudgetMeter = { type: "budget_meter"; label?: string; spentUsd: number; capUsd: number; href?: string };
export type UIGateBlock = { type: "gate"; title: string; kind?: string; summary?: string; href?: string };
export type DeviceStatus = "online" | "busy" | "offline";
export type UIDeviceCard = { type: "device_card"; device: string; status: DeviceStatus; job?: string; hw?: string; href?: string };

/* content craft */
export type HookVariant = { text: string; score?: number };
export type UIHookLab = { type: "hook_lab"; title?: string; hooks: HookVariant[]; href?: string };
export type ScriptLine = { at?: string; text: string };
export type UIScriptLines = { type: "script_lines"; title?: string; lines: ScriptLine[]; href?: string };
export type AbCell = { label: string; value: string };
export type UIAbTest = { type: "ab_test"; metric?: string; a: AbCell; b: AbCell; winner?: "a" | "b"; href?: string };
export type TrendTag = { label: string; heat?: number };
export type UITrendTags = { type: "trend_tags"; title?: string; tags: TrendTag[]; href?: string };
export type UIVoiceTrack = { type: "voice_track"; title?: string; durationSec?: number; bars?: number[]; href?: string };
export type PaletteColor = { hex: string; name?: string };
export type UIPalette = { type: "palette"; title?: string; colors: PaletteColor[]; href?: string };
export type PipelineStage = { label: string; state: StepState };
export type UIPipeline = { type: "pipeline"; stages: PipelineStage[]; href?: string };
export type UIDiff = { type: "diff"; title?: string; before: string; after: string; href?: string };

export type UIBlock =
  | UICard
  | UIStatGrid
  | UITable
  | UIVideo
  | UIConcept
  | UIImage
  | UICallout
  | UIMarkdown
  | UIJsonTree
  | UIProgress
  | UISteps
  | UIKeyValue
  | UIActions
  | UIForm
  | UISketch
  | UIHtml
  | UICalendarWeek
  | UIStoryboard
  | UIRenderProgress
  | UIInsightsChart
  | UIBoostPreview
  | UIGenome
  | UIInboxSummary
  | UICalendarMonth
  | UIPostCard
  | UIScorecard
  | UITimeline
  | UIAnnotate
  | UIBoard
  | UISparkline
  | UIDonut
  | UIGauge
  | UIHeatmap
  | UIFunnel
  | UIMetric
  | UIVerdict
  | UIChecklist
  | UIQuote
  | UIBadgeRow
  | UIRating
  | UICountdown
  | UISlots
  | UIMissionCard
  | UIBudgetMeter
  | UIGateBlock
  | UIDeviceCard
  | UIHookLab
  | UIScriptLines
  | UIAbTest
  | UITrendTags
  | UIVoiceTrack
  | UIPalette
  | UIPipeline
  | UIDiff;

export type UIBlockType = UIBlock["type"];

export const KNOWN_TYPES: ReadonlySet<string> = new Set([
  "card",
  "stat_grid",
  "table",
  "video",
  "concept",
  "image",
  "callout",
  "markdown",
  "json_tree",
  "progress",
  "steps",
  "key_value",
  "actions",
  "form",
  "sketch",
  "html",
  "calendar_week",
  "storyboard",
  "render_progress",
  "insights_chart",
  "boost_preview",
  "genome",
  "inbox_summary",
  "calendar_month",
  "post_card",
  "scorecard",
  "timeline",
  "annotate",
  "board",
  "sparkline",
  "donut",
  "gauge",
  "heatmap",
  "funnel",
  "metric",
  "verdict",
  "checklist",
  "quote",
  "badge_row",
  "rating",
  "countdown",
  "slots",
  "mission_card",
  "budget_meter",
  "gate",
  "device_card",
  "hook_lab",
  "script_lines",
  "ab_test",
  "trend_tags",
  "voice_track",
  "palette",
  "pipeline",
  "diff",
]);

/* ---------- coercion helpers ---------- */

function str(v: unknown, max = MAX_STR): string {
  if (v == null) return "";
  const s = typeof v === "string" ? v : typeof v === "number" || typeof v === "boolean" ? String(v) : "";
  return s.length > max ? s.slice(0, max) : s;
}

function optStr(v: unknown, max = MAX_STR): string | undefined {
  if (v == null || v === "") return undefined;
  const s = str(v, max);
  return s || undefined;
}

function optNum(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

/* Only allow http(s) and data:image urls; otherwise drop (prevents javascript:
   and other unsafe schemes from ever reaching href/src). */
function safeUrl(v: unknown): string | undefined {
  const s = optStr(v, 4000);
  if (!s) return undefined;
  const t = s.trim();
  if (/^https?:\/\//i.test(t)) return t;
  if (/^data:image\//i.test(t)) return t;
  // same-origin app links (e.g. /post/<id>) — but reject protocol-relative
  // URLs like //evil.com which also start with "/" and would go off-origin.
  if (t.startsWith("/") && !t.startsWith("//")) return t;
  return undefined;
}

/* ---------- per-block validators (return null to DROP the block) ---------- */

function vCard(o: Record<string, unknown>): UICard | null {
  const title = str(o.title, 300);
  if (!title) return null;
  const rawFields = arr(o.fields).slice(0, MAX_FIELDS);
  const fields = rawFields
    .map((f) => {
      const x = (f ?? {}) as Record<string, unknown>;
      const label = str(x.label, 200);
      const value = str(x.value, 600);
      if (!label && !value) return null;
      return { label, value } as CardField;
    })
    .filter((x): x is CardField => x !== null);
  return {
    type: "card",
    title,
    subtitle: optStr(o.subtitle, 600),
    fields: fields.length ? fields : undefined,
    thumbUrl: safeUrl(o.thumbUrl),
    href: safeUrl(o.href),
  };
}

function vStatGrid(o: Record<string, unknown>): UIStatGrid | null {
  const stats = arr(o.stats)
    .slice(0, MAX_STATS)
    .map((s) => {
      const x = (s ?? {}) as Record<string, unknown>;
      const label = str(x.label, 120);
      const value = str(x.value, 120);
      if (!label && !value) return null;
      return { label, value, unit: optStr(x.unit, 40) } as UIStat;
    })
    .filter((x): x is UIStat => x !== null);
  if (!stats.length) return null;
  return { type: "stat_grid", stats };
}

function vTable(o: Record<string, unknown>): UITable | null {
  const columns = arr(o.columns)
    .slice(0, MAX_TABLE_COLS)
    .map((c) => str(c, 120));
  if (!columns.length) return null;
  const width = columns.length;
  const rows = arr(o.rows)
    .slice(0, MAX_TABLE_ROWS)
    .map((r) => {
      const cells = arr(r)
        .slice(0, width)
        .map((c) => str(c, 400));
      while (cells.length < width) cells.push("");
      return cells;
    });
  return { type: "table", columns, rows };
}

function vVideo(o: Record<string, unknown>): UIVideo | null {
  const id = str(o.id, 200);
  const title = str(o.title, 300);
  if (!id && !title) return null;
  return {
    type: "video",
    id,
    title: title || id,
    thumbUrl: safeUrl(o.thumbUrl),
    status: optStr(o.status, 60),
  };
}

function vConcept(o: Record<string, unknown>): UIConcept | null {
  const id = str(o.id, 200);
  const title = str(o.title, 300);
  if (!id && !title) return null;
  return {
    type: "concept",
    id,
    title: title || id,
    score: optNum(o.score),
    status: optStr(o.status, 60),
  };
}

function vImage(o: Record<string, unknown>): UIImage | null {
  const url = safeUrl(o.url);
  if (!url) return null;
  return { type: "image", url, caption: optStr(o.caption, 400) };
}

function vCallout(o: Record<string, unknown>): UICallout | null {
  const text = str(o.text, 1200);
  if (!text) return null;
  const toneRaw = str(o.tone, 12);
  const tone: CalloutTone =
    toneRaw === "warn" || toneRaw === "ok" || toneRaw === "err" ? toneRaw : "info";
  return { type: "callout", tone, text };
}

function vMarkdown(o: Record<string, unknown>): UIMarkdown | null {
  const text = str(o.text, MAX_STR);
  if (!text) return null;
  return { type: "markdown", text };
}

/* json_tree: accept any JSON-serializable `data`. We round-trip it through
   JSON to (a) strip anything non-serializable (functions/symbols/undefined/
   circular → dropped or throws → declined), and (b) bound the serialized size
   so a giant payload can't bloat the transported spec. Empty (no data, or an
   empty object/array) is dropped — there's nothing to explore. */
const MAX_JSON_TREE = 40_000;
function vJsonTree(o: Record<string, unknown>): UIJsonTree | null {
  if (!("data" in o)) return null;
  let serial: string;
  try {
    serial = JSON.stringify(o.data);
  } catch {
    return null; // circular / non-serializable
  }
  if (serial == null) return null; // undefined / function / symbol
  if (serial.length > MAX_JSON_TREE) return null;
  // Drop empties: null, "", {}, [] carry nothing to explore.
  if (serial === "null" || serial === '""' || serial === "{}" || serial === "[]") return null;
  // Re-parse so `data` is a clean plain JSON value (no prototype surprises).
  const data = JSON.parse(serial);
  return { type: "json_tree", data, label: optStr(o.label, 80) };
}

function vProgress(o: Record<string, unknown>): UIProgress | null {
  const raw = optNum(o.value);
  if (raw == null) return null;
  const value = Math.max(0, Math.min(100, Math.round(raw)));
  const toneRaw = str(o.tone, 12);
  const tone: CalloutTone | undefined =
    toneRaw === "warn" || toneRaw === "ok" || toneRaw === "err" || toneRaw === "info" ? toneRaw : undefined;
  return { type: "progress", label: optStr(o.label, 160), value, caption: optStr(o.caption, 200), tone, jobId: optStr(o.jobId, 80), itemId: optStr(o.itemId, 80) };
}

function vSteps(o: Record<string, unknown>): UISteps | null {
  const items = arr(o.items)
    .slice(0, MAX_FIELDS)
    .map((s) => {
      const x = (s ?? {}) as Record<string, unknown>;
      const label = str(x.label, 200);
      if (!label) return null;
      const st = str(x.state, 12);
      const state: StepState = st === "done" || st === "active" || st === "error" ? st : "pending";
      return { label, state, detail: optStr(x.detail, 300) } as UIStepItem;
    })
    .filter((x): x is UIStepItem => x !== null);
  if (!items.length) return null;
  return { type: "steps", title: optStr(o.title, 200), items };
}

function vKeyValue(o: Record<string, unknown>): UIKeyValue | null {
  const items = arr(o.items)
    .slice(0, MAX_FIELDS)
    .map((kv) => {
      const x = (kv ?? {}) as Record<string, unknown>;
      const key = str(x.key, 200);
      const value = str(x.value, 600);
      if (!key && !value) return null;
      return { key, value } as UIKeyValueItem;
    })
    .filter((x): x is UIKeyValueItem => x !== null);
  if (!items.length) return null;
  return { type: "key_value", title: optStr(o.title, 200), items };
}

function vActions(o: Record<string, unknown>): UIActions | null {
  const buttons = arr(o.buttons)
    .slice(0, MAX_BUTTONS)
    .map((b) => {
      const x = (b ?? {}) as Record<string, unknown>;
      const label = str(x.label, 120);
      const send = str(x.send, 1200);
      if (!label || !send) return null;
      return { label, send } as UIActionButton;
    })
    .filter((x): x is UIActionButton => x !== null);
  if (!buttons.length) return null;
  return { type: "actions", buttons };
}

function vForm(o: Record<string, unknown>): UIForm | null {
  const fields = arr(o.fields)
    .slice(0, MAX_FIELDS)
    .map((f) => {
      const x = (f ?? {}) as Record<string, unknown>;
      const name = str(x.name, 80);
      const label = str(x.label, 200);
      if (!name) return null;
      const t = str(x.type, 20);
      const type: FormFieldType =
        t === "number" || t === "textarea" || t === "select" ? t : "text";
      const options =
        type === "select"
          ? arr(x.options)
              .slice(0, MAX_OPTIONS)
              .map((op) => str(op, 200))
              .filter(Boolean)
          : undefined;
      return {
        name,
        label: label || name,
        type,
        options: options && options.length ? options : undefined,
        placeholder: optStr(x.placeholder, 200),
      } as UIFormField;
    })
    .filter((x): x is UIFormField => x !== null);
  if (!fields.length) return null;
  return {
    type: "form",
    title: optStr(o.title, 200),
    fields,
    submitLabel: str(o.submitLabel, 80) || "Submit",
    sendTemplate: optStr(o.sendTemplate, 1200),
  };
}

function vSketch(o: Record<string, unknown>): UISketch | null {
  // Cheap server-side pre-filter only — the REAL sanitizer is SafeSketch on the
  // client (DOMParser + element/attribute allowlists). Here we just bound the
  // size, require an <svg…> root, and drop the obviously hostile.
  if (typeof o.svg !== "string") return null;
  if (o.svg.length > MAX_SVG) return null;
  const svg = o.svg.trim();
  if (!svg.startsWith("<svg")) return null;
  const lower = svg.toLowerCase();
  if (
    lower.includes("<script") ||
    lower.includes("javascript:") ||
    lower.includes("onerror") ||
    lower.includes("onload")
  ) {
    return null;
  }
  return { type: "sketch", svg, caption: optStr(o.caption, 400) };
}

/* A custom HTML/CSS/SVG visualization. Unlike sketch, this is NOT sanitized
   element-by-element — it is rendered in a locked sandboxed iframe (sandbox=""
   → scripts inert, opaque origin) by SafeHtml, so it is XSS-proof regardless of
   content. This validator only enforces the size cap, clamps the height hint to
   a sensible 120-600px, and drops a block that has nothing renderable (no
   angle bracket at all → not markup, likely a mistake). */
function vHtml(o: Record<string, unknown>): UIHtml | null {
  if (typeof o.html !== "string") return null;
  const html = o.html.trim();
  if (!html || html.length > MAX_HTML) return null;
  // Must contain at least one tag/element to be a "visualization" — a bare
  // sentence belongs in markdown, not here.
  if (!html.includes("<")) return null;
  const raw = optNum(o.height);
  const height = raw == null ? undefined : Math.max(120, Math.min(600, Math.round(raw)));
  return { type: "html", html, caption: optStr(o.caption, 400), height };
}

/* ---------- domain-block validators ---------- */

function vCalendarWeek(o: Record<string, unknown>): UICalendarWeek | null {
  const days = arr(o.days)
    .slice(0, MAX_CAL_DAYS)
    .map((d) => {
      const x = (d ?? {}) as Record<string, unknown>;
      const date = str(x.date, 40);
      if (!date) return null;
      const posts = arr(x.posts)
        .slice(0, MAX_CAL_POSTS)
        .map((p) => {
          const y = (p ?? {}) as Record<string, unknown>;
          const id = str(y.id, 120);
          const title = str(y.title, 200);
          if (!id && !title) return null;
          return {
            id,
            title: title || id,
            time: optStr(y.time, 40),
            platform: optStr(y.platform, 40),
            status: optStr(y.status, 40),
          } as CalendarPost;
        })
        .filter((p): p is CalendarPost => p !== null);
      return { date, posts } as CalendarDay;
    })
    .filter((d): d is CalendarDay => d !== null);
  if (!days.length) return null;
  return { type: "calendar_week", days, href: safeUrl(o.href) ?? "/calendar" };
}

function vStoryboard(o: Record<string, unknown>): UIStoryboard | null {
  const itemId = str(o.itemId, 120);
  const scenes = arr(o.scenes)
    .slice(0, MAX_SCENES)
    .map((s) => {
      const x = (s ?? {}) as Record<string, unknown>;
      const id = str(x.id, 120);
      const caption = optStr(x.caption, 200);
      if (!id && !caption) return null;
      return {
        id,
        caption,
        thumb: safeUrl(x.thumb),
        durationSec: optNum(x.durationSec),
      } as StoryboardScene;
    })
    .filter((s): s is StoryboardScene => s !== null);
  if (!itemId || !scenes.length) return null;
  return {
    type: "storyboard",
    itemId,
    scenes,
    href: safeUrl(o.href) ?? `/post/${encodeURIComponent(itemId)}`,
  };
}

function vRenderProgress(o: Record<string, unknown>): UIRenderProgress | null {
  const itemId = str(o.itemId, 120);
  const stage = str(o.stage, 160);
  if (!itemId && !stage) return null;
  const st = str(o.status, 12);
  const status: RenderStatus = st === "done" || st === "failed" ? st : "running";
  const raw = optNum(o.pct);
  const pct = raw == null ? undefined : Math.max(0, Math.min(100, Math.round(raw)));
  const log = arr(o.log)
    .slice(-MAX_LOG_LINES)
    .map((l) => str(l, 200))
    .filter(Boolean);
  return {
    type: "render_progress",
    itemId,
    stage: stage || status,
    pct,
    log: log.length ? log : undefined,
    status,
    href: safeUrl(o.href) ?? (itemId ? `/post/${encodeURIComponent(itemId)}` : undefined),
  };
}

function vInsightsChart(o: Record<string, unknown>): UIInsightsChart | null {
  const series = arr(o.series)
    .slice(0, MAX_SERIES)
    .map((s) => {
      const x = (s ?? {}) as Record<string, unknown>;
      const label = str(x.label, 120);
      const value = optNum(x.value);
      if (!label || value == null) return null;
      return { label, value, delta: optNum(x.delta) } as InsightPoint;
    })
    .filter((s): s is InsightPoint => s !== null);
  if (!series.length) return null;
  return {
    type: "insights_chart",
    title: optStr(o.title, 200),
    series,
    unit: optStr(o.unit, 40),
    href: safeUrl(o.href) ?? "/analytics",
  };
}

function vBoostPreview(o: Record<string, unknown>): UIBoostPreview | null {
  const adId = str(o.adId, 120);
  if (!adId) return null;
  const gateReasons = arr(o.gateReasons)
    .slice(0, MAX_GATE_REASONS)
    .map((r) => str(r, 300))
    .filter(Boolean);
  const calls = arr(o.calls)
    .slice(0, MAX_CALLS)
    .map((c) => {
      const x = (c ?? {}) as Record<string, unknown>;
      const step = str(x.step, 120);
      const path = str(x.path, 200);
      if (!step && !path) return null;
      return { step, path } as BoostCall;
    })
    .filter((c): c is BoostCall => c !== null);
  return {
    type: "boost_preview",
    adId,
    status: str(o.status, 40) || "draft",
    dailyBudgetUsd: optNum(o.dailyBudgetUsd) ?? 0,
    durationDays: optNum(o.durationDays) ?? 0,
    gateReasons,
    calls: calls.length ? calls : undefined,
    href: safeUrl(o.href) ?? "/ads",
  };
}

function vGenome(o: Record<string, unknown>): UIGenome | null {
  const channel = str(o.channel, 80);
  const traits = arr(o.traits)
    .slice(0, MAX_TRAITS)
    .map((t) => {
      const x = (t ?? {}) as Record<string, unknown>;
      const kind = str(x.kind, 40);
      const text = str(x.text, 200);
      if (!text) return null;
      return { kind: kind || "trait", text, weight: optNum(x.weight) } as GenomeTrait;
    })
    .filter((t): t is GenomeTrait => t !== null);
  if (!channel || !traits.length) return null;
  return { type: "genome", channel, traits, href: safeUrl(o.href) ?? "/channels" };
}

function vInboxSummary(o: Record<string, unknown>): UIInboxSummary | null {
  const c = (o.counts ?? {}) as Record<string, unknown>;
  const comments = optNum(c.comments);
  const dms = optNum(c.dms);
  const flagged = optNum(c.flagged);
  const counts: InboxCounts | undefined =
    comments != null || dms != null || flagged != null ? { comments, dms, flagged } : undefined;
  const threads = arr(o.threads)
    .slice(0, MAX_THREADS)
    .map((t) => {
      const x = (t ?? {}) as Record<string, unknown>;
      const id = str(x.id, 120);
      const from = str(x.from, 120);
      const preview = str(x.preview, 200);
      if (!from && !preview) return null;
      return { id, from: from || "—", preview, kind: optStr(x.kind, 40) } as InboxThread;
    })
    .filter((t): t is InboxThread => t !== null);
  if (!counts && !threads.length) return null;
  return { type: "inbox_summary", counts, threads, href: safeUrl(o.href) ?? "/inbox" };
}

function vCalendarMonth(o: Record<string, unknown>): UICalendarMonth | null {
  const month = str(o.month, 10).slice(0, 7);
  if (!/^\d{4}-\d{2}$/.test(month)) return null;
  const events = arr(o.events)
    .slice(0, MAX_MONTH_EVENTS)
    .map((e) => {
      const x = (e ?? {}) as Record<string, unknown>;
      const date = str(x.date, 40);
      const title = str(x.title, 160);
      if (!date || !title) return null;
      const k = str(x.kind, 12);
      const kind: MonthEventKind | undefined =
        k === "post" || k === "event" || k === "reminder" ? k : undefined;
      return { date, title, id: optStr(x.id, 120), kind, status: optStr(x.status, 40) } as MonthEvent;
    })
    .filter((e): e is MonthEvent => e !== null);
  return { type: "calendar_month", month, events, href: safeUrl(o.href) ?? "/calendar" };
}

function vPostCard(o: Record<string, unknown>): UIPostCard | null {
  const itemId = str(o.itemId, 120);
  if (!itemId) return null;
  const title = str(o.title, 300) || itemId;
  const publishedTo = arr(o.publishedTo)
    .slice(0, MAX_PUBLISHED_TO)
    .map((p) => str(p, 40))
    .filter(Boolean);
  const m = (o.metrics ?? {}) as Record<string, unknown>;
  const views = optNum(m.views);
  const likes = optNum(m.likes);
  const comments = optNum(m.comments);
  const metrics: PostMetrics | undefined =
    views != null || likes != null || comments != null ? { views, likes, comments } : undefined;
  return {
    type: "post_card",
    itemId,
    title,
    status: str(o.status, 40) || "draft",
    thumb: safeUrl(o.thumb),
    durationSec: optNum(o.durationSec),
    mood: optStr(o.mood, 80),
    channel: optStr(o.channel, 80),
    publishedTo: publishedTo.length ? publishedTo : undefined,
    metrics,
    href: safeUrl(o.href) ?? `/post/${encodeURIComponent(itemId)}`,
  };
}

function vScorecard(o: Record<string, unknown>): UIScorecard | null {
  const rows = arr(o.rows)
    .slice(0, MAX_SCORE_ROWS)
    .map((r) => {
      const x = (r ?? {}) as Record<string, unknown>;
      const label = str(x.label, 160);
      if (!label) return null;
      const v = str(x.verdict, 12);
      const verdict: ScoreVerdict = v === "strong" || v === "weak" ? v : "variable";
      return { label, verdict, note: optStr(x.note, 300) } as ScoreRow;
    })
    .filter((r): r is ScoreRow => r !== null);
  if (!rows.length) return null;
  return { type: "scorecard", title: optStr(o.title, 200), rows, href: safeUrl(o.href) };
}

function vTimeline(o: Record<string, unknown>): UITimeline | null {
  const events = arr(o.events)
    .slice(0, MAX_TIMELINE_EVENTS)
    .map((e) => {
      const x = (e ?? {}) as Record<string, unknown>;
      const at = str(x.at, 60);
      const title = str(x.title, 200);
      if (!title) return null;
      return { at, title, detail: optStr(x.detail, 300), kind: optStr(x.kind, 40) } as TimelineEvent;
    })
    .filter((e): e is TimelineEvent => e !== null);
  if (!events.length) return null;
  return { type: "timeline", events, href: safeUrl(o.href) };
}

function vAnnotate(o: Record<string, unknown>): UIAnnotate | null {
  const text = str(o.text, MAX_ANNOTATE_TEXT);
  if (!text) return null;
  const emphasis = arr(o.emphasis)
    .slice(0, MAX_ANNOTATE_EMPHASIS)
    .map((e) => {
      const x = (e ?? {}) as Record<string, unknown>;
      const phrase = str(x.phrase, 120);
      if (!phrase) return null;
      const s = str(x.style, 12);
      const style: AnnotateStyle = s === "underline" ? "underline" : "circle";
      return { phrase, style } as AnnotateEmphasis;
    })
    .filter((e): e is AnnotateEmphasis => e !== null);
  return { type: "annotate", text, emphasis, note: optStr(o.note, 200) };
}

function vBoard(o: Record<string, unknown>): UIBoard | null {
  // Depth 1 only: children are validated with the same per-block validators,
  // but a nested `board` (or unknown type) is silently dropped.
  const blocks: UIBlock[] = [];
  for (const item of arr(o.blocks).slice(0, MAX_BOARD_CHILDREN)) {
    if (!item || typeof item !== "object") continue;
    const c = item as Record<string, unknown>;
    const type = typeof c.type === "string" ? c.type : "";
    if (type === "board" || !KNOWN_TYPES.has(type)) continue;
    const block = VALIDATORS[type](c);
    if (block) blocks.push(block);
  }
  if (!blocks.length) return null;
  const columns: 2 | 3 = optNum(o.columns) === 3 ? 3 : 2;
  return { type: "board", title: optStr(o.title, 200), columns, blocks };
}

/* ---------- widget-block validators (v3) ---------- */

function num01(v: unknown): number | undefined {
  const n = optNum(v);
  if (n == null) return undefined;
  return Math.max(0, Math.min(1, n));
}

/* Models routinely send intensities on the wrong scale (87 instead of 0.87).
   Hard-clamping those to 1 renders everything maxed out, which reads broken.
   Normalize the whole series at once: values already 0..1 pass through; a
   0..100 series is read as percentages; anything larger scales by its max. */
function normalizeSeries(values: (number | undefined)[]): (number | undefined)[] {
  const present = values.filter((v): v is number => v != null && Number.isFinite(v) && v >= 0);
  if (!present.length) return values.map(() => undefined);
  const max = Math.max(...present);
  const div = max <= 1 ? 1 : max <= 100 ? 100 : max;
  return values.map((v) =>
    v == null || !Number.isFinite(v) ? undefined : Math.max(0, Math.min(1, v / div)),
  );
}

function vSparkline(o: Record<string, unknown>): UISparkline | null {
  const points = arr(o.points)
    .slice(0, MAX_SPARK_POINTS)
    .map((p) => optNum(p))
    .filter((p): p is number => p != null);
  if (points.length < 2) return null;
  return {
    type: "sparkline",
    title: optStr(o.title, 160),
    points,
    unit: optStr(o.unit, 40),
    startLabel: optStr(o.startLabel, 40),
    endLabel: optStr(o.endLabel, 40),
    href: safeUrl(o.href),
  };
}

function vDonut(o: Record<string, unknown>): UIDonut | null {
  const slices = arr(o.slices)
    .slice(0, MAX_DONUT_SLICES)
    .map((s) => {
      const x = (s ?? {}) as Record<string, unknown>;
      const label = str(x.label, 120);
      const value = optNum(x.value);
      if (!label || value == null || value < 0) return null;
      return { label, value } as DonutSlice;
    })
    .filter((s): s is DonutSlice => s !== null);
  if (!slices.length || !slices.some((s) => s.value > 0)) return null;
  return { type: "donut", title: optStr(o.title, 160), slices, unit: optStr(o.unit, 40), href: safeUrl(o.href) };
}

function vGauge(o: Record<string, unknown>): UIGauge | null {
  const label = str(o.label, 160) || str(o.title, 160);
  const raw = optNum(o.value);
  if (!label || raw == null) return null;
  let value = raw;
  let t = optNum(o.target);
  // fraction scale (0.68 meaning 68%): promote both value and target together
  if (value >= 0 && value <= 1 && (t == null || (t >= 0 && t <= 1))) {
    value *= 100;
    if (t != null) t *= 100;
  }
  value = Math.max(0, Math.min(100, value));
  const target = t == null ? undefined : Math.max(0, Math.min(100, t));
  return { type: "gauge", label, value, target, unit: optStr(o.unit, 40), href: safeUrl(o.href) };
}

function vHeatmap(o: Record<string, unknown>): UIHeatmap | null {
  const xLabels = arr(o.xLabels).slice(0, MAX_HEATMAP_X).map((l) => str(l, 24));
  const yLabels = arr(o.yLabels).slice(0, MAX_HEATMAP_Y).map((l) => str(l, 24));
  if (!xLabels.length || !yLabels.length) return null;
  // The grid is normalized as ONE series (0..1 / percent / max-scaled) so a
  // wrong-scale payload still reads as a gradient; short rows pad with 0 so
  // the grid is always rectangular.
  const flat = normalizeSeries(
    yLabels.flatMap((_, yi) => {
      const row = arr(arr(o.cells)[yi]);
      return xLabels.map((_x, xi) => optNum(row[xi]));
    }),
  );
  const cells = yLabels.map((_, yi) =>
    xLabels.map((_x, xi) => flat[yi * xLabels.length + xi] ?? 0),
  );
  return { type: "heatmap", title: optStr(o.title, 160), xLabels, yLabels, cells, href: safeUrl(o.href) };
}

function vFunnel(o: Record<string, unknown>): UIFunnel | null {
  const stages = arr(o.stages)
    .slice(0, MAX_FUNNEL_STAGES)
    .map((s) => {
      const x = (s ?? {}) as Record<string, unknown>;
      const label = str(x.label, 120);
      const value = optNum(x.value);
      if (!label || value == null || value < 0) return null;
      return { label, value } as FunnelStage;
    })
    .filter((s): s is FunnelStage => s !== null);
  if (stages.length < 2) return null;
  return { type: "funnel", title: optStr(o.title, 160), stages, unit: optStr(o.unit, 40), href: safeUrl(o.href) };
}

function vMetric(o: Record<string, unknown>): UIMetric | null {
  const label = str(o.label, 160) || str(o.title, 160);
  const value = optNum(o.value);
  if (!label || value == null) return null;
  return { type: "metric", label, value, unit: optStr(o.unit, 40), delta: optNum(o.delta), href: safeUrl(o.href) };
}

function vVerdict(o: Record<string, unknown>): UIVerdict | null {
  const title = str(o.title, 200);
  if (!title) return null;
  const v = str(o.verdict, 8).toLowerCase();
  const verdict: VerdictKind = v === "go" || v === "kill" ? v : "hold";
  return { type: "verdict", verdict, title, reason: optStr(o.reason, 300), href: safeUrl(o.href) };
}

function vChecklist(o: Record<string, unknown>): UIChecklist | null {
  const items = arr(o.items)
    .slice(0, MAX_CHECK_ITEMS)
    .map((it) => {
      const x = (it ?? {}) as Record<string, unknown>;
      const label = str(x.label, 200);
      if (!label) return null;
      return { label, done: x.done === true || x.done === "true" || x.state === "done" } as ChecklistItem;
    })
    .filter((x): x is ChecklistItem => x !== null);
  if (!items.length) return null;
  return { type: "checklist", title: optStr(o.title, 200), items, href: safeUrl(o.href) };
}

function vQuote(o: Record<string, unknown>): UIQuote | null {
  const text = str(o.text, MAX_QUOTE_TEXT);
  if (!text) return null;
  return { type: "quote", text, by: optStr(o.by, 120), href: safeUrl(o.href) };
}

function vBadgeRow(o: Record<string, unknown>): UIBadgeRow | null {
  const badges = arr(o.badges)
    .slice(0, MAX_BADGES)
    .map((b) => {
      const x = (b ?? {}) as Record<string, unknown>;
      const label = str(x.label, 80);
      if (!label) return null;
      const k = str(x.kind, 12);
      const kind: BadgeKind | undefined =
        k === "accent" || k === "ok" || k === "warn" || k === "err" ? k : undefined;
      return { label, kind } as Badge;
    })
    .filter((b): b is Badge => b !== null);
  if (!badges.length) return null;
  return { type: "badge_row", title: optStr(o.title, 160), badges };
}

function vRating(o: Record<string, unknown>): UIRating | null {
  let raw = optNum(o.value);
  if (raw == null) return null;
  // scale rescue: 0..10 reads as a ten-scale, 0..100 as a percent score
  if (raw > 5 && raw <= 10) raw /= 2;
  else if (raw > 10 && raw <= 100) raw /= 20;
  // halves, 0..5
  const value = Math.max(0, Math.min(5, Math.round(raw * 2) / 2));
  return { type: "rating", label: optStr(o.label, 160), value, href: safeUrl(o.href) };
}

function vCountdown(o: Record<string, unknown>): UICountdown | null {
  const label = str(o.label, 200);
  const at = str(o.at, 40);
  if (!label || !at || Number.isNaN(new Date(at).getTime())) return null;
  return { type: "countdown", label, at, href: safeUrl(o.href) };
}

function vSlots(o: Record<string, unknown>): UISlots | null {
  const raw = arr(o.slots)
    .slice(0, MAX_SLOTS)
    .map((s) => {
      const x = (s ?? {}) as Record<string, unknown>;
      const day = str(x.day, 24);
      const time = str(x.time, 24);
      if (!day && !time) return null;
      return { day: day || "—", time: time || "—", score: optNum(x.score) };
    })
    .filter((s): s is { day: string; time: string; score: number | undefined } => s !== null);
  if (!raw.length) return null;
  // normalize all scores together so percent-scale payloads still rank
  const scores = normalizeSeries(raw.map((s) => s.score));
  const slots = raw.map((s, i) => ({ day: s.day, time: s.time, score: scores[i] }) as ScheduleSlotItem);
  return { type: "slots", title: optStr(o.title, 160), slots, href: safeUrl(o.href) };
}

function vMissionCard(o: Record<string, unknown>): UIMissionCard | null {
  const missionId = str(o.missionId, 120);
  const goal = str(o.goal, 400);
  if (!missionId || !goal) return null;
  const s = str(o.status, 12).toLowerCase();
  const status: MissionStatus = s === "paused" || s === "done" ? s : "active";
  return {
    type: "mission_card",
    missionId,
    goal,
    status,
    cadence: optStr(o.cadence, 120),
    nextRun: optStr(o.nextRun, 60),
    href: safeUrl(o.href) ?? "/missions",
  };
}

function vBudgetMeter(o: Record<string, unknown>): UIBudgetMeter | null {
  const spentUsd = optNum(o.spentUsd);
  const capUsd = optNum(o.capUsd);
  if (spentUsd == null || capUsd == null || capUsd <= 0 || spentUsd < 0) return null;
  return { type: "budget_meter", label: optStr(o.label, 160), spentUsd, capUsd, href: safeUrl(o.href) };
}

function vGate(o: Record<string, unknown>): UIGateBlock | null {
  const title = str(o.title, 200);
  if (!title) return null;
  return {
    type: "gate",
    title,
    kind: optStr(o.kind, 40),
    summary: optStr(o.summary, 400),
    href: safeUrl(o.href),
  };
}

function vDeviceCard(o: Record<string, unknown>): UIDeviceCard | null {
  const device = str(o.device, 80);
  if (!device) return null;
  const s = str(o.status, 12).toLowerCase();
  const status: DeviceStatus = s === "busy" || s === "offline" ? s : "online";
  return {
    type: "device_card",
    device,
    status,
    job: optStr(o.job, 200),
    hw: optStr(o.hw, 120),
    href: safeUrl(o.href) ?? "/devices",
  };
}

function vHookLab(o: Record<string, unknown>): UIHookLab | null {
  const hooks = arr(o.hooks)
    .slice(0, MAX_HOOKS)
    .map((h) => {
      const x = (h ?? {}) as Record<string, unknown>;
      const text = str(x.text, 240);
      if (!text) return null;
      const sc = optNum(x.score);
      return { text, score: sc == null ? undefined : Math.max(0, Math.min(100, sc)) } as HookVariant;
    })
    .filter((h): h is HookVariant => h !== null);
  if (!hooks.length) return null;
  return { type: "hook_lab", title: optStr(o.title, 160), hooks, href: safeUrl(o.href) };
}

function vScriptLines(o: Record<string, unknown>): UIScriptLines | null {
  const lines = arr(o.lines)
    .slice(0, MAX_SCRIPT_LINES)
    .map((l) => {
      const x = (l ?? {}) as Record<string, unknown>;
      const text = str(x.text, 300);
      if (!text) return null;
      return { at: optStr(x.at, 24), text } as ScriptLine;
    })
    .filter((l): l is ScriptLine => l !== null);
  if (!lines.length) return null;
  return { type: "script_lines", title: optStr(o.title, 160), lines, href: safeUrl(o.href) };
}

function vAbTest(o: Record<string, unknown>): UIAbTest | null {
  const mk = (v: unknown): AbCell | null => {
    const x = (v ?? {}) as Record<string, unknown>;
    const label = str(x.label, 160);
    const value = str(x.value, 80);
    if (!label && !value) return null;
    return { label: label || "—", value: value || "—" };
  };
  const a = mk(o.a);
  const b = mk(o.b);
  if (!a || !b) return null;
  const w = str(o.winner, 4).toLowerCase();
  const winner: "a" | "b" | undefined = w === "a" || w === "b" ? w : undefined;
  return { type: "ab_test", metric: optStr(o.metric, 160), a, b, winner, href: safeUrl(o.href) };
}

function vTrendTags(o: Record<string, unknown>): UITrendTags | null {
  const raw = arr(o.tags)
    .slice(0, MAX_TAGS)
    .map((t) => {
      const x = (t ?? {}) as Record<string, unknown>;
      const label = str(x.label, 60);
      if (!label) return null;
      return { label, heat: optNum(x.heat) };
    })
    .filter((t): t is { label: string; heat: number | undefined } => t !== null);
  if (!raw.length) return null;
  // normalize heats together (percent-scale payloads still tint as a gradient)
  const heats = normalizeSeries(raw.map((t) => t.heat));
  const tags = raw.map((t, i) => ({ label: t.label, heat: heats[i] }) as TrendTag);
  return { type: "trend_tags", title: optStr(o.title, 160), tags, href: safeUrl(o.href) };
}

function vVoiceTrack(o: Record<string, unknown>): UIVoiceTrack | null {
  const bars = normalizeSeries(arr(o.bars).slice(0, MAX_WAVE_BARS).map((b) => optNum(b)))
    .filter((b): b is number => b != null);
  const title = optStr(o.title, 200);
  const durationSec = optNum(o.durationSec);
  if (!title && !bars.length && durationSec == null) return null;
  return { type: "voice_track", title, durationSec, bars: bars.length ? bars : undefined, href: safeUrl(o.href) };
}

function vPalette(o: Record<string, unknown>): UIPalette | null {
  const colors = arr(o.colors)
    .slice(0, MAX_PALETTE_COLORS)
    .map((c) => {
      const x = (c ?? {}) as Record<string, unknown>;
      const hex = str(x.hex, 9).trim();
      // strict hex only — this value lands in an inline style.
      if (!/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(hex)) return null;
      return { hex, name: optStr(x.name, 60) } as PaletteColor;
    })
    .filter((c): c is PaletteColor => c !== null);
  if (!colors.length) return null;
  return { type: "palette", title: optStr(o.title, 160), colors, href: safeUrl(o.href) };
}

function vPipeline(o: Record<string, unknown>): UIPipeline | null {
  const stages = arr(o.stages)
    .slice(0, MAX_PIPELINE_STAGES)
    .map((s) => {
      const x = (s ?? {}) as Record<string, unknown>;
      const label = str(x.label, 60);
      if (!label) return null;
      const st = str(x.state, 12);
      const state: StepState = st === "done" || st === "active" || st === "error" ? st : "pending";
      return { label, state } as PipelineStage;
    })
    .filter((s): s is PipelineStage => s !== null);
  if (stages.length < 2) return null;
  return { type: "pipeline", stages, href: safeUrl(o.href) };
}

function vDiff(o: Record<string, unknown>): UIDiff | null {
  const before = str(o.before, 300);
  const after = str(o.after, 300);
  if (!before || !after) return null;
  return { type: "diff", title: optStr(o.title, 160), before, after, href: safeUrl(o.href) };
}

const VALIDATORS: Record<string, (o: Record<string, unknown>) => UIBlock | null> = {
  card: vCard,
  stat_grid: vStatGrid,
  table: vTable,
  video: vVideo,
  concept: vConcept,
  image: vImage,
  callout: vCallout,
  markdown: vMarkdown,
  json_tree: vJsonTree,
  progress: vProgress,
  steps: vSteps,
  key_value: vKeyValue,
  actions: vActions,
  form: vForm,
  sketch: vSketch,
  html: vHtml,
  calendar_week: vCalendarWeek,
  storyboard: vStoryboard,
  render_progress: vRenderProgress,
  insights_chart: vInsightsChart,
  boost_preview: vBoostPreview,
  genome: vGenome,
  inbox_summary: vInboxSummary,
  calendar_month: vCalendarMonth,
  post_card: vPostCard,
  scorecard: vScorecard,
  timeline: vTimeline,
  annotate: vAnnotate,
  board: vBoard,
  sparkline: vSparkline,
  donut: vDonut,
  gauge: vGauge,
  heatmap: vHeatmap,
  funnel: vFunnel,
  metric: vMetric,
  verdict: vVerdict,
  checklist: vChecklist,
  quote: vQuote,
  badge_row: vBadgeRow,
  rating: vRating,
  countdown: vCountdown,
  slots: vSlots,
  mission_card: vMissionCard,
  budget_meter: vBudgetMeter,
  gate: vGate,
  device_card: vDeviceCard,
  hook_lab: vHookLab,
  script_lines: vScriptLines,
  ab_test: vAbTest,
  trend_tags: vTrendTags,
  voice_track: vVoiceTrack,
  palette: vPalette,
  pipeline: vPipeline,
  diff: vDiff,
};

/* Validate + sanitize an arbitrary blocks payload into a safe UIBlock[].
   Drops unknown block types, coerces fields, caps counts/sizes. Never throws. */
export function validateBlocks(input: unknown): UIBlock[] {
  const raw = arr(input).slice(0, MAX_BLOCKS);
  const out: UIBlock[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const type = typeof o.type === "string" ? o.type : "";
    if (!KNOWN_TYPES.has(type)) continue;
    const block = VALIDATORS[type](o);
    if (block) out.push(block);
  }
  return out;
}

/* ---------- tool definition + handler ---------- */

export const UI_TOOLS: OpenAITool[] = [
  {
    type: "function",
    function: {
      name: "ui_render",
      description:
        "Render rich INLINE UI in the chat. Call this to PRESENT results visually and to OFFER next actions interactively. Use `card` for a concept/video/object summary, `concept`/`video` for pipeline items (link to their pages), `stat_grid` for metrics, `table` for lists/comparisons, `progress` for a real progress BAR (value 0-100 — always use this for render/upload/job progress instead of ASCII bars or text percentages), `steps` for a stepper/checklist of pipeline stages (each item state: done/active/pending/error), `key_value` for a compact labelled detail list (ids, sizes, timings), `image` for previews, `callout` for status (info/warn/ok/err), `markdown` for formatted prose, `json_tree` for an explorable collapsible TREE of structured data when no specific widget fits ({data: any JSON value, label?} — use it as the LAST resort to present nested/raw API or tool data instead of dumping JSON in a code block), `actions` for clickable next-step buttons (each button sends its `send` text back as the user's next message), `form` to collect input (submitting sends a compact summary back), and `sketch` for a hand-drawn explanatory SVG line drawing (svg markup + optional caption; rendered through a strict sanitizer), and `html` for a CUSTOM HTML/CSS/SVG visualization rendered in a LOCKED sandbox — use it ONLY when no other block type fits ({html: the markup, caption?, height? 120-600}; inline styles + inline SVG only, NO <script>/JS/event handlers (they will not run — the sandbox renders all script content inert), NO external resources; the house ink tokens (--bone/--accent/--font-sans/--font-mono, transparent bg) are pre-injected so your markup inherits the look; max 20000 chars; STATIC — it cannot resize itself, so keep it within the height). DOMAIN blocks render one capability each as an inline mini-view that deep-links to its full page via `href`: `calendar_week` (7-column week strip of scheduled posts — {days:[{date, posts:[{id,title,time?,platform?,status?}]}], href:'/calendar'}), `storyboard` (horizontal scene frames of one item — {itemId, scenes:[{id,caption?,thumb?,durationSec?}], href:'/post/<itemId>'}; max 12 scenes; thumb may be /api/scenethumb/<itemId>/<index>), `render_progress` (static render snapshot — {itemId, stage, pct?, log?:string[], status:running|done|failed}; does NOT poll — re-render for fresh numbers, or use `progress` with jobId/itemId for a live bar), `insights_chart` (compact horizontal bar chart — {title?, series:[{label,value,delta?}] max 12, unit?, href:'/analytics'}; delta is an optional signed % change vs the previous period, rendered as a tinted ▲/▼), `boost_preview` (ads dry-run preview — {adId, status, dailyBudgetUsd, durationDays, gateReasons:string[], calls?:[{step,path}], href:'/ads'}; intentionally has NO launch button — launch only via the explicit confirmed flow), `genome` (Brand Genome traits grouped by kind — {channel, traits:[{kind,text,weight?}], href:'/channels'}), `inbox_summary` (community triage — {counts:{comments?,dms?,flagged?}, threads:[{id,from,preview,kind?}] max 5, href:'/inbox'}), `calendar_month` (full month grid, weeks × 7, today highlighted — {month:'YYYY-MM', events:[{date:'YYYY-MM-DD', title, id?, kind? (post|event|reminder), status?}] max 62, href:'/calendar'}; use for any monthly schedule/plan view), `post_card` (rich preview of ONE content item: 9:16 poster, status pill, mono metrics — {itemId, title, status, thumb? (falls back to /api/thumb/<itemId>), durationSec?, mood?, channel?, publishedTo?:string[], metrics?:{views?,likes?,comments?}, href:'/post/<itemId>'}; ALWAYS end a discussion of a specific post/item with its post_card), `scorecard` (analysis verdicts — {title?, rows:[{label, verdict: strong|variable|weak, note?}] max 8, href?}; use for strengths/risks/quality assessments instead of a markdown table), and `timeline` (vertical ink timeline — {events:[{at (ISO or label), title, detail?, kind?}] max 10, href?}; use for histories, mission progress, and dated plans). COMPOSITION blocks: `annotate` (hand-annotated statement — {text (max 400 chars), emphasis:[{phrase, style: circle|underline}] max 3, note?}; each phrase is matched inside text and gets a wobbled ink circle/underline drawn around/under it, with an optional small mono margin note below — use it to emphasize ONE key number or phrase instead of bold) and `board` (composite dashboard grid — {title?, columns: 2|3, blocks:[…]} nesting up to 6 OTHER blocks (never another board) side by side; use it to compose a multi-faceted report, e.g. a weekly review = calendar_week + insights_chart + inbox_summary). WIDGET blocks (small, single-purpose, ink-animated; all take href?): charts — `sparkline` ({points:number[] 2-60, startLabel?, endLabel?, unit?} drawn trend line, last value big), `donut` ({slices:[{label,value}] max 6, unit?} share-of-whole ring), `gauge` ({label, value 0-100, target?, unit?} dial with needle), `heatmap` ({xLabels max 12, yLabels max 7, cells:number[][] 0..1} intensity grid — best posting times), `funnel` ({stages:[{label,value}] 2-6, unit?} drop-off with conversion %); stats — `metric` ({label, value:number, unit?, delta?} ONE hero number counting up), `verdict` ({verdict:go|hold|kill, title, reason?} stamped ink call), `checklist` ({items:[{label,done}] max 10} drawn checkmarks), `quote` ({text max 280, by?} pull-quote), `badge_row` ({badges:[{label,kind? default|accent|ok|warn|err}] max 10} ink chips), `rating` ({label?, value 0-5} ink stars); ops — `countdown` ({label, at:ISO} LIVE ticking timer to the next slot), `slots` ({slots:[{day,time,score?0..1}] max 8} best posting times, best gets ringed), `mission_card` ({missionId, goal, status:active|paused|done, cadence?, nextRun?}), `budget_meter` ({label?, spentUsd, capUsd} spend vs cap, warns near cap), `gate` ({title, kind?, summary?, href} something awaiting HUMAN approval — render it whenever work stops at an approval gate; it has NO approve button by design), `device_card` ({device, status:online|busy|offline, job?, hw?} one fleet device); content — `hook_lab` ({hooks:[{text,score?0-100}] max 6} ranked hook variants, winner circled), `script_lines` ({lines:[{at?,text}] max 12} script excerpt on an ink rail), `ab_test` ({metric?, a:{label,value}, b:{label,value}, winner?:a|b} side-by-side with winner ring), `trend_tags` ({tags:[{label,heat?0..1}] max 12} trending topic chips), `voice_track` ({title?, durationSec?, bars?:number[] 0..1 max 48} voiceover waveform), `palette` ({colors:[{hex:'#rrggbb',name?}] max 8} brand swatches), `pipeline` ({stages:[{label,state:done|active|pending|error}] 2-7} horizontal idea→publish flow), `diff` ({title?, before, after} copy change: strikethrough → underline). The UI is purely declarative and safe — NO HTML. Prefer ui_render over plain text when showing structured results or offering choices; when a block type exists for the data, a markdown table is FORBIDDEN.",
      parameters: {
        type: "object",
        properties: {
          blocks: {
            type: "array",
            description:
              "Ordered UI blocks to render. Each block is one of the safe declarative types.",
            items: {
              type: "object",
              properties: {
                type: {
                  type: "string",
                  enum: [
                    "card",
                    "stat_grid",
                    "table",
                    "video",
                    "concept",
                    "image",
                    "callout",
                    "markdown",
                    "json_tree",
                    "progress",
                    "steps",
                    "key_value",
                    "actions",
                    "form",
                    "sketch",
                    "html",
                    "calendar_week",
                    "storyboard",
                    "render_progress",
                    "insights_chart",
                    "boost_preview",
                    "genome",
                    "inbox_summary",
                    "calendar_month",
                    "post_card",
                    "scorecard",
                    "timeline",
                    "annotate",
                    "board",
                    "sparkline",
                    "donut",
                    "gauge",
                    "heatmap",
                    "funnel",
                    "metric",
                    "verdict",
                    "checklist",
                    "quote",
                    "badge_row",
                    "rating",
                    "countdown",
                    "slots",
                    "mission_card",
                    "budget_meter",
                    "gate",
                    "device_card",
                    "hook_lab",
                    "script_lines",
                    "ab_test",
                    "trend_tags",
                    "voice_track",
                    "palette",
                    "pipeline",
                    "diff",
                  ],
                  description: "The block kind.",
                },
                // card
                title: { type: "string" },
                subtitle: { type: "string" },
                fields: {
                  type: "array",
                  description: "card: label/value pairs.",
                  items: {
                    type: "object",
                    properties: { label: { type: "string" }, value: { type: "string" } },
                  },
                },
                thumbUrl: { type: "string", description: "card/video: thumbnail image url." },
                href: {
                  type: "string",
                  description:
                    "card + every domain block: deep-link to the full page (e.g. /calendar, /post/<id>, /ads, /analytics, /channels, /inbox) rendered as a quiet 'open →' corner link.",
                },
                // stat_grid
                stats: {
                  type: "array",
                  description: "stat_grid: metrics.",
                  items: {
                    type: "object",
                    properties: {
                      label: { type: "string" },
                      value: { type: "string" },
                      unit: { type: "string" },
                    },
                  },
                },
                // table / scorecard / board
                columns: {
                  anyOf: [
                    { type: "array", items: { type: "string" } },
                    { type: "number", enum: [2, 3] },
                  ],
                  description: "table: header cells (string[]). board: grid column count (2 or 3).",
                },
                rows: {
                  type: "array",
                  description:
                    "table: rows of string cells (string[][]). scorecard: verdict rows, each {label, verdict: strong|variable|weak, note?} (max 8).",
                  items: {
                    anyOf: [
                      { type: "array", items: { type: "string" } },
                      {
                        type: "object",
                        properties: {
                          label: { type: "string" },
                          verdict: { type: "string", enum: ["strong", "variable", "weak"] },
                          note: { type: "string" },
                        },
                        required: ["label", "verdict"],
                      },
                    ],
                  },
                },
                // video / concept
                id: { type: "string", description: "video/concept: item id (used to link to /post/<id>)." },
                status: { type: "string", description: "video/concept/post_card: status label. render_progress: running|done|failed. boost_preview: draft|approved|launched|paused." },
                score: { type: "number", description: "concept: numeric score." },
                // image
                url: { type: "string", description: "image: image url." },
                caption: { type: "string", description: "image/sketch: caption." },
                // sketch
                svg: {
                  type: "string",
                  description:
                    "sketch: the full <svg …>…</svg> markup of a hand-drawn line sketch (max 20000 chars; allowed elements: svg,g,path,circle,ellipse,line,polyline,rect,text,use,defs,clipPath — everything else is stripped).",
                },
                // html
                html: {
                  type: "string",
                  description:
                    "html: a custom HTML/CSS/SVG visualization (max 20000 chars) rendered inside a LOCKED sandboxed iframe — use ONLY when no other block fits. Inline styles + inline SVG only; NO <script>/JS/event handlers (inert — they never run) and NO external resources. House ink tokens (--bone/--accent/--font-sans/--font-mono, transparent bg) are pre-injected. Static (cannot self-resize).",
                },
                height: {
                  type: "number",
                  description: "html: fixed render height in px (clamped 120-600, default 420); content scrolls internally.",
                },
                // json_tree
                data: {
                  description:
                    "json_tree: ANY JSON-serializable value (object/array/primitive) to render as an explorable collapsible tree. Non-serializable or empty data is dropped; serialized size is capped at 40000 chars.",
                },
                // callout
                tone: { type: "string", enum: ["info", "warn", "ok", "err"], description: "callout/progress tone." },
                text: { type: "string", description: "callout/markdown text. annotate: the statement (max 400 chars) containing the phrases to emphasize." },
                // progress (also reuses `caption` above for the sub-bar text, `tone` above)
                label: { type: "string", description: "progress: label shown above the bar." },
                value: { type: "number", description: "progress: percent 0-100 (the initial value)." },
                jobId: { type: "string", description: "progress: a fleet job id (job_…) to make the bar LIVE — it then polls and updates itself until the render finishes." },
                itemId: { type: "string", description: "progress: an item/post id to make the bar LIVE by tracking that item's render job. storyboard/render_progress/post_card: the item/post id (used for the /post/<id> deep link and the /api/thumb/<id> poster fallback)." },
                // steps / key_value
                items: {
                  type: "array",
                  description: "steps: {label, state: done|active|pending|error, detail?}. key_value: {key, value}.",
                  items: {
                    type: "object",
                    properties: {
                      label: { type: "string" },
                      state: { type: "string", enum: ["done", "active", "pending", "error"] },
                      detail: { type: "string" },
                      key: { type: "string" },
                      value: { type: "string" },
                    },
                  },
                },
                // actions
                buttons: {
                  type: "array",
                  description: "actions: clickable buttons; clicking sends `send` as the next user message.",
                  items: {
                    type: "object",
                    properties: { label: { type: "string" }, send: { type: "string" } },
                    required: ["label", "send"],
                  },
                },
                // form
                submitLabel: { type: "string", description: "form: submit button label." },
                sendTemplate: {
                  type: "string",
                  description:
                    "form: optional template for the message sent on submit; use {fieldName} placeholders.",
                },
                // calendar_week
                days: {
                  type: "array",
                  description:
                    "calendar_week: up to 7 days, each {date: 'YYYY-MM-DD', posts: [{id, title, time?, platform?, status?}]}. Post chips link to /post/<id>.",
                  items: {
                    type: "object",
                    properties: {
                      date: { type: "string" },
                      posts: {
                        type: "array",
                        items: {
                          type: "object",
                          properties: {
                            id: { type: "string" },
                            title: { type: "string" },
                            time: { type: "string" },
                            platform: { type: "string" },
                            status: { type: "string" },
                          },
                        },
                      },
                    },
                    required: ["date"],
                  },
                },
                // storyboard
                scenes: {
                  type: "array",
                  description:
                    "storyboard: up to 12 scenes, each {id, caption?, thumb? (image url, e.g. /api/scenethumb/<itemId>/<index>), durationSec?}.",
                  items: {
                    type: "object",
                    properties: {
                      id: { type: "string" },
                      caption: { type: "string" },
                      thumb: { type: "string" },
                      durationSec: { type: "number" },
                    },
                  },
                },
                // render_progress (status enum shared with video/concept status string is fine)
                stage: { type: "string", description: "render_progress: current stage label (e.g. 'render · chapter 3/7')." },
                pct: { type: "number", description: "render_progress: percent 0-100 (static snapshot — re-render for fresh numbers)." },
                log: {
                  type: "array",
                  items: { type: "string" },
                  description: "render_progress: last few log lines (max 8).",
                },
                // insights_chart
                series: {
                  type: "array",
                  description:
                    "insights_chart: up to 12 bars, each {label, value, delta?}. delta is an optional signed % change vs the previous period (e.g. 12.5 or -8) rendered as a tinted ▲/▼.",
                  items: {
                    type: "object",
                    properties: {
                      label: { type: "string" },
                      value: { type: "number" },
                      delta: { type: "number" },
                    },
                    required: ["label", "value"],
                  },
                },
                unit: { type: "string", description: "insights_chart: unit suffix for values (e.g. 'views')." },
                // boost_preview
                adId: { type: "string", description: "boost_preview: the boost/ad id." },
                dailyBudgetUsd: { type: "number", description: "boost_preview: daily budget in USD." },
                durationDays: { type: "number", description: "boost_preview: run length in days." },
                gateReasons: {
                  type: "array",
                  items: { type: "string" },
                  description: "boost_preview: why the launch is blocked (max 10; empty = no blockers).",
                },
                calls: {
                  type: "array",
                  description: "boost_preview: the API calls a live launch would make, each {step, path} (max 6).",
                  items: {
                    type: "object",
                    properties: { step: { type: "string" }, path: { type: "string" } },
                  },
                },
                // genome / post_card
                channel: { type: "string", description: "genome: the channel id. post_card: the item's channel." },
                traits: {
                  type: "array",
                  description: "genome: DNA traits, each {kind (hook/topic/format/voice/visual…), text, weight?} (max 24).",
                  items: {
                    type: "object",
                    properties: {
                      kind: { type: "string" },
                      text: { type: "string" },
                      weight: { type: "number" },
                    },
                    required: ["text"],
                  },
                },
                // inbox_summary
                counts: {
                  type: "object",
                  description: "inbox_summary: triage counts.",
                  properties: {
                    comments: { type: "number" },
                    dms: { type: "number" },
                    flagged: { type: "number" },
                  },
                },
                threads: {
                  type: "array",
                  description: "inbox_summary: up to 5 threads, each {id, from, preview, kind? (comment|dm|flag)}.",
                  items: {
                    type: "object",
                    properties: {
                      id: { type: "string" },
                      from: { type: "string" },
                      preview: { type: "string" },
                      kind: { type: "string" },
                    },
                  },
                },
                // calendar_month / timeline
                month: { type: "string", description: "calendar_month: the month to draw, 'YYYY-MM'." },
                events: {
                  type: "array",
                  description:
                    "calendar_month: up to 62 events, each {date:'YYYY-MM-DD', title, id? (post id → /post/<id> link), kind? (post|event|reminder), status?}. timeline: up to 10 events, each {at (ISO date or short label), title, detail?, kind?}.",
                  items: {
                    type: "object",
                    properties: {
                      date: { type: "string" },
                      title: { type: "string" },
                      id: { type: "string" },
                      kind: { type: "string" },
                      status: { type: "string" },
                      at: { type: "string" },
                      detail: { type: "string" },
                    },
                    required: ["title"],
                  },
                },
                // post_card
                thumb: { type: "string", description: "post_card: poster/thumbnail url; omit to use /api/thumb/<itemId>." },
                durationSec: { type: "number", description: "post_card: video duration in seconds." },
                mood: { type: "string", description: "post_card: the item's mood preset (e.g. cinematic)." },
                publishedTo: {
                  type: "array",
                  items: { type: "string" },
                  description: "post_card: platforms the item is published to (e.g. ['youtube','tiktok']) (max 6).",
                },
                metrics: {
                  type: "object",
                  description: "post_card: engagement metrics.",
                  properties: {
                    views: { type: "number" },
                    likes: { type: "number" },
                    comments: { type: "number" },
                  },
                },
                // annotate
                emphasis: {
                  type: "array",
                  description:
                    "annotate: up to 3 phrases to emphasize in ink, each {phrase (must appear verbatim in `text`, case-insensitive), style: circle|underline}. circle = a wobbled ink ring drawn around the phrase (best for ONE key number); underline = a hand underline drawn beneath it.",
                  items: {
                    type: "object",
                    properties: {
                      phrase: { type: "string" },
                      style: { type: "string", enum: ["circle", "underline"] },
                    },
                    required: ["phrase"],
                  },
                },
                note: { type: "string", description: "annotate: optional small mono margin note rendered below the statement (max 200 chars)." },
                // board (columns is shared with table above)
                blocks: {
                  type: "array",
                  description:
                    "board: 1-6 nested blocks laid out in the grid — each is any block type EXCEPT another board (depth 1 only; invalid children are silently dropped). title (shared property above) labels the board.",
                  items: { type: "object" },
                },
                // ---- widget blocks (v3) ----
                points: {
                  type: "array",
                  items: { type: "number" },
                  description: "sparkline: 2-60 ordered values; the line draws itself and the LAST value is shown big. Use startLabel/endLabel for the time range.",
                },
                startLabel: { type: "string", description: "sparkline: label under the first point (e.g. 'Jun 1')." },
                endLabel: { type: "string", description: "sparkline: label under the last point (e.g. 'today')." },
                slices: {
                  type: "array",
                  description: "donut: up to 6 {label, value} shares of a whole (views by platform, time by stage…).",
                  items: { type: "object", properties: { label: { type: "string" }, value: { type: "number" } }, required: ["label", "value"] },
                },
                target: { type: "number", description: "gauge: optional 0-100 target tick drawn on the dial." },
                xLabels: { type: "array", items: { type: "string" }, description: "heatmap: column labels (max 12; e.g. hours or weekdays)." },
                yLabels: { type: "array", items: { type: "string" }, description: "heatmap: row labels (max 7)." },
                cells: {
                  type: "array",
                  items: { type: "array", items: { type: "number" } },
                  description: "heatmap: rows×cols of intensities 0..1 (normalize before sending). Great for best-posting-times.",
                },
                stages: {
                  type: "array",
                  description: "funnel: 2-6 {label, value} shrinking stages (views→likes→follows). pipeline: 2-7 {label, state: done|active|pending|error} horizontal flow nodes (idea→script→render→publish).",
                  items: { type: "object", properties: { label: { type: "string" }, value: { type: "number" }, state: { type: "string", enum: ["done", "active", "pending", "error"] } }, required: ["label"] },
                },
                delta: { type: "number", description: "metric: signed % change vs previous period, drawn as a tinted ink arrow." },
                verdict: { type: "string", enum: ["go", "hold", "kill"], description: "verdict: the stamped call (go=green ring, hold=amber, kill=red)." },
                reason: { type: "string", description: "verdict: one-line justification next to the stamp." },
                by: { type: "string", description: "quote: attribution (— @handle)." },
                badges: {
                  type: "array",
                  description: "badge_row: up to 10 ink-outlined chips, each {label, kind? default|accent|ok|warn|err}.",
                  items: { type: "object", properties: { label: { type: "string" }, kind: { type: "string", enum: ["default", "accent", "ok", "warn", "err"] } }, required: ["label"] },
                },
                at: { type: "string", description: "countdown: ISO datetime it counts down to (live, ticks every second)." },
                slots: {
                  type: "array",
                  description: "slots: up to 8 posting slots {day, time, score? 0..1}; the best-scored slot gets the ink ring.",
                  items: { type: "object", properties: { day: { type: "string" }, time: { type: "string" }, score: { type: "number" } } },
                },
                missionId: { type: "string", description: "mission_card: the mission id." },
                goal: { type: "string", description: "mission_card: the mission's standing goal." },
                cadence: { type: "string", description: "mission_card: cadence summary (e.g. 'generate=daily, publish=mon/thu')." },
                nextRun: { type: "string", description: "mission_card: next tick (ISO or label)." },
                spentUsd: { type: "number", description: "budget_meter: spent so far in USD." },
                capUsd: { type: "number", description: "budget_meter: the hard cap in USD." },
                summary: { type: "string", description: "gate: what is waiting for human approval (NEVER auto-approve; the block only links to the page)." },
                device: { type: "string", description: "device_card: device name (e.g. 'm4')." },
                job: { type: "string", description: "device_card: current job/phase line." },
                hw: { type: "string", description: "device_card: hardware summary." },
                hooks: {
                  type: "array",
                  description: "hook_lab: up to 6 hook variants {text, score? 0-100}; the top-scored one gets circled.",
                  items: { type: "object", properties: { text: { type: "string" }, score: { type: "number" } }, required: ["text"] },
                },
                lines: {
                  type: "array",
                  description: "script_lines: up to 12 script lines {at? (timecode), text} on an ink rail.",
                  items: { type: "object", properties: { at: { type: "string" }, text: { type: "string" } }, required: ["text"] },
                },
                metric: { type: "string", description: "ab_test: what is being compared (e.g. 'avg view duration')." },
                a: { type: "object", description: "ab_test: variant A {label, value}.", properties: { label: { type: "string" }, value: { type: "string" } } },
                b: { type: "object", description: "ab_test: variant B {label, value}.", properties: { label: { type: "string" }, value: { type: "string" } } },
                winner: { type: "string", enum: ["a", "b"], description: "ab_test: which variant gets the winner's ink ring." },
                tags: {
                  type: "array",
                  description: "trend_tags: up to 12 topic chips {label, heat? 0..1}; heat tints the chip, the hottest sparks.",
                  items: { type: "object", properties: { label: { type: "string" }, heat: { type: "number" } }, required: ["label"] },
                },
                bars: { type: "array", items: { type: "number" }, description: "voice_track: up to 48 waveform amplitudes 0..1 (omit to synthesize a deterministic wave)." },
                colors: {
                  type: "array",
                  description: "palette: up to 8 brand colors {hex: '#rrggbb', name?}; the first swatch gets the accent ring.",
                  items: { type: "object", properties: { hex: { type: "string" }, name: { type: "string" } }, required: ["hex"] },
                },
                before: { type: "string", description: "diff: the old copy — gets a hand strikethrough." },
                after: { type: "string", description: "diff: the new copy — gets a hand underline." },
              },
              required: ["type"],
            },
          },
        },
        required: ["blocks"],
      },
    },
  },
];

export type UiToolResult = { ok: true; rendered: number; blocks: UIBlock[] };

/* Handler for the ui_render LOCAL tool. Validates/sanitizes the blocks and
   returns the cleaned spec so the graph can additionally emit a `ui` event. */
export function uiToolHandler(args: Record<string, unknown>): UiToolResult {
  const blocks = validateBlocks(args?.blocks);
  return { ok: true, rendered: blocks.length, blocks };
}

export function isUiTool(name: string): boolean {
  return name === "ui_render";
}
