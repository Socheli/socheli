import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

import { DATA_DIR, ensureDir, nowIso } from "./store.ts";
import { httpCurl } from "./http.ts";
import { isTokenError } from "./publish-types.ts";
import { resolveIgCreds } from "./connections.ts";
import { isSendingHalted } from "./admin.ts";
import { listStoredComments, sendReply } from "./comments.ts";

/* comment-triggers.ts — the "comment a keyword, get a DM" growth mechanic
   (ManyChat-style). When a comment matches a rule, the brand sends the commenter
   a PRIVATE REPLY: a one-time DM tied to the comment via recipient.comment_id,
   which is allowed within 7 days WITHOUT the 24h messaging window (that's the
   whole point — you can DM a fresh commenter). Optionally also posts a public
   comment reply ("check your DMs"). Works on both connection flavours (the
   resolved base is graph.facebook.com or graph.instagram.com). Sends honour the
   kill-switch and are token-gated/never-throw. */

const GRAPH = "https://graph.facebook.com/v21.0"; // fallback only; resolveIgCreds owns the base
const useProxy = () => process.env.IG_USE_PROXY === "1";
function graphJson(r: { stdout: string }): any {
  try {
    return JSON.parse(r.stdout);
  } catch {
    return { error: { message: (r.stdout || "").slice(0, 200) } };
  }
}

// ── config (per-channel, gitignored) ─────────────────────────────────────────
export const TriggerRule = z
  .object({
    id: z.string(),
    name: z.string().default(""),
    keywords: z.array(z.string()).default([]).describe("case-insensitive substrings; ANY match fires"),
    anyComment: z.boolean().default(false).describe("fire on every comment regardless of keyword"),
    dmMessage: z.string().min(1).describe("the DM sent to the commenter (link/CTA)"),
    publicReply: z.string().optional().describe("optional public comment reply, e.g. 'Check your DMs 📩'"),
    oncePerUser: z.boolean().default(true).describe("don't DM the same user twice across comments"),
    enabled: z.boolean().default(true),
  })
  .strict();
export type TriggerRule = z.infer<typeof TriggerRule>;

export const TriggerConfig = z
  .object({
    channel: z.string(),
    enabled: z.boolean().default(false),
    rules: z.array(TriggerRule).default([]),
  })
  .strict();
export type TriggerConfig = z.infer<typeof TriggerConfig>;

const DIR = join(DATA_DIR, "comment-triggers");
const sani = (c: string) => (c || "global").replace(/[^a-zA-Z0-9_-]/g, "-");
const cfgFile = (ch: string) => join(DIR, sani(ch), "config.json");
const stateFile = (ch: string) => join(DIR, sani(ch), "state.json"); // fired comment ids + DM'd users

type State = { firedCommentIds: string[]; dmdUsers: string[] };

function readJson<T>(path: string, fb: T): T {
  try {
    return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as T) : fb;
  } catch {
    return fb;
  }
}
function writeJson(path: string, data: unknown): void {
  ensureDir(path.slice(0, path.lastIndexOf("/")));
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  renameSync(tmp, path);
}

export function loadTriggerConfig(channel: string): TriggerConfig {
  const raw = readJson<unknown>(cfgFile(channel), null);
  const parsed = TriggerConfig.safeParse(raw);
  return parsed.success ? parsed.data : { channel, enabled: false, rules: [] };
}
export function saveTriggerConfig(cfg: TriggerConfig): TriggerConfig {
  const clean = TriggerConfig.parse(cfg);
  writeJson(cfgFile(clean.channel), clean);
  return clean;
}
function loadState(channel: string): State {
  return readJson<State>(stateFile(channel), { firedCommentIds: [], dmdUsers: [] });
}
function saveState(channel: string, s: State): void {
  writeJson(stateFile(channel), { firedCommentIds: s.firedCommentIds.slice(-5000), dmdUsers: s.dmdUsers.slice(-5000) });
}

// ── matching ─────────────────────────────────────────────────────────────────
function matchRule(rules: TriggerRule[], text: string): TriggerRule | undefined {
  const lc = (text || "").toLowerCase();
  for (const r of rules) {
    if (r.enabled === false) continue;
    if (r.anyComment) return r;
    if (r.keywords.some((k) => k.trim() && lc.includes(k.toLowerCase()))) return r;
  }
  return undefined;
}

// ── the private reply send (DM tied to a comment) ────────────────────────────
type SendResult = { ok: true; id?: string } | { ok: false; reason: string };

/** Send a one-time private reply (DM) to the author of a comment. */
export async function sendPrivateReply(channel: string, commentId: string, message: string): Promise<SendResult> {
  const halt = isSendingHalted(channel);
  if (halt.halted) return { ok: false, reason: halt.reason ?? "sending halted by admin" };
  const creds = resolveIgCreds(channel);
  if (!creds) return { ok: false, reason: "no Instagram connection for this brand" };
  const base = creds.base || GRAPH;
  const body = JSON.stringify({ recipient: { comment_id: commentId }, message: { text: message } });
  const res = graphJson(
    httpCurl(["-X", "POST", `${base}/${creds.userId}/messages?access_token=${creds.token}`, "-H", "Content-Type: application/json", "-d", body], { proxy: useProxy() }),
  );
  if (res?.message_id || res?.id) return { ok: true, id: String(res.message_id ?? res.id) };
  if (isTokenError(String(res?.error?.message ?? ""), res?.error?.code)) return { ok: false, reason: `re-auth needed: ${res.error?.message}` };
  return { ok: false, reason: `private reply failed: ${res?.error?.message ?? "unknown"}` };
}

// ── processing ───────────────────────────────────────────────────────────────
export type TriggerDecision = {
  commentId: string;
  username?: string;
  text: string;
  matchedRule?: string;
  outcome: "would_dm" | "dmd" | "skipped" | "error" | "already" | "no_match";
  reason?: string;
};

export type TriggerRun = { ok: true; decisions: TriggerDecision[]; summary: { total: number; matched: number; dmd: number; wouldDm: number; skipped: number } } | { ok: false; reason: string };

/** Run the comment→DM triggers over a channel's STORED comments. dryRun = preview. */
export async function runCommentTriggers(channel: string, opts: { dryRun?: boolean; limit?: number } = {}): Promise<TriggerRun> {
  const cfg = loadTriggerConfig(channel);
  const dryRun = !!opts.dryRun;
  const state = loadState(channel);
  const fired = new Set(state.firedCommentIds);
  const dmd = new Set(state.dmdUsers);
  const decisions: TriggerDecision[] = [];
  const summary = { total: 0, matched: 0, dmd: 0, wouldDm: 0, skipped: 0 };

  const comments = listStoredComments(channel).slice(0, Math.max(1, opts.limit ?? 200));
  for (const c of comments) {
    if (fired.has(c.id)) continue; // already processed this comment
    summary.total++;
    const rule = matchRule(cfg.rules, c.text);
    const d: TriggerDecision = { commentId: c.id, username: c.username, text: c.text, outcome: "skipped" };
    if (!rule) {
      d.outcome = "no_match";
      decisions.push(d);
      continue;
    }
    summary.matched++;
    d.matchedRule = rule.name || rule.id;
    if (rule.oncePerUser && c.username && dmd.has(c.username)) {
      d.outcome = "already";
      d.reason = "user already DM'd";
      decisions.push(d);
      if (!dryRun) fired.add(c.id);
      continue;
    }
    if (dryRun) {
      d.outcome = "would_dm";
      summary.wouldDm++;
      decisions.push(d);
      continue;
    }
    const sent = await sendPrivateReply(channel, c.id, rule.dmMessage);
    if (sent.ok) {
      d.outcome = "dmd";
      summary.dmd++;
      fired.add(c.id);
      if (c.username) dmd.add(c.username);
      if (rule.publicReply) await sendReply(channel, c.id, rule.publicReply).catch(() => undefined);
    } else {
      d.outcome = "error";
      d.reason = sent.reason;
      summary.skipped++;
    }
    decisions.push(d);
  }
  if (!dryRun) saveState(channel, { firedCommentIds: [...fired], dmdUsers: [...dmd] });
  return { ok: true, decisions, summary };
}
