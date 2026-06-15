"use client";
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { Presence, JobRow } from "../../lib/fleet";
import { Select } from "../Select";
import { parseProgress } from "../../lib/progress";

const KNOWN_CHANNELS = ["labrinox", "claude_code_lab", "agentic_builder", "moltjobs", "cognitivx"];
const ACTIVE = new Set(["running", "dispatched"]);

function StatusBadge({ s }: { s: string }) {
  const cls = s === "busy" ? "b-accent" : s === "idle" || s === "online" ? "b-ok" : s === "error" ? "b-err" : "b-neutral";
  return <span className={`badge ${cls}`}><span className="d" />{s}</span>;
}

// a live progress bar for one job, parsed from its progress tail
function JobBar({ job }: { job: JobRow }) {
  const p = parseProgress(job.progress, job.status);
  return (
    <div className="dev-bar-wrap">
      <div className="dev-bar"><div className={`dev-bar-fill${p.indeterminate ? " indeterminate" : ""}`} style={{ width: p.pct != null ? `${p.pct}%` : "100%" }} /></div>
      <span className="dev-bar-pct">{p.pct != null ? `${p.pct}%` : "···"}</span>
      <span className="dev-bar-label">{p.label}</span>
    </div>
  );
}

function ago(iso?: string) {
  if (!iso) return "";
  const s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m ago`;
}

function JobCard({ j }: { j: JobRow & { attempts?: number } }) {
  const [open, setOpen] = useState(false);
  const active = ACTIVE.has(j.status);
  return (
    <div className={`dev-job${active ? " active" : ""}${j.status === "error" ? " err" : ""}`}>
      <div className="dev-job-head">
        <StatusBadge s={j.status} />
        <span className="dev-job-type">{j.type}</span>
        {j.channel && <span className="row-cost">{j.channel}</span>}
        {j.device && <span className="row-cost">on {j.device}</span>}
        {j.itemId && <a href={`/post/${j.itemId}`} className="dev-job-link">{j.itemId} ↗</a>}
        {j.attempts && j.attempts > 1 ? <span className="dev-attempts" title="render attempts for this item">×{j.attempts}</span> : null}
        <span className="row-cost" style={{ marginLeft: "auto" }}>{ago(j.updatedAt ?? j.createdAt)}</span>
      </div>
      {active && <JobBar job={j} />}
      {j.status === "error" && j.message && <div className="dev-job-msg">{j.message}</div>}
      {j.progress.length > 0 && (
        <button className="dev-log-toggle" onClick={() => setOpen((o) => !o)}>{open ? "▾ hide log" : `▸ log (${j.progress.length})`}</button>
      )}
      {open && (
        <pre className="dev-log">{j.progress.slice(-40).map((p) => p.line).join("\n")}</pre>
      )}
    </div>
  );
}

export function DevicesClient({ devices: initialDevices, jobs: initialJobs, online: initialOnline, canDispatch = true }: { devices: Presence[]; jobs: JobRow[]; online: number; canDispatch?: boolean }) {
  const router = useRouter();
  const [type, setType] = useState<"auto" | "new" | "ping" | "longform">("auto");
  const [channel, setChannel] = useState("labrinox");
  const [seed, setSeed] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  // live fleet: poll /api/jobs every 3s so devices + jobs update without a manual
  // refresh — and tick every second so the "Ns ago" / progress feel alive.
  const [devices, setDevices] = useState(initialDevices);
  const [jobs, setJobs] = useState(initialJobs);
  const [online, setOnline] = useState(initialOnline);
  const [, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    const pull = () =>
      fetch("/api/jobs", { cache: "no-store" })
        .then((r) => (r.ok ? r.json() : null))
        .then((f) => { if (alive && f) { setDevices(f.devices ?? []); setJobs(f.jobs ?? []); setOnline(f.online ?? 0); } })
        .catch(() => {});
    const p = window.setInterval(pull, 3000);
    const t = window.setInterval(() => setTick((n) => n + 1), 1000);
    void pull();
    return () => { alive = false; window.clearInterval(p); window.clearInterval(t); };
  }, []);

  const jobById = useMemo(() => new Map(jobs.map((j) => [j.id, j])), [jobs]);

  // split active vs recent; dedupe recent terminal jobs by item (collapse the
  // noisy re-dispatch chains into one card with an attempt count).
  const { activeJobs, recentJobs } = useMemo(() => {
    const active = jobs.filter((j) => ACTIVE.has(j.status));
    const terminal = jobs.filter((j) => !ACTIVE.has(j.status));
    const seen = new Map<string, JobRow & { attempts: number }>();
    for (const j of terminal) {
      const key = j.itemId || j.id;
      const prev = seen.get(key);
      if (!prev) seen.set(key, { ...j, attempts: 1 });
      else prev.attempts += 1; // keep the first (newest, jobs come newest-first), count the rest
    }
    return { activeJobs: active, recentJobs: [...seen.values()] };
  }, [jobs]);

  const dispatch = async () => {
    setBusy(true); setMsg("");
    const r = await fetch("/api/jobs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type, channel, seed: seed || undefined }) });
    const d = await r.json().catch(() => ({}));
    setBusy(false);
    setMsg(r.ok ? `dispatched ${d.job?.id ?? "✓"}` : `failed: ${d.error ?? r.status}`);
    setSeed("");
  };
  const needsSeed = type === "new" || type === "longform";

  return (
    <div className="grid" style={{ gap: 20 }}>
      {canDispatch && (
      <div className="card">
        <div className="stat-label">Dispatch a job to the fleet</div>
        <div style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 14, flexWrap: "wrap" }}>
          <Select value={type} onChange={(v) => setType(v as any)} width={230} ariaLabel="Job type"
            options={[{ value: "auto", label: "auto (select+build+publish)" }, { value: "new", label: "new (short-form build)" }, { value: "longform", label: "longform (16:9 YouTube)" }, { value: "ping", label: "ping (test)" }]} />
          {type !== "ping" && (
            <>
              <Select value={channel} onChange={setChannel} width={180} ariaLabel="Channel"
                options={KNOWN_CHANNELS.map((c) => ({ value: c, label: c }))} />
              <input value={seed} onChange={(e) => setSeed(e.target.value)} placeholder={needsSeed ? "topic / seed (required)" : "seed (blank = auto-select)"} className="input" style={{ flex: 1, minWidth: 180 }} />
            </>
          )}
          <button onClick={dispatch} disabled={busy || online === 0 || (needsSeed && !seed.trim())} className="btn btn-primary" title={online === 0 ? "no devices online" : undefined}>
            {busy ? "Dispatching…" : "Dispatch"}
          </button>
        </div>
        {online === 0 && <div className="sub" style={{ marginTop: 10, color: "var(--warning)" }}>No devices online — start the agent on a device: <code>pnpm content agent --device m4</code></div>}
        {msg && <div className="sub" style={{ marginTop: 10 }}>{msg}</div>}
      </div>
      )}

      {/* devices — each shows its live current-job progress when busy */}
      <div>
        <h2 className="h2">Devices <span className="row-cost">· {online} online</span></h2>
        {devices.length === 0 ? (
          <div className="empty">No devices have connected yet.</div>
        ) : (
          <div className="grid" style={{ gap: 10 }}>
            {devices.map((d) => {
              const cur = d.currentJob ? jobById.get(d.currentJob) : undefined;
              return (
                <div key={d.device} className={`dev-card${d.status === "busy" ? " busy" : ""}`}>
                  <div className="dev-card-head">
                    <span className={`dev-dot ${d.status}`} />
                    <span className="dev-name">{d.device}</span>
                    <StatusBadge s={d.status} />
                    {(d.caps ?? []).slice(0, 6).map((c) => <span key={c} className="tag" style={{ margin: 0 }}>{c}</span>)}
                    <span className="row-cost" style={{ marginLeft: "auto" }}>last seen {ago(d.lastSeen)}</span>
                  </div>
                  <div className="dev-meta">
                    {d.profile && <span>{d.profile.arch} · {d.profile.ramGb}GB · {d.profile.cpus} cores · {d.profile.gpu}</span>}
                  </div>
                  {cur && ACTIVE.has(cur.status) && (
                    <div className="dev-current">
                      <span className="dev-current-tag">{cur.type}{cur.itemId ? <a href={`/post/${cur.itemId}`} className="dev-job-link"> {cur.itemId} ↗</a> : ""}</span>
                      <JobBar job={cur} />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* active jobs */}
      {activeJobs.length > 0 && (
        <div>
          <h2 className="h2">In progress <span className="row-cost">· {activeJobs.length}</span></h2>
          <div className="grid" style={{ gap: 10 }}>{activeJobs.map((j) => <JobCard key={j.id} j={j} />)}</div>
        </div>
      )}

      {/* recent (deduped by item) */}
      <div>
        <h2 className="h2">Recent jobs</h2>
        {recentJobs.length === 0 ? (
          <div className="empty">No completed jobs yet.</div>
        ) : (
          <div className="grid" style={{ gap: 10 }}>{recentJobs.map((j) => <JobCard key={j.id} j={j} />)}</div>
        )}
      </div>
    </div>
  );
}
