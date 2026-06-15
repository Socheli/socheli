"use client";

import { useCallback, useState } from "react";
import { EditChat } from "../studio/EditChat";
import type { EditPlan, StartedJob } from "../studio/types";

/* EditChatPanel — the chat-edit dock for the frame editor (Editor Frame-Control —
   Phase C). Reuses the /studio EditChat component WHOLESALE — same one-tap
   recipes, same guided↔autonomous toggle, same PROPOSED EditPlan approval card —
   and drives the SAME tenant-gated route (/api/studio/[id]/edit) the studio uses,
   so the chat-edit path is byte-identical between the two surfaces.

   This wrapper owns only the route plumbing (mirrors Studio.tsx's onSubmit/onApprove):
     · guided    → POST {request, mode} → the EditPlan (approval card)
     · approve   → POST {action:"apply", planId, render} → apply (+ render job)
     · autonomous→ POST {request, mode, render:true} → oneshot apply (+ render job)
   When a render detaches it calls onRendering() so the parent polls + reloads the
   preview; an inline apply calls onApplied() so the parent refreshes the timeline. */

export function EditChatPanel({
  runId,
  canEdit,
  onRendering,
  onApplied,
}: {
  runId: string;
  canEdit: boolean;
  onRendering: () => void;
  onApplied: () => void;
}) {
  const [plan, setPlan] = useState<EditPlan | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  /* If a render detached, hand off to the parent's poller; else it applied
     inline — refresh the timeline/preview now. */
  const handleJob = useCallback((job: StartedJob) => {
    if (job && job.status === "started") onRendering();
    else onApplied();
  }, [onRendering, onApplied]);

  const onSubmit = useCallback(async (request: string, mode: "guided" | "autonomous") => {
    setBusy(true);
    setErr(null);
    setPlan(null);
    try {
      const res = await fetch(`/api/studio/${runId}/edit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ request, mode, render: mode === "autonomous" }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
      if (mode === "guided") setPlan(j as EditPlan);
      else handleJob(j.job as StartedJob);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "edit failed");
    } finally {
      setBusy(false);
    }
  }, [runId, handleJob]);

  const onApprove = useCallback(async (p: EditPlan, render: boolean) => {
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch(`/api/studio/${runId}/edit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "apply", planId: p.id, render }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
      setPlan(null);
      handleJob(j.job as StartedJob);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "apply failed");
    } finally {
      setBusy(false);
    }
  }, [runId, handleJob]);

  const onReject = useCallback(() => setPlan(null), []);

  return (
    <div className="ed2-chat">
      {err && <div className="st-err">{err}</div>}
      <EditChat
        plan={plan}
        busy={busy}
        canEdit={canEdit}
        onSubmit={onSubmit}
        onApprove={onApprove}
        onReject={onReject}
      />
    </div>
  );
}
