#!/usr/bin/env -S node --import tsx
/**
 * socheli-mcp.ts — the comprehensive Socheli MCP server.
 *
 * Where editor-mcp.ts exposes only the ~30 EDITOR tools, this server exposes
 * EVERY capability in the single canonical tool registry (pipeline + editor +
 * publish + grow + analytics + assets + channels + scheduler) over stdio
 * JSON-RPC, with full parity to the CLI / HTTP / SDK surfaces.
 *
 * It is a thin adapter over ../tools/registry.ts:
 *   - tools/list  -> toolsManifest() (name + description + jsonschema, + kind hint)
 *   - tools/call  -> callTool(name, arguments) (async: validates zod + awaits
 *                    promise-backed tools + delegates editor_* to callEditorTool)
 *
 * editor-mcp.ts is left untouched and keeps working; this is the superset.
 */
import { allTools, callTool, toolsManifest } from "./tools/registry.ts";

type JsonRpc = {
  jsonrpc?: "2.0";
  id?: string | number | null;
  method?: string;
  params?: any;
};

let buffer = Buffer.alloc(0);

function send(message: Record<string, unknown>) {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
  process.stdout.write(body);
}

function result(id: JsonRpc["id"], value: unknown) {
  send({ jsonrpc: "2.0", id, result: value });
}

function error(id: JsonRpc["id"], code: number, message: string) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

/** Map the canonical manifest into the MCP tool shape. */
function asMcpTools() {
  return toolsManifest().map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    // Non-standard but useful hint for clients: read | mutate | long.
    _meta: { kind: tool.kind },
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
      error(msg.id, -32602, "tools/call requires a string params.name");
      return;
    }
    try {
      const out = await callTool(name, args);
      result(msg.id, {
        isError: !out.ok,
        content: [
          {
            type: "text",
            text: JSON.stringify(out, null, 2),
          },
        ],
      });
    } catch (e) {
      result(msg.id, {
        isError: true,
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { ok: false, message: e instanceof Error ? e.message : String(e) },
              null,
              2,
            ),
          },
        ],
      });
    }
    return;
  }

  if (msg.id != null) error(msg.id, -32601, `method not found: ${msg.method}`);
}

function pump() {
  while (true) {
    const headerEnd = buffer.indexOf("\r\n\r\n");
    if (headerEnd === -1) return;
    const header = buffer.subarray(0, headerEnd).toString("utf8");
    const m = /Content-Length:\s*(\d+)/i.exec(header);
    if (!m) {
      buffer = buffer.subarray(headerEnd + 4);
      continue;
    }
    const length = Number(m[1]);
    const start = headerEnd + 4;
    const end = start + length;
    if (buffer.length < end) return;
    const body = buffer.subarray(start, end).toString("utf8");
    buffer = buffer.subarray(end);
    let parsed: JsonRpc | null = null;
    try {
      parsed = JSON.parse(body);
    } catch (e) {
      error(null, -32700, e instanceof Error ? e.message : String(e));
      continue;
    }
    // handle() is async; fire-and-forget keeps the pump non-blocking while each
    // request resolves independently (responses carry their own id).
    void handle(parsed!).catch((e) => {
      error(parsed?.id ?? null, -32603, e instanceof Error ? e.message : String(e));
    });
  }
}

process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  pump();
});

// Touch allTools so the comprehensive registry is eagerly evaluated at startup
// (surfaces any registry construction error before the first request).
void allTools.length;
