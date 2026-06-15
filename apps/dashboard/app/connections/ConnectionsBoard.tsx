"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Plug2, Settings2, ShieldCheck, RefreshCw, Bell } from "lucide-react";
import type { ConnectionStatus } from "../../lib/connections";
import { StatusPill } from "./components/ConnectionPanel";

/* The connections overview — one row per brand showing live connection state,
   webhook subscription, responder on/off + default action, and quick actions.
   Connect/Configure deep-link into the wizard / manage pages. Inline
   Verify/Refresh/Subscribe are quick re-checks for an already-connected brand,
   all publish-class (disabled unless canConnect). */

export type ConnectionRow = ConnectionStatus & { brandName: string };

type Props = {
  rows: ConnectionRow[];
  canConnect: boolean;
  canEdit: boolean;
};

const ACTION_LABEL: Record<string, string> = { auto_send: "Auto-send", draft: "Draft", flag: "Flag" };

export function ConnectionsBoard({ rows, canConnect }: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  const flash = (kind: "ok" | "error", text: string) => {
    setNotice({ kind, text });
    setTimeout(() => setNotice(null), 4200);
  };

  async function act(key: string, channel: string, action: string, okMsg: string) {
    setBusy(key);
    try {
      const res = await fetch("/api/connections", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, channel }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j?.error ?? "action failed");
      flash("ok", okMsg);
      router.refresh();
    } catch (e) {
      flash("error", e instanceof Error ? e.message : "action failed");
    } finally {
      setBusy("");
    }
  }

  if (rows.length === 0) {
    return <div className="card" style={{ padding: 18, fontSize: 13, color: "var(--text-muted)" }}>No brands yet. Create a brand under Brands, then connect its account here.</div>;
  }

  return (
    <div style={{ display: "grid", gap: 14 }}>
      {notice && (
        <div className="card" style={{ padding: "9px 14px", borderColor: notice.kind === "ok" ? "var(--success, #5fd97a)" : "var(--error, #ef5350)" }}>
          <span style={{ fontSize: 12.5, color: notice.kind === "ok" ? "var(--success, #5fd97a)" : "var(--error, #ef5350)" }}>{notice.text}</span>
        </div>
      )}

      {rows.map((r) => (
        <div key={r.channel} className="card" style={{ display: "grid", gap: 12 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
            <div style={{ display: "grid", gap: 3, minWidth: 160 }}>
              <div style={{ fontSize: 14.5, fontWeight: 600, color: "var(--text-primary)" }}>{r.brandName}</div>
              <StatusPill status={r} />
            </div>
            <div style={{ display: "flex", gap: 16, fontSize: 12, color: "var(--text-muted)", flexWrap: "wrap", flex: 1 }}>
              {r.username && <span style={{ fontFamily: "var(--font-mono)" }}>@{r.username}</span>}
              <span>Webhooks {r.webhookSubscribed ? "on" : "off"}</span>
              <span>Responder {r.responderEnabled ? `on · ${ACTION_LABEL[r.defaultAction] ?? r.defaultAction}` : "off"}</span>
              {r.tokenExpiresAt && <span>expires {new Date(r.tokenExpiresAt).toLocaleDateString()}</span>}
            </div>
          </div>

          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {!r.connected || r.needsReauth ? (
              <Link href={`/connections/${encodeURIComponent(r.channel)}/setup`} className="btn btn-primary" style={{ padding: "7px 13px", fontSize: 12.5, opacity: canConnect ? 1 : 0.5, pointerEvents: canConnect ? "auto" : "none" }}>
                <Plug2 size={14} /> {r.needsReauth ? "Re-connect" : "Connect"}
              </Link>
            ) : (
              <>
                <Link href={`/connections/${encodeURIComponent(r.channel)}/manage`} className="btn" style={{ padding: "7px 13px", fontSize: 12.5 }}>
                  <Settings2 size={14} /> Configure
                </Link>
                <button className="btn" style={{ padding: "7px 13px", fontSize: 12.5 }} disabled={!canConnect || busy === `v:${r.channel}`} title={canConnect ? "" : "Requires the publish permission"} onClick={() => act(`v:${r.channel}`, r.channel, "verify", "Verified")}>
                  <ShieldCheck size={14} /> Verify
                </button>
                <button className="btn" style={{ padding: "7px 13px", fontSize: 12.5 }} disabled={!canConnect || busy === `r:${r.channel}`} title={canConnect ? "" : "Requires the publish permission"} onClick={() => act(`r:${r.channel}`, r.channel, "refresh", "Token refreshed")}>
                  <RefreshCw size={14} /> Refresh
                </button>
                {!r.webhookSubscribed && (
                  <button className="btn" style={{ padding: "7px 13px", fontSize: 12.5 }} disabled={!canConnect || busy === `s:${r.channel}`} title={canConnect ? "" : "Requires the publish permission"} onClick={() => act(`s:${r.channel}`, r.channel, "subscribe", "Subscribed")}>
                    <Bell size={14} /> Subscribe
                  </button>
                )}
              </>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
