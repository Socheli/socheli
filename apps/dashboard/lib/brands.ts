import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ChannelDNA, recordInWorkspace, type TenantContext } from "@os/schemas";
import type { ChannelDNA as Brand } from "@os/schemas";
import { REPO_ROOT } from "./data";
import { currentPlanId, planById, type Plan } from "./billing";

export type { Brand };

/* The dashboard's view of the brand registry. Same `data/brands.json` the engine
   reads (packages/engine/src/brands-store.ts) — we read/write it directly and
   validate against the shared ChannelDNA schema, so a brand created here is
   immediately usable by the generator.

   Brands are workspace-owned: each brand carries `workspaceId`. The scoped
   functions below take a workspaceId and only ever see that workspace's brands.
   Bare (no-arg) calls stay for system tooling that spans workspaces. */
const BRANDS_FILE = join(REPO_ROOT, "data", "brands.json");

function readRaw(): Record<string, unknown> {
  if (!existsSync(BRANDS_FILE)) return {};
  try {
    return (JSON.parse(readFileSync(BRANDS_FILE, "utf8")) as { brands?: Record<string, unknown> }).brands ?? {};
  } catch {
    return {};
  }
}
function writeRaw(brands: Record<string, unknown>): void {
  mkdirSync(join(REPO_ROOT, "data"), { recursive: true });
  writeFileSync(BRANDS_FILE, JSON.stringify({ brands }, null, 2));
}

function parseAll(): Brand[] {
  return Object.values(readRaw())
    .map((b) => {
      const p = ChannelDNA.safeParse(b);
      return p.success ? p.data : null;
    })
    .filter((b): b is Brand => !!b);
}

export function listBrands(workspaceId?: string): Brand[] {
  return parseAll()
    .filter((b) => (workspaceId ? recordInWorkspace(b, workspaceId) : true))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function getBrand(id: string, workspaceId?: string): Brand | null {
  const p = ChannelDNA.safeParse(readRaw()[id]);
  if (!p.success) return null;
  if (workspaceId && !recordInWorkspace(p.data, workspaceId)) return null;
  return p.data;
}

export function brandExists(id: string): boolean {
  return id in readRaw();
}

/* Plan quotas count brands PER WORKSPACE — a team's seats/brands are theirs. */
export type BrandUsage = { plan: Plan; count: number; limit: number; atLimit: boolean };
export function brandUsage(workspaceId?: string): BrandUsage {
  const plan = planById(currentPlanId());
  const count = workspaceId ? listBrands(workspaceId).length : Object.keys(readRaw()).length;
  const limit = plan.quota.brands;
  return { plan, count, limit, atLimit: count >= limit };
}

/* Validate + persist a brand. `mode: "create"` enforces the workspace's plan
   limit and rejects a duplicate id. When a `ctx` is supplied the brand is stamped
   with the caller's workspace/author and scoping is enforced (you can't overwrite
   another workspace's brand). */
export type SaveResult = { ok: boolean; brand?: Brand; error?: string; code?: "exists" | "limit" | "invalid" | "forbidden" };
export function saveBrand(input: unknown, mode: "create" | "update", ctx?: TenantContext): SaveResult {
  const p = ChannelDNA.safeParse(input);
  if (!p.success) {
    return { ok: false, code: "invalid", error: p.error.issues.map((i) => `${i.path.join(".") || "field"}: ${i.message}`).join("; ") };
  }
  const brand = p.data;
  const brands = readRaw();
  const existing = brands[brand.id] ? ChannelDNA.safeParse(brands[brand.id]) : null;
  const exists = !!existing?.success;

  if (ctx) {
    // Stamp ownership on create; preserve it on update.
    if (mode === "create") {
      brand.workspaceId = ctx.workspaceId;
      brand.createdBy = ctx.userId ?? undefined;
    } else if (existing?.success) {
      if (!recordInWorkspace(existing.data, ctx.workspaceId)) {
        return { ok: false, code: "forbidden", error: "This brand belongs to another workspace." };
      }
      brand.workspaceId = existing.data.workspaceId ?? ctx.workspaceId;
      brand.createdBy = existing.data.createdBy ?? brand.createdBy;
    }
  }

  if (mode === "create") {
    if (exists) return { ok: false, code: "exists", error: `A brand with id "${brand.id}" already exists.` };
    const u = brandUsage(ctx?.workspaceId);
    if (u.atLimit) return { ok: false, code: "limit", error: `Your ${u.plan.name} plan allows ${u.limit} brand${u.limit === 1 ? "" : "s"}. Upgrade to add more.` };
  }
  brands[brand.id] = brand;
  writeRaw(brands);
  return { ok: true, brand };
}

export function deleteBrand(id: string, workspaceId?: string): boolean {
  const brands = readRaw();
  if (!(id in brands)) return false;
  if (workspaceId) {
    const p = ChannelDNA.safeParse(brands[id]);
    if (p.success && !recordInWorkspace(p.data, workspaceId)) return false;
  }
  delete brands[id];
  writeRaw(brands);
  return true;
}

/* A URL-safe id from a brand name (used when the wizard doesn't supply one). */
export function slugifyBrandId(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 40) || `brand_${Date.now().toString(36)}`
  );
}
