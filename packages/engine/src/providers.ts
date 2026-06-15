/* The pluggable LLM provider registry (OpenClaw-style: any provider, any model).
   Most providers speak the OpenAI /chat/completions shape, so ONE generic runner
   (brain.ts runOpenAICompat) serves ~24 of them; only Anthropic and Gemini need
   native adapters, and claude/codex stay on their local CLI spawn paths. This is
   pure data + lookups — no I/O — shared by brain.ts (dispatch), ai-providers.ts
   (config/status), and the dashboard model pickers. */

export type ProviderKind = "openai-compat" | "local-openai-compat" | "anthropic" | "gemini-native" | "cli";
export type ProviderAuth = "bearer" | "x-api-key" | "x-goog-api-key" | "none";

export type ProviderDef = {
  id: string;
  label: string;
  kind: ProviderKind;
  baseUrl: string;       // OpenAI-compatible /v1 base (empty for cli)
  apiKeyEnv: string;     // env var holding the key (empty for cli / keyless local)
  auth: ProviderAuth;
  modelsEndpoint: string; // GET path that lists models, if any
  exampleModels: string[];
};

export const PROVIDERS: ProviderDef[] = [
  // ── first-party clouds ──
  { id: "openai", label: "OpenAI", kind: "openai-compat", baseUrl: "https://api.openai.com/v1", apiKeyEnv: "OPENAI_API_KEY", auth: "bearer", modelsEndpoint: "/models", exampleModels: ["gpt-4o", "gpt-4o-mini", "o4-mini", "gpt-5-mini"] },
  { id: "anthropic", label: "Anthropic (Claude API)", kind: "anthropic", baseUrl: "https://api.anthropic.com", apiKeyEnv: "ANTHROPIC_API_KEY", auth: "x-api-key", modelsEndpoint: "/v1/models", exampleModels: ["claude-opus-4-8", "claude-sonnet-4-6", "claude-haiku-4-5", "claude-fable-5"] },
  { id: "gemini", label: "Google Gemini", kind: "gemini-native", baseUrl: "https://generativelanguage.googleapis.com/v1beta", apiKeyEnv: "GEMINI_API_KEY", auth: "x-goog-api-key", modelsEndpoint: "/models", exampleModels: ["gemini-2.5-pro", "gemini-2.5-flash", "gemini-2.0-flash", "gemini-2.5-flash-lite"] },
  { id: "xai", label: "xAI (Grok)", kind: "openai-compat", baseUrl: "https://api.x.ai/v1", apiKeyEnv: "XAI_API_KEY", auth: "bearer", modelsEndpoint: "/models", exampleModels: ["grok-4", "grok-3", "grok-3-mini"] },
  { id: "mistral", label: "Mistral AI", kind: "openai-compat", baseUrl: "https://api.mistral.ai/v1", apiKeyEnv: "MISTRAL_API_KEY", auth: "bearer", modelsEndpoint: "/models", exampleModels: ["mistral-large-latest", "mistral-small-latest", "codestral-latest"] },
  { id: "deepseek", label: "DeepSeek", kind: "openai-compat", baseUrl: "https://api.deepseek.com/v1", apiKeyEnv: "DEEPSEEK_API_KEY", auth: "bearer", modelsEndpoint: "/models", exampleModels: ["deepseek-chat", "deepseek-reasoner"] },
  { id: "cohere", label: "Cohere", kind: "openai-compat", baseUrl: "https://api.cohere.ai/compatibility/v1", apiKeyEnv: "COHERE_API_KEY", auth: "bearer", modelsEndpoint: "/models", exampleModels: ["command-a-03-2025", "command-r-plus", "command-r"] },
  { id: "perplexity", label: "Perplexity", kind: "openai-compat", baseUrl: "https://api.perplexity.ai", apiKeyEnv: "PERPLEXITY_API_KEY", auth: "bearer", modelsEndpoint: "", exampleModels: ["sonar", "sonar-pro", "sonar-reasoning"] },
  // ── fast / cheap inference clouds ──
  { id: "groq", label: "Groq", kind: "openai-compat", baseUrl: "https://api.groq.com/openai/v1", apiKeyEnv: "GROQ_API_KEY", auth: "bearer", modelsEndpoint: "/models", exampleModels: ["llama-3.3-70b-versatile", "llama-3.1-8b-instant", "moonshotai/kimi-k2-instruct"] },
  { id: "cerebras", label: "Cerebras", kind: "openai-compat", baseUrl: "https://api.cerebras.ai/v1", apiKeyEnv: "CEREBRAS_API_KEY", auth: "bearer", modelsEndpoint: "/models", exampleModels: ["llama-3.3-70b", "qwen-3-32b", "gpt-oss-120b"] },
  { id: "together", label: "Together AI", kind: "openai-compat", baseUrl: "https://api.together.xyz/v1", apiKeyEnv: "TOGETHER_API_KEY", auth: "bearer", modelsEndpoint: "/models", exampleModels: ["meta-llama/Llama-3.3-70B-Instruct-Turbo", "deepseek-ai/DeepSeek-V3", "Qwen/Qwen2.5-72B-Instruct-Turbo"] },
  { id: "fireworks", label: "Fireworks AI", kind: "openai-compat", baseUrl: "https://api.fireworks.ai/inference/v1", apiKeyEnv: "FIREWORKS_API_KEY", auth: "bearer", modelsEndpoint: "/models", exampleModels: ["accounts/fireworks/models/llama-v3p3-70b-instruct", "accounts/fireworks/models/deepseek-v3"] },
  { id: "deepinfra", label: "DeepInfra", kind: "openai-compat", baseUrl: "https://api.deepinfra.com/v1/openai", apiKeyEnv: "DEEPINFRA_API_KEY", auth: "bearer", modelsEndpoint: "/models", exampleModels: ["meta-llama/Llama-3.3-70B-Instruct", "deepseek-ai/DeepSeek-V3", "Qwen/Qwen2.5-72B-Instruct"] },
  { id: "nebius", label: "Nebius AI Studio", kind: "openai-compat", baseUrl: "https://api.studio.nebius.com/v1", apiKeyEnv: "NEBIUS_API_KEY", auth: "bearer", modelsEndpoint: "/models", exampleModels: ["meta-llama/Llama-3.3-70B-Instruct", "deepseek-ai/DeepSeek-V3"] },
  { id: "hyperbolic", label: "Hyperbolic", kind: "openai-compat", baseUrl: "https://api.hyperbolic.xyz/v1", apiKeyEnv: "HYPERBOLIC_API_KEY", auth: "bearer", modelsEndpoint: "/models", exampleModels: ["meta-llama/Llama-3.3-70B-Instruct", "deepseek-ai/DeepSeek-V3"] },
  { id: "sambanova", label: "SambaNova", kind: "openai-compat", baseUrl: "https://api.sambanova.ai/v1", apiKeyEnv: "SAMBANOVA_API_KEY", auth: "bearer", modelsEndpoint: "/models", exampleModels: ["Meta-Llama-3.3-70B-Instruct", "DeepSeek-R1", "Qwen2.5-72B-Instruct"] },
  // ── aggregators / routers ──
  { id: "openrouter", label: "OpenRouter", kind: "openai-compat", baseUrl: "https://openrouter.ai/api/v1", apiKeyEnv: "OPENROUTER_API_KEY", auth: "bearer", modelsEndpoint: "/models", exampleModels: ["anthropic/claude-sonnet-4.6", "openai/gpt-4o", "google/gemini-2.5-flash", "meta-llama/llama-3.3-70b-instruct"] },
  { id: "requesty", label: "Requesty", kind: "openai-compat", baseUrl: "https://router.requesty.ai/v1", apiKeyEnv: "REQUESTY_API_KEY", auth: "bearer", modelsEndpoint: "/models", exampleModels: ["openai/gpt-4o", "anthropic/claude-sonnet-4.5", "deepseek/deepseek-chat"] },
  { id: "helicone", label: "Helicone Gateway", kind: "openai-compat", baseUrl: "https://ai-gateway.helicone.ai/v1", apiKeyEnv: "HELICONE_API_KEY", auth: "bearer", modelsEndpoint: "/models", exampleModels: ["gpt-4o", "claude-sonnet-4-5", "gemini-2.5-flash"] },
  // ── local / self-hosted (OpenAI-compatible servers) ──
  { id: "ollama", label: "Ollama (local)", kind: "local-openai-compat", baseUrl: "http://localhost:11434/v1", apiKeyEnv: "", auth: "none", modelsEndpoint: "/models", exampleModels: ["llama3.3:70b", "qwen2.5:14b", "gemma3:12b", "deepseek-r1:8b"] },
  { id: "lmstudio", label: "LM Studio (local)", kind: "local-openai-compat", baseUrl: "http://localhost:1234/v1", apiKeyEnv: "", auth: "none", modelsEndpoint: "/models", exampleModels: ["qwen2.5-7b-instruct", "llama-3.2-3b-instruct", "phi-4"] },
  { id: "vllm", label: "vLLM (local)", kind: "local-openai-compat", baseUrl: "http://localhost:8000/v1", apiKeyEnv: "VLLM_API_KEY", auth: "bearer", modelsEndpoint: "/models", exampleModels: ["meta-llama/Llama-3.1-8B-Instruct", "Qwen/Qwen2.5-7B-Instruct"] },
  { id: "llamacpp", label: "llama.cpp server (local)", kind: "local-openai-compat", baseUrl: "http://localhost:8080/v1", apiKeyEnv: "LLAMACPP_API_KEY", auth: "bearer", modelsEndpoint: "/models", exampleModels: ["qwen2.5-7b-instruct-q4_k_m", "llama-3.1-8b-instruct-q4_k_m"] },
  { id: "litellm", label: "LiteLLM Proxy (local)", kind: "local-openai-compat", baseUrl: "http://localhost:4000/v1", apiKeyEnv: "LITELLM_API_KEY", auth: "bearer", modelsEndpoint: "/models", exampleModels: ["gpt-4o", "claude-sonnet-4-5", "gemini-2.5-flash"] },
  // ── local CLI subscriptions (spawned, no HTTP) ──
  { id: "claude", label: "Claude Code (local CLI)", kind: "cli", baseUrl: "", apiKeyEnv: "", auth: "none", modelsEndpoint: "", exampleModels: ["claude-opus-4-8", "claude-sonnet-4-6", "claude-haiku-4-5"] },
  { id: "codex", label: "Codex CLI (local)", kind: "cli", baseUrl: "", apiKeyEnv: "", auth: "none", modelsEndpoint: "", exampleModels: ["gpt-5-codex"] },
];

const BY_ID = new Map(PROVIDERS.map((p) => [p.id, p] as const));
export const PROVIDER_IDS: string[] = PROVIDERS.map((p) => p.id);
export const getProvider = (id?: string): ProviderDef | undefined => {
  const def = id ? BY_ID.get(id.toLowerCase()) : undefined;
  // Ollama's baseUrl is otherwise hardcoded to localhost:11434 — let OLLAMA_BASE_URL
  // point the local-model brain at a remote host (e.g. a LAN GPU box's Ollama).
  // Accepts a bare host or a full /v1 base; normalized to an OpenAI-compat /v1 URL.
  if (def?.id === "ollama" && process.env.OLLAMA_BASE_URL) {
    let url = process.env.OLLAMA_BASE_URL.trim().replace(/\/+$/, "");
    if (!/\/v1$/.test(url)) url += "/v1";
    return { ...def, baseUrl: url };
  }
  return def;
};
export const isKnownProvider = (id?: string): boolean => !!getProvider(id);

/* A per-task model override is encoded "provider/model" (split on the FIRST "/"
   so namespaced slugs like openrouter/anthropic/claude-sonnet-4.6 survive). A
   bare string with no known provider prefix is a model for the active provider. */
export function parseTaskModel(s?: string): { provider?: string; model?: string } | null {
  if (!s || !s.trim()) return null;
  const v = s.trim();
  const slash = v.indexOf("/");
  if (slash > 0) {
    const head = v.slice(0, slash);
    if (BY_ID.has(head.toLowerCase())) return { provider: head.toLowerCase(), model: v.slice(slash + 1) };
  }
  return { model: v };
}
