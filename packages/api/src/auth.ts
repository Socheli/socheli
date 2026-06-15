import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { join } from "node:path";
import { DEFAULT_WORKSPACE, systemContext, type Role, type TenantContext } from "@os/schemas";
import { DATA_DIR } from "./store.ts";

/* Per-key auth for the API server. The dashboard issues keys into
   data/api-keys.json (records are hashed); here we resolve an incoming Bearer
   token back to its workspace + role so every /v1/* handler runs scoped to the
   caller's tenant. We duplicate the small sha256 + record shape because the API
   package can't import the dashboard (Next/server-only). The legacy env
   SOCHELI_API_KEY still works and resolves to a system/owner context. */

const API_KEYS_FILE = join(DATA_DIR, "api-keys.json");
const LEGACY_KEY = process.env.SOCHELI_API_KEY || "";

export type ApiKeyRecord = {
  id: string;
  prefix: string; // first chars, shown in the UI to identify a key
  hash: string; // sha256(rawKey) — the only stored form of the secret
  workspaceId: string;
  createdBy: string | null;
  role: Role; // the role this key acts as
  label: string;
  createdAt: string;
  lastUsedAt?: string;
  revokedAt?: string;
};

type KeyFile = { keys: ApiKeyRecord[] };

function readFile(): KeyFile {
  if (!existsSync(API_KEYS_FILE)) return { keys: [] };
  try {
    const parsed = JSON.parse(readFileSync(API_KEYS_FILE, "utf8")) as KeyFile;
    return { keys: Array.isArray(parsed.keys) ? parsed.keys : [] };
  } catch {
    return { keys: [] };
  }
}

function writeFile(f: KeyFile): void {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(API_KEYS_FILE, JSON.stringify(f, null, 2));
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/* A key safe to return over the wire (no secret material). */
export type PublicApiKey = Omit<ApiKeyRecord, "hash">;
const toPublic = ({ hash, ...rest }: ApiKeyRecord): PublicApiKey => rest;

/* Resolve an Authorization header to a TenantContext. The legacy static key maps
   to a system/owner context of the default workspace; every other key resolves
   to its issued workspace + role with via:"apikey". Returns null when unknown. */
export function resolveContext(authHeader: string | undefined | null): TenantContext | null {
  const raw = (authHeader || "").replace(/^Bearer\s+/i, "").trim();
  if (!raw) return null;

  // Legacy single static key → trusted owner of the default workspace.
  if (LEGACY_KEY && raw === LEGACY_KEY) return systemContext(DEFAULT_WORKSPACE);

  const f = readFile();
  const rec = f.keys.find((k) => k.hash === sha256(raw) && !k.revokedAt);
  if (!rec) return null;
  rec.lastUsedAt = new Date().toISOString();
  writeFile(f);

  return {
    workspaceId: rec.workspaceId,
    userId: rec.createdBy ?? null,
    orgId: rec.workspaceId.startsWith("org_") ? rec.workspaceId : null,
    role: rec.role,
    plan: "team",
    via: "apikey",
  };
}

/* True when the API has any way to authenticate a caller. */
export const authConfigured = (): boolean => !!LEGACY_KEY || existsSync(API_KEYS_FILE);

/* ── Key management (mirrors the dashboard's api-keys lib) ─────────────────── */

/* This workspace's keys, newest first, with no secret material. */
export function listKeys(workspaceId: string): PublicApiKey[] {
  return readFile()
    .keys.filter((k) => k.workspaceId === workspaceId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map(toPublic);
}

/* Issue a new key for the caller's workspace. Returns the plaintext ONCE. */
export function issueKey(
  ctx: TenantContext,
  opts: { label: string; role?: Role },
): { key: string; record: PublicApiKey } {
  const raw = `sk_soch_${randomBytes(24).toString("base64url")}`;
  const rec: ApiKeyRecord = {
    id: `key_${randomBytes(8).toString("hex")}`,
    prefix: raw.slice(0, 16),
    hash: sha256(raw),
    workspaceId: ctx.workspaceId,
    createdBy: ctx.userId,
    role: opts.role ?? "member",
    label: opts.label || "Untitled key",
    createdAt: new Date().toISOString(),
  };
  const f = readFile();
  f.keys.push(rec);
  writeFile(f);
  return { key: raw, record: toPublic(rec) };
}

/* Revoke a key by id within the caller's workspace. */
export function revokeKey(workspaceId: string, id: string): boolean {
  const f = readFile();
  const rec = f.keys.find((k) => k.id === id && k.workspaceId === workspaceId);
  if (!rec || rec.revokedAt) return false;
  rec.revokedAt = new Date().toISOString();
  writeFile(f);
  return true;
}
