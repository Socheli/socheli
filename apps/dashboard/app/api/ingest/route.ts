import { mkdirSync, writeFileSync } from "node:fs";
import { join, extname, basename } from "node:path";
import { RENDERS_DIR } from "../../../lib/data";
import { importIngest, startedJob } from "../../../lib/studio";
import { currentContext, ctxCan, forbidden } from "../../../lib/tenancy";
import { audit } from "../../../lib/audit";

export const dynamic = "force-dynamic";

/* INGEST a user video into the Studio (Pillar 5 — the EDITOR STUDIO).
   POST /api/ingest
     · multipart/form-data with a `file` part → staged to a temp file → imported
     · application/json { path } → import an on-disk file directly (no upload)
   Both call lib/studio.importIngest → engine ingest_video (the one tool registry):
   a render-friendly source imports inline and returns the item; one that needs a
   transcode detaches and returns {status:"started", pid, logPath, id} — surfaced
   verbatim so the page polls /api/studio/[id].

   Tenancy: gated on `content.create` (importing a video creates a kind:"ingested"
   ContentItem). `channel` must be omitted or trusted; we default to the brand the
   engine uses and let the engine validate. */

const UPLOAD_DIR = join(RENDERS_DIR, "..", "ingest", "uploads");
const VIDEO_EXT = new Set([".mp4", ".mov", ".m4v", ".webm", ".mkv", ".avi", ".hevc", ".mpg", ".mpeg", ".wmv"]);
const MAX_BYTES = 4 * 1024 * 1024 * 1024; // 4 GiB upload ceiling

/* Sanitize an uploaded filename to a safe stem + an allow-listed extension, so a
   crafted name can never traverse out of UPLOAD_DIR or smuggle a non-video ext. */
function safeUploadName(original: string): string | null {
  const ext = extname(original).toLowerCase();
  if (!VIDEO_EXT.has(ext)) return null;
  const stem = basename(original, ext).replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80) || "upload";
  return `${Date.now()}_${stem}${ext}`;
}

export async function POST(req: Request) {
  const ctx = await currentContext();
  if (!ctxCan(ctx, "content.create")) return forbidden("content.create");

  const contentType = req.headers.get("content-type") ?? "";

  // ── Path B: JSON { path } — import an already-on-disk file (no upload) ──
  if (contentType.includes("application/json")) {
    const body = await req.json().catch(() => null);
    const path = String(body?.path ?? "").trim();
    if (!path) return Response.json({ error: "path required" }, { status: 400 });
    const channel = typeof body?.channel === "string" && body.channel.trim() ? body.channel.trim() : undefined;

    const res = await importIngest(path, channel);
    if (!res.ok) return Response.json({ error: res.message ?? "import failed" }, { status: 500 });
    audit(ctx, "studio.ingest", String(res.data?.id ?? ""), { via: "path" });
    return Response.json({ ...res.data, job: startedJob(res) });
  }

  // ── Path A: multipart upload → temp file → import ──
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return Response.json({ error: "expected multipart/form-data or application/json" }, { status: 400 });
  }
  const file = form.get("file");
  if (!(file instanceof File)) return Response.json({ error: "file part required" }, { status: 400 });
  if (file.size > MAX_BYTES) return Response.json({ error: "file too large" }, { status: 413 });

  const name = safeUploadName(file.name || "upload.mp4");
  if (!name) return Response.json({ error: "unsupported file type" }, { status: 415 });

  // Stage the upload to the engine's ingest area so importVideo (and any detached
  // transcode worker) can read it. The engine owns the final normalized copy.
  mkdirSync(UPLOAD_DIR, { recursive: true });
  const tmpPath = join(UPLOAD_DIR, name);
  try {
    const buf = Buffer.from(await file.arrayBuffer());
    writeFileSync(tmpPath, buf);
  } catch (e) {
    return Response.json({ error: `could not stage upload: ${e instanceof Error ? e.message : String(e)}` }, { status: 500 });
  }

  const channel = typeof form.get("channel") === "string" && (form.get("channel") as string).trim()
    ? (form.get("channel") as string).trim()
    : undefined;

  const res = await importIngest(tmpPath, channel);
  if (!res.ok) return Response.json({ error: res.message ?? "import failed" }, { status: 500 });
  audit(ctx, "studio.ingest", String(res.data?.id ?? ""), { via: "upload", name: file.name });
  return Response.json({ ...res.data, job: startedJob(res) });
}
