"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { MessageSquare, Send, EyeOff, RefreshCw, Inbox as InboxIcon } from "lucide-react";
import { confirmDialog } from "../confirm";
import type { InboxComment, InboxDm } from "../../lib/inbox";

export type BrandLite = { id: string; name: string; accent?: string };

type Props = {
  brands: BrandLite[];
  commentTriage: InboxComment[];
  commentPending: InboxComment[];
  dmTriage: InboxDm[];
  dmPending: InboxDm[];
  canSend: boolean;
};

/* Client board — two lanes (Comments / DMs), each with a triage queue (draft a
   reply / hide) and a pending queue (approve & send). Server data stays fresh
   via router.refresh polling. Sending is the gated action — disabled unless the
   caller holds content.publish. */
export function InboxBoard({ brands, commentTriage, commentPending, dmTriage, dmPending, canSend }: Props) {
  const router = useRouter();
  const [tab, setTab] = useState<"comments" | "dms">("comments");
  const [channel, setChannel] = useState(brands[0]?.id ?? "");
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  useEffect(() => {
    const t = setInterval(() => {
      if (document.visibilityState === "visible") router.refresh();
    }, 8000);
    return () => clearInterval(t);
  }, [router]);

  const flash = (kind: "ok" | "error", text: string) => {
    setNotice({ kind, text });
    setTimeout(() => setNotice(null), 4200);
  };

  async function act(key: string, body: Record<string, unknown>, okMsg: string) {
    setBusy(key);
    try {
      const res = await fetch("/api/inbox", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j?.error ?? "action failed");
      flash("ok", okMsg);
      router.refresh();
    } catch (e) {
      flash("error", e instanceof Error ? e.message : "action failed");
    } finally {
      setBusy("");
    }
  }

  const refresh = () => {
    if (!channel) return;
    void act(`pull:${channel}`, { action: "comments_pull", channel }, "Refreshing from Instagram…").then(() =>
      act(`pull:dm:${channel}`, { action: "dm_pull", channel }, "Inbox refreshed"),
    );
  };

  const counts = { ct: commentTriage.length, cp: commentPending.length, dt: dmTriage.length, dp: dmPending.length };

  return (
    <div>
      {notice && (
        <div className="card" style={{ marginBottom: 14, padding: "10px 16px", borderColor: notice.kind === "ok" ? "var(--success, #5fd97a)" : "var(--error, #ef5350)" }}>
          <span style={{ fontSize: 12.5, color: notice.kind === "ok" ? "var(--success, #5fd97a)" : "var(--error, #ef5350)" }}>{notice.text}</span>
        </div>
      )}

      {/* Controls: tab switch + brand selector + refresh */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16, flexWrap: "wrap" }}>
        <div style={{ display: "inline-flex", gap: 6 }}>
          <button className={`btn ${tab === "comments" ? "btn-active" : ""}`} style={{ padding: "8px 14px" }} onClick={() => setTab("comments")}>
            <MessageSquare size={14} /> Comments {counts.ct + counts.cp > 0 ? `(${counts.ct + counts.cp})` : ""}
          </button>
          <button className={`btn ${tab === "dms" ? "btn-active" : ""}`} style={{ padding: "8px 14px" }} onClick={() => setTab("dms")}>
            <InboxIcon size={14} /> DMs {counts.dt + counts.dp > 0 ? `(${counts.dt + counts.dp})` : ""}
          </button>
        </div>
        <div style={{ marginLeft: "auto", display: "inline-flex", gap: 8, alignItems: "center" }}>
          <select value={channel} onChange={(e) => setChannel(e.target.value)} className="btn" style={{ padding: "8px 12px" }}>
            {brands.map((b) => (
              <option key={b.id} value={b.id}>{b.name}</option>
            ))}
          </select>
          <button className="btn" style={{ padding: "8px 14px" }} disabled={!channel || busy.startsWith("pull")} onClick={refresh}>
            <RefreshCw size={14} /> Refresh from Instagram
          </button>
        </div>
      </div>

      {!canSend && (
        <div className="card" style={{ marginBottom: 14, padding: "9px 14px" }}>
          <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>You can triage and draft replies. Sending requires the publish permission — drafts wait here for someone who can approve them.</span>
        </div>
      )}

      {tab === "comments" ? (
        <div style={{ display: "grid", gap: 18 }}>
          <Lane title="To triage" empty="No comments waiting. Hit refresh to pull the latest.">
            {commentTriage.map((c) => (
              <CommentTriage key={c.id} c={c} draft={drafts[c.id] ?? ""} setDraft={(v) => setDrafts((d) => ({ ...d, [c.id]: v }))} busy={busy}
                onDraft={() => act(`cd:${c.id}`, { action: "comment_draft", channel: c.channel, commentId: c.id, reply: drafts[c.id] ?? "" }, "Reply drafted — pending your approval")}
                onHide={() => act(`ch:${c.id}`, { action: "comment_hide", channel: c.channel, commentId: c.id, hide: true }, "Comment hidden")} />
            ))}
          </Lane>
          <Lane title="Pending your approval" empty="No drafted replies yet.">
            {commentPending.map((c) => (
              <PendingRow key={c.id} who={c.username} context={c.text} reply={c.draft ?? ""} canSend={canSend} busy={busy === `cs:${c.id}`}
                onSend={async () => {
                  if (!(await confirmDialog({ title: "Send this reply?", message: c.draft, confirmText: "Send to Instagram" }))) return;
                  act(`cs:${c.id}`, { action: "comment_send", channel: c.channel, commentId: c.id }, "Reply sent");
                }} />
            ))}
          </Lane>
        </div>
      ) : (
        <div style={{ display: "grid", gap: 18 }}>
          <Lane title="To triage" empty="No open DM threads. Hit refresh to pull the latest.">
            {dmTriage.map((t) => (
              <DmTriage key={t.conversationId} t={t} draft={drafts[t.conversationId] ?? ""} setDraft={(v) => setDrafts((d) => ({ ...d, [t.conversationId]: v }))} busy={busy}
                onDraft={() => act(`dd:${t.conversationId}`, { action: "dm_draft", channel: t.channel, conversationId: t.conversationId, reply: drafts[t.conversationId] ?? "" }, "Reply drafted — pending your approval")} />
            ))}
          </Lane>
          <Lane title="Pending your approval" empty="No drafted DM replies yet.">
            {dmPending.map((t) => (
              <PendingRow key={t.conversationId} who={t.username} context={t.lastMessage} reply={t.draft ?? ""} canSend={canSend} busy={busy === `ds:${t.conversationId}`} warn={!t.windowOpen ? `24h window closed (~${t.hoursSinceInbound}h)` : undefined}
                onSend={async () => {
                  if (!(await confirmDialog({ title: "Send this DM reply?", message: t.draft, confirmText: "Send to Instagram" }))) return;
                  act(`ds:${t.conversationId}`, { action: "dm_send", channel: t.channel, conversationId: t.conversationId }, "DM reply sent");
                }} />
            ))}
          </Lane>
        </div>
      )}
    </div>
  );
}

function Lane({ title, empty, children }: { title: string; empty: string; children: React.ReactNode }) {
  const items = Array.isArray(children) ? children.filter(Boolean) : children;
  const isEmpty = Array.isArray(items) ? items.length === 0 : !items;
  return (
    <div>
      <div className="eyebrow" style={{ marginBottom: 10 }}>{title}</div>
      {isEmpty ? (
        <div className="card" style={{ padding: "16px", color: "var(--text-muted)", fontSize: 12.5 }}>{empty}</div>
      ) : (
        <div style={{ display: "grid", gap: 10 }}>{children}</div>
      )}
    </div>
  );
}

function CommentTriage({ c, draft, setDraft, busy, onDraft, onHide }: { c: InboxComment; draft: string; setDraft: (v: string) => void; busy: string; onDraft: () => void; onHide: () => void }) {
  return (
    <div className="card" style={{ display: "grid", gap: 9 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "baseline", justifyContent: "space-between" }}>
        <div style={{ fontSize: 13 }}><span style={{ color: "var(--text-secondary)", fontFamily: "var(--font-mono)" }}>@{c.username ?? "unknown"}</span> · <span className="tag" style={{ margin: 0 }}>{c.channel}</span></div>
        <button className="btn" style={{ padding: "5px 10px", fontSize: 12 }} disabled={busy === `ch:${c.id}`} onClick={onHide}><EyeOff size={13} /> Hide</button>
      </div>
      <div style={{ fontSize: 13.5, color: "var(--text-primary)" }}>{c.text}</div>
      <textarea value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Draft a reply in brand voice…" rows={2}
        style={{ width: "100%", background: "var(--bg-surface)", border: "1px solid var(--border-subtle)", borderRadius: 7, color: "var(--text-primary)", padding: "8px 10px", fontSize: 13, resize: "vertical" }} />
      <div>
        <button className="btn btn-primary" style={{ padding: "7px 13px", fontSize: 12.5 }} disabled={!draft.trim() || busy === `cd:${c.id}`} onClick={onDraft}><MessageSquare size={13} /> Save draft</button>
      </div>
    </div>
  );
}

function DmTriage({ t, draft, setDraft, busy, onDraft }: { t: InboxDm; draft: string; setDraft: (v: string) => void; busy: string; onDraft: () => void }) {
  return (
    <div className="card" style={{ display: "grid", gap: 9 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "baseline", justifyContent: "space-between" }}>
        <div style={{ fontSize: 13 }}><span style={{ color: "var(--text-secondary)", fontFamily: "var(--font-mono)" }}>@{t.username ?? "unknown"}</span> · <span className="tag" style={{ margin: 0 }}>{t.channel}</span></div>
        {!t.windowOpen && <span style={{ fontSize: 11.5, color: "var(--error, #ef5350)" }}>24h window closed</span>}
      </div>
      <div style={{ fontSize: 13.5, color: "var(--text-primary)" }}>{t.lastMessage}</div>
      <textarea value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Draft a reply in brand voice…" rows={2}
        style={{ width: "100%", background: "var(--bg-surface)", border: "1px solid var(--border-subtle)", borderRadius: 7, color: "var(--text-primary)", padding: "8px 10px", fontSize: 13, resize: "vertical" }} />
      <div>
        <button className="btn btn-primary" style={{ padding: "7px 13px", fontSize: 12.5 }} disabled={!draft.trim() || busy === `dd:${t.conversationId}`} onClick={onDraft}><MessageSquare size={13} /> Save draft</button>
      </div>
    </div>
  );
}

function PendingRow({ who, context, reply, canSend, busy, warn, onSend }: { who?: string; context: string; reply: string; canSend: boolean; busy: boolean; warn?: string; onSend: () => void }) {
  return (
    <div className="card" style={{ display: "grid", gap: 8 }}>
      <div style={{ fontSize: 12, color: "var(--text-muted)" }}>Replying to <span style={{ fontFamily: "var(--font-mono)" }}>@{who ?? "unknown"}</span>: “{context.slice(0, 90)}”</div>
      <div style={{ fontSize: 13.5, color: "var(--text-primary)", borderLeft: "2px solid var(--border-interactive)", paddingLeft: 10 }}>{reply}</div>
      <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
        <button className="btn btn-primary" style={{ padding: "7px 13px", fontSize: 12.5 }} disabled={!canSend || busy} title={canSend ? "" : "Requires the publish permission"} onClick={onSend}><Send size={13} /> {busy ? "Sending…" : "Approve & send"}</button>
        {warn && <span style={{ fontSize: 11.5, color: "var(--error, #ef5350)" }}>{warn}</span>}
      </div>
    </div>
  );
}
