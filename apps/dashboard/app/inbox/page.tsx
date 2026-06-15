import { currentContext, ctxCan } from "../../lib/tenancy";
import { listBrands } from "../../lib/brands";
import { commentsFor, dmsFor, type InboxComment, type InboxDm } from "../../lib/inbox";
import { PageHead } from "../PageHead";
import { InboxBoard, type BrandLite } from "./InboxBoard";

export const dynamic = "force-dynamic";

/* Inbox — community management (engine: comments.ts / dms.ts). Server shell:
   aggregates the comment + DM triage and pending-approval queues across every
   brand in the caller's workspace and hands them to the client board, which
   keeps them live via router.refresh polling. Sending a reply is gated to
   content.publish — the human approve→send step, like the publish gate. */

export default async function InboxPage() {
  const ctx = await currentContext();
  const brands = listBrands(ctx.workspaceId);
  const brandLite: BrandLite[] = brands.map((b) => ({ id: b.id, name: b.name, accent: b.accent }));

  const commentTriage: InboxComment[] = [];
  const commentPending: InboxComment[] = [];
  const dmTriage: InboxDm[] = [];
  const dmPending: InboxDm[] = [];
  for (const b of brands) {
    const c = commentsFor(b.id);
    commentTriage.push(...c.triage);
    commentPending.push(...c.pending);
    const d = dmsFor(b.id);
    dmTriage.push(...d.triage);
    dmPending.push(...d.pending);
  }

  return (
    <>
      <PageHead
        section="engage"
        title="Inbox"
        sub="Comments & DMs across your brands — triage, draft replies in brand voice, and approve & send. Drafting is safe; sending is gated to you."
      />
      <InboxBoard
        brands={brandLite}
        commentTriage={commentTriage}
        commentPending={commentPending}
        dmTriage={dmTriage}
        dmPending={dmPending}
        canSend={ctxCan(ctx, "content.publish")}
      />
    </>
  );
}
