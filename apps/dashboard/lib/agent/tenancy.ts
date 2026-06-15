import {
  can,
  DEFAULT_WORKSPACE,
  systemContext,
  type Permission,
  type TenantContext,
} from "@os/schemas";
import type { OpenAITool, ToolDef, ToolKind } from "./tools";

/* Tenancy for the Soli agent.

   The agent runs server-side with a resolved TenantContext (workspaceId, userId,
   role) for the caller. Two jobs live here:

   1. SCOPING — every engine tool call is pinned to the caller's workspace by
      injecting `workspaceId` (and the author `createdBy`) into the tool args, so
      a tool only ever sees / writes data in that workspace. The injected fields
      are reserved: a model-supplied value is ALWAYS overwritten so the agent can
      never reach across workspaces by guessing a foreign id.

   2. PERMISSION GATING — a mutating tool (kind "mutate" / "long") may run only if
      the caller's role grants the matching permission. A `viewer` can therefore
      use read tools but never act. Local orchestration tools (team_run / …) are
      gated as content actions; iCog memory tools are read/write of the agent's
      own memory and are allowed for anyone who can use the copilot at all.

   The TenantContext is resolved in the route from the Clerk session (or, for the
   job queue, the system context) — NEVER from client-supplied input. */

/* Per-tool permission map. A tool not listed here falls back to permByKind():
   reads are ungated, mutating tools require content.create as a safe baseline so
   a brand-new tool is gated rather than silently open. */
const TOOL_PERMISSION: Record<string, Permission> = {
  // editor mutations operate on an existing item -> edit
  editor_clone_item: "content.create",
  editor_set_path: "content.edit.any",
  editor_unset_path: "content.edit.any",
  editor_patch_scene: "content.edit.any",
  editor_add_scene: "content.edit.any",
  editor_delete_scene: "content.edit.any",
  editor_duplicate_scene: "content.edit.any",
  editor_move_scene: "content.edit.any",
  editor_split_scene: "content.edit.any",
  editor_terminal_line: "content.edit.any",
  editor_set_style: "content.edit.any",
  editor_set_effect: "content.edit.any",
  editor_suite_autofix: "content.edit.any",
  editor_accept_autofix: "content.edit.any",
  editor_apply_recipe: "content.edit.any",
  editor_start_rerender: "queue.dispatch",

  // Pillar 5 Studio — ingest + chat-edit an arbitrary video (kind:"ingested").
  // ingest_video imports a NEW item (create); editor_understand analyses an
  // existing item (edit-class). creative_edit_route writes an analysis-only
  // EditPlan artifact (edit-class — proposes, never renders). The APPLY/one-shot
  // tools execute the plan through the real timeline machinery + (optionally)
  // re-render, so they are queue.dispatch like every other render path. Mapping
  // by NAME keeps gating correct even though these ship kind read/mutate/long in
  // the engine manifest (which would otherwise default the mutating ones to the
  // content.create baseline). Read tools (editor_understanding_get, timeline_get,
  // ingest_status) carry kind:"read" and stay viewer-ok via permByKind().
  ingest_video: "content.create",
  editor_understand: "content.edit.any",
  auto_subtitle: "content.edit.any",
  creative_edit_route: "content.edit.any",
  creative_montage: "content.edit.any",
  creative_subtitle: "content.edit.any",
  creative_apply_plan: "queue.dispatch",
  creative_edit: "queue.dispatch",
  // direct timeline mutations (trim/razor/insert/overwrite/jl_cut/slip/slide…)
  // edit an existing item's timeline -> edit-class; compile/render -> dispatch.
  timeline_build: "content.edit.any",
  timeline_trim: "content.edit.any",
  timeline_razor: "content.edit.any",
  timeline_insert: "content.edit.any",
  timeline_overwrite: "content.edit.any",
  timeline_compile: "content.edit.any",
  render_hybrid: "queue.dispatch",

  // pipeline / render / generation -> dispatch a job
  pipeline_generate_post: "content.create",
  pipeline_generate_longform: "content.create",
  pipeline_autopilot: "schedule.manage",
  pipeline_rerender: "queue.dispatch",
  tools_batch_rerender: "queue.dispatch",

  // draft builder
  draft_set_idea: "content.create",
  draft_script: "content.create",
  draft_set_script: "content.edit.any",
  draft_storyboard: "content.create",
  draft_set_storyboard: "content.edit.any",
  draft_render: "queue.dispatch",

  // concepts
  concept_select: "content.create",
  concept_board_comment: "content.edit.any",
  concept_board_set_status: "content.edit.any",
  concept_board_generate: "content.create",

  // publishing
  publish_item: "content.publish",
  publish_export_bundle: "content.publish",

  // derivatives
  derivatives_make_thumbnail: "content.edit.any",
  derivatives_make_aspects: "content.edit.any",

  // a/b testing
  abtest_generate_variants: "content.create",

  // analytics ingest
  analytics_ingest: "analytics.view",

  // learnings
  learnings_record_win: "content.edit.any",
  learnings_record_avoid: "content.edit.any",

  // intel (long generations) -> create-class work
  intel_trend: "content.create",
  intel_suggest_titles_hashtags: "content.create",
  intel_topic_overview: "content.create",

  // long-form content helpers
  tools_qa_storyboard: "content.edit.any",
  tools_revise_storyboard: "content.edit.any",
  tools_fact_check: "content.edit.any",
  tools_generate_package: "content.create",
  tools_optimize_hook: "content.edit.any",
  tools_preview_voice: "content.create",
  tools_select_music: "content.edit.any",
  tools_search_broll: "content.edit.any",
  tools_render_cover: "content.edit.any",

  // scheduler / autopilot cadence
  scheduler_install: "schedule.manage",
  scheduler_uninstall: "schedule.manage",
  scheduler_tick: "schedule.manage",
  tools_schedule_update: "schedule.manage",

  // calendar plan
  plan_create: "calendar.edit",
  plan_update: "calendar.edit",
  plan_move: "calendar.edit",
  plan_archive: "calendar.edit",
  plan_delete: "calendar.edit",
  plan_run: "plan.run",

  // LOCAL orchestration tools (spawn sub-agents / background work)
  team_run: "content.create",
  workflow_run: "content.create",
  queue_enqueue: "content.create",

  // Brand Genome (DNA): evolution + trait edits -> create-class work…
  dna_evolve: "content.create",
  dna_set_trait: "content.create",
  // …but genome APPROVALS (apply/reject a queued mutation, lock a trait) are a
  // brand-level decision -> brand.manage, which only admin/owner hold.
  dna_mutation_approve: "brand.manage",
  dna_mutation_reject: "brand.manage",
  dna_lock_trait: "brand.manage",

  // research harness: a run is a paid long generation -> create-class
  research_run: "content.create",

  // agent harness: delegate deep multi-step work to a background agent
  agent_run_task: "content.create",

  // paid boosts (ads_*): approving/launching spend is publish-grade; the kill
  // switch + caps are an ops control -> schedule.manage. ads_plan/ads_create/
  // ads_pause fall through to the kind-based content.create baseline, and
  // ads_status/ads_list ship kind "read" -> viewer-ok via permByKind().
  ads_approve: "content.publish",
  ads_launch: "content.publish",
  ads_budget: "schedule.manage",

  // missions orchestrator (tools may land in a parallel change; mapping by
  // NAME here keeps gating correct regardless of landing order)
  mission_create: "content.create",
  mission_update: "content.create",
  mission_pause: "content.create",
  mission_resume: "content.create",
  mission_tick: "content.create",
};

/* Harness-v2 read tools (dna/research/mission/agent-task) used to be name-matched
   here as a landing-order shim. They now all ship `kind:"read"` in the engine
   manifest, so permByKind() already resolves them to viewer+ via the kind path —
   the regex was dead and only risked silently outranking (masking) a future
   explicit gate added in TOOL_PERMISSION. Removed; manifest kind governs reads. */

/* Default permission for an unmapped tool, by its registry kind. Reads are open;
   anything that mutates requires at least the baseline create permission. */
function permByKind(kind: ToolKind): Permission | null {
  return kind === "read" ? null : "content.create";
}

/* Tools whose effect is purely on the agent's OWN memory or presentation — never
   gated by workspace role (anyone who can chat with Soli can use them). */
const UNGATED_TOOLS = new Set<string>([
  "ui_render",
  "ui_guide",
  "memory_recall",
  "memory_remember",
  "icog_talk",
  "icog_reflect",
  // Editor Frame-Control intent composers (edit-tools.ts): they only READ the
  // frame surface and return an approve-before-apply PROPOSAL — they never
  // mutate, so a viewer may use them. The MUTATE tools the proposal points to
  // (timeline_*_frame / creative_apply_plan) stay gated by the role matrix.
  "edit_cut_dead_air",
  "edit_reel_key_moments",
  "edit_cut_on_beat",
  "edit_zoom_on_word",
]);

/* Resolve the permission a tool requires, or null when it needs none (a read).
   `kind` is the registry kind for engine tools; local/icog tools are classed by
   the explicit maps above. */
export function permissionFor(name: string, kind: ToolKind): Permission | null {
  if (UNGATED_TOOLS.has(name)) return null;
  if (name in TOOL_PERMISSION) return TOOL_PERMISSION[name];
  return permByKind(kind);
}

/* Whether a tool is a read (no permission required). Used to restrict viewers to
   read-only tools regardless of any future mapping gap. */
export function isReadTool(name: string, kind: ToolKind): boolean {
  return permissionFor(name, kind) === null;
}

/* Build a fast kind lookup from the manifest so the dispatcher can class a tool
   by name. Local/icog tools are absent from the engine manifest; the dispatcher
   treats them via permissionFor's explicit maps and a default of "mutate". */
export function kindMap(manifest: ToolDef[]): Map<string, ToolKind> {
  const m = new Map<string, ToolKind>();
  for (const t of manifest) m.set(t.name, t.kind);
  return m;
}

/* The fields we inject into every engine tool call to pin it to the workspace.
   Reserved: always overwrite any model-supplied value. */
export function scopeArgs(args: unknown, ctx: TenantContext): Record<string, unknown> {
  const obj = args && typeof args === "object" ? { ...(args as Record<string, unknown>) } : {};
  obj.workspaceId = ctx.workspaceId;
  if (ctx.userId) obj.createdBy = ctx.userId;
  return obj;
}

/* Gate a tool call against the caller's role. Returns null when allowed, or a
   structured deny result (which the dispatcher returns as the tool's result so
   the model can explain the refusal instead of crashing the turn). */
export function gate(
  name: string,
  kind: ToolKind,
  ctx: TenantContext,
): { ok: false; error: string; permission: Permission } | null {
  const perm = permissionFor(name, kind);
  if (!perm) return null; // read / ungated
  if (can(ctx.role, perm)) return null;
  return {
    ok: false,
    error: `forbidden: your role (${ctx.role}) cannot "${name}" — missing permission "${perm}".`,
    permission: perm,
  };
}

/* Only advertise tools the caller's role can actually use, so the model never
   even attempts an action it would be denied (a viewer is offered read tools
   only). Defense-in-depth: dispatchTool still gates every call. `kinds` classes
   each tool; tools absent from it (local/icog) are classed via permissionFor. */
export function allowedTools(
  tools: OpenAITool[],
  ctx: TenantContext,
  kinds: Map<string, ToolKind>,
): OpenAITool[] {
  return tools.filter((t) => {
    const name = t.function.name;
    const perm = permissionFor(name, kinds.get(name) ?? "mutate");
    return !perm || can(ctx.role, perm);
  });
}

/* The tenant context carried through the agent. Falls back to the system/default
   workspace when none was resolved (e.g. a legacy single-tenant deployment). */
export function tenantOrSystem(ctx?: TenantContext): TenantContext {
  return ctx ?? systemContext(DEFAULT_WORKSPACE);
}
