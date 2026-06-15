import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "../data";

/* The model that powers Soli (the in-app copilot). Single source of truth =
   data/copilot-model.json, the SAME file the engine's copilot_model tool writes
   — so switching from the CLI / MCP / by asking Soli, or from the UI picker, all
   land in one place and the copilot picks it up on the next message (makeModel
   reads this per request; no restart). Default = Claude Sonnet: clean instruct
   behaviour (no chain-of-thought leaking into the reply, unlike the engine's
   batch gemma model) and strong tool-calling. */
const FILE = join(REPO_ROOT, "data", "copilot-model.json");

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
  mkdirSync(join(REPO_ROOT, "data"), { recursive: true });
  writeFileSync(FILE, JSON.stringify({ model: m, updatedAt: new Date().toISOString() }, null, 2));
  return m;
}
