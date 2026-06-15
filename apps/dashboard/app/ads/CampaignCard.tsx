"use client";

import Link from "next/link";
import type { AdRecord } from "@os/schemas";
import { confirmDialog } from "../confirm";
import { InsightsPanel } from "./InsightsPanel";
import type { CallTool } from "./AdsClient";

/* One boost record: lifecycle chip, budget × duration, the boosted post,
   approval provenance, error surface for failed runs, insights once it has
   (or had) delivery, and the state's next action (approve / launch / pause). */

const STATUS_BADGE: Record<string, string> = {
  draft: "b-neutral",
  approved: "b-accent",
  live: "b-ok",
  paused: "b-neutral",
  completed: "b-neutral",
  failed: "b-err",
};

const fmtUsd = (n: number) => `$${n % 1 === 0 ? n.toFixed(0) : n.toFixed(2)}`;
const fmtDay = (iso?: string) => (iso ? iso.slice(0, 10) : "—");

export function CampaignCard({
  ad,
  channelName,
  itemTitle,
  canPublish,
  canCreate,
  callTool,
  onChanged,
  onError,
  onOpenGate,
}: {
  ad: AdRecord;
  channelName: string;
  itemTitle?: string;
  canPublish: boolean;
  canCreate: boolean;
  callTool: CallTool;
  onChanged: (msg: string) => void;
  onError: (msg: string) => void;
  onOpenGate: () => void;
}) {
  const total = ad.dailyBudgetUsd * ad.durationDays;

  const pause = async () => {
    const ok = await confirmDialog({
      title: "Pause this boost?",
      message: "Pauses delivery on Meta — spend stops until it is relaunched.",
      confirmText: "Pause boost",
      danger: true,
    });
    if (!ok) return;
    try {
      await callTool("ads_pause", { id: ad.id });
      onChanged("Boost paused — delivery stopped.");
    } catch (e) {
      onError(e instanceof Error ? e.message : "pause failed");
    }
  };

  return (
    <div className="card" style={{ padding: 18 }}>
      <div className="ads-row">
        <span className={`badge ${STATUS_BADGE[ad.status] ?? "b-neutral"}`}>
          <span className="d" />
          {ad.status}
        </span>
        <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text-light)" }}>{channelName}</span>
        <span className="ads-meta">{ad.id}</span>
        <span style={{ flex: 1 }} />
        {ad.status === "draft" && canPublish && (
          <button className="btn" style={{ padding: "6px 12px" }} onClick={onOpenGate} type="button">
            Review &amp; approve
          </button>
        )}
        {ad.status === "approved" && canPublish && (
          <button className="btn btn-primary" style={{ padding: "6px 12px" }} onClick={onOpenGate} type="button">
            Launch…
          </button>
        )}
        {ad.status === "live" && canCreate && (
          <button className="btn danger" style={{ padding: "6px 12px" }} onClick={pause} type="button">
            Pause
          </button>
        )}
      </div>

      <div style={{ marginTop: 12 }}>
        <Link href={`/post/${ad.itemId}`} className="row-title" style={{ textDecoration: "none", fontWeight: 600 }}>
          {itemTitle ?? ad.itemId}
        </Link>
      </div>

      <div className="ads-row" style={{ marginTop: 10 }}>
        <span className="ads-money">
          {fmtUsd(ad.dailyBudgetUsd)}/day × {ad.durationDays}d = {fmtUsd(total)}
        </span>
        <span className="ads-meta">→ {ad.targeting.countries.join(", ")}</span>
        <span className="ads-meta">{ad.objective.toLowerCase().replace(/_/g, " ")}</span>
        <span className="ads-meta">created {fmtDay(ad.createdAt)}</span>
      </div>

      {(ad.approval || ad.launchedAt || ad.pausedAt || ad.completedAt) && (
        <div className="ads-row" style={{ marginTop: 8 }}>
          {ad.approval && (
            <span className="ads-meta" style={{ color: "var(--text-secondary)" }}>
              approved by {ad.approval.approvedBy} · {fmtDay(ad.approval.approvedAt)}
            </span>
          )}
          {ad.launchedAt && <span className="ads-meta">live since {fmtDay(ad.launchedAt)}</span>}
          {ad.pausedAt && <span className="ads-meta">paused {fmtDay(ad.pausedAt)}</span>}
          {ad.completedAt && <span className="ads-meta">completed {fmtDay(ad.completedAt)}</span>}
        </div>
      )}

      {ad.status === "failed" && ad.error && (
        <div
          style={{
            marginTop: 10,
            padding: "9px 12px",
            border: "1px solid rgba(239,83,80,0.35)",
            borderRadius: 8,
            fontSize: 12.5,
            color: "var(--error)",
          }}
        >
          {ad.error}
        </div>
      )}

      {(ad.status === "live" || ad.status === "paused" || ad.status === "completed") && (
        <InsightsPanel ad={ad} callTool={callTool} />
      )}
    </div>
  );
}
