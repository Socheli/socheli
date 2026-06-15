import "server-only";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ResponderConfig, ResponderTemplate } from "@os/schemas";
import type { ResponderConfig as ResponderConfigT, ResponderTemplate as ResponderTemplateT } from "@os/schemas";
import { REPO_ROOT } from "./data";

/* The dashboard's READ view of the per-brand responder store
   (data/responder/<channel>/config.json + templates.json — the gitignored
   files the engine's responder.ts owns). Reads happen here directly and are
   validated against the shared schemas (the lib/missions.ts pattern); every
   MUTATION (set config / save rule / template CRUD / test / run) goes through
   the engine via the canonical tool runner so the classifier + Brand-Genome
   voice + guardrails are never re-implemented. */

const sani = (c: string) => (c || "global").replace(/[^a-zA-Z0-9_-]/g, "-");
const responderDir = (ch: string) => join(REPO_ROOT, "data", "responder", sani(ch));

function readJson<T>(path: string, fallback: T): T {
  try {
    return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as T) : fallback;
  } catch {
    return fallback;
  }
}

/* A defensive default config when a brand has no responder configured yet —
   mirrors the schema defaults (disabled, empty rules, auto_send default with
   complaint/risky guardrailed off). */
function defaultConfig(channel: string): ResponderConfigT {
  return {
    channel,
    enabled: false,
    rules: [],
    defaultAction: "auto_send",
    respectDmWindow: true,
    neverAutoSentiments: ["complaint", "risky"],
  };
}

/** The responder config for one brand (validated; falls back to defaults). */
export function responderConfigFor(channel: string): ResponderConfigT {
  const raw = readJson<unknown>(join(responderDir(channel), "config.json"), null);
  if (!raw) return defaultConfig(channel);
  const p = ResponderConfig.safeParse(raw);
  return p.success ? p.data : defaultConfig(channel);
}

/** The saved reply templates for one brand (per-entry tolerant parse). */
export function templatesFor(channel: string): ResponderTemplateT[] {
  const raw = readJson<unknown[]>(join(responderDir(channel), "templates.json"), []);
  if (!Array.isArray(raw)) return [];
  return raw
    .map((t) => ResponderTemplate.safeParse(t))
    .filter((p): p is { success: true; data: ResponderTemplateT } => p.success)
    .map((p) => p.data);
}

/** Combined responder view for one brand — config + templates. */
export function responderFor(channel: string): { config: ResponderConfigT; templates: ResponderTemplateT[] } {
  return { config: responderConfigFor(channel), templates: templatesFor(channel) };
}

/* ── Engine bridge for responder mutations ──────────────────────────────────
   Same shape as lib/inbox.ts runInboxTool — spawn the canonical tool runner.
   The dashboard never bundles the engine. */

export type ToolResult = { ok: boolean; data?: Record<string, unknown>; message?: string };

const RESPONDER_TOOLS = new Set([
  "responder_get",
  "responder_set",
  "responder_test",
  "responder_run",
  "template_list",
  "template_save",
  "template_delete",
]);

export function runResponderTool(name: string, input: Record<string, unknown>): Promise<ToolResult> {
  if (!RESPONDER_TOOLS.has(name)) return Promise.resolve({ ok: false, message: `not a responder tool: ${name}` });
  const runner = join(REPO_ROOT, "packages", "engine", "src", "tool.ts");
  return new Promise((resolve) => {
    const child = spawn("node", ["--import", "tsx", runner, name, JSON.stringify(input)], { cwd: REPO_ROOT, env: process.env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", (e) => resolve({ ok: false, message: String(e) }));
    child.on("close", () => {
      try {
        resolve(JSON.parse(stdout.trim()) as ToolResult);
      } catch {
        resolve({ ok: false, message: (stderr || stdout).trim().slice(0, 2000) || "engine produced no output" });
      }
    });
  });
}
