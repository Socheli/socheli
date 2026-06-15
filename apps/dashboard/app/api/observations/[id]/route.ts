import { loadObservation } from "../../../../lib/observations";
import { currentContext } from "../../../../lib/tenancy";

/* GET /api/observations/:id — load a single full observation record.
   Used by the detail page and by the scan-result polling loop. */

export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  await currentContext();
  const { id } = await params;

  if (!id || !/^obs_[a-z0-9]+$/i.test(id)) {
    return Response.json({ error: "invalid id" }, { status: 400 });
  }

  const obs = loadObservation(id);
  if (!obs) return Response.json({ error: "not found" }, { status: 404 });
  return Response.json({ observation: obs });
}
