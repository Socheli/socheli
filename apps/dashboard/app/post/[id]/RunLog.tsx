"use client";
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { fmtCost } from "../../ui";
import { confirmDialog, alertDialog } from "../../confirm";
import { parseProgress } from "../../../lib/progress";

type RunWarning = { at: string; stage: string; code: string; message: string; detail?: string };
type LiveJob = { id: string; status: string; device?: string; itemId?: string; updatedAt?: string; type?: string; progress?: { line: string }[]; warnings?: RunWarning[] };

type Item = {
  id: string;
  channel?: string;
  seedIdea?: string;
  mood?: string;
  status: string;
  createdAt: string;
  updatedAt?: string;
  idea?: any;
  script?: any;
  storyboard?: { scenes?: any[] };
  qa?: { overall?: number; verdict?: string };
  pkg?: { title?: string };
  videoPath?: string;
  ledger?: { entries?: { stage: string; usd: number; at: string }[]; totalUsd?: number };
  log?: { at: string; msg: string }[];
  warnings?: RunWarning[];
};

const TERMINAL = new Set(["packaged", "rendered", "failed", "qa_failed", "published"]);
const STALL_MS = 4 * 60 * 1000;

const STEPS = [
  { id: "trends", label: "Trend scan", test: (it: Item) => hasStage(it, "trends") || hasLog(it, "scanning") },
  { id: "idea", label: "Idea selected", test: (it: Item) => !!it.idea || hasStage(it, "idea") || it.status === "idea_proposed" },
  { id: "hook", label: "Hook chosen", test: (it: Item) => !!it.script?.hook || hasStage(it, "hook") },
  { id: "script", label: "Script drafted", test: (it: Item) => !!it.script || hasStage(it, "script") },
  { id: "storyboard", label: "Storyboard built", test: (it: Item) => !!it.storyboard || hasStage(it, "storyboard") },
  { id: "factcheck", label: "Fact check", test: (it: Item) => hasStage(it, "factcheck") },
  { id: "qa", label: "QA scored", test: (it: Item) => !!it.qa || hasStage(it, "qa") || hasStage(it, "qa2") },
  { id: "package", label: "Packaging", test: (it: Item) => !!it.pkg || hasStage(it, "package") },
  { id: "render", label: "Render asset", test: (it: Item) => !!it.videoPath || it.status === "rendered" },
];

function hasStage(it: Item, stage: string) {
  return !!it.ledger?.entries?.some((e) => e.stage === stage);
}
function hasLog(it: Item, text: string) {
  return !!it.log?.some((l) => l.msg.toLowerCase().includes(text));
}
function time(iso?: string) {
  return iso ? iso.slice(11, 19) : "--:--:--";
}
function stageAt(it: Item, stage: string) {
  return it.ledger?.entries?.find((e) => e.stage === stage)?.at;
}
function detailFor(it: Item, id: string) {
  if (id === "idea" && it.idea) return `${it.idea.format?.replace(/_/g, " ")} / ${it.idea.topic}`;
  if (id === "hook" && it.script?.hook) return it.script.hook;
  if (id === "script" && it.script?.narration) return `${it.script.narration.length} narration beats`;
  if (id === "storyboard" && it.storyboard?.scenes) return `${it.storyboard.scenes.length} scenes`;
  if (id === "qa" && it.qa) return `${it.qa.overall?.toFixed?.(1) ?? "?"}/10 ${it.qa.verdict ?? ""}`;
  if (id === "package" && it.pkg?.title) return it.pkg.title;
  if (id === "render" && it.videoPath) return "MP4 ready";
  const e = it.ledger?.entries?.find((x) => x.stage === id);
  return e ? `${fmtCost(e.usd)}` : "";
}

export function RunLog({ id, initial }: { id: string; initial: Item }) {
  const router = useRouter();
  const [item, setItem] = useState(initial);
  const [job, setJob] = useState<LiveJob | null>(null);
  const [lastPoll, setLastPoll] = useState(new Date());
  const [busy, setBusy] = useState("");

  const terminal = TERMINAL.has(item.status) || !!item.videoPath;
  const age = lastPoll.getTime() - new Date(item.updatedAt ?? item.createdAt).getTime();
  const stalled = !terminal && age > STALL_MS;

  useEffect(() => {
    let alive = true;
    // Stop polling once the run reaches a terminal state — no point hammering the API.
    if (TERMINAL.has(item.status) || item.videoPath) {
      setLastPoll(new Date());
      return;
    }
    const poll = async () => {
      const r = await fetch(`/api/item/${id}`, { cache: "no-store" }).catch(() => null);
      if (alive && r?.ok) setItem(await r.json());
      // live render progress: find this item's most-recent fleet job (progress is
      // keyed by job, not item — match on itemId) so we can show device + percent.
      const fr = await fetch("/api/jobs", { cache: "no-store" }).catch(() => null);
      const fd = await fr?.json().catch(() => null);
      if (alive && fd?.jobs) {
        const mine = (fd.jobs as LiveJob[]).filter((j) => j.itemId === id);
        setJob(mine[0] ?? null); // jobs come newest-first
      }
      if (alive) setLastPoll(new Date());
    };
    const t = window.setInterval(poll, 1200);
    void poll();
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, [id, item.status, item.videoPath]);

  const dismiss = async () => {
    if (!(await confirmDialog({ title: "Dismiss this run?", message: "It will be removed from the queue.", confirmText: "Dismiss", danger: true }))) return;
    setBusy("dismiss");
    await fetch(`/api/item/${id}`, { method: "DELETE" }).catch(() => null);
    router.push("/queue");
  };
  const retry = async () => {
    setBusy("retry");
    const r = await fetch("/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ seed: item.seedIdea, channel: item.channel, mood: item.mood, voice: true }),
    }).catch(() => null);
    const data = await r?.json().catch(() => ({}));
    if (!r || !r.ok) {
      setBusy("");
      await alertDialog({ title: "Couldn't retry", message: `${data?.error ?? "The engine didn't accept the job."} The original run was kept.`, danger: true });
      return;
    }
    // Only remove the stalled run once the new one is queued.
    await fetch(`/api/item/${id}`, { method: "DELETE" }).catch(() => null);
    router.push("/queue");
  };

  const current = useMemo(() => {
    const idx = STEPS.findIndex((s, i) => !s.test(item) && !STEPS.slice(i + 1).some((later) => later.test(item)));
    return idx === -1 ? STEPS.length - 1 : Math.max(0, idx);
  }, [item]);
  const prog = useMemo(() => (job ? parseProgress(job.progress, job.status) : null), [job]);
  const log = (item.log ?? []).slice(-8).reverse();
  // Non-fatal render degradations (caption/voice/music fallbacks). Persisted on
  // the item once it syncs; before that, the live device job carries them. Merge
  // + dedupe so they show during the render AND after it lands.
  const warnings = useMemo(() => {
    const seen = new Set<string>();
    const out: RunWarning[] = [];
    for (const w of [...(item.warnings ?? []), ...(job?.warnings ?? [])]) {
      const key = `${w.stage}:${w.code}:${w.message}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(w);
    }
    return out;
  }, [item.warnings, job?.warnings]);

  return (
    <div className="card run-card">
      <div className="run-head">
        <div>
          <h2 className="h2" style={{ margin: 0 }}>Run log</h2>
          <div className="run-sub">{terminal ? `finished / ${item.status}` : stalled ? "stalled / polling paused" : `polling every 1.2s / last ${time(lastPoll.toISOString())}`}</div>
        </div>
        <span className={`badge ${stalled ? "b-err" : "b-neutral"}`}><span className="d" />{stalled ? "stalled" : item.status}</span>
      </div>
      {stalled && (
        <div className="run-stalled">
          No progress for {Math.round(age / 60000)}m — the run looks stuck. Retry from the original idea, or dismiss it.
        </div>
      )}
      {warnings.length > 0 && (
        <div className="run-warns" style={{ display: "flex", flexDirection: "column", gap: 8, margin: "12px 0", padding: "12px 14px", borderRadius: 10, border: "1px solid rgba(239,176,80,0.34)", background: "rgba(239,176,80,0.07)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 11, fontFamily: "var(--font-mono)", letterSpacing: "0.07em", textTransform: "uppercase", color: "var(--warning, #efb050)" }}>
            <span>⚠ {warnings.length === 1 ? "1 degradation" : `${warnings.length} degradations`}</span>
            <span style={{ opacity: 0.6 }}>· finished, but not at full quality</span>
          </div>
          {warnings.map((w, i) => (
            <div key={`${w.code}-${i}`} style={{ display: "flex", flexDirection: "column", gap: 3 }}>
              <div style={{ fontSize: 13, color: "var(--text-primary)" }}>
                <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, padding: "1px 6px", marginRight: 8, borderRadius: 5, background: "rgba(239,176,80,0.16)", color: "var(--warning, #efb050)", textTransform: "uppercase", letterSpacing: "0.05em" }}>{w.stage}</span>
                {w.message}
              </div>
              {w.detail && (
                <code style={{ fontSize: 11, color: "var(--text-muted)", fontFamily: "var(--font-mono)", whiteSpace: "pre-wrap", wordBreak: "break-word", paddingLeft: 2 }}>{w.detail}</code>
              )}
            </div>
          ))}
        </div>
      )}
      {prog && !terminal && (
        <div className="run-progress">
          <div className="run-progress-head">
            <span className="run-progress-label">{prog.label}</span>
            <span className="run-progress-pct">{prog.pct != null ? `${prog.pct}%` : "working…"}{job?.device ? ` · ${job.device}` : ""}</span>
          </div>
          <div className="run-bar">
            <div className={`run-bar-fill${prog.indeterminate ? " indeterminate" : ""}`} style={{ width: prog.pct != null ? `${prog.pct}%` : "100%" }} />
          </div>
        </div>
      )}
      <div className="run-steps">
        {STEPS.map((step, i) => {
          const recorded = step.test(item);
          const inferred = !recorded && STEPS.slice(i + 1).some((later) => later.test(item));
          const done = recorded || inferred;
          const active = !done && i === current;
          return (
            <div key={step.id} className={`run-step${done ? " done" : ""}${inferred ? " inferred" : ""}${active ? " active" : ""}`}>
              <span className="run-dot" />
              <span className="run-time">{time(stageAt(item, step.id) ?? item.updatedAt ?? item.createdAt)}</span>
              <span className="run-label">{step.label}</span>
              <span className="run-detail">{recorded ? detailFor(item, step.id) : inferred ? "not recorded" : active ? "in progress" : "queued"}</span>
            </div>
          );
        })}
      </div>
      <div className="run-stream">
        {log.length ? log.map((l, i) => <div className="log-line" key={`${l.at}-${i}`}><span className="t">{time(l.at)}</span>{l.msg}</div>) : <div className="log-line"><span className="t">{time(item.createdAt)}</span>run initialized</div>}
      </div>
      {!terminal && (
        <div className="run-actions">
          <button className="btn" disabled={!!busy} onClick={retry}>{busy === "retry" ? "Starting…" : "↻ Retry"}</button>
          <button className="btn q-act-danger" disabled={!!busy} onClick={dismiss}>{busy === "dismiss" ? "Dismissing…" : "✕ Dismiss"}</button>
        </div>
      )}
    </div>
  );
}
