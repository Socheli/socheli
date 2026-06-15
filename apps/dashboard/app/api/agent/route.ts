import { hasOpenRouterKey } from "../../../lib/agent/openrouter";
import { getCopilotModel } from "../../../lib/agent/model-config";
import { streamAgentViaSubscription } from "../../../lib/agent/subscription";
import { currentContext } from "../../../lib/tenancy";
import {
  streamAgent,
  type AgentMessageInput,
  type AgentContextInput,
  type StreamAgentEvent,
} from "../../../lib/agent/graph";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/* Server-side Socheli copilot.
   POST { messages: {role,content}[], context?, model? } -> SSE stream of agent
   events (text/event-stream, "data: <json>\n\n" frames).
   With no OPENROUTER_API_KEY we still respond with a graceful one-line stream so
   the whole path is exercisable. */

type AgentRequest = {
  messages?: AgentMessageInput[];
  context?: AgentContextInput;
  model?: string;
};

const SSE_HEADERS = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
};

function sseLine(event: StreamAgentEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

function cannedStream(text: string): Response {
  const enc = new TextEncoder();
  const s = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(enc.encode(sseLine({ type: "token", text })));
      c.enqueue(enc.encode(sseLine({ type: "done" })));
      c.close();
    },
  });
  return new Response(s, { headers: SSE_HEADERS });
}

const DEMO = (process.env.AUTH_MODE ?? "").toLowerCase() === "demo";
// Cheap, fast model for the public demo so live Soli costs are bounded.
const DEMO_MODEL = process.env.SOCHELI_DEMO_MODEL || "google/gemini-2.5-flash";
// Per-IP rate limit for the demo (in-memory; one demo instance). Bounds abuse/spend.
const DEMO_HITS = new Map<string, number[]>();
function demoRateOk(ip: string): boolean {
  const now = Date.now(), win = 10 * 60 * 1000, max = 12;
  const arr = (DEMO_HITS.get(ip) ?? []).filter((t) => now - t < win);
  if (arr.length >= max) { DEMO_HITS.set(ip, arr); return false; }
  arr.push(now); DEMO_HITS.set(ip, arr);
  if (DEMO_HITS.size > 5000) DEMO_HITS.clear(); // crude memory cap
  return true;
}

export async function POST(req: Request): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as AgentRequest;
  const messages = Array.isArray(body.messages) ? body.messages : [];

  // Public demo: Soli runs for real but READ-ONLY — the viewer tenant + the
  // engine tool runner restrict it to read tools (no generate/publish/spend), on
  // a cheap model, behind a per-IP rate limit so public spend stays bounded.
  if (DEMO) {
    const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || req.headers.get("x-real-ip") || "anon";
    if (!demoRateOk(ip)) {
      return cannedStream("You've reached the demo's message limit for now. Sign up to keep chatting with Soli and to generate, publish, and grow for real.");
    }
  }

  // Resolve the caller's tenant from the Clerk session — NEVER from the request
  // body. This pins every tool call to the caller's workspace and gates mutations
  // by their role (a viewer gets read tools only). Any client-sent role/workspace
  // in `context` is ignored. In demo this is a read-only viewer.
  const tenant = await currentContext();

  // The effective model is resolved SERVER-side (the persisted picker value), not
  // from the request body. Demo forces a cheap model; "claude-code" runs the turn
  // through the local claude-code harness on the user's subscription.
  const effectiveModel = DEMO ? DEMO_MODEL : getCopilotModel();
  const viaSubscription = !DEMO && effectiveModel === "claude-code";

  // No key AND not on the subscription path: emit a helpful one-liner.
  if (!viaSubscription && !hasOpenRouterKey()) {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(sseLine({ type: "token", text: "Set OPENROUTER_API_KEY to enable the copilot." })),
        );
        controller.enqueue(encoder.encode(sseLine({ type: "done" })));
        controller.close();
      },
    });
    return new Response(stream, { headers: SSE_HEADERS });
  }

  const encoder = new TextEncoder();
  const signal = req.signal;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const safeEnqueue = (chunk: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          closed = true;
        }
      };

      try {
        const source = viaSubscription
          ? streamAgentViaSubscription({ messages, context: body.context, signal })
          : streamAgent({ messages, context: body.context, model: body.model, signal, tenant });
        for await (const event of source) {
          if (signal.aborted) break;
          safeEnqueue(sseLine(event));
        }
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        safeEnqueue(sseLine({ type: "error", message }));
      } finally {
        if (!closed) {
          try {
            controller.close();
          } catch {
            /* already closed (client aborted) */
          }
        }
      }
    },
    cancel() {
      /* Client aborted; streamAgent observes req.signal and stops. */
    },
  });

  return new Response(stream, { headers: SSE_HEADERS });
}
