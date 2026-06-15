import "server-only";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { REPO_ROOT } from "./data";
import type { Role, TenantContext } from "@os/schemas";

/* Per-workspace API keys — replaces the single static SOCHELI_API_KEY. The file
   `data/api-keys.json` is the contract shared with the API server (which resolves
   an incoming Bearer token to a workspace + role). Keys are stored hashed; the
   plaintext is shown to the user exactly once at issue time. */

export const API_KEYS_FILE = join(REPO_ROOT, "data", "api-keys.json");

export type ApiKeyRecord = {
  id: string;
  prefix: string; // first chars, shown in the UI to identify a key
  hash: string; // sha256(rawKey) — the only stored form of the secret
  workspaceId: string;
  createdBy: string | null;
  role: Role; // the role this key acts as (cannot exceed the issuer's role)
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
  mkdirSync(join(REPO_ROOT, "data"), { recursive: true });
  writeFileSync(API_KEYS_FILE, JSON.stringify(f, null, 2));
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/* A key the UI can safely render (no secret material). */
export type PublicApiKey = Omit<ApiKeyRecord, "hash">;
const toPublic = ({ hash, ...rest }: ApiKeyRecord): PublicApiKey => rest;

export function listKeys(workspaceId: string): PublicApiKey[] {
  return readFile()
    .keys.filter((k) => k.workspaceId === workspaceId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map(toPublic);
}

/* Issue a new key for the caller's workspace. Returns the plaintext ONCE. The
   issued key cannot grant a role above the issuer's own. */
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

export function revokeKey(workspaceId: string, id: string): boolean {
  const f = readFile();
  const rec = f.keys.find((k) => k.id === id && k.workspaceId === workspaceId);
  if (!rec || rec.revokedAt) return false;
  rec.revokedAt = new Date().toISOString();
  writeFile(f);
  return true;
}

/* Resolve an incoming raw key to its (active) record. Used by the API server's
   auth layer. Updates lastUsedAt. Returns null for unknown/revoked keys. */
export function resolveKey(raw: string): ApiKeyRecord | null {
  if (!raw) return null;
  const f = readFile();
  const rec = f.keys.find((k) => k.hash === sha256(raw) && !k.revokedAt);
  if (!rec) return null;
  rec.lastUsedAt = new Date().toISOString();
  writeFile(f);
  return rec;
}
