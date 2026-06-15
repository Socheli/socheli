/**
 * helpers.ts — leaf module of shared tool-construction helpers.
 *
 * WHY THIS FILE EXISTS (integration fix): these helpers used to live in
 * registry.ts and were imported back by dna-tools/research-tools/mission-tools/
 * harness-tools. registry.ts ALSO imports the tool arrays FROM those files
 * (line "import { dnaTools } from ./dna-tools.ts"), so that back-import formed an
 * import CYCLE. A plain hoisted `function tool()` survives a cycle, but tsx's
 * esbuild `keepNames` transform wraps the arrow returned by `tool()` in the
 * per-module `__name` helper, and `__name` is a top-of-module `var` that is NOT
 * yet initialized while the tool files (imported partway through registry's
 * evaluation) execute their top-level `tool({...})` calls — yielding
 * "TypeError: __name is not a function" at manifest load.
 *
 * The fix is structural: move every shared helper into THIS leaf module, which
 * imports nothing from registry.ts. Both registry.ts (which re-exports them for
 * back-compat) and the four tool files import from here, so there is no cycle and
 * `__name` is fully initialized before any `tool()` call runs.
 */

import { spawn } from "node:child_process";
import { mkdirSync, openSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

import { type EditorTool, type ToolResult } from "../editor-tools.ts";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
export const DATA_DIR = join(ROOT, "data");
export const ENGINE_SRC = join(ROOT, "packages", "engine", "src");

// ---------------------------------------------------------------------------
// ToolResult helpers (mirror editor-tools.ts conventions)
// ---------------------------------------------------------------------------

export function ok(data?: ToolResult["data"], message?: string): ToolResult {
  return { ok: true, data, message };
}

export function fail(error: unknown): ToolResult {
  return { ok: false, message: error instanceof Error ? error.message : String(error) };
}

/** Kick off a detached engine process and return immediately (non-blocking). */
export function spawnEngine(scriptRel: string, args: string[], logName: string): { pid?: number; logPath: string } {
  mkdirSync(DATA_DIR, { recursive: true });
  const script = join(ENGINE_SRC, scriptRel);
  const logPath = join(DATA_DIR, logName);
  const out = openSync(logPath, "a");
  const child = spawn("node", ["--import", "tsx", script, ...args], {
    cwd: ROOT,
    detached: true,
    stdio: ["ignore", out, out],
    env: process.env,
  });
  child.unref();
  return { pid: child.pid, logPath };
}

/** Run the `content` CLI (cli.ts) detached for a high-level command. */
export function spawnCli(cliArgs: string[], logName: string) {
  return spawnEngine("cli.ts", cliArgs, logName);
}

// ---------------------------------------------------------------------------
// PipelineTool: an EditorTool plus a zod schema + cost/effect kind.
// ---------------------------------------------------------------------------

export type ToolKind = "read" | "mutate" | "long";

export type PipelineTool = EditorTool & {
  kind: ToolKind;
  /** zod schema validated by callTool() before run() executes. */
  schema: z.ZodTypeAny;
};

// ---------------------------------------------------------------------------
// Async tool results.
//
// A PipelineTool's run() is SYNCHRONOUS (it returns a ToolResult, not a
// Promise). Tools that must do async work (HTTP, awaited LLM calls) wrap their
// promise with asyncResult(): the promise is smuggled through a PENDING symbol
// and unwrapped+awaited by callTool(). These live in the leaf so any tool file —
// not just registry.ts — can return async results without a cyclic import. The
// symbol is defined ONCE here so its identity is shared across every importer
// (callTool's isPending() check relies on that identity).
// ---------------------------------------------------------------------------

export const PENDING = Symbol("pending-promise");
export type Pending = { [PENDING]: Promise<ToolResult> };

/** Wrap a Promise<ToolResult> so a synchronous run() can return async work. */
export function asyncResult(p: Promise<ToolResult>): ToolResult {
  return { ok: true, data: { __pending__: true } as any, message: "pending", ...({ [PENDING]: p } as any) } as ToolResult;
}

export function isPending(r: ToolResult): r is ToolResult & Pending {
  return !!(r as any)?.[PENDING];
}

/** Build a PipelineTool, deriving inputSchema (json) from the zod schema. */
export function tool(spec: {
  name: string;
  description: string;
  kind: ToolKind;
  schema: z.ZodTypeAny;
  run: (input: any) => ToolResult;
}): PipelineTool {
  return {
    name: spec.name,
    description: spec.description,
    kind: spec.kind,
    schema: spec.schema,
    inputSchema: zodToJsonSchema(spec.schema),
    run: (input: any) => {
      try {
        return spec.run(input ?? {});
      } catch (e) {
        return fail(e);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Minimal zod → JSON Schema converter (no extra dependency).
// Covers the subset of zod used by this registry: objects, strings, numbers,
// booleans, enums, arrays, optionals, defaults and descriptions.
// ---------------------------------------------------------------------------

export function zodToJsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  const def: any = (schema as any)._def;
  const typeName: string = def?.typeName;

  switch (typeName) {
    case "ZodObject": {
      const shape = def.shape();
      const properties: Record<string, unknown> = {};
      const required: string[] = [];
      for (const [key, value] of Object.entries(shape) as [string, z.ZodTypeAny][]) {
        properties[key] = zodToJsonSchema(value);
        if (!isOptional(value)) required.push(key);
      }
      return {
        type: "object",
        properties,
        ...(required.length ? { required } : {}),
        additionalProperties: false,
      };
    }
    case "ZodString":
      return withMeta(schema, { type: "string" });
    case "ZodNumber":
      return withMeta(schema, { type: "number" });
    case "ZodBoolean":
      return withMeta(schema, { type: "boolean" });
    case "ZodEnum":
      return withMeta(schema, { type: "string", enum: def.values });
    case "ZodArray":
      return withMeta(schema, { type: "array", items: zodToJsonSchema(def.type) });
    case "ZodOptional":
    case "ZodNullable":
      return zodToJsonSchema(def.innerType);
    case "ZodDefault": {
      const inner = zodToJsonSchema(def.innerType);
      return { ...inner, default: typeof def.defaultValue === "function" ? def.defaultValue() : def.defaultValue };
    }
    case "ZodEffects":
      return zodToJsonSchema(def.schema);
    default:
      return {};
  }
}

function isOptional(schema: z.ZodTypeAny): boolean {
  const typeName = (schema as any)?._def?.typeName;
  if (typeName === "ZodOptional" || typeName === "ZodDefault" || typeName === "ZodNullable") return true;
  return false;
}

function withMeta(schema: z.ZodTypeAny, base: Record<string, unknown>): Record<string, unknown> {
  const description = (schema as any)?._def?.description;
  return description ? { ...base, description } : base;
}
