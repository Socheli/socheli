export const meta = {
  name: 'socheli-team-tenancy',
  description: 'Propagate multi-member/org tenancy across engine, API, all dashboard routes/pages, calendar production queue, team UI, and copilot',
  phases: [
    { title: 'Implement', detail: 'subsystem agents scope their files to the workspace + roles' },
    { title: 'Verify', detail: 'typecheck the whole repo and fix regressions' },
  ],
}

/* ── Shared contract every agent receives. The tenancy FOUNDATION is already
   built and verified; agents consume it and must not modify the foundation files. */
const CONTRACT = `
SOCHELI MULTI-MEMBER / ORG TENANCY — SHARED FOUNDATION (already built & typechecked; DO NOT modify these files):

@os/schemas now exports (packages/schemas/src/tenancy.ts):
  - workspaceIdFor({orgId,userId}), DEFAULT_WORKSPACE ("ws_default"), isPersonalWorkspace(id)
  - ROLES (["owner","admin","member","viewer"]), type Role, ROLE_LABEL, ROLE_RANK, roleAtLeast(role,min)
  - appRoleFromClerk({clerkRole,isCreator,override,personal}), clerkRoleFor(role) -> "org:admin"|"org:member"
  - PERMISSIONS, type Permission, ROLE_PERMISSIONS, can(role, permission, {isOwnerOfRecord?}) -> boolean
  - type TenantContext = { workspaceId, userId, orgId, role, plan, via }, systemContext(workspaceId?)
  - TenantFields (spread into a zod object: z.object({ ...TenantFields, ... })), type Tenanted = {workspaceId?,createdBy?}
  - recordWorkspace(rec), recordInWorkspace(rec, workspaceId), scopeToWorkspace(items,{workspaceId})
  - stampOwnership(record, ctx), ownsRecord(record, {userId})
  Permission vocabulary includes: content.create, content.edit.any/own, content.delete.any/own, content.publish,
  queue.dispatch, queue.cancel, calendar.edit, plan.run, brand.manage, schedule.manage, device.manage,
  analytics.view, member.invite, member.remove, member.role, billing.manage, apikey.manage, org.settings, org.delete, audit.view.

ContentItem and ChannelDNA schemas already include optional workspaceId + createdBy.

Dashboard server libs (apps/dashboard/lib) — already built, import & use (DO NOT modify):
  - tenancy.ts: currentContext(): Promise<TenantContext>; currentWorkspaceId(): Promise<string>;
      ctxCan(ctx,perm,opts?); assertCan(ctx,perm,opts?) [throws ForbiddenError]; forbidden(perm): Response.
  - api-keys.ts: listKeys(workspaceId), issueKey(ctx,{label,role}), revokeKey(workspaceId,id), resolveKey(raw). File: data/api-keys.json (records: {id,prefix,hash,workspaceId,createdBy,role,label,createdAt,lastUsedAt?,revokedAt?}).
  - audit.ts: audit(ctx, action, target?, meta?); readAudit(workspaceId, limit?).
  - data.ts: listItemsFor(workspaceId), getItemFor(id, workspaceId), warRoom(workspaceId?), Item type has workspaceId?/createdBy?. (legacy listItems()/getItem() still exist.)
  - brands.ts: listBrands(workspaceId?), getBrand(id, workspaceId?), brandUsage(workspaceId?), saveBrand(input, mode, ctx?), deleteBrand(id, workspaceId?).

Migration already applied: existing data stamped workspaceId="ws_default".

RULES:
  - This is NOT a git repo. Only edit files in YOUR assigned set. Never touch the foundation files above.
  - Dashboard pages are React Server Components: call \`const ctx = await currentContext()\` (or currentWorkspaceId()),
    read with the *For(workspaceId) helpers, and pass ctx.role to client components so they can disable/hide controls the role can't use.
  - Route handlers (app/api/.../route.ts): resolve ctx, scope every read to ctx.workspaceId (return 404 when a record isn't in the workspace),
    and gate every mutation: \`try { assertCan(ctx, "<perm>"); } catch { return forbidden("<perm>"); }\`, then audit(ctx, "<action>", id) on success.
    For *.own permissions pass {isOwnerOfRecord: ownsRecord(record, ctx)}.
  - The ENGINE (packages/engine) and API server (packages/api) have NO Clerk. Engine functions take an explicit workspaceId
    parameter (default DEFAULT_WORKSPACE) and stamp records via stampOwnership/TenantFields. The API server resolves the caller's
    TenantContext from the Bearer key via resolveKey() (read data/api-keys.json directly; legacy env SOCHELI_API_KEY = systemContext()/owner).
  - Add tenant fields with TenantFields when a record type is defined with zod; for plain TS types add optional workspaceId?: string; createdBy?: string.
  - Match the surrounding code style exactly (comment density, naming, idioms). Keep changes minimal and correct. Write real, working code.
  - Do not run dev servers. Keep your files typecheck-clean.

Return a concise list of the files you changed and the key behavior added.
`

const REPO = process.env.SOCHELI_ROOT || new URL('..', import.meta.url).pathname

const subsystems = [
  {
    label: 'content-library',
    title: 'Content / Library / War-room',
    prompt: `${CONTRACT}

YOUR SUBSYSTEM: Content items, the Library, post detail/editor, and the War Room home.
FILES YOU OWN (edit only these):
  - packages/engine/src/store.ts  -> add listItemsFor(workspaceId), getItemFor(id, workspaceId); make saveItem accept an optional ctx/workspaceId to stamp ownership via stampOwnership (keep saveItem(item) working). Keep DATA_DIR/RUNS_DIR exports intact.
  - apps/dashboard/app/page.tsx (War Room)  -> scope warRoom(ctx.workspaceId).
  - apps/dashboard/app/library/page.tsx  -> use listItemsFor(workspaceId); if it has a client list, pass role so non-members can't see edit/delete actions.
  - apps/dashboard/app/post/[id]/page.tsx and apps/dashboard/app/post/[id]/edit/page.tsx  -> use getItemFor(id, workspaceId); 404/redirect if not in workspace; pass role + ownsRecord to gate editor controls.
  - apps/dashboard/app/api/item/[id]/route.ts, apps/dashboard/app/api/generate/route.ts, apps/dashboard/app/api/rerender/route.ts, apps/dashboard/app/api/publish/route.ts, apps/dashboard/app/api/video/[id]/route.ts, apps/dashboard/app/api/thumb/[id]/route.ts, apps/dashboard/app/api/scenethumb/[i]/route.ts (if present), apps/dashboard/app/api/props/[id]/route.ts, apps/dashboard/app/api/assets/route.ts
  -> scope reads to workspace (getItemFor); gate generate/rerender with queue.dispatch, publish with content.publish, edits with content.edit.own (pass isOwnerOfRecord). audit() the mutations. Read endpoints (video/thumb/props) must 404 when the item isn't in the caller's workspace.
First read each file to learn its current shape, then make minimal correct edits.`,
  },
  {
    label: 'brands-channels',
    title: 'Brands / Channels',
    prompt: `${CONTRACT}

YOUR SUBSYSTEM: Brand registry + the Channels page (brand CRUD, plan-gated count).
FILES YOU OWN:
  - packages/engine/src/brands-store.ts  -> make read/write workspace-aware: add a workspaceId param to the registry reads (default DEFAULT_WORKSPACE), filter by recordInWorkspace, stamp new brands. Keep existing exports working for callers that pass nothing.
  - apps/dashboard/app/channels/page.tsx and its client (e.g. BrandManager) -> list brands via listBrands(workspaceId); enforce per-workspace brandUsage(workspaceId) for the plan gate; pass ctx.role so only brand.manage roles see create/edit/delete; show plan seat/brand counts for THIS workspace.
  - apps/dashboard/app/api/brands/route.ts (GET list / POST create), apps/dashboard/app/api/brands/[id]/route.ts (GET/PATCH/DELETE), apps/dashboard/app/api/brands/crawl/route.ts
  -> GET scoped to workspace (listBrands(ctx.workspaceId)/getBrand(id, ctx.workspaceId)); POST/PATCH/DELETE gated by brand.manage and call saveBrand(input,mode,ctx)/deleteBrand(id, ctx.workspaceId); audit() each change; brandUsage(ctx.workspaceId) for the create-limit response.
Note lib/brands.ts is FOUNDATION (already updated) — call it, don't modify it.`,
  },
  {
    label: 'calendar-queue-plan',
    title: 'Calendar / Production Queue / Plan (CORE multi-member surface)',
    prompt: `${CONTRACT}

YOUR SUBSYSTEM (the headline ask: make the calendar + production queue team & multi-member compatible):
FILES YOU OWN:
  - packages/engine/src/algo-research.ts -> add workspaceId?: string and createdBy?: string and (NEW) assignee?: string to the PlannedPost type, so a planned post can be owned and ASSIGNED to a teammate.
  - packages/engine/src/content-plan.ts -> make loadPlan/savePlan/CRUD workspace-aware: add loadPlanFor(workspaceId) (filter via recordInWorkspace), scope getPost/postsForDate/updatePost/movePost/archivePost/removePost to a workspaceId param (default DEFAULT_WORKSPACE), stamp new posts with workspaceId/createdBy, add "assignee" to the EDITABLE field list. Keep zero-arg legacy calls working.
  - apps/dashboard/lib/content-plan.ts (the dashboard mirror) -> mirror the same workspace scoping + assignee support.
  - apps/dashboard/lib/calendar-events.ts and apps/dashboard/lib/calendar-meta.ts -> scope events/meta (notes, reminders) to workspaceId; stamp createdBy; add per-event optional assignee where it fits.
  - apps/dashboard/app/calendar/page.tsx (+ its client) -> scope to workspace; add a MEMBER FILTER (filter posts by assignee/creator using the org's members) and show who a post is assigned to / created by; gate edit/move/plan-run by calendar.edit / plan.run; pass org members + role to the client.
  - apps/dashboard/app/queue/page.tsx (Production Queue) -> scope in-flight items/jobs to the workspace; show owner/assignee per job; let an admin reassign; gate cancel by queue.cancel.
  - apps/dashboard/app/plan/page.tsx (Algo Lab) -> scope plan/strategy to workspace; gate plan.run.
  - apps/dashboard/app/api/plan/route.ts, apps/dashboard/app/api/plan/research/route.ts, apps/dashboard/app/api/calendar/route.ts, apps/dashboard/app/api/calendar/meta/route.ts, apps/dashboard/app/api/calendar/prompt/route.ts, apps/dashboard/app/api/schedule/route.ts, apps/dashboard/app/api/schedule/reschedule/route.ts
  -> resolve ctx, scope reads to workspace, gate mutations (calendar.edit / plan.run / schedule.manage), support setting a post's assignee, audit() changes.
  - LEAVE apps/dashboard/app/api/calendar/ics/route.ts public but make the ICS feed scope by a workspace token (the .ics must keep working without a session — derive workspace from its token, defaulting safely).
This is the most important subsystem — make assignment + per-member visibility genuinely work end to end.`,
  },
  {
    label: 'concepts',
    title: 'Concepts board',
    prompt: `${CONTRACT}

YOUR SUBSYSTEM: the Concept board.
FILES YOU OWN:
  - apps/dashboard/lib/concepts.ts -> scope concepts (data/concepts.json, an array) by workspaceId: add a workspaceId param to reads (filter via recordInWorkspace), stamp new concepts with workspaceId/createdBy. Comments keep their author. Keep legacy calls working.
  - apps/dashboard/app/concepts/page.tsx (+ client) -> list scoped to workspace; pass role to gate create/comment/status changes; show concept author.
  - apps/dashboard/app/api/concepts/route.ts, apps/dashboard/app/api/concepts/comment/route.ts, apps/dashboard/app/api/concepts/status/route.ts
  -> resolve ctx; scope reads; gate create with content.create, status with content.edit.own (pass isOwnerOfRecord via ownsRecord); comments allowed for any member; audit() changes.`,
  },
  {
    label: 'devices-autopilot-jobs',
    title: 'Devices / Fleet / Autopilot / Jobs',
    prompt: `${CONTRACT}

YOUR SUBSYSTEM: the render fleet, autopilot, and job queue.
FILES YOU OWN:
  - packages/engine/src/fleet.ts -> add workspaceId?: string and createdBy?: string to the Job type (and JobRow if defined here) so a dispatched job belongs to a workspace.
  - packages/engine/src/bridge.ts -> preserve workspaceId/createdBy through the job lifecycle (dispatched -> running -> done) when it writes data/jobs.json; do not drop the fields.
  - apps/dashboard/lib/fleet.ts -> scope job reads by workspaceId (filter jobs by recordInWorkspace); devices may be shared but tag/filter by workspace where a device is claimed; keep legacy calls working.
  - apps/dashboard/lib/schedule.ts -> scope the autopilot schedule by workspace (a workspace has its own cadence); stamp workspaceId.
  - apps/dashboard/app/devices/page.tsx -> scope fleet/jobs to workspace; gate device.manage actions by role.
  - apps/dashboard/app/autopilot/page.tsx (+ client) -> scope schedule to workspace; gate schedule.manage.
  - apps/dashboard/app/api/jobs/route.ts, apps/dashboard/app/api/jobs/[id]/route.ts, apps/dashboard/app/api/jobs/[id]/stream/route.ts, apps/dashboard/app/api/scheduler/route.ts
  -> resolve ctx; scope job reads to workspace (404 cross-workspace); gate dispatch/cancel; audit().
  NOTE: app/api/agent/* is owned by another agent — do not touch it.`,
  },
  {
    label: 'api-sdk-cli-mcp',
    title: 'API server + SDK / CLI / MCP',
    prompt: `${CONTRACT}

YOUR SUBSYSTEM: the @socheli/api Hono server and the SDK/CLI/MCP clients.
FILES YOU OWN:
  - packages/api/src/server.ts and a NEW packages/api/src/auth.ts:
      * Replace the single static-key check with a per-key resolver. auth.ts: resolveContext(authHeader) -> TenantContext|null by reading data/api-keys.json (hash the bearer with sha256 and match a non-revoked record -> {workspaceId, role, createdBy}); ALSO accept the legacy env SOCHELI_API_KEY as systemContext() (owner of DEFAULT_WORKSPACE). Build TenantContext with via:"apikey".
      * Thread the resolved ctx into every /v1/* handler; scope reads to ctx.workspaceId (items, jobs, fleet, schedule, plan); gate mutations with can(ctx.role, "<perm>") returning 403 when denied (generate->queue.dispatch, publish->content.publish, schedule PUT->schedule.manage, plan writes->calendar.edit, tool calls->map by tool kind: read tools allowed to any role, mutate/long tools require the matching content/queue perm).
      * Add endpoints: GET /v1/keys (list this workspace's keys, no secrets), POST /v1/keys (issue — gated by apikey.manage), DELETE /v1/keys/:id (revoke). Mirror the issue/revoke logic against data/api-keys.json (you may duplicate the small sha256 + record logic here since the API package can't import the dashboard).
      * Add GET /v1/me returning the resolved workspaceId + role.
  - packages/api/src/store.ts -> accept a workspaceId and filter listItems/getItem/getJobs/getFleet/getSchedule by it.
  - packages/api/src/match.ts -> only if needed to carry workspace on dispatch.
  - packages/sdk/src/index.ts and packages/sdk/src/types.ts -> add me() and keys (list/issue/revoke) methods; types for ApiKey + Me; the key already carries the workspace so existing calls keep working.
  - packages/cli/src/index.ts -> add \`socheli me\` and \`socheli keys <list|issue|revoke>\` commands.
  - packages/mcp/src/index.ts -> add a socheli_me tool; the existing tools now operate within the key's workspace automatically.
Keep everything typecheck-clean against tsconfig.base.json (packages/*/src).`,
  },
  {
    label: 'team-billing-keys-audit',
    title: 'Team management UI + billing/usage + API keys + audit (the org control center)',
    prompt: `${CONTRACT}

YOUR SUBSYSTEM: the team-management heart — org roles/ownership/access controls, seat enforcement, API-key management UI, audit log, and per-workspace billing/usage.
FILES YOU OWN:
  - apps/dashboard/app/settings/OrgSettings.tsx -> UPGRADE the team UI:
      * Roles must include Owner and Viewer (use ROLES/ROLE_LABEL from @os/schemas), not just admin/member. The org CREATOR is the Owner. Persist the finer grade (owner/viewer) in the org publicMetadata.roles[userId] map via organization.update({ publicMetadata }) while still calling Clerk member.update({ role: clerkRoleFor(appRole) }) for the underlying org:admin/org:member. Map a member's displayed role with appRoleFromClerk.
      * Access controls: only Owner/Admin can change roles, invite, remove; only Owner can delete the org or transfer ownership (add a "Transfer ownership" action that sets publicMetadata owner + promotes). Viewers are read-only.
      * SEAT ENFORCEMENT: before inviting, block when (membersCount + pendingInvites) >= the plan's seats quota (import PLANS/planById + currentPlanId from ../../lib/billing); show "Upgrade to add seats".
      * Show a permission summary (what each role can do) and render an Audit log section (fetch from a new /api/audit route).
  - apps/dashboard/app/settings/SettingsClient.tsx and apps/dashboard/app/settings/page.tsx -> in the "API & Developers" tab, replace the static-key note with real per-workspace API-key management (list keys from /api/keys, issue with a label+role, copy-once, revoke). Pass the server ctx.role to gate apikey.manage.
  - NEW apps/dashboard/app/api/keys/route.ts (GET list, POST issue) and apps/dashboard/app/api/keys/[id]/route.ts (DELETE revoke) -> use lib/api-keys.ts + currentContext(); gate with apikey.manage; audit().
  - NEW apps/dashboard/app/api/audit/route.ts (GET) -> readAudit(ctx.workspaceId); gate with audit.view.
  - apps/dashboard/lib/usage.ts -> scope usage counting to a workspaceId (posts this month from listItemsFor, devices/seats from the workspace + plan).
  - apps/dashboard/app/usage/page.tsx and apps/dashboard/app/billing/page.tsx and apps/dashboard/app/analytics/page.tsx -> scope all metrics to ctx.workspaceId; on usage/billing show seats used vs plan (members count) and gate billing actions by billing.manage.
  - apps/dashboard/app/api/analytics/route.ts and apps/dashboard/app/api/abtest/route.ts -> scope to workspace; gate writes.
  Note: lib/api-keys.ts, lib/audit.ts, lib/tenancy.ts are FOUNDATION — import them, don't modify.`,
  },
  {
    label: 'copilot-agent',
    title: 'Copilot (Soli) org scoping',
    prompt: `${CONTRACT}

YOUR SUBSYSTEM: the in-app Copilot (Soli) agent.
FILES YOU OWN:
  - apps/dashboard/app/api/agent/route.ts and apps/dashboard/app/api/agent/jobs/route.ts -> resolve currentContext() and pass the TenantContext (workspaceId, userId, role) into the agent run; gate the route so a viewer can use read tools only.
  - apps/dashboard/lib/agent/graph.ts and apps/dashboard/lib/agent/tools.ts (and lib/agent/* as needed, EXCEPT lib/agent/icog.ts memory wiring which you may extend but keep working) -> thread the workspace context so every tool call is scoped to ctx.workspaceId, and enforce that mutating tools require the matching permission (can(ctx.role, perm)). The agent must only see/act on the caller's workspace data.
  - apps/dashboard/app/copilot/useAgent.ts and Copilot.tsx -> include org/workspace + role in the AgentContext sent to the API.
  Keep the SSE streaming + existing tool registry working; just add scoping + permission gating.`,
  },
]

phase('Implement')
log(`Launching ${subsystems.length} subsystem agents in parallel over disjoint file sets…`)

const results = await parallel(
  subsystems.map((s) => () =>
    agent(s.prompt, { label: s.label, phase: 'Implement' }).then((out) => ({ label: s.label, title: s.title, out }))
  )
)

const done = results.filter(Boolean)
log(`Implementation complete: ${done.length}/${subsystems.length} subsystems reported back.`)

phase('Verify')
const verifyPrompt = `${CONTRACT}

VERIFY & FIX the whole repo after the tenancy fan-out. Run, from ${REPO}:
  1) node_modules/.bin/tsc -p tsconfig.base.json --noEmit   (covers packages/*/src — must be CLEAN)
  2) cd apps/dashboard && node ../../node_modules/typescript/bin/tsc -p tsconfig.json --noEmit
PRE-EXISTING baseline you should NOT try to fix (they existed before this work): ~77 errors in packages/remotion/src/scenes.tsx, a few in Post.tsx/effects.tsx, the TS5097 ".ts extension" notices in packages/schemas & packages/tokens index files, app/page.tsx(55) and app/devices/page.tsx(28) "number not assignable to string", and .next/types generated files.
Your job: fix any NEW errors introduced by the tenancy changes (wrong signatures, missing awaits on currentContext(), bad imports, type mismatches on workspaceId/role/assignee, route handler return types). Edit whatever files are needed to make the tenancy-related code typecheck. Do NOT modify the foundation files' behavior. Report the before/after error counts and the NEW errors you fixed.`

const verify = await agent(verifyPrompt, { label: 'verify-and-fix', phase: 'Verify' })

return { subsystems: done.map((d) => ({ label: d.label, summary: String(d.out).slice(0, 800) })), verify: String(verify).slice(0, 2000) }
