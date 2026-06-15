/* Persisted brand registry. `data/brands.json` is the materialized source of
   truth for the brands (channels) a user manages — seeded from the built-in
   CHANNELS the first time the engine runs, then edited via the dashboard's
   brand-settings CRUD. The engine reads it as authoritative (falling back to the
   built-in const if the file is missing/corrupt); the dashboard reads/writes the
   SAME file directly, so no cross-package import is needed.

   Brands are workspace-owned: each carries `workspaceId`. The registry reads take
   an optional workspaceId and only return that workspace's brands (legacy/unstamped
   brands belong to DEFAULT_WORKSPACE). Bare calls span every workspace, which keeps
   system tooling and existing callers working unchanged. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ChannelDNA, DEFAULT_WORKSPACE, recordInWorkspace } from "@os/schemas";
import { autoSyncAfter } from "./sync.ts";
import type { ChannelDNA as ChannelDNAT } from "@os/schemas";

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "data");
export const BRANDS_FILE = join(DATA_DIR, "brands.json");

export type BrandRegistry = { brands: Record<string, ChannelDNAT> };

/* Read + validate the persisted registry. When a `workspaceId` is given, only that
   workspace's brands are returned (unstamped legacy brands resolve to the default
   workspace). Returns null if the file is absent or contains no valid brand for
   the scope (so callers fall back to the built-in defaults). */
export function readBrandRegistry(workspaceId?: string): BrandRegistry | null {
  if (!existsSync(BRANDS_FILE)) return null;
  try {
    const raw = JSON.parse(readFileSync(BRANDS_FILE, "utf8")) as { brands?: Record<string, unknown> };
    const brands: Record<string, ChannelDNAT> = {};
    for (const c of Object.values(raw.brands ?? {})) {
      const p = ChannelDNA.safeParse(c);
      if (!p.success) continue;
      if (workspaceId && !recordInWorkspace(p.data, workspaceId)) continue;
      brands[p.data.id] = p.data;
    }
    return Object.keys(brands).length ? { brands } : null;
  } catch {
    return null;
  }
}

/* Persist brands. New brands are stamped with `workspaceId` (default
   DEFAULT_WORKSPACE) when they don't already carry one, so the registry always
   round-trips a workspace; existing stamps are preserved. When the registry is
   written piecemeal per workspace, brands from OTHER workspaces already on disk
   are retained. */
export function writeBrandRegistry(brands: Record<string, ChannelDNAT>, workspaceId: string = DEFAULT_WORKSPACE): void {
  mkdirSync(DATA_DIR, { recursive: true });
  const merged: Record<string, ChannelDNAT> = {};
  // keep brands belonging to other workspaces untouched
  const existing = readBrandRegistry();
  if (existing) {
    for (const b of Object.values(existing.brands)) {
      if (!recordInWorkspace(b, workspaceId)) merged[b.id] = b;
    }
  }
  for (const b of Object.values(brands)) {
    merged[b.id] = b.workspaceId ? b : { ...b, workspaceId };
  }
  writeFileSync(BRANDS_FILE, JSON.stringify({ brands: merged }, null, 2));
  autoSyncAfter("brand-edit"); // push brand registry changes up to production
}
