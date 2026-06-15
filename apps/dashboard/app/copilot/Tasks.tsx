"use client";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  ChevronRight,
  Bot,
  Users,
  Workflow,
  Wrench,
  GitBranch,
  Loader2,
  Check,
  X,
  Clock,
  CircleSlash,
  Square,
  ArrowUp,
} from "lucide-react";
import type { useJobs } from "./useJobs";
import type { Job, JobEvent, JobKind, JobStatus } from "./useJobs";

type JobsApi = ReturnType<typeof useJobs>;

/* Live TASK TREE for the agent queue / teams / workflows — a Claude-Code-style
   indented, collapsible tree. Each node carries a status dot, a kind icon, a
   title, a live event/step count, elapsed time, a cancel control while running,
   and an expandable body showing recent events + the final result. */

function KindIcon({ kind, size = 13 }: { kind: JobKind; size?: number }) {
  switch (kind) {
    case "team":
      return <Users size={size} />;
    case "workflow":
      return <Workflow size={size} />;
    case "subagent":
      return <GitBranch size={size} />;
    case "tool":
      return <Wrench size={size} />;
    case "agent":
    default:
      return <Bot size={size} />;
  }
}

function StatusDot({ status }: { status: JobStatus }) {
  if (status === "running")
    return (
      <span className="cpt-dot running" title="running">
        <Loader2 size={12} className="cp-spin" />
      </span>
    );
  if (status === "queued")
    return (
      <span className="cpt-dot queued" title="queued">
        <Clock size={11} />
      </span>
    );
  if (status === "succeeded")
    return (
      <span className="cpt-dot ok" title="succeeded">
        <Check size={12} />
      </span>
    );
  if (status === "failed")
    return (
      <span className="cpt-dot err" title="failed">
        <X size={12} />
      </span>
    );
  return (
    <span className="cpt-dot canceled" title="canceled">
      <CircleSlash size={11} />
    </span>
  );
}

function elapsed(job: Job): string {
  const start = job.startedAt ?? job.createdAt;
  const end = job.endedAt ?? Date.now();
  const ms = Math.max(0, end - start);
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  if (m < 60) return `${m}m ${rem}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function fmtJson(value: unknown): string {
  try {
    return typeof value === "string" ? value : JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function eventLine(ev: JobEvent): { ico: JobKind | "log"; label: string; detail?: string } | null {
  switch (ev.type) {
    case "tool_call":
      return { ico: "tool", label: ev.name ?? "tool", detail: "call" };
    case "tool_result":
      return { ico: "tool", label: ev.name ?? "tool", detail: ev.ok === false ? "error" : "done" };
    case "spawn":
      return { ico: (ev.role as JobKind) ?? "subagent", label: ev.role ?? "spawned", detail: "spawn" };
    case "log":
      return { ico: "log", label: ev.message ?? "log" };
    case "status":
      return { ico: "log", label: `status: ${ev.status ?? ""}` };
    case "token":
      return null; // tokens shown as a single rolling preview, not per-line
    default:
      return null;
  }
}

function tokenPreview(events: JobEvent[]): string {
  let s = "";
  for (const e of events) if (e.type === "token" && e.text) s += e.text;
  return s.trim();
}

/* Latest reported percent + label, scanned from the end of the event stream.
   Long pipeline tools (generate/render/longform) emit `log` events carrying a
   `pct` parsed from the run log; this surfaces the freshest one for a thin bar. */
function latestProgress(events: JobEvent[]): { pct: number; label?: string } | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const p = events[i].pct;
    if (typeof p === "number" && Number.isFinite(p)) {
      return { pct: Math.max(0, Math.min(100, Math.round(p))), label: events[i].message };
    }
  }
  return null;
}

/* The full live rail: every non-token event in order, with a small ink glyph.
   tokens are folded into a single trailing preview elsewhere, so they're skipped
   here. Sampled implicitly by the engine/bridge (it already debounces pct). */
function railLines(events: JobEvent[]): { ico: JobKind | "log"; label: string; detail?: string; key: number }[] {
  const out: { ico: JobKind | "log"; label: string; detail?: string; key: number }[] = [];
  events.forEach((ev, i) => {
    const l = eventLine(ev);
    if (l) out.push({ ...l, key: ev.seq ?? i });
  });
  return out;
}

/* Sticky-bottom auto-scrolling event rail for a RUNNING job. Follows the tail
   unless the user has scrolled up to read history (then it stops snapping).
   reduced-motion safe: the snap is an instant scrollTop assignment, not a
   smooth animation. */
function LiveRail({ events }: { events: JobEvent[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const lines = useMemo(() => railLines(events).slice(-60), [events]);

  const onScroll = () => {
    const el = ref.current;
    if (!el) return;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
  };

  useLayoutEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [lines.length]);

  if (!lines.length) return null;
  return (
    <div className="cpt-rail" ref={ref} onScroll={onScroll} role="log" aria-live="polite">
      {lines.map((l) => (
        <div key={l.key} className={`cpt-rail-ev ${l.detail ?? ""}`}>
          <span className="cpt-rail-ico">
            {l.ico === "log" ? <ChevronRight size={10} /> : <KindIcon kind={l.ico} size={10} />}
          </span>
          <span className="cpt-rail-label">{l.label}</span>
          {l.detail && <span className="cpt-rail-detail">{l.detail}</span>}
        </div>
      ))}
    </div>
  );
}

function TreeNode({
  job,
  childrenOf,
  onCancel,
}: {
  job: Job;
  childrenOf: (parentId: string) => Job[];
  onCancel: (id: string) => void;
}) {
  const [open, setOpen] = useState(job.status === "running");
  const kids = childrenOf(job.id);
  const running = job.status === "running" || job.status === "queued";
  const eventCount = job.events.filter((e) => e.type !== "token" && e.type !== "status").length;
  const recent = useMemo(() => {
    const lines = job.events.map(eventLine).filter(Boolean) as NonNullable<
      ReturnType<typeof eventLine>
    >[];
    return lines.slice(-8);
  }, [job.events]);
  const preview = useMemo(() => tokenPreview(job.events), [job.events]);
  const progress = useMemo(() => latestProgress(job.events), [job.events]);
  // A thin bar shows while running with a known pct, and stays at 100% on a
  // succeeded job that reported progress (so a finished render reads "done").
  const barPct = job.status === "succeeded" ? 100 : progress?.pct;

  return (
    <div className={`cpt-node kind-${job.kind}`} style={{ paddingLeft: job.depth > 0 ? 14 : 0 }}>
      <div className={`cpt-row ${job.status}`}>
        <button
          className="cpt-twist"
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-label={open ? "Collapse" : "Expand"}
        >
          <ChevronRight size={13} className={`cpt-chev${open ? " open" : ""}`} />
        </button>
        <StatusDot status={job.status} />
        <span className="cpt-kind">
          <KindIcon kind={job.kind} />
        </span>
        <button className="cpt-title" type="button" onClick={() => setOpen((v) => !v)} title={job.title}>
          {job.title}
        </button>
        <span className="cpt-meta">
          {eventCount > 0 && <span className="cpt-count">{eventCount}</span>}
          <span className="cpt-elapsed">{elapsed(job)}</span>
        </span>
        {running && (
          <button
            className="cpt-cancel"
            type="button"
            onClick={() => onCancel(job.id)}
            title="Cancel"
            aria-label="Cancel job"
          >
            <Square size={11} />
          </button>
        )}
      </div>

      {typeof barPct === "number" && (job.status === "running" || job.status === "succeeded") && (
        <div className={`cpt-bar ${job.status}`} title={progress?.label}>
          <div className="cpt-bar-track">
            <div className="cpt-bar-fill" style={{ width: `${barPct}%` }} />
          </div>
          <span className="cpt-bar-pct">{barPct}%</span>
        </div>
      )}

      {open && (
        <div className="cpt-body">
          {preview && (
            <div className="cpt-preview">{preview.slice(-600)}</div>
          )}
          {/* RUNNING: a live, autoscrolling rail of the full event stream.
              SETTLED: the compact last-8 list (cheaper, no scroll machinery). */}
          {running ? (
            <LiveRail events={job.events} />
          ) : (
            recent.length > 0 && (
              <div className="cpt-events">
                {recent.map((l, i) => (
                  <div key={i} className={`cpt-ev ${l.detail ?? ""}`}>
                    <span className="cpt-ev-ico">
                      {l.ico === "log" ? <ChevronRight size={11} /> : <KindIcon kind={l.ico} size={11} />}
                    </span>
                    <span className="cpt-ev-label">{l.label}</span>
                    {l.detail && <span className="cpt-ev-detail">{l.detail}</span>}
                  </div>
                ))}
              </div>
            )
          )}
          {job.error && <div className="cpt-result err">{job.error}</div>}
          {job.result && <div className="cpt-result">{fmtJson(job.result).slice(0, 1200)}</div>}
          {!preview && recent.length === 0 && !job.result && !job.error && (
            <div className="cpt-result muted">No events yet.</div>
          )}
        </div>
      )}

      {kids.length > 0 && (
        <div className="cpt-kids">
          {kids.map((k) => (
            <TreeNode key={k.id} job={k} childrenOf={childrenOf} onCancel={onCancel} />
          ))}
        </div>
      )}
    </div>
  );
}

export function Tasks({ api }: { api: JobsApi }) {
  const { jobs, error, enqueue, cancel } = api;
  const [draft, setDraft] = useState("");

  // Index by parent for nesting; roots are jobs with no parentId.
  const { roots, childrenOf } = useMemo(() => {
    const byParent = new Map<string, Job[]>();
    for (const j of jobs) {
      if (!j.parentId) continue;
      const arr = byParent.get(j.parentId) ?? [];
      arr.push(j);
      byParent.set(j.parentId, arr);
    }
    for (const arr of byParent.values()) arr.sort((a, b) => a.createdAt - b.createdAt);
    const rootList = jobs.filter((j) => !j.parentId).sort((a, b) => b.createdAt - a.createdAt);
    return {
      roots: rootList,
      childrenOf: (id: string) => byParent.get(id) ?? [],
    };
  }, [jobs]);

  const submit = () => {
    const p = draft.trim();
    if (!p) return;
    setDraft("");
    void enqueue(p.slice(0, 80), p);
  };

  return (
    <div className="cpt">
      <div className="cpt-enqueue">
        <input
          className="cpt-input"
          placeholder="Queue a background job…"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              submit();
            }
          }}
        />
        <button
          className="cpt-enqueue-btn"
          type="button"
          onClick={submit}
          disabled={!draft.trim()}
          title="Enqueue job"
          aria-label="Enqueue job"
        >
          <ArrowUp size={15} />
        </button>
      </div>

      <div className="cpt-list">
        {error && <div className="cpt-error">{error}</div>}
        {roots.length === 0 && !error ? (
          <div className="cpt-empty">
            <div className="cpt-empty-icon">
              <Workflow size={20} />
            </div>
            <div className="cpt-empty-title">No tasks yet</div>
            <div className="cpt-empty-sub">
              Queue a background job above, or the agent will spawn teams and
              workflows here as it works.
            </div>
          </div>
        ) : (
          roots.map((r) => (
            <TreeNode key={r.id} job={r} childrenOf={childrenOf} onCancel={cancel} />
          ))
        )}
      </div>
    </div>
  );
}

export default Tasks;
