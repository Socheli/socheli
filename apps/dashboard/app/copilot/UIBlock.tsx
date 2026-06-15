"use client";
import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { Markdown } from "./Markdown";
import { SafeSketch } from "../../components/sketch/SafeSketch";
import { SafeHtml } from "../../components/sketch/SafeHtml";
import { parseProgress } from "../../lib/progress";
import {
  CalendarWeekView,
  StoryboardView,
  RenderProgressView,
  InsightsChartView,
  BoostPreviewView,
  GenomeView,
  InboxSummaryView,
  CalendarMonthView,
  PostCardView,
  ScorecardView,
  TimelineView,
  AnnotateView,
  BoardView,
  JsonTreeView,
  SparklineView,
  DonutView,
  GaugeView,
  HeatmapView,
  FunnelView,
  MetricView,
  VerdictView,
  ChecklistView,
  QuoteView,
  BadgeRowView,
  RatingView,
  CountdownView,
  SlotsView,
  MissionCardView,
  BudgetMeterView,
  GateView,
  DeviceCardView,
  HookLabView,
  ScriptLinesView,
  AbTestView,
  TrendTagsView,
  VoiceTrackView,
  PaletteView,
  PipelineView,
  DiffView,
} from "./blocks";

type LiveJob = { id: string; status: string; itemId?: string; progress?: { line: string }[] };
import {
  Film,
  Lightbulb,
  Info,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  ExternalLink,
  Loader2,
  Circle,
} from "lucide-react";
import type {
  UIBlock,
  UICard,
  UIStatGrid,
  UITable,
  UIVideo,
  UIConcept,
  UIImage,
  UICallout,
  UIMarkdown,
  UIProgress,
  UISteps,
  UIKeyValue,
  UIActions,
  UIForm,
  UISketch,
  UIHtml,
  CalloutTone,
  StepState,
} from "../../lib/agent/ui-spec";

/* Pure, SAFE renderer for the copilot's generative UI blocks. Maps the
   declarative UIBlock[] spec to dark-themed React. No raw HTML — markdown is a
   tiny safe inline subset rendered as React nodes. Interactive blocks (actions
   buttons, form submit) call onAction(text) which the chat turns into the next
   user message, looping back into the conversation. */

type Props = { blocks: UIBlock[]; onAction?: (text: string) => void };

export function UIBlocks({ blocks, onAction }: Props) {
  if (!blocks || blocks.length === 0) return null;
  return (
    <div className="gu-blocks">
      {blocks.map((b, i) => (
        <BlockView key={i} block={b} onAction={onAction} />
      ))}
    </div>
  );
}

function BlockView({ block, onAction }: { block: UIBlock; onAction?: (text: string) => void }) {
  switch (block.type) {
    case "card":
      return <CardView b={block} />;
    case "stat_grid":
      return <StatGridView b={block} />;
    case "table":
      return <TableView b={block} />;
    case "video":
      return <VideoView b={block} />;
    case "concept":
      return <ConceptView b={block} />;
    case "image":
      return <ImageView b={block} />;
    case "callout":
      return <CalloutView b={block} />;
    case "markdown":
      return <MarkdownView b={block} />;
    case "progress":
      return <ProgressView b={block} />;
    case "steps":
      return <StepsView b={block} />;
    case "key_value":
      return <KeyValueView b={block} />;
    case "actions":
      return <ActionsView b={block} onAction={onAction} />;
    case "form":
      return <FormView b={block} onAction={onAction} />;
    case "sketch":
      return <SafeSketch svg={block.svg} caption={block.caption} />;
    case "html":
      return <SafeHtml html={block.html} caption={block.caption} height={block.height} />;
    case "calendar_week":
      return <CalendarWeekView b={block} />;
    case "storyboard":
      return <StoryboardView b={block} />;
    case "render_progress":
      return <RenderProgressView b={block} />;
    case "insights_chart":
      return <InsightsChartView b={block} />;
    case "boost_preview":
      return <BoostPreviewView b={block} />;
    case "genome":
      return <GenomeView b={block} />;
    case "inbox_summary":
      return <InboxSummaryView b={block} />;
    case "calendar_month":
      return <CalendarMonthView b={block} />;
    case "post_card":
      return <PostCardView b={block} />;
    case "scorecard":
      return <ScorecardView b={block} />;
    case "timeline":
      return <TimelineView b={block} />;
    case "annotate":
      return <AnnotateView b={block} />;
    case "json_tree":
      return <JsonTreeView b={block} />;
    case "sparkline":
      return <SparklineView b={block} />;
    case "donut":
      return <DonutView b={block} />;
    case "gauge":
      return <GaugeView b={block} />;
    case "heatmap":
      return <HeatmapView b={block} />;
    case "funnel":
      return <FunnelView b={block} />;
    case "metric":
      return <MetricView b={block} />;
    case "verdict":
      return <VerdictView b={block} />;
    case "checklist":
      return <ChecklistView b={block} />;
    case "quote":
      return <QuoteView b={block} />;
    case "badge_row":
      return <BadgeRowView b={block} />;
    case "rating":
      return <RatingView b={block} />;
    case "countdown":
      return <CountdownView b={block} />;
    case "slots":
      return <SlotsView b={block} />;
    case "mission_card":
      return <MissionCardView b={block} />;
    case "budget_meter":
      return <BudgetMeterView b={block} />;
    case "gate":
      return <GateView b={block} />;
    case "device_card":
      return <DeviceCardView b={block} />;
    case "hook_lab":
      return <HookLabView b={block} />;
    case "script_lines":
      return <ScriptLinesView b={block} />;
    case "ab_test":
      return <AbTestView b={block} />;
    case "trend_tags":
      return <TrendTagsView b={block} />;
    case "voice_track":
      return <VoiceTrackView b={block} />;
    case "palette":
      return <PaletteView b={block} />;
    case "pipeline":
      return <PipelineView b={block} />;
    case "diff":
      return <DiffView b={block} />;
    case "board":
      // Composite layout — children (validated depth-1 in ui-spec) render
      // through this same BlockView recursively, passed as a render prop.
      return (
        <BoardView
          b={block}
          renderBlock={(child, key) => <BlockView key={key} block={child} onAction={onAction} />}
        />
      );
    default:
      return null;
  }
}

/* ---------- safe inline markdown ----------
   Supports **bold**, *italic*, `code`, [text](url) and line breaks only.
   Rendered as React nodes — never via dangerouslySetInnerHTML. */
function renderInline(text: string, keyBase: string): ReactNode[] {
  const out: ReactNode[] = [];
  // Split on the supported tokens; keep the delimiters via capture groups.
  // Italic requires non-space adjacency (`*x*`, not `2 * 3`) so stray/spaced
  // asterisks in prose don't become <em>; bold/code/link are unambiguous.
  const tokenRe = /(\*\*[^*]+\*\*|\*\S\*|\*\S[^*]*\S\*|`[^`]+`|\[[^\]]+\]\([^)]+\))/g;
  const parts = text.split(tokenRe);
  parts.forEach((p, i) => {
    if (!p) return;
    const k = `${keyBase}-${i}`;
    if (p.startsWith("**") && p.endsWith("**") && p.length > 4) {
      out.push(<strong key={k}>{p.slice(2, -2)}</strong>);
    } else if (p.startsWith("*") && p.endsWith("*") && p.length > 2) {
      out.push(<em key={k}>{p.slice(1, -1)}</em>);
    } else if (p.startsWith("`") && p.endsWith("`") && p.length > 2) {
      out.push(
        <code key={k} className="cp-code">
          {p.slice(1, -1)}
        </code>,
      );
    } else {
      const link = p.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
      if (link) {
        const href = link[2].trim();
        if (/^https?:\/\//i.test(href) || (href.startsWith("/") && !href.startsWith("//"))) {
          out.push(
            <a key={k} href={href} target="_blank" rel="noopener noreferrer" className="gu-link">
              {link[1]}
            </a>,
          );
          return;
        }
        out.push(<span key={k}>{link[1]}</span>);
      } else {
        out.push(<span key={k}>{p}</span>);
      }
    }
  });
  return out;
}

function MarkdownNodes({ text }: { text: string }) {
  const lines = text.split("\n");
  return (
    <>
      {lines.map((line, li) => (
        <span key={li}>
          {renderInline(line, `l${li}`)}
          {li < lines.length - 1 ? <br /> : null}
        </span>
      ))}
    </>
  );
}

/* ---------- blocks ---------- */

function CardView({ b }: { b: UICard }) {
  const body = (
    <>
      {b.thumbUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img className="gu-card-thumb" src={b.thumbUrl} alt="" />
      ) : null}
      <div className="gu-card-main">
        <div className="gu-card-title">
          {b.title}
          {b.href ? <ExternalLink size={12} className="gu-card-ext" /> : null}
        </div>
        {b.subtitle ? <div className="gu-card-sub">{b.subtitle}</div> : null}
        {b.fields && b.fields.length ? (
          <dl className="gu-fields">
            {b.fields.map((f, i) => (
              <div className="gu-field" key={i}>
                <dt>{f.label}</dt>
                <dd>{f.value}</dd>
              </div>
            ))}
          </dl>
        ) : null}
      </div>
    </>
  );
  if (b.href) {
    return (
      <a className="gu-card gu-card-link" href={b.href} target="_blank" rel="noopener noreferrer">
        {body}
      </a>
    );
  }
  return <div className="gu-card">{body}</div>;
}

function StatGridView({ b }: { b: UIStatGrid }) {
  return (
    <div className="gu-stats">
      {b.stats.map((s, i) => (
        <div className="gu-stat" key={i}>
          <div className="gu-stat-value">
            {s.value}
            {s.unit ? <span className="gu-stat-unit">{s.unit}</span> : null}
          </div>
          <div className="gu-stat-label">{s.label}</div>
        </div>
      ))}
    </div>
  );
}

function TableView({ b }: { b: UITable }) {
  return (
    <div className="gu-table-wrap">
      <table className="gu-table">
        <thead>
          <tr>
            {b.columns.map((c, i) => (
              <th key={i}>{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {b.rows.map((row, ri) => (
            <tr key={ri}>
              {row.map((cell, ci) => (
                <td key={ci}>{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function VideoView({ b }: { b: UIVideo }) {
  const inner = (
    <>
      <div className="gu-video-thumb">
        {b.thumbUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={b.thumbUrl} alt="" />
        ) : (
          <Film size={18} />
        )}
      </div>
      <div className="gu-video-main">
        <div className="gu-video-title">{b.title}</div>
        {b.status ? <div className="gu-pill">{b.status}</div> : null}
      </div>
    </>
  );
  if (b.id) {
    return (
      <Link className="gu-video gu-card-link" href={`/post/${encodeURIComponent(b.id)}`}>
        {inner}
      </Link>
    );
  }
  return <div className="gu-video">{inner}</div>;
}

function ConceptView({ b }: { b: UIConcept }) {
  const inner = (
    <>
      <div className="gu-concept-ico">
        <Lightbulb size={16} />
      </div>
      <div className="gu-concept-main">
        <div className="gu-concept-title">{b.title}</div>
        <div className="gu-concept-meta">
          {typeof b.score === "number" ? <span className="gu-score">score {b.score}</span> : null}
          {b.status ? <span className="gu-pill">{b.status}</span> : null}
        </div>
      </div>
    </>
  );
  if (b.id) {
    return (
      <Link className="gu-concept gu-card-link" href={`/post/${encodeURIComponent(b.id)}`}>
        {inner}
      </Link>
    );
  }
  return <div className="gu-concept">{inner}</div>;
}

function ImageView({ b }: { b: UIImage }) {
  return (
    <figure className="gu-image">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={b.url} alt={b.caption ?? ""} />
      {b.caption ? <figcaption>{b.caption}</figcaption> : null}
    </figure>
  );
}

const TONE_ICON: Record<CalloutTone, typeof Info> = {
  info: Info,
  warn: AlertTriangle,
  ok: CheckCircle2,
  err: XCircle,
};

function CalloutView({ b }: { b: UICallout }) {
  const Icon = TONE_ICON[b.tone] ?? Info;
  return (
    <div className={`gu-callout ${b.tone}`}>
      <Icon size={14} className="gu-callout-ico" />
      <div className="gu-callout-text">
        <MarkdownNodes text={b.text} />
      </div>
    </div>
  );
}

function MarkdownView({ b }: { b: UIMarkdown }) {
  return (
    <div className="gu-markdown">
      <Markdown>{b.text}</Markdown>
    </div>
  );
}

function ProgressView({ b }: { b: UIProgress }) {
  // Static unless the block names a fleet job/item — then poll /api/jobs and
  // update the bar live (parsed percent + phase) until the render is terminal.
  const live = !!(b.jobId || b.itemId);
  const [value, setValue] = useState(b.value);
  const [caption, setCaption] = useState(b.caption);
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (!live) return;
    let alive = true;
    const poll = async () => {
      const r = await fetch("/api/jobs", { cache: "no-store" }).catch(() => null);
      const f = await r?.json().catch(() => null);
      if (!alive || !f?.jobs) return;
      const job = (f.jobs as LiveJob[]).find((j) => (b.jobId && j.id === b.jobId) || (b.itemId && j.itemId === b.itemId));
      if (!job) return;
      const p = parseProgress((job.progress ?? []).map((x) => x.line), job.status);
      if (p.pct != null) setValue(p.pct);
      setCaption(p.label);
      if (job.status === "done" || job.status === "error") { setDone(true); if (job.status === "done") setValue(100); }
    };
    void poll();
    const t = window.setInterval(() => { if (done) { window.clearInterval(t); return; } void poll(); }, 3000);
    return () => { alive = false; window.clearInterval(t); };
  }, [live, b.jobId, b.itemId, done]);

  return (
    <div className={`gu-progress${b.tone ? ` tone-${b.tone}` : ""}`}>
      <div className="gu-progress-head">
        <span className="gu-progress-label">
          {live && !done ? <span className="gu-live-dot" /> : null}
          {b.label || (live ? "Render progress" : "")}
        </span>
        <span className="gu-progress-pct">{value}%</span>
      </div>
      <div className="gu-progress-track">
        <div className="gu-progress-fill" style={{ width: `${value}%` }} />
      </div>
      {caption ? <div className="gu-progress-cap">{caption}{live && !done ? " · live" : ""}</div> : null}
    </div>
  );
}

const STEP_ICON: Record<StepState, ReactNode> = {
  done: <CheckCircle2 size={15} className="gu-step-ic done" />,
  active: <Loader2 size={15} className="gu-step-ic active" />,
  error: <XCircle size={15} className="gu-step-ic error" />,
  pending: <Circle size={15} className="gu-step-ic pending" />,
};

function StepsView({ b }: { b: UISteps }) {
  return (
    <div className="gu-steps">
      {b.title ? <div className="gu-steps-title">{b.title}</div> : null}
      <ol className="gu-steps-list">
        {b.items.map((s, i) => (
          <li className={`gu-step ${s.state}`} key={i}>
            <span className="gu-step-marker">{STEP_ICON[s.state]}</span>
            <span className="gu-step-label">{s.label}</span>
            {s.detail ? <span className="gu-step-detail">{s.detail}</span> : null}
          </li>
        ))}
      </ol>
    </div>
  );
}

function KeyValueView({ b }: { b: UIKeyValue }) {
  return (
    <div className="gu-kv">
      {b.title ? <div className="gu-kv-title">{b.title}</div> : null}
      <dl className="gu-kv-list">
        {b.items.map((kv, i) => (
          <div className="gu-kv-row" key={i}>
            <dt className="gu-kv-key">{kv.key}</dt>
            <dd className="gu-kv-val">{kv.value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function ActionsView({ b, onAction }: { b: UIActions; onAction?: (text: string) => void }) {
  return (
    <div className="gu-actions">
      {b.buttons.map((btn, i) => (
        <button
          key={i}
          type="button"
          className="gu-action-btn"
          onClick={() => onAction?.(btn.send)}
          disabled={!onAction}
        >
          {btn.label}
        </button>
      ))}
    </div>
  );
}

function FormView({ b, onAction }: { b: UIForm; onAction?: (text: string) => void }) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [submitted, setSubmitted] = useState(false);

  const set = (name: string, v: string) => setValues((prev) => ({ ...prev, [name]: v }));

  const buildMessage = (): string => {
    if (b.sendTemplate) {
      return b.sendTemplate.replace(/\{(\w+)\}/g, (_m, key: string) => values[key] ?? "");
    }
    const parts = b.fields.map((f) => `${f.label}: ${values[f.name] ?? ""}`);
    const head = b.title ? `${b.title}\n` : "";
    return `${head}${parts.join("\n")}`;
  };

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!onAction || submitted) return;
    setSubmitted(true);
    onAction(buildMessage());
  };

  return (
    <form className="gu-form" onSubmit={onSubmit}>
      {b.title ? <div className="gu-form-title">{b.title}</div> : null}
      {b.fields.map((f) => (
        <label className="gu-form-field" key={f.name}>
          <span className="gu-form-label">{f.label}</span>
          {f.type === "textarea" ? (
            <textarea
              className="gu-input"
              rows={3}
              placeholder={f.placeholder}
              value={values[f.name] ?? ""}
              disabled={submitted}
              onChange={(e) => set(f.name, e.target.value)}
            />
          ) : f.type === "select" ? (
            <select
              className="gu-input"
              value={values[f.name] ?? ""}
              disabled={submitted}
              onChange={(e) => set(f.name, e.target.value)}
            >
              <option value="">{f.placeholder ?? "Select…"}</option>
              {(f.options ?? []).map((op) => (
                <option key={op} value={op}>
                  {op}
                </option>
              ))}
            </select>
          ) : (
            <input
              className="gu-input"
              type={f.type === "number" ? "number" : "text"}
              placeholder={f.placeholder}
              value={values[f.name] ?? ""}
              disabled={submitted}
              onChange={(e) => set(f.name, e.target.value)}
            />
          )}
        </label>
      ))}
      <button type="submit" className="gu-form-submit" disabled={submitted || !onAction}>
        {submitted ? "Sent" : b.submitLabel}
      </button>
    </form>
  );
}

export default UIBlocks;
