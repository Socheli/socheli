"use client";

import { useState } from "react";
import { FlaskConical } from "lucide-react";
import type { ResponderDecision } from "@os/schemas";

/* The dry-run test surface. Calls responder_test (edit-class — never sends)
   against the current inbox and shows, per item, what the CURRENTLY SAVED
   config WOULD do: would_send / would_draft / would_flag (and skipped). This is
   the "verify before enabling" step of the wizard. Save your rules first — the
   test runs the persisted config, not unsaved edits. */

type Props = {
  channel: string;
  canTest: boolean;
};

const OUTCOME_STYLE: Record<string, { label: string; color: string }> = {
  would_send: { label: "Would auto-send", color: "var(--success, #5fd97a)" },
  would_draft: { label: "Would draft", color: "var(--accent, #7aa2ff)" },
  would_flag: { label: "Would flag", color: "var(--warning, #e6b34a)" },
  skipped: { label: "Skipped", color: "var(--text-muted)" },
  sent: { label: "Sent", color: "var(--success, #5fd97a)" },
  drafted: { label: "Drafted", color: "var(--accent, #7aa2ff)" },
  flagged: { label: "Flagged", color: "var(--warning, #e6b34a)" },
};

export function TestPanel({ channel, canTest }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rows, setRows] = useState<ResponderDecision[] | null>(null);

  async function run() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/responder", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "test", channel, limit: 25 }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j?.error ?? "test failed");
      const decisions = (j?.data?.decisions ?? j?.data?.results ?? []) as ResponderDecision[];
      setRows(Array.isArray(decisions) ? decisions : []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "test failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: "grid", gap: 14 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <div className="eyebrow" style={{ flex: 1 }}>Dry run — what each rule would do on the current inbox</div>
        <button className="btn btn-primary" style={{ padding: "8px 14px" }} disabled={!canTest || busy} title={canTest ? "" : "Requires the edit permission"} onClick={run}>
          <FlaskConical size={14} /> {busy ? "Running…" : "Run test"}
        </button>
      </div>
      <div style={{ fontSize: 11.5, color: "var(--text-muted)" }}>
        Nothing is sent. The test runs your <strong style={{ color: "var(--text-secondary)" }}>saved</strong> config — save rule/default changes first.
      </div>
      {error && <div style={{ fontSize: 12, color: "var(--error, #ef5350)" }}>{error}</div>}

      {rows && rows.length === 0 && !error && (
        <div className="card" style={{ padding: 14, fontSize: 12.5, color: "var(--text-muted)" }}>No inbox items to test. Pull comments/DMs in the inbox first.</div>
      )}

      {rows && rows.length > 0 && (
        <div style={{ display: "grid", gap: 10 }}>
          {rows.map((d) => {
            const o = OUTCOME_STYLE[d.outcome] ?? { label: d.outcome, color: "var(--text-muted)" };
            const downgraded = d.originalAction && d.originalAction !== d.action;
            return (
              <div key={`${d.kind}:${d.itemId}`} className="card" style={{ display: "grid", gap: 7 }}>
                <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 8 }}>
                  <div style={{ fontSize: 12 }}>
                    <span className="tag" style={{ margin: 0, fontSize: 10.5 }}>{d.kind}</span>{" "}
                    <span style={{ fontFamily: "var(--font-mono)", color: "var(--text-secondary)" }}>@{d.username ?? "unknown"}</span>{" "}
                    <span style={{ color: "var(--text-muted)" }}>· {d.classification.sentiment} · {d.classification.priority}</span>
                  </div>
                  <span style={{ fontSize: 12, fontWeight: 600, color: o.color }}>{o.label}</span>
                </div>
                <div style={{ fontSize: 13, color: "var(--text-primary)" }}>{d.text}</div>
                {d.reply && <div style={{ fontSize: 12.5, color: "var(--text-secondary)", borderLeft: "2px solid var(--border-interactive)", paddingLeft: 10 }}>{d.reply}</div>}
                <div style={{ fontSize: 11, color: "var(--text-muted)" }}>
                  {d.matchedRuleId ? `matched ${d.matchedRuleId}` : "no rule → default"}
                  {downgraded && <span style={{ color: "var(--warning, #e6b34a)" }}> · guardrail downgraded {d.originalAction} → {d.action}</span>}
                  {d.reason && ` · ${d.reason}`}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
