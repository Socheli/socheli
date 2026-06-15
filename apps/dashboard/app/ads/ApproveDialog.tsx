"use client";

import { useState } from "react";
import type { AdRecord, AdsGlobalConfig } from "@os/schemas";
import { Modal } from "../Modal";
import type { CallTool } from "./AdsClient";

/* THE HUMAN GATE for real-money spend.

   draft     → budget summary + cap headroom → "Approve boost" (ads_approve).
   approved  → two-step launch: the FIRST click only runs ads_launch with
               dryRun:true and renders what came back — the engine's gate
               verdict (gate.reasons) and the exact Meta API calls it WOULD
               make (step, path, key body fields). Only then does a second,
               explicit control (acknowledge checkbox + launch button) send
               { dryRun:false } with confirm:true. The API additionally
               rejects any live launch that lacks confirm:true. */

type DryGate = { allowed?: boolean; reasons?: string[] };
type MetaCall = { step?: string; path?: string; method?: string; body?: Record<string, unknown> };

const fmtUsd = (n: number) => `$${n % 1 === 0 ? n.toFixed(0) : n.toFixed(2)}`;
const clip = (s: string, n = 90) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function parseDry(d?: Record<string, unknown>): { gate?: DryGate; calls: MetaCall[] } {
  const gate = d?.gate as DryGate | undefined;
  const raw = (d?.calls ?? d?.metaCalls ?? []) as unknown;
  return { gate, calls: Array.isArray(raw) ? (raw as MetaCall[]) : [] };
}

function CapRow({ label, cap, after }: { label: string; cap: number; after: number }) {
  const headroom = cap - after;
  const blocked = cap <= 0 || headroom < 0;
  return (
    <div className="ads-row" style={{ fontSize: 12.5 }}>
      <span style={{ color: "var(--text-secondary)" }}>{label}</span>
      <span style={{ flex: 1 }} />
      <span className="ads-money">
        {fmtUsd(after)}/day of {fmtUsd(cap)} cap
      </span>
      <span style={{ color: blocked ? "var(--error)" : "var(--success)", fontWeight: 600, fontSize: 12 }}>
        {cap <= 0 ? "cap is 0 — blocked" : headroom < 0 ? `${fmtUsd(-headroom)} over` : `${fmtUsd(headroom)} headroom`}
      </span>
    </div>
  );
}

export function ApproveDialog({
  ad,
  config,
  liveDailyUsd,
  channelLiveDailyUsd,
  itemTitle,
  onClose,
  onDone,
  callTool,
}: {
  ad: AdRecord;
  config: AdsGlobalConfig;
  liveDailyUsd: number;
  channelLiveDailyUsd: number;
  itemTitle?: string;
  onClose: () => void;
  onDone: (msg: string) => void;
  callTool: CallTool;
}) {
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const [dry, setDry] = useState<{ gate?: DryGate; calls: MetaCall[] } | null>(null);
  const [ack, setAck] = useState(false);

  const total = ad.dailyBudgetUsd * ad.durationDays;
  const launching = ad.status === "approved";

  const approve = async () => {
    setBusy("approve");
    setErr("");
    try {
      await callTool("ads_approve", { id: ad.id });
      onDone("Boost approved — launch it (dry-run first) when ready.");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "approve failed");
      setBusy("");
    }
  };

  const dryRun = async () => {
    setBusy("dry");
    setErr("");
    try {
      const d = await callTool("ads_launch", { id: ad.id, dryRun: true });
      setDry(parseDry(d));
    } catch (e) {
      setErr(e instanceof Error ? e.message : "dry-run failed");
    } finally {
      setBusy("");
    }
  };

  const goLive = async () => {
    setBusy("live");
    setErr("");
    try {
      const d = await callTool("ads_launch", { id: ad.id, dryRun: false }, { confirm: true });
      // The engine re-checks the gate even on dryRun:false — a blocked launch
      // comes back unexecuted with the blocking reasons. Surface them.
      if (d && d.executed === false) {
        setDry(parseDry(d));
        setAck(false);
        setErr("Launch blocked by the spend gate — see the reasons above.");
        setBusy("");
        return;
      }
      onDone(`Boost launched — ${fmtUsd(ad.dailyBudgetUsd)}/day is now live.`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "launch failed");
      setBusy("");
    }
  };

  const gateOk = dry?.gate ? dry.gate.allowed !== false : false;

  return (
    <Modal
      open
      onClose={onClose}
      title={launching ? "Launch boost" : "Approve boost"}
      subtitle={itemTitle ?? ad.itemId}
      width={560}
    >
      {/* budget summary — the number the human is signing off on */}
      <div className="card" style={{ padding: 16, marginBottom: 14 }}>
        <div className="stat-label">Spend commitment</div>
        <div style={{ fontSize: 22, fontWeight: 680, marginTop: 8 }}>
          {fmtUsd(ad.dailyBudgetUsd)}/day × {ad.durationDays} days = {fmtUsd(total)}
        </div>
        <div className="ads-meta" style={{ marginTop: 6 }}>
          {ad.targeting.countries.join(", ")} · {ad.objective.toLowerCase().replace(/_/g, " ")}
        </div>
        <div style={{ display: "grid", gap: 6, marginTop: 14 }}>
          <CapRow label="Workspace cap (all channels)" cap={config.totalCapUsd} after={liveDailyUsd + ad.dailyBudgetUsd} />
          <CapRow label="Channel cap" cap={config.perChannelDailyCapUsd} after={channelLiveDailyUsd + ad.dailyBudgetUsd} />
        </div>
        {config.killSwitch && (
          <div style={{ marginTop: 12, fontSize: 12.5, color: "var(--error)" }}>
            The ads kill switch is ON — launches are blocked until it is released in Budget &amp; safety.
          </div>
        )}
      </div>

      {!launching && (
        <>
          <div className="sub" style={{ fontSize: 12.5, marginBottom: 14, lineHeight: 1.55 }}>
            Approving records your sign-off on this budget. Nothing spends yet — launching is a separate, dry-run-first
            step.
          </div>
          {err && <div style={{ marginBottom: 12, fontSize: 12.5, color: "var(--error)" }}>{err}</div>}
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button className="btn" onClick={onClose} type="button">Cancel</button>
            <button className="btn btn-primary" onClick={approve} disabled={busy === "approve"} type="button">
              {busy === "approve" ? "Approving…" : "Approve boost"}
            </button>
          </div>
        </>
      )}

      {launching && (
        <>
          {!dry && (
            <>
              <div className="sub" style={{ fontSize: 12.5, marginBottom: 14, lineHeight: 1.55 }}>
                Step 1 is always a dry-run: the engine checks every spend gate and shows the exact Meta API calls it
                would make. Nothing spends on this click.
              </div>
              {err && <div style={{ marginBottom: 12, fontSize: 12.5, color: "var(--error)" }}>{err}</div>}
              <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                <button className="btn" onClick={onClose} type="button">Cancel</button>
                <button className="btn btn-primary" onClick={dryRun} disabled={busy === "dry"} type="button">
                  {busy === "dry" ? "Dry-running…" : "Dry-run launch"}
                </button>
              </div>
            </>
          )}

          {dry && (
            <>
              {/* the engine's gate verdict */}
              <div className="stat-label" style={{ marginBottom: 8 }}>Gate verdict</div>
              {dry.gate?.reasons?.length ? (
                <ul style={{ margin: "0 0 12px", paddingLeft: 18, display: "grid", gap: 4 }}>
                  {dry.gate.reasons.map((r, i) => (
                    <li key={i} style={{ fontSize: 12.5, color: gateOk ? "var(--text-secondary)" : "var(--error)" }}>{r}</li>
                  ))}
                </ul>
              ) : (
                <div style={{ marginBottom: 12, fontSize: 12.5, color: gateOk ? "var(--success)" : "var(--error)" }}>
                  {gateOk ? "All spend gates clear." : "The engine blocked this launch."}
                </div>
              )}

              {/* the exact Meta calls a live launch would make */}
              {dry.calls.length > 0 && (
                <>
                  <div className="stat-label" style={{ margin: "12px 0 8px" }}>Meta API calls (would run)</div>
                  <div style={{ display: "grid", gap: 6, marginBottom: 14 }}>
                    {dry.calls.map((c, i) => (
                      <div key={i} className="ads-call">
                        <span style={{ color: "var(--accent)", flexShrink: 0 }}>{c.step ?? `step ${i + 1}`}</span>
                        <span style={{ color: "var(--text-secondary)", flexShrink: 0 }}>{c.method ?? "POST"} {c.path ?? ""}</span>
                        <span style={{ color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {Object.entries(c.body ?? {})
                            .slice(0, 6)
                            .map(([k, v]) => `${k}=${clip(typeof v === "string" ? v : JSON.stringify(v), 40)}`)
                            .join(" · ")}
                        </span>
                      </div>
                    ))}
                  </div>
                </>
              )}

              {err && <div style={{ marginBottom: 12, fontSize: 12.5, color: "var(--error)" }}>{err}</div>}

              {/* the second, explicit confirmation — real money beyond this point */}
              <label style={{ display: "flex", alignItems: "flex-start", gap: 9, fontSize: 12.5, color: "var(--text-secondary)", marginBottom: 14, cursor: "pointer" }}>
                <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} disabled={!gateOk} style={{ marginTop: 2, accentColor: "var(--accent)" }} />
                <span>
                  I reviewed the dry-run and confirm spending {fmtUsd(ad.dailyBudgetUsd)}/day ({fmtUsd(total)} total) of
                  real money on this boost.
                </span>
              </label>
              <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                <button className="btn" onClick={onClose} type="button">Cancel</button>
                <button className="btn" onClick={dryRun} disabled={busy !== ""} type="button">Re-run dry-run</button>
                <button className="btn btn-primary" onClick={goLive} disabled={!gateOk || !ack || busy !== ""} type="button">
                  {busy === "live" ? "Launching…" : `Confirm & launch live (${fmtUsd(ad.dailyBudgetUsd)}/day)`}
                </button>
              </div>
            </>
          )}
        </>
      )}
    </Modal>
  );
}
