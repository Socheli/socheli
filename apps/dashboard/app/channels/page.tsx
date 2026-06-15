import { listBrands, brandUsage } from "../../lib/brands";
import { currentContext, ctxCan } from "../../lib/tenancy";
import { BrandManager } from "./BrandManager";

export const dynamic = "force-dynamic";

export default async function Channels() {
  const ctx = await currentContext();
  const brands = listBrands(ctx.workspaceId);
  const usage = brandUsage(ctx.workspaceId);
  const canManage = ctxCan(ctx, "brand.manage");
  return <BrandManager initialBrands={brands} initialUsage={usage} canManage={canManage} />;
}
