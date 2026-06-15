import { z } from "zod";
import { TenantFields } from "./tenancy.ts";

/* ─── Paid amplification (Instagram boosts via the Marketing API) ───────────
   The record + config shapes for boosting published IG media as engagement
   ads. SECURITY BY DESIGN: there is NO token field anywhere in these shapes —
   the Meta ads token lives ONLY in env (META_ADS_TOKEN) and is never
   persisted or logged. Spend is multiply gated (kill switch ON by default,
   caps default to 0) so nothing can spend until the operator opts in. */

/* The only campaign objective the boost flow creates. */
export const AdObjective = z.enum(["OUTCOME_ENGAGEMENT"]);
export type AdObjective = z.infer<typeof AdObjective>;

export const AdStatus = z.enum(["draft", "approved", "live", "paused", "completed", "failed"]);
export type AdStatus = z.infer<typeof AdStatus>;

/* Audience targeting. dsaBeneficiary/dsaPayor are REQUIRED by Meta when any
   targeted country is in the EU/EEA (Digital Services Act disclosure). */
export const AdTargeting = z
  .object({
    countries: z.array(z.string().length(2)).min(1), // ISO-3166-1 alpha-2
    ageMin: z.number().int().min(13).max(65).optional(),
    ageMax: z.number().int().min(13).max(65).optional(),
    dsaBeneficiary: z.string().optional(), // who benefits from the ad (DSA)
    dsaPayor: z.string().optional(), // who pays for the ad (DSA)
  })
  .strict();
export type AdTargeting = z.infer<typeof AdTargeting>;

/* The Meta-side object ids created by the boost flow, persisted after EACH
   creation step so a partial failure never orphans untracked objects. */
export const AdMetaIds = z
  .object({
    campaignId: z.string().optional(),
    adsetId: z.string().optional(),
    creativeId: z.string().optional(),
    adId: z.string().optional(),
  })
  .strict();
export type AdMetaIds = z.infer<typeof AdMetaIds>;

/* A point-in-time insights snapshot (lifetime preset) from /<adId>/insights. */
export const AdInsights = z
  .object({
    impressions: z.number().optional(),
    reach: z.number().optional(),
    spendUsd: z.number().optional(), // Meta returns spend as a MAJOR-units string
    clicks: z.number().optional(),
    cpm: z.number().optional(),
    ctr: z.number().optional(),
    actions: z.record(z.string(), z.number()).optional(), // action_type → value
    fetchedAt: z.string(),
  })
  .strict();
export type AdInsights = z.infer<typeof AdInsights>;

/* The AI-drafted boost plan (advisory only — never spends anything itself). */
export const AdPlan = z
  .object({
    rationale: z.string(),
    suggestedDailyBudgetUsd: z.number().positive(),
    suggestedDurationDays: z.number().int().min(1).max(30),
    suggestedCountries: z.array(z.string()).min(1),
    hookNote: z.string().optional(),
  })
  .strict();
export type AdPlan = z.infer<typeof AdPlan>;

/* One boost: a published IG media promoted as an OUTCOME_ENGAGEMENT campaign.
   Lifecycle: draft → approved (human gate) → live → paused/completed; failed
   on any execution error. Persisted at data/ads/<channel>/<adId>.json. */
export const AdRecord = z
  .object({
    ...TenantFields, // workspaceId + createdBy — the owning org/person
    id: z.string(),
    channel: z.string(),
    itemId: z.string(),
    igMediaId: z.string(),
    objective: AdObjective.default("OUTCOME_ENGAGEMENT"),
    dailyBudgetUsd: z.number().positive(),
    durationDays: z.number().int().min(1).max(30),
    targeting: AdTargeting,
    status: AdStatus,
    metaIds: AdMetaIds.default({}),
    plan: AdPlan.optional(),
    approval: z.object({ approvedAt: z.string(), approvedBy: z.string() }).optional(),
    insights: AdInsights.optional(),
    createdAt: z.string(),
    updatedAt: z.string(),
    launchedAt: z.string().optional(),
    pausedAt: z.string().optional(),
    completedAt: z.string().optional(),
    log: z.array(z.object({ at: z.string(), msg: z.string() })).default([]),
    error: z.string().optional(),
  })
  .strict();
export type AdRecord = z.infer<typeof AdRecord>;

/* Global ads control — data/ads/config.json. SAFE BY DEFAULT: the kill switch
   ships ON and both caps ship at 0, so no launch can pass the spend gate
   until the operator explicitly opens it. */
export const AdsGlobalConfig = z
  .object({
    killSwitch: z.boolean().default(true), // ON by default — must be flipped off to spend
    killSwitchReason: z.string().optional(),
    totalCapUsd: z.number().nonnegative().default(0), // max summed live daily budget, all channels
    perChannelDailyCapUsd: z.number().nonnegative().default(0), // max summed live daily budget per channel
    updatedAt: z.string().default(""),
  })
  .strict();
export type AdsGlobalConfig = z.infer<typeof AdsGlobalConfig>;

/* Per-channel ads config — data/ads/<channel>/config.json. NO token here. */
export const AdsChannelConfig = z
  .object({
    adAccountId: z.string().optional(), // numeric Meta ad account id WITHOUT the act_ prefix
    pageId: z.string().optional(), // Facebook Page backing the IG account
    defaultCountries: z.array(z.string()).default(["US"]),
    dailyCapUsd: z.number().optional(), // tighter per-channel cap (min with the global one)
    updatedAt: z.string().default(""),
  })
  .strict();
export type AdsChannelConfig = z.infer<typeof AdsChannelConfig>;
