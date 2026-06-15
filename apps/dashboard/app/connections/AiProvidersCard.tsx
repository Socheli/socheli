"use client";

import { useState } from "react";
import { Check, ExternalLink, KeyRound, PlugZap, Trash2 } from "lucide-react";
import type { AiProviderStatus, BrainProviderId } from "../../lib/ai-providers";

type Props = {
  providers: AiProviderStatus[];
  canManage: boolean;
};

const API_KEY_PROVIDERS = new Set<BrainProviderId>(["openrouter", "anthropic", "openai"]);

export function AiProvidersCard({ providers: initial, canManage }: Props) {
  const [providers, setProviders] = useState(initial);
  const [open, setOpen] = useState<BrainProviderId | "">("");
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState("");
  const [busy, setBusy] = useState("");
  const [note, setNote] = useState("");

  async function post(body: Record<string, unknown>) {
    const r = await fetch("/api/ai-providers", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j?.error ?? "provider action failed");
    if (Array.isArray(j.providers)) setProviders(j.providers);
    return j as { url?: string };
  }

  async function save(provider: BrainProviderId) {
    setBusy(`save:${provider}`);
    setNote("");
    try {
      await post({ action: "set_key", provider, apiKey, model });
      setNote("Provider saved and selected.");
      setApiKey("");
      setModel("");
      setOpen("");
    } catch (e) {
      setNote(e instanceof Error ? e.message : "save failed");
    } finally {
      setBusy("");
    }
  }

  async function select(provider: BrainProviderId) {
    setBusy(`select:${provider}`);
    setNote("");
    try {
      await post({ action: "select", provider });
      setNote("Provider selected for future generation jobs.");
    } catch (e) {
      setNote(e instanceof Error ? e.message : "select failed");
    } finally {
      setBusy("");
    }
  }

  async function clear(provider: BrainProviderId) {
    setBusy(`clear:${provider}`);
    setNote("");
    try {
      await post({ action: "clear", provider });
      setNote("Provider credentials removed.");
    } catch (e) {
      setNote(e instanceof Error ? e.message : "remove failed");
    } finally {
      setBusy("");
    }
  }

  async function openRouterOAuth() {
    setBusy("oauth:openrouter");
    setNote("");
    try {
      const j = await post({ action: "openrouter_oauth_start", provider: "openrouter" });
      if (j.url) window.location.href = j.url;
    } catch (e) {
      setNote(e instanceof Error ? e.message : "OAuth start failed");
      setBusy("");
    }
  }

  return (
    <div className="card" style={{ marginBottom: 16, display: "grid", gap: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <PlugZap size={15} color="var(--text-secondary)" />
        <div style={{ display: "grid", gap: 2 }}>
          <span style={{ fontSize: 13.5, color: "var(--text-primary)" }}>AI providers</span>
          <span style={{ fontSize: 12, color: "var(--text-muted)" }}>Choose the brain used by generation jobs. Secrets are write-only and redacted after save.</span>
        </div>
      </div>

      <div style={{ display: "grid", gap: 10 }}>
        {providers.map((p) => (
          <div key={p.id} style={{ borderTop: "1px solid var(--border-subtle)", paddingTop: 10, display: "grid", gap: 8 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
              <div style={{ minWidth: 145 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary)" }}>{p.label}</div>
                <div style={{ fontSize: 11.5, color: "var(--text-muted)" }}>{p.source} · {p.auth}{p.keyPreview ? ` · ${p.keyPreview}` : ""}</div>
              </div>
              <span style={{ fontSize: 11, color: p.enabled ? "var(--success, #5fd97a)" : "var(--text-muted)", border: "1px solid var(--border-subtle)", borderRadius: 999, padding: "3px 8px" }}>
                {p.enabled ? "selected" : p.configured ? "available" : "not connected"}
              </span>
              {p.model && <span style={{ fontSize: 11.5, color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>{p.model}</span>}
              {p.note && <span style={{ fontSize: 11.5, color: "var(--text-muted)" }}>{p.note}</span>}
              {canManage && (
                <div style={{ marginLeft: "auto", display: "inline-flex", gap: 7, flexWrap: "wrap" }}>
                  <button className="btn" style={btnStyle} disabled={busy !== "" || !p.configured} onClick={() => select(p.id)}>Select</button>
                  {p.id === "openrouter" && (
                    <button className="btn" style={btnStyle} disabled={busy !== ""} onClick={openRouterOAuth}>
                      <ExternalLink size={13} /> OAuth
                    </button>
                  )}
                  {API_KEY_PROVIDERS.has(p.id) && (
                    <button className="btn" style={btnStyle} disabled={busy !== ""} onClick={() => setOpen(open === p.id ? "" : p.id)}>
                      <KeyRound size={13} /> API key
                    </button>
                  )}
                  {p.source === "workspace" && (
                    <button className="btn" style={btnStyle} disabled={busy !== ""} onClick={() => clear(p.id)}>
                      <Trash2 size={13} /> Remove
                    </button>
                  )}
                </div>
              )}
            </div>

            {open === p.id && canManage && (
              <div style={{ display: "grid", gap: 8 }}>
                <input value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={`${p.label} API key`} type="password" style={inputStyle} />
                <input value={model} onChange={(e) => setModel(e.target.value)} placeholder="Optional model override" style={inputStyle} />
                <div>
                  <button className="btn btn-primary" style={{ padding: "7px 13px", fontSize: 12.5 }} disabled={busy !== "" || !apiKey.trim()} onClick={() => save(p.id)}>
                    <Check size={13} /> Save and select
                  </button>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>

      <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
        OAuth availability is provider-specific: OpenRouter supports PKCE here; Claude Code and Codex use their local CLI logins, while Anthropic/OpenAI use API keys for server-side generation.
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
