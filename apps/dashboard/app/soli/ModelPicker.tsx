"use client";
import { useEffect, useState } from "react";
import { Select } from "../Select";

type Preset = { id: string; label: string; note: string };

/* Switch the model that powers Soli, right from the chat header. Reads the
   current model + presets from /api/copilot/model and POSTs the new one; the
   copilot picks it up on the next message (no restart). Mirrors the engine
   `copilot_model` tool — same data file — so the CLI / MCP / asking Soli all
   stay in sync. When "Claude Code (subscription)" is picked but the server isn't
   connected, an inline connect appears: paste the token from `claude setup-token`.
   Hidden for read-only roles (the POSTs 403 for them anyway). */
export function ModelPicker({ canEdit = true }: { canEdit?: boolean }) {
  const [model, setModel] = useState("");
  const [presets, setPresets] = useState<Preset[]>([]);
  const [claudeConnected, setClaudeConnected] = useState<boolean | null>(null);
  const [token, setToken] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let alive = true;
    Promise.all([
      fetch("/api/copilot/model").then((r) => r.json()).catch(() => null),
      fetch("/api/copilot/claude-auth").then((r) => r.json()).catch(() => null),
    ]).then(([m, a]) => {
      if (!alive) return;
      if (m) { setModel(m.model ?? ""); setPresets(m.presets ?? []); }
      if (a) setClaudeConnected(!!a.connected);
    });
    return () => { alive = false; };
  }, []);

  if (!model || !canEdit) return null;

  const change = async (m: string) => {
    setModel(m);
    await fetch("/api/copilot/model", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: m }),
    }).catch(() => {});
  };

  const connect = async () => {
    if (!token.trim()) return;
    setSaving(true);
    const r = await fetch("/api/copilot/claude-auth", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: token.trim() }),
    }).catch(() => null);
    setSaving(false);
    if (r?.ok) { setClaudeConnected(true); setToken(""); }
  };

  const opts = (presets.some((p) => p.id === model) ? presets : [{ id: model, label: model, note: "" }, ...presets])
    .map((p) => ({ value: p.id, label: p.label, hint: p.note }));

  const needsConnect = model === "claude-code" && claudeConnected === false;

  return (
    <span className="soli-model" title="Model powering Soli — switch live">
      <Select value={model} onChange={change} width={190} ariaLabel="Soli model" options={opts} />
      {needsConnect && (
        <span className="soli-model-connect" title="Run `claude setup-token` locally, paste the token here">
          <input
            className="soli-model-token"
            type="password"
            placeholder="paste claude setup-token"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") void connect(); }}
            spellCheck={false}
            autoComplete="off"
          />
          <button className="cp-icon-btn" type="button" disabled={!token.trim() || saving} onClick={() => void connect()}>
            {saving ? "…" : "connect"}
          </button>
        </span>
      )}
    </span>
  );
}
