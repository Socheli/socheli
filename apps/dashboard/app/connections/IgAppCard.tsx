"use client";

import { useEffect, useState } from "react";
import { Camera, Check } from "lucide-react";

/* Bring-Your-Own Instagram app card (Instagram Login flow). The instance
   defaults to Socheli's Instagram app; a workspace can switch to its OWN
   Instagram App ID + Secret here. These are DISTINCT from the Meta/Facebook
   app id/secret — get them from App Dashboard → Instagram → API setup with
   Instagram login. The OAuth redirect stays this instance's
   /api/connections/ig-callback (whitelist it in your app's Instagram OAuth
   redirect list). The secret is write-only: it's posted once and never read
   back (status shows source + App ID only). Self-host instances can also just
   set INSTAGRAM_APP_* in their env. */
type Status = { configured: boolean; source: "workspace" | "env" | "none"; appId: string; redirect: string; redirectConfigured: boolean };

export function IgAppCard({ canManage }: { canManage: boolean }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [open, setOpen] = useState(false);
  const [appId, setAppId] = useState("");
  const [appSecret, setAppSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");

  const load = async () => {
    const r = await fetch("/api/connections", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "ig_app_status" }) });
    const j = await r.json().catch(() => ({}));
    if (r.ok) setStatus(j.data ?? null);
  };
  useEffect(() => {
    void load();
  }, []);

  async function save() {
    if (!appId.trim() || !appSecret.trim()) return;
    setBusy(true);
    setNote("");
    try {
      const r = await fetch("/api/connections", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "ig_app_set", appId: appId.trim(), appSecret: appSecret.trim() }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j?.error ?? "failed");
      setNote("Saved — this workspace now uses your Instagram app.");
      setAppSecret("");
      setOpen(false);
      await load();
    } catch (e) {
      setNote(e instanceof Error ? e.message : "failed");
    } finally {
      setBusy(false);
    }
  }

  async function clear() {
    setBusy(true);
    try {
      await fetch("/api/connections", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "ig_app_clear" }) });
      await load();
      setNote("Reverted to the instance default Instagram app.");
    } finally {
      setBusy(false);
    }
  }

  const sourceLabel = status?.source === "workspace" ? "Your own Instagram app" : status?.source === "env" ? "Instance default app" : "No Instagram app configured";

  return (
    <div className="card" style={{ marginBottom: 16, display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <Camera size={15} color="var(--text-secondary)" />
        <div style={{ display: "flex", flexDirection: "column" }}>
          <span style={{ fontSize: 13.5, color: "var(--text-primary)" }}>Instagram app — {sourceLabel}</span>
          <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
            {status?.appId ? `App ID ${status.appId}` : "—"} · redirect {status?.redirectConfigured ? "configured" : "not set"}
          </span>
        </div>
        {canManage && (
          <div style={{ marginLeft: "auto", display: "inline-flex", gap: 8 }}>
            {status?.source === "workspace" && (
              <button className="btn" style={{ padding: "6px 12px", fontSize: 12 }} disabled={busy} onClick={clear}>
                Use instance default
              </button>
            )}
            <button className="btn" style={{ padding: "6px 12px", fontSize: 12 }} onClick={() => setOpen((o) => !o)}>
              {status?.source === "workspace" ? "Replace" : "Use your own app"}
            </button>
          </div>
        )}
      </div>

      {open && canManage && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8, borderTop: "1px solid var(--border-subtle)", paddingTop: 10 }}>
          <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
            Use your own Instagram app for the Instagram Login flow (IG Business/Creator, no Facebook Page). Get the App ID + Secret from App
            Dashboard → Instagram → API setup with Instagram login — these are DISTINCT from the Meta/Facebook app credentials. The OAuth redirect
            stays this instance&apos;s <code>/api/connections/ig-callback</code> — add it to your app&apos;s Instagram OAuth redirect list. Your secret
            is stored securely and never shown again.
          </span>
          <input value={appId} onChange={(e) => setAppId(e.target.value)} placeholder="Instagram App ID" style={inputStyle} />
          <input value={appSecret} onChange={(e) => setAppSecret(e.target.value)} placeholder="Instagram App Secret" type="password" style={inputStyle} />
          <div>
            <button className="btn btn-primary" style={{ padding: "7px 13px", fontSize: 12.5 }} disabled={busy || !appId.trim() || !appSecret.trim()} onClick={save}>
              <Check size={13} /> Save app
            </button>
          </div>
        </div>
      )}
      {note && <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>{note}</span>}
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  background: "var(--bg-surface)",
  border: "1px solid var(--border-subtle)",
  borderRadius: 7,
  color: "var(--text-primary)",
  padding: "8px 10px",
  fontSize: 13,
};
