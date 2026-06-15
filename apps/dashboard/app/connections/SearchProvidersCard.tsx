"use client";

import { useState } from "react";
import { Check, ExternalLink, Globe, KeyRound, Search, Trash2 } from "lucide-react";
import type { SearchProviderId, SearchProviderStatus } from "../../lib/search-providers";

type Props = {
  providers: SearchProviderStatus[];
  canManage: boolean;
};

export function SearchProvidersCard({ providers: initial, canManage }: Props) {
  const [providers, setProviders] = useState(initial);
  const [open, setOpen] = useState<SearchProviderId | "">("");
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState("");
  const [note, setNote] = useState("");

  async function post(body: Record<string, unknown>) {
    const r = await fetch("/api/search-providers", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j?.error ?? "provider action failed");
    if (Array.isArray(j.providers)) setProviders(j.providers);
    return j;
  }

  async function save(provider: SearchProviderId) {
    setBusy(`save:${provider}`);
    setNote("");
    try {
      await post({ action: "set_key", provider, apiKey });
      setNote("Saved. The research harness will use it on its next run.");
      setApiKey("");
      setOpen("");
    } catch (e) {
      setNote(e instanceof Error ? e.message : "save failed");
    } finally {
      setBusy("");
    }
  }

  async function clear(provider: SearchProviderId) {
    setBusy(`clear:${provider}`);
    setNote("");
    try {
      await post({ action: "clear", provider });
      setNote("Key removed.");
    } catch (e) {
      setNote(e instanceof Error ? e.message : "remove failed");
    } finally {
      setBusy("");
    }
  }

  return (
    <div className="card" style={{ marginBottom: 16, display: "grid", gap: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <Search size={15} color="var(--text-secondary)" />
        <div style={{ display: "grid", gap: 2 }}>
          <span style={{ fontSize: 13.5, color: "var(--text-primary)" }}>Web search providers</span>
          <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
            Power the research harness (deep research → grounded videos). Tried top-to-bottom; the keyless scraper is the always-on fallback. Secrets are write-only and redacted after save.
          </span>
        </div>
      </div>

      <div style={{ display: "grid", gap: 10 }}>
        {providers.map((p) => (
          <div key={p.id} style={{ borderTop: "1px solid var(--border-subtle)", paddingTop: 10, display: "grid", gap: 8 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
              <div style={{ minWidth: 165 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary)", display: "inline-flex", alignItems: "center", gap: 6 }}>
                  {p.keyless && <Globe size={12} color="var(--text-muted)" />}
                  {p.label}
                </div>
                <div style={{ fontSize: 11.5, color: "var(--text-muted)" }}>
                  {p.keyless ? "no key needed" : p.source}
                  {p.keyPreview ? ` · ${p.keyPreview}` : ""}
                </div>
              </div>
              <span style={{ fontSize: 11, color: p.configured ? "var(--success, #5fd97a)" : "var(--text-muted)", border: "1px solid var(--border-subtle)", borderRadius: 999, padding: "3px 8px" }}>
                {p.keyless ? "fallback" : p.configured ? (p.source === "env" ? "env" : "connected") : "not connected"}
              </span>
              {p.note && <span style={{ fontSize: 11.5, color: "var(--text-muted)", flex: "1 1 200px" }}>{p.note}</span>}
              {canManage && !p.keyless && (
                <div style={{ marginLeft: "auto", display: "inline-flex", gap: 7, flexWrap: "wrap" }}>
                  {p.docsUrl && (
                    <a className="btn" style={btnStyle} href={p.docsUrl} target="_blank" rel="noreferrer">
                      <ExternalLink size={13} /> Get key
                    </a>
                  )}
                  <button className="btn" style={btnStyle} disabled={busy !== "" || p.source === "env"} onClick={() => setOpen(open === p.id ? "" : p.id)} title={p.source === "env" ? "Set via environment variable" : undefined}>
                    <KeyRound size={13} /> API key
                  </button>
                  {p.source === "workspace" && (
                    <button className="btn" style={btnStyle} disabled={busy !== ""} onClick={() => clear(p.id)}>
                      <Trash2 size={13} /> Remove
                    </button>
                  )}
                </div>
              )}
            </div>

            {open === p.id && canManage && !p.keyless && (
              <div style={{ display: "grid", gap: 8 }}>
                <input value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={`${p.label} API key`} type="password" style={inputStyle} />
                <div>
                  <button className="btn btn-primary" style={{ padding: "7px 13px", fontSize: 12.5 }} disabled={busy !== "" || !apiKey.trim()} onClick={() => save(p.id)}>
                    <Check size={13} /> Save key
                  </button>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>

      <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
        Set a key once and it rides the normal data sync out to every render node. An environment variable (e.g. <code>TAVILY_API_KEY</code>) always overrides a key saved here.
      </span>
      {note && <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>{note}</span>}
    </div>
  );
}

const btnStyle: React.CSSProperties = { padding: "6px 10px", fontSize: 12 };

const inputStyle: React.CSSProperties = {
  background: "var(--bg-surface)",
  border: "1px solid var(--border-subtle)",
  borderRadius: 7,
  color: "var(--text-primary)",
  padding: "8px 10px",
  fontSize: 13,
};
