import { Eye } from "lucide-react";
import { loadObservation } from "../../../lib/observations";
import { ObsDetail } from "./ObsDetail";

export const dynamic = "force-dynamic";

/* Creative Lab — single observation detail page.
   Loads the observation from the flat JSON store and passes it to the
   client component, which polls for analysis updates while the scan worker runs. */

export default async function ObsDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const obs = loadObservation(id);

  return (
    <>
      <div className="page-head" style={{ marginBottom: 24 }}>
        <div className="eyebrow">// creative-lab / observation</div>
        <h1 className="h1" style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <Eye size={24} strokeWidth={1.6} style={{ flexShrink: 0 }} />
          Observation
        </h1>
      </div>

      <ObsDetail id={id} initial={obs} />
    </>
  );
}
