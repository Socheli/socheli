import { createReadStream, statSync } from "node:fs";
import { getItemFor, videoFile } from "../../../../lib/data";
import { currentWorkspaceId } from "../../../../lib/tenancy";
import type { ReadStream } from "node:fs";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // Stream only when the item belongs to the caller's workspace.
  const vf = videoFile(getItemFor(id, await currentWorkspaceId()));
  if (!vf) return new Response("not found", { status: 404 });

  const stat = statSync(vf);
  const range = req.headers.get("range");
  const toWeb = (s: ReadStream) => s as unknown as ReadableStream;

  if (range) {
    const m = /bytes=(\d+)-(\d*)/.exec(range);
    const start = m ? parseInt(m[1], 10) : 0;
    const end = m && m[2] ? parseInt(m[2], 10) : stat.size - 1;
    const stream = createReadStream(vf, { start, end });
    return new Response(toWeb(stream), {
      status: 206,
      headers: {
        "Content-Range": `bytes ${start}-${end}/${stat.size}`,
        "Accept-Ranges": "bytes",
        "Content-Length": String(end - start + 1),
        "Content-Type": "video/mp4",
      },
    });
  }
  return new Response(toWeb(createReadStream(vf)), {
    headers: { "Content-Length": String(stat.size), "Content-Type": "video/mp4", "Accept-Ranges": "bytes" },
  });
}
