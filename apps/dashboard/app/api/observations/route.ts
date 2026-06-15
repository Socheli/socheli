import { listObservations } from "../../../lib/observations";
import { currentContext } from "../../../lib/tenancy";

/* Creative Lab — observations index.
   GET /api/observations[?platform=&sort=newest|score|likes&limit=]
   Returns the observation list filtered to the current workspace (by channelId
   if scoped; otherwise all observations visible to this user). */

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  await currentContext(); // auth check — no permission needed for reads
  const url = new URL(req.url);
  const platform = (url.searchParams.get("platform") ?? "") || undefined;
  const sort = (url.searchParams.get("sort") ?? "newest") as "newest" | "score" | "likes";
  const limit = Math.min(Number(url.searchParams.get("limit") ?? "100"), 200);

  const observations = listObservations({ platform, sort, limit });
  return Response.json({ observations });
}
