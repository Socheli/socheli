"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { BarChart3, RefreshCw, Users, Eye, Activity } from "lucide-react";
import type { InsightsSummary } from "../../../lib/connections";

/* Account-level insights scorecard for one brand. Reads the latest stored
   snapshot (passed from the server) and offers a live pull (insights_pull) for
   anyone who can publish — the pull touches the live token, so it's gated. */

type Props = {
  channel: string;
  insights: InsightsSummary | null;
  canPublish: boolean;
};

function fmt(n?: number): string {
  if (n === undefined || n === null) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export function InsightsCard({ channel, insights, canPublish }: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function pull() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/connections", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "insights_pull" as never, channel, period: "day" }),
      });
      // insights_pull is a publish-class read on the live account; the route
      // forwards it through connect-tool gating. If it isn't wired as an
      // action there yet, the route returns a clear error we surface.
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j?.error ?? "pull failed");
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "pull failed");
    } finally {
      setBusy(false);
    }
  }

  const stats: { icon: React.ReactNode; label: string; value: string }[] = [
    { icon: <Users size={14} />, label: "Followers", value: fmt(insights?.followers) },
    { icon: <Eye size={14} />, label: "Reach", value: fmt(insights?.reach) },
    { icon: <Activity size={14} />, label: "Engaged", value: fmt(insights?.accountsEngaged) },
    { icon: <BarChart3 size={14} />, label: "Interactions", value: fmt(insights?.totalInteractions) },
  ];

  return (
    <div className="card" style={{ display: "grid", gap: 12 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div className="eyebrow">// insights</div>
        <button className="btn" style={{ padding: "6px 11px", fontSize: 12 }} disabled={!canPublish || busy} title={canPublish ? "" : "Requires the publish permission"} onClick={pull}>
          <RefreshCw size={13} /> {busy ? "Pulling…" : "Pull"}
        </button>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(110px, 1fr))", gap: 12 }}>
        {stats.map((s) => (
          <div key={s.label} style={{ display: "grid", gap: 4 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11.5, color: "var(--text-muted)" }}>{s.icon} {s.label}</div>
            <div style={{ fontSize: 22, fontWeight: 600, color: "var(--text-primary)" }}>{s.value}</div>
          </div>
        ))}
      </div>
      <div style={{ fontSize: 11.5, color: "var(--text-muted)" }}>
        {insights?.capturedAt ? `Snapshot ${new Date(insights.capturedAt).toLocaleString()}` : "No snapshot yet — pull to capture one."}
        {error && <span style={{ color: "var(--error, #ef5350)", marginLeft: 8 }}>{error}</span>}
      </div>
    </div>
  );
}
