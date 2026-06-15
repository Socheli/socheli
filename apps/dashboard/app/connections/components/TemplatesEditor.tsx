"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Plus, Trash2, Save } from "lucide-react";
import { confirmDialog } from "../../confirm";
import type { ResponderTemplate } from "@os/schemas";

/* Saved canned-reply (template) CRUD for one brand. Unlike RulesEditor this
   one persists each template independently via /api/responder
   (template_set / template_delete) since templates are referenced by id from
   rules and the live responder. Edit-class — saving a template never sends. */

type Props = {
  channel: string;
  templates: ResponderTemplate[];
  canEdit: boolean;
};

async function post(body: Record<string, unknown>) {
  const res = await fetch("/api/responder", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j?.error ?? "action failed");
  return j;
}

export function TemplatesEditor({ channel, templates, canEdit }: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [draftName, setDraftName] = useState("");
  const [draftBody, setDraftBody] = useState("");
  const [drafts, setDrafts] = useState<Record<string, { name: string; body: string }>>({});

  const editValue = (t: ResponderTemplate) => drafts[t.id] ?? { name: t.name, body: t.body };

  async function save(key: string, template: Record<string, unknown>, after?: () => void) {
    setBusy(key);
    setError(null);
    try {
      await post({ action: "template_set", channel, template });
      after?.();
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "save failed");
    } finally {
      setBusy("");
    }
  }

  async function remove(t: ResponderTemplate) {
    if (!(await confirmDialog({ title: `Delete "${t.name}"?`, confirmText: "Delete", danger: true }))) return;
    setBusy(`del:${t.id}`);
    setError(null);
    try {
      await post({ action: "template_delete", channel, templateId: t.id });
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "delete failed");
    } finally {
      setBusy("");
    }
  }

  const inputStyle: React.CSSProperties = {
    background: "var(--bg-surface)", border: "1px solid var(--border-subtle)", borderRadius: 7,
    color: "var(--text-primary)", padding: "7px 9px", fontSize: 12.5,
  };

  return (
    <div style={{ display: "grid", gap: 14 }}>
      <div className="eyebrow">Reply templates — saved canned responses</div>
      {error && <div style={{ fontSize: 12, color: "var(--error, #ef5350)" }}>{error}</div>}

      <div style={{ display: "grid", gap: 10 }}>
        {templates.map((t) => {
          const v = editValue(t);
          const changed = v.name !== t.name || v.body !== t.body;
          return (
            <div key={t.id} className="card" style={{ display: "grid", gap: 8 }}>
              <div style={{ display: "flex", gap: 8 }}>
                <input value={v.name} disabled={!canEdit} onChange={(e) => setDrafts((d) => ({ ...d, [t.id]: { ...editValue(t), name: e.target.value } }))} style={{ ...inputStyle, flex: 1, fontSize: 13 }} />
                <button className="btn btn-primary" style={{ padding: "6px 11px", fontSize: 12 }} disabled={!canEdit || !changed || busy === `s:${t.id}`}
                  onClick={() => save(`s:${t.id}`, { id: t.id, channel, name: v.name, body: v.body, tags: t.tags }, () => setDrafts((d) => { const n = { ...d }; delete n[t.id]; return n; }))}>
                  <Save size={13} /> Save
                </button>
                <button className="btn danger" style={{ padding: "6px 9px" }} disabled={!canEdit || busy === `del:${t.id}`} onClick={() => remove(t)}><Trash2 size={13} /></button>
              </div>
              <textarea value={v.body} disabled={!canEdit} rows={2}
                onChange={(e) => setDrafts((d) => ({ ...d, [t.id]: { ...editValue(t), body: e.target.value } }))}
                style={{ ...inputStyle, fontSize: 13, resize: "vertical" }} />
            </div>
          );
        })}
        {templates.length === 0 && (
          <div className="card" style={{ padding: 14, fontSize: 12.5, color: "var(--text-muted)" }}>No templates yet.</div>
        )}
      </div>

      {/* New template */}
      <div className="card" style={{ display: "grid", gap: 8 }}>
        <div style={{ fontSize: 12, color: "var(--text-muted)" }}>New template</div>
        <input value={draftName} disabled={!canEdit} onChange={(e) => setDraftName(e.target.value)} placeholder="Name (e.g. Thanks reply)" style={{ ...inputStyle, fontSize: 13 }} />
        <textarea value={draftBody} disabled={!canEdit} rows={2} onChange={(e) => setDraftBody(e.target.value)} placeholder="Body…" style={{ ...inputStyle, fontSize: 13, resize: "vertical" }} />
        <div>
          <button className="btn" style={{ padding: "7px 12px", fontSize: 12.5 }} disabled={!canEdit || !draftName.trim() || !draftBody.trim() || busy === "new"}
            onClick={() => save("new", { id: `tpl_${Date.now()}`, channel, name: draftName.trim(), body: draftBody.trim(), tags: [] }, () => { setDraftName(""); setDraftBody(""); })}>
            <Plus size={14} /> Add template
          </button>
        </div>
      </div>
    </div>
  );
}
