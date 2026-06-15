import "server-only";
import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { AdRecord, AdsChannelConfig, AdsGlobalConfig, recordInWorkspace } from "@os/schemas";
import type {
  AdRecord as AdRecordT,
  AdsChannelConfig as AdsChannelConfigT,
  AdsGlobalConfig as AdsGlobalConfigT,
} from "@os/schemas";
import { REPO_ROOT, listItemsFor } from "./data";

/* The dashboard's READ + control layer for paid amplification (/ads — "Boosts").
   Mirrors lib/admin.ts exactly: direct flat-JSON reads of the engine-owned
   data/ads/** store (validated against the shared @os/schemas ads shapes), and
   every MUTATION routed through the engine via the canonical tool runner
   (runAdsTool), so the spend gates — kill switch, caps, draft→approve→launch,
   dry-run-first — are enforced in ONE place (the engine), never re-implemented.

   SECURITY: ads spend real money and the store carries NO token by design
   (META_ADS_TOKEN lives only in env). This lib never reads env tokens and never
   returns anything but the schema-validated record shapes. */

/* ── Store layout (owned solely by the engine's ads tools) ──────────────────
   data/ads/config.json            → AdsGlobalConfig (kill switch + caps)
   data/ads/<channel>/config.json  → AdsChannelConfig (per-channel, no token)
   data/ads/<channel>/<adId>.json  → AdRecord */

const ADS_DIR = join(REPO_ROOT, "data", "ads");

/* Global ads control. Absent/invalid file → the schema's SAFE defaults
   (kill switch ON, caps 0 — nothing can spend until the operator opts in). */
export function adsConfig(): AdsGlobalConfigT {
  const file = join(ADS_DIR, "config.json");
  if (existsSync(file)) {
    try {
      const parsed = AdsGlobalConfig.safeParse(JSON.parse(readFileSync(file, "utf8")));
      if (parsed.success) return parsed.data;
    } catch {
      /* fall through to safe default */
    }
  }
  return AdsGlobalConfig.parse({});
}

/* Per-channel ads config (adAccountId/pageId presence, default countries). */
export function adsChannelConfig(channel: string): AdsChannelConfigT | null {
  const file = join(ADS_DIR, channel.replace(/[^a-zA-Z0-9_-]/g, "-"), "config.json");
  if (!existsSync(file)) return null;
  try {
    const parsed = AdsChannelConfig.safeParse(JSON.parse(readFileSync(file, "utf8")));
    if (parsed.success) return parsed.data;
  } catch {
    /* invalid → null */
  }
  return null;
}

/* Every boost record in the workspace, newest first. Records that fail schema
   validation are skipped (never guessed at). */
export function listAdsFor(workspaceId: string): AdRecordT[] {
  if (!existsSync(ADS_DIR)) return [];
  const out: AdRecordT[] = [];
  for (const entry of readdirSync(ADS_DIR)) {
    const dir = join(ADS_DIR, entry);
    try {
      if (!statSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".json") || f === "config.json") continue;
      try {
        const parsed = AdRecord.safeParse(JSON.parse(readFileSync(join(dir, f), "utf8")));
        if (parsed.success && recordInWorkspace(parsed.data, workspaceId)) out.push(parsed.data);
      } catch {
        /* skip unreadable */
      }
    }
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/* Committed live spend: the sum of live records' daily budgets — the number the
   UI holds against totalCapUsd / perChannelDailyCapUsd. */
export function liveDailyBudgetUsd(ads: AdRecordT[]): number {
  return ads.filter((a) => a.status === "live").reduce((s, a) => s + a.dailyBudgetUsd, 0);
}

/* ── Boostable inventory ─────────────────────────────────────────────────────
   The wizard can only boost what is actually live on Instagram: workspace items
   carrying a publish entry { platform: "instagram", status: "published" }. */
export type BoostableItem = {
  id: string;
  channel: string;
  title: string;
  publishedAt: string;
  url?: string;
  mood?: string;
};

export function listInstagramPublishedFor(workspaceId: string): BoostableItem[] {
  const out: BoostableItem[] = [];
  for (const it of listItemsFor(workspaceId)) {
    const pub = (it.publish ?? []).find((p) => p.platform === "instagram" && p.status === "published");
    if (!pub) continue;
    out.push({
      id: it.id,
      channel: it.channel,
      title: it.pkg?.title ?? it.idea?.topic ?? it.seedIdea,
      publishedAt: pub.at,
      url: pub.url,
      mood: it.mood,
    });
  }
  return out;
}

/* ── Engine bridge for ads mutations ─────────────────────────────────────────
   Spawn the canonical tool runner — EXACTLY mirrors lib/admin.ts runAdminTool.
   The engine's ads tools are the sole writers of data/ads/** and the only place
   the spend gates (kill switch, caps, approval, dry-run) are enforced. */

export type ToolResult = { ok: boolean; data?: Record<string, unknown>; message?: string };

export const ADS_TOOLS = new Set([
  "ads_plan",
  "ads_create",
  "ads_approve",
  "ads_launch",
  "ads_pause",
  "ads_status",
  "ads_list",
  "ads_budget",
]);

export function runAdsTool(name: string, input: Record<string, unknown>): Promise<ToolResult> {
  if (!ADS_TOOLS.has(name)) {
    return Promise.resolve({ ok: false, message: `not an ads tool: ${name}` });
  }
  const runner = join(REPO_ROOT, "packages", "engine", "src", "tool.ts");
  return new Promise((resolve) => {
    const child = spawn("node", ["--import", "tsx", runner, name, JSON.stringify(input)], {
      cwd: REPO_ROOT,
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", (e) => resolve({ ok: false, message: String(e) }));
    child.on("close", () => {
      try {
        resolve(JSON.parse(stdout.trim()) as ToolResult);
      } catch {
        resolve({ ok: false, message: (stderr || stdout).trim().slice(0, 2000) || "engine produced no output" });
      }
    });
  });
}
