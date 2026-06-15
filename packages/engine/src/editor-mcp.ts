#!/usr/bin/env -S node --import tsx
import { callEditorTool, toolManifest } from "./editor-tools.ts";

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

function asMcpTools() {
  return toolManifest().map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  }));
}

function handle(msg: JsonRpc) {
  if (!msg.method) return;

  if (msg.method === "initialize") {
    result(msg.id, {
      protocolVersion: msg.params?.protocolVersion ?? "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "socheli-editor", version: "0.1.0" },
    });
    return;
  }

  if (msg.method === "notifications/initialized") return;

  if (msg.method === "tools/list") {
    result(msg.id, { tools: asMcpTools() });
    return;
  }

  if (msg.method === "tools/call") {
    const name = msg.params?.name;
    const args = msg.params?.arguments ?? {};
    const out = callEditorTool(name, args);
    result(msg.id, {
      isError: !out.ok,
      content: [
        {
          type: "text",
          text: JSON.stringify(out, null, 2),
        },
      ],
    });
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
    try {
      handle(JSON.parse(body));
    } catch (e) {
      error(null, -32700, e instanceof Error ? e.message : String(e));
    }
  }
}

process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  pump();
});
