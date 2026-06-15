import { currentContext, ctxCan } from "../../lib/tenancy";
import { PageHead } from "../PageHead";
import { AlgoLab } from "./AlgoLab";

export const dynamic = "force-dynamic";

/* Algo Lab (server shell). The planner reads + writes the caller's workspace; the
   actual run is gated server-side on `plan.run` in /api/plan/research, and we pass
   the same permission down so the UI disables the run button for viewers. */

export default async function PlanPage() {
  const ctx = await currentContext();
  const canPlan = ctxCan(ctx, "plan.run");
  return (
    <>
      <PageHead
        section="create"
        title="Algorithm-Hacking Planner"
        sub="Pick a brand, reverse-engineer what each of its platforms rewards right now, and auto-fill the calendar with a scored content slate engineered against those signals."
      />
      <AlgoLab canPlan={canPlan} />
    </>
  );
}
