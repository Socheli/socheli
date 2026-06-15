import type { Permission } from "@os/schemas";
import { currentContext, ctxCan, forbidden } from "../../../lib/tenancy";
import { audit } from "../../../lib/audit";
import { getBrand } from "../../../lib/brands";
import { runAdsTool } from "../../../lib/ads";

/* Paid-amplification control API. POST { tool: "ads_*", input } drives the
   boost lifecycle that backs /ads — every call routed through the engine's ads
   tools (the sole writer of data/ads/** + the spend gates) via lib/ads.ts
   runAdsTool, exactly like /api/admin → runAdminTool.

   GATING (ads spend real money — the gates are sacred):
     ads_approve / ads_launch → content.publish  (the human spend gate)
     ads_budget               → schedule.manage  (kill switch + caps = admin)
     ads_plan / ads_create / ads_pause → content.create (draft-side work)
     ads_status / ads_list    → any member (reads)
   Tenancy is PINNED server-side (workspaceId/createdBy from the session ctx —
   never trusted from the client) and any channel-scoped input must name a brand
   in the caller's workspace. ads_launch is dry-run-by-default: a live launch
   requires BOTH input.dryRun === false AND an explicit top-level confirm: true,
   else 400. Every mutation audits. */

export const dynamic = "force-dynamic";

const GATES: Record<string, Permission | null> = {
  ads_plan: "content.create",
  ads_create: "content.create",
  ads_pause: "content.create",
  ads_approve: "content.publish",
  ads_launch: "content.publish",
  ads_budget: "schedule.manage",
  ads_status: null,
  ads_list: null,
};

const READ_TOOLS = new Set(["ads_status", "ads_list"]);

export async function POST(req: Request) {
  const ctx = await currentContext();
  const ws = ctx.workspaceId;
  const body = (await req.json().catch(() => null)) as
    | { tool?: unknown; input?: unknown; confirm?: unknown }
    | null;

  const tool = String(body?.tool ?? "");
  if (!(tool in GATES)) {
    return Response.json({ error: `unknown ads tool: ${tool}` }, { status: 400 });
  }
  const perm = GATES[tool];
  if (perm && !ctxCan(ctx, perm)) return forbidden(perm);

  const raw = (body?.input && typeof body.input === "object" ? body.input : {}) as Record<string, unknown>;
  const input: Record<string, unknown> = { ...raw };
  // Never trust the client for tenancy — pin from the session context.
  input.workspaceId = ws;
  input.createdBy = ctx.userId ?? undefined;
  // Approval provenance comes from the session too, never the client.
  if (tool === "ads_approve") input.approvedBy = ctx.userId ?? "operator";

  // Any channel-scoped call must target a brand in the caller's workspace.
  if (typeof input.channel === "string" && input.channel) {
    if (!getBrand(input.channel, ws)) {
      return Response.json({ error: "brand not found" }, { status: 404 });
    }
  }

  // THE LIVE-SPEND GATE: launch is dry-run unless the client explicitly sends
  // dryRun: false, and a live launch additionally requires confirm: true.
  if (tool === "ads_launch") {
    input.dryRun = raw.dryRun === false ? false : true;
    if (input.dryRun === false && body?.confirm !== true) {
      return Response.json(
        { error: "live launch requires explicit confirm: true alongside dryRun: false" },
        { status: 400 },
      );
    }
  }

  const res = await runAdsTool(tool, input);
  if (!res.ok) return Response.json({ error: res.message ?? `${tool} failed` }, { status: 500 });

  if (!READ_TOOLS.has(tool)) {
    const target =
      (typeof input.id === "string" && input.id) ||
      (typeof input.itemId === "string" && input.itemId) ||
      (typeof input.channel === "string" && input.channel) ||
      ws;
    audit(ctx, `ads.${tool.replace(/^ads_/, "")}`, target, {
      ...(tool === "ads_launch" ? { dryRun: input.dryRun } : {}),
      ...(typeof input.channel === "string" ? { channel: input.channel } : {}),
    });
  }

  return Response.json({ ok: true, data: res.data });
}
