import { mkdirSync, readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ContentItem,
  type CostLedger,
  type RunWarning,
  type TenantContext,
  DEFAULT_WORKSPACE,
  recordInWorkspace,
  stampOwnership,
  systemContext,
} from "@os/schemas";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
export const DATA_DIR = join(ROOT, "data");
export const RUNS_DIR = join(DATA_DIR, "runs");

/* Rendered video outputs are large and the boot disk is small — keep them on an
   external volume (set SOCHELI_EXT_VOLUME to its mount point) when it's mounted.
   Override the final path directly with SOCHELI_RENDERS_DIR. Keep this expression
   identical in editor-tools.ts and the dashboard's lib/data.ts. */
export const RENDERS_DIR =
  process.env.SOCHELI_RENDERS_DIR ||
  (process.env.SOCHELI_EXT_VOLUME && existsSync(process.env.SOCHELI_EXT_VOLUME)
    ? join(process.env.SOCHELI_EXT_VOLUME, "Socheli", "renders")
    : join(DATA_DIR, "renders"));

const ensure = (d: string) => mkdirSync(d, { recursive: true });

export function nowIso() {
  return new Date().toISOString();
}

export function newId(channel: string) {
  const stamp = nowIso().replace(/[-:TZ.]/g, "").slice(0, 14);
  return `${channel.split("_")[0]}_${stamp}`;
}

export function itemPath(id: string) {
  return join(RUNS_DIR, `${id}.json`);
}

/* Persist an item. Pass a TenantContext (or a bare workspaceId) on create to
   stamp ownership; existing workspaceId/createdBy are never overwritten. Calling
   saveItem(item) with no context keeps working for legacy/system paths. */
export function saveItem(item: ContentItem, ctx?: TenantContext | string) {
  ensure(RUNS_DIR);
  if (ctx) stampOwnership(item, typeof ctx === "string" ? systemContext(ctx) : ctx);
  item.updatedAt = nowIso();
  writeFileSync(itemPath(item.id), JSON.stringify(item, null, 2));
}

export function loadItem(id: string): ContentItem {
  return ContentItem.parse(JSON.parse(readFileSync(itemPath(id), "utf8")));
}

export function listItems(): ContentItem[] {
  ensure(RUNS_DIR);
  return readdirSync(RUNS_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      try {
        return ContentItem.parse(JSON.parse(readFileSync(join(RUNS_DIR, f), "utf8")));
      } catch {
        return null;
      }
    })
    .filter((x): x is ContentItem => !!x)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/* Workspace-scoped reads — return only items owned by the given workspace
   (unstamped legacy items resolve to DEFAULT_WORKSPACE). The bare listItems()/
   loadItem() above stay for system/cross-workspace tooling. */
export function listItemsFor(workspaceId: string = DEFAULT_WORKSPACE): ContentItem[] {
  return listItems().filter((it) => recordInWorkspace(it, workspaceId));
}

export function getItemFor(id: string, workspaceId: string = DEFAULT_WORKSPACE): ContentItem | null {
  if (!existsSync(itemPath(id))) return null;
  const it = loadItem(id);
  return recordInWorkspace(it, workspaceId) ? it : null;
}

export function logLine(item: ContentItem, msg: string) {
  item.log.push({ at: nowIso(), msg });
}

/* Record a non-fatal render degradation: a structured warning the dashboard +
   device surface, PLUS a ⚠ log line (so it also rides the live progress stream).
   Use this anywhere the pipeline takes a quality fallback instead of aborting. */
export function warn(item: ContentItem, stage: string, code: string, message: string, detail?: string): RunWarning {
  const w: RunWarning = { at: nowIso(), stage, code, message, ...(detail ? { detail: detail.slice(0, 2000) } : {}) };
  (item.warnings ??= []).push(w);
  item.log.push({ at: w.at, msg: `⚠ ${message}` });
  return w;
}

export function charge(ledger: CostLedger, stage: string, usd: number) {
  if (usd <= 0) return;
  ledger.entries.push({ stage, usd, at: nowIso() });
  ledger.totalUsd = Number((ledger.totalUsd + usd).toFixed(6));
}

export { ensure as ensureDir };
