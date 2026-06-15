#!/usr/bin/env -S node --import tsx
import { createSocheli } from "@socheli/sdk";

/* @socheli/mcp — a Model Context Protocol server that exposes the Socheli content
   engine as tools, so Claude (or any MCP client) can list/inspect content, dispatch
   renders to the fleet, check device status, and publish. Dependency-free stdio
   JSON-RPC (matches the repo's editor-mcp pattern).

   Configure in an MCP client:
     { "command": "node", "args": ["--import","tsx","packages/mcp/src/index.ts"],
       "env": { "SOCHELI_API_URL": "https://api.socheli.com", "SOCHELI_API_KEY": "sk_..." } } */

const socheli = createSocheli({ baseUrl: process.env.SOCHELI_API_URL, apiKey: process.env.SOCHELI_API_KEY });

type JsonRpc = { jsonrpc?: "2.0"; id?: string | number | null; method?: string; params?: any };

let buffer = Buffer.alloc(0);
function send(message: Record<string, unknown>) {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
  process.stdout.write(body);
}
const result = (id: JsonRpc["id"], value: unknown) => send({ jsonrpc: "2.0", id, result: value });
const error = (id: JsonRpc["id"], code: number, message: string) => send({ jsonrpc: "2.0", id, error: { code, message } });
const textContent = (v: unknown) => ({ content: [{ type: "text", text: typeof v === "string" ? v : JSON.stringify(v, null, 2) }] });

const TOOLS = [
  {
    name: "socheli_me",
    description: "Show which workspace the current API key acts in and its role. Every other tool operates within this workspace automatically.",
    inputSchema: { type: "object", properties: {} },
    run: () => socheli.me(),
  },
  {
    name: "socheli_list_items",
    description: "List recent content items (id, status, QA score, title). Optionally filter by channel or limit.",
    inputSchema: { type: "object", properties: { limit: { type: "number", description: "max items (default 20)" }, channel: { type: "string" } } },
    run: (a: any) => socheli.items.list({ limit: a.limit ?? 20, channel: a.channel }),
  },
  {
    name: "socheli_get_item",
    description: "Get the full detail of one content item by id (idea, script, storyboard, package, video URL, publish state).",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    run: (a: any) => socheli.items.get(a.id),
  },
  {
    name: "socheli_generate",
    description: "Dispatch a new render job to the device fleet from an idea/seed. type 'auto' also publishes; 'new' builds only.",
    inputSchema: {
      type: "object",
      properties: {
        seed: { type: "string", description: "the idea/topic to make a video about" },
        channel: { type: "string", description: "channel id (default labrinox)" },
        type: { type: "string", enum: ["new", "auto"] },
        mood: { type: "string" },
        voice: { type: "boolean" },
      },
      required: ["seed"],
    },
    run: (a: any) => socheli.generate({ seed: a.seed, channel: a.channel, type: a.type, mood: a.mood, voice: a.voice }),
  },
  {
    name: "socheli_jobs",
    description: "List recent fleet jobs and their status (dispatched/running/done/error) and which device ran them.",
    inputSchema: { type: "object", properties: {} },
    run: () => socheli.jobs(),
  },
  {
    name: "socheli_fleet_status",
    description: "Show connected render devices and how many are online/idle/busy.",
    inputSchema: { type: "object", properties: {} },
    run: () => socheli.fleet(),
  },
  {
    name: "socheli_publish",
    description: "Publish a finished item to every configured platform (YouTube/IG/TikTok + bundle). Set public to go public.",
    inputSchema: { type: "object", properties: { id: { type: "string" }, public: { type: "boolean" } }, required: ["id"] },
    run: (a: any) => socheli.items.publish(a.id, { public: a.public }),
  },

  // ── Content calendar / plan (the plan_* registry CRUD; see docs/calendar.md) ──
  {
    name: "socheli_plan_list",
    description: "List planned content-calendar posts (newest plan-run first). Optionally filter by channel/status; archived hidden unless includeArchived.",
    inputSchema: { type: "object", properties: { channel: { type: "string" }, status: { type: "string" }, includeArchived: { type: "boolean" } } },
    run: (a: any) => socheli.plan.list({ channel: a.channel, status: a.status, includeArchived: a.includeArchived }),
  },
  {
    name: "socheli_plan_day",
    description: "Get every planned post for one date (YYYY-MM-DD), sorted by time — the calendar day view.",
    inputSchema: { type: "object", properties: { date: { type: "string", description: "YYYY-MM-DD" }, includeArchived: { type: "boolean" } }, required: ["date"] },
    run: (a: any) => socheli.plan.day(a.date, a.includeArchived),
  },
  {
    name: "socheli_plan_update",
    description: "Edit fields on a planned post (topic/angle/hook/format/mood/rationale/algoLever/platform/status/date/time). Only the provided fields change.",
    inputSchema: { type: "object", properties: { id: { type: "string" }, patch: { type: "object" } }, required: ["id", "patch"] },
    run: (a: any) => socheli.plan.update(a.id, a.patch ?? {}),
  },
  {
    name: "socheli_plan_move",
    description: "Move (reschedule) a planned post to a new date (YYYY-MM-DD) and optional time (HH:MM).",
    inputSchema: { type: "object", properties: { id: { type: "string" }, date: { type: "string" }, time: { type: "string" } }, required: ["id", "date"] },
    run: (a: any) => socheli.plan.move(a.id, a.date, a.time),
  },
  {
    name: "socheli_plan_archive",
    description: "Archive a planned post (soft-hide from the active plan, reversible). Use socheli_plan_update to set status back.",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    run: (a: any) => socheli.plan.archive(a.id),
  },
  {
    name: "socheli_plan_delete",
    description: "Permanently delete a planned post by id. Prefer socheli_plan_archive for a reversible hide.",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    run: (a: any) => socheli.plan.remove(a.id),
  },
  {
    name: "socheli_plan_run",
    description: "Run the algorithm-hacking planner for a channel: research + per-platform playbooks → a dated content plan dripped across the next N days. Starts a background job.",
    inputSchema: { type: "object", properties: { channel: { type: "string" }, days: { type: "number" }, platforms: { type: "array", items: { type: "string" } }, time: { type: "string" } }, required: ["channel"] },
    run: (a: any) => socheli.plan.run({ channel: a.channel, days: a.days, platforms: a.platforms, time: a.time }),
  },

  // ── Community inbox: Instagram comments + DMs (drafting is local; sending is
  //    the human-gated action, mirroring the publish gate) ──────────────────────
  {
    name: "socheli_inbox",
    description: "Show a channel's community inbox: comments and DMs awaiting a reply, plus replies already drafted and pending your approval. Read-only triage view.",
    inputSchema: { type: "object", properties: { channel: { type: "string" } }, required: ["channel"] },
    run: async (a: any) => ({
      comments: (await socheli.tool("comments_list", { channel: a.channel, unansweredOnly: true })).data,
      dms: (await socheli.tool("dm_list", { channel: a.channel })).data,
      pendingComments: (await socheli.tool("comments_pending", { channel: a.channel })).data,
      pendingDms: (await socheli.tool("dm_pending", { channel: a.channel })).data,
    }),
  },
  {
    name: "socheli_inbox_pull",
    description: "Refresh a channel's inbox from Instagram (fetch latest comments + DMs via the Graph API). Needs a token with instagram_manage_comments / instagram_manage_messages.",
    inputSchema: { type: "object", properties: { channel: { type: "string" } }, required: ["channel"] },
    run: async (a: any) => ({ comments: await socheli.tool("comments_pull", { channel: a.channel }), dms: await socheli.tool("dm_pull", { channel: a.channel }) }),
  },
  {
    name: "socheli_comment_draft",
    description: "Draft a brand-voice reply to a comment (saved as PENDING for human approval, NOT sent).",
    inputSchema: { type: "object", properties: { channel: { type: "string" }, commentId: { type: "string" }, reply: { type: "string" } }, required: ["channel", "commentId", "reply"] },
    run: (a: any) => socheli.tool("comment_draft", { channel: a.channel, commentId: a.commentId, reply: a.reply }),
  },
  {
    name: "socheli_comment_send",
    description: "GATED, LIVE: send an approved reply to a comment (sends the pending draft, or pass text to override). A human action.",
    inputSchema: { type: "object", properties: { channel: { type: "string" }, commentId: { type: "string" }, text: { type: "string" } }, required: ["channel", "commentId"] },
    run: (a: any) => socheli.tool("comment_send", { channel: a.channel, commentId: a.commentId, ...(a.text ? { text: a.text } : {}) }),
  },
  {
    name: "socheli_dm_draft",
    description: "Draft a brand-voice reply to a DM thread (saved as PENDING for human approval, NOT sent). Respect the 24h window.",
    inputSchema: { type: "object", properties: { channel: { type: "string" }, conversationId: { type: "string" }, reply: { type: "string" } }, required: ["channel", "conversationId", "reply"] },
    run: (a: any) => socheli.tool("dm_draft", { channel: a.channel, conversationId: a.conversationId, reply: a.reply }),
  },
  {
    name: "socheli_dm_send",
    description: "GATED, LIVE: send an approved DM reply (sends the pending draft, or pass text to override). Enforces the 24h messaging window. A human action.",
    inputSchema: { type: "object", properties: { channel: { type: "string" }, conversationId: { type: "string" }, text: { type: "string" } }, required: ["channel", "conversationId"] },
    run: (a: any) => socheli.tool("dm_send", { channel: a.channel, conversationId: a.conversationId, ...(a.text ? { text: a.text } : {}) }),
  },

  // ── Generic registry passthrough — reach any tool not wrapped above ──────────
  {
    name: "socheli_list_tools",
    description: "List every tool in the canonical Socheli registry (editor + pipeline + plan/calendar) with name, kind and description — discover capabilities to call via socheli_call_tool.",
    inputSchema: { type: "object", properties: {} },
    run: () => socheli.tools(),
  },
  {
    name: "socheli_call_tool",
    description: "Call any Socheli registry tool by name with a JSON input object (e.g. plan_create, concept_select, runs_list). Use socheli_list_tools to discover names + schemas.",
    inputSchema: { type: "object", properties: { name: { type: "string" }, input: { type: "object" } }, required: ["name"] },
    run: (a: any) => socheli.tool(a.name, a.input ?? {}),
  },
] as const;

async function handle(msg: JsonRpc) {
  if (!msg.method) return;
  if (msg.method === "initialize") {
    return result(msg.id, {
      protocolVersion: msg.params?.protocolVersion ?? "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "socheli", version: "0.1.0" },
    });
  }
  if (msg.method === "notifications/initialized") return;
  if (msg.method === "tools/list") {
    return result(msg.id, { tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) });
  }
  if (msg.method === "tools/call") {
    const tool = TOOLS.find((t) => t.name === msg.params?.name);
    if (!tool) return error(msg.id, -32601, `unknown tool: ${msg.params?.name}`);
    try {
      const value = await tool.run(msg.params?.arguments ?? {});
      return result(msg.id, textContent(value));
    } catch (e: any) {
      return result(msg.id, { ...textContent(`error: ${e?.message ?? e}`), isError: true });
    }
  }
  if (typeof msg.id !== "undefined") error(msg.id, -32601, `method not found: ${msg.method}`);
}

process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const header = buffer.indexOf("\r\n\r\n");
    if (header === -1) break;
    const m = /Content-Length:\s*(\d+)/i.exec(buffer.slice(0, header).toString());
    if (!m) { buffer = buffer.slice(header + 4); continue; }
    const len = Number(m[1]);
    const start = header + 4;
    if (buffer.length < start + len) break;
    const body = buffer.slice(start, start + len).toString();
    buffer = buffer.slice(start + len);
    try {
      void handle(JSON.parse(body));
    } catch { /* ignore malformed frame */ }
  }
});
process.stdin.resume();
