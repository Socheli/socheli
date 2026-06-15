import { currentContext } from "../../lib/tenancy";
import { listBrands } from "../../lib/brands";
import { adsConfig, listAdsFor, listInstagramPublishedFor, liveDailyBudgetUsd } from "../../lib/ads";
import { SparkMark } from "../../components/sketch";
import { PageHead } from "../PageHead";
import { AdsClient } from "./AdsClient";

export const dynamic = "force-dynamic";

/* Boosts (/ads) — paid amplification of published Instagram posts. Server
   shell: reads the workspace's boost records, the global ads config (kill
   switch + caps), the brand list and the boostable inventory (items already
   published to Instagram), then hands everything to the client. The flow is
   gate-first by construction: draft → approve (human) → dry-run → confirmed
   live launch, with the engine enforcing every spend gate server-side. */

export default async function AdsPage() {
  const ctx = await currentContext();
  const ws = ctx.workspaceId;

  const ads = listAdsFor(ws);
  const config = adsConfig();
  const channels = listBrands(ws).map((b) => ({ id: b.id, name: b.name, accent: b.accent }));
  const items = listInstagramPublishedFor(ws);
  // Presence only — the token itself is NEVER read into page props or logs.
  const credsConfigured = !!process.env.META_ADS_TOKEN && !!process.env.META_AD_ACCOUNT_ID;

  return (
    <>
      <PageHead
        section="grow"
        icon={<SparkMark size={24} />}
        title="Boosts"
        sub="Promote published Instagram posts as engagement ads. Every boost is draft → approve → dry-run → confirmed launch; the kill switch and budget caps hold the line on spend."
      />
      <AdsClient
        initial={{
          ads,
          config,
          channels,
          items,
          liveDailyBudgetUsd: liveDailyBudgetUsd(ads),
          credsConfigured,
          role: ctx.role,
        }}
      />
    </>
  );
}
