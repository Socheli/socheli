import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "./data";

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
};

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

const DIR = join(REPO_ROOT, "data", "ai-providers");
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

export function openRouterOAuthStart(callbackUrl: string): { url: string; verifier: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const url = new URL("https://openrouter.ai/auth");
  url.searchParams.set("callback_url", callbackUrl);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  return { url: url.toString(), verifier };
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
