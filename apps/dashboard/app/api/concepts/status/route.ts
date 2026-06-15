import { ownsRecord } from "@os/schemas";
import { getConcept, setStatus } from "../../../../lib/concepts";
import { currentContext, assertCan, forbidden } from "../../../../lib/tenancy";
import { audit } from "../../../../lib/audit";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const ctx = await currentContext();
  const body = await req.json().catch(() => ({}));
  const id = String(body.id ?? "");
  const status = String(body.status ?? "");
  if (!id || !["new", "approved", "rejected", "generated"].includes(status)) return Response.json({ error: "bad request" }, { status: 400 });
  // Scope: a concept outside the workspace is a 404, not a 403.
  const concept = getConcept(id, ctx.workspaceId);
  if (!concept) return Response.json({ error: "not found" }, { status: 404 });
  // Editing status needs edit rights; non-admins may only touch concepts they proposed.
  try {
    assertCan(ctx, "content.edit.own", { isOwnerOfRecord: ownsRecord(concept, ctx) });
  } catch {
    return forbidden("content.edit.own");
  }
  setStatus(id, status as "new" | "approved" | "rejected" | "generated", ctx.workspaceId);
  audit(ctx, "concept.status", id, { status });
  return Response.json({ ok: true });
}
