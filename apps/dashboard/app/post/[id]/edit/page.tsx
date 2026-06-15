import { notFound, redirect } from "next/navigation";
import { ownsRecord } from "@os/schemas";
import { getItemFor } from "../../../../lib/data";
import { currentContext, ctxCan } from "../../../../lib/tenancy";
import Editor from "./Editor";

export const dynamic = "force-dynamic";

/* Server gate for the pro editor: scope the post to the caller's workspace (404
   when it isn't theirs) and ensure they may edit it (any-editor, or own-editor
   when they authored it) before handing off to the client Editor. The editor's
   own writes (PATCH / rerender) are independently enforced at the API layer. */
export default async function EditPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await currentContext();
  const it = getItemFor(id, ctx.workspaceId);
  if (!it) return notFound();
  const canEdit = ctxCan(ctx, "content.edit.any") || ctxCan(ctx, "content.edit.own", { isOwnerOfRecord: ownsRecord(it, ctx) });
  if (!canEdit) redirect(`/post/${id}`);
  return <Editor id={id} />;
}
