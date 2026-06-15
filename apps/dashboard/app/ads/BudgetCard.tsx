"use client";

import { useState } from "react";
import type { AdsGlobalConfig } from "@os/schemas";
import { confirmDialog } from "../confirm";
import type { CallTool } from "./AdsClient";

/* Budget & safety: the workspace ads kill switch (ships ON — blocking) and the
   two spend caps, held against the currently committed live daily budget.
   All mutations go through ads_budget (schedule.manage — admin only). */

const fmtUsd = (n: number) => `$${n % 1 === 0 ? n.toFixed(0) : n.toFixed(2)}`;

export function BudgetCard({
  config,
  liveDailyUsd,
  canManage,
  callTool,
  onChanged,
  onError,
}: {
  config: AdsGlobalConfig;
  liveDailyUsd: number;
  canManage: boolean;
  callTool: CallTool;
  onChanged: (msg: string) => void;
  onError: (msg: string) => void;
}) {
  const [total, setTotal] = useState(String(config.totalCapUsd));
  const [perChan, setPerChan] = useState(String(config.perChannelDailyCapUsd));
  const [busy, setBusy] = useState("");

  const toggleKill = async () => {
    const releasing = config.killSwitch; // OFF = spend becomes possible → the dangerous direction
    if (releasing) {
      const ok = await confirmDialog({
        title: "Release the ads kill switch?",
        message: "Approved boosts can then be launched and spend REAL money (still capped and confirm-gated). Engaging it again halts launches instantly.",
        confirmText: "Release kill switch",
        danger: true,
      });
      if (!ok) return;
    }
    setBusy("kill");
    try {
      await callTool("ads_budget", { action: "set", killSwitch: !config.killSwitch });
      onChanged(releasing ? "Kill switch released — launches are possible within caps." : "Kill switch ENGAGED — all ad launches blocked.");
    } catch (e) {
      onError(e instanceof Error ? e.message : "kill switch update failed");
    } finally {
      setBusy("");
    }
  };

  const saveCaps = async () => {
    const t = Number(total);
    const p = Number(perChan);
    if (!Number.isFinite(t) || t < 0 || !Number.isFinite(p) || p < 0) {
      onError("caps must be numbers ≥ 0");
      return;
    }
    setBusy("caps");
    try {
      await callTool("ads_budget", { action: "set", totalCapUsd: t, perChannelDailyCapUsd: p });
      onChanged(`Caps saved — ${fmtUsd(t)}/day total, ${fmtUsd(p)}/day per channel.`);
    } catch (e) {
      onError(e instanceof Error ? e.message : "cap update failed");
    } finally {
      setBusy("");
    }
  };

  const totalCap = config.totalCapUsd;
  const overCap = totalCap > 0 && liveDailyUsd > totalCap;

  return (
    <div className="card" style={{ borderColor: config.killSwitch ? "var(--error, #ef5350)" : undefined }}>
      <div className="ads-row">
        <div style={{ minWidth: 0 }}>
          <div className="stat-label">Budget &amp; safety</div>
          <div style={{ fontSize: 13.5, fontWeight: 600, marginTop: 8, color: config.killSwitch ? "var(--error)" : "var(--text-light)" }}>
            {config.killSwitch ? "Kill switch ON — all ad launches blocked" : "Spend gate open — launches allowed within caps"}
          </div>
          {config.killSwitch && config.killSwitchReason && (
            <div className="sub" style={{ fontSize: 11.5, marginTop: 4 }}>{config.killSwitchReason}</div>
          )}
        </div>
        <span style={{ flex: 1 }} />
        {canManage ? (
          <button
            className={config.killSwitch ? "btn ads-kill-on" : "btn danger"}
            onClick={toggleKill}
            disabled={busy === "kill"}
            type="button"
          >
            {config.killSwitch ? "Release kill switch" : "Engage kill switch"}
          </button>
        ) : (
          <span className="sub" style={{ fontSize: 11.5 }}>Read-only — kill switch &amp; caps need admin (schedule.manage).</span>
        )}
      </div>

      <div className="ads-row" style={{ marginTop: 16 }}>
        <span className="ads-money" style={{ color: overCap ? "var(--error)" : undefined }}>
          Committed live spend: {fmtUsd(liveDailyUsd)}/day
        </span>
        <span className="ads-meta">
          caps: {fmtUsd(config.totalCapUsd)}/day total · {fmtUsd(config.perChannelDailyCapUsd)}/day per channel
          {config.totalCapUsd <= 0 ? " (0 = nothing can launch)" : ""}
        </span>
      </div>

      {canManage && (
        <div className="ads-row" style={{ marginTop: 14, alignItems: "flex-end" }}>
          <label>
            <span className="stat-label" style={{ display: "block", marginBottom: 6 }}>Total cap (USD/day)</span>
            <input className="input" style={{ width: 150 }} type="number" min={0} step={1} value={total} onChange={(e) => setTotal(e.target.value)} />
          </label>
          <label>
            <span className="stat-label" style={{ display: "block", marginBottom: 6 }}>Per-channel cap (USD/day)</span>
            <input className="input" style={{ width: 150 }} type="number" min={0} step={1} value={perChan} onChange={(e) => setPerChan(e.target.value)} />
          </label>
          <button className="btn" onClick={saveCaps} disabled={busy === "caps"} type="button">
            {busy === "caps" ? "Saving…" : "Save caps"}
          </button>
        </div>
      )}
    </div>
  );
}
