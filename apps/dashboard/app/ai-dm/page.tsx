import { currentContext, ctxCan } from "../../lib/tenancy";
import { listBrands } from "../../lib/brands";
import { threadsFor } from "../../lib/ai-dm";
import { PageHead } from "../PageHead";
import { AiDmConsole, type BrandLite } from "./AiDmConsole";

export const dynamic = "force-dynamic";

/* AI DM — a live conversational console where an AI answers Instagram DMs per
   thread (engine: ai-dm.ts, reusing the responder's brand-voice generation + the
   dm_* send/window/kill-switch gates). Connect a brand account (/connections),
   then draft-and-approve, send, or hand a thread to the AI to auto-reply. */

export default async function AiDmPage() {
  const ctx = await currentContext();
  const brands: BrandLite[] = listBrands(ctx.workspaceId).map((b) => ({ id: b.id, name: b.name }));
  const initialChannel = brands[0]?.id ?? "";
  const initialThreads = initialChannel ? threadsFor(initialChannel) : [];

  return (
    <>
      <PageHead
        section="engage"
        title="AI DM"
        sub="Let an AI handle direct messages in your brand's voice — draft for approval, send, or hand a thread to the AI to auto-reply. The kill-switch, 24h messaging window, and never-auto-reply guardrails always apply."
      />
      <AiDmConsole brands={brands} initialChannel={initialChannel} initialThreads={initialThreads} canSend={ctxCan(ctx, "content.publish")} />
    </>
  );
}
