import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR, nowIso } from "./store.ts";

/* The model that powers Soli (the in-app copilot / chat). Persisted to a single
   flat JSON the dashboard reads at request time, so switching it (from the UI
   picker, the CLI, or by asking Soli) takes effect on the NEXT message with no
   restart. The copilot talks to OpenRouter, so every preset is an OpenRouter
   slug routed with the existing key — including Anthropic's Claude family.

   Default = Claude Sonnet: clean instruct behaviour (no chain-of-thought
   leaking into the reply, unlike the engine's batch gemma model), strong
   tool-calling, fast enough for interactive chat. */
const FILE = join(DATA_DIR, "copilot-model.json");

export const DEFAULT_COPILOT_MODEL = "anthropic/claude-sonnet-4.6";

export const COPILOT_MODEL_PRESETS: { id: string; label: string; note: string }[] = [
  { id: "claude-code", label: "Claude Code (subscription)", note: "runs on your Claude Code plan via the harness — free, needs connect" },
  { id: "anthropic/claude-sonnet-4.6", label: "Claude Sonnet 4.6", note: "default · best balance for chat + tools" },
  { id: "anthropic/claude-opus-4.8", label: "Claude Opus 4.8", note: "most capable · slower, pricier" },
  { id: "anthropic/claude-haiku-4.5", label: "Claude Haiku 4.5", note: "fastest, cheapest Claude" },
  { id: "google/gemini-2.5-flash", label: "Gemini 2.5 Flash", note: "non-Claude fallback" },
  { id: "openai/gpt-4.1-mini", label: "GPT-4.1 mini", note: "OpenAI option" },
];

export function getCopilotModel(): string {
  try {
    if (existsSync(FILE)) {
      const j = JSON.parse(readFileSync(FILE, "utf8")) as { model?: string };
      if (j?.model && typeof j.model === "string") return j.model;
    }
  } catch {
    /* fall through to env / default */
  }
  return process.env.OPENROUTER_COPILOT_MODEL || DEFAULT_COPILOT_MODEL;
}

export function setCopilotModel(model: string): string {
  const m = model.trim();
  if (!m) throw new Error("model is required");
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(FILE, JSON.stringify({ model: m, updatedAt: nowIso() }, null, 2));
  return m;
}
