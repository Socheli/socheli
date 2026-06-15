import { Eye } from "lucide-react";
import { listObservations } from "../../lib/observations";
import { PageHead } from "../PageHead";
import { CreativeLab, ObsStats } from "./CreativeLab";

export const dynamic = "force-dynamic";

/* Creative Lab — observation inventory.
   Server shell: loads the initial observation list and hands it to the client
   hub (CreativeLab) for live filters, scan submission, and auto-refresh. */

export default async function CreativeLabPage() {
  const obs = listObservations({ sort: "newest", limit: 100 });

  return (
    <>
      <PageHead
        section="create"
        icon={<Eye size={24} strokeWidth={1.6} />}
        title="Creative Lab"
        aside={<ObsStats obs={obs} />}
        sub="Observation inventory — scan any reel, video, or profile for AI-powered creative analysis."
      />

      <CreativeLab initialObs={obs} />
    </>
  );
}
