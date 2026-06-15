import { schedulerStatus } from "../../../lib/schedule";
import { currentContext } from "../../../lib/tenancy";

export const dynamic = "force-dynamic";

export async function GET() {
  const ctx = await currentContext();
  return Response.json(schedulerStatus(ctx.workspaceId));
}
