import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "./store.ts";

export type BrainProviderId = "claude" | "codex" | "openrouter" | "anthropic" | "openai";

type StoredAiProvider = {
  id: BrainProviderId;
  enabled: boolean;
  auth: "api_key" | "oauth" | "local_cli";
  apiKey?: string;
  userId?: string;
  model?: string;
  connectedAt?: string;
  updatedAt?: string;
  // Revoked by the user: makes the provider unavailable even if a key/env/CLI
  // login is present. Every connection is revocable this way (not just keyed ones).
  disabled?: boolean;
  // Multiple named credentials on ONE provider (e.g. two Claude Code OAuth logins,
  // two API keys). The active one is used; each is individually revocable. The
  // legacy single `apiKey` above is treated as an implicit account when present.
  accounts?: ProviderAccount[];
  activeAccountId?: string;
};

export type ProviderAccount = { id: string; label: string; secret: string; kind: "key" | "oauth"; addedAt: string; disabled?: boolean };

export type AiProviderStatus = {
  id: BrainProviderId;
  label: string;
  enabled: boolean;
  configured: boolean;
  auth: "api_key" | "oauth" | "local_cli" | "env" | "none";
  source: "workspace" | "env" | "local" | "none";
  model?: string;
  keyPreview?: string;
  connectedAt?: string;
  note?: string;
};

const DIR = join(DATA_DIR, "ai-providers");
const sani = (s: string) => (s || "ws_default").replace(/[^a-zA-Z0-9_-]/g, "-");
const fileFor = (workspaceId: string) => join(DIR, `${sani(workspaceId)}.json`);
const now = () => new Date().toISOString();

const LABELS: Record<BrainProviderId, string> = {
  claude: "Claude Code",
  codex: "Codex CLI",
  openrouter: "OpenRouter",
  anthropic: "Anthropic API",
  openai: "OpenAI API",
};

function readStore(workspaceId: string): StoredAiProvider[] {
  try {
    const p = fileFor(workspaceId);
    if (!existsSync(p)) return [];
    const raw = JSON.parse(readFileSync(p, "utf8"));
    return Array.isArray(raw?.providers) ? raw.providers : [];
  } catch {
    return [];
  }
}

function writeStore(workspaceId: string, providers: StoredAiProvider[]): void {
  mkdirSync(DIR, { recursive: true });
  const p = fileFor(workspaceId);
  const tmp = `${p}.tmp`;
  writeFileSync(tmp, JSON.stringify({ workspaceId, providers }, null, 2), { mode: 0o600 });
  renameSync(tmp, p);
}

function preview(secret?: string): string | undefined {
  if (!secret) return undefined;
  return secret.length <= 6 ? "set" : `...${secret.slice(-6)}`;
}

function sha(input: string): string {
  return createHash("sha256").update(input).digest("base64url");
}

function envProvider(id: BrainProviderId): AiProviderStatus | null {
  if (id === "openrouter" && process.env.OPENROUTER_API_KEY) return { id, label: LABELS[id], enabled: false, configured: true, auth: "env", source: "env", model: process.env.OPENROUTER_MODEL, keyPreview: preview(process.env.OPENROUTER_API_KEY) };
  if (id === "anthropic" && process.env.ANTHROPIC_API_KEY) return { id, label: LABELS[id], enabled: false, configured: true, auth: "env", source: "env", model: process.env.ANTHROPIC_MODEL, keyPreview: preview(process.env.ANTHROPIC_API_KEY) };
  if (id === "openai" && process.env.OPENAI_API_KEY) return { id, label: LABELS[id], enabled: false, configured: true, auth: "env", source: "env", model: process.env.OPENAI_MODEL, keyPreview: preview(process.env.OPENAI_API_KEY) };
  return null;
}

export function aiProviderStatuses(workspaceId: string): AiProviderStatus[] {
  const stored = readStore(workspaceId);
  const active = stored.find((p) => p.enabled)?.id;
  return (Object.keys(LABELS) as BrainProviderId[]).map((id) => {
    const s = stored.find((p) => p.id === id);
    const env = envProvider(id);
    if (s) {
      return {
        id,
        label: LABELS[id],
        enabled: active === id,
        configured: s.auth === "local_cli" || !!s.apiKey,
        auth: s.auth,
        source: "workspace",
        model: s.model,
        keyPreview: preview(s.apiKey),
        connectedAt: s.connectedAt,
        note: s.userId ? `user ${s.userId}` : undefined,
      };
    }
    if (env) return { ...env, enabled: active === id };
    if (id === "claude") return { id, label: LABELS[id], enabled: active === id, configured: true, auth: "local_cli", source: "local", note: "uses the local Claude Code login or ANTHROPIC_API_KEY" };
    if (id === "codex") return { id, label: LABELS[id], enabled: active === id, configured: true, auth: "local_cli", source: "local", note: "uses the local Codex CLI login" };
    return { id, label: LABELS[id], enabled: false, configured: false, auth: "none", source: "none" };
  });
}

export function setAiProviderKey(workspaceId: string, id: BrainProviderId, apiKey: string, model?: string): void {
  const providers = readStore(workspaceId).filter((p) => p.id !== id);
  providers.push({ id, enabled: true, auth: "api_key", apiKey, model: model || undefined, connectedAt: now(), updatedAt: now() });
  writeStore(workspaceId, providers.map((p) => ({ ...p, enabled: p.id === id })));
}

export function selectAiProvider(workspaceId: string, id: BrainProviderId, model?: string): void {
  const providers = readStore(workspaceId).filter((p) => p.id !== id);
  providers.push({ id, enabled: true, auth: "local_cli", model: model || undefined, connectedAt: now(), updatedAt: now() });
  writeStore(workspaceId, providers.map((p) => ({ ...p, enabled: p.id === id })));
}

export function clearAiProvider(workspaceId: string, id: BrainProviderId): boolean {
  const before = readStore(workspaceId);
  const after = before.filter((p) => p.id !== id);
  if (!after.length) rmSync(fileFor(workspaceId), { force: true });
  else writeStore(workspaceId, after);
  return after.length !== before.length;
}

export function activeAiProvider(workspaceId?: string): StoredAiProvider | null {
  if (!workspaceId) return null;
  return readStore(workspaceId).find((p) => p.enabled) ?? null;
}

/* Store/replace a provider's API key WITHOUT changing which provider is active.
   Connecting many providers (so per-task model selection can use any of them)
   must never flip the default brain provider — that's what selectAiProvider is for. */
export function setProviderKeyOnly(workspaceId: string, id: string, apiKey: string, model?: string): void {
  const providers = readStore(workspaceId);
  const pid = id as BrainProviderId;
  const existing = providers.find((p) => p.id === pid);
  if (existing) {
    existing.apiKey = apiKey;
    if (model) existing.model = model;
    existing.auth = "api_key";
    existing.updatedAt = now();
  } else {
    providers.push({ id: pid, enabled: false, auth: "api_key", apiKey, model: model || undefined, connectedAt: now(), updatedAt: now() });
  }
  writeStore(workspaceId, providers);
}

/* The active credential for ANY provider id (not just the active default), for
   the per-task multi-provider dispatch. Prefers the active account, then the
   first enabled account, then the legacy single key. A revoked provider returns
   nothing. Caller falls back to the env var. */
export function getProviderApiKey(workspaceId: string | undefined, id: string): string | undefined {
  const s = readStore(workspaceId || "ws_default").find((p) => p.id === (id as BrainProviderId));
  if (!s || s.disabled) return undefined;
  if (s.accounts?.length) {
    const active = s.accounts.find((a) => a.id === s.activeAccountId && !a.disabled) ?? s.accounts.find((a) => !a.disabled);
    return active?.secret || undefined;
  }
  return s.apiKey || undefined;
}

/* ── Multiple named accounts per provider ────────────────────────────────── */
const acctId = () => `acc_${randomBytes(5).toString("hex")}`;

export function addProviderAccount(workspaceId: string, id: string, label: string, secret: string, kind: "key" | "oauth" = "key"): string {
  const providers = readStore(workspaceId);
  const pid = id as BrainProviderId;
  let p = providers.find((x) => x.id === pid);
  if (!p) { p = { id: pid, enabled: false, auth: kind === "oauth" ? "oauth" : "api_key", connectedAt: now(), updatedAt: now() }; providers.push(p); }
  if (!p.accounts) {
    p.accounts = [];
    // fold a pre-existing single key into an account so nothing is lost
    if (p.apiKey) { p.accounts.push({ id: acctId(), label: "default", secret: p.apiKey, kind: "key", addedAt: now() }); delete p.apiKey; }
  }
  const aid = acctId();
  p.accounts.push({ id: aid, label: label.trim() || `account ${p.accounts.length + 1}`, secret: secret.trim(), kind, addedAt: now() });
  if (!p.activeAccountId || !p.accounts.some((a) => a.id === p!.activeAccountId)) p.activeAccountId = aid;
  p.disabled = false;
  p.updatedAt = now();
  writeStore(workspaceId, providers);
  return aid;
}
export function removeProviderAccount(workspaceId: string, id: string, accountId: string): void {
  const providers = readStore(workspaceId);
  const p = providers.find((x) => x.id === (id as BrainProviderId));
  if (!p?.accounts) return;
  p.accounts = p.accounts.filter((a) => a.id !== accountId);
  if (p.activeAccountId === accountId) p.activeAccountId = p.accounts.find((a) => !a.disabled)?.id;
  p.updatedAt = now();
  if (!p.accounts.length && !p.apiKey) writeStore(workspaceId, providers.filter((x) => x.id !== p.id));
  else writeStore(workspaceId, providers);
}
export function setActiveAccount(workspaceId: string, id: string, accountId: string): void {
  const providers = readStore(workspaceId);
  const p = providers.find((x) => x.id === (id as BrainProviderId));
  if (!p?.accounts?.some((a) => a.id === accountId)) return;
  p.activeAccountId = accountId;
  p.updatedAt = now();
  writeStore(workspaceId, providers);
}
/* Account metadata for the UI (NEVER the secret). */
export function listProviderAccounts(workspaceId: string | undefined, id: string): { id: string; label: string; kind: string; active: boolean; addedAt: string }[] {
  const p = readStore(workspaceId || "ws_default").find((x) => x.id === (id as BrainProviderId));
  if (!p) return [];
  const accts = p.accounts ?? (p.apiKey ? [{ id: "legacy", label: "default", secret: p.apiKey, kind: "key" as const, addedAt: p.connectedAt ?? "" }] : []);
  const active = p.activeAccountId ?? accts.find((a) => !a.disabled)?.id;
  return accts.map((a) => ({ id: a.id, label: a.label, kind: a.kind, active: a.id === active, addedAt: a.addedAt }));
}

/* Revoke / restore ANY connection — local CLI, env-keyed, or stored-key. Revoking
   sets a disabled flag (env keys + CLI logins can't be deleted, but this makes
   the provider unavailable). Restoring clears it. */
export function setProviderDisabled(workspaceId: string, id: string, disabled: boolean): void {
  const providers = readStore(workspaceId);
  const pid = id as BrainProviderId;
  const existing = providers.find((p) => p.id === pid);
  if (existing) { existing.disabled = disabled; existing.updatedAt = now(); }
  else providers.push({ id: pid, enabled: false, auth: "local_cli", disabled, connectedAt: now(), updatedAt: now() });
  writeStore(workspaceId, providers);
}
export function isProviderDisabled(workspaceId: string | undefined, id: string): boolean {
  return !!readStore(workspaceId || "ws_default").find((p) => p.id === (id as BrainProviderId))?.disabled;
}

/* Make a provider the DEFAULT brain (the one tasks use when they have no
   per-task override). Flips the enabled flag; keeps every stored key intact.
   A keyless/CLI provider with no stored entry yet gets one. */
export function setActiveProvider(workspaceId: string, id: string): void {
  const providers = readStore(workspaceId);
  const pid = id as BrainProviderId;
  if (!providers.some((p) => p.id === pid)) {
    providers.push({ id: pid, enabled: true, auth: "local_cli", connectedAt: now(), updatedAt: now() });
  }
  writeStore(workspaceId, providers.map((p) => ({ ...p, enabled: p.id === pid })));
}
export function getActiveProviderId(workspaceId?: string): string | null {
  return activeAiProvider(workspaceId)?.id ?? null;
}

/* Drop just a provider's stored key (without removing other providers). */
export function clearProviderKey(workspaceId: string, id: string): boolean {
  const before = readStore(workspaceId);
  const after = before.filter((p) => p.id !== (id as BrainProviderId));
  if (after.length === before.length) return false;
  if (!after.length) rmSync(fileFor(workspaceId), { force: true });
  else writeStore(workspaceId, after);
  return true;
}

export function resolveBrainConfig(workspaceId?: string): { provider: string; openrouterKey?: string; openrouterModel?: string; anthropicKey?: string; openaiKey?: string; openaiModel?: string } {
  const p = activeAiProvider(workspaceId);
  if (!p) return { provider: (process.env.BRAIN_PROVIDER || "claude").toLowerCase() };
  if (p.id === "openrouter") return { provider: "openrouter", openrouterKey: p.apiKey || process.env.OPENROUTER_API_KEY, openrouterModel: p.model || process.env.OPENROUTER_MODEL };
  if (p.id === "anthropic") return { provider: "claude", anthropicKey: p.apiKey || process.env.ANTHROPIC_API_KEY };
  if (p.id === "openai") return { provider: "openai", openaiKey: p.apiKey || process.env.OPENAI_API_KEY, openaiModel: p.model || process.env.OPENAI_MODEL };
  return { provider: p.id };
}

export function beginOpenRouterOAuth(callbackUrl: string): { url: string; verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = sha(verifier);
  const url = new URL("https://openrouter.ai/auth");
  url.searchParams.set("callback_url", callbackUrl);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  return { url: url.toString(), verifier, challenge };
}

export async function exchangeOpenRouterCode(workspaceId: string, code: string, verifier: string): Promise<{ ok: true; userId?: string } | { ok: false; reason: string }> {
  const res = await fetch("https://openrouter.ai/api/v1/auth/keys", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code, code_verifier: verifier, code_challenge_method: "S256" }),
  });
  const j = await res.json().catch(() => ({} as { key?: string; user_id?: string; error?: { message?: string } }));
  if (!res.ok || !j.key) return { ok: false, reason: j.error?.message || `OpenRouter OAuth exchange failed (${res.status})` };
  const providers = readStore(workspaceId).filter((p) => p.id !== "openrouter");
  providers.push({ id: "openrouter", enabled: true, auth: "oauth", apiKey: j.key, userId: j.user_id, connectedAt: now(), updatedAt: now() });
  writeStore(workspaceId, providers.map((p) => ({ ...p, enabled: p.id === "openrouter" })));
  return { ok: true, userId: j.user_id };
}
