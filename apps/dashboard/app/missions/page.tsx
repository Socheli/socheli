import { currentContext, ctxCan } from "../../lib/tenancy";
import { listBrands } from "../../lib/brands";
import { listMissionsFor, spentTodayUsd } from "../../lib/missions";
import { pendingMutationsFor, gatedPublishesFor } from "../../lib/approvals";
import { PageHead } from "../PageHead";
import { MissionsBoard, type MissionView, type BrandLite } from "./MissionsBoard";

export const dynamic = "force-dynamic";

/* Missions — the autonomous social-media-manager loop (Agent Harness v2 §4/§5).
   Server shell: reads the caller's workspace missions + the approvals inbox
   (pending DNA mutations across all brands, render-verified items waiting at
   the publish gate) and hands everything to the client board, which keeps it
   live via router.refresh polling. */

export default async function MissionsPage() {
  const ctx = await currentContext();

  const brands: BrandLite[] = listBrands(ctx.workspaceId).map((b) => ({
    id: b.id,
    name: b.name,
    accent: b.accent,
    logo: b.logo,
  }));

  // Normalize the zod-inferred record into the explicit client view shape
  // (the dashboard compiles strict:false, which blurs zod optionality).
  const missions: MissionView[] = listMissionsFor(ctx.workspaceId).map((m) => ({
    id: m.id,
    channel: m.channel,
    goal: m.goal,
    status: m.status,
    cadence: m.cadence ?? {},
    approvalPolicy: {
      publish: m.approvalPolicy?.publish ?? "gate",
      dnaMutations: m.approvalPolicy?.dnaMutations ?? "gate",
    },
    budget: { usdPerDay: m.budget?.usdPerDay, postsPerDay: m.budget?.postsPerDay },
    queue: (m.queue ?? []).map((t) => ({
      id: t.id,
      role: t.role,
      goal: t.goal,
      status: t.status,
      dueAt: t.dueAt,
      startedAt: t.startedAt,
      finishedAt: t.finishedAt,
      resultSummary: t.resultSummary,
      usd: t.usd ?? 0,
    })),
    log: (m.log ?? []).slice(0, 6).map((l) => ({ at: l.at, event: l.event })),
    spentToday: spentTodayUsd(m),
    updatedAt: m.updatedAt,
    createdAt: m.createdAt,
  }));

  return (
    <>
      <PageHead
        section="publish"
        title="Missions"
        sub="Standing goals the system advances on its own — research, plan, generate, analyze, evolve — with budgets, cadences and a human approval gate."
      />
      <MissionsBoard
        missions={missions}
        brands={brands}
        dnaPending={pendingMutationsFor(ctx.workspaceId)}
        gatedPublishes={gatedPublishesFor(ctx.workspaceId)}
        canManage={ctxCan(ctx, "schedule.manage")}
        canApproveDna={ctxCan(ctx, "brand.manage")}
        canPublish={ctxCan(ctx, "content.publish")}
      />
    </>
  );
}
