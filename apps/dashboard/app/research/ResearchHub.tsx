"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowRight, Link2, ShieldCheck } from "lucide-react";
import { Select } from "../Select";
import type { ResearchKind, ResearchListRow } from "../../lib/research";
import { FreshBadge, KindBadge, KIND_META, StatusBadge, fmtAge, fmtUsd } from "./meta";

/* The research hub: "new research" composer on top, the run index below with
   kind/channel filters. The composer POSTs /api/research (which spawns the
   engine's detached research worker) and redirects straight to the run page,
   where the steps stream in. The list auto-refreshes while any run is live. */

const KINDS = Object.keys(KIND_META) as ResearchKind[];
const DEPTHS = [
  { value: "quick", label: "Quick", hint: "≈3 queries · 5 sources" },
  { value: "standard", label: "Standard", hint: "≈5 queries · 10 sources" },
  { value: "deep", label: "Deep", hint: "≈8 queries · 20 sources" },
];

export function ResearchHub({
  initialRuns,
  brands,
  canRun,
}: {
  initialRuns: ResearchListRow[];
  brands: { id: string; name: string }[];
  canRun: boolean;
}) {
  const router = useRouter();
  const [runs, setRuns] = useState<ResearchListRow[]>(initialRuns);

  // composer
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<string>("topic");
  const [depth, setDepth] = useState<string>("standard");
  const [channel, setChannel] = useState<string>("");
  const [starting, setStarting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // filters
  const [fKind, setFKind] = useState<string>("");
  const [fChannel, setFChannel] = useState<string>("");

  /* Channel options = the workspace's brands plus any channel that already
     appears on a run (engine-side runs can carry channels with no brand). */
  const channelOptions = useMemo(() => {
    const byId = new Map<string, string>();
    for (const b of brands) byId.set(b.id, b.name);
    for (const r of runs) if (r.channel && !byId.has(r.channel)) byId.set(r.channel, r.channel.replace(/_/g, " "));
    return [...byId.entries()].map(([value, label]) => ({ value, label }));
  }, [brands, runs]);

  /* Light auto-refresh: every 5s while a run is live (steps/cost move), every
     30s otherwise (another surface — CLI, copilot, a mission — may add runs). */
  const anyRunning = runs.some((r) => r.status === "running");
  const refreshing = useRef(false);
  useEffect(() => {
    const tick = async () => {
      if (refreshing.current || document.visibilityState !== "visible") return;
      refreshing.current = true;
      try {
        const r = await fetch("/api/research", { cache: "no-store" });
        if (r.ok) {
          const j = (await r.json()) as { runs?: ResearchListRow[] };
          if (Array.isArray(j.runs)) setRuns(j.runs);
        }
      } catch {
        /* transient — next tick retries */
      } finally {
        refreshing.current = false;
      }
    };
    const iv = setInterval(tick, anyRunning ? 5000 : 30000);
    return () => clearInterval(iv);
  }, [anyRunning]);

  const start = async () => {
    if (!canRun || starting) return;
    const q = query.trim();
    if (q.length < 3) {
      setErr("Give the run a real question (at least 3 characters).");
      return;
    }
    setStarting(true);
    setErr(null);
    try {
      const res = await fetch("/api/research", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: q, kind, depth, channel: channel || undefined }),
      });
      const j = (await res.json().catch(() => ({}))) as { id?: string; error?: string };
      if (!res.ok || !j.id) throw new Error(j.error ?? `HTTP ${res.status}`);
      router.push(`/research/${j.id}`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "failed to start research");
      setStarting(false);
    }
  };

  const visible = runs.filter((r) => (!fKind || r.kind === fKind) && (!fChannel || r.channel === fChannel));

  return (
    <>
      {/* ── New research composer ──────────────────────────────────────── */}
      <div className="card" style={{ marginBottom: 18 }}>
        <div className="stat-label" style={{ marginBottom: 10 }}>New research</div>
        <input
          className="input"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && start()}
          placeholder='What should we find out? e.g. "what hook styles are winning on IG reels right now"'
          disabled={starting}
          aria-label="Research question"
          maxLength={400}
        />
        <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", marginTop: 14 }}>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
            <span className="stat-label" style={{ marginRight: 4 }}>Kind</span>
            {KINDS.map((k) => {
              const Icon = KIND_META[k].icon;
              return (
                <button
                  key={k}
                  onClick={() => !starting && setKind(k)}
                  className={`btn${kind === k ? " btn-primary" : ""}`}
                  style={{ padding: "7px 12px", fontSize: 12 }}
                >
                  <Icon size={12} />
                  {KIND_META[k].label}
                </button>
              );
            })}
          </div>
          <span style={{ flex: 1 }} />
          <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "var(--text-muted)" }}>
            Depth
            <Select value={depth} onChange={setDepth} width={140} ariaLabel="Research depth" options={DEPTHS} disabled={starting} />
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "var(--text-muted)" }}>
            Channel
            <Select
              value={channel}
              onChange={setChannel}
              width={170}
              ariaLabel="Channel"
              options={[{ value: "", label: "No channel" }, ...channelOptions]}
              disabled={starting}
            />
          </label>
          <button
            onClick={start}
            disabled={!canRun || starting}
            className="btn btn-primary"
            style={{ padding: "9px 18px", opacity: canRun ? 1 : 0.5, cursor: canRun ? "pointer" : "not-allowed" }}
            title={canRun ? undefined : "You don't have permission to start research"}
          >
            {starting ? (
              <>
                <span className="pulse-dot" style={{ width: 8, height: 8, borderRadius: "50%", background: "#0a0a0a" }} />
                Starting…
              </>
            ) : (
              <>
                Run research
                <ArrowRight size={14} />
              </>
            )}
          </button>
        </div>
        {!canRun && (
          <div className="sub" style={{ fontSize: 11, marginTop: 8 }}>
            Your role can browse research but not start runs. Ask an admin to run one.
          </div>
        )}
        {err && (
          <div style={{ marginTop: 10, fontSize: 12.5, color: "var(--error, #ef5350)" }}>{err}</div>
        )}
      </div>

      {/* ── Filters ────────────────────────────────────────────────────── */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 14 }}>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          <button onClick={() => setFKind("")} className={`btn${fKind === "" ? " btn-active" : ""}`} style={{ padding: "6px 11px", fontSize: 12 }}>
            All kinds
          </button>
          {KINDS.map((k) => (
            <button key={k} onClick={() => setFKind(fKind === k ? "" : k)} className={`btn${fKind === k ? " btn-active" : ""}`} style={{ padding: "6px 11px", fontSize: 12 }}>
              {KIND_META[k].label}
            </button>
          ))}
        </div>
        <span style={{ flex: 1 }} />
        <Select
          value={fChannel}
          onChange={setFChannel}
          width={190}
          ariaLabel="Filter by channel"
          options={[{ value: "", label: "All channels" }, ...channelOptions]}
        />
      </div>

      {/* ── Run list ───────────────────────────────────────────────────── */}
      {visible.length === 0 ? (
        <div className="empty">
          {runs.length === 0
            ? "No research yet. Ask the first question above — the run streams its steps live and lands as a cited, verified report."
            : "No runs match these filters."}
        </div>
      ) : (
        <div style={{ display: "grid", gap: 10 }}>
          {visible.map((r) => (
            <Link key={r.id} href={`/research/${r.id}`} style={{ textDecoration: "none", color: "inherit" }}>
              <div className="card" style={{ padding: "14px 18px" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                  <KindBadge kind={r.kind} />
                  {r.depth && <span className="tag" style={{ margin: 0, opacity: 0.75 }}>{r.depth}</span>}
                  <span style={{ fontSize: 13.5, fontWeight: 600, color: "var(--text-light)", flex: 1, minWidth: 180, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {r.query}
                  </span>
                  <StatusBadge status={r.status} />
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap", marginTop: 9, fontSize: 11.5, color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>
                  {r.channel && <span className="tag" style={{ margin: 0 }}>{r.channel.replace(/_/g, " ")}</span>}
                  <FreshBadge status={r.status} ageHours={r.ageHours} ttlHours={r.ttlHours} />
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }} title="sources">
                    <Link2 size={11} />
                    {r.sourceCount}
                  </span>
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }} title="claims">
                    <ShieldCheck size={11} />
                    {r.claimCount}
                  </span>
                  <span title="run cost">{fmtUsd(r.usd)}</span>
                  <span style={{ flex: 1 }} />
                  <span>{fmtAge(r.createdAt)}</span>
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}
    </>
  );
}
