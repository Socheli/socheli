"use client";

import { Plus, Trash2, ArrowUp, ArrowDown } from "lucide-react";
import type { ResponderAction, ResponderRule, ResponderSentiment, ResponderTemplate } from "@os/schemas";

/* The responder rule editor. A CONTROLLED component: it never POSTs — the
   parent (ConnectWizard / ManagePanels) owns the working ResponderConfig and
   persists it via /api/responder. Each rule = a match condition (keywords /
   topic hint / sentiment / surface) → an action (auto_send | draft | flag),
   optionally backed by a saved template. Below the rules sits the brand
   DEFAULT-action toggle (ships auto_send) + the immovable guardrail notice and
   the tone textarea. */

export type WorkingConfig = {
  enabled: boolean;
  rules: ResponderRule[];
  defaultAction: ResponderAction;
  toneNotes: string;
  respectDmWindow: boolean;
  neverAutoSentiments: ResponderSentiment[];
};

const ACTIONS: ResponderAction[] = ["auto_send", "draft", "flag"];
const ACTION_LABEL: Record<ResponderAction, string> = { auto_send: "Auto-send", draft: "Draft for review", flag: "Flag only" };
const SENTIMENTS: ResponderSentiment[] = ["positive", "neutral", "question", "negative", "complaint", "risky"];
const CHANNELS: ResponderRule["match"]["channel"][] = ["any", "comment", "dm"];

let ruleSeq = 0;
function newRule(): ResponderRule {
  ruleSeq += 1;
  return {
    id: `rule_${Date.now()}_${ruleSeq}`,
    name: "New rule",
    enabled: true,
    match: { keywords: [], channel: "any" },
    action: "draft",
  };
}

type Props = {
  config: WorkingConfig;
  templates: ResponderTemplate[];
  onChange: (next: WorkingConfig) => void;
  disabled?: boolean;
};

export function RulesEditor({ config, templates, onChange, disabled }: Props) {
  const setRule = (i: number, patch: Partial<ResponderRule>) => {
    const rules = config.rules.map((r, j) => (j === i ? { ...r, ...patch } : r));
    onChange({ ...config, rules });
  };
  const setMatch = (i: number, patch: Partial<ResponderRule["match"]>) => {
    const rules = config.rules.map((r, j) => (j === i ? { ...r, match: { ...r.match, ...patch } } : r));
    onChange({ ...config, rules });
  };
  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= config.rules.length) return;
    const rules = [...config.rules];
    [rules[i], rules[j]] = [rules[j], rules[i]];
    onChange({ ...config, rules });
  };
  const remove = (i: number) => onChange({ ...config, rules: config.rules.filter((_, j) => j !== i) });
  const add = () => onChange({ ...config, rules: [...config.rules, newRule()] });

  const inputStyle: React.CSSProperties = {
    background: "var(--bg-surface)", border: "1px solid var(--border-subtle)", borderRadius: 7,
    color: "var(--text-primary)", padding: "7px 9px", fontSize: 12.5,
  };

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <div className="eyebrow">Rules — first matching rule wins</div>

      <div style={{ display: "grid", gap: 12 }}>
        {config.rules.length === 0 && (
          <div className="card" style={{ padding: 14, fontSize: 12.5, color: "var(--text-muted)" }}>
            No rules yet. Without rules every item takes the brand default action below.
          </div>
        )}
        {config.rules.map((r, i) => (
          <div key={r.id} className="card" style={{ display: "grid", gap: 10 }}>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <input value={r.name} onChange={(e) => setRule(i, { name: e.target.value })} disabled={disabled} placeholder="Rule name" style={{ ...inputStyle, flex: 1, fontSize: 13 }} />
              <label style={{ display: "inline-flex", gap: 6, alignItems: "center", fontSize: 12, color: "var(--text-secondary)" }}>
                <input type="checkbox" checked={r.enabled} onChange={(e) => setRule(i, { enabled: e.target.checked })} disabled={disabled} /> On
              </label>
              <button className="btn" style={{ padding: "5px 8px" }} disabled={disabled || i === 0} onClick={() => move(i, -1)} title="Move up"><ArrowUp size={13} /></button>
              <button className="btn" style={{ padding: "5px 8px" }} disabled={disabled || i === config.rules.length - 1} onClick={() => move(i, 1)} title="Move down"><ArrowDown size={13} /></button>
              <button className="btn danger" style={{ padding: "5px 8px" }} disabled={disabled} onClick={() => remove(i)} title="Delete rule"><Trash2 size={13} /></button>
            </div>

            <div className="rules-grid" style={{ display: "grid", gap: 8, gridTemplateColumns: "repeat(2, minmax(0, 1fr))" }}>
              <label style={{ display: "grid", gap: 4 }}>
                <span style={{ fontSize: 11, color: "var(--text-muted)" }}>Keywords (comma-separated)</span>
                <input value={(r.match.keywords ?? []).join(", ")} disabled={disabled}
                  onChange={(e) => setMatch(i, { keywords: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) })}
                  placeholder="price, shipping, refund" style={inputStyle} />
              </label>
              <label style={{ display: "grid", gap: 4 }}>
                <span style={{ fontSize: 11, color: "var(--text-muted)" }}>Topic hint</span>
                <input value={r.match.topicHint ?? ""} disabled={disabled}
                  onChange={(e) => setMatch(i, { topicHint: e.target.value || undefined })}
                  placeholder="pricing questions" style={inputStyle} />
              </label>
            </div>

            <div className="rules-grid-3" style={{ display: "grid", gap: 8, gridTemplateColumns: "repeat(3, minmax(0, 1fr))" }}>
              <label style={{ display: "grid", gap: 4 }}>
                <span style={{ fontSize: 11, color: "var(--text-muted)" }}>Surface</span>
                <select value={r.match.channel} disabled={disabled} onChange={(e) => setMatch(i, { channel: e.target.value as ResponderRule["match"]["channel"] })} style={inputStyle}>
                  {CHANNELS.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              </label>
              <label style={{ display: "grid", gap: 4 }}>
                <span style={{ fontSize: 11, color: "var(--text-muted)" }}>Action</span>
                <select value={r.action} disabled={disabled} onChange={(e) => setRule(i, { action: e.target.value as ResponderAction })} style={inputStyle}>
                  {ACTIONS.map((a) => <option key={a} value={a}>{ACTION_LABEL[a]}</option>)}
                </select>
              </label>
              <label style={{ display: "grid", gap: 4 }}>
                <span style={{ fontSize: 11, color: "var(--text-muted)" }}>Template (optional)</span>
                <select value={r.templateId ?? ""} disabled={disabled} onChange={(e) => setRule(i, { templateId: e.target.value || undefined })} style={inputStyle}>
                  <option value="">— brand voice —</option>
                  {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
              </label>
            </div>

            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              <span style={{ fontSize: 11, color: "var(--text-muted)", alignSelf: "center" }}>Sentiment:</span>
              {SENTIMENTS.map((s) => {
                const on = (r.match.sentiment ?? []).includes(s);
                return (
                  <button key={s} className={`tag ${on ? "" : ""}`} disabled={disabled}
                    onClick={() => {
                      const cur = new Set(r.match.sentiment ?? []);
                      on ? cur.delete(s) : cur.add(s);
                      const arr = [...cur];
                      setMatch(i, { sentiment: arr.length ? (arr as ResponderSentiment[]) : undefined });
                    }}
                    style={{ margin: 0, fontSize: 11, cursor: disabled ? "default" : "pointer", opacity: on ? 1 : 0.45, border: on ? "1px solid var(--border-interactive)" : "1px solid var(--border-subtle)", background: "none" }}>
                    {s}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
        <div>
          <button className="btn" style={{ padding: "8px 13px" }} disabled={disabled} onClick={add}><Plus size={14} /> Add rule</button>
        </div>
      </div>

      {/* Brand default + guardrails */}
      <div className="card" style={{ display: "grid", gap: 12 }}>
        <div className="eyebrow">Default action — for anything no rule matched</div>
        <div style={{ display: "inline-flex", gap: 6 }}>
          {ACTIONS.map((a) => (
            <button key={a} className={`btn ${config.defaultAction === a ? "btn-active" : ""}`} disabled={disabled}
              style={{ padding: "7px 12px", fontSize: 12.5 }} onClick={() => onChange({ ...config, defaultAction: a })}>
              {ACTION_LABEL[a]}
            </button>
          ))}
        </div>
        <div style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.55 }}>
          Ships as <strong style={{ color: "var(--text-secondary)" }}>Auto-send</strong> — flip to Draft for review in one click. DM auto-replies only fire inside the 24-hour
          messaging window, and <strong style={{ color: "var(--text-secondary)" }}>complaints &amp; risky messages are always flagged</strong> for a human — never auto-sent, regardless of any rule.
        </div>
        <label style={{ display: "inline-flex", gap: 8, alignItems: "center", fontSize: 12.5, color: "var(--text-secondary)" }}>
          <input type="checkbox" checked={config.respectDmWindow} disabled={disabled} onChange={(e) => onChange({ ...config, respectDmWindow: e.target.checked })} />
          Only auto-send DMs inside the 24h window
        </label>
      </div>

      {/* Tone */}
      <label style={{ display: "grid", gap: 6 }}>
        <span className="eyebrow">Tone notes (layered on Brand Genome)</span>
        <textarea value={config.toneNotes} disabled={disabled} rows={3}
          onChange={(e) => onChange({ ...config, toneNotes: e.target.value })}
          placeholder="Warm, concise, never defensive. Use the brand's signature sign-off."
          style={{ ...inputStyle, fontSize: 13, resize: "vertical" }} />
      </label>
    </div>
  );
}
