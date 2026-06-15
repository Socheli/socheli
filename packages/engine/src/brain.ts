import { spawn, spawnSync } from "node:child_process";
import { writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { z } from "zod";
import { resolveBrainConfig, getProviderApiKey, isProviderDisabled } from "./ai-providers.ts";
import { getProvider, parseTaskModel, type ProviderDef } from "./providers.ts";
import { getTaskOverride } from "./task-models.ts";
import { classifyProviderError, shouldRotate, type ProviderErrorClass } from "./harness/errors.ts";

/* The content brain — provider-agnostic. Pick a backend with BRAIN_PROVIDER:
     claude     (default) headless Claude Code `claude -p` — uses your CC auth, no key.
     openrouter OpenRouter HTTP API — set OPENROUTER_API_KEY (+ OPENROUTER_MODEL[_TIER]).
     codex      OpenAI Codex CLI `codex exec` — uses your ChatGPT/Codex subscription.
   Returns parsed JSON + USD cost (0 for subscription backends). */

export type BrainResult<T> = { data: T; usd: number };
export type BrainTier = "cheap" | "smart" | "best";

// Exported so the harness runtimes (harness/claude-sdk.ts) reuse this map
// instead of re-declaring an identical literal. claude-code.ts already imports
// resolveClaudeBin from here, so this widening adds no new cycle.
export const CLAUDE_MODELS: Record<BrainTier, string> = {
  cheap: "claude-haiku-4-5-20251001",
  smart: "claude-sonnet-4-6",
  best: "claude-opus-4-8",
};
// OpenRouter: per-tier override, else OPENROUTER_MODEL, else a current default.
// Defaults are cheap-but-capable Gemini Flash so the brain works on a low/free
// OpenRouter balance (the old claude-3.5/3.7 slugs 404'd, and the premium claude
// models reserve more credits than a free account can afford). Point
// OPENROUTER_MODEL[_TIER] at anthropic/claude-sonnet-4.6 / claude-opus-4.8 once
// the account is funded for top-tier quality.
// Exported so the harness openrouter runtime falls back to this resolver
// instead of re-implementing the OPENROUTER_MODEL[_TIER] precedence.
export const openrouterModel = (tier: BrainTier): string =>
  process.env[`OPENROUTER_MODEL_${tier.toUpperCase()}`] ||
  process.env.OPENROUTER_MODEL ||
  ({ cheap: "google/gemini-2.5-flash-lite", smart: "google/gemini-2.5-flash", best: "google/gemini-2.5-flash" } as Record<BrainTier, string>)[tier];

/* Resolve the `claude` CLI to an ABSOLUTE path so it works no matter what PATH
   the parent process was started with. The common failure ("spawn claude
   ENOENT") happens when the dashboard / a server spawns the engine from a shell
   that doesn't have the Claude Code bin dir on PATH. The engine's OWN node
   (process.execPath) lives in that same bin dir for nvm/volta installs, so check
   there first; then CLAUDE_BIN, well-known locations, and finally PATH. */
let _claudeBin: string | null | undefined;
export function resolveClaudeBin(): string | null {
  if (_claudeBin !== undefined) return _claudeBin;
  const candidates = [
    process.env.CLAUDE_BIN,
    join(dirname(process.execPath), "claude"), // same bin dir as the node running us (nvm/volta)
    process.env.HOME ? join(process.env.HOME, ".local/bin/claude") : "",
    process.env.HOME ? join(process.env.HOME, ".claude/local/claude") : "",
    "/usr/local/bin/claude",
    "/opt/homebrew/bin/claude",
  ].filter(Boolean) as string[];
  for (const c of candidates) if (existsSync(c)) return (_claudeBin = c);
  const w = spawnSync("which", ["claude"], { encoding: "utf8" });
  const p = (w.stdout || "").trim();
  return (_claudeBin = p && existsSync(p) ? p : null);
}

/* ─── claude -p (default) ──────────────────────────────────────────────── */
function runClaude(prompt: string, tier: BrainTier, anthropicKey?: string, modelOverride?: string, oauthToken?: string): Promise<{ result: string; usd: number }> {
  return new Promise((resolve, reject) => {
    const bin = resolveClaudeBin();
    if (!bin) {
      reject(new Error("Claude Code CLI not found. Install it, set CLAUDE_BIN, or set BRAIN_PROVIDER=openrouter with OPENROUTER_API_KEY."));
      return;
    }
    // A per-task model override (claude-* slug) wins; else the tier's default model.
    const args = ["-p", prompt, "--output-format", "json", "--model", modelOverride || CLAUDE_MODELS[tier]];
    // The active Claude account's OAuth token (multi-login) drives the CLI; else
    // an ANTHROPIC_API_KEY; else the ambient login. ensure the bin's dir is on PATH.
    const env = { ...process.env, ...(oauthToken ? { CLAUDE_CODE_OAUTH_TOKEN: oauthToken } : {}), ...(anthropicKey ? { ANTHROPIC_API_KEY: anthropicKey } : {}), PATH: `${dirname(bin)}:${process.env.PATH ?? ""}` };
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"], env });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) return reject(new Error(`claude exited ${code}: ${err.slice(0, 500)}`));
      try {
        const env = JSON.parse(out);
        resolve({ result: String(env.result ?? ""), usd: Number(env.total_cost_usd ?? 0) });
      } catch {
        reject(new Error(`claude output not JSON: ${out.slice(0, 300)}`));
      }
    });
  });
}

/* ─── Generic OpenAI-compatible runner (serves ~24 providers) ──────────────
   Any provider whose kind is openai-compat / local-openai-compat: POST
   {baseUrl}/chat/completions with a bearer (or no) key and the OpenAI choices[]
   shape. Per-provider quirks (reasoning models, json mode, locals) handled inline. */
const REASONING_MODEL = /(\b|\/)(o\d(-|\b)|gpt-5|deepseek-reasoner|grok-4|grok-3-mini)|reasoning|-r1\b/i;

function modelFor(def: ProviderDef, tier: BrainTier, modelOverride?: string): string {
  if (modelOverride) return modelOverride;
  const envM = process.env[`${def.id.toUpperCase()}_MODEL`];
  if (envM) return envM;
  if (def.id === "openrouter") return openrouterModel(tier);
  return def.exampleModels[0];
}

function runOpenAICompat(def: ProviderDef, prompt: string, tier: BrainTier, keyOverride?: string, modelOverride?: string): { result: string; usd: number } {
  const key = keyOverride || (def.apiKeyEnv ? process.env[def.apiKeyEnv] : undefined);
  if (def.auth !== "none" && !key) throw new Error(`${def.id}: ${def.apiKeyEnv} is not set`);
  const model = modelFor(def, tier, modelOverride);
  const reasoning = REASONING_MODEL.test(model);
  // json_object is widely honoured; skip it for locals + a couple that 400 on it.
  const wantJson = def.kind !== "local-openai-compat" && def.id !== "perplexity" && def.id !== "cohere" && !reasoning;
  const body: Record<string, unknown> = { model, messages: [{ role: "user", content: prompt }] };
  if (!reasoning) body.temperature = 0.7;
  const maxTok = Number(process.env[`${def.id.toUpperCase()}_MAX_TOKENS`] || 16000);
  body[def.id === "openai" && reasoning ? "max_completion_tokens" : "max_tokens"] = maxTok;
  if (wantJson) body.response_format = { type: "json_object" };
  if (def.id === "openrouter") body.usage = { include: true };
  const bf = join(tmpdir(), `oc_${def.id}_${Math.abs(hash(prompt))}.json`);
  writeFileSync(bf, JSON.stringify(body));
  const url = def.baseUrl.replace(/\/$/, "") + "/chat/completions";
  const headers = ["-H", "Content-Type: application/json"];
  if (def.auth === "bearer" && key) headers.push("-H", `Authorization: Bearer ${key}`);
  else if (def.auth === "x-api-key" && key) headers.push("-H", `api-key: ${key}`);
  if (def.id === "openrouter") headers.push("-H", "X-Title: Labrinox");
  // The SOCKS egress proxy is only for OpenRouter (geo-blocked region path).
  const proxy = process.env.BRAIN_PROXY;
  const proxyArgs = proxy && def.id === "openrouter" ? ["--socks5-hostname", proxy.replace(/^socks5h?:\/\//, "")] : [];
  const r = spawnSync("curl", ["-s", ...proxyArgs, "-X", "POST", url, ...headers, "-d", `@${bf}`], { encoding: "utf8", timeout: 1000 * 120, maxBuffer: 1 << 25 });
  rmSync(bf, { force: true });
  let j: { choices?: { message?: { content?: string } }[]; usage?: { cost?: number }; error?: { message?: string } | string };
  try { j = JSON.parse(r.stdout); } catch { throw new Error(`${def.id}: non-JSON response: ${(r.stdout || r.stderr || "").slice(0, 300)}`); }
  if (j.error) throw new Error(`${def.id}: ${typeof j.error === "string" ? j.error : j.error?.message}`);
  return { result: j.choices?.[0]?.message?.content ?? "", usd: Number(j.usage?.cost ?? 0) };
}

/* Thin wrapper kept for the claude→openrouter transparent fallback callsite. */
function runOpenRouter(prompt: string, tier: BrainTier, keyOverride?: string, modelOverride?: string): { result: string; usd: number } {
  return runOpenAICompat(getProvider("openrouter")!, prompt, tier, keyOverride, modelOverride);
}

/* ─── Anthropic Messages API (native — no /chat/completions) ──────────────── */
function runAnthropic(def: ProviderDef, prompt: string, tier: BrainTier, keyOverride?: string, modelOverride?: string): { result: string; usd: number } {
  const key = keyOverride || process.env[def.apiKeyEnv];
  if (!key) throw new Error(`anthropic: ${def.apiKeyEnv} is not set`);
  const model = modelOverride || process.env.ANTHROPIC_MODEL || def.exampleModels[1] || def.exampleModels[0];
  const bf = join(tmpdir(), `an_${Math.abs(hash(prompt))}.json`);
  // Current Claude models 400 on temperature/top_p — omit them entirely.
  writeFileSync(bf, JSON.stringify({ model, max_tokens: Number(process.env.ANTHROPIC_MAX_TOKENS || 16000), messages: [{ role: "user", content: prompt }] }));
  const r = spawnSync("curl", ["-s", "-X", "POST", `${def.baseUrl.replace(/\/$/, "")}/v1/messages`,
    "-H", `x-api-key: ${key}`, "-H", "anthropic-version: 2023-06-01", "-H", "Content-Type: application/json", "-d", `@${bf}`],
    { encoding: "utf8", timeout: 1000 * 120, maxBuffer: 1 << 25 });
  rmSync(bf, { force: true });
  let j: { content?: { text?: string }[]; error?: { message?: string } };
  try { j = JSON.parse(r.stdout); } catch { throw new Error(`anthropic: non-JSON response: ${(r.stdout || r.stderr || "").slice(0, 300)}`); }
  if (j.error) throw new Error(`anthropic: ${j.error.message}`);
  return { result: j.content?.[0]?.text ?? "", usd: 0 };
}

/* ─── Google Gemini (native generateContent) ──────────────────────────────── */
function runGemini(def: ProviderDef, prompt: string, _tier: BrainTier, keyOverride?: string, modelOverride?: string): { result: string; usd: number } {
  const key = keyOverride || process.env[def.apiKeyEnv];
  if (!key) throw new Error(`gemini: ${def.apiKeyEnv} is not set`);
  const model = modelOverride || process.env.GEMINI_MODEL || def.exampleModels[1] || def.exampleModels[0];
  const bf = join(tmpdir(), `gm_${Math.abs(hash(prompt))}.json`);
  writeFileSync(bf, JSON.stringify({ contents: [{ role: "user", parts: [{ text: prompt }] }], generationConfig: { responseMimeType: "application/json", maxOutputTokens: Number(process.env.GEMINI_MAX_TOKENS || 16000), temperature: 0.7 } }));
  const url = `${def.baseUrl.replace(/\/$/, "")}/models/${model}:generateContent`;
  const r = spawnSync("curl", ["-s", "-X", "POST", url, "-H", `x-goog-api-key: ${key}`, "-H", "Content-Type: application/json", "-d", `@${bf}`],
    { encoding: "utf8", timeout: 1000 * 120, maxBuffer: 1 << 25 });
  rmSync(bf, { force: true });
  let j: { candidates?: { content?: { parts?: { text?: string }[] } }[]; error?: { message?: string } };
  try { j = JSON.parse(r.stdout); } catch { throw new Error(`gemini: non-JSON response: ${(r.stdout || r.stderr || "").slice(0, 300)}`); }
  if (j.error) throw new Error(`gemini: ${j.error.message}`);
  return { result: j.candidates?.[0]?.content?.parts?.[0]?.text ?? "", usd: 0 };
}

/* ─── Codex CLI (ChatGPT/Codex subscription) ───────────────────────────── */
function runCodex(prompt: string): { result: string; usd: number } {
  const r = spawnSync("codex", ["exec", "--skip-git-repo-check", prompt], { encoding: "utf8", timeout: 1000 * 180, maxBuffer: 1 << 25 });
  if (r.status !== 0) throw new Error(`codex exited ${r.status}: ${(r.stderr || "").slice(0, 300)}`);
  return { result: r.stdout || "", usd: 0 }; // subscription → no per-call cost
}

/* ─── provider fallback chain ──────────────────────────────────────────── */

type BrainCfg = ReturnType<typeof resolveBrainConfig>;

/* Cheap prerequisite probe — mirrors the checks each run* backend makes at
   spawn time (key set / binary on disk) without duplicating them deeply. */
function providerReady(provider: string, cfg: BrainCfg): boolean {
  if (isProviderDisabled(process.env.SOCHELI_WORKSPACE_ID, provider)) return false; // revoked
  if (provider === "codex") return true; // probed at spawn; ENOENT rotates
  if (provider === "claude") return Boolean(resolveClaudeBin() || cfg.openrouterKey || process.env.OPENROUTER_API_KEY);
  const def = getProvider(provider);
  if (!def) return false;
  if (def.auth === "none") return true; // keyless local servers (ollama/lmstudio)
  return Boolean(getProviderApiKey(process.env.SOCHELI_WORKSPACE_ID, provider) || (def.apiKeyEnv && process.env[def.apiKeyEnv]));
}

/* The chain think() walks: [workspace/BRAIN_PROVIDER primary] + BRAIN_FALLBACK
   (comma list, default "openrouter"), deduped, filtered to providers whose
   prerequisites exist. Never empty — if nothing is ready we keep the primary
   so the eventual failure carries that provider's real error message. */
export function brainProviderChain(cfg: BrainCfg = resolveBrainConfig(process.env.SOCHELI_WORKSPACE_ID)): string[] {
  const primary = cfg.provider.toLowerCase();
  const fallbacks = (process.env.BRAIN_FALLBACK || "openrouter")
    .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  const deduped = [primary, ...fallbacks].filter((p, i, a) => a.indexOf(p) === i);
  const chain = deduped.filter((p) => providerReady(p, cfg));
  return chain.length ? chain : [primary];
}

async function runBrain(prompt: string, tier: BrainTier, providerOverride?: string, taskModel?: string): Promise<{ result: string; usd: number }> {
  const cfg = resolveBrainConfig(process.env.SOCHELI_WORKSPACE_ID);
  const provider = (providerOverride || cfg.provider).toLowerCase();
  // The two local CLI providers spawn their own process (subscription auth).
  if (provider === "codex") return runCodex(prompt);
  if (provider === "claude") {
    // Claude Code CLI; if it isn't installed but an OpenRouter key IS set, fall
    // through transparently rather than failing the whole run (the old "spawn
    // claude ENOENT" degraded baseline).
    if (!resolveClaudeBin() && (cfg.openrouterKey || process.env.OPENROUTER_API_KEY)) return runOpenRouter(prompt, tier, cfg.openrouterKey, taskModel);
    const claudeTok = getProviderApiKey(process.env.SOCHELI_WORKSPACE_ID, "claude"); // active Claude account OAuth token (multi-login)
    return runClaude(prompt, tier, cfg.anthropicKey, taskModel, claudeTok);
  }
  // Everything else dispatches off the provider registry. A per-task model
  // override (taskModel) wins for THIS call; the key is the stored workspace key
  // for the active provider, else the provider's env var.
  const def = getProvider(provider);
  if (!def) {
    if (cfg.openrouterKey || process.env.OPENROUTER_API_KEY) return runOpenRouter(prompt, tier, cfg.openrouterKey, taskModel);
    throw new Error(`unknown brain provider: ${provider}`);
  }
  const key = getProviderApiKey(process.env.SOCHELI_WORKSPACE_ID, provider) || (def.apiKeyEnv ? process.env[def.apiKeyEnv] : undefined);
  if (def.kind === "anthropic") return runAnthropic(def, prompt, tier, key, taskModel);
  if (def.kind === "gemini-native") return runGemini(def, prompt, tier, key, taskModel);
  return runOpenAICompat(def, prompt, tier, key, taskModel);
}

const hash = (s: string) => {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
};

/* Tolerant repair for the malformations cheap models actually emit — beyond the
   trailing comma: a MISSING comma between two values ("Expected ',' or ']' after
   array element"), and a TRUNCATED tail (unterminated string / unclosed brackets
   when the model hits its token cap). String-aware so it never touches content
   inside quotes. Valid JSON passes through unchanged (every value is already
   followed by , } ] or :, none of which trigger an insertion). */
function repairJson(s: string): string {
  let out = "";
  let inStr = false;
  let esc = false;
  let last = ""; // last significant char emitted OUTSIDE a string
  const stack: string[] = [];
  // a value just ended when `last` is a closing quote/bracket or a literal/number char
  const valueEnded = () => last === '"' || last === "}" || last === "]" || /[0-9a-zA-Z]/.test(last);
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      out += c;
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      if (!inStr) last = '"';
      continue;
    }
    if (c === '"' || c === "{" || c === "[" || /[-0-9tfn]/.test(c)) {
      // a value (or key) is starting — if the previous token already closed a
      // value with no separator between, the model dropped a comma. Insert it.
      if (valueEnded()) out += ",";
    }
    if (c === '"') { inStr = true; out += c; continue; }
    if (c === "{" || c === "[") { stack.push(c); out += c; last = c; continue; }
    if (c === "}" || c === "]") { stack.pop(); out += c; last = c; continue; }
    out += c;
    if (!/\s/.test(c)) last = c; // ':' ',' digits, literal chars
  }
  if (inStr) out += '"'; // close a truncated string
  while (stack.length) out += stack.pop() === "{" ? "}" : "]"; // close truncated structures
  return out.replace(/,(\s*[}\]])/g, "$1"); // and strip any trailing commas
}

function extractJson(raw: string): unknown {
  let s = raw.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) s = fence[1].trim();
  const start = s.search(/[[{]/);
  if (start > 0) s = s.slice(start);
  const lastObj = s.lastIndexOf("}");
  const lastArr = s.lastIndexOf("]");
  const end = Math.max(lastObj, lastArr);
  if (end >= 0) s = s.slice(0, end + 1);
  try {
    return JSON.parse(s);
  } catch {
    // 1) the cheap fix: trailing commas before } or ]
    try {
      return JSON.parse(s.replace(/,(\s*[}\]])/g, "$1"));
    } catch {
      // 2) the tolerant repair: missing separators + truncated tail. Re-slice
      //    from the ORIGINAL (the truncated case may have no closing bracket to
      //    slice to, so repairJson balances it).
      return JSON.parse(repairJson(start > 0 ? raw.trim().slice(start) : raw.trim()));
    }
  }
}

/* think — one-shot JSON brain with an automatic provider FALLBACK CHAIN.

   Walks brainProviderChain() (primary + BRAIN_FALLBACK). Per error class
   (harness/errors.ts):
     model     → retry the SAME provider with parse feedback, up to `retries`
                 extra attempts (the existing zod-retry semantics, unchanged)
     transient → one same-provider retry, then advance to the next provider
     unavailable/auth/quota/bare-nonzero-exit → advance immediately
   Hard cap of 6 total attempts across the whole chain. */
export async function think<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, prompt: string, tier: BrainTier = "smart", retries = 2, task?: string): Promise<BrainResult<T>> {
  // Per-task override (user picked a model/tier for this named task in the picker).
  // The model is encoded "provider/model"; a task-set provider jumps to the FRONT
  // of the fallback chain so this task runs on the chosen provider first.
  const ov = getTaskOverride(task);
  const effTier: BrainTier = ov?.tier ?? tier;
  const parsed = parseTaskModel(ov?.model);
  const taskProvider = parsed?.provider;
  const taskModel = parsed?.model;
  const baseChain = brainProviderChain();
  const chain = taskProvider ? [taskProvider, ...baseChain.filter((p) => p !== taskProvider)] : baseChain;
  const maxAttempts = 6;
  let totalUsd = 0;
  let attempts = 0;
  const failures: string[] = []; // "provider(class: message)" per abandoned provider

  for (let pi = 0; pi < chain.length && attempts < maxAttempts; pi++) {
    const provider = chain[pi];
    const next = chain[pi + 1];
    let modelErr: unknown; // last model-class failure on THIS provider — fed back into the prompt
    let transientRetried = false;
    let providerAttempt = 0;
    for (;;) {
      attempts++;
      providerAttempt++;
      // small backoff on same-provider retries — rides out subprocess blips/rate limits
      if (providerAttempt > 1) await new Promise((r) => setTimeout(r, 1500 * (providerAttempt - 1)));
      const tieredPrompt =
        modelErr === undefined
          ? prompt
          : `${prompt}\n\nYour previous reply failed: ${String(modelErr).slice(0, 300)}\nReturn ONLY valid compact JSON, no prose, no markdown fence.`;
      try {
        // both the subprocess call AND validation are inside the retry — a crashed
        // claude/codex invocation retries/rotates instead of killing the whole run.
        // Apply the task's model only to its chosen provider (or when none was set,
        // to whatever provider runs). A wrong-provider slug on a fallback hop is skipped.
        const modelForCall = !taskProvider || taskProvider === provider ? taskModel : undefined;
        const { result, usd } = await runBrain(tieredPrompt, effTier, provider, modelForCall);
        totalUsd += usd;
        const parsed = schema.parse(extractJson(result));
        return { data: parsed, usd: totalUsd };
      } catch (e) {
        const isZod = e instanceof z.ZodError;
        const msg = isZod ? JSON.stringify(e.issues.slice(0, 4)) : String((e as Error)?.message ?? e);
        const cls: ProviderErrorClass = isZod ? "model" : classifyProviderError(msg);
        const rotate = !isZod && shouldRotate(cls, msg);
        const capped = attempts >= maxAttempts;
        if (!rotate && cls === "model" && providerAttempt <= retries && !capped) {
          modelErr = msg; // zod/parse failure → retry same provider with feedback
          continue;
        }
        if (cls === "transient" && !transientRetried && !capped) {
          transientRetried = true; // one same-provider retry, then advance
          continue;
        }
        failures.push(`${provider}(${cls}: ${msg.slice(0, 200)})`);
        if (next && !capped) console.error(`brain: ${provider} failed (${cls}) → ${next}`);
        break; // advance to the next provider in the chain
      }
    }
  }
  throw new Error(`brain failed: ${failures.join("; ") || "no providers available"}`);
}
