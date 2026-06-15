import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

import { CLAUDE_MODELS, resolveClaudeBin } from "../brain.ts";
import { callTool, pipelineTools } from "../tools/registry.ts";
import { ROLE_PRESETS, tierForTask, toolsForTask } from "./roles.ts";
import { DEFAULT_MAX_STEPS, type AgentEvent, type AgentTask, type HarnessRuntime } from "./types.ts";

/* claude-sdk runtime — the PREMIUM default (docs/AGENT-HARNESS.md §3).

   Drives @anthropic-ai/claude-agent-sdk `query()` with an IN-PROCESS MCP
   server (`createSdkMcpServer` + `tool()`) that wraps exactly the registry
   tools the role is allowed to use. Tool dispatch goes through the same
   `callTool` the canonical tool runner (tool.ts) uses, so an SDK agent and a
   CLI/HTTP/MCP caller hit identical code paths and validation.

   The SDK is a soft dependency: it is loaded via dynamic import() so the
   engine still parses/loads when the package isn't installed — available()
   simply returns false and the router falls through to claude-code /
   openrouter. Auth is subscription-friendly: ANTHROPIC_API_KEY when set,
   otherwise the SDK rides the local Claude Code CLI auth (we use
   resolveClaudeBin() as the "CC auth is present" heuristic, same as brain.ts). */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

/* Tier → model. Single source of truth is brain.ts's CLAUDE_MODELS; re-export
   it here so existing importers (claude-code.ts) keep their `from "./claude-sdk.ts"`
   path while the literal lives in exactly one place. */
export { CLAUDE_MODELS };

/** Compose the prompt every runtime sends: injected context first, then the goal. */
export function composePrompt(task: AgentTask): string {
  return task.context ? `<context>\n${task.context}\n</context>\n\n${task.goal}` : task.goal;
}

/* Convert a registry tool's input contract into the zod RAW SHAPE the SDK's
   tool() helper expects. Pipeline tools carry a real zod object — reuse its
   shape verbatim. Editor tools only carry hand-written JSON schema, so we
   rebuild an equivalent (loose) zod shape from it; callTool re-validates with
   the authoritative schema anyway, this shape just gives the model accurate
   parameter names/types. */
function jsonSchemaToZodShape(schema: Record<string, any>): Record<string, z.ZodTypeAny> {
  const props: Record<string, any> = schema?.properties ?? {};
  const required = new Set<string>(Array.isArray(schema?.required) ? schema.required : []);
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [key, prop] of Object.entries(props)) {
    let t: z.ZodTypeAny;
    const p = (prop ?? {}) as Record<string, any>;
    if (Array.isArray(p.enum)) t = z.enum(p.enum as [string, ...string[]]);
    else if (p.type === "string") t = z.string();
    else if (p.type === "number" || p.type === "integer") t = z.number();
    else if (p.type === "boolean") t = z.boolean();
    else if (p.type === "array") t = z.array(z.any());
    else if (p.type === "object") t = z.record(z.any());
    else t = z.any();
    if (typeof p.description === "string") t = t.describe(p.description);
    shape[key] = required.has(key) ? t : t.optional();
  }
  return shape;
}

/* LAZY map: once the integrator spreads harnessTools into the registry there
   is an import cycle (registry → harness-tools → run → router → here →
   registry). Reading the `pipelineTools` const during module init would hit
   its temporal dead zone — deferring to first use makes the cycle safe. */
let _pipelineByName: Map<string, (typeof pipelineTools)[number]> | undefined;
function pipelineByName() {
  return (_pipelineByName ??= new Map(pipelineTools.map((t) => [t.name, t])));
}

function zodShapeFor(name: string, inputSchema: Record<string, unknown>): Record<string, z.ZodTypeAny> {
  const pt = pipelineByName().get(name);
  const s: any = pt?.schema;
  // .strict() objects are still ZodObject — shape is directly reusable.
  if (s && typeof s === "object" && s._def?.typeName === "ZodObject") return s.shape;
  return jsonSchemaToZodShape(inputSchema as Record<string, any>);
}

/* Dispatch one tool call through the canonical registry, tenant-scoped where
   the tool's contract carries TenantFields: strict schemas without a
   workspaceId key would reject an injected field, so we only add it when the
   tool actually declares one. */
export async function dispatchRegistryTool(task: AgentTask, name: string, args: any): Promise<{ ok: boolean; payload: unknown }> {
  let input = args ?? {};
  const pt = pipelineByName().get(name);
  const shape: any = (pt?.schema as any)?._def?.typeName === "ZodObject" ? (pt!.schema as any).shape : null;
  if (task.tenant?.workspaceId && shape && "workspaceId" in shape && input.workspaceId === undefined) {
    input = { ...input, workspaceId: task.tenant.workspaceId };
  }
  const result = await callTool(name, input);
  return { ok: result.ok, payload: result };
}

let _sdk: any | null | undefined;
async function loadSdk(): Promise<any | null> {
  if (_sdk !== undefined) return _sdk;
  try {
    // Dynamic import via a variable specifier: the engine must keep loading
    // (and typechecking) when the dep is absent — available() just goes false.
    const specifier = "@anthropic-ai/claude-agent-sdk";
    _sdk = await import(specifier);
  } catch {
    _sdk = null;
  }
  return _sdk;
}

export const claudeSdkRuntime: HarnessRuntime = {
  id: "claude-sdk",

  async available(): Promise<boolean> {
    const sdk = await loadSdk();
    if (!sdk) return false;
    return Boolean(process.env.ANTHROPIC_API_KEY || resolveClaudeBin());
  },

  async *run(task: AgentTask): AsyncGenerator<AgentEvent> {
    const sdk = await loadSdk();
    if (!sdk) {
      yield { type: "error", message: "claude-sdk runtime unavailable: @anthropic-ai/claude-agent-sdk is not installed (pnpm add @anthropic-ai/claude-agent-sdk -F @os/engine)" };
      return;
    }
    const { query, createSdkMcpServer, tool } = sdk as {
      query: (args: { prompt: string; options?: Record<string, unknown> }) => AsyncGenerator<any, void>;
      createSdkMcpServer: (opts: { name: string; version?: string; tools?: any[] }) => unknown;
      tool: (name: string, description: string, shape: Record<string, z.ZodTypeAny>, handler: (args: any) => Promise<any>) => any;
    };

    const allowed = toolsForTask(task);
    if (!allowed.length) {
      yield { type: "error", message: `no registry tools resolved for role "${task.role}"` };
      return;
    }

    // Wrap each allowed registry tool as an in-process MCP tool. Results are
    // stringified ToolResults so the model sees ok/message/data verbatim.
    const { toolsManifest } = await import("../tools/registry.ts");
    const manifestByName = new Map(toolsManifest().map((t) => [t.name, t]));
    const sdkTools = allowed
      .map((name) => {
        const m = manifestByName.get(name);
        if (!m) return null;
        return tool(name, m.description, zodShapeFor(name, m.inputSchema), async (args: any) => {
          const { ok, payload } = await dispatchRegistryTool(task, name, args);
          return { content: [{ type: "text", text: JSON.stringify(payload) }], isError: !ok };
        });
      })
      .filter(Boolean);

    const server = createSdkMcpServer({ name: "socheli", version: "0.1.0", tools: sdkTools as any[] });
    const maxSteps = task.maxSteps ?? DEFAULT_MAX_STEPS;
    const model = CLAUDE_MODELS[tierForTask(task)];
    const claudeBin = resolveClaudeBin();

    // Map MCP tool_use ids → registry names so tool_result events carry names.
    const callNames = new Map<string, string>();
    const stripMcp = (n: string) => n.replace(/^mcp__socheli__/, "");

    try {
      const stream = query({
        prompt: composePrompt(task),
        options: {
          model,
          maxTurns: maxSteps,
          systemPrompt: ROLE_PRESETS[task.role].systemPrompt,
          mcpServers: { socheli: server },
          allowedTools: allowed.map((n) => `mcp__socheli__${n}`),
          // Headless: deny anything not pre-approved instead of hanging on a
          // permission prompt. Our MCP allowlist is the entire tool surface.
          permissionMode: "dontAsk",
          strictMcpConfig: true,
          cwd: ROOT,
          ...(task.budgetUsd ? { maxBudgetUsd: task.budgetUsd } : {}),
          ...(claudeBin ? { pathToClaudeCodeExecutable: claudeBin } : {}),
        },
      });

      yield { type: "step", label: `claude-sdk · ${model} · ${allowed.length} tools · ≤${maxSteps} turns` };

      for await (const msg of stream) {
        if (msg?.type === "assistant" && Array.isArray(msg.message?.content)) {
          for (const block of msg.message.content) {
            if (block?.type === "text" && block.text) {
              yield { type: "token", text: block.text };
            } else if (block?.type === "tool_use") {
              callNames.set(block.id, stripMcp(block.name));
              yield { type: "tool_call", id: block.id, name: stripMcp(block.name), args: block.input };
            }
          }
        } else if (msg?.type === "user" && Array.isArray(msg.message?.content)) {
          for (const block of msg.message.content) {
            if (block?.type === "tool_result") {
              yield {
                type: "tool_result",
                id: block.tool_use_id,
                name: callNames.get(block.tool_use_id) ?? "unknown",
                ok: !block.is_error,
                result: block.content,
              };
            }
          }
        } else if (msg?.type === "result") {
          const usd = Number(msg.total_cost_usd ?? 0);
          if (msg.subtype === "success") {
            yield { type: "done", summary: String(msg.result ?? ""), usd };
          } else {
            const why = Array.isArray(msg.errors) && msg.errors.length ? msg.errors.join("; ") : msg.subtype;
            yield { type: "error", message: `claude-sdk ended: ${why}` };
            yield { type: "done", summary: `task ended without success (${msg.subtype})`, usd };
          }
        }
      }
    } catch (e) {
      yield { type: "error", message: `claude-sdk runtime failed: ${e instanceof Error ? e.message : String(e)}` };
    }
  },
};
