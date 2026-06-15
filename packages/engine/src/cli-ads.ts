/**
 * cli-ads.ts — the `content ads` command group: a friendly, one-liner CLI for
 * Instagram boosts (paid amplification). Wraps the ads_* registry tools so you
 * never hand-write JSON:
 *
 *   content ads plan    <channel> <itemId>
 *   content ads create  <channel> <itemId> --budget <usd> [--days 7] [--countries US,DE]
 *   content ads approve <id>
 *   content ads launch  <id> [--live]      # no --live = dry-run preview, never spends
 *   content ads pause   <id>
 *   content ads status  <id>
 *   content ads list    [channel] [--status x]
 *   content ads budget  [--kill on|off] [--total <usd>] [--per-channel <usd>]
 *                       [--channel <id> --cap <usd> --account <id>]
 *
 * Everything here goes through the one registry (callTool), so the same spend
 * gates apply: draft → human approval → dry-run-by-default launch, the ads
 * kill switch (ON by default), daily caps, and DSA checks. The Meta ads token
 * lives ONLY in env (META_ADS_TOKEN) and is redacted in every preview.
 */

import { callTool } from "./tools/registry.ts";

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

async function call(name: string, input: Record<string, unknown>) {
  return callTool(name, input);
}

const usd = (n: unknown) => (typeof n === "number" ? `$${n.toFixed(2)}` : "—");

function printRecord(rec: any): void {
  if (!rec) return;
  console.log(`  ${rec.id}  [${rec.status}]  ${rec.channel} · item ${rec.itemId}`);
  console.log(`    budget : ${usd(rec.dailyBudgetUsd)}/day × ${rec.durationDays} day(s) → ${(rec.targeting?.countries ?? []).join(", ")}`);
  console.log(`    media  : ${rec.igMediaId}`);
  if (rec.approval) console.log(`    approved: ${rec.approval.approvedAt} by ${rec.approval.approvedBy}`);
  if (rec.metaIds?.campaignId) console.log(`    meta   : campaign ${rec.metaIds.campaignId}${rec.metaIds.adId ? ` · ad ${rec.metaIds.adId}` : ""}`);
  if (rec.error) console.log(`    error  : ${rec.error}`);
}

function printGate(gate: any): void {
  if (!gate) return;
  if (gate.allowed) {
    console.log(`  gate: OPEN — a launch with --live would spend real money.`);
    return;
  }
  console.log(`  gate: BLOCKED — ${gate.reasons?.length ?? 0} reason(s):`);
  for (const r of gate.reasons ?? []) console.log(`    ✗ ${r}`);
}

function printCalls(calls: any[]): void {
  if (!calls?.length) return;
  console.log(`\n  dry-run preview — the exact Meta calls a live launch would make (token redacted):`);
  for (const c of calls) {
    console.log(`\n  [${c.step}] ${c.method} ${c.path}`);
    for (const [k, v] of Object.entries(c.body ?? {})) console.log(`      ${k} = ${v}`);
  }
}

function usage(): number {
  console.log(`content ads — Instagram boosts (paid amplification; gated, dry-run by default)

  plan    <channel> <itemId>                       AI-draft a boost plan (advisory, spends nothing)
  create  <channel> <itemId> --budget <usd> [--days 7] [--countries US,DE]
                                                   create a DRAFT record (never calls Meta)
  approve <id>                                     human approval gate (still spends nothing)
  launch  <id> [--live]                            no --live = dry-run preview + gate reasons;
                                                   --live executes ONLY when the gate is open. SPENDS MONEY.
  pause   <id>                                     pause a live boost (stops spend)
  status  <id>                                     record + gate + fresh insights from Meta
  list    [channel] [--status draft|approved|live|paused|completed|failed]
  budget  [--kill on|off] [--total <usd>] [--per-channel <usd>]
          [--channel <id> --cap <usd> --account <id>]
                                                   the spend controls (kill switch ships ON)

Channels: run 'content channels' to list brand ids.`);
  return 1;
}

export async function runAdsCommand(args: string[]): Promise<number> {
  const { pos, flags } = parse(args);
  const sub = pos[0];
  if (!sub) return usage();

  switch (sub) {
    case "plan": {
      const [, channel, itemId] = pos;
      if (!channel || !itemId) {
        console.log(`usage: content ads plan <channel> <itemId>`);
        return 1;
      }
      const r = await call("ads_plan", { channel, itemId });
      if (!r.ok) {
        console.log(`✗ ${r.message}`);
        return 1;
      }
      const d = r.data as any;
      console.log(`■ boost plan — ${channel} · ${d.item?.id}\n`);
      console.log(`  topic    : ${d.item?.topic ?? "?"}`);
      if (d.item?.hook) console.log(`  hook     : ${d.item.hook}`);
      console.log(`  media    : ${d.igMediaId ?? "— (not published to Instagram)"}`);
      console.log(`  boostable: ${d.boostable ? "yes" : `NO — ${d.reason}`}`);
      console.log(`\n  suggested: ${usd(d.plan?.suggestedDailyBudgetUsd)}/day × ${d.plan?.suggestedDurationDays} day(s) → ${(d.plan?.suggestedCountries ?? []).join(", ")}`);
      console.log(`  rationale: ${d.plan?.rationale}`);
      if (d.plan?.hookNote) console.log(`  hook note: ${d.plan.hookNote}`);
      if (d.boostable) console.log(`\nNext:  content ads create ${channel} ${d.item?.id} --budget ${d.plan?.suggestedDailyBudgetUsd}`);
      return 0;
    }

    case "create": {
      const [, channel, itemId] = pos;
      const budget = Number(flags.budget);
      if (!channel || !itemId || !Number.isFinite(budget) || budget <= 0) {
        console.log(`usage: content ads create <channel> <itemId> --budget <usd> [--days 7] [--countries US,DE]`);
        return 1;
      }
      const input: Record<string, unknown> = { channel, itemId, dailyBudgetUsd: budget };
      if (flags.days !== undefined) input.durationDays = Number(flags.days);
      if (typeof flags.countries === "string") input.countries = flags.countries.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
      const r = await call("ads_create", input);
      if (!r.ok) {
        console.log(`✗ ${r.message}`);
        return 1;
      }
      const rec = (r.data as any)?.record;
      console.log(`✓ draft created (spends nothing until approved + launched --live)\n`);
      printRecord(rec);
      console.log(`\nNext:  content ads approve ${rec?.id}   then   content ads launch ${rec?.id}   (dry-run)`);
      return 0;
    }

    case "approve": {
      const id = pos[1];
      if (!id) {
        console.log(`usage: content ads approve <id>`);
        return 1;
      }
      const r = await call("ads_approve", { id });
      if (!r.ok) {
        console.log(`✗ ${r.message}`);
        return 1;
      }
      console.log(`✓ ${r.message}`);
      return 0;
    }

    case "launch": {
      const id = pos[1];
      if (!id) {
        console.log(`usage: content ads launch <id> [--live]   (no --live = dry-run preview, never spends)`);
        return 1;
      }
      const r = await call("ads_launch", { id, dryRun: !flags.live });
      if (!r.ok) {
        console.log(`✗ ${r.message}`);
        return 1;
      }
      const d = r.data as any;
      if (d.executed) {
        console.log(`✓ ${r.message}\n`);
        printRecord(d.record);
        console.log(`\nWatch it:  content ads status ${id}   ·   stop spend:  content ads pause ${id}`);
        return 0;
      }
      console.log(`■ launch ${id} — DRY-RUN (nothing executed, nothing spent)\n`);
      printGate(d.gate);
      printCalls(d.calls);
      if (d.gate?.allowed) console.log(`\n→ execute for real:  content ads launch ${id} --live   (SPENDS REAL MONEY)`);
      return 0;
    }

    case "pause": {
      const id = pos[1];
      if (!id) {
        console.log(`usage: content ads pause <id>`);
        return 1;
      }
      const r = await call("ads_pause", { id });
      console.log(r.ok ? `✓ ${r.message}` : `✗ ${r.message}`);
      return r.ok ? 0 : 1;
    }

    case "status": {
      const id = pos[1];
      if (!id) {
        console.log(`usage: content ads status <id>`);
        return 1;
      }
      const r = await call("ads_status", { id });
      if (!r.ok) {
        console.log(`✗ ${r.message}`);
        return 1;
      }
      const d = r.data as any;
      console.log(`■ ad status — ${id}\n`);
      printRecord(d.record);
      const ins = d.insights;
      if (ins) {
        console.log(`    insights (lifetime, fetched ${ins.fetchedAt}):`);
        console.log(`      spend ${usd(ins.spendUsd)} · impressions ${ins.impressions ?? "—"} · reach ${ins.reach ?? "—"} · clicks ${ins.clicks ?? "—"} · cpm ${ins.cpm ?? "—"} · ctr ${ins.ctr ?? "—"}`);
        for (const [k, v] of Object.entries(ins.actions ?? {})) console.log(`      action ${k}: ${v}`);
      } else {
        console.log(`    insights: — (none fetched yet)`);
      }
      console.log("");
      printGate(d.gate);
      return 0;
    }

    case "list": {
      const channel = pos[1];
      const input: Record<string, unknown> = {};
      if (channel) input.channel = channel;
      if (typeof flags.status === "string") input.status = flags.status;
      const r = await call("ads_list", input);
      if (!r.ok) {
        console.log(`✗ ${r.message}`);
        return 1;
      }
      const d = r.data as any;
      const counts = Object.entries(d.counts ?? {}).map(([k, v]) => `${v} ${k}`).join(" · ") || "none";
      console.log(`■ boosts${channel ? ` — ${channel}` : ""} (${counts})\n`);
      if (!(d.ads ?? []).length) console.log(`  no ad records${typeof flags.status === "string" ? ` with status "${flags.status}"` : ""}.`);
      for (const rec of d.ads ?? []) printRecord(rec);
      return 0;
    }

    case "budget": {
      const input: Record<string, unknown> = {};
      if (flags.kill === "on") input.killSwitch = true;
      else if (flags.kill === "off") input.killSwitch = false;
      if (flags.total !== undefined) input.totalCapUsd = Number(flags.total);
      if (flags["per-channel"] !== undefined) input.perChannelDailyCapUsd = Number(flags["per-channel"]);
      if (typeof flags.channel === "string") input.channel = flags.channel;
      if (flags.cap !== undefined) input.channelDailyCapUsd = Number(flags.cap);
      if (typeof flags.account === "string") input.adAccountId = flags.account;
      const setting = Object.keys(input).filter((k) => k !== "channel").length > 0;
      const r = await call("ads_budget", { action: setting ? "set" : "get", ...input });
      if (!r.ok) {
        console.log(`✗ ${r.message}`);
        return 1;
      }
      const d = r.data as any;
      const cfg = d.config ?? {};
      console.log(`■ ads spend controls${setting ? " (updated)" : ""}\n`);
      console.log(`  kill switch      : ${cfg.killSwitch ? "ON — all launches blocked" : "OFF"}${cfg.killSwitchReason ? `  (${cfg.killSwitchReason})` : ""}`);
      console.log(`  total cap        : ${usd(cfg.totalCapUsd)}/day across all channels`);
      console.log(`  per-channel cap  : ${usd(cfg.perChannelDailyCapUsd)}/day`);
      console.log(`  live daily budget: ${usd(d.liveDailyBudgetUsd)}`);
      console.log(`  creds configured : ${d.credsConfigured ? "yes" : "no (set META_ADS_TOKEN + account/page)"}`);
      if (d.channel) {
        const ch = d.channel;
        console.log(`\n  channel ${ch.id}:`);
        console.log(`    ad account    : ${ch.config?.adAccountId ?? "— (uses META_AD_ACCOUNT_ID)"}`);
        console.log(`    page id       : ${ch.config?.pageId ?? "— (uses the brand connection's page)"}`);
        console.log(`    daily cap     : ${ch.config?.dailyCapUsd != null ? usd(ch.config.dailyCapUsd) : "— (global per-channel cap applies)"}`);
        console.log(`    effective cap : ${Number.isFinite(ch.effectiveCapUsd) ? usd(ch.effectiveCapUsd) : "∞"}`);
      }
      return 0;
    }

    case "help":
    default:
      return usage();
  }
}
