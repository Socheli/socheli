"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Plug2, ListChecks, MessageSquareText, FlaskConical, BarChart3, Power } from "lucide-react";
import type { ConnectionStatus, InsightsSummary } from "../../../../lib/connections";
import type { ResponderConfig, ResponderTemplate } from "@os/schemas";
import { ConnectionPanel } from "../../components/ConnectionPanel";
import { InsightsCard } from "../../components/InsightsCard";
import { RulesEditor, type WorkingConfig } from "../../components/RulesEditor";
import { TemplatesEditor } from "../../components/TemplatesEditor";
import { TestPanel } from "../../components/TestPanel";

/* The post-setup management surface for a connected brand. Tabs over the same
   panel components the wizard uses. The Rules tab saves the working config
   (edit-class); a master ON/OFF switch (publish-class) lives in the header. */

type Tab = "connection" | "rules" | "templates" | "test" | "insights";

type Props = {
  channel: string;
  brandName: string;
  status: ConnectionStatus;
  config: ResponderConfig;
  templates: ResponderTemplate[];
  insights: InsightsSummary | null;
  canPublish: boolean;
  canEdit: boolean;
};

function toWorking(c: ResponderConfig): WorkingConfig {
  return {
    enabled: c.enabled,
    rules: c.rules,
    defaultAction: c.defaultAction,
    toneNotes: c.toneNotes ?? "",
    respectDmWindow: c.respectDmWindow,
    neverAutoSentiments: c.neverAutoSentiments,
  };
}

const TABS: { id: Tab; label: string; icon: React.ReactNode }[] = [
  { id: "connection", label: "Connection", icon: <Plug2 size={14} /> },
  { id: "rules", label: "Rules & tone", icon: <ListChecks size={14} /> },
  { id: "templates", label: "Templates", icon: <MessageSquareText size={14} /> },
  { id: "test", label: "Test", icon: <FlaskConical size={14} /> },
  { id: "insights", label: "Insights", icon: <BarChart3 size={14} /> },
];

export function ManagePanels({ channel, brandName, status, config, templates, insights, canPublish, canEdit }: Props) {
  const router = useRouter();
  const [tab, setTab] = useState<Tab>("connection");
  const [working, setWorking] = useState<WorkingConfig>(toWorking(config));
  const [enabled, setEnabled] = useState(config.enabled);
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  const flash = (kind: "ok" | "error", text: string) => {
    setNotice({ kind, text });
    setTimeout(() => setNotice(null), 4200);
  };

  async function saveConfig(nextEnabled: boolean) {
    setBusy("save");
    try {
      const payload: ResponderConfig = {
        channel,
        enabled: nextEnabled,
        rules: working.rules,
        defaultAction: working.defaultAction,
        toneNotes: working.toneNotes || undefined,
        respectDmWindow: working.respectDmWindow,
        neverAutoSentiments: working.neverAutoSentiments,
      };
      const res = await fetch("/api/responder", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "set", channel, config: payload, enabled: nextEnabled }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j?.error ?? "save failed");
      setEnabled(nextEnabled);
      flash("ok", nextEnabled ? "Saved — responder on" : "Saved");
      router.refresh();
    } catch (e) {
      flash("error", e instanceof Error ? e.message : "save failed");
    } finally {
      setBusy("");
    }
  }

  return (
    <div style={{ display: "grid", gap: 16 }}>
      {notice && (
        <div className="card" style={{ padding: "9px 14px", borderColor: notice.kind === "ok" ? "var(--success, #5fd97a)" : "var(--error, #ef5350)" }}>
          <span style={{ fontSize: 12.5, color: notice.kind === "ok" ? "var(--success, #5fd97a)" : "var(--error, #ef5350)" }}>{notice.text}</span>
        </div>
      )}

      {/* Header: tabs + master switch */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <div style={{ display: "inline-flex", gap: 6, flexWrap: "wrap" }}>
          {TABS.map((t) => (
            <button key={t.id} className={`btn ${tab === t.id ? "btn-active" : ""}`} style={{ padding: "7px 12px", fontSize: 12.5 }} onClick={() => setTab(t.id)}>
              {t.icon} {t.label}
            </button>
          ))}
        </div>
        <div style={{ marginLeft: "auto", display: "inline-flex", alignItems: "center", gap: 10 }}>
          <span style={{ fontSize: 12, color: enabled ? "var(--success, #5fd97a)" : "var(--text-muted)" }}>
            Responder {enabled ? "on" : "off"}
          </span>
          <button className={`btn ${enabled ? "" : "btn-primary"}`} style={{ padding: "7px 13px", fontSize: 12.5 }} disabled={!canPublish || busy === "save"} title={canPublish ? "" : "Requires the publish permission"}
            onClick={() => saveConfig(!enabled)}>
            <Power size={14} /> {enabled ? "Turn off" : "Turn on"}
          </button>
        </div>
      </div>

      {tab === "connection" && <ConnectionPanel channel={channel} status={status} canPublish={canPublish} onChanged={() => router.refresh()} />}

      {tab === "rules" && (
        <div style={{ display: "grid", gap: 14 }}>
          <RulesEditor config={working} templates={templates} onChange={setWorking} disabled={!canEdit} />
          <div>
            <button className="btn btn-primary" style={{ padding: "8px 14px" }} disabled={!canEdit || busy === "save"} onClick={() => saveConfig(enabled)}>
              {busy === "save" ? "Saving…" : "Save rules & tone"}
            </button>
          </div>
        </div>
      )}

      {tab === "templates" && <TemplatesEditor channel={channel} templates={templates} canEdit={canEdit} />}

      {tab === "test" && <TestPanel channel={channel} canTest={canEdit} />}

      {tab === "insights" && <InsightsCard channel={channel} insights={insights} canPublish={canPublish} />}
    </div>
  );
}
