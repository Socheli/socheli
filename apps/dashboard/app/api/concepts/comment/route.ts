import { roleAtLeast } from "@os/schemas";
import { addComment, getConcept } from "../../../../lib/concepts";
import { currentContext } from "../../../../lib/tenancy";
import { audit } from "../../../../lib/audit";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const ctx = await currentContext();
  const body = await req.json().catch(() => ({}));
  const id = String(body.id ?? "");
  const text = String(body.text ?? "").trim();
  if (!id || !text) return Response.json({ error: "id and text required" }, { status: 400 });
  // Scope: a concept outside the workspace is a 404, not a 403.
  if (!getConcept(id, ctx.workspaceId)) return Response.json({ error: "not found" }, { status: 404 });
  // Comments are open to any member of the workspace (viewers are read-only).
  if (!roleAtLeast(ctx.role, "member")) return Response.json({ error: "forbidden" }, { status: 403 });
  addComment(id, text, ctx.workspaceId);
  audit(ctx, "concept.comment", id);
  return Response.json({ ok: true });
}
