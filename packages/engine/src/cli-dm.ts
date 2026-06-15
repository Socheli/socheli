/**
 * cli-dm.ts — the `content dm` command group: a friendly, one-liner CLI for the
 * Instagram DM AI responder. Wraps the comment/dm/connection/responder/ai-dm
 * tools so you never hand-write JSON:
 *
 *   content dm connect <brand> [--ig-user <id>] [--token <tok>]
 *   content dm setup   <brand> [--default draft|auto_send|flag] [--enable]
 *   content dm status  <brand>
 *   content dm pull    <brand>
 *   content dm list    <brand>
 *   content dm test    <brand>                  # dry-run: what the AI WOULD do
 *   content dm run     <brand>                  # process the inbox once (live)
 *   content dm reply   <brand> <conversationId> [--send]
 *   content dm watch   <brand> [--interval 60]  # 24/7 auto-reply loop
 *
 * Everything here goes through the one registry (callTool), so the same safety
 * gates apply: kill-switch, 24h DM window, and the never-auto sentiment guardrail.
 */

import { createInterface } from "node:readline";

import { callTool } from "./tools/registry.ts";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/* Read all of stdin (for `--json-stdin`: agents pipe JSON, zero shell-quoting). */
function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve(""); // nothing piped
    let buf = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (buf += c));
    process.stdin.on("end", () => resolve(buf));
    process.stdin.on("error", () => resolve(buf));
  });
}

/* One interactive prompt (humans). */
function ask(rl: ReturnType<typeof createInterface>, q: string): Promise<string> {
  return new Promise((res) => rl.question(q, (a) => res(a.trim())));
}

type TriggerRuleInput = { id: string; name: string; keywords: string[]; anyComment: boolean; dmMessage: string; publicReply?: string; oncePerUser: boolean; enabled: boolean };

function ruleFromFlags(flags: Flags): TriggerRuleInput {
  const kw = typeof flags.keywords === "string" ? flags.keywords.split(",").map((s) => s.trim()).filter(Boolean) : [];
  return {
    id: `r_${Date.now().toString(36)}`,
    name: typeof flags["rule-name"] === "string" ? flags["rule-name"] : typeof flags.name === "string" ? flags.name : "",
    keywords: kw,
    anyComment: !!flags.any,
    dmMessage: typeof flags.dm === "string" ? flags.dm : "",
    publicReply: typeof flags.reply === "string" ? flags.reply : undefined,
    oncePerUser: flags.once !== false, // default true
    enabled: true,
  };
}

/* Normalize a single-rule JSON object (accepts dm/dmMessage, reply/publicReply). */
function ruleFromJson(o: any): TriggerRuleInput {
  return {
    id: String(o.id ?? `r_${Date.now().toString(36)}`),
    name: String(o.name ?? ""),
    keywords: Array.isArray(o.keywords) ? o.keywords.map(String) : [],
    anyComment: !!o.anyComment,
    dmMessage: String(o.dmMessage ?? o.dm ?? ""),
    publicReply: o.publicReply ?? o.reply ?? undefined,
    oncePerUser: o.oncePerUser !== false,
    enabled: o.enabled !== false,
  };
}

/* Merge one rule into the channel's existing trigger config (replace by name if
   it exists, else append), optionally flipping the master switch on. */
async function mergeRule(channel: string, rule: TriggerRuleInput, enable?: boolean): Promise<{ enabled: boolean; rules: TriggerRuleInput[] }> {
  const cur = data(await call("ctrigger_get", { channel }))?.config ?? { enabled: false, rules: [] };
  const rules: TriggerRuleInput[] = [...(cur.rules ?? [])];
  const i = rule.name ? rules.findIndex((r) => r.name === rule.name) : -1;
  if (i >= 0) rules[i] = rule;
  else rules.push(rule);
  return { enabled: enable ?? cur.enabled ?? false, rules };
}

/* `content dm triggers set <brand>` — three input modes:
   1) FLAGS   : --keywords a,b --dm "<msg>" [--reply "<msg>"] [--any] [--enabled]
   2) JSON    : --json '<…>'  or  (agent-friendly, no quoting) echo '<…>' | … --json-stdin
   3) INTERACTIVE: no flags in a terminal → guided prompts. */
async function triggersSet(channel: string, flags: Flags): Promise<number> {
  // ── JSON mode (full config {rules:[…]} or a single rule) ───────────────────
  let jsonStr = typeof flags.json === "string" ? flags.json : "";
  if (flags["json-stdin"] === true || jsonStr === "-") jsonStr = await readStdin();
  if (jsonStr.trim()) {
    let parsed: any;
    try {
      parsed = JSON.parse(jsonStr);
    } catch (e) {
      console.log(`✗ invalid JSON: ${e instanceof Error ? e.message : String(e)}`);
      return 1;
    }
    const cfg = Array.isArray(parsed.rules)
      ? { channel, enabled: parsed.enabled !== false, rules: parsed.rules.map(ruleFromJson) }
      : { channel, ...(await mergeRule(channel, ruleFromJson(parsed), true)) };
    const r = await call("ctrigger_set", cfg);
    console.log(r.ok ? `✓ ${r.message}` : `✗ ${r.message}`);
    return r.ok ? 0 : 1;
  }

  // ── Flag mode ──────────────────────────────────────────────────────────────
  if (flags.keywords !== undefined || flags.dm !== undefined || flags.any === true) {
    const rule = ruleFromFlags(flags);
    if (!rule.dmMessage) {
      console.log('✗ --dm "<message>" is required (the DM sent to commenters).');
      return 1;
    }
    if (!rule.keywords.length && !rule.anyComment) {
      console.log("✗ pass --keywords a,b (or --any to fire on every comment).");
      return 1;
    }
    const cfg = await mergeRule(channel, rule, flags.enabled === true ? true : undefined);
    const r = await call("ctrigger_set", { channel, ...cfg });
    console.log(r.ok ? `✓ rule "${rule.name || rule.id}" saved · ${cfg.enabled ? "ENABLED" : "disabled (add --enabled to go live)"}` : `✗ ${r.message}`);
    return r.ok ? 0 : 1;
  }

  // ── Interactive mode (terminal) ──────────────────────────────────────────────
  if (process.stdin.isTTY) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    console.log(`Set up a comment→DM trigger for ${channel}.  (Ctrl-C to cancel)\n`);
    const kw = await ask(rl, "Keywords that trigger it (comma-separated), or 'any' for every comment: ");
    const dm = await ask(rl, "DM message to send (the link/CTA): ");
    if (!dm) {
      console.log("✗ a DM message is required.");
      rl.close();
      return 1;
    }
    const reply = await ask(rl, "Public comment reply (optional, Enter to skip): ");
    const name = await ask(rl, "Rule name (optional): ");
    const en = (await ask(rl, "Enable it now? (y/N): ")).toLowerCase().startsWith("y");
    rl.close();
    const isAny = kw.toLowerCase() === "any";
    const rule: TriggerRuleInput = {
      id: `r_${Date.now().toString(36)}`,
      name,
      keywords: isAny ? [] : kw.split(",").map((s) => s.trim()).filter(Boolean),
      anyComment: isAny,
      dmMessage: dm,
      publicReply: reply || undefined,
      oncePerUser: true,
      enabled: true,
    };
    const cfg = await mergeRule(channel, rule, en ? true : undefined);
    const r = await call("ctrigger_set", { channel, ...cfg });
    console.log(r.ok ? `\n✓ trigger saved${cfg.enabled ? " and ENABLED" : " (disabled — enable when ready)"}.` : `✗ ${r.message}`);
    return r.ok ? 0 : 1;
  }

  console.log(`usage: content dm triggers set <brand> --keywords a,b --dm "<msg>" [--reply "<msg>"] [--any] [--enabled]
       agents (no quoting):  printf '%s' '<json>' | content dm triggers set <brand> --json-stdin
       humans:               run in a terminal with no flags for guided prompts.`);
  return 1;
}

type Flags = Record<string, string | boolean>;
function parse(argv: string[]): { pos: string[]; flags: Flags } {
  const pos: string[] = [];
  const flags: Flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else flags[key] = true;
    } else pos.push(a);
  }
  return { pos, flags };
}

const data = (r: { ok: boolean; data?: any; message?: string }): any => (r.ok ? r.data : undefined);

async function call(name: string, input: Record<string, unknown>) {
  return callTool(name, input);
}

function usage(): number {
  console.log(`content dm — Instagram DM AI responder

  connect <brand> [--ig-user <id>] [--token <tok>]   link the brand's IG account
                                                     (or set IG_USER_ID/IG_ACCESS_TOKEN in .env)
  setup   <brand> [--default draft|auto_send|flag] [--enable]
                                                     install a sensible starter responder config
  status  <brand>                                    connection + responder + inbox at a glance
  pull    <brand>                                    fetch latest DMs from Instagram
  list    <brand>                                    show open DM threads
  test    <brand>                                    DRY-RUN — what the AI would do (no sends)
  run     <brand>                                    process the inbox once (live, per your rules)
  reply   <brand> <conversationId> [--send]          AI-reply to one thread (draft, or --send)
  watch   <brand> [--interval 60]                    24/7 loop: pull + auto-reply every N seconds
  triggers <brand> [--run]                           comment a keyword -> get a DM (dry-run, or --run live)
  triggers set <brand>                               add a trigger: interactive, or --keywords a,b --dm "<msg>" [--enabled],
                                                     or pipe JSON:  echo '{…}' | content dm triggers set <brand> --json-stdin
  login   <brand> [--code <c> --state <s>]           connect via Instagram Login (NO Facebook Page):
                                                     run without --code to print the authorize URL,
                                                     then re-run with the returned --code + --state
  refresh <brand>                                    extend the connection's token (works for both
                                                     Facebook-Login and Instagram-Login flavors)
  app     status | set --app-id <id> --app-secret <secret> | clear
                                                     Bring Your Own Meta app for this workspace
                                                     (overrides the instance default; works locally too)
  app-ig  status | set --app-id <id> --app-secret <secret> | clear
                                                     Bring Your Own Instagram app (Instagram Login flow;
                                                     App Dashboard → Instagram → API setup with Instagram login)

Channels: run 'content channels' to list brand ids.`);
  return 1;
}

export async function runDmCommand(argv: string[]): Promise<number> {
  const { pos, flags } = parse(argv);
  const sub = pos[0];
  const channel = pos[1];
  if (!sub) return usage();

  // `dm app …` is workspace-scoped (Bring-Your-Own Meta app) — no channel needed.
  if (sub === "app") {
    const action = pos[1] ?? "status";
    if (action === "set") {
      const appId = flags["app-id"] as string;
      const appSecret = flags["app-secret"] as string;
      if (!appId || !appSecret) {
        console.log(`usage: content dm app set --app-id <id> --app-secret <secret>\n  (use your own Meta app for this workspace; redirect stays the instance's callback)`);
        return 1;
      }
      const r = await call("meta_app_set", { appId, appSecret });
      console.log(r.ok ? `✓ workspace Meta app set (App ID ${appId}, source: workspace)` : `✗ ${r.message}`);
      return r.ok ? 0 : 1;
    }
    if (action === "clear") {
      const r = await call("meta_app_clear", {});
      console.log(r.ok ? `✓ ${r.message} — now using the instance default app` : `✗ ${r.message}`);
      return r.ok ? 0 : 1;
    }
    const s = data(await call("meta_app_status", {})) ?? {};
    console.log(`■ Meta app — workspace ${s.workspaceId ?? "?"}\n`);
    console.log(`  source   : ${s.source}  ${s.source === "workspace" ? "(your own app)" : s.source === "env" ? "(instance default)" : "(none configured)"}`);
    console.log(`  App ID   : ${s.appId || "—"}`);
    console.log(`  redirect : ${s.redirectConfigured ? s.redirect : "— (set META_OAUTH_REDIRECT)"}`);
    if (!s.configured) console.log(`\n  Set your own:  content dm app set --app-id <id> --app-secret <secret>`);
    return 0;
  }

  // `dm app-ig …` — Bring-Your-Own Instagram app (Instagram Login flow). Also
  // workspace-scoped, no channel. The Instagram App ID/Secret are DISTINCT from
  // the Meta/Facebook ones (App Dashboard → Instagram → API setup with Instagram login).
  if (sub === "app-ig") {
    const action = pos[1] ?? "status";
    if (action === "set") {
      const appId = flags["app-id"] as string;
      const appSecret = flags["app-secret"] as string;
      if (!appId || !appSecret) {
        console.log(`usage: content dm app-ig set --app-id <id> --app-secret <secret>\n  (your Instagram app for the Instagram Login flow; redirect stays the instance's /api/connections/ig-callback)`);
        return 1;
      }
      const r = await call("ig_app_set", { appId, appSecret });
      console.log(r.ok ? `✓ workspace Instagram app set (App ID ${appId}, source: workspace)` : `✗ ${r.message}`);
      return r.ok ? 0 : 1;
    }
    if (action === "clear") {
      const r = await call("ig_app_clear", {});
      console.log(r.ok ? `✓ ${r.message} — now using the instance default Instagram app` : `✗ ${r.message}`);
      return r.ok ? 0 : 1;
    }
    const s = data(await call("ig_app_status", {})) ?? {};
    console.log(`■ Instagram app — workspace ${s.workspaceId ?? "?"}\n`);
    console.log(`  source   : ${s.source}  ${s.source === "workspace" ? "(your own app)" : s.source === "env" ? "(instance default)" : "(none configured)"}`);
    console.log(`  App ID   : ${s.appId || "—"}`);
    console.log(`  redirect : ${s.redirectConfigured ? s.redirect : "— (set INSTAGRAM_OAUTH_REDIRECT, must end in /api/connections/ig-callback)"}`);
    if (!s.configured) console.log(`\n  Set your own:  content dm app-ig set --app-id <id> --app-secret <secret>`);
    return 0;
  }

  if (sub !== "help" && !channel) {
    console.log(`usage: content dm ${sub} <brand>`);
    return 1;
  }

  switch (sub) {
    case "connect": {
      const ig = (flags["ig-user"] as string) || process.env.IG_USER_ID;
      const token = (flags.token as string) || process.env.IG_ACCESS_TOKEN;
      if (!ig || !token) {
        console.log(`Need an IG Business account id + a long-lived token (scope: instagram_manage_messages).
  Either:  content dm connect ${channel} --ig-user <id> --token <token>
  Or set IG_USER_ID + IG_ACCESS_TOKEN in .env and re-run.
  (Tip: a token on the command line lands in your shell history — .env is safer.)`);
        return 1;
      }
      const r = await call("connect_paste", { channel, igUserId: ig, token });
      if (!r.ok) {
        console.log(`✗ connect failed: ${r.message}`);
        return 1;
      }
      console.log(`✓ connected ${channel}`);
      const st = data(await call("connection_status", { channel }));
      if (st) console.log(`  account: @${st.username ?? "?"}  ·  status: ${st.status ?? "?"}`);
      return 0;
    }

    case "login": {
      // Instagram Login (NO Facebook Page). Two-step CLI OAuth:
      //   1) no --code → print the authorize URL + state to open in a browser.
      //   2) re-run with --code + --state → exchange for the long-lived IG token.
      const code = flags.code as string;
      const state = flags.state as string;
      if (!code) {
        const d = data(await call("connect_ig_start", { channel }));
        if (!d?.url) {
          console.log(`✗ could not start Instagram Login: is INSTAGRAM_APP_ID set (or run 'content dm app-ig set …')?`);
          return 1;
        }
        console.log(`Open this URL, authorize your Instagram Business/Creator account, then copy the\n\`code\` and \`state\` from the redirect URL and re-run:\n`);
        console.log(`  ${d.url}\n`);
        console.log(`Then:  content dm login ${channel} --code <code> --state ${d.state}`);
        return 0;
      }
      if (!state) {
        console.log(`usage: content dm login ${channel} --code <code> --state <state>\n  (re-run 'content dm login ${channel}' without --code to get a fresh authorize URL + state)`);
        return 1;
      }
      const r = await call("connect_ig_callback", { channel, code, state });
      if (!r.ok) {
        console.log(`✗ Instagram Login failed: ${r.message}`);
        return 1;
      }
      console.log(`✓ connected ${channel} via Instagram Login`);
      const st = data(await call("connection_status", { channel }));
      if (st) console.log(`  account: @${st.username ?? "?"}  ·  status: ${st.status ?? "?"}`);
      return 0;
    }

    case "refresh": {
      // ONE command for both flavors — the engine's connection_refresh branches
      // on the connection's authType (fb_exchange_token vs ig_refresh_token).
      const r = await call("connection_refresh", { channel });
      if (!r.ok) {
        console.log(`✗ refresh failed: ${r.message}`);
        return 1;
      }
      const st = data(await call("connection_status", { channel })) ?? {};
      console.log(`✓ token refreshed for ${channel}`);
      console.log(`  status: ${st.status ?? "?"}${st.expiresInDays != null ? `  ·  expires in ~${st.expiresInDays} day(s)` : ""}`);
      return 0;
    }

    case "setup": {
      const def = String(flags.default ?? "draft");
      const enable = !!flags.enable;
      const rules = [
        { id: "thanks", name: "thanks & hype", match: { keywords: ["thanks", "thank you", "love", "amazing", "awesome", "fire", "🔥", "🙌"], channel: "dm" }, action: "auto_send" },
        { id: "questions", name: "questions", match: { keywords: ["how", "what", "when", "where", "can you", "do you", "?"], channel: "dm" }, action: "draft" },
        { id: "pricing", name: "pricing & collab", match: { keywords: ["price", "cost", "charge", "rate", "hire", "freelance", "collab", "partnership", "sponsor"], channel: "dm" }, action: "draft" },
      ];
      const r = await call("responder_set", { channel, enabled: enable, defaultAction: def, rules });
      if (!r.ok) {
        console.log(`✗ setup failed: ${r.message}`);
        return 1;
      }
      console.log(`✓ responder configured for ${channel}`);
      console.log(`  rules: thanks→auto-send · questions→draft · pricing→draft · default→${def}`);
      console.log(`  complaints/risky are always flagged (never auto-sent).`);
      console.log(`  status: ${enable ? "ENABLED" : "disabled — add --enable to turn it on"}`);
      console.log(`\nNext:  content dm test ${channel}   (dry-run)  ·  content dm watch ${channel}   (24/7)`);
      return 0;
    }

    case "status": {
      const conn = data(await call("connection_status", { channel })) ?? {};
      const cfg = data(await call("responder_get", { channel }))?.config ?? {};
      const th = data(await call("aidm_threads", { channel })) ?? {};
      console.log(`■ DM status — ${channel}\n`);
      console.log(`  connection : ${conn.status ? `${conn.status} (@${conn.username ?? "?"})` : "not connected — run: content dm connect " + channel}`);
      console.log(`  responder  : ${cfg.enabled ? "ENABLED" : "disabled"} · default ${cfg.defaultAction ?? "?"} · ${(cfg.rules ?? []).length} rule(s)`);
      console.log(`  inbox      : ${th.count ?? 0} thread(s), ${th.needReply ?? 0} need a reply`);
      return 0;
    }

    case "pull": {
      const r = await call("aidm_pull", { channel });
      console.log(r.ok ? `✓ ${r.message}` : `✗ ${r.message}`);
      return r.ok ? 0 : 1;
    }

    case "list": {
      const d = data(await call("aidm_threads", { channel }));
      if (!d) return 1;
      console.log(`■ DM threads — ${channel} (${d.count}, ${d.needReply} need reply)\n`);
      for (const t of d.threads ?? []) {
        const mark = t.needsReply ? "●" : " ";
        const win = t.windowOpen ? "" : "  (24h window closed)";
        console.log(`  ${mark} @${t.username ?? "?"}  [${t.conversationId}]${win}\n      ${String(t.lastMessage).slice(0, 80)}`);
      }
      return 0;
    }

    case "test":
    case "run": {
      const dry = sub === "test";
      const r = await call(dry ? "responder_test" : "responder_run", { channel, scope: "dm" });
      if (!r.ok) {
        console.log(`✗ ${r.message}`);
        return 1;
      }
      const d = r.data as any;
      const s = d.summary ?? {};
      console.log(`${dry ? "DRY-RUN" : "LIVE"} — ${channel}: ${s.total ?? 0} item(s)`);
      for (const x of d.decisions ?? []) {
        const who = x.username ? `@${x.username}` : x.itemId;
        console.log(`  ${x.outcome}  ${who}  (${x.classification?.sentiment ?? "?"})`);
        if (x.reply) console.log(`      “${String(x.reply).slice(0, 120)}”`);
      }
      console.log(dry ? `\n→ ${s.wouldSend ?? 0} would send, ${s.wouldDraft ?? 0} draft, ${s.wouldFlag ?? 0} flag` : `\n→ ${s.sent ?? 0} sent, ${s.drafted ?? 0} drafted, ${s.flagged ?? 0} flagged`);
      return 0;
    }

    case "reply": {
      const conversationId = pos[2];
      if (!conversationId) {
        console.log(`usage: content dm reply ${channel} <conversationId> [--send]`);
        return 1;
      }
      const r = await call("aidm_reply", { channel, conversationId, send: !!flags.send });
      if (!r.ok) {
        console.log(`✗ ${r.message}`);
        return 1;
      }
      const rd = r.data as any;
      console.log(`✓ AI ${rd.outcome}: “${String(rd.reply).slice(0, 160)}”${rd.reason ? `  (${rd.reason})` : ""}`);
      return 0;
    }

    case "triggers": {
      // `content dm triggers set <brand> …` (interactive | flags | --json-stdin)
      if (pos[1] === "set") {
        const ch = pos[2];
        if (!ch) {
          console.log('usage: content dm triggers set <brand>  [--keywords a,b --dm "<msg>" | --json-stdin | interactive]');
          return 1;
        }
        return triggersSet(ch, flags);
      }
      // `content dm triggers <brand> [--run]` — status + dry-run/live
      const cfg = data(await call("ctrigger_get", { channel }))?.config ?? {};
      console.log(`■ comment→DM triggers — ${channel}: ${cfg.enabled ? "ENABLED" : "disabled"}, ${(cfg.rules ?? []).length} rule(s)`);
      for (const ru of cfg.rules ?? []) console.log(`  · ${ru.name || ru.id}: ${ru.anyComment ? "any comment" : (ru.keywords ?? []).join(", ")} → DM "${String(ru.dmMessage).slice(0, 50)}"`);
      const live = !!flags.run;
      const r = await call(live ? "ctrigger_run" : "ctrigger_test", { channel });
      if (!r.ok) {
        console.log(`✗ ${r.message}`);
        return 1;
      }
      const d = r.data as any;
      const s = d.summary ?? {};
      console.log(`\n${live ? "LIVE" : "DRY-RUN"}: ${s.total ?? 0} unprocessed comment(s), ${s.matched ?? 0} matched → ${live ? `${s.dmd ?? 0} DM'd` : `${s.wouldDm ?? 0} would DM`}`);
      for (const x of (d.decisions ?? []).filter((y: any) => y.outcome !== "no_match").slice(0, 12)) console.log(`  ${x.outcome}  @${x.username ?? "?"} (rule: ${x.matchedRule ?? "—"})${x.reason ? `  ${x.reason}` : ""}`);
      if (!live && (s.wouldDm ?? 0) > 0) console.log(`\n→ send for real:  content dm triggers ${channel} --run   (needs the master switch enabled via ctrigger_set)`);
      return 0;
    }

    case "watch": {
      const intervalSec = Math.max(15, Number(flags.interval ?? 60));
      const cfg = data(await call("responder_get", { channel }))?.config ?? {};
      if (!cfg.enabled) {
        console.log(`✗ responder for ${channel} is disabled. Enable it first:\n    content dm setup ${channel} --enable`);
        return 1;
      }
      console.log(`▶ watching ${channel} — pulling + auto-replying every ${intervalSec}s (Ctrl-C to stop)`);
      console.log(`  rules apply: thanks→auto-send, others→draft, complaints→flag. Kill-switch + 24h window enforced.\n`);
      for (;;) {
        try {
          // Re-check enabled each cycle so disabling it stops the loop's sends.
          const live = data(await call("responder_get", { channel }))?.config ?? {};
          if (!live.enabled) {
            console.log(`[${new Date().toISOString()}] responder disabled — pausing sends (still polling).`);
          } else {
            await call("aidm_pull", { channel }); // pull BEFORE run so sent replies aren't re-sent
            const r = await call("responder_run", { channel, scope: "dm" });
            const s = r.ok ? (r.data as any).summary : null;
            console.log(`[${new Date().toISOString()}] ${s ? `sent ${s.sent}, drafted ${s.drafted}, flagged ${s.flagged} (of ${s.total})` : "✗ " + r.message}`);
          }
        } catch (e) {
          console.log(`[${new Date().toISOString()}] cycle error: ${e instanceof Error ? e.message : String(e)}`);
        }
        await sleep(intervalSec * 1000);
      }
    }

    case "help":
    default:
      return usage();
  }
}
