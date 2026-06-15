"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Check, ChevronLeft, ChevronRight, Power } from "lucide-react";
import type { ConnectionStatus } from "../../../../lib/connections";
import type { ResponderConfig, ResponderTemplate } from "@os/schemas";
import { ConnectionPanel } from "../../components/ConnectionPanel";
import { RulesEditor, type WorkingConfig } from "../../components/RulesEditor";
import { TemplatesEditor } from "../../components/TemplatesEditor";
import { TestPanel } from "../../components/TestPanel";

/* The 6-step connection wizard:
     1 Connect   — OAuth with Meta (or paste a token)
     2 Verify    — re-check the live connection + subscribe webhooks
     3 Rules     — responder rules + brand default + tone
     4 Templates — saved canned replies
     5 Test      — dry-run the responder against the live inbox
     6 Save & enable — persist the config and flip the master switch on
   Steps are gated: you can't pass Connect until an account is connected.
   Enabling (step 6) is publish-class; rule/template/tone edits are edit-class. */

const STEPS = ["Connect", "Verify", "Rules", "Templates", "Test", "Enable"] as const;

type Props = {
  channel: string;
  brandName: string;
  initialStep: number; // 1-based; the OAuth callback returns ?step=2
  initialStatus: ConnectionStatus;
  initialConfig: ResponderConfig;
  templates: ResponderTemplate[];
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

export function ConnectWizard({ channel, brandName, initialStep, initialStatus, initialConfig, templates, canPublish, canEdit }: Props) {
  const router = useRouter();
  const [step, setStep] = useState(Math.min(Math.max(initialStep, 1), STEPS.length));
  const [config, setConfig] = useState<WorkingConfig>(toWorking(initialConfig));
  const [busy, setBusy] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [savedOk, setSavedOk] = useState(false);

  const idx = step - 1;
  const connected = initialStatus.connected;

  async function postResponder(action: string, body: Record<string, unknown>) {
    setBusy(action);
    setError(null);
    try {
      const res = await fetch("/api/responder", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, channel, ...body }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j?.error ?? "save failed");
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : "save failed");
      return false;
    } finally {
      setBusy("");
    }
  }

  // Persist the working config WITHOUT enabling (edit-class). Used when leaving
  // the Rules step so Test runs the saved config.
  async function saveConfig(enabled: boolean) {
    const payload: ResponderConfig = {
      channel,
      enabled,
      rules: config.rules,
      defaultAction: config.defaultAction,
      toneNotes: config.toneNotes || undefined,
      respectDmWindow: config.respectDmWindow,
      neverAutoSentiments: config.neverAutoSentiments,
    };
    const ok = await postResponder("set", { config: payload, enabled });
    if (ok && enabled) {
      setSavedOk(true);
      router.refresh();
    }
    return ok;
  }

  const next = async () => {
    setError(null);
    // Leaving Rules → persist so Test/Enable see the saved config.
    if (step === 3) {
      if (!(await saveConfig(false))) return;
    }
    setStep((s) => Math.min(s + 1, STEPS.length));
  };
  const prev = () => setStep((s) => Math.max(s - 1, 1));

  return (
    <div style={{ display: "grid", gap: 18 }}>
      {/* Stepper */}
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {STEPS.map((label, i) => {
          const done = i < idx;
          const active = i === idx;
          return (
            <button key={label} className={`btn ${active ? "btn-active" : ""}`} style={{ padding: "6px 11px", fontSize: 12, opacity: done || active ? 1 : 0.55 }}
              disabled={i > idx && !connected} onClick={() => setStep(i + 1)}>
              <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
                {done ? <Check size={12} /> : <span style={{ fontFamily: "var(--font-mono)" }}>{i + 1}</span>} {label}
              </span>
            </button>
          );
        })}
      </div>

      {error && <div className="card" style={{ padding: "9px 14px", fontSize: 12.5, color: "var(--error, #ef5350)", borderColor: "var(--error, #ef5350)" }}>{error}</div>}

      {/* Step body */}
      {step === 1 && (
        <div style={{ display: "grid", gap: 12 }}>
          <div className="sub">Connect {brandName}&apos;s Instagram/Facebook account. Each brand uses its own account — the responder, comments, DMs, publishing and insights all flow through this connection.</div>
          <ConnectionPanel channel={channel} status={initialStatus} canPublish={canPublish} onChanged={() => router.refresh()} />
        </div>
      )}

      {step === 2 && (
        <div style={{ display: "grid", gap: 12 }}>
          <div className="sub">Verify the live connection and subscribe to comment + message webhooks so new activity flows into your inbox automatically.</div>
          <ConnectionPanel channel={channel} status={initialStatus} canPublish={canPublish} onChanged={() => router.refresh()} />
        </div>
      )}

      {step === 3 && (
        <RulesEditor config={config} templates={templates} onChange={setConfig} disabled={!canEdit} />
      )}

      {step === 4 && (
        <TemplatesEditor channel={channel} templates={templates} canEdit={canEdit} />
      )}

      {step === 5 && (
        <TestPanel channel={channel} canTest={canEdit} />
      )}

      {step === 6 && (
        <div style={{ display: "grid", gap: 14 }}>
          <div className="sub">
            Ready to go live. Enabling turns on the responder for {brandName}: it will classify new comments and DMs and apply your rules. Your default action is{" "}
            <strong style={{ color: "var(--text-secondary)" }}>{config.defaultAction === "auto_send" ? "Auto-send" : config.defaultAction === "draft" ? "Draft for review" : "Flag only"}</strong>.
            Complaints &amp; risky messages are always flagged for you. DM auto-replies respect the 24h window.
          </div>
          <div className="card" style={{ display: "grid", gap: 10 }}>
            <div style={{ fontSize: 13 }}>
              {config.enabled || savedOk ? (
                <span style={{ color: "var(--success, #5fd97a)" }}>Responder enabled for {brandName}.</span>
              ) : (
                <span style={{ color: "var(--text-secondary)" }}>Responder is off. Enable it to start handling inbound automatically.</span>
              )}
            </div>
            <div style={{ display: "flex", gap: 10 }}>
              <button className="btn btn-primary" style={{ padding: "9px 16px" }} disabled={!canPublish || busy === "set"} title={canPublish ? "" : "Requires the publish permission"}
                onClick={() => saveConfig(true)}>
                <Power size={15} /> {busy === "set" ? "Enabling…" : "Save & enable responder"}
              </button>
              <button className="btn" style={{ padding: "9px 16px" }} disabled={!canEdit || busy === "set"} onClick={() => saveConfig(false)}>
                Save without enabling
              </button>
            </div>
            {!canPublish && <div style={{ fontSize: 11.5, color: "var(--text-muted)" }}>You can configure and test, but enabling the live responder needs the publish permission.</div>}
          </div>
        </div>
      )}

      {/* Footer nav */}
      <div style={{ display: "flex", justifyContent: "space-between", borderTop: "1px solid var(--border-subtle)", paddingTop: 14 }}>
        <button className="btn" style={{ padding: "8px 14px" }} disabled={step === 1} onClick={prev}><ChevronLeft size={14} /> Back</button>
        {step < STEPS.length ? (
          <button className="btn btn-primary" style={{ padding: "8px 14px" }} disabled={(step === 1 && !connected) || busy === "set"} onClick={next}>
            {step === 1 && !connected ? "Connect to continue" : "Next"} <ChevronRight size={14} />
          </button>
        ) : (
          <span />
        )}
      </div>
    </div>
  );
}
