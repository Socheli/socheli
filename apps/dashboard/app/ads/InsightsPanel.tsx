"use client";

import { useState } from "react";
import type { AdInsights, AdRecord } from "@os/schemas";
import type { CallTool } from "./AdsClient";

/* Delivery snapshot for a boost. Renders the persisted AdInsights and offers a
   refresh that asks the engine (ads_status) to fetch a fresh lifetime snapshot
   from Meta — a read, so any member can use it. */

const num = (n?: number) => (typeof n === "number" ? n.toLocaleString() : "—");
const usd = (n?: number) => (typeof n === "number" ? `$${n.toFixed(2)}` : "—");
const pct = (n?: number) => (typeof n === "number" ? `${n.toFixed(2)}%` : "—");

export function InsightsPanel({ ad, callTool }: { ad: AdRecord; callTool: CallTool }) {
  const [ins, setIns] = useState<AdInsights | undefined>(ad.insights);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const refresh = async () => {
    setBusy(true);
    setErr("");
    try {
      const d = await callTool("ads_status", { id: ad.id, refresh: true });
      const next =
        (d?.insights as AdInsights | undefined) ??
        (d?.record as { insights?: AdInsights } | undefined)?.insights ??
        (d?.ad as { insights?: AdInsights } | undefined)?.insights;
      if (next) setIns(next);
      else setErr("No insights yet — Meta reports delivery with a delay.");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "status refresh failed");
    } finally {
      setBusy(false);
    }
  };

  const METRICS: { label: string; value: string }[] = [
    { label: "impressions", value: num(ins?.impressions) },
    { label: "reach", value: num(ins?.reach) },
    { label: "spend", value: usd(ins?.spendUsd) },
    { label: "clicks", value: num(ins?.clicks) },
    { label: "cpm", value: usd(ins?.cpm) },
    { label: "ctr", value: pct(ins?.ctr) },
  ];

  return (
    <div style={{ marginTop: 14, paddingTop: 12, borderTop: "1px solid var(--border-subtle)" }}>
      <div className="ads-row">
        <span className="stat-label">Insights{ins?.fetchedAt ? ` · ${ins.fetchedAt.slice(0, 16).replace("T", " ")}` : ""}</span>
        <span style={{ flex: 1 }} />
        <button className="btn" style={{ padding: "5px 11px", fontSize: 12 }} onClick={refresh} disabled={busy} type="button">
          {busy ? "Refreshing…" : "Refresh"}
        </button>
      </div>
      <div className="ads-ins">
        {METRICS.map((m) => (
          <div key={m.label}>
            <div className="ads-ins-v">{m.value}</div>
            <div className="ads-meta">{m.label}</div>
          </div>
        ))}
      </div>
      {err && <div style={{ marginTop: 8, fontSize: 12, color: "var(--text-muted)" }}>{err}</div>}
    </div>
  );
}
