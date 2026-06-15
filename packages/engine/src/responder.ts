import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { z } from "zod";

import {
  ResponderClassification,
  type ResponderAction,
  type ResponderConfig,
  type ResponderDecision,
  type ResponderRule,
  type ResponderTemplate,
} from "@os/schemas";

import { DATA_DIR, ensureDir, nowIso } from "./store.ts";
import { think } from "./brain.ts";
import { genomeContextSafe } from "./dna.ts";
import { getMemoryProvider } from "./memory/index.ts";
import {
  findComment,
  listStoredComments,
  sendReply,
  upsertDraft,
  type DraftReply,
} from "./comments.ts";
import {
  listOpenThreads,
  sendMessage,
  upsertDmDraft,
  windowOpen,
  type DmDraft,
  type DmThread,
} from "./dms.ts";

/* ════════════════════════════════════════════════════════════════════════
   RESPONDER — the per-brand custom responder agent.

   A brand configures an ordered list of RULES (match condition → action) plus a
   brand-level DEFAULT action for unmatched items. The responder runs over the
   STORED inbox (comments.ts snapshots + dms.ts threads — NO live pull here) and,
   per item: classifies (brain.think), matches the first enabled rule, applies
   guardrails, then acts.

   ACT semantics:
     - auto_send → delegate to the EXISTING gated live fns sendReply()/sendMessage(),
       passing `channel` through. We never duplicate Graph/token code.
     - draft     → upsertDraft()/upsertDmDraft() (queues for human review in /inbox).
     - flag      → record a decision only; never reply.

   GUARDRAILS (applyGuardrails): auto_send is DOWNGRADED to draft when the inbound
   sentiment is in cfg.neverAutoSentiments (complaint/risky floor), or when a DM is
   outside the 24h window and cfg.respectDmWindow is on. complaint/risky never go out.

   DRY-RUN: runResponder({dryRun:true}) short-circuits BEFORE any mutation and emits
   would_* outcomes — the /inbox "test what each rule would do" preview.

   Stores under data/responder/<sanitize(channel)>/{config,templates}.json with the
   EXACT atomic tmp+rename + sanitize convention from comments.ts.
   ════════════════════════════════════════════════════════════════════════ */

// ───────────────────────────────────────────────────────────────────────────
// Store — data/responder/<channel>/{config,templates}.json (flat JSON, atomic)
// ───────────────────────────────────────────────────────────────────────────

const RESPONDER_DIR = join(DATA_DIR, "responder");
const sanitize = (c: string) => (c || "global").replace(/[^a-zA-Z0-9_-]/g, "-");
const channelDir = (channel: string) => join(RESPONDER_DIR, sanitize(channel));
const configFile = (channel: string) => join(channelDir(channel), "config.json");
const templatesFile = (channel: string) => join(channelDir(channel), "templates.json");

function loadJson<T>(path: string, fallback: T): T {
  try {
    return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as T) : fallback;
  } catch {
    return fallback;
  }
}

function saveJson(path: string, data: unknown): void {
  ensureDir(path.slice(0, path.lastIndexOf("/"))); // parent dir
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  renameSync(tmp, path);
}

// ───────────────────────────────────────────────────────────────────────────
// Config + templates persistence
// ───────────────────────────────────────────────────────────────────────────

/** Read the brand's responder config, seeding a safe default on first read. */
export function loadResponderConfig(channel: string, ws?: string): ResponderConfig {
  const seeded: ResponderConfig = {
    channel,
    enabled: false,
    rules: [],
    defaultAction: "auto_send",
    respectDmWindow: true,
    neverAutoSentiments: ["complaint", "risky"],
    ...(ws ? { workspaceId: ws } : {}),
  };
  const raw = loadJson<Partial<ResponderConfig> | null>(configFile(channel), null);
  if (!raw) return seeded;
  // merge over the seed so older/partial files still resolve every field
  return { ...seeded, ...raw, channel };
}

/** Persist the brand's responder config (stamps updatedAt, atomic). */
export function saveResponderConfig(cfg: ResponderConfig): ResponderConfig {
  const next: ResponderConfig = { ...cfg, updatedAt: nowIso() };
  saveJson(configFile(cfg.channel), next);
  return next;
}

export function loadTemplates(channel: string): ResponderTemplate[] {
  return loadJson<ResponderTemplate[]>(templatesFile(channel), []);
}

export function saveTemplates(channel: string, t: ResponderTemplate[]): void {
  saveJson(templatesFile(channel), t);
}

/** Upsert a template by id (generating an id when absent), atomic. */
export function upsertTemplate(channel: string, t: ResponderTemplate): ResponderTemplate {
  const next: ResponderTemplate = {
    ...t,
    channel,
    id: t.id || `tpl_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    createdAt: t.createdAt || nowIso(),
  };
  const all = loadTemplates(channel);
  const i = all.findIndex((x) => x.id === next.id);
  if (i >= 0) all[i] = next;
  else all.push(next);
  saveTemplates(channel, all);
  return next;
}

export function deleteTemplate(channel: string, id: string): boolean {
  const all = loadTemplates(channel);
  const next = all.filter((x) => x.id !== id);
  if (next.length === all.length) return false;
  saveTemplates(channel, next);
  return true;
}

// ───────────────────────────────────────────────────────────────────────────
// Classification — brain.think, degrading to a heuristic so a run never dies
// ───────────────────────────────────────────────────────────────────────────

const NEG_HINTS = ["scam", "fraud", "refund", "broken", "worst", "hate", "terrible", "awful", "sue", "lawyer", "rip off", "ripoff", "stolen", "fake"];
const RISK_HINTS = ["kill", "suicide", "lawsuit", "illegal", "racist", "violence", "harassment", "threat"];

/** Cheap network-free fallback so a dry-run/run never dies if the brain is down. */
function heuristicClassify(text: string): ResponderClassification {
  const t = (text || "").toLowerCase();
  if (RISK_HINTS.some((w) => t.includes(w))) return { sentiment: "risky", priority: "urgent" };
  if (NEG_HINTS.some((w) => t.includes(w))) return { sentiment: "complaint", priority: "high" };
  if (t.includes("?") || /\b(how|what|when|where|why|can you|do you)\b/.test(t)) return { sentiment: "question", priority: "normal" };
  return { sentiment: "neutral", priority: "normal" };
}

/** Classify one inbound text. On any brain error, fall back to the heuristic. */
export async function classifyItem(
  channel: string,
  text: string,
  opts: { toneNotes?: string } = {},
): Promise<ResponderClassification> {
  const clean = (text || "").trim();
  if (!clean) return { sentiment: "neutral", priority: "low" };
  try {
    const prompt = [
      `You are triaging an inbound social message for the brand "${channel}".`,
      opts.toneNotes ? `Brand tone notes: ${opts.toneNotes}` : "",
      "",
      `Inbound message:\n"""${clean.slice(0, 600)}"""`,
      "",
      "Classify it. Return ONLY compact JSON matching:",
      `{"sentiment":"positive|neutral|question|negative|complaint|risky","priority":"low|normal|high|urgent","topic":"short topic phrase"}`,
      "Use 'complaint' for anger/refund/broken-product; 'risky' for legal/safety/abuse; 'question' for genuine questions.",
    ]
      .filter(Boolean)
      .join("\n");
    const { data } = await think<ResponderClassification>(ResponderClassification, prompt, "smart");
    return data;
  } catch {
    return heuristicClassify(clean);
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Rule matching — ordered, first enabled rule that qualifies wins
// ───────────────────────────────────────────────────────────────────────────

/** First enabled rule whose match qualifies: keyword substring OR sentiment OR topicHint;
    channel kind filter ("any" matches both). */
export function matchRule(
  rules: ResponderRule[],
  text: string,
  cls: ResponderClassification,
  kind: "comment" | "dm",
): ResponderRule | undefined {
  const lower = (text || "").toLowerCase();
  const topic = (cls.topic || "").toLowerCase();
  for (const rule of rules) {
    if (rule.enabled === false) continue;
    const m = rule.match;
    if (m.channel && m.channel !== "any" && m.channel !== kind) continue;

    let qualified = false;
    if (m.keywords && m.keywords.length) {
      if (m.keywords.some((k) => k && lower.includes(k.toLowerCase()))) qualified = true;
    }
    if (!qualified && m.sentiment && m.sentiment.length) {
      if (m.sentiment.includes(cls.sentiment)) qualified = true;
    }
    if (!qualified && m.topicHint) {
      const hint = m.topicHint.toLowerCase();
      if (topic.includes(hint) || lower.includes(hint)) qualified = true;
    }
    // a rule with NO match criteria at all is a catch-all (still channel-filtered)
    if (!qualified && !m.keywords?.length && !m.sentiment?.length && !m.topicHint) qualified = true;

    if (qualified) return rule;
  }
  return undefined;
}

// ───────────────────────────────────────────────────────────────────────────
// Guardrails — the safety floor that can only ever DOWNGRADE auto_send
// ───────────────────────────────────────────────────────────────────────────

/** Downgrade auto_send→draft when sentiment is on the never-auto floor, or when a
    DM is outside the 24h window and the brand respects it. flag/draft pass through. */
export function applyGuardrails(
  action: ResponderAction,
  cls: ResponderClassification,
  cfg: ResponderConfig,
  kind: "comment" | "dm",
  thread?: DmThread,
): { action: ResponderAction; reason?: string } {
  if (action !== "auto_send") return { action };

  const floor = cfg.neverAutoSentiments ?? ["complaint", "risky"];
  if (floor.includes(cls.sentiment)) {
    return { action: "draft", reason: `guardrail: ${cls.sentiment} can never auto-send (downgraded to draft)` };
  }
  if (kind === "dm" && cfg.respectDmWindow !== false) {
    const w = windowOpen(thread);
    if (!w.open) {
      return { action: "draft", reason: `guardrail: outside 24h DM window (~${w.hours}h) — downgraded to draft` };
    }
  }
  return { action: "auto_send" };
}

// ───────────────────────────────────────────────────────────────────────────
// Reply drafting — template body, else brand-voice generation (never empty)
// ───────────────────────────────────────────────────────────────────────────

async function recallContext(channel: string, text: string): Promise<string> {
  try {
    const provider = getMemoryProvider();
    const hits = await provider.recall(text.slice(0, 200), { limit: 3, scope: { channelId: channel } });
    if (!hits.length) return "";
    return hits.map((h) => `- ${h.content}`).join("\n");
  } catch {
    return "";
  }
}

/** Resolve the reply body: a template body when templateId resolves, otherwise a
    short brand-voice reply grounded by the genome + tone notes + recalled memory.
    Never returns empty — a missing template falls back to generation. */
export async function draftReplyText(
  channel: string,
  text: string,
  cls: ResponderClassification,
  cfg: ResponderConfig,
  templateId?: string,
): Promise<string> {
  if (templateId) {
    const tpl = loadTemplates(channel).find((t) => t.id === templateId);
    if (tpl && tpl.body.trim()) return tpl.body.trim();
    // missing/empty template → fall through to generated voice
  }

  const genome = genomeContextSafe(channel);
  const memory = await recallContext(channel, text);
  try {
    const ReplySchema = z.object({ reply: z.string().min(1) }).strict();
    const prompt = [
      `Write a SHORT reply (1-2 sentences, no hashtags, no emoji spam) to this inbound message for the brand "${channel}".`,
      "Stay strictly in the brand's voice and never make promises or admissions.",
      "",
      `=== BRAND VOICE / GENOME ===\n${genome}`,
      cfg.toneNotes ? `\n=== EXTRA TONE NOTES ===\n${cfg.toneNotes}` : "",
      memory ? `\n=== RELEVANT MEMORY ===\n${memory}` : "",
      "",
      `Inbound sentiment: ${cls.sentiment}. Inbound message:\n"""${(text || "").slice(0, 600)}"""`,
      "",
      `Return ONLY compact JSON: {"reply":"..."}`,
    ]
      .filter(Boolean)
      .join("\n");
    const { data } = await think<{ reply: string }>(ReplySchema, prompt, "smart");
    const reply = (data?.reply || "").trim();
    if (reply) return reply;
  } catch {
    // fall through to a safe canned reply below
  }

  // last-resort safe reply so an auto_send is never an empty body
  return cls.sentiment === "question"
    ? "Thanks for reaching out — we'll get you an answer shortly."
    : "Thanks so much for the message — we really appreciate it!";
}

// ───────────────────────────────────────────────────────────────────────────
// runResponder — the orchestration over the STORED inbox
// ───────────────────────────────────────────────────────────────────────────

type RunSummary = {
  total: number;
  wouldSend: number;
  wouldDraft: number;
  wouldFlag: number;
  sent: number;
  drafted: number;
  flagged: number;
};

type RunResult =
  | { ok: true; decisions: ResponderDecision[]; summary: RunSummary }
  | { ok: false; reason: string };

/** Run the responder over a channel's STORED inbox (no live pull).
    dryRun short-circuits BEFORE any mutation (outcome would_*). A live run delegates
    auto_send to the existing gated sendReply()/sendMessage(), drafts via upsert*. */
export async function runResponder(
  channel: string,
  opts: { dryRun?: boolean; scope?: "comment" | "dm" | "both"; limit?: number; workspaceId?: string } = {},
): Promise<RunResult> {
  const cfg = loadResponderConfig(channel, opts.workspaceId);
  const scope = opts.scope ?? "both";
  const limit = Math.max(1, opts.limit ?? 25);
  const dryRun = !!opts.dryRun;

  const decisions: ResponderDecision[] = [];
  const summary: RunSummary = { total: 0, wouldSend: 0, wouldDraft: 0, wouldFlag: 0, sent: 0, drafted: 0, flagged: 0 };

  // ── collect stored inbox items (unanswered only) ──────────────────────────
  type Item =
    | { kind: "comment"; id: string; text: string; username?: string }
    | { kind: "dm"; id: string; text: string; username?: string; thread: DmThread };
  const items: Item[] = [];

  if (scope === "comment" || scope === "both") {
    for (const c of listStoredComments(channel, { unansweredOnly: true })) {
      items.push({ kind: "comment", id: c.id, text: c.text, username: c.username });
    }
  }
  if (scope === "dm" || scope === "both") {
    for (const t of listOpenThreads(channel)) {
      const last = [...t.messages].reverse().find((m) => m.direction === "in") ?? t.messages[t.messages.length - 1];
      items.push({ kind: "dm", id: t.conversationId, text: last?.text ?? "", username: t.participantUsername, thread: t });
    }
  }

  const slice = items.slice(0, limit);

  for (const item of slice) {
    summary.total++;
    const cls = await classifyItem(channel, item.text, { toneNotes: cfg.toneNotes });
    const thread = item.kind === "dm" ? item.thread : undefined;
    const matched = matchRule(cfg.rules, item.text, cls, item.kind);
    const originalAction: ResponderAction = matched?.action ?? cfg.defaultAction;
    const guard = applyGuardrails(originalAction, cls, cfg, item.kind, thread);
    const action = guard.action;

    const decision: ResponderDecision = {
      itemId: item.id,
      kind: item.kind,
      text: item.text,
      username: item.username,
      classification: cls,
      matchedRuleId: matched?.id,
      action,
      originalAction: originalAction !== action ? originalAction : undefined,
      templateId: matched?.templateId,
      outcome: "skipped",
      reason: guard.reason,
    };

    // flag → record only, never reply (no body needed)
    if (action === "flag") {
      decision.outcome = dryRun ? "would_flag" : "flagged";
      if (dryRun) summary.wouldFlag++;
      else summary.flagged++;
      decisions.push(decision);
      continue;
    }

    // draft + auto_send both need a reply body
    const reply = await draftReplyText(channel, item.text, cls, cfg, matched?.templateId);
    decision.reply = reply;

    // ── DRY RUN: short-circuit BEFORE any mutation ──────────────────────────
    if (dryRun) {
      decision.outcome = action === "auto_send" ? "would_send" : "would_draft";
      if (action === "auto_send") summary.wouldSend++;
      else summary.wouldDraft++;
      decisions.push(decision);
      continue;
    }

    // ── LIVE ────────────────────────────────────────────────────────────────
    if (action === "auto_send") {
      if (item.kind === "comment") {
        const res = await sendReply(channel, item.id, reply);
        if (res.ok) {
          const draft: DraftReply = {
            commentId: item.id,
            mediaId: findComment(channel, item.id)?.mediaId ?? "",
            username: item.username,
            inReplyTo: item.text,
            reply,
            draftedAt: nowIso(),
            status: "sent",
            sentId: res.id,
            sentAt: nowIso(),
          };
          upsertDraft(channel, draft);
          decision.outcome = "sent";
          summary.sent++;
        } else {
          decision.outcome = "skipped";
          decision.reason = res.reason;
        }
      } else {
        const t = item.thread;
        const res = await sendMessage(channel, t.conversationId, t.participantId, reply);
        if (res.ok) {
          const draft: DmDraft = {
            conversationId: t.conversationId,
            recipientId: t.participantId,
            inReplyTo: item.text,
            reply,
            draftedAt: nowIso(),
            status: "sent",
            sentId: res.id,
            sentAt: nowIso(),
          };
          upsertDmDraft(channel, draft);
          decision.outcome = "sent";
          summary.sent++;
        } else {
          decision.outcome = "skipped";
          decision.reason = res.reason;
        }
      }
      decisions.push(decision);
      continue;
    }

    // action === "draft"
    if (item.kind === "comment") {
      const draft: DraftReply = {
        commentId: item.id,
        mediaId: findComment(channel, item.id)?.mediaId ?? "",
        username: item.username,
        inReplyTo: item.text,
        reply,
        draftedAt: nowIso(),
        status: "pending",
      };
      upsertDraft(channel, draft);
    } else {
      const t = item.thread;
      const draft: DmDraft = {
        conversationId: t.conversationId,
        recipientId: t.participantId,
        inReplyTo: item.text,
        reply,
        draftedAt: nowIso(),
        status: "pending",
      };
      upsertDmDraft(channel, draft);
    }
    decision.outcome = "drafted";
    summary.drafted++;
    decisions.push(decision);
  }

  return { ok: true, decisions, summary };
}
