"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import {
  Check,
  Dna,
  FileSearch,
  Lock,
  LockOpen,
  Plus,
  RefreshCw,
  X,
} from "lucide-react";
import type { BrandGenome, GenomeMutation, GenomeTrait, PendingMutation, PlatformPlaybook } from "@os/schemas";
import { confirmDialog } from "../../../confirm";

/* The Brand Genome panel — trait buckets with weight bars, platform playbooks,
   the pending-mutation approval queue and the evolution timeline. All data via
   /api/dna/* (which spawns the engine's dna_* tools); this component never
   re-implements genome logic, it only renders and re-fetches. */

const BUCKETS = ["hooks", "topics", "formats", "visual", "voice"] as const;
type Bucket = (typeof BUCKETS)[number];

const BUCKET_DESC: Record<Bucket, string> = {
  hooks: "opening patterns that earn the first 2 seconds",
  topics: "subject affinities the audience rewards",
  formats: "video formats that perform",
  visual: "pacing, density, motion direction",
  voice: "delivery and tone notes",
};

const KIND_BADGE: Record<GenomeMutation["kind"], string> = {
  auto: "b-accent",
  approved: "b-ok",
  manual: "b-neutral",
};

function fmtTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function evidenceTitle(evidence?: string[]): string | undefined {
  return evidence?.length ? `Evidence:\n${evidence.join("\n")}` : undefined;
}

/* ── weight bar row (one trait) ─────────────────────────────────────────── */
function TraitRow({ trait, accent }: { trait: GenomeTrait; accent: string }) {
  const n = trait.evidence?.length ?? 0;
  return (
    <div className="qa-row" style={{ gap: 10 }}>
      <div
        className="qa-name"
        style={{ width: "44%", minWidth: 120, textTransform: "none", fontFamily: "inherit", color: "var(--text-light)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
        title={trait.value}
      >
        {trait.value}
      </div>
      <div className="qa-track">
        <div className="qa-fill" style={{ width: `${Math.round(trait.weight * 100)}%`, background: accent }} />
      </div>
      <div className="qa-num">{trait.weight.toFixed(2)}</div>
      <span
        className="tag"
        style={{ margin: 0, display: "inline-flex", alignItems: "center", gap: 5, cursor: n ? "help" : "default", opacity: n ? 1 : 0.45 }}
        title={evidenceTitle(trait.evidence) ?? "No evidence recorded"}
      >
        <FileSearch size={11} />
        {n}
      </span>
    </div>
  );
}

/* ── one trait bucket card ──────────────────────────────────────────────── */
function BucketCard({
  bucket,
  traits,
  locked,
  accent,
  canManage,
  busy,
  onLock,
  onAdd,
}: {
  bucket: Bucket;
  traits: GenomeTrait[];
  locked: boolean;
  accent: string;
  canManage: boolean;
  busy: boolean;
  onLock: (locked: boolean) => void;
  onAdd: (value: string) => Promise<void>;
}) {
  const [draft, setDraft] = useState("");
  const [adding, setAdding] = useState(false);

  const add = async () => {
    const v = draft.trim();
    if (!v || adding) return;
    setAdding(true);
    try {
      await onAdd(v);
      setDraft("");
    } finally {
      setAdding(false);
    }
  };

  const sorted = [...traits].sort((a, b) => b.weight - a.weight);

  return (
    <div className="card">
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4 }}>
        <div className="eyebrow" style={{ marginBottom: 0 }}>// {bucket}</div>
        <span className="tag" style={{ margin: 0 }}>{traits.length}</span>
        {canManage && (
          <button
            className="bw-btn ghost sm"
            style={{ marginLeft: "auto", display: "inline-flex", alignItems: "center", gap: 6, ...(locked ? { color: "var(--accent)", borderColor: "var(--border-interactive)" } : {}) }}
            disabled={busy}
            onClick={() => onLock(!locked)}
            title={locked ? "Locked — the evolution loop can't auto-mutate this bucket. Click to unlock." : "Unlocked — click to pin this bucket against auto-mutations."}
          >
            {locked ? <Lock size={12} /> : <LockOpen size={12} />}
            {locked ? "Locked" : "Lock"}
          </button>
        )}
        {!canManage && locked && (
          <span className="tag" style={{ margin: 0, marginLeft: "auto", display: "inline-flex", alignItems: "center", gap: 5 }}>
            <Lock size={11} /> locked
          </span>
        )}
      </div>
      <div className="sub" style={{ fontSize: 12, marginBottom: 14 }}>{BUCKET_DESC[bucket]}</div>

      {sorted.length === 0 ? (
        <div className="sub" style={{ padding: "10px 0", fontSize: 13, color: "var(--text-muted)" }}>
          No learned traits yet — evolution or a manual add seeds this bucket.
        </div>
      ) : (
        <div>{sorted.map((t) => <TraitRow key={t.value} trait={t} accent={accent} />)}</div>
      )}

      {canManage && (
        <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
          <input
            className="bw-input"
            style={{ flex: 1, minWidth: 0 }}
            value={draft}
            placeholder={`Add a ${bucket.replace(/s$/, "")} trait + Enter`}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void add();
              }
            }}
          />
          <button className="bw-btn sm" style={{ display: "inline-flex", alignItems: "center", gap: 5 }} disabled={!draft.trim() || adding} onClick={() => void add()}>
            <Plus size={13} />
            {adding ? "…" : "Add"}
          </button>
        </div>
      )}
    </div>
  );
}

/* ── platform playbook card ─────────────────────────────────────────────── */
function PlaybookCard({ pb }: { pb: PlatformPlaybook }) {
  return (
    <div className="card">
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <div className="eyebrow" style={{ marginBottom: 0 }}>// {pb.platform}</div>
        {pb.cadence && <span className="badge b-neutral" style={{ marginLeft: "auto" }}><span className="d" />{pb.cadence}</span>}
      </div>
      <div style={{ marginTop: 14 }}>
        {pb.levers.map((l) => (
          <div key={l} className="kv" style={{ justifyContent: "flex-start", gap: 10 }}>
            <span className="kv-k" style={{ flexShrink: 0 }}>lever</span>
            <span className="kv-v">{l}</span>
          </div>
        ))}
        {pb.bestTimes && pb.bestTimes.length > 0 && (
          <div className="kv">
            <span className="kv-k">best times</span>
            <span className="kv-v">{pb.bestTimes.join(" · ")}</span>
          </div>
        )}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 12, fontSize: 11.5, fontFamily: "var(--font-mono)", color: "var(--text-muted)" }}>
        updated {fmtTime(pb.updatedAt)}
        {pb.researchId && (
          <Link
            href={`/research/${pb.researchId}`}
            className="tag"
            style={{ margin: 0, marginLeft: "auto", display: "inline-flex", alignItems: "center", gap: 5, textDecoration: "none" }}
            title="Open the research run this playbook came from"
          >
            <FileSearch size={11} />
            research
          </Link>
        )}
      </div>
    </div>
  );
}

/* ── pending mutation card ──────────────────────────────────────────────── */
function PendingCard({
  m,
  accent,
  canManage,
  busy,
  onDecide,
}: {
  m: PendingMutation;
  accent: string;
  canManage: boolean;
  busy: boolean;
  onDecide: (action: "approve" | "reject") => void;
}) {
  const pct = Math.round(m.confidence * 100);
  return (
    <div className="card">
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <span className="tag" style={{ margin: 0 }}>{m.path}</span>
        <span style={{ fontSize: 11.5, fontFamily: "var(--font-mono)", color: "var(--text-muted)", marginLeft: "auto" }}>
          proposed {fmtTime(m.proposedAt)}
        </span>
      </div>
      <div style={{ marginTop: 12, fontSize: 14, color: "var(--text-primary)", fontWeight: 600 }}>{m.mutation}</div>
      <div className="sub" style={{ marginTop: 6, fontSize: 13 }}>{m.rationale}</div>
      <div className="qa-row" style={{ marginTop: 14, marginBottom: 0 }}>
        <div className="qa-name" style={{ width: 90 }}>confidence</div>
        <div className="qa-track">
          <div className="qa-fill" style={{ width: `${pct}%`, background: accent }} />
        </div>
        <div className="qa-num">{pct}%</div>
      </div>
      {canManage ? (
        <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
          <button className="bw-btn primary sm" style={{ display: "inline-flex", alignItems: "center", gap: 6 }} disabled={busy} onClick={() => onDecide("approve")}>
            <Check size={13} /> Approve
          </button>
          <button className="bw-btn danger sm" style={{ display: "inline-flex", alignItems: "center", gap: 6 }} disabled={busy} onClick={() => onDecide("reject")}>
            <X size={13} /> Reject
          </button>
        </div>
      ) : (
        <div className="sub" style={{ marginTop: 12, fontSize: 12, color: "var(--text-muted)" }}>
          Awaiting admin approval.
        </div>
      )}
    </div>
  );
}

/* ── the panel ──────────────────────────────────────────────────────────── */
export function GenomePanel({ channel, accent, canManage }: { channel: string; accent: string; canManage: boolean }) {
  const [genome, setGenome] = useState<BrandGenome | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null); // a mutation id / "lock:<path>" / "evolve"
  const [evolveHint, setEvolveHint] = useState<string | null>(null);
  const [actionErr, setActionErr] = useState<string | null>(null);
  const [showAllHistory, setShowAllHistory] = useState(false);

  const load = useCallback(async (initial = false) => {
    if (initial) setLoading(true);
    setError(null);
    try {
      const r = await fetch(`/api/dna?channel=${encodeURIComponent(channel)}`);
      const j = await r.json().catch(() => ({}));
      if (!r.ok) setError(j.error || `Couldn't read the genome (${r.status}).`);
      else setGenome(j.genome as BrandGenome);
    } catch {
      setError("Network error reading the genome.");
    } finally {
      setLoading(false);
    }
  }, [channel]);

  useEffect(() => {
    void load(true);
  }, [load]);

  /* one POST wrapper: every mutation route follows the same shape, and every
     success re-fetches the genome so the panel always shows engine truth. */
  const post = useCallback(
    async (url: string, body: Record<string, unknown>, busyKey: string) => {
      setBusy(busyKey);
      setActionErr(null);
      try {
        const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ channel, ...body }) });
        if (!r.ok) {
          const j = await r.json().catch(() => ({}));
          setActionErr(j.error || `Action failed (${r.status}).`);
          return false;
        }
        await load();
        return true;
      } catch {
        setActionErr("Network error — the change may not have been saved.");
        return false;
      } finally {
        setBusy(null);
      }
    },
    [channel, load],
  );

  async function evolve() {
    setBusy("evolve");
    setActionErr(null);
    setEvolveHint(null);
    try {
      const r = await fetch("/api/dna/evolve", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ channel }) });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        setActionErr(j.error || `Couldn't start evolution (${r.status}).`);
      } else {
        setEvolveHint("Evolution started in the background — proposals land in Pending mutations below in a few minutes. Refresh to check.");
      }
    } catch {
      setActionErr("Network error starting evolution.");
    } finally {
      setBusy(null);
    }
  }

  async function decide(m: PendingMutation, action: "approve" | "reject") {
    if (action === "reject") {
      const ok = await confirmDialog({
        title: "Reject this mutation?",
        message: `"${m.mutation}" will be discarded. The genome's traits stay untouched.`,
        confirmText: "Reject",
        danger: true,
      });
      if (!ok) return;
    }
    await post("/api/dna/mutations", { id: m.id, action }, m.id);
  }

  if (loading) {
    return (
      <div className="empty">
        <RefreshCw size={18} style={{ display: "block", margin: "0 auto 12px", animation: "spin 1.1s linear infinite" }} />
        Reading the genome…
        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      </div>
    );
  }

  if (error || !genome) {
    return (
      <div className="empty">
        <div style={{ marginBottom: 14 }}>{error ?? "No genome data."}</div>
        <button className="bw-btn sm" onClick={() => void load(true)}>Try again</button>
      </div>
    );
  }

  const traitCount = BUCKETS.reduce((a, b) => a + genome.traits[b].length, 0);
  const history = showAllHistory ? genome.evolution : genome.evolution.slice(0, 12);

  return (
    <>
      {/* header strip: version + counts + actions */}
      <div className="card" style={{ display: "flex", alignItems: "center", gap: 18, flexWrap: "wrap", marginBottom: 26 }}>
        <span className="tag" style={{ margin: 0 }}>v{genome.version}</span>
        <span style={{ fontSize: 12, fontFamily: "var(--font-mono)", color: "var(--text-secondary)" }}>{traitCount} traits</span>
        <span style={{ fontSize: 12, fontFamily: "var(--font-mono)", color: "var(--text-secondary)" }}>{genome.evolution.length} mutations</span>
        {genome.pending.length > 0 && (
          <span className="badge b-warn"><span className="d" />{genome.pending.length} pending</span>
        )}
        <span style={{ fontSize: 12, fontFamily: "var(--font-mono)", color: "var(--text-muted)" }}>updated {fmtTime(genome.updatedAt)}</span>
        <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
          <button className="bw-btn ghost sm" style={{ display: "inline-flex", alignItems: "center", gap: 6 }} onClick={() => void load()} title="Re-read the genome">
            <RefreshCw size={12} /> Refresh
          </button>
          {canManage && (
            <button
              className="bw-btn primary sm"
              style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
              disabled={busy === "evolve"}
              onClick={() => void evolve()}
              title="Gather learnings, analytics and fresh research, then propose evidence-backed mutations for approval"
            >
              <Dna size={13} />
              {busy === "evolve" ? "Starting…" : "Evolve now"}
            </button>
          )}
        </div>
      </div>

      {evolveHint && (
        <div className="card" style={{ marginBottom: 26, borderColor: "var(--border-interactive)", display: "flex", alignItems: "center", gap: 10, fontSize: 13, color: "var(--text-secondary)" }}>
          <Dna size={14} style={{ flexShrink: 0, color: "var(--accent)" }} />
          {evolveHint}
        </div>
      )}
      {actionErr && (
        <div className="card" style={{ marginBottom: 26, borderColor: "rgba(239,83,80,0.4)", color: "var(--error)", fontSize: 13 }}>
          {actionErr}
        </div>
      )}

      {/* audience model */}
      {genome.audienceModel?.summary && (
        <div className="card" style={{ marginBottom: 26 }}>
          <div className="eyebrow" style={{ marginBottom: 8 }}>// audience model</div>
          <div style={{ fontSize: 14, color: "var(--text-light)" }}>{genome.audienceModel.summary}</div>
          {genome.audienceModel.segments.length > 0 && (
            <div style={{ marginTop: 10 }}>
              {genome.audienceModel.segments.map((s) => (
                <div key={s.name} className="kv">
                  <span className="kv-k">{s.name}</span>
                  <span className="kv-v">{s.notes}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* trait buckets */}
      <div className="eyebrow">// traits</div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(340px, 100%), 1fr))", gap: 16, marginBottom: 34 }}>
        {BUCKETS.map((b) => (
          <BucketCard
            key={b}
            bucket={b}
            traits={genome.traits[b]}
            locked={genome.locks.some((l) => l === `traits.${b}` || l === "traits")}
            accent={accent}
            canManage={canManage}
            busy={busy === `lock:traits.${b}`}
            onLock={(locked) => void post("/api/dna/lock", { path: `traits.${b}`, locked }, `lock:traits.${b}`)}
            onAdd={async (value) => {
              await post("/api/dna/trait", { path: `traits.${b}`, value, weight: 0.6 }, `add:traits.${b}`);
            }}
          />
        ))}
      </div>

      {/* platform playbooks */}
      <div className="eyebrow">// platform playbooks</div>
      {genome.platformPlaybooks.length === 0 ? (
        <div className="card" style={{ marginBottom: 34, color: "var(--text-muted)", fontSize: 13 }}>
          No playbooks yet — an Algo Lab run or genome evolution writes per-platform ranking levers here, with research provenance.
        </div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(300px, 100%), 1fr))", gap: 16, marginBottom: 34 }}>
          {genome.platformPlaybooks.map((pb) => <PlaybookCard key={pb.platform} pb={pb} />)}
        </div>
      )}

      {/* pending mutations */}
      <div className="eyebrow">// pending mutations</div>
      {genome.pending.length === 0 ? (
        <div className="card" style={{ marginBottom: 34, color: "var(--text-muted)", fontSize: 13 }}>
          Nothing awaiting approval. &ldquo;Evolve now&rdquo; proposes evidence-backed mutations that queue here.
        </div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(340px, 100%), 1fr))", gap: 16, marginBottom: 34 }}>
          {genome.pending.map((m) => (
            <PendingCard key={m.id} m={m} accent={accent} canManage={canManage} busy={busy === m.id} onDecide={(a) => void decide(m, a)} />
          ))}
        </div>
      )}

      {/* evolution timeline */}
      <div className="eyebrow">// evolution timeline</div>
      {genome.evolution.length === 0 ? (
        <div className="card" style={{ color: "var(--text-muted)", fontSize: 13 }}>
          No mutations yet — this brand&apos;s DNA is still its hand-authored seed.
        </div>
      ) : (
        <div className="card" style={{ padding: 0 }}>
          {history.map((m, i) => (
            <div
              key={m.id}
              style={{
                display: "flex",
                alignItems: "flex-start",
                gap: 12,
                padding: "14px 18px",
                borderBottom: i < history.length - 1 ? "1px solid var(--border-subtle)" : "none",
                flexWrap: "wrap",
              }}
            >
              <span className={`badge ${KIND_BADGE[m.kind]}`} style={{ flexShrink: 0 }}>
                <span className="d" />
                {m.kind}
              </span>
              <div style={{ flex: 1, minWidth: 200 }}>
                <div style={{ fontSize: 13.5, color: "var(--text-light)" }}>{m.mutation}</div>
                <div className="sub" style={{ fontSize: 12, marginTop: 3 }}>{m.cause}</div>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 10, flexShrink: 0 }}>
                <span className="tag" style={{ margin: 0 }}>{m.path}</span>
                {(m.evidence?.length ?? 0) > 0 && (
                  <span className="tag" style={{ margin: 0, display: "inline-flex", alignItems: "center", gap: 5, cursor: "help" }} title={evidenceTitle(m.evidence)}>
                    <FileSearch size={11} />
                    {m.evidence!.length}
                  </span>
                )}
                <span style={{ fontSize: 11.5, fontFamily: "var(--font-mono)", color: "var(--text-muted)" }}>{fmtTime(m.at)}</span>
              </div>
            </div>
          ))}
          {genome.evolution.length > 12 && (
            <div style={{ padding: "12px 18px", borderTop: "1px solid var(--border-subtle)" }}>
              <button className="bw-btn ghost sm" onClick={() => setShowAllHistory((v) => !v)}>
                {showAllHistory ? "Show fewer" : `Show all ${genome.evolution.length}`}
              </button>
            </div>
          )}
        </div>
      )}
    </>
  );
}
