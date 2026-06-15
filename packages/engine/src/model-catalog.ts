import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR, nowIso } from "./store.ts";
import { PROVIDERS } from "./providers.ts";
import { getProviderApiKey } from "./ai-providers.ts";

/* The full model catalog for the per-task model picker. OpenRouter's public
   /models endpoint aggregates ~330 models from every upstream (Anthropic, OpenAI,
   Google, Meta, Mistral, DeepSeek, xAI, Qwen, …) with context + pricing + modality,
   so we cache that as the master list (routed via OpenRouter) and also surface
   each connected NATIVE provider's own models for direct routing. Each model is
   enriched with an approximate community (arena-style) rating for the well-known
   families. Cached 24h to data/model-catalog.json; degrades to cache on failure. */

const CACHE = join(DATA_DIR, "model-catalog.json");
const TTL_MS = 24 * 60 * 60 * 1000;

export type CatalogModel = {
  value: string;          // the per-task override string: "<routeProvider>/<id>"
  routeProvider: string;  // provider that serves it (openrouter, or a native id)
  id: string;             // upstream model id
  name: string;
  family: string;         // anthropic|openai|google|meta|mistral|deepseek|xai|…
  context: number;        // context window tokens (0 = unknown)
  pricePromptM?: number;  // USD per 1M prompt tokens
  priceCompletionM?: number;
  free: boolean;
  vision: boolean;        // accepts image input
  rating?: number;        // community (arena-style) ~0-10, curated
  created?: number;       // unix seconds (for "newest")
  direct: boolean;        // true = routed natively (not via OpenRouter)
  available: boolean;     // its routeProvider is connected
};

/* Approximate community/arena scores for well-known families (longest match wins
   by list order). These are a curated convenience signal, not live arena data;
   unmatched models simply have no rating. */
const RATINGS: [RegExp, number][] = [
  [/claude-opus-4[.-]8/i, 9.6], [/claude-opus-4[.-][567]/i, 9.4], [/claude-opus-4/i, 9.2],
  [/claude-sonnet-4[.-]6/i, 9.1], [/claude-sonnet-4[.-]5/i, 9.0], [/claude-sonnet-4/i, 8.9],
  [/claude-3[.-]7-sonnet/i, 8.8], [/claude-fable/i, 9.0], [/claude-haiku-4/i, 8.4], [/claude-3[.-]5-haiku/i, 8.0],
  [/gpt-5/i, 9.2], [/gpt-4[.-]1\b/i, 8.7], [/gpt-4o-mini/i, 8.0], [/gpt-4o/i, 8.6], [/o4-mini/i, 8.2], [/\bo3\b/i, 9.0], [/\bo1\b/i, 8.6],
  [/gemini-2[.-]5-pro/i, 9.0], [/gemini-2[.-]5-flash/i, 8.5], [/gemini-2[.-]0-flash/i, 8.0],
  [/grok-4/i, 8.9], [/grok-3\b/i, 8.4],
  [/deepseek.*(v3|chat)/i, 8.4], [/deepseek.*(r1|reasoner)/i, 8.6],
  [/llama-?3[.-]3-70b/i, 8.0], [/llama-?3[.-]1-405b/i, 8.2], [/llama-?3[.-]1-70b/i, 7.7], [/llama-?4/i, 8.3],
  [/qwen.?3/i, 8.3], [/qwen.?2[.-]5-72b/i, 8.1], [/qwen.*coder/i, 8.0],
  [/mistral-large/i, 7.9], [/mixtral-8x22b/i, 7.6], [/codestral/i, 7.8], [/magistral/i, 7.9],
  [/kimi-k2|moonshot/i, 8.3], [/command-a/i, 7.8], [/command-r-plus/i, 7.5],
  [/glm-4|z-ai/i, 8.0], [/minimax/i, 7.8], [/gpt-oss/i, 8.1],
];
function ratingFor(id: string): number | undefined {
  for (const [re, s] of RATINGS) if (re.test(id)) return s;
  return undefined;
}

const FAMILY_ALIAS: Record<string, string> = {
  "x-ai": "xai", "meta-llama": "meta", "mistralai": "mistral", "moonshotai": "moonshot",
  "z-ai": "zhipu", "ibm-granite": "ibm", "nvidia": "nvidia",
};
function familyOf(idOrProvider: string): string {
  const head = idOrProvider.split("/")[0].replace(/^~/, "").toLowerCase();
  return FAMILY_ALIAS[head] ?? head;
}

type OrModel = { id: string; name?: string; context_length?: number; created?: number; pricing?: { prompt?: string; completion?: string }; architecture?: { input_modalities?: string[] } };

async function fetchOpenRouter(): Promise<OrModel[]> {
  try {
    const r = await fetch("https://openrouter.ai/api/v1/models");
    if (!r.ok) return [];
    const j = (await r.json()) as { data?: OrModel[] };
    return Array.isArray(j.data) ? j.data : [];
  } catch {
    return [];
  }
}

function loadCache(): { at: number; data: OrModel[] } | null {
  try {
    if (existsSync(CACHE)) return JSON.parse(readFileSync(CACHE, "utf8")) as { at: number; data: OrModel[] };
  } catch { /* ignore */ }
  return null;
}

export async function modelCatalog(): Promise<{ models: CatalogModel[]; families: string[]; updatedAt: string; openrouterConnected: boolean; total: number }> {
  const cached = loadCache();
  let raw: OrModel[] = [];
  let at = cached?.at ?? 0;
  if (cached && Date.now() - cached.at < TTL_MS) {
    raw = cached.data;
  } else {
    raw = await fetchOpenRouter();
    if (raw.length) { at = Date.now(); try { mkdirSync(DATA_DIR, { recursive: true }); writeFileSync(CACHE, JSON.stringify({ at, data: raw })); } catch { /* non-fatal */ } }
    else if (cached) { raw = cached.data; at = cached.at; }
  }

  const ws = process.env.SOCHELI_WORKSPACE_ID;
  const orConnected = !!getProviderApiKey(ws, "openrouter") || !!process.env.OPENROUTER_API_KEY;
  const models: CatalogModel[] = [];

  for (const m of raw) {
    if (typeof m.id !== "string" || m.id.startsWith("openrouter/")) continue; // skip OR meta-models (fusion/auto)
    const pp = parseFloat(m.pricing?.prompt ?? "0");
    const pc = parseFloat(m.pricing?.completion ?? "0");
    const vision = !!m.architecture?.input_modalities?.includes("image");
    models.push({
      value: `openrouter/${m.id}`, routeProvider: "openrouter", id: m.id,
      name: m.name || m.id, family: familyOf(m.id),
      context: m.context_length || 0,
      pricePromptM: pp >= 0 ? Math.round(pp * 1e6 * 100) / 100 : undefined,
      priceCompletionM: pc >= 0 ? Math.round(pc * 1e6 * 100) / 100 : undefined,
      free: pp === 0 && pc === 0, vision, rating: ratingFor(m.id), created: m.created,
      direct: false, available: orConnected,
    });
  }

  // Connected native providers → their own models, for DIRECT (no-OpenRouter) routing.
  for (const p of PROVIDERS) {
    if (p.kind === "cli" || p.id === "openrouter") continue;
    const connected = p.auth === "none" || !!getProviderApiKey(ws, p.id) || !!(p.apiKeyEnv && process.env[p.apiKeyEnv]);
    if (!connected) continue;
    for (const m of p.exampleModels) {
      models.push({
        value: `${p.id}/${m}`, routeProvider: p.id, id: m, name: m,
        family: FAMILY_ALIAS[p.id] ?? p.id, context: 0, free: p.auth === "none",
        vision: false, rating: ratingFor(m), direct: true, available: true,
      });
    }
  }

  const families = [...new Set(models.map((m) => m.family))].sort();
  return { models, families, updatedAt: at ? new Date(at).toISOString() : nowIso(), openrouterConnected: orConnected, total: models.length };
}
