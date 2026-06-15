"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Sparkles, Send, RefreshCw, Bot, User } from "lucide-react";
import type { AiDmThread, AiDmMessage } from "../../lib/ai-dm";

export type BrandLite = { id: string; name: string };

type Props = { brands: BrandLite[]; initialChannel: string; initialThreads: AiDmThread[]; canSend: boolean };

/* Live AI DM console: brand selector + thread list (left) + conversation (right).
   "AI draft" generates a brand-voice reply into the composer for review; "AI
   send" generates + sends; the Auto toggle hands a thread to the AI (the poll
   then auto-replies to new inbound). All sends inherit the kill-switch + 24h
   window + never-auto guardrail server-side. Self-fetches (not router.refresh)
   so the chat updates live. */
export function AiDmConsole({ brands, initialChannel, initialThreads, canSend }: Props) {
  const [channel, setChannel] = useState(initialChannel);
  const [threads, setThreads] = useState<AiDmThread[]>(initialThreads);
  const [selected, setSelected] = useState<string>("");
  const [messages, setMessages] = useState<AiDmMessage[]>([]);
  const [composer, setComposer] = useState("");
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const scroller = useRef<HTMLDivElement>(null);

  const flash = (kind: "ok" | "error", text: string) => {
    setNotice({ kind, text });
    setTimeout(() => setNotice(null), 4200);
  };

  const loadThreads = useCallback(async (ch: string) => {
    const r = await fetch(`/api/ai-dm?channel=${encodeURIComponent(ch)}`);
    const j = await r.json().catch(() => ({}));
    if (r.ok) setThreads(j.threads ?? []);
  }, []);

  const loadMessages = useCallback(async (ch: string, cid: string) => {
    const r = await fetch(`/api/ai-dm?channel=${encodeURIComponent(ch)}&conversationId=${encodeURIComponent(cid)}`);
    const j = await r.json().catch(() => ({}));
    if (r.ok) setMessages(j.messages ?? []);
  }, []);

  // Channel switch → reset + load.
  useEffect(() => {
    setSelected("");
    setMessages([]);
    void loadThreads(channel);
  }, [channel, loadThreads]);

  // Poll: refresh threads, auto-sweep AI threads, refresh open conversation.
  useEffect(() => {
    const tick = async () => {
      if (document.visibilityState !== "visible" || !channel) return;
      if (canSend && threads.some((t) => t.auto && t.needsReply)) {
        await fetch("/api/ai-dm", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "sweep", channel }) }).catch(() => {});
      }
      await loadThreads(channel);
      if (selected) await loadMessages(channel, selected);
    };
    const id = setInterval(tick, 8000);
    return () => clearInterval(id);
  }, [channel, selected, threads, canSend, loadThreads, loadMessages]);

  // Auto-scroll the conversation to the newest message.
  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
  }, [messages]);

  async function post(body: Record<string, unknown>): Promise<Record<string, unknown> | null> {
    const r = await fetch("/api/ai-dm", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      flash("error", String(j?.error ?? "action failed"));
      return null;
    }
    return j;
  }

  async function pull() {
    setBusy("pull");
    const j = await post({ action: "pull", channel });
    if (j) {
      flash("ok", "Pulled latest DMs");
      await loadThreads(channel);
    }
    setBusy("");
  }

  async function select(cid: string) {
    setSelected(cid);
    setComposer("");
    await loadMessages(channel, cid);
  }

  async function aiDraft() {
    if (!selected) return;
    setBusy("draft");
    const j = await post({ action: "draft", channel, conversationId: selected });
    if (j?.data && (j.data as { reply?: string }).reply) {
      setComposer(String((j.data as { reply: string }).reply));
      flash("ok", "AI drafted a reply — review and send");
    }
    setBusy("");
  }

  async function aiSend() {
    if (!selected) return;
    setBusy("aisend");
    const j = await post({ action: "send_ai", channel, conversationId: selected });
    if (j) {
      const outcome = (j.data as { outcome?: string })?.outcome ?? "done";
      flash("ok", outcome === "sent" ? "AI sent a reply" : `AI ${outcome} (held — check the inbox)`);
      setComposer("");
      await loadMessages(channel, selected);
      await loadThreads(channel);
    }
    setBusy("");
  }

  async function manualSend() {
    if (!selected || !composer.trim()) return;
    setBusy("send");
    const j = await post({ action: "send_manual", channel, conversationId: selected, text: composer.trim() });
    if (j) {
      flash("ok", "Sent");
      setComposer("");
      await loadMessages(channel, selected);
      await loadThreads(channel);
    }
    setBusy("");
  }

  async function toggleAuto(cid: string, auto: boolean) {
    setBusy(`auto:${cid}`);
    const j = await post({ action: "set_auto", channel, conversationId: cid, auto });
    if (j) {
      flash("ok", auto ? "Thread handed to the AI" : "Thread set to manual");
      await loadThreads(channel);
    }
    setBusy("");
  }

  const cur = threads.find((t) => t.conversationId === selected);

  return (
    <div>
      {notice && (
        <div className="card" style={{ marginBottom: 14, padding: "10px 16px", borderColor: notice.kind === "ok" ? "var(--success, #5fd97a)" : "var(--error, #ef5350)" }}>
          <span style={{ fontSize: 12.5, color: notice.kind === "ok" ? "var(--success, #5fd97a)" : "var(--error, #ef5350)" }}>{notice.text}</span>
        </div>
      )}

      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14, flexWrap: "wrap" }}>
        <select value={channel} onChange={(e) => setChannel(e.target.value)} className="btn" style={{ padding: "8px 12px" }}>
          {brands.map((b) => (
            <option key={b.id} value={b.id}>{b.name}</option>
          ))}
        </select>
        <button className="btn" style={{ padding: "8px 14px" }} disabled={busy === "pull"} onClick={pull}>
          <RefreshCw size={14} /> Pull DMs
        </button>
        <Link href={`/connections/${encodeURIComponent(channel)}/setup`} className="btn" style={{ padding: "8px 14px", marginLeft: "auto" }}>
          Connect / manage account
        </Link>
      </div>

      {!canSend && (
        <div className="card" style={{ marginBottom: 14, padding: "9px 14px" }}>
          <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>You can draft AI replies; sending and auto-handle need the publish permission.</span>
        </div>
      )}

      <div className="aidm-split" style={{ display: "grid", gridTemplateColumns: "minmax(240px, 300px) minmax(0, 1fr)", gap: 14, minHeight: 460 }}>
        {/* Thread list */}
        <div className="card" style={{ padding: 8, display: "flex", flexDirection: "column", gap: 6, maxHeight: 620, overflowY: "auto" }}>
          {threads.length === 0 && <div style={{ padding: 12, fontSize: 12.5, color: "var(--text-muted)" }}>No conversations. Hit “Pull DMs”.</div>}
          {threads.map((t) => (
            <button
              key={t.conversationId}
              onClick={() => select(t.conversationId)}
              className="btn"
              style={{ justifyContent: "flex-start", textAlign: "left", padding: "9px 11px", borderColor: selected === t.conversationId ? "var(--accent)" : undefined, background: selected === t.conversationId ? "#171717" : undefined }}
            >
              <span style={{ display: "flex", flexDirection: "column", gap: 3, width: "100%" }}>
                <span style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12.5 }}>
                  {t.needsReply && <span style={{ width: 7, height: 7, borderRadius: 99, background: "var(--success, #5fd97a)" }} />}
                  <span style={{ fontFamily: "var(--font-mono)", color: "var(--text-secondary)" }}>@{t.username ?? "unknown"}</span>
                  {t.auto && <span className="tag" style={{ margin: 0, color: "var(--accent)" }}><Bot size={10} /> AI</span>}
                  {!t.windowOpen && <span style={{ fontSize: 10.5, color: "var(--error, #ef5350)", marginLeft: "auto" }}>window closed</span>}
                </span>
                <span style={{ fontSize: 12, color: "var(--text-muted)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{t.lastMessage}</span>
              </span>
            </button>
          ))}
        </div>

        {/* Conversation */}
        <div className="card" style={{ padding: 0, display: "flex", flexDirection: "column" }}>
          {!cur ? (
            <div style={{ margin: "auto", color: "var(--text-muted)", fontSize: 13 }}>Select a conversation.</div>
          ) : (
            <>
              <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--border-subtle)", display: "flex", alignItems: "center", gap: 10 }}>
                <span style={{ fontFamily: "var(--font-mono)", fontSize: 13, color: "var(--text-secondary)" }}>@{cur.username ?? "unknown"}</span>
                {!cur.windowOpen && <span style={{ fontSize: 11.5, color: "var(--error, #ef5350)" }}>24h window closed (~{cur.hoursSinceInbound}h)</span>}
                <label style={{ marginLeft: "auto", display: "inline-flex", alignItems: "center", gap: 7, fontSize: 12, color: "var(--text-secondary)", cursor: canSend ? "pointer" : "not-allowed" }} title={canSend ? "" : "Requires the publish permission"}>
                  <input type="checkbox" checked={cur.auto} disabled={!canSend || busy === `auto:${cur.conversationId}`} onChange={(e) => toggleAuto(cur.conversationId, e.target.checked)} />
                  <Bot size={13} /> AI auto-handle
                </label>
              </div>

              <div ref={scroller} style={{ flex: 1, overflowY: "auto", padding: 16, display: "flex", flexDirection: "column", gap: 8, maxHeight: 420 }}>
                {messages.map((m) => (
                  <div key={m.id} style={{ alignSelf: m.direction === "out" ? "flex-end" : "flex-start", maxWidth: "78%" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 5, marginBottom: 2, justifyContent: m.direction === "out" ? "flex-end" : "flex-start" }}>
                      {m.direction === "out" ? <Bot size={11} color="var(--text-muted)" /> : <User size={11} color="var(--text-muted)" />}
                    </div>
                    <div style={{ padding: "8px 12px", borderRadius: 12, fontSize: 13.5, background: m.direction === "out" ? "#f5f5f5" : "var(--bg-surface)", color: m.direction === "out" ? "#0a0a0a" : "var(--text-primary)", border: m.direction === "out" ? "none" : "1px solid var(--border-subtle)" }}>
                      {m.text}
                    </div>
                  </div>
                ))}
                {messages.length === 0 && <div style={{ margin: "auto", color: "var(--text-muted)", fontSize: 12.5 }}>No messages.</div>}
              </div>

              <div style={{ borderTop: "1px solid var(--border-subtle)", padding: 12, display: "flex", flexDirection: "column", gap: 8 }}>
                <textarea
                  value={composer}
                  onChange={(e) => setComposer(e.target.value)}
                  placeholder="Type a reply, or let the AI draft one…"
                  rows={2}
                  style={{ width: "100%", background: "var(--bg-surface)", border: "1px solid var(--border-subtle)", borderRadius: 7, color: "var(--text-primary)", padding: "8px 10px", fontSize: 13, resize: "vertical" }}
                />
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <button className="btn" style={{ padding: "7px 13px", fontSize: 12.5 }} disabled={busy === "draft"} onClick={aiDraft}>
                    <Sparkles size={13} /> AI draft
                  </button>
                  <button className="btn" style={{ padding: "7px 13px", fontSize: 12.5 }} disabled={!canSend || busy === "aisend"} title={canSend ? "" : "Requires the publish permission"} onClick={aiSend}>
                    <Bot size={13} /> {busy === "aisend" ? "Sending…" : "AI reply + send"}
                  </button>
                  <button className="btn btn-primary" style={{ padding: "7px 13px", fontSize: 12.5, marginLeft: "auto" }} disabled={!canSend || !composer.trim() || busy === "send"} title={canSend ? "" : "Requires the publish permission"} onClick={manualSend}>
                    <Send size={13} /> Send
                  </button>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
