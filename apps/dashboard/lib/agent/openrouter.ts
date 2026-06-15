import { ChatOpenAI } from "@langchain/openai";
import { getCopilotModel } from "./model-config";

/* OpenRouter-backed chat model for the Socheli in-app copilot.
   We talk to OpenRouter through the OpenAI-compatible surface of ChatOpenAI:
   just point configuration.baseURL at OpenRouter and pass OPENROUTER_API_KEY.

   IMPORTANT — the copilot does NOT read OPENROUTER_MODEL. That var is the ENGINE
   brain's default tier (packages/engine/src/brain.ts), and on the server it's set
   to a small, cheap, RUMINATING model (gemma-4-26b) tuned for batch generation.
   Letting it bleed into the chat path is exactly what kept putting the copilot
   back on a model that dumps its chain-of-thought into the reply. The copilot
   resolves from OPENROUTER_COPILOT_MODEL (a dedicated override) and otherwise the
   clean instruct DEFAULT_MODEL below — never the shared engine var. */

// Gemini 2.5 Flash: a clean, fast, cheap instruct model that returns FINAL
// answers without rambling its deliberation into `content`. For the copilot this
// matters more than raw size — gemma-4-26b / deepseek-v4-flash ruminate their
// whole chain-of-thought inline ("Wait, I should... Actually, I'll..."), which no
// param-gating or sanitizer can fix because the model writes its thinking AS the
// reply. Gemini Flash is strong at tool-calling + structured/JSON output and stays
// concise; same family already used for transcription. Override via OPENROUTER_COPILOT_MODEL.
// The default lives in model-config.ts (DEFAULT_COPILOT_MODEL = Claude Sonnet);
// this constant is kept for reference/compat. makeModel resolves via getCopilotModel().
export const DEFAULT_MODEL = "anthropic/claude-sonnet-4.6";
// Ordered fallback chain — OpenRouter auto-retries the next model on error /
// rate-limit. Comma-separated env override. Only clean instruct models here; the
// ruminating deepseek and the weak gemma are deliberately kept OUT of the chat path.
export const DEFAULT_FALLBACKS = ["google/gemini-2.5-flash-lite", "openai/gpt-4.1-mini"];

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

/* OpenRouter attribution headers — this is the "app name" shown in OpenRouter's
   activity/rankings. Overridable via env. */
const DEFAULT_HEADERS = {
  "HTTP-Referer": process.env.OPENROUTER_SITE_URL || "https://app.socheli.com",
  "X-Title": process.env.OPENROUTER_APP_NAME || "Soli",
};

export function hasOpenRouterKey(): boolean {
  return !!(process.env.OPENROUTER_API_KEY && process.env.OPENROUTER_API_KEY.trim());
}

export type MakeModelOptions = {
  model?: string;
  temperature?: number;
  streaming?: boolean;
};

export function makeModel(opts: MakeModelOptions = {}): ChatOpenAI {
  // Resolution: explicit opts.model → the persisted user choice (data/
  // copilot-model.json, set from the picker / CLI / Soli) → OPENROUTER_COPILOT_MODEL
  // env → Claude default. NEVER the engine's shared OPENROUTER_MODEL (gemma).
  // Read per call so a switch takes effect on the next message with no restart.
  const model = opts.model || getCopilotModel();
  // Optional OpenRouter fallback chain (env-gated, OFF by default — the native
  // `models`-array routing errored with the current request shape; revisit with
  // an app-level retry to gemma-4-31b-it if gemma-4-26b ever proves flaky).
  const fallbacks = (process.env.OPENROUTER_FALLBACK_MODELS || "")
    .split(",").map((s) => s.trim()).filter(Boolean).filter((m) => m !== model);
  const models = opts.model ? [] : fallbacks;
  return new ChatOpenAI({
    model,
    ...(models.length ? { modelKwargs: { models: [model, ...models] } } : {}),
    // Only set temperature when explicitly requested: several OpenRouter-routed
    // reasoning models (o1/o3, some Gemini thinking variants) 400 on any
    // non-default temperature. Unset lets each model use its own default.
    ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
    streaming: opts.streaming ?? true,
    // Without a key the engine path is unreachable; callers must gate on
    // hasOpenRouterKey() first. We still pass a placeholder so construction
    // never throws when the route decides to short-circuit.
    apiKey: process.env.OPENROUTER_API_KEY || "missing",
    configuration: {
      baseURL: OPENROUTER_BASE_URL,
      defaultHeaders: DEFAULT_HEADERS,
    },
  });
}
