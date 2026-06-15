import { currentContext, ctxCan, assertCan, forbidden, ForbiddenError } from "../../../lib/tenancy";
import { audit } from "../../../lib/audit";
import { getBrand } from "../../../lib/brands";
import { runAdminTool } from "../../../lib/admin";
import { runResponderTool } from "../../../lib/responder";
import { updatePost } from "../../../lib/content-plan";
import { updateEntry } from "../../../lib/calendar-meta";

/* SMM Admin control API. POST { action, ... } drives the cross-brand controls
   that back /admin: the workspace kill-switch, pause/resume (global or per
   brand), per-brand responder-off, and per-brand budget caps — every one of
   them routed through the engine's admin tools (the sole writer of the admin
   control store + the hard send-halt) via lib/admin.ts runAdminTool.

   GATING: the controls are admin-class — gate on the strongest existing
   autonomous-ops permission, schedule.manage (admin+owner). `reassign` is the
   one exception: handing a planned post / reminder to a teammate is a calendar
   edit, so it gates on calendar.edit. Per-feed approve/reject (DNA / publish /
   inbox / responder go-live) are NOT here — the client hits each feed's own
   existing route so each keeps its own gate. Every mutation audits. */

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const ctx = await currentContext();
  const ws = ctx.workspaceId;
  const body = await req.json().catch(() => null);
  const action = String(body?.action ?? "");

  // ── Reassignment is a calendar edit, gated separately ──────────────────────
  if (action === "reassign") {
    if (!ctxCan(ctx, "calendar.edit")) return forbidden("calendar.edit");
    const kind = String(body?.kind ?? "");
    const id = String(body?.id ?? "");
    const assignee = body?.assignee === null ? undefined : String(body?.assignee ?? "");
    if (!id || (kind !== "post" && kind !== "reminder")) {
      return Response.json({ error: "reassign needs { kind: 'post'|'reminder', id, assignee }" }, { status: 400 });
    }
    const updated =
      kind === "post"
        ? updatePost(id, { assignee }, ws)
        : updateEntry(id, { assignee }, ws);
    if (!updated) return Response.json({ error: "not found in workspace" }, { status: 404 });
    audit(ctx, "admin.reassign", id, { kind, assignee });
    return Response.json({ ok: true, data: updated });
  }

  // ── All other controls are admin-class (schedule.manage) ───────────────────
  try {
    assertCan(ctx, "schedule.manage");
  } catch (e) {
    if (e instanceof ForbiddenError) return forbidden(e.permission);
    throw e;
  }

  // Guard any channel-scoped action to a brand in the caller's workspace.
  const channel = body?.channel !== undefined ? String(body.channel).trim() : undefined;
  const channelActions = new Set(["pause", "resume", "responder_off", "budget"]);
  if (channelActions.has(action)) {
    if (!channel || !getBrand(channel, ws)) return Response.json({ error: "brand not found" }, { status: 404 });
  }

  switch (action) {
    case "killswitch": {
      const on = body?.on === true;
      const reason = typeof body?.reason === "string" ? body.reason.slice(0, 280) : undefined;
      const res = await runAdminTool("admin_kill_switch", { workspaceId: ws, on, reason, by: ctx.userId ?? "system" });
      if (!res.ok) return Response.json({ error: res.message ?? "kill-switch failed" }, { status: 500 });
      audit(ctx, "admin.killswitch", ws, { on, reason });
      return Response.json({ ok: true, data: res.data });
    }

    case "pause_all": {
      const res = await runAdminTool("admin_pause", { workspaceId: ws });
      if (!res.ok) return Response.json({ error: res.message ?? "pause failed" }, { status: 500 });
      audit(ctx, "admin.pause_all", ws);
      return Response.json({ ok: true, data: res.data });
    }
    case "resume_all": {
      const res = await runAdminTool("admin_resume", { workspaceId: ws });
      if (!res.ok) return Response.json({ error: res.message ?? "resume failed" }, { status: 500 });
      audit(ctx, "admin.resume_all", ws);
      return Response.json({ ok: true, data: res.data });
    }

    case "pause": {
      const res = await runAdminTool("admin_pause", { workspaceId: ws, channel });
      if (!res.ok) return Response.json({ error: res.message ?? "pause failed" }, { status: 500 });
      audit(ctx, "admin.pause", channel);
      return Response.json({ ok: true, data: res.data });
    }
    case "resume": {
      const res = await runAdminTool("admin_resume", { workspaceId: ws, channel });
      if (!res.ok) return Response.json({ error: res.message ?? "resume failed" }, { status: 500 });
      audit(ctx, "admin.resume", channel);
      return Response.json({ ok: true, data: res.data });
    }

    case "responder_off": {
      // Disabling never flips the responder ON, so it's safe under schedule.manage
      // (turning it ON is the publish-gated action on /api/responder). responder_set
      // REPLACES the whole config, so fetch the current config and flip ONLY
      // `enabled` — preserving the brand's rules/tone/default (no destructive reset).
      const cur = await runResponderTool("responder_get", { channel });
      const cfg = (cur.ok ? (cur.data as { config?: Record<string, unknown> })?.config : undefined) ?? {};
      const input: Record<string, unknown> = { channel, enabled: false };
      for (const k of ["rules", "defaultAction", "toneNotes", "respectDmWindow", "neverAutoSentiments"] as const) {
        if (cfg[k] !== undefined) input[k] = cfg[k];
      }
      const res = await runResponderTool("responder_set", input);
      if (!res.ok) return Response.json({ error: res.message ?? "responder_off failed" }, { status: 500 });
      audit(ctx, "admin.responder_off", channel);
      return Response.json({ ok: true, data: res.data });
    }

    case "budget": {
      const usdPerDay = Number(body?.usdPerDay);
      const postsPerDay = Number(body?.postsPerDay);
      const input: Record<string, unknown> = { workspaceId: ws, channel };
      if (Number.isFinite(usdPerDay) && usdPerDay > 0) input.usdPerDay = usdPerDay;
      if (Number.isFinite(postsPerDay) && postsPerDay > 0) input.postsPerDay = postsPerDay;
      const res = await runAdminTool("admin_set_budget_cap", input);
      if (!res.ok) return Response.json({ error: res.message ?? "budget cap failed" }, { status: 500 });
      audit(ctx, "admin.budget", channel, { usdPerDay: input.usdPerDay, postsPerDay: input.postsPerDay });
      return Response.json({ ok: true, data: res.data });
    }

    default:
      return Response.json({ error: `unknown action: ${action}` }, { status: 400 });
  }
}
