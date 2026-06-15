"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { can } from "@os/schemas";
import type { AdRecord, AdsGlobalConfig, AdStatus, Role } from "@os/schemas";
import { InkDivider, InkDraw, InkIcon } from "../../components/sketch";
import { BudgetCard } from "./BudgetCard";
import { CampaignCard } from "./CampaignCard";
import { BoostWizard } from "./BoostWizard";
import { ApproveDialog } from "./ApproveDialog";

/* The /ads client shell: budget & safety card up top, then the boost list
   tabbed by lifecycle state. Mutations go through ONE helper (callTool →
   POST /api/ads) so the server-side gates are the only path; the UI merely
   hides what the caller's role can't do. */

export type BoostItem = {
  id: string;
  channel: string;
  title: string;
  publishedAt: string;
  url?: string;
  mood?: string;
};

export type CallTool = (
  tool: string,
  input: Record<string, unknown>,
  opts?: { confirm?: boolean },
) => Promise<Record<string, unknown> | undefined>;

const STATUSES: AdStatus[] = ["draft", "approved", "live", "paused", "completed", "failed"];

export function AdsClient({
  initial,
}: {
  initial: {
    ads: AdRecord[];
    config: AdsGlobalConfig;
    channels: { id: string; name: string; accent?: string }[];
    items: BoostItem[];
    liveDailyBudgetUsd: number;
    credsConfigured: boolean;
    role: Role;
  };
}) {
  const router = useRouter();
  const [tab, setTab] = useState<"all" | AdStatus>("all");
  const [wizardOpen, setWizardOpen] = useState(false);
  const [gateAd, setGateAd] = useState<AdRecord | null>(null);
  const [notice, setNotice] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  const canCreate = can(initial.role, "content.create");
  const canPublish = can(initial.role, "content.publish");
  const canManage = can(initial.role, "schedule.manage");

  const flash = (kind: "ok" | "error", text: string) => {
    setNotice({ kind, text });
    window.setTimeout(() => setNotice((n) => (n?.text === text ? null : n)), 6000);
  };

  const callTool: CallTool = async (tool, input, opts) => {
    const res = await fetch("/api/ads", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tool, input, ...(opts?.confirm ? { confirm: true } : {}) }),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
    return j.data as Record<string, unknown> | undefined;
  };

  const done = (msg: string) => {
    flash("ok", msg);
    setGateAd(null);
    setWizardOpen(false);
    router.refresh();
  };

  const counts = useMemo(() => {
    const c = {} as Record<AdStatus, number>;
    for (const s of STATUSES) c[s] = 0;
    for (const a of initial.ads) c[a.status]++;
    return c;
  }, [initial.ads]);

  const shown = tab === "all" ? initial.ads : initial.ads.filter((a) => a.status === tab);
  const channelNameOf = (id: string) => initial.channels.find((c) => c.id === id)?.name ?? id.replace(/_/g, " ");
  const itemTitleOf = (itemId: string) => initial.items.find((i) => i.id === itemId)?.title;
  const channelLiveDaily = (channel: string) =>
    initial.ads
      .filter((a) => a.status === "live" && a.channel === channel)
      .reduce((s, a) => s + a.dailyBudgetUsd, 0);

  return (
    <>
      {notice && (
        <div
          className="card"
          style={{ marginBottom: 14, padding: "10px 16px", borderColor: notice.kind === "ok" ? "var(--success, #5fd97a)" : "var(--error, #ef5350)" }}
        >
          <span style={{ fontSize: 12.5, color: notice.kind === "ok" ? "var(--success, #5fd97a)" : "var(--error, #ef5350)" }}>
            {notice.text}
          </span>
        </div>
      )}

      {!initial.credsConfigured && (
        <div className="card" style={{ marginBottom: 14, padding: "12px 16px", borderColor: "rgba(239,83,80,0.35)" }}>
          <span className="sub" style={{ fontSize: 12.5 }}>
            Meta ads credentials are not configured (<code>META_ADS_TOKEN</code> + <code>META_AD_ACCOUNT_ID</code> in{" "}
            <code>.env</code>). You can draft and approve boosts now; dry-runs and launches stay blocked until the
            credentials are set.
          </span>
        </div>
      )}

      {/* spend safety — kill switch + caps */}
      <BudgetCard
        config={initial.config}
        liveDailyUsd={initial.liveDailyBudgetUsd}
        canManage={canManage}
        callTool={callTool}
        onChanged={done}
        onError={(m) => flash("error", m)}
      />

      <div style={{ margin: "22px 0", color: "var(--text-muted)" }}>
        <InkDivider withStar />
      </div>

      {/* boost list */}
      <div className="ads-tabs">
        <button className={tab === "all" ? "chan-tab on" : "chan-tab"} onClick={() => setTab("all")} type="button">
          All {initial.ads.length ? `· ${initial.ads.length}` : ""}
        </button>
        {STATUSES.map((s) => (
          <button key={s} className={tab === s ? "chan-tab on" : "chan-tab"} onClick={() => setTab(s)} type="button">
            {s} {counts[s] ? `· ${counts[s]}` : ""}
          </button>
        ))}
        <span style={{ flex: 1 }} />
        {canCreate && (
          <button className="btn btn-primary" style={{ padding: "7px 14px" }} onClick={() => setWizardOpen(true)} type="button">
            Draft a boost
          </button>
        )}
      </div>

      {initial.ads.length === 0 ? (
        <div className="ads-empty">
          <InkDraw durationMs={1400}>
            <InkIcon name="star-rough" size={64} />
          </InkDraw>
          <div className="ads-empty-title">No boosts yet.</div>
          <div className="sub">Publish a post to Instagram, then draft a boost.</div>
          {canCreate && (
            <button className="btn" onClick={() => setWizardOpen(true)} type="button">
              Draft a boost
            </button>
          )}
        </div>
      ) : shown.length === 0 ? (
        <div className="ads-empty" style={{ padding: "32px 24px" }}>
          <div className="sub">Nothing in “{tab}”.</div>
        </div>
      ) : (
        <div className="ads-list">
          {shown.map((ad) => (
            <CampaignCard
              key={ad.id}
              ad={ad}
              channelName={channelNameOf(ad.channel)}
              itemTitle={itemTitleOf(ad.itemId)}
              canPublish={canPublish}
              canCreate={canCreate}
              callTool={callTool}
              onChanged={done}
              onError={(m) => flash("error", m)}
              onOpenGate={() => setGateAd(ad)}
            />
          ))}
        </div>
      )}

      {/* the human gate: approve, then dry-run → confirmed live launch */}
      {gateAd && (
        <ApproveDialog
          ad={gateAd}
          config={initial.config}
          liveDailyUsd={initial.liveDailyBudgetUsd}
          channelLiveDailyUsd={channelLiveDaily(gateAd.channel)}
          itemTitle={itemTitleOf(gateAd.itemId)}
          onClose={() => setGateAd(null)}
          onDone={done}
          callTool={callTool}
        />
      )}

      {/* draft wizard — never launches anything */}
      {wizardOpen && (
        <BoostWizard
          items={initial.items}
          channelNameOf={channelNameOf}
          onClose={() => setWizardOpen(false)}
          onDone={done}
          callTool={callTool}
        />
      )}
    </>
  );
}
