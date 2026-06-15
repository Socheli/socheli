import { currentUser } from "@clerk/nextjs/server";
import { listItemsFor, isVerified } from "../../lib/data";
import { currentContext, ctxCan } from "../../lib/tenancy";
import { listWorkspaceMembers } from "../../lib/workspace-members";
import { fleet } from "../../lib/fleet";
import { PageHead } from "../PageHead";
import { QueueList, type QueueItem, type InflightJob } from "./QueueList";

export const dynamic = "force-dynamic";

// Statuses that mean the pipeline has finished (success or failure) — no longer "in flight".
const TERMINAL = new Set(["packaged", "rendered", "failed", "qa_failed", "published"]);
const STALL_MS = 4 * 60 * 1000;

export default async function Queue() {
  const ctx = await currentContext();
  const user = await currentUser();
  const members = await listWorkspaceMembers(ctx.orgId, {
    userId: ctx.userId,
    name: user ? [user.firstName, user.lastName].filter(Boolean).join(" ") : null,
    email: user?.emailAddresses?.[0]?.emailAddress ?? null,
    imageUrl: user?.imageUrl ?? null,
  });

  const now = Date.now();
  // The Production Queue is for live/finished renders — not rejected ones. QA-killed
  // (qa_failed) and errored (failed) items are dropped from it (they live in Library
  // history); everything else across the lifecycle stays.
  const REJECTED = new Set(["qa_failed", "failed"]);
  // Scope the in-flight queue to the caller's workspace.
  const items: QueueItem[] = listItemsFor(ctx.workspaceId).filter((it) => !REJECTED.has(it.status)).map((it) => {
    const terminal = TERMINAL.has(it.status) || !!it.videoPath;
    const age = now - new Date(it.updatedAt ?? it.createdAt).getTime();
    return {
      id: it.id,
      channel: it.channel,
      title: it.pkg?.title ?? it.idea?.topic ?? it.seedIdea,
      status: it.status,
      mood: it.mood,
      kind: it.kind,
      scenes: it.storyboard?.scenes.length,
      qa: it.qa?.overall,
      cost: it.ledger.totalUsd,
      hasVideo: isVerified(it), // only true when the render actually exists on disk
      generating: !terminal,
      stalled: !terminal && age > STALL_MS,
      seedIdea: it.seedIdea,
      createdBy: it.createdBy,
      assignee: (it as { assignee?: string }).assignee,
    };
  });

  // In-flight jobs from the fleet — a generation that's dispatched/running on a
  // device has no ContentItem yet, so surface it here (live phase) so the queue
  // never looks empty right after Generate. Also keep just-finished jobs whose
  // item isn't synced yet (incl. QA-rejected ones) so the outcome is visible.
  const itemIds = new Set(items.map((i) => i.id));
  const recent = (ts?: string) => ts && Date.now() - new Date(ts).getTime() < 15 * 60 * 1000;
  const inflight: InflightJob[] = fleet(ctx.workspaceId).jobs
    .filter((j) => j.status === "dispatched" || j.status === "running" || (recent(j.updatedAt) && !(j.itemId && itemIds.has(j.itemId))))
    .map((j) => ({
      id: j.id,
      type: j.type,
      channel: j.channel,
      status: j.status,
      phase: j.progress?.[j.progress.length - 1]?.line ?? "queued",
      updatedAt: j.updatedAt,
      itemId: j.itemId,
      message: j.message,
    }));

  return (
    <>
      <PageHead
        section="create"
        title="Production Queue"
        sub={`${items.length} content items across the lifecycle.`}
      />
      <QueueList
        items={items}
        inflight={inflight}
        members={members}
        meId={ctx.userId}
        canCancel={ctxCan(ctx, "queue.cancel")}
        canReassign={ctxCan(ctx, "content.edit.any")}
      />
    </>
  );
}
