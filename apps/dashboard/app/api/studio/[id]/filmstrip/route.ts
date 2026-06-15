import { createReadStream, existsSync, statSync } from "node:fs";
import type { ReadStream } from "node:fs";
import { getItemFor } from "../../../../../lib/data";
import { currentWorkspaceId } from "../../../../../lib/tenancy";
import { runStudioTool } from "../../../../../lib/studio";

export const dynamic = "force-dynamic";

/* GET /api/studio/[id]/filmstrip — the thumbnail FILMSTRIP jpg for the /editor
   scrubber. Workspace-gated (only an item the caller owns), then editor_filmstrip
   generates/reuses the cached strip and we stream it as image/jpeg. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // gate: the item must belong to the caller's workspace.
  const item = getItemFor(id, await currentWorkspaceId());
  if (!item) return new Response("not found", { status: 404 });

  const res = await runStudioTool("editor_filmstrip", { id });
  const path = (res.ok && res.data && (res.data as { path?: string }).path) || null;
  if (!path || !existsSync(path)) return new Response("no filmstrip", { status: 404 });

  const stat = statSync(path);
  const stream = createReadStream(path) as unknown as ReadableStream;
  return new Response(stream, {
    headers: {
      "Content-Type": "image/jpeg",
      "Content-Length": String(stat.size),
      "Cache-Control": "private, max-age=60",
    },
  });
}
