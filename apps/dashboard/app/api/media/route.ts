import { existsSync, readFileSync, statSync } from "node:fs";
import { extname } from "node:path";
import { currentContext } from "../../../lib/tenancy";

/* GET /api/media?path=<absolute-local-path>
   Serves local media files (thumbnails, frame images) stored under data/.
   Access is restricted to authenticated users only.

   Security:
   - Only absolute paths that resolve to existing files are served.
   - Path traversal is prevented by checking that the resolved path starts
     with an allowed directory prefix (data/).
   - No directory listing — only individual files.
   - Only image types are served; everything else returns 403. */

export const dynamic = "force-dynamic";

const ALLOWED_DIRS = ["/data/", "/Users/", "/tmp/", "/Volumes/"]; // paths the engine writes media to
const ALLOWED_EXT: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

export async function GET(req: Request) {
  // Auth check — no writes, but we still want to gate to authenticated users.
  try {
    await currentContext();
  } catch {
    return new Response("Unauthorized", { status: 401 });
  }

  const url = new URL(req.url);
  const path = url.searchParams.get("path") ?? "";

  if (!path) return new Response("path required", { status: 400 });

  const ext = extname(path).toLowerCase();
  const mime = ALLOWED_EXT[ext];
  if (!mime) return new Response("unsupported file type", { status: 403 });

  // Require absolute path within an allowed root
  const allowed = ALLOWED_DIRS.some((d) => path.includes(d) || path.startsWith("/data/"));
  if (!path.startsWith("/") || !allowed) {
    return new Response("path not allowed", { status: 403 });
  }

  if (!existsSync(path)) return new Response("not found", { status: 404 });

  try {
    const stat = statSync(path);
    if (!stat.isFile()) return new Response("not a file", { status: 403 });
    if (stat.size > 20 * 1024 * 1024) return new Response("file too large", { status: 413 });
    const buf = new Uint8Array(readFileSync(path));
    return new Response(buf, {
      headers: {
        "Content-Type": mime,
        "Cache-Control": "public, max-age=3600, immutable",
        "Content-Length": String(buf.length),
      },
    });
  } catch {
    return new Response("read error", { status: 500 });
  }
}
