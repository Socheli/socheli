#!/usr/bin/env -S node --import tsx
import "../env.ts"; // .env → process.env (the server runs registry tools)
import { createInterface } from "node:readline";

import { callTool, toolsManifest } from "../tools/registry.ts";

/* mcp-stdio.ts — newline-delimited MCP stdio server over the canonical
   tool registry (harness support, docs/AGENT-HARNESS.md §3).

   WHY THIS EXISTS next to socheli-mcp.ts: that server frames messages with
   LSP-style `Content-Length` headers, but the CURRENT MCP stdio transport —
   what Claude Code's `--mcp-config` client actually speaks — is one JSON-RPC
   envelope per line. Verified empirically: claude-code sessions report the
   socheli server "still connecting" forever against socheli-mcp.ts, while
   this line-delimited twin connects instantly. Same registry, same tool
   names (mcp__socheli__*), same callTool dispatch — only the wire framing
   differs. socheli-mcp.ts is left untouched for existing framed clients.

   Protocol surface: initialize, notifications/initialized, ping, tools/list,
   tools/call — identical semantics to socheli-mcp.ts. */

type JsonRpc = {
  jsonrpc?: "2.0";
  id?: string | number | null;
  method?: string;
  params?: any;
};

function send(message: Record<string, unknown>) {
  process.stdout.write(JSON.stringify(message) + "\n");
}

function result(id: JsonRpc["id"], value: unknown) {
  send({ jsonrpc: "2.0", id, result: value });
}

function rpcError(id: JsonRpc["id"], code: number, message: string) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

/* Optional allowlist: SOCHELI_MCP_TOOLS="a,b,c" restricts which tools this
   server ADVERTISES (and accepts calls for). The claude-code runtime sets it
   to the role's allowlist — without it, ~110 advertised tools push Claude
   Code into ToolSearch deferral and small models flail instead of calling
   the tool directly (observed: agent never emits the mcp__socheli__ call). */
const TOOL_FILTER = (process.env.SOCHELI_MCP_TOOLS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const toolAllowed = (name: string) => TOOL_FILTER.length === 0 || TOOL_FILTER.includes(name);

/** Map the canonical manifest into the MCP tool shape (mirrors socheli-mcp.ts). */
function asMcpTools() {
  return toolsManifest()
    .filter((tool) => toolAllowed(tool.name))
    .map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      _meta: { kind: tool.kind }, // non-standard hint: read | mutate | long
    }));
}

async function handle(msg: JsonRpc) {
  if (!msg.method) return;

  if (msg.method === "initialize") {
    result(msg.id, {
      protocolVersion: msg.params?.protocolVersion ?? "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "socheli", version: "0.1.0" },
    });
    return;
  }

  if (msg.method === "notifications/initialized") return;

  if (msg.method === "ping") {
    result(msg.id, {});
    return;
  }

  if (msg.method === "tools/list") {
    result(msg.id, { tools: asMcpTools() });
    return;
  }

  if (msg.method === "tools/call") {
    const name = msg.params?.name;
    const args = msg.params?.arguments ?? {};
    if (typeof name !== "string") {
      rpcError(msg.id, -32602, "tools/call requires a string params.name");
      return;
    }
    if (!toolAllowed(name)) {
      result(msg.id, {
        isError: true,
        content: [{ type: "text", text: JSON.stringify({ ok: false, message: `tool not in this session's allowlist: ${name}` }) }],
      });
      return;
    }
    try {
      const out = await callTool(name, args);
      result(msg.id, {
        isError: !out.ok,
        content: [{ type: "text", text: JSON.stringify(out, null, 2) }],
      });
    } catch (e) {
      result(msg.id, {
        isError: true,
        content: [
          {
            type: "text",
            text: JSON.stringify({ ok: false, message: e instanceof Error ? e.message : String(e) }, null, 2),
          },
        ],
      });
    }
    return;
  }

  if (msg.id != null) rpcError(msg.id, -32601, `method not found: ${msg.method}`);
}

// One JSON-RPC envelope per stdin line; responses go out the same way.
// handle() is async; fire-and-forget keeps the loop non-blocking while each
// request resolves independently (responses carry their own id).
const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let parsed: JsonRpc;
  try {
    parsed = JSON.parse(trimmed);
  } catch (e) {
    rpcError(null, -32700, e instanceof Error ? e.message : String(e));
    return;
  }
  void handle(parsed).catch((e) => {
    rpcError(parsed?.id ?? null, -32603, e instanceof Error ? e.message : String(e));
  });
});
