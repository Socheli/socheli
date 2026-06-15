import { z } from "zod";

import { AdPlan, AdRecord, type AdPlan as AdPlanT } from "@os/schemas";

import { type PipelineTool, asyncResult, fail, ok, tool } from "./helpers.ts";
import {
  buildBoostCalls,
  checkSpendGate,
  effectiveChannelCapUsd,
  executeBoost,
  fetchAdInsights,
  igMediaIdFor,
  listAds,
  liveDailyBudgetUsd,
  loadAd,
  loadAdsConfig,
  loadChannelAdsConfig,
  newAdId,
  resolveAdsCreds,
  saveAd,
  saveAdsConfig,
  saveChannelAdsConfig,
  setCampaignStatus,
} from "../ads.ts";
import { getGenome } from "../dna.ts";
import { loadItem, nowIso } from "../store.ts";

/**
 * ads-tools.ts — the paid-amplification (Instagram boost) tool surface, spread
 * into the canonical registry (registry.ts pipelineTools) so MCP / HTTP / CLI /
 * SDK / the dashboard copilot all get it for free.
 *
 * GATES ARE SACRED — this surface spends REAL MONEY, so it is gated harder
 * than anything else in the registry:
 *   - records are created as drafts; a human approves (ads_approve);
 *   - ads_launch is dry-run BY DEFAULT and executes only with explicit
 *     dryRun:false AND a fully-open spend gate (kill switch OFF — it ships ON —
 *     caps allow it, admin sending not halted, creds configured, DSA fields
 *     present for EU/EEA targeting);
 *   - the Meta ads token lives ONLY in env (META_ADS_TOKEN) and is redacted as
 *     "<META_ADS_TOKEN>" in every previewed call body.
 */

// ---------------------------------------------------------------------------
// Shared input fragments
// ---------------------------------------------------------------------------

const channelArg = z.string().min(1).describe("channel/brand id (e.g. labrinox)");
const adIdArg = z.string().min(1).describe("ad record id (ad_…)");
const tenantArgs = {
  workspaceId: z.string().optional(),
  createdBy: z.string().optional(),
};

/* Heuristic AI-draft of a boost plan grounded in the Brand Genome + the item.
   Registry tools never call the LLM brain inline (long-running brain work is
   spawned via the CLI), so the plan derives from learned genome weights with a
   clear rationale instead. Advisory only — persists nothing, spends nothing. */
function draftPlan(channel: string, topic: string, hook: string | undefined): AdPlanT {
  const genome = getGenome(channel);
  const top = (traits: { value: string; weight: number }[]) =>
    [...traits].sort((a, b) => b.weight - a.weight)[0];
  const topTopic = top(genome.traits.topics);
  const topHook = top(genome.traits.hooks);
  const countries = loadChannelAdsConfig(channel).defaultCountries;
  const rationale = [
    `Boost "${topic}" as an OUTCOME_ENGAGEMENT campaign.`,
    topTopic
      ? `The brand's top learned topic affinity is "${topTopic.value}" (w=${topTopic.weight.toFixed(2)}), so paid reach should compound what the genome already says works.`
      : `No learned topic affinities yet — treat this boost as a signal-gathering test.`,
    `Start small ($5/day for 7 days in ${countries.join(", ")}), watch CPM/CTR for the first 48h, and only scale via a new approved record if engagement holds.`,
  ].join(" ");
  const hookNote = hook
    ? `Hook on the boosted media: "${hook}"${topHook ? ` — compare against the genome's top hook pattern "${topHook.value}" (w=${topHook.weight.toFixed(2)})` : ""}.`
    : undefined;
  return AdPlan.parse({
    rationale,
    suggestedDailyBudgetUsd: 5,
    suggestedDurationDays: 7,
    suggestedCountries: countries,
    ...(hookNote ? { hookNote } : {}),
  });
}

// ---------------------------------------------------------------------------
// The 8 ads_* tools
// ---------------------------------------------------------------------------

export const adsTools: PipelineTool[] = [
  tool({
    name: "ads_plan",
    description:
      "Draft a boost plan (budget/duration/countries + rationale) for one content item, grounded in the channel's Brand Genome. Advisory ONLY: persists nothing, makes no Meta calls and spends nothing. Reports whether the item is boostable (it needs a published Instagram media, and instagram_login connections cannot boost).",
    kind: "mutate",
    schema: z.object({ channel: channelArg, itemId: z.string().min(1), ...tenantArgs }).strict(),
    run: ({ channel, itemId }) => {
      const item = loadItem(itemId);
      const topic = item.idea?.topic ?? item.seedIdea;
      const hook = item.script?.hook ?? item.storyboard?.hook;
      const igMediaId = igMediaIdFor(itemId);
      const creds = resolveAdsCreds(channel);
      const igLoginBlocked = creds.reason?.startsWith("instagram_login") ? creds.reason : undefined;
      const boostable = !!igMediaId && !igLoginBlocked;
      const reason = !igMediaId
        ? "no published Instagram media — publish to Instagram first"
        : igLoginBlocked;
      const plan = draftPlan(channel, topic, hook);
      return ok(
        {
          plan,
          item: { id: item.id, topic, hook },
          igMediaId,
          boostable,
          ...(reason ? { reason } : {}),
        },
        boostable ? "boost plan drafted (advisory — nothing persisted, nothing spent)" : `not boostable: ${reason}`,
      );
    },
  }),
  tool({
    name: "ads_create",
    description:
      "Create a DRAFT boost record for one content item's published Instagram media. Drafts spend NOTHING and never call Meta — launching requires a separate human approval (ads_approve) and then an explicit ads_launch with dryRun:false. Fails if the item has no published Instagram media.",
    kind: "mutate",
    schema: z
      .object({
        channel: channelArg,
        itemId: z.string().min(1),
        dailyBudgetUsd: z.number().positive().describe("daily budget in USD (major units)"),
        durationDays: z.number().int().min(1).max(30).default(7),
        countries: z.array(z.string()).default(["US"]).describe("ISO-3166-1 alpha-2 country codes"),
        ageMin: z.number().int().min(13).max(65).optional(),
        ageMax: z.number().int().min(13).max(65).optional(),
        dsaBeneficiary: z.string().optional().describe("DSA beneficiary — required for EU/EEA targeting"),
        dsaPayor: z.string().optional().describe("DSA payor — required for EU/EEA targeting"),
        plan: AdPlan.optional().describe("the ads_plan draft to attach for provenance"),
        ...tenantArgs,
      })
      .strict(),
    run: ({ channel, itemId, dailyBudgetUsd, durationDays, countries, ageMin, ageMax, dsaBeneficiary, dsaPayor, plan, workspaceId, createdBy }) => {
      const igMediaId = igMediaIdFor(itemId);
      if (!igMediaId) return fail(`no published Instagram media for ${itemId} — publish to Instagram first`);
      const record = saveAd(
        AdRecord.parse({
          ...(workspaceId ? { workspaceId } : {}),
          ...(createdBy ? { createdBy } : {}),
          id: newAdId(),
          channel,
          itemId,
          igMediaId,
          dailyBudgetUsd,
          durationDays,
          targeting: { countries, ageMin, ageMax, dsaBeneficiary, dsaPayor },
          status: "draft",
          ...(plan ? { plan } : {}),
          createdAt: nowIso(),
          updatedAt: nowIso(),
          log: [{ at: nowIso(), msg: `draft created: $${dailyBudgetUsd}/day × ${durationDays}d → ${countries.join(", ")}` }],
        }),
      );
      return ok({ record }, `draft ${record.id} created — approve with ads_approve, then launch (dry-run first) with ads_launch`);
    },
  }),
  tool({
    name: "ads_approve",
    description:
      "Approve a DRAFT boost record (the human spend-approval gate). Approving does NOT launch anything and spends nothing — launching is a separate explicit step (ads_launch with dryRun:false) that is still gated by the kill switch, caps and creds.",
    kind: "mutate",
    schema: z.object({ id: adIdArg, approvedBy: z.string().optional(), ...tenantArgs }).strict(),
    run: ({ id, approvedBy }) => {
      const rec = loadAd(id);
      if (!rec) return fail(`no ad record ${id}`);
      if (rec.status !== "draft") return fail(`only a draft can be approved — ${id} is "${rec.status}"`);
      rec.status = "approved";
      rec.approval = { approvedAt: nowIso(), approvedBy: approvedBy ?? "operator" };
      rec.log.push({ at: nowIso(), msg: `approved by ${rec.approval.approvedBy}` });
      const record = saveAd(rec);
      return ok({ record }, `${id} approved — launch is a separate step: ads_launch ${id} (dry-run by default; dryRun:false to spend)`);
    },
  }),
  tool({
    name: "ads_launch",
    description:
      "Launch an approved boost. Executes ONLY an approved record, only with dryRun:false, only when the ads kill switch is off, caps allow it and Meta creds are configured — otherwise returns the exact dry-run API-call preview and the blocking reasons. Spends real money when executed.",
    kind: "mutate",
    schema: z
      .object({
        id: adIdArg,
        dryRun: z.boolean().default(true).describe("true (default) = preview the exact Meta calls; false = SPEND REAL MONEY"),
        ...tenantArgs,
      })
      .strict(),
    run: ({ id, dryRun }) => {
      const rec = loadAd(id);
      if (!rec) return fail(`no ad record ${id}`);
      const gate = checkSpendGate(rec);
      const creds = resolveAdsCreds(rec.channel);
      if (dryRun || !gate.allowed) {
        return ok(
          { executed: false, dryRun: true, gate, calls: buildBoostCalls(rec, creds), record: rec },
          gate.allowed
            ? "dry-run preview — gate is OPEN; re-run with dryRun:false to spend"
            : `blocked: ${gate.reasons.join(" · ")}`,
        );
      }
      return asyncResult(
        executeBoost(rec).then((r) =>
          r.status === "live"
            ? ok({ executed: true, record: r }, `boost LIVE — $${r.dailyBudgetUsd.toFixed(2)}/day for ${r.durationDays} day(s)`)
            : fail(r.error ?? "boost failed (created ids kept; campaign stays PAUSED — no orphan spend)"),
        ),
      );
    },
  }),
  tool({
    name: "ads_pause",
    description: "Pause a LIVE boost: sets the Meta campaign to PAUSED and marks the record paused (stops further spend).",
    kind: "mutate",
    schema: z.object({ id: adIdArg, ...tenantArgs }).strict(),
    run: ({ id }) => {
      const rec = loadAd(id);
      if (!rec) return fail(`no ad record ${id}`);
      if (rec.status !== "live") return fail(`only a live boost can be paused — ${id} is "${rec.status}"`);
      return asyncResult(
        setCampaignStatus(rec, "PAUSED").then(() => {
          rec.status = "paused";
          rec.pausedAt = nowIso();
          const record = saveAd(rec);
          return ok({ record }, `${id} paused — campaign ${record.metaIds.campaignId} is PAUSED`);
        }),
      );
    },
  }),
  tool({
    name: "ads_status",
    description:
      "Get one boost record with its spend gate verdict, refreshing lifetime insights (impressions/reach/spend/clicks/cpm/ctr/actions) from Meta when the boost has run (refresh:true, the default). Flips an expired live boost to completed. Read-only on Meta — never spends.",
    kind: "read",
    schema: z
      .object({
        id: adIdArg,
        refresh: z.boolean().default(true).describe("fetch + persist a fresh insights snapshot from Meta"),
        ...tenantArgs,
      })
      .strict(),
    run: ({ id, refresh }) => {
      let rec = loadAd(id);
      if (!rec) return fail(`no ad record ${id}`);
      if (rec.status === "live" && rec.launchedAt && Date.now() > Date.parse(rec.launchedAt) + rec.durationDays * 24 * 60 * 60 * 1000) {
        rec.status = "completed";
        rec.completedAt = nowIso();
        rec.log.push({ at: nowIso(), msg: `completed: ${rec.durationDays}-day flight elapsed` });
        rec = saveAd(rec);
      }
      const canRefresh = refresh && ["live", "paused", "completed"].includes(rec.status) && !!rec.metaIds.adId;
      if (!canRefresh) return ok({ record: rec, insights: rec.insights, gate: checkSpendGate(rec) });
      const current = rec;
      return asyncResult(
        fetchAdInsights(current)
          .then((insights) => {
            current.insights = insights;
            const record = saveAd(current);
            return ok({ record, insights, gate: checkSpendGate(record) }, `insights refreshed (spend $${insights.spendUsd?.toFixed(2) ?? "0.00"})`);
          })
          .catch((e) => fail(e)),
      );
    },
  }),
  tool({
    name: "ads_list",
    description: "List boost records (newest first), optionally filtered by channel and/or status, with counts per status. Read-only.",
    kind: "read",
    schema: z
      .object({
        channel: channelArg.optional(),
        status: z.enum(["draft", "approved", "live", "paused", "completed", "failed"]).optional(),
        ...tenantArgs,
      })
      .strict(),
    run: ({ channel, status }) => {
      const ads = listAds(channel, status);
      const counts: Record<string, number> = {};
      for (const a of listAds(channel)) counts[a.status] = (counts[a.status] ?? 0) + 1;
      return ok({ ads, counts }, `${ads.length} ad record(s)`);
    },
  }),
  tool({
    name: "ads_budget",
    description:
      "Get or set the ads spend controls: the global kill switch (ON by default — nothing launches while it's on), the total and per-channel daily caps, and a channel's ad account / tighter cap. action:'set' patches ONLY the provided fields; never touches tokens (META_ADS_TOKEN lives in env only).",
    kind: "mutate",
    schema: z
      .object({
        action: z.enum(["get", "set"]).default("get"),
        killSwitch: z.boolean().optional().describe("global ads kill switch — true halts all launches"),
        killSwitchReason: z.string().optional(),
        totalCapUsd: z.number().nonnegative().optional().describe("max summed live daily budget across ALL channels"),
        perChannelDailyCapUsd: z.number().nonnegative().optional().describe("max summed live daily budget per channel"),
        channel: channelArg.optional(),
        channelDailyCapUsd: z.number().nonnegative().optional().describe("tighter per-channel cap (requires channel)"),
        adAccountId: z.string().optional().describe("numeric Meta ad account id WITHOUT act_ (requires channel)"),
        ...tenantArgs,
      })
      .strict(),
    run: ({ action, killSwitch, killSwitchReason, totalCapUsd, perChannelDailyCapUsd, channel, channelDailyCapUsd, adAccountId }) => {
      if (action === "set") {
        const cfg = loadAdsConfig();
        if (killSwitch !== undefined) cfg.killSwitch = killSwitch;
        if (killSwitchReason !== undefined) cfg.killSwitchReason = killSwitchReason;
        if (totalCapUsd !== undefined) cfg.totalCapUsd = totalCapUsd;
        if (perChannelDailyCapUsd !== undefined) cfg.perChannelDailyCapUsd = perChannelDailyCapUsd;
        saveAdsConfig(cfg);
        if (channel && (channelDailyCapUsd !== undefined || adAccountId !== undefined)) {
          const ch = loadChannelAdsConfig(channel);
          if (channelDailyCapUsd !== undefined) ch.dailyCapUsd = channelDailyCapUsd;
          if (adAccountId !== undefined) ch.adAccountId = adAccountId;
          saveChannelAdsConfig(channel, ch);
        }
      }
      const config = loadAdsConfig();
      return ok(
        {
          config,
          ...(channel
            ? { channel: { id: channel, config: loadChannelAdsConfig(channel), effectiveCapUsd: effectiveChannelCapUsd(channel) } }
            : {}),
          liveDailyBudgetUsd: liveDailyBudgetUsd(),
          credsConfigured: channel ? resolveAdsCreds(channel).configured : Boolean(process.env.META_ADS_TOKEN),
        },
        `kill switch ${config.killSwitch ? "ON (launches blocked)" : "OFF"} · total cap $${config.totalCapUsd} · per-channel cap $${config.perChannelDailyCapUsd}`,
      );
    },
  }),
];
