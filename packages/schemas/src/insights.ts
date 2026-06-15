import { z } from "zod";

/* ════════════════════════════════════════════════════════════════════════
   INSIGHTS — per-brand account-level Instagram insight snapshots.

   Captured from the connected brand's account (reach / engagement / followers)
   and surfaced into the dashboard. Each snapshot stores ONLY numeric metrics +
   the igUserId — NEVER a token. Persisted to gitignored data/insights/<channel>.json.

   Mirrors memory.ts: tiny, .strict(), const + z.infer pair. The capture engine
   (Graph insights fetch, token-gated, never-throw) lives engine-side; this zod
   schema is the data that persists / crosses the wire.
   ════════════════════════════════════════════════════════════════════════ */

/* One captured account-level metrics snapshot for a brand. Stores ONLY numeric
   metrics + igUserId — NEVER a token. Persisted to gitignored data/insights/<channel>.json. */
export const AccountInsightSnapshot = z
  .object({
    channel: z.string(),
    capturedAt: z.string().describe("ISO timestamp"),
    igUserId: z.string().optional(),
    followers: z.number().optional(),
    reach: z.number().optional(),
    impressions: z.number().optional(),
    profileViews: z.number().optional(),
    accountsEngaged: z.number().optional(),
    totalInteractions: z.number().optional(),
    period: z.enum(["day", "week", "days_28"]).default("day"),
    raw: z.unknown().optional(),
  })
  .strict();
export type AccountInsightSnapshot = z.infer<typeof AccountInsightSnapshot>;
