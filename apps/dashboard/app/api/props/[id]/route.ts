import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT, getItemFor } from "../../../../lib/data";
import { currentWorkspaceId } from "../../../../lib/tenancy";

export const dynamic = "force-dynamic";

/* The exact PostProps used for the last render (written by renderPost); feeds the
   dashboard's live Remotion Player so the preview matches the final video. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // Props belong to a post — serve them only when that post is in the workspace.
  const item = getItemFor(id, await currentWorkspaceId());
  if (!item) return new Response("not found", { status: 404 });

  // Prefer the exact props from the last render (voice/music/word-synced captions).
  const p = join(REPO_ROOT, "data", "props", `${id}.json`);
  if (existsSync(p)) return new Response(readFileSync(p, "utf8"), { headers: { "Content-Type": "application/json" } });

  // No render yet → synthesize live-preview props from the item's storyboard so the
  // editor's Player works BEFORE the first render. A render only adds audio + word-
  // level captions; the visual composition previews fine without them.
  const it = item as { storyboard?: unknown; brandAccent?: string; pkg?: { brandAccent?: string } };
  if (!it.storyboard) return new Response("no storyboard yet", { status: 404 });
  return Response.json({ storyboard: it.storyboard, brandAccent: it.brandAccent ?? it.pkg?.brandAccent, preview: true });
}
