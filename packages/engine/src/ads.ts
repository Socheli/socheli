import { existsSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  AdInsights,
  AdRecord,
  AdsChannelConfig,
  AdsGlobalConfig,
  type AdInsights as AdInsightsT,
  type AdRecord as AdRecordT,
  type AdsChannelConfig as AdsChannelConfigT,
  type AdsGlobalConfig as AdsGlobalConfigT,
} from "@os/schemas";

import { DATA_DIR, ensureDir, nowIso, loadItem } from "./store.ts";
import { httpCurl } from "./http.ts";
import { isTokenError } from "./publish-types.ts";
import { resolveIgCreds } from "./connections.ts";
import { isSendingHalted } from "./admin.ts";

/* Instagram boosts via the Meta Marketing API — promote a PUBLISHED IG media
   as an OUTCOME_ENGAGEMENT campaign. This module spends REAL MONEY, so every
   execution path funnels through checkSpendGate(): approved record + admin
   sending not halted + ads kill switch OFF + channel/total caps + configured
   creds + DSA disclosure for EU/EEA targeting. Safe by default: the kill
   switch ships ON and both caps ship at 0.

   SECURITY: the ads token comes from process.env.META_ADS_TOKEN ONLY — never
   from a stored connection (those carry Page tokens, the wrong kind anyway),
   and it is NEVER persisted or logged. buildBoostCalls() redacts it as
   "<META_ADS_TOKEN>" in every previewed body; only the curl invocation inside
   executeBoost()/setCampaignStatus()/fetchAdInsights() sees the real value.

   Persistence (flat JSON, atomic tmp+rename):
     data/ads/config.json            — AdsGlobalConfig (kill switch + caps)
     data/ads/<channel>/config.json  — AdsChannelConfig (account/page/countries)
     data/ads/<channel>/<adId>.json  — AdRecord */

const GRAPH_ADS = "https://graph.facebook.com/v25.0";

function graphJson(r: { stdout: string }): any {
  try {
    return JSON.parse(r.stdout);
  } catch {
    return { error: { message: (r.stdout || "").slice(0, 200) } };
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Store — data/ads/… (flat JSON, atomic)
// ───────────────────────────────────────────────────────────────────────────

const ADS_DIR = join(DATA_DIR, "ads");
const sanitize = (c: string) => (c || "global").replace(/[^a-zA-Z0-9_-]/g, "-");
const channelDir = (channel: string) => join(ADS_DIR, sanitize(channel));
const globalConfigFile = () => join(ADS_DIR, "config.json");
const channelConfigFile = (channel: string) => join(channelDir(channel), "config.json");
const adFile = (channel: string, id: string) => join(channelDir(channel), `${id}.json`);

function saveJson(path: string, data: unknown): void {
  ensureDir(path.slice(0, path.lastIndexOf("/")));
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  renameSync(tmp, path);
}

/* Config loaders are schema-parsed and NEVER throw — a missing or corrupt file
   degrades to the safe defaults (kill switch ON, caps 0). */
export function loadAdsConfig(): AdsGlobalConfigT {
  try {
    const p = globalConfigFile();
    if (!existsSync(p)) return AdsGlobalConfig.parse({});
    return AdsGlobalConfig.parse(JSON.parse(readFileSync(p, "utf8")));
  } catch {
    return AdsGlobalConfig.parse({});
  }
}
export function saveAdsConfig(cfg: AdsGlobalConfigT): AdsGlobalConfigT {
  const valid = AdsGlobalConfig.parse({ ...cfg, updatedAt: nowIso() });
  saveJson(globalConfigFile(), valid);
  return valid;
}

export function loadChannelAdsConfig(channel: string): AdsChannelConfigT {
  try {
    const p = channelConfigFile(channel);
    if (!existsSync(p)) return AdsChannelConfig.parse({});
    return AdsChannelConfig.parse(JSON.parse(readFileSync(p, "utf8")));
  } catch {
    return AdsChannelConfig.parse({});
  }
}
export function saveChannelAdsConfig(channel: string, cfg: AdsChannelConfigT): AdsChannelConfigT {
  const valid = AdsChannelConfig.parse({ ...cfg, updatedAt: nowIso() });
  saveJson(channelConfigFile(channel), valid);
  return valid;
}

export function newAdId(): string {
  return `ad_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export function saveAd(rec: AdRecordT): AdRecordT {
  rec.updatedAt = nowIso();
  const valid = AdRecord.parse(rec);
  saveJson(adFile(valid.channel, valid.id), valid);
  return valid;
}

/** All ad records, newest first; optionally filtered by channel and/or status. */
export function listAds(channel?: string, status?: string): AdRecordT[] {
  if (!existsSync(ADS_DIR)) return [];
  const dirs = channel
    ? [channelDir(channel)]
    : readdirSync(ADS_DIR)
        .map((d) => join(ADS_DIR, d))
        .filter((p) => {
          try {
            return statSync(p).isDirectory();
          } catch {
            return false;
          }
        });
  const ads: AdRecordT[] = [];
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".json") || f === "config.json") continue;
      try {
        const parsed = AdRecord.safeParse(JSON.parse(readFileSync(join(dir, f), "utf8")));
        if (parsed.success) ads.push(parsed.data);
      } catch {
        /* skip unreadable files */
      }
    }
  }
  return ads
    .filter((a) => !status || a.status === status)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Find one ad record by id across all channel dirs (data/ads/<channel>/<id>.json). */
export function loadAd(id: string): AdRecordT | null {
  if (!existsSync(ADS_DIR)) return null;
  for (const d of readdirSync(ADS_DIR)) {
    const p = join(ADS_DIR, d, `${id}.json`);
    if (!existsSync(p)) continue;
    try {
      const parsed = AdRecord.safeParse(JSON.parse(readFileSync(p, "utf8")));
      if (parsed.success) return parsed.data;
    } catch {
      /* fall through */
    }
  }
  return null;
}

const pushLog = (rec: AdRecordT, msg: string) => rec.log.push({ at: nowIso(), msg });

// ───────────────────────────────────────────────────────────────────────────
// Credentials — META_ADS_TOKEN from env ONLY (a connection's Page token is the
// wrong token kind for the Marketing API, and we never want it copied here).
// ───────────────────────────────────────────────────────────────────────────

export type AdsCreds = {
  configured: boolean;
  reason?: string;
  token?: string;
  adAccountId?: string;
  pageId?: string;
  igUserId?: string;
};

export function resolveAdsCreds(channel: string): AdsCreds {
  const creds = resolveIgCreds(channel);
  if (creds?.api === "instagram") {
    return {
      configured: false,
      reason: "instagram_login connection cannot boost — reconnect this brand via Facebook Login",
    };
  }
  const cfg = loadChannelAdsConfig(channel);
  const token = process.env.META_ADS_TOKEN || undefined;
  const adAccountId = cfg.adAccountId || process.env.META_AD_ACCOUNT_ID || undefined;
  const pageId = cfg.pageId || creds?.pageId || undefined;
  const igUserId = creds?.userId;
  const missing = [
    !token && "META_ADS_TOKEN env",
    !adAccountId && "ad account id (ads_budget --account / META_AD_ACCOUNT_ID)",
    !pageId && "Facebook Page id",
    !igUserId && "connected IG account",
  ].filter(Boolean) as string[];
  if (missing.length) return { configured: false, reason: `missing: ${missing.join(", ")}`, token, adAccountId, pageId, igUserId };
  return { configured: true, token, adAccountId, pageId, igUserId };
}

// ───────────────────────────────────────────────────────────────────────────
// Boostable media — only a PUBLISHED Instagram post can be promoted.
// ───────────────────────────────────────────────────────────────────────────

/** The IG media id of the item's LAST successful Instagram publish, or null. */
export function igMediaIdFor(itemId: string): string | null {
  try {
    const item = loadItem(itemId);
    const pubs = (item.publish ?? []).filter(
      (p) => p.platform === "instagram" && p.status === "published" && p.id,
    );
    return pubs.length ? pubs[pubs.length - 1].id ?? null : null;
  } catch {
    return null;
  }
}

// ───────────────────────────────────────────────────────────────────────────
// The boost call plan — PURE (no network), token ALWAYS redacted.
// ───────────────────────────────────────────────────────────────────────────

export type MetaCall = {
  step: "campaign" | "adset" | "creative" | "ad" | "activate";
  method: "POST";
  path: string;
  body: Record<string, string>;
};

const REDACTED_TOKEN = "<META_ADS_TOKEN>";

/* The exact 5-call sequence a boost executes. Everything is created PAUSED;
   the single final `activate` flips the campaign live. Pure: ids not yet
   created render as <placeholders>, and the token is always redacted — this
   is the dry-run preview surface. */
export function buildBoostCalls(rec: AdRecordT, creds: AdsCreds): MetaCall[] {
  const act = creds.adAccountId ?? "<ad_account_id>";
  const name = `Boost ${rec.itemId} — ${rec.channel}`;
  const campaignId = rec.metaIds.campaignId ?? "<campaign_id>";
  const adsetId = rec.metaIds.adsetId ?? "<adset_id>";
  const creativeId = rec.metaIds.creativeId ?? "<creative_id>";
  const start = new Date();
  const end = new Date(start.getTime() + rec.durationDays * 24 * 60 * 60 * 1000);
  const targeting: Record<string, unknown> = {
    geo_locations: { countries: rec.targeting.countries },
    ...(rec.targeting.ageMin != null ? { age_min: rec.targeting.ageMin } : {}),
    ...(rec.targeting.ageMax != null ? { age_max: rec.targeting.ageMax } : {}),
    publisher_platforms: ["instagram"],
    instagram_positions: ["stream", "reels"],
  };
  return [
    {
      step: "campaign",
      method: "POST",
      path: `/act_${act}/campaigns`,
      body: {
        name,
        objective: "OUTCOME_ENGAGEMENT",
        status: "PAUSED",
        special_ad_categories: "[]", // REQUIRED by Meta even when empty
        access_token: REDACTED_TOKEN,
      },
    },
    {
      step: "adset",
      method: "POST",
      path: `/act_${act}/adsets`,
      body: {
        name,
        campaign_id: campaignId,
        daily_budget: String(Math.round(rec.dailyBudgetUsd * 100)), // MINOR units (cents)
        billing_event: "IMPRESSIONS",
        optimization_goal: "POST_ENGAGEMENT",
        bid_strategy: "LOWEST_COST_WITHOUT_CAP",
        start_time: start.toISOString(),
        end_time: end.toISOString(),
        targeting: JSON.stringify(targeting),
        status: "PAUSED",
        ...(rec.targeting.dsaBeneficiary ? { dsa_beneficiary: rec.targeting.dsaBeneficiary } : {}),
        ...(rec.targeting.dsaPayor ? { dsa_payor: rec.targeting.dsaPayor } : {}),
        access_token: REDACTED_TOKEN,
      },
    },
    {
      step: "creative",
      method: "POST",
      path: `/act_${act}/adcreatives`,
      body: {
        object_id: creds.pageId ?? "<page_id>",
        // instagram_actor_id is DEAD in current Marketing API versions —
        // instagram_user_id is the field that works on v25.0.
        instagram_user_id: creds.igUserId ?? "<ig_user_id>",
        source_instagram_media_id: rec.igMediaId,
        access_token: REDACTED_TOKEN,
      },
    },
    {
      step: "ad",
      method: "POST",
      path: `/act_${act}/ads`,
      body: {
        name,
        adset_id: adsetId,
        creative: JSON.stringify({ creative_id: creativeId }),
        status: "PAUSED",
        access_token: REDACTED_TOKEN,
      },
    },
    {
      step: "activate",
      method: "POST",
      path: `/${campaignId}`,
      body: { status: "ACTIVE", access_token: REDACTED_TOKEN },
    },
  ];
}

// ───────────────────────────────────────────────────────────────────────────
// THE spend gate — every reason a launch is blocked, in ONE place.
// ───────────────────────────────────────────────────────────────────────────

/* EU + EEA (Iceland, Liechtenstein, Norway) — DSA disclosure territory. */
const EU_EEA = new Set([
  "AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR",
  "HU", "IE", "IT", "LV", "LT", "LU", "MT", "NL", "PL", "PT", "RO", "SK",
  "SI", "ES", "SE", "IS", "LI", "NO",
]);

/** Summed daily budget of LIVE ads (one channel, or all when omitted). */
export function liveDailyBudgetUsd(channel?: string): number {
  return listAds(channel, "live").reduce((sum, a) => sum + a.dailyBudgetUsd, 0);
}

/** min(global per-channel cap, the channel's own tighter cap when set). */
export function effectiveChannelCapUsd(channel: string): number {
  const global = loadAdsConfig().perChannelDailyCapUsd;
  const own = loadChannelAdsConfig(channel).dailyCapUsd ?? Infinity;
  return Math.min(global, own);
}

export function checkSpendGate(rec: AdRecordT): { allowed: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (rec.status !== "approved") {
    reasons.push(`record status is "${rec.status}" — only an approved record can launch (run ads_approve first)`);
  }
  const halted = isSendingHalted(rec.channel);
  if (halted.halted) reasons.push(`admin halt: ${halted.reason ?? "sending halted"}`);
  const cfg = loadAdsConfig();
  if (cfg.killSwitch !== false) {
    reasons.push(`ads kill switch is ON${cfg.killSwitchReason ? ` (${cfg.killSwitchReason})` : ""} — flip it off via ads_budget`);
  }
  const channelCap = effectiveChannelCapUsd(rec.channel);
  const channelLive = liveDailyBudgetUsd(rec.channel);
  if (channelLive + rec.dailyBudgetUsd > channelCap) {
    reasons.push(
      `channel daily cap exceeded: $${channelLive.toFixed(2)} live + $${rec.dailyBudgetUsd.toFixed(2)} > $${Number.isFinite(channelCap) ? channelCap.toFixed(2) : "∞"} cap for ${rec.channel}`,
    );
  }
  const totalLive = liveDailyBudgetUsd();
  if (totalLive + rec.dailyBudgetUsd > cfg.totalCapUsd) {
    reasons.push(
      `total daily cap exceeded: $${totalLive.toFixed(2)} live + $${rec.dailyBudgetUsd.toFixed(2)} > $${cfg.totalCapUsd.toFixed(2)} total cap`,
    );
  }
  const creds = resolveAdsCreds(rec.channel);
  if (!creds.configured) reasons.push(`ads credentials not configured: ${creds.reason ?? "unknown"}`);
  const euCountries = rec.targeting.countries.filter((c) => EU_EEA.has(c.toUpperCase()));
  if (euCountries.length && (!rec.targeting.dsaBeneficiary || !rec.targeting.dsaPayor)) {
    reasons.push(
      `EU/EEA targeting (${euCountries.join(", ")}) requires dsaBeneficiary + dsaPayor (Digital Services Act)`,
    );
  }
  return { allowed: reasons.length === 0, reasons };
}

// ───────────────────────────────────────────────────────────────────────────
// Execution — only ever called AFTER the gate passed with explicit dryRun:false.
// ───────────────────────────────────────────────────────────────────────────

/* POST one MetaCall with the REAL token substituted at the last moment. The
   redacted body is what gets logged/previewed; the token never leaves env. */
function postGraph(call: MetaCall, token: string): any {
  const args = ["-X", "POST", `${GRAPH_ADS}${call.path}`];
  for (const [k, v] of Object.entries(call.body)) {
    args.push("--data-urlencode", `${k}=${v === REDACTED_TOKEN ? token : v}`);
  }
  return graphJson(httpCurl(args)); // graph.facebook.com is not geo-blocked — no proxy
}

/* Create campaign → adset → creative → ad (ALL PAUSED), persisting metaIds
   after EACH step, then ONE activate call flips the campaign live. On any
   step error the record fails, created ids are kept and the campaign stays
   PAUSED — no orphan spend. */
export async function executeBoost(rec: AdRecordT): Promise<AdRecordT> {
  const creds = resolveAdsCreds(rec.channel);
  const failWith = (msg: string): AdRecordT => {
    rec.status = "failed";
    rec.error = isTokenError(msg) ? "needs-auth: META_ADS_TOKEN expired/invalid" : msg;
    pushLog(rec, `failed: ${rec.error}`);
    return saveAd(rec);
  };
  if (!creds.configured || !creds.token) return failWith(`ads credentials not configured: ${creds.reason ?? "unknown"}`);
  const token = creds.token;

  const idKey: Record<string, keyof AdRecordT["metaIds"]> = {
    campaign: "campaignId",
    adset: "adsetId",
    creative: "creativeId",
    ad: "adId",
  };
  for (const step of ["campaign", "adset", "creative", "ad", "activate"] as const) {
    // Rebuild from the record each step so freshly persisted ids flow into the
    // next call's body (buildBoostCalls reads them from rec.metaIds).
    const call = buildBoostCalls(rec, creds).find((c) => c.step === step)!;
    const res = postGraph(call, token);
    if (res?.error) {
      const code = res.error.code;
      const msg = `${step} failed: ${res.error.message ?? JSON.stringify(res.error).slice(0, 200)}`;
      rec.status = "failed";
      rec.error = isTokenError(res.error.message ?? "", code) ? "needs-auth: META_ADS_TOKEN expired/invalid" : msg;
      pushLog(rec, `failed at ${step}: ${rec.error} — campaign stays PAUSED, created ids kept`);
      return saveAd(rec);
    }
    if (step === "activate") {
      pushLog(rec, `campaign ${rec.metaIds.campaignId} activated`);
    } else {
      const id = String(res?.id ?? "");
      if (!id) return failWith(`${step} returned no id`);
      rec.metaIds[idKey[step]] = id;
      pushLog(rec, `${step} created (${id}, PAUSED)`);
      saveAd(rec); // persist after EACH step — a later failure never loses ids
    }
  }
  rec.status = "live";
  rec.launchedAt = nowIso();
  rec.error = undefined;
  pushLog(rec, `live: $${rec.dailyBudgetUsd.toFixed(2)}/day for ${rec.durationDays} day(s)`);
  return saveAd(rec);
}

/** Flip the boost's campaign ACTIVE/PAUSED. Throws on a Graph error. */
export async function setCampaignStatus(rec: AdRecordT, status: "ACTIVE" | "PAUSED"): Promise<void> {
  const creds = resolveAdsCreds(rec.channel);
  if (!creds.configured || !creds.token) throw new Error(`ads credentials not configured: ${creds.reason ?? "unknown"}`);
  if (!rec.metaIds.campaignId) throw new Error("record has no campaignId");
  const res = postGraph(
    { step: "activate", method: "POST", path: `/${rec.metaIds.campaignId}`, body: { status, access_token: REDACTED_TOKEN } },
    creds.token,
  );
  if (res?.error) {
    const msg = res.error.message ?? JSON.stringify(res.error).slice(0, 200);
    throw new Error(isTokenError(msg, res.error.code) ? "needs-auth: META_ADS_TOKEN expired/invalid" : `set status failed: ${msg}`);
  }
  pushLog(rec, `campaign ${rec.metaIds.campaignId} → ${status}`);
}

/** Lifetime insights snapshot for the boost's ad. Throws on a Graph error. */
export async function fetchAdInsights(rec: AdRecordT): Promise<AdInsightsT> {
  const creds = resolveAdsCreds(rec.channel);
  if (!creds.configured || !creds.token) throw new Error(`ads credentials not configured: ${creds.reason ?? "unknown"}`);
  if (!rec.metaIds.adId) throw new Error("record has no adId");
  const res = graphJson(
    httpCurl([
      `${GRAPH_ADS}/${rec.metaIds.adId}/insights?fields=impressions,reach,spend,clicks,cpm,ctr,actions&date_preset=lifetime&access_token=${creds.token}`,
    ]),
  );
  if (res?.error) {
    const msg = res.error.message ?? JSON.stringify(res.error).slice(0, 200);
    throw new Error(isTokenError(msg, res.error.code) ? "needs-auth: META_ADS_TOKEN expired/invalid" : `insights failed: ${msg}`);
  }
  const row = res?.data?.[0] ?? {};
  const num = (v: unknown) => (v == null || v === "" ? undefined : Number(v));
  const actions: Record<string, number> = {};
  for (const a of row.actions ?? []) {
    if (a?.action_type != null) actions[String(a.action_type)] = Number(a.value) || 0;
  }
  return AdInsights.parse({
    impressions: num(row.impressions),
    reach: num(row.reach),
    spendUsd: row.spend != null ? parseFloat(String(row.spend)) : undefined, // MAJOR-units string
    clicks: num(row.clicks),
    cpm: num(row.cpm),
    ctr: num(row.ctr),
    ...(Object.keys(actions).length ? { actions } : {}),
    fetchedAt: nowIso(),
  });
}
