/**
 * @os/engine SDK — the in-process, typed client for the single canonical tool
 * registry (tools/registry.ts).
 *
 * This is for code that already runs *inside* the engine / agent (tsx-run,
 * node-only). It is a thin, dependency-free re-export layer over the registry:
 *
 *   - callTool(name, input)   — call any tool by name (validated + awaited)
 *   - allTools                — every EditorTool (editor + pipeline + …)
 *   - toolsManifest()         — canonical name/description/kind/jsonschema list
 *   - tools.<camelCaseName>() — convenience: tools.editorListItems(input) etc.
 *
 * NOTE: do NOT import this file into a Next bundle. The registry pulls in
 * node-only engine modules (fs/child_process). Browser/dashboard code must go
 * through the HTTP API, which spawns the engine tool runner.
 */

import type { EditorTool, ToolResult } from "./editor-tools.ts";
import {
  type PipelineTool,
  type ToolKind,
  allTools,
  callTool,
  toolsManifest,
} from "./tools/registry.ts";

// Re-export the canonical primitives so consumers import everything from one place.
export { allTools, callTool, toolsManifest };
export type { EditorTool, PipelineTool, ToolKind, ToolResult };

/** Convert a registry tool name (snake_case) to a camelCase method key. */
function toCamelCase(name: string): string {
  return name.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

/**
 * Map of tool name -> the convenience method name exposed on `tools`.
 * Useful for tooling/introspection (e.g. building docs or a JS proxy elsewhere).
 */
export const toolMethodNames: Record<string, string> = Object.fromEntries(
  allTools.map((t) => [t.name, toCamelCase(t.name)]),
);

/**
 * Convenience object: `tools.editorListItems(input)` === `callTool("editor_list_items", input)`.
 *
 * Built dynamically from `allTools` so it always covers every registered tool
 * (editor + pipeline + publish + grow + analytics + assets + channels). Typed
 * loosely as a record of input -> ToolResult fns; for fully-typed input use
 * `callTool` with the tool's known shape, or read `toolsManifest()`.
 */
export const tools: Record<string, (input?: any) => Promise<ToolResult>> = Object.fromEntries(
  allTools.map((t) => [toCamelCase(t.name), (input: any = {}) => callTool(t.name, input)]),
);
