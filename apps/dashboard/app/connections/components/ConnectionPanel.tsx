"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Plug2, ShieldCheck, RefreshCw, Bell, Link2Off, Clipboard, Camera } from "lucide-react";
import { confirmDialog } from "../../confirm";
import type { ConnectionStatus } from "../../../lib/connections";

/* The connection control surface (reused by the wizard's Connect/Verify steps
   and the manage page). All live actions are gated to canPublish — disabled
   buttons carry a title explaining the missing permission. Every action POSTs
   to /api/connections and refreshes the server view; nothing here ever renders
   a token (the paste field POSTs once and clears). */

type Props = {
  channel: string;
  status: ConnectionStatus;
  canPublish: boolean;
  onChanged?: () => void;
};

async function post(body: Record<string, unknown>) {
  const res = await fetch("/api/connections", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j?.error ?? "action failed");
  return j?.data as Record<string, unknown> | undefined;
}

export function ConnectionPanel({ channel, status, canPublish, onChanged }: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [igUserId, setIgUserId] = useState("");
  const [token, setToken] = useState("");

  const flash = (kind: "ok" | "error", text: string) => {
    setNotice({ kind, text });
    setTimeout(() => setNotice(null), 4500);
  };

  async function act(key: string, body: Record<string, unknown>, okMsg: string, after?: (data?: Record<string, unknown>) => void) {
    setBusy(key);
    try {
      const data = await post(body);
      flash("ok", okMsg);
      after?.(data);
      onChanged?.();
      router.refresh();
    } catch (e) {
      flash("error", e instanceof Error ? e.message : "action failed");
    } finally {
      setBusy("");
    }
  }

  const startOAuth = () =>
    act("start", { action: "connect_start", channel }, "Opening Meta…", (data) => {
      const url = typeof data?.url === "string" ? data.url : undefined;
      if (url) window.location.href = url;
    });

  // Instagram-Login flow (NO Facebook Page) — distinct authorize URL + engine tool.
  const startIgOAuth = () =>
    act("start_ig", { action: "connect_ig_start", channel }, "Opening Instagram…", (data) => {
      const url = typeof data?.url === "string" ? data.url : undefined;
      if (url) window.location.href = url;
    });

  const pasteConnect = () => {
    if (!igUserId.trim() || !token.trim()) return;
    act("paste", { action: "connect_paste", channel, igUserId: igUserId.trim(), token: token.trim() }, "Account connected", () => {
      setToken(""); // never keep the token in client state after the POST
      setIgUserId("");
      setPasteOpen(false);
    });
  };

  const disabledTitle = canPublish ? "" : "Requires the publish permission";

  return (
    <div className="card" style={{ display: "grid", gap: 14 }}>
      {notice && (
        <div style={{ fontSize: 12.5, color: notice.kind === "ok" ? "var(--success, #5fd97a)" : "var(--error, #ef5350)" }}>{notice.text}</div>
      )}

      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <StatusPill status={status} />
        {status.username && <span style={{ fontSize: 13, fontFamily: "var(--font-mono)", color: "var(--text-secondary)" }}>@{status.username}</span>}
        {status.accountIdMasked && <span style={{ fontSize: 11.5, color: "var(--text-muted)" }}>IG {status.accountIdMasked}</span>}
      </div>

      {status.scopes.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {status.scopes.map((s) => (
            <span key={s} className="tag" style={{ margin: 0, fontSize: 11 }}>{s.replace(/^instagram_/, "")}</span>
          ))}
        </div>
      )}

      <div style={{ display: "flex", gap: 16, fontSize: 12, color: "var(--text-muted)", flexWrap: "wrap" }}>
        {status.tokenExpiresAt && <span>Token expires {new Date(status.tokenExpiresAt).toLocaleDateString()}</span>}
        <span>Webhooks {status.webhookSubscribed ? "subscribed" : "not subscribed"}</span>
        {status.lastError && <span style={{ color: "var(--error, #ef5350)" }}>Last error: {status.lastError}</span>}
      </div>

      {(!status.connected || status.needsReauth) && (
        <div style={{ fontSize: 11.5, color: "var(--text-muted)", lineHeight: 1.5 }}>
          <strong style={{ color: "var(--text-secondary)" }}>Meta</strong> connects Instagram via a Facebook Page — full features (comments, DMs,
          publishing, insights). <strong style={{ color: "var(--text-secondary)" }}>Instagram</strong> connects an IG Business/Creator account with NO
          Facebook Page — comments + DMs.
        </div>
      )}

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {!status.connected || status.needsReauth ? (
          <>
            <button className="btn btn-primary" style={{ padding: "8px 14px" }} disabled={!canPublish || busy === "start"} title={disabledTitle} onClick={startOAuth}>
              <Plug2 size={14} /> {status.needsReauth ? "Re-connect with Meta" : "Connect with Meta"}
            </button>
            <button className="btn btn-primary" style={{ padding: "8px 14px" }} disabled={!canPublish || busy === "start_ig"} title={disabledTitle} onClick={startIgOAuth}>
              <Camera size={14} /> Connect with Instagram
            </button>
            <button className="btn" style={{ padding: "8px 14px" }} disabled={!canPublish} title={disabledTitle} onClick={() => setPasteOpen((v) => !v)}>
              <Clipboard size={14} /> Paste a token
            </button>
          </>
        ) : (
          <>
            <button className="btn" style={{ padding: "8px 14px" }} disabled={!canPublish || busy === "verify"} title={disabledTitle} onClick={() => act("verify", { action: "verify", channel }, "Connection verified")}>
              <ShieldCheck size={14} /> Verify
            </button>
            <button className="btn" style={{ padding: "8px 14px" }} disabled={!canPublish || busy === "refresh"} title={disabledTitle} onClick={() => act("refresh", { action: "refresh", channel }, "Token refreshed")}>
              <RefreshCw size={14} /> Refresh token
            </button>
            {/* Webhook subscription is Page-level (subscribed_apps needs a pageId).
                Instagram-Login connections have no Page → the app subscribes the
                `instagram` object's fields at the App-Dashboard level instead, so
                hide this per-connection button for that flavor. */}
            {status.authType !== "instagram_login" && (
              <button className="btn" style={{ padding: "8px 14px" }} disabled={!canPublish || busy === "subscribe"} title={disabledTitle} onClick={() => act("subscribe", { action: "subscribe", channel }, "Subscribed to comment + message webhooks")}>
                <Bell size={14} /> {status.webhookSubscribed ? "Re-subscribe webhooks" : "Subscribe webhooks"}
              </button>
            )}
            <button className="btn danger" style={{ padding: "8px 14px" }} disabled={!canPublish || busy === "disconnect"} title={disabledTitle}
              onClick={async () => {
                if (!(await confirmDialog({ title: "Disconnect this account?", message: "Removes the stored token for this brand. Comments/DMs and publishing fall back to the global account (if set).", confirmText: "Disconnect", danger: true }))) return;
                act("disconnect", { action: "disconnect", channel }, "Account disconnected");
              }}>
              <Link2Off size={14} /> Disconnect
            </button>
          </>
        )}
      </div>

      {pasteOpen && (
        <div style={{ display: "grid", gap: 8, borderTop: "1px solid var(--border-subtle)", paddingTop: 12 }}>
          <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
            Advanced: paste an Instagram business account id and a long-lived PAGE access token. The token is sent once and never stored or shown here.
          </div>
          <input value={igUserId} onChange={(e) => setIgUserId(e.target.value)} placeholder="Instagram business account id"
            style={{ background: "var(--bg-surface)", border: "1px solid var(--border-subtle)", borderRadius: 7, color: "var(--text-primary)", padding: "8px 10px", fontSize: 13 }} />
          <input value={token} onChange={(e) => setToken(e.target.value)} placeholder="Page access token" type="password" autoComplete="off"
            style={{ background: "var(--bg-surface)", border: "1px solid var(--border-subtle)", borderRadius: 7, color: "var(--text-primary)", padding: "8px 10px", fontSize: 13, fontFamily: "var(--font-mono)" }} />
          <div>
            <button className="btn btn-primary" style={{ padding: "7px 13px", fontSize: 12.5 }} disabled={!igUserId.trim() || !token.trim() || busy === "paste"} onClick={pasteConnect}>
              Connect
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export function StatusPill({ status }: { status: ConnectionStatus }) {
  const map: Record<string, { label: string; color: string }> = {
    connected: { label: "Connected", color: "var(--success, #5fd97a)" },
    expired: { label: "Token expired", color: "var(--warning, #e6b34a)" },
    revoked: { label: "Access revoked", color: "var(--error, #ef5350)" },
    error: { label: "Error", color: "var(--error, #ef5350)" },
  };
  const key = status.connected ? "connected" : status.status ?? "disconnected";
  const m = map[key] ?? { label: "Not connected", color: "var(--text-muted)" };
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12.5, color: m.color }}>
      <span style={{ width: 7, height: 7, borderRadius: "50%", background: m.color, display: "inline-block" }} />
      {m.label}
    </span>
  );
}
