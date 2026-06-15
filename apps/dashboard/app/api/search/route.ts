import { currentContext } from "../../../lib/tenancy";
import { searchStages, type SearchStage } from "../../../lib/search";

/* Global hyper-search API — backs the header command palette (HyperSearch).

   GET ?q=<query>            → text/event-stream: one `stage` event per corpus
                               (pages → content → chats → brands → missions),
                               each spaced by a small delay so the palette can
                               choreograph the search as a visible step-by-step
                               harness, then a final `done` event.
   GET ?q=<query>&mode=json  → { stages: [...] } in one shot (reduced-motion /
                               non-streaming clients).

   TENANCY: the workspace id comes from the session context (currentContext) and
   is NEVER trusted from the request — every scanner only ever touches the
   caller's own workspace records. Results carry display-safe fields only. */

export const dynamic = "force-dynamic";

const STAGE_DELAY_MS = 130; // deliberate per-stage reveal; the scan itself is instant

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function GET(req: Request) {
  const ctx = await currentContext();
  const url = new URL(req.url);
  const q = (url.searchParams.get("q") || "").slice(0, 200);
  const mode = url.searchParams.get("mode");

  const stages = q.trim() ? searchStages(q, ctx.workspaceId) : [];

  // One-shot JSON for reduced-motion / simple clients.
  if (mode === "json") {
    return Response.json({ q, stages });
  }

  // SSE: emit each stage in sequence with a small delay so the harness "ignites"
  // one corpus at a time in the UI.
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };
      send("start", { q, total: stages.length });
      for (const stage of stages) {
        await sleep(STAGE_DELAY_MS);
        send("stage", stage satisfies SearchStage);
      }
      send("done", { q });
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    },
  });
}
