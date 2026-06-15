"use client";

import Link from "next/link";
import { useCallback, useState } from "react";
import { Dna } from "lucide-react";
import { BrandWizard } from "./BrandWizard";
import { confirmDialog } from "../confirm";

type Usage = { plan: { id: string; name: string }; count: number; limit: number; atLimit: boolean };

/* Brand logos are stored as paths relative to the Remotion public/ dir (e.g.
   "logos/foo.png") because that's what the render engine consumes. In the
   dashboard, that dir is served under /rem (public/rem -> packages/remotion/
   public). A bare relative path would resolve against the current route
   (/channels/logos/…) and 404, so map relative paths onto /rem here. Absolute
   URLs and already-rooted paths are passed through untouched. */
function logoSrc(logo?: string): string | undefined {
  if (!logo) return undefined;
  if (/^(https?:)?\/\//.test(logo) || logo.startsWith("/")) return logo;
  return `/rem/${logo}`;
}

export function BrandManager({ initialBrands, initialUsage, canManage = true }: { initialBrands: any[]; initialUsage: Usage; canManage?: boolean }) {
  const [brands, setBrands] = useState<any[]>(initialBrands);
  const [usage, setUsage] = useState<Usage>(initialUsage);
  const [wizard, setWizard] = useState<{ mode: "create" | "edit"; initial?: any } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const r = await fetch("/api/brands");
    if (r.ok) {
      const j = await r.json();
      setBrands(j.brands);
      setUsage(j.usage);
    }
  }, []);

  async function remove(id: string, name: string) {
    if (!(await confirmDialog({ title: `Delete the "${name}" brand?`, message: "Generated videos stay, but you can't make new ones for it.", confirmText: "Delete brand", danger: true }))) return;
    setBusy(id);
    try {
      await fetch(`/api/brands/${id}`, { method: "DELETE" });
      await refresh();
    } finally {
      setBusy(null);
    }
  }

  const pct = usage.limit > 0 ? Math.min(100, (usage.count / usage.limit) * 100) : 0;

  return (
    <>
      <div className="page-head" style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", gap: 20, flexWrap: "wrap" }}>
        <div>
          <div className="eyebrow">// manage</div>
          <h1 className="h1">Brands</h1>
          <div className="sub">Each brand is a full DNA — voice, look, typeface, moods — the generator renders against.</div>
        </div>
        <div className="brand-quota">
          <div className="brand-quota-top">
            <span className="brand-quota-count">{usage.count}{Number.isFinite(usage.limit) ? <span className="brand-quota-lim"> / {usage.limit}</span> : <span className="brand-quota-lim"> brands</span>}</span>
            <span className="brand-quota-plan">{Number.isFinite(usage.limit) ? `${usage.plan.name} plan` : "unlimited"}</span>
          </div>
          {Number.isFinite(usage.limit) && <div className="brand-quota-bar"><div className="brand-quota-fill" style={{ width: `${pct}%` }} /></div>}
          {canManage ? (
            <button className="bw-btn primary" style={{ marginTop: 10, width: "100%" }} onClick={() => setWizard({ mode: "create" })}>+ New brand</button>
          ) : (
            <div className="brand-quota-upsell" style={{ marginTop: 10 }}>View only — ask an admin to add brands.</div>
          )}
        </div>
      </div>

      {brands.length === 0 ? (
        <div className="empty">No brands yet. Create your first one.</div>
      ) : (
        <div className="grid cols-2">
          {brands.map((b) => (
            <div className="card brand-card" key={b.id}>
              <div className="brand-card-head">
                {b.logo ? (
                  <img className="brand-logo-img" src={logoSrc(b.logo)} alt="" onError={(e) => ((e.target as HTMLImageElement).style.display = "none")} />
                ) : (
                  <span className="brand-dot" style={{ background: b.accent ?? "#888", boxShadow: `0 0 14px ${b.accent ?? "#888"}` }} />
                )}
                <div style={{ minWidth: 0 }}>
                  <div className="brand-name">{b.name}</div>
                  {b.slogan && <div className="brand-slogan">{b.slogan}</div>}
                </div>
                <span className="badge b-neutral" style={{ marginLeft: "auto" }}><span className="d" style={{ background: b.accent ?? "#888" }} />{b.theme}</span>
              </div>
              <div className="kv"><span className="kv-k">audience</span><span className="kv-v brand-clip">{b.audience}</span></div>
              <div className="kv"><span className="kv-k">tone</span><span className="kv-v brand-clip">{b.tone}</span></div>
              {b.archetype && <div className="kv"><span className="kv-k">archetype</span><span className="kv-v brand-clip">{b.archetype}</span></div>}
              <div style={{ marginTop: 12, display: "flex", flexWrap: "wrap", gap: 6 }}>
                {(b.moods ?? []).map((m: any) => <span className="tag" key={typeof m === "string" ? m : m.id}>{typeof m === "string" ? m : m.id}</span>)}
              </div>
              <div className="brand-card-foot">
                <Link
                  href={`/channels/${b.id}/dna`}
                  className="bw-btn ghost sm"
                  style={{ display: "inline-flex", alignItems: "center", gap: 6, textDecoration: "none" }}
                  title="The brand's living genome — learned traits, playbooks, evolution"
                >
                  <Dna size={13} />
                  Genome
                </Link>
                {canManage && (
                  <>
                    <button className="bw-btn ghost sm" onClick={() => setWizard({ mode: "edit", initial: b })}>Edit</button>
                    <button className="bw-btn danger sm" disabled={busy === b.id} onClick={() => remove(b.id, b.name)}>{busy === b.id ? "…" : "Delete"}</button>
                  </>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {wizard && (
        <BrandWizard
          mode={wizard.mode}
          initial={wizard.initial}
          onClose={() => setWizard(null)}
          onSaved={async () => {
            await refresh();
            setWizard(null);
          }}
        />
      )}
    </>
  );
}
