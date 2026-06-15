"use client";
import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { Select } from "../Select";

export type CatalogModel = {
  value: string; routeProvider: string; id: string; name: string; family: string;
  context: number; pricePromptM?: number; priceCompletionM?: number; free: boolean;
  vision: boolean; rating?: number; created?: number; direct: boolean; available: boolean;
};

const SORTS = [
  { value: "rating", label: "Top rated" },
  { value: "newest", label: "Newest" },
  { value: "context", label: "Largest context" },
  { value: "price", label: "Cheapest" },
  { value: "name", label: "Name A→Z" },
];

const fmtCtx = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(n % 1_000_000 ? 1 : 0)}M` : n >= 1000 ? `${Math.round(n / 1000)}K` : n ? String(n) : "");
const fmtPrice = (m?: number) => (m == null ? "" : m === 0 ? "free" : m < 1 ? `$${m.toFixed(2)}/M` : `$${m.toFixed(m < 10 ? 1 : 0)}/M`);

export function ModelPickerDialog({
  open, value, models, families, openrouterConnected, onPick, onClose,
}: {
  open: boolean; value: string; models: CatalogModel[]; families: string[];
  openrouterConnected: boolean; onPick: (v: string) => void; onClose: () => void;
}) {
  const [q, setQ] = useState("");
  const [fam, setFam] = useState("all");
  const [sort, setSort] = useState("rating");
  const [vis, setVis] = useState(false);
  const [freeOnly, setFreeOnly] = useState(false);
  const [availOnly, setAvailOnly] = useState(true);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => { document.removeEventListener("keydown", onKey); document.body.style.overflow = ""; };
  }, [open, onClose]);

  const famCounts = useMemo(() => {
    const c = new Map<string, number>();
    for (const m of models) if (!availOnly || m.available) c.set(m.family, (c.get(m.family) ?? 0) + 1);
    return c;
  }, [models, availOnly]);

  const filtered = useMemo(() => {
    const n = q.trim().toLowerCase();
    const xs = models.filter((m) => {
      if (availOnly && !m.available) return false;
      if (fam !== "all" && m.family !== fam) return false;
      if (vis && !m.vision) return false;
      if (freeOnly && !m.free) return false;
      if (n && !(m.name.toLowerCase().includes(n) || m.id.toLowerCase().includes(n) || m.family.includes(n))) return false;
      return true;
    });
    xs.sort((a, b) => {
      if (sort === "rating") return (b.rating ?? -1) - (a.rating ?? -1) || (b.context - a.context);
      if (sort === "newest") return (b.created ?? 0) - (a.created ?? 0);
      if (sort === "context") return b.context - a.context;
      if (sort === "price") return (a.pricePromptM ?? 1e9) - (b.pricePromptM ?? 1e9);
      return a.name.localeCompare(b.name);
    });
    return xs;
  }, [models, q, fam, sort, vis, freeOnly, availOnly]);

  if (!open || typeof document === "undefined") return null;

  const famOptions = [{ value: "all", label: `All families (${famCounts.size})` }, ...families.filter((f) => famCounts.has(f)).map((f) => ({ value: f, label: `${f} (${famCounts.get(f)})` }))];

  return createPortal(
    <div className="mpd-overlay" onClick={onClose}>
      <div className="mpd" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Choose a model">
        <div className="mpd-head">
          <div className="mpd-search">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" className="mpd-search-ico"><circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="2" /><path d="m20 20-3.5-3.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>
            <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search 300+ models — name, family, or slug" spellCheck={false} />
          </div>
          <button className="mpd-close" type="button" onClick={onClose} aria-label="Close">✕</button>
        </div>

        <div className="mpd-toolbar">
          <Select value={fam} onChange={setFam} width={190} ariaLabel="Family" options={famOptions} />
          <Select value={sort} onChange={setSort} width={160} ariaLabel="Sort" options={SORTS} />
          <button type="button" className={`mpd-chip${vis ? " on" : ""}`} onClick={() => setVis((v) => !v)}>Vision</button>
          <button type="button" className={`mpd-chip${freeOnly ? " on" : ""}`} onClick={() => setFreeOnly((v) => !v)}>Free</button>
          <button type="button" className={`mpd-chip${availOnly ? " on" : ""}`} onClick={() => setAvailOnly((v) => !v)} title="Only models whose provider is connected">Connected</button>
          <span className="mpd-count">{filtered.length} models</span>
        </div>

        {!openrouterConnected && (
          <div className="mpd-banner">Connect <b>OpenRouter</b> in Providers to enable the full catalog (one key, every model). Native-provider models you've connected are usable now.</div>
        )}

        <div className="mpd-list">
          <button type="button" className={`mpd-row mpd-default${!value ? " on" : ""}`} onClick={() => onPick("")}>
            <span className="mpd-name">Default model <span className="mpd-sub">(the task's default tier)</span></span>
            {!value && <span className="mpd-tick">✓</span>}
          </button>
          {filtered.map((m) => (
            <button key={m.value} type="button" className={`mpd-row${m.value === value ? " on" : ""}${!m.available ? " off" : ""}`} onClick={() => m.available && onPick(m.value)} disabled={!m.available} title={!m.available ? `Connect ${m.routeProvider} to use this` : m.id}>
              <span className="mpd-rt">{m.rating != null ? <span className="mpd-rate" title="community score">★ {m.rating.toFixed(1)}</span> : <span className="mpd-rate dim">—</span>}</span>
              <span className="mpd-name">
                {m.name}
                <span className="mpd-tags">
                  <span className="mpd-tag fam">{m.family}</span>
                  {m.direct && <span className="mpd-tag">direct</span>}
                  {m.vision && <span className="mpd-tag">vision</span>}
                </span>
              </span>
              <span className="mpd-ctx">{fmtCtx(m.context)}</span>
              <span className="mpd-price">{fmtPrice(m.pricePromptM)}</span>
              {m.value === value && <span className="mpd-tick">✓</span>}
            </button>
          ))}
          {!filtered.length && <div className="mpd-empty">No models match. Loosen the filters, or connect more providers.</div>}
        </div>
      </div>
    </div>,
    document.body,
  );
}
