import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { DATA_DIR, ensureDir, nowIso } from "./store.ts";
import { classifyItem, draftReplyText, loadResponderConfig } from "./responder.ts";
import { findThread, loadThreads, pullConversations, sendMessage, upsertDmDraft, upsertThread, windowOpen, type DmDraft, type DmThread } from "./dms.ts";

/* ai-dm.ts — the per-thread AI reply layer behind the live "AI DM" console.
   Reuses the responder's brand-voice generation (classifyItem + draftReplyText)
   to answer ONE conversation on demand, and an optional per-thread AUTO flag so
   a thread can be handed to the AI. Sending goes through dms.sendMessage, which
   already enforces the workspace kill-switch + the 24h messaging window — so
   auto-replies inherit both gates. The AUTO guardrail additionally downgrades an
   auto-send to a draft when the inbound sentiment is in the brand's never-auto
   set (complaint/risky), so the AI never auto-replies to something risky. */

// ───────────────────────── per-thread AUTO store ─────────────────────────────
const AIDM_DIR = join(DATA_DIR, "ai-dm");
const sani = (c: string) => (c || "global").replace(/[^a-zA-Z0-9_-]/g, "-");
const autoFile = (ch: string) => join(AIDM_DIR, `${sani(ch)}.json`);

type AutoStore = { auto: Record<string, boolean> };

function loadAutoStore(channel: string): AutoStore {
  try {
    const p = autoFile(channel);
    if (!existsSync(p)) return { auto: {} };
    const raw = JSON.parse(readFileSync(p, "utf8"));
    return raw && typeof raw === "object" && raw.auto ? (raw as AutoStore) : { auto: {} };
  } catch {
    return { auto: {} };
  }
}

function saveAutoStore(channel: string, store: AutoStore): void {
  ensureDir(AIDM_DIR);
  const p = autoFile(channel);
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(store, null, 2));
  renameSync(tmp, p);
}

export function isAuto(channel: string, conversationId: string): boolean {
  return !!loadAutoStore(channel).auto[conversationId];
}
export function setAuto(channel: string, conversationId: string, on: boolean): void {
  const store = loadAutoStore(channel);
  if (on) store.auto[conversationId] = true;
  else delete store.auto[conversationId];
  saveAutoStore(channel, store);
}

// ───────────────────────── thread views ──────────────────────────────────────
export type AiDmThreadView = {
  conversationId: string;
  username?: string;
  lastMessage: string;
  lastDirection: "in" | "out" | null;
  needsReply: boolean; // last message is inbound
  windowOpen: boolean;
  hoursSinceInbound?: number;
  auto: boolean;
  messageCount: number;
};

export function listThreadViews(channel: string): AiDmThreadView[] {
  return loadThreads(channel)
    .map((t) => {
      const last = t.messages[t.messages.length - 1];
      const w = windowOpen(t);
      return {
        conversationId: t.conversationId,
        username: t.participantUsername,
        lastMessage: last?.text ?? "",
        lastDirection: (last?.direction as "in" | "out") ?? null,
        needsReply: last?.direction === "in",
        windowOpen: w.open,
        hoursSinceInbound: w.hours,
        auto: isAuto(channel, t.conversationId),
        messageCount: t.messages.length,
      };
    })
    .sort((a, b) => Number(b.needsReply) - Number(a.needsReply));
}

export function threadDetail(channel: string, conversationId: string): { thread: DmThread; window: { open: boolean; hours?: number }; auto: boolean } | null {
  const thread = findThread(channel, conversationId);
  if (!thread) return null;
  return { thread, window: windowOpen(thread), auto: isAuto(channel, conversationId) };
}

// ───────────────────────── the AI reply ──────────────────────────────────────
export type AiReplyResult =
  | { ok: true; outcome: "sent" | "drafted"; reply: string; sentiment: string; messageId?: string; reason?: string }
  | { ok: false; reason: string };

/** Generate a brand-voice reply to a thread's latest inbound message and either
    send it (live, gated) or store it as a pending draft. */
export async function aiReplyForThread(channel: string, conversationId: string, opts: { send?: boolean; auto?: boolean } = {}): Promise<AiReplyResult> {
  const thread = findThread(channel, conversationId);
  if (!thread) return { ok: false, reason: `thread ${conversationId} not found for ${channel} — pull DMs first` };
  const lastIn = [...thread.messages].reverse().find((m) => m.direction === "in");
  if (!lastIn?.text) return { ok: false, reason: "no inbound message to reply to in this thread" };

  const cfg = loadResponderConfig(channel);
  const cls = await classifyItem(channel, lastIn.text, { toneNotes: cfg.toneNotes });
  const reply = await draftReplyText(channel, lastIn.text, cls, cfg);

  // AUTO guardrail: never auto-send to a never-auto sentiment → hold for review.
  const guardrailed = !!opts.auto && (cfg.neverAutoSentiments ?? []).includes(cls.sentiment);
  const wantSend = !!opts.send && !guardrailed;

  const draftIt = (reason?: string): AiReplyResult => {
    const draft: DmDraft = { conversationId, recipientId: thread.participantId, inReplyTo: lastIn.text, reply, draftedAt: nowIso(), status: "pending" };
    upsertDmDraft(channel, draft);
    return { ok: true, outcome: "drafted", reply, sentiment: cls.sentiment, reason };
  };

  if (!wantSend) return draftIt(guardrailed ? `held for review (sentiment: ${cls.sentiment})` : undefined);

  // Send live — sendMessage enforces the kill-switch + 24h window; if it refuses,
  // fall back to a draft so the AI's reply is never silently lost.
  const res = await sendMessage(channel, conversationId, thread.participantId, reply);
  if (res.ok) return { ok: true, outcome: "sent", reply, sentiment: cls.sentiment, messageId: res.id };
  return draftIt(res.reason);
}

/** Convenience for AUTO mode: pull, then auto-reply to every auto-flagged thread
    whose last message is inbound. Returns a per-thread outcome summary. */
export async function autoSweep(channel: string): Promise<{ pulled: number; handled: { conversationId: string; outcome: string; reason?: string }[] }> {
  const pull = await pullConversations(channel, {});
  if (pull.ok) for (const t of pull.threads) upsertThread(channel, t);
  const handled: { conversationId: string; outcome: string; reason?: string }[] = [];
  for (const v of listThreadViews(channel)) {
    if (!v.auto || !v.needsReply) continue;
    const r = await aiReplyForThread(channel, v.conversationId, { send: true, auto: true });
    handled.push({ conversationId: v.conversationId, outcome: r.ok ? r.outcome : "error", reason: r.ok ? r.reason : r.reason });
  }
  return { pulled: pull.ok ? pull.threads.length : 0, handled };
}
