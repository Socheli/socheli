import { currentContext, ctxCan, forbidden } from "../../../lib/tenancy";
import { audit } from "../../../lib/audit";
import { getBrand } from "../../../lib/brands";
import { responderFor, runResponderTool } from "../../../lib/responder";

/* Per-brand responder API (engine: responder.ts).
     GET  ?channel=  → responder config + templates for one brand.
     POST            → a responder action: { action, channel, ... }.

   Tenancy: the channel must be a brand in the caller's workspace.
   GATING:
     - EDIT-class (content.edit.any): editing rules/tone/default while the
       responder stays OFF, running a dry-run TEST, and template CRUD — these
       never send anything live.
     - PUBLISH-class (content.publish): turning the responder ON (enabled:true)
       or running it live (responder_run). Enabling auto_send means the agent
       can reply in the brand's voice — that is the gate, like the publish gate.

   The `enabled` flag in a `set` payload decides which gate applies: a set that
   flips enabled true is publish-class; a set that keeps it off is edit-class. */

export const dynamic = "force-dynamic";

/* Actions that are always edit-class (no live send). */
const EDIT_ACTIONS = new Set(["set", "test", "template_set", "template_delete"]);
/* Actions that are always publish-class (live send / enable). */
const PUBLISH_ACTIONS = new Set(["enable", "run"]);

const ACTION_TOOL: Record<string, string> = {
  set: "responder_set",
  enable: "responder_set",
  test: "responder_test",
  run: "responder_run",
  template_set: "template_save",
  template_delete: "template_delete",
};

export async function GET(req: Request) {
  const ctx = await currentContext();
  const channel = new URL(req.url).searchParams.get("channel")?.trim() ?? "";
  if (!channel || !getBrand(channel, ctx.workspaceId)) return Response.json({ error: "brand not found" }, { status: 404 });
  const { config, templates } = responderFor(channel);
  return Response.json({ channel, config, templates });
}

export async function POST(req: Request) {
  const ctx = await currentContext();
  const body = await req.json().catch(() => null);
  const action = String(body?.action ?? "");
  const channel = String(body?.channel ?? "").trim();

  const tool = ACTION_TOOL[action];
  if (!tool) return Response.json({ error: `unknown action: ${action}` }, { status: 400 });
  if (!channel || !getBrand(channel, ctx.workspaceId)) return Response.json({ error: "brand not found" }, { status: 404 });

  // A `set` that flips the master switch ON is publish-class; otherwise edit-class.
  const enablesLive = action === "set" && body?.enabled === true;
  const needsPublish = PUBLISH_ACTIONS.has(action) || enablesLive;

  if (needsPublish) {
    if (!ctxCan(ctx, "content.publish")) return forbidden("content.publish");
  } else if (EDIT_ACTIONS.has(action)) {
    if (!ctxCan(ctx, "content.edit.any")) return forbidden("content.edit.any");
  } else {
    return Response.json({ error: `unknown action: ${action}` }, { status: 400 });
  }

  // Build the engine input per action. The dashboard↔engine bridge is an
  // untyped spawn, so this ADAPTS the client's natural shapes to the engine
  // tools' STRICT zod schemas (responder_set / template_save take FLAT fields).
  const input: Record<string, unknown> = { channel };
  if (action === "set" || action === "enable") {
    // The client sends the canonical ResponderConfig under `config`; responder_set
    // takes those fields flat. Unwrap config, let a granular top-level field
    // override it, and map the legacy `tone` alias → toneNotes.
    const cfg = (body?.config && typeof body.config === "object" ? body.config : {}) as Record<string, unknown>;
    for (const k of ["enabled", "rules", "defaultAction", "toneNotes", "respectDmWindow", "neverAutoSentiments"] as const) {
      if (cfg[k] !== undefined) input[k] = cfg[k];
      if (body?.[k] !== undefined) input[k] = body[k];
    }
    const tone = body?.tone ?? (cfg as { tone?: unknown }).tone;
    if (tone !== undefined && input.toneNotes === undefined) input.toneNotes = tone;
  } else if (action === "test" || action === "run") {
    if (body?.limit !== undefined) input.limit = body.limit;
    if (body?.scope !== undefined) input.scope = body.scope;
  } else if (action === "template_set") {
    // engine template_save takes flat {name, body, tags, id?}; client sends a nested `template`.
    const t = (body?.template && typeof body.template === "object" ? body.template : body) as Record<string, unknown>;
    for (const k of ["id", "name", "body", "tags"] as const) {
      if (t[k] !== undefined) input[k] = t[k];
    }
  } else if (action === "template_delete") {
    const id = body?.id ?? body?.templateId; // engine template_delete wants `id`
    if (id !== undefined) input.id = id;
  }

  const res = await runResponderTool(tool, input);
  if (!res.ok) return Response.json({ error: res.message ?? `${action} failed` }, { status: 400 });

  // Audit with safe summary fields only (no message bodies / tokens).
  const cfg = (body?.config ?? {}) as { rules?: unknown[]; defaultAction?: string };
  audit(ctx, `responder.${action}`, channel, {
    ruleCount: Array.isArray(cfg.rules) ? cfg.rules.length : Array.isArray(body?.rules) ? body.rules.length : undefined,
    defaultAction: cfg.defaultAction ?? body?.defaultAction,
    enabled: action === "set" ? body?.enabled : undefined,
  });

  return Response.json({ ok: true, data: res.data });
}
