"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Eye,
  Loader2,
  ScanLine,
  Search,
  Tag,
  TrendingUp,
} from "lucide-react";
import type { ObsListRow } from "../../lib/observations";

/* ── helpers ──────────────────────────────────────────────────────────────── */

function fmtNum(n?: number): string {
  if (!n) return "—";
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "K";
  return String(n);
}

function fmtAge(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const d = Math.floor(diff / 86_400_000);
  if (d === 0) return "today";
  if (d === 1) return "1d ago";
  if (d < 30) return `${d}d ago`;
  const m = Math.floor(d / 30);
  return m === 1 ? "1mo ago" : `${m}mo ago`;
}

/* ── platform badge ───────────────────────────────────────────────────────── */

function PlatformBadge({ platform }: { platform: string }) {
  const map: Record<string, { label: string; color: string }> = {
    instagram: { label: "Instagram", color: "#c13584" },
    youtube: { label: "YouTube", color: "#e5383b" },
    tiktok: { label: "TikTok", color: "#ededed" },
    x: { label: "X", color: "#5f5f5f" },
    other: { label: "Other", color: "#5f5f5f" },
  };
  const m = map[platform] ?? { label: platform, color: "#5f5f5f" };
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        padding: "3px 9px",
        borderRadius: 999,
        fontSize: 10,
        fontFamily: "var(--font-mono)",
        fontWeight: 600,
        letterSpacing: "0.05em",
        textTransform: "uppercase" as const,
        background: `${m.color}22`,
        border: `1px solid ${m.color}66`,
        color: m.color,
        flexShrink: 0,
      }}
    >
      {platform === "instagram" && (
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <rect x="2" y="2" width="20" height="20" rx="5" />
          <circle cx="12" cy="12" r="5" />
          <circle cx="17.5" cy="6.5" r="1.5" fill="currentColor" stroke="none" />
        </svg>
      )}
      {platform === "youtube" && (
        <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor">
          <path d="M22.54 6.42a2.78 2.78 0 0 0-1.95-1.97C18.88 4 12 4 12 4s-6.88 0-8.59.45A2.78 2.78 0 0 0 1.46 6.42 29 29 0 0 0 1 12a29 29 0 0 0 .46 5.58 2.78 2.78 0 0 0 1.95 1.97C5.12 20 12 20 12 20s6.88 0 8.59-.45a2.78 2.78 0 0 0 1.96-1.97A29 29 0 0 0 23 12a29 29 0 0 0-.46-5.58zM9.75 15.02V8.98L15.5 12l-5.75 3.02z" />
        </svg>
      )}
      {platform === "tiktok" && (
        <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor">
          <path d="M19.59 6.69a4.83 4.83 0 0 1-3.77-4.25V2h-3.45v13.67a2.89 2.89 0 0 1-2.88 2.5 2.89 2.89 0 0 1-2.89-2.89 2.89 2.89 0 0 1 2.89-2.89c.28 0 .54.04.79.1V9.01a6.33 6.33 0 0 0-.79-.05 6.34 6.34 0 0 0-6.34 6.34 6.34 6.34 0 0 0 6.34 6.34 6.34 6.34 0 0 0 6.33-6.34V9.5a8.17 8.17 0 0 0 4.77 1.52V7.57a4.85 4.85 0 0 1-1-.88z" />
        </svg>
      )}
      {m.label}
    </span>
  );
}

/* ── inspiration score bar ────────────────────────────────────────────────── */

function InspirationBar({ score }: { score?: number }) {
  if (score == null) return null;
  const pct = Math.max(0, Math.min(1, score / 10));
  const color = pct >= 0.7 ? "var(--success)" : pct >= 0.4 ? "var(--warning)" : "var(--text-muted)";
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <div
        style={{
          flex: 1,
          height: 4,
          borderRadius: 999,
          background: "var(--bg-surface)",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            width: `${pct * 100}%`,
            height: "100%",
            background: color,
            borderRadius: 999,
            transition: "width 400ms cubic-bezier(.22,1,.36,1)",
          }}
        />
      </div>
      <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-secondary)", width: 26, textAlign: "right" }}>
        {score.toFixed(1)}
      </span>
    </div>
  );
}

/* ── thumbnail ────────────────────────────────────────────────────────────── */

function ObsThumb({ obs }: { obs: ObsListRow }) {
  const [err, setErr] = useState(false);
  const src = obs.thumbnailPath
    ? `/api/media?path=${encodeURIComponent(obs.thumbnailPath)}`
    : null;

  if (!src || err) {
    return (
      <div
        style={{
          width: "100%",
          aspectRatio: "9/16",
          background: "var(--bg-surface)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          borderRadius: "var(--radius-sm)",
          fontSize: 28,
          color: "var(--text-muted)",
        }}
      >
        <Eye size={28} strokeWidth={1.2} />
      </div>
    );
  }

  return (
    <div style={{ width: "100%", aspectRatio: "9/16", position: "relative", borderRadius: "var(--radius-sm)", overflow: "hidden", background: "#000" }}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt={obs.title ?? obs.creator?.handle ?? "thumbnail"}
        onError={() => setErr(true)}
        style={{ width: "100%", height: "100%", objectFit: "cover" }}
      />
    </div>
  );
}

/* ── observation card ─────────────────────────────────────────────────────── */

function ObsCard({ obs }: { obs: ObsListRow }) {
  const summary = obs.analysis?.visualLanguage ?? obs.analysis?.tone ?? "";

  return (
    <Link
      href={`/creative-lab/${obs.id}`}
      style={{
        display: "flex",
        flexDirection: "column",
        background: "var(--bg-card)",
        border: "1px solid var(--border-subtle)",
        borderRadius: "var(--radius)",
        overflow: "hidden",
        transition: "border-color 140ms",
        textDecoration: "none",
        color: "inherit",
      }}
      className="obs-card"
    >
      {/* thumbnail */}
      <div style={{ padding: "10px 10px 0" }}>
        <ObsThumb obs={obs} />
      </div>

      {/* body */}
      <div style={{ padding: "10px 12px 12px", display: "flex", flexDirection: "column", gap: 7, flex: 1 }}>
        {/* platform + handle row */}
        <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
          <PlatformBadge platform={obs.platform} />
          {obs.creator?.handle && (
            <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-muted)" }}>
              @{obs.creator.handle}
            </span>
          )}
        </div>

        {/* title */}
        {obs.title && (
          <div style={{ fontSize: 12.5, fontWeight: 580, color: "var(--text-light)", lineHeight: 1.35, overflow: "hidden", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" }}>
            {obs.title}
          </div>
        )}

        {/* metrics */}
        <div style={{ display: "flex", gap: 10, fontSize: 11, fontFamily: "var(--font-mono)", color: "var(--text-muted)" }}>
          {obs.metrics?.likes != null && (
            <span title="Likes">♥ {fmtNum(obs.metrics.likes)}</span>
          )}
          {obs.metrics?.views != null && (
            <span title="Views">▶ {fmtNum(obs.metrics.views)}</span>
          )}
          {obs.createdAt && (
            <span style={{ marginLeft: "auto" }}>{fmtAge(obs.createdAt)}</span>
          )}
        </div>

        {/* inspiration score */}
        <InspirationBar score={obs.analysis?.inspirationScore} />

        {/* visual language snippet */}
        {summary && (
          <p
            style={{
              fontSize: 11.5,
              color: "var(--text-secondary)",
              lineHeight: 1.45,
              margin: 0,
              overflow: "hidden",
              display: "-webkit-box",
              WebkitLineClamp: 2,
              WebkitBoxOrient: "vertical",
            }}
          >
            {summary}
          </p>
        )}

        {/* tags */}
        {obs.tags.length > 0 && (
          <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
            {obs.tags.slice(0, 4).map((t) => (
              <span
                key={t}
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: 10,
                  color: "var(--text-muted)",
                  background: "var(--bg-surface)",
                  border: "1px solid var(--border-subtle)",
                  borderRadius: 5,
                  padding: "2px 7px",
                }}
              >
                {t}
              </span>
            ))}
          </div>
        )}

        {/* cta */}
        <div
          style={{
            marginTop: "auto",
            paddingTop: 6,
            fontSize: 11,
            fontFamily: "var(--font-mono)",
            color: "var(--text-muted)",
            letterSpacing: "0.04em",
            textTransform: "uppercase" as const,
          }}
        >
          View details →
        </div>
      </div>
    </Link>
  );
}

/* ── scan bar ─────────────────────────────────────────────────────────────── */

function ScanBar({ onScanned }: { onScanned: (id: string) => void }) {
  const router = useRouter();
  const [url, setUrl] = useState("");
  const [scanning, setScanning] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const submit = useCallback(async () => {
    const trimmed = url.trim();
    if (!trimmed) return;
    setErr(null);
    setScanning(true);
    try {
      const r = await fetch("/api/scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: trimmed }),
      });
      const j = (await r.json()) as { id?: string; error?: string };
      if (!r.ok || !j.id) {
        setErr(j.error ?? "Scan failed — check the URL and try again.");
        return;
      }
      setUrl("");
      onScanned(j.id);
      router.push(`/creative-lab/${j.id}`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Network error");
    } finally {
      setScanning(false);
    }
  }, [url, onScanned, router]);

  return (
    <div style={{ marginBottom: 32 }}>
      <div
        style={{
          display: "flex",
          gap: 8,
          background: "var(--bg-elevated)",
          border: "1px solid var(--border-interactive)",
          borderRadius: "var(--radius)",
          padding: "6px 6px 6px 14px",
          alignItems: "center",
          transition: "border-color 140ms",
        }}
      >
        <ScanLine size={16} color="var(--text-muted)" style={{ flexShrink: 0 }} />
        <input
          ref={inputRef}
          value={url}
          onChange={(e) => { setUrl(e.target.value); setErr(null); }}
          onKeyDown={(e) => e.key === "Enter" && !scanning && submit()}
          placeholder="Paste an Instagram, YouTube, or TikTok URL to scan…"
          style={{
            flex: 1,
            background: "none",
            border: "none",
            outline: "none",
            color: "var(--text-primary)",
            fontFamily: "var(--font-body)",
            fontSize: 14,
            padding: "4px 0",
          }}
          disabled={scanning}
        />
        <button
          onClick={submit}
          disabled={scanning || !url.trim()}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 7,
            padding: "9px 18px",
            borderRadius: 9,
            border: "none",
            background: "var(--accent)",
            color: "#0a0a0a",
            fontWeight: 600,
            fontSize: 13,
            cursor: scanning || !url.trim() ? "not-allowed" : "pointer",
            opacity: scanning || !url.trim() ? 0.5 : 1,
            transition: "opacity 120ms",
            flexShrink: 0,
          }}
        >
          {scanning ? (
            <Loader2 size={14} style={{ animation: "spin 0.8s linear infinite" }} />
          ) : (
            <Search size={14} />
          )}
          {scanning ? "Scanning…" : "Scan"}
        </button>
      </div>
      {err && (
        <p style={{ fontSize: 12.5, color: "var(--error)", margin: "8px 0 0", paddingLeft: 4 }}>
          {err}
        </p>
      )}
    </div>
  );
}

/* ── filter pills ─────────────────────────────────────────────────────────── */

const PLATFORMS = [
  { id: "", label: "All" },
  { id: "instagram", label: "Instagram" },
  { id: "youtube", label: "YouTube" },
  { id: "tiktok", label: "TikTok" },
];

const SORTS = [
  { id: "newest", label: "Newest" },
  { id: "score", label: "Highest score" },
  { id: "likes", label: "Most likes" },
];

function FilterBar({
  platform, setPlat,
  sort, setSort,
}: {
  platform: string; setPlat: (v: string) => void;
  sort: string; setSort: (v: string) => void;
}) {
  return (
    <div style={{ display: "flex", gap: 16, marginBottom: 24, flexWrap: "wrap", alignItems: "center" }}>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {PLATFORMS.map((p) => (
          <button
            key={p.id || "all"}
            onClick={() => setPlat(p.id)}
            className={`chan-tab${platform === p.id ? " on" : ""}`}
          >
            {p.label}
          </button>
        ))}
      </div>
      <div style={{ height: 22, width: 1, background: "var(--border-subtle)", flexShrink: 0 }} />
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {SORTS.map((s) => (
          <button
            key={s.id}
            onClick={() => setSort(s.id)}
            className={`chan-tab${sort === s.id ? " on" : ""}`}
          >
            {s.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/* ── main hub ─────────────────────────────────────────────────────────────── */

export function CreativeLab({ initialObs }: { initialObs: ObsListRow[] }) {
  const [obs, setObs] = useState<ObsListRow[]>(initialObs);
  const [platform, setPlat] = useState("");
  const [sort, setSort] = useState("newest");
  const [scanning] = useState(false);

  /* Re-fetch when filters change. */
  useEffect(() => {
    let cancelled = false;
    const qs = new URLSearchParams();
    if (platform) qs.set("platform", platform);
    if (sort) qs.set("sort", sort);
    fetch(`/api/observations?${qs.toString()}`, { cache: "no-store" })
      .then((r) => r.json())
      .then((j: { observations?: ObsListRow[] }) => {
        if (!cancelled && Array.isArray(j.observations)) setObs(j.observations);
      })
      .catch(() => {/* transient */});
    return () => { cancelled = true; };
  }, [platform, sort]);

  /* Auto-refresh while a scan is in progress (30s heartbeat). */
  useEffect(() => {
    const iv = setInterval(() => {
      const qs = new URLSearchParams();
      if (platform) qs.set("platform", platform);
      if (sort) qs.set("sort", sort);
      fetch(`/api/observations?${qs.toString()}`, { cache: "no-store" })
        .then((r) => r.json())
        .then((j: { observations?: ObsListRow[] }) => {
          if (Array.isArray(j.observations)) setObs(j.observations);
        })
        .catch(() => {/* transient */});
    }, 30_000);
    return () => clearInterval(iv);
  }, [platform, sort]);

  const onScanned = useCallback((_id: string) => {
    // After scan starts, refresh the list in a few seconds once analysis lands
    setTimeout(() => {
      const qs = new URLSearchParams();
      if (platform) qs.set("platform", platform);
      if (sort) qs.set("sort", sort);
      fetch(`/api/observations?${qs.toString()}`, { cache: "no-store" })
        .then((r) => r.json())
        .then((j: { observations?: ObsListRow[] }) => {
          if (Array.isArray(j.observations)) setObs(j.observations);
        })
        .catch(() => {});
    }, 6_000);
  }, [platform, sort]);

  const filtered = obs;

  return (
    <>
      <ScanBar onScanned={onScanned} />
      <FilterBar platform={platform} setPlat={setPlat} sort={sort} setSort={setSort} />

      {scanning && (
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "14px 18px", background: "var(--bg-surface)", border: "1px solid var(--border-subtle)", borderRadius: "var(--radius)", marginBottom: 24 }}>
          <Loader2 size={15} style={{ animation: "spin 0.8s linear infinite", color: "var(--text-muted)" }} />
          <span style={{ fontSize: 13, color: "var(--text-secondary)" }}>Scanning content — this takes ~30s. The card will appear when the analysis finishes.</span>
        </div>
      )}

      {filtered.length === 0 ? (
        <div className="empty" style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 14, paddingTop: 80 }}>
          <Eye size={40} strokeWidth={1} color="var(--text-muted)" />
          <div style={{ fontSize: 15, color: "var(--text-muted)" }}>
            No observations yet — paste a URL above to scan your first piece of content.
          </div>
          <div style={{ fontSize: 12.5, color: "var(--text-muted)", fontFamily: "var(--font-mono)", letterSpacing: "0.04em" }}>
            Supports Instagram reels, YouTube Shorts, and TikTok videos
          </div>
        </div>
      ) : (
        <>
          <div style={{ fontSize: 11.5, fontFamily: "var(--font-mono)", color: "var(--text-muted)", marginBottom: 14, letterSpacing: "0.04em" }}>
            {filtered.length} observation{filtered.length !== 1 ? "s" : ""}
          </div>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))",
              gap: 16,
            }}
          >
            {filtered.map((o) => (
              <ObsCard key={o.id} obs={o} />
            ))}
          </div>
        </>
      )}

      <style>{`
        .obs-card:hover { border-color: var(--border-interactive) !important; }
        @keyframes spin { to { transform: rotate(360deg); } }
        @media (max-width: 900px) {
          .obs-grid { grid-template-columns: repeat(2, 1fr) !important; }
        }
        @media (max-width: 560px) {
          .obs-grid { grid-template-columns: 1fr !important; }
        }
      `}</style>
    </>
  );
}

/* ── stats row (shown in the page header) ─────────────────────────────────── */

export function ObsStats({ obs }: { obs: ObsListRow[] }) {
  const byPlat = obs.reduce<Record<string, number>>((acc, o) => {
    acc[o.platform] = (acc[o.platform] ?? 0) + 1;
    return acc;
  }, {});

  const parts = Object.entries(byPlat).map(([p, n]) => `${n} ${p}`);
  const avgScore =
    obs.length > 0
      ? (obs.reduce((s, o) => s + (o.analysis?.inspirationScore ?? 0), 0) / obs.length).toFixed(1)
      : null;

  return (
    <div className="sub" style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
      <span>{obs.length} scanned</span>
      {parts.length > 0 && (
        <>
          <span style={{ color: "var(--text-muted)" }}>·</span>
          <span>{parts.join(" · ")}</span>
        </>
      )}
      {avgScore && (
        <>
          <span style={{ color: "var(--text-muted)" }}>·</span>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
            <TrendingUp size={12} strokeWidth={2} />
            avg score {avgScore}
          </span>
        </>
      )}
    </div>
  );
}

export { Tag };
