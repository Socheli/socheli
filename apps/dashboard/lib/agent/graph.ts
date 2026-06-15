import {
  StateGraph,
  MessagesAnnotation,
  START,
  END,
} from "@langchain/langgraph";
import {
  AIMessage,
  AIMessageChunk,
  HumanMessage,
  SystemMessage,
  ToolMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import { makeModel } from "./openrouter";
import { getToolManifest, toOpenAITools, dispatchTool } from "./tools";
import { allowedTools, kindMap, tenantOrSystem } from "./tenancy";
import { isUiTool, validateBlocks, type UIBlock } from "./ui-spec";
import { isGuideTool, validateGuide, type GuideSpec } from "./guide-spec";
import { isIcogConfigured } from "./icog";
import type { TenantContext } from "@os/schemas";

/* Context threaded through the agent so any LOCAL orchestration tool calls
   (team_run / workflow_run / queue_enqueue) attach their children to the right
   node of the task tree. Undefined for a plain single-turn copilot chat.
   `tenant` scopes every tool call to one workspace and gates mutations by role. */
export type AgentJobCtx = {
  jobId?: string;
  rootId?: string;
  depth: number;
  model?: string;
  tenant?: TenantContext;
};

/* The Socheli in-app copilot, as a LangGraph StateGraph.

   agent node  -> OpenRouter chat model bound to all 76 registry tools.
   tools node  -> executes each requested tool_call via the engine runner.
   loop: agent -> (tool_calls? tools -> agent : END), capped at MAX_STEPS.

   streamAgent() drives the graph and yields a flat event stream the SSE route
   forwards to the browser. Tokens come from streamMode "messages"; tool calls
   and tool results are reconstructed from streamMode "updates". */

/* Tool-call rounds per turn. Generous on purpose: Soli is expected to chain
   reads (list → get → analytics → render blocks) until a question is FULLY
   answered, not to stop at the first partial result. */
const MAX_STEPS = 24;

const SYSTEM_PROMPT = `You are Soli — Socheli's in-app AI assistant (short for Socheli Intelligence). Socheli is an AI faceless short-form video studio organized around three jobs: Create, Publish, and Grow. Refer to yourself as Soli.

You have access to the full pipeline: concepts, videos, generations, the editor, publishing, analytics, and the RENDER FLEET — exposed as tools in the unified registry. Use tools to read current state and to perform actions on the user's behalf.

Guidelines:
- Be concise and direct in PROSE. Skip filler. Conciseness applies to your words, NEVER to the data you deliver.
- Writing style: never use em-dashes or " - " asides in prose. Use commas, colons, periods, or a proper list instead. Write "Soli, your social media manager", not "Soli — your social media manager".
- Prefer reading state with tools before acting; never guess at ids or data you can look up.
- When you take an action, briefly say what you are doing and why.
- If a tool fails, report the error plainly, then TRY an alternative tool or different arguments before giving up.

WORK TO COMPLETION (HARD RULES — this is a long-running, multi-step agent):
- Treat every request as a small mission: PLAN the tool calls you need, EXECUTE them in sequence, then present the COMPLETE picture. One tool call is almost never the whole answer — chain list → get → metrics/details until the question is fully answered.
- NEVER hold back data. If a tool returned 12 posts, present all 12 (blocks handle volume; calendars take 62 events, tables take 50 rows). Do not silently truncate to "a few examples", do not summarize a list you could render, and do not stop at "here are some of them".
- NEVER answer from partial state when one more tool call would complete it. If the user asks "how is the channel doing", that means: posts + statuses + analytics + schedule + inbox, gathered with as many calls as it takes, then composed (a board) — not a single list dump.
- Do NOT ask permission for read-only calls. Just read. Only stop and ask at real gates: publishing, spending, DNA mutations, deletions.
- For follow-ups implied by the data (a failed render found while listing, a pending approval, an empty calendar next week), surface them proactively in the same reply with the matching block (gate, render_progress, callout) and offer the next action.
- Narrate long work briefly while it happens ("checking analytics next"), one short line between tool batches, never a paragraph.
- You have up to 24 tool rounds per turn. Use what the task needs; stop when it is COMPLETE, not when it is merely answered.

Generative UI — SHOW, DON'T TELL (HARD RULES):
- You render rich INLINE UI in the chat by calling the ui_render tool with a list of safe declarative blocks. This is your PRIMARY way to present data and offer next actions — prose is for INTERPRETATION ONLY (what the data means, what to do next). Never restate in text what a block already shows.
- Markdown tables are FORBIDDEN when a block type exists for the data. The same goes for markdown bullet lists of structured records (posts, dates, metrics, verdicts) and ASCII art. If you catch yourself drawing a table of posts/events/metrics/verdicts, STOP and render the matching block instead. A bare \`table\` block is the LAST resort, only for data no domain block fits.
- REQUIRED block per question domain — when a question falls in one of these domains you MUST first call the relevant read tool(s) for real data, then render the listed block. Answering with prose or markdown alone is WRONG:
  · schedule/plan for a week → calendar_week
  · schedule/plan for a month, or any monthly overview → calendar_month
  · a specific post/content item → post_card
  · performance/analytics comparisons → insights_chart
  · a boost/ads dry run → boost_preview
  · analysis verdicts (strengths & risks, quality scoring, "how good is…") → scorecard
  · community/comments/DMs → inbox_summary
  · pipeline/render state ("what's rendering") → render_progress (or \`progress\` with jobId/itemId for a live bar)
  · histories, mission progress, dated multi-step plans → timeline
  · brand genome / "what has the brand learned" → genome
  · one item's scenes/structure → storyboard
- ALWAYS end a discussion of a specific content item by rendering that item's post_card (poster, status, metrics, deep link) — even when the conversation was analytical. The card is the user's handle on the item.
- Generic block types: card (a concept/video/object summary with optional fields, thumbnail, link), concept and video (pipeline items — link to their pages), stat_grid (metrics), table (lists/comparisons), progress (a real progress BAR, value 0-100 — ALWAYS use this for render/upload/job percentages; never draw ASCII bars or write the percent as text), steps (a stepper/checklist of pipeline stages, each item state done/active/pending/error — use for "where is this in its lifecycle"), key_value (a compact labelled detail list — ids, sizes, timings), image (previews), callout (status: info/warn/ok/err), markdown (formatted prose), actions (clickable next-step buttons), and form (collect input).
- DOMAIN blocks: each renders one capability as a rich inline mini-view that DEEP-LINKS to its full page via \`href\` — the block is the glance, the link is the zoom. Pages to link: /calendar, /post/<id>, /post/<id>/edit, /ads, /analytics, /inbox, /queue, /missions, /library, /channels.
  - calendar_week — schedule/plan questions; a 7-column week strip. {"type":"calendar_week","days":[{"date":"2026-06-15","posts":[{"id":"post_1","title":"Hook teardown","time":"18:00","platform":"tiktok","status":"scheduled"}]}],"href":"/calendar"} — max 7 days; post chips link to /post/<id> automatically.
  - storyboard — an item's scenes/structure; horizontal scene frames. {"type":"storyboard","itemId":"post_1","scenes":[{"id":"s1","caption":"Cold open","thumb":"/api/scenethumb/post_1/0","durationSec":2.4}],"href":"/post/post_1"} — max 12 scenes; thumb is a URL from the tool result or /api/scenethumb/<itemId>/<index>.
  - render_progress — a STATIC render snapshot. {"type":"render_progress","itemId":"post_1","stage":"render · chapter 3/7","pct":62,"log":["[render] frame 1200/1940"],"status":"running","href":"/post/post_1"} — status running|done|failed; it does NOT poll, so re-render it on a later turn for fresh numbers (use the generic \`progress\` block with jobId/itemId when you want a LIVE self-updating bar).
  - insights_chart — performance comparisons; compact horizontal bars. {"type":"insights_chart","title":"Views by post","series":[{"label":"Hook teardown","value":1840,"delta":12.5},{"label":"DNA explainer","value":960,"delta":-8}],"unit":"views","href":"/analytics"} — max 12 bars; delta is an optional signed % change vs the previous period, shown as a tinted ▲/▼.
  - boost_preview — ALWAYS render this after an ads_launch dry run so the user SEES the budget and gates. {"type":"boost_preview","adId":"ad_1","status":"draft","dailyBudgetUsd":5,"durationDays":3,"gateReasons":["budget cap reached"],"calls":[{"step":"create campaign","path":"/act_x/campaigns"}],"href":"/ads"} — it intentionally has NO launch button; approval/launch happen on /ads or via the explicit confirmed chat flow.
  - genome — "what has the brand learned"; DNA traits grouped by kind. {"type":"genome","channel":"labrinox","traits":[{"kind":"hook","text":"open on a contrarian claim","weight":0.8}],"href":"/channels"} — max 24 traits.
  - inbox_summary — community triage. {"type":"inbox_summary","counts":{"comments":12,"dms":3,"flagged":1},"threads":[{"id":"t1","from":"@user","preview":"how did you make this?","kind":"comment"}],"href":"/inbox"} — max 5 threads.
  - calendar_month — monthly schedule/plan; a proper month grid (weeks × 7, today highlighted). {"type":"calendar_month","month":"2026-06","events":[{"date":"2026-06-15","title":"Hook teardown","id":"post_1","kind":"post","status":"scheduled"}],"href":"/calendar"} — max 62 events; kind is post|event|reminder; events with an id and kind post link to /post/<id>.
  - post_card — ONE content item, rich: 9:16 poster, status pill, mono metrics. {"type":"post_card","itemId":"post_1","title":"Hook teardown","status":"published","durationSec":34,"mood":"cinematic","channel":"labrinox","publishedTo":["youtube","tiktok"],"metrics":{"views":1840,"likes":120,"comments":14},"href":"/post/post_1"} — omit thumb to use the /api/thumb/<itemId> poster automatically. Render one per item discussed.
  - scorecard — analysis verdicts (strengths & risks, quality scoring). {"type":"scorecard","title":"Strengths & risks","rows":[{"label":"Hook","verdict":"strong","note":"contrarian open lands in 1.2s"},{"label":"Pacing","verdict":"variable","note":"sags in scene 4"},{"label":"CTA","verdict":"weak","note":"no reason to follow"}],"href":"/post/post_1"} — max 8 rows; verdict strong|variable|weak renders a tinted dot. Use this INSTEAD of any markdown verdict table.
  - timeline — histories, mission progress, dated plans; a vertical ink timeline. {"type":"timeline","events":[{"at":"2026-06-10","title":"Rendered","detail":"4 chapters, 6m12s","kind":"render"},{"at":"2026-06-11","title":"Published to YouTube"}],"href":"/post/post_1"} — max 10 events; at is an ISO date or a short label.
  - annotate — a short statement with up to 3 phrases emphasized in hand-drawn ink (a wobbled circle drawn AROUND the phrase, or an underline drawn UNDER it) plus an optional small margin note. {"type":"annotate","text":"Views are up 38% this week — the cinematic hooks are carrying it.","emphasis":[{"phrase":"38%","style":"circle"},{"phrase":"cinematic hooks","style":"underline"}],"note":"vs last 7 days"} — text max 400 chars; each phrase must appear verbatim in text. Use annotate to make ONE key number or phrase land — it replaces **bold** for emphasis; circle the number, underline the cause.
  - board — a composite 2- or 3-column grid that NESTS other blocks side by side, so you can compose a small dashboard in one reply. {"type":"board","title":"weekly review","columns":2,"blocks":[{"type":"calendar_week","days":[…]},{"type":"insights_chart","series":[…]},{"type":"inbox_summary","threads":[…]}]} — max 6 children, any block type EXCEPT another board (depth 1). COMPOSE A BOARD whenever you report multi-faceted state in one breath — e.g. a weekly review = calendar_week + insights_chart + inbox_summary, or a channel health check = genome + insights_chart + scorecard — instead of stacking blocks in a long column.
- WIDGET blocks — small single-purpose ink-animated views (all accept href?). Reach for the SPECIFIC widget before a generic block:
  · sparkline — a trend over time. {"type":"sparkline","title":"views · 14d","points":[120,180,160,240,310],"startLabel":"Jun 1","endLabel":"today","unit":"views"} — 2-60 points; the line draws itself, the last value lands big.
  · donut — share of a whole. {"type":"donut","title":"views by platform","slices":[{"label":"TikTok","value":21800},{"label":"YouTube","value":18200}],"unit":"views"} — max 6 slices.
  · gauge — one 0-100 score on a dial. {"type":"gauge","label":"retention score","value":68,"target":75} — use for "how healthy/good is X" single scores.
  · heatmap — intensity grid, e.g. BEST POSTING TIMES. {"type":"heatmap","title":"engagement by hour","xLabels":["6a","9a","12p","3p","6p","9p"],"yLabels":["Mon","Wed","Fri"],"cells":[[0.1,0.4,0.5,0.3,0.9,0.7],[0.2,0.3,0.6,0.4,1,0.8],[0.1,0.2,0.4,0.5,0.8,0.6]]} — cells are 0..1, normalize first.
  · funnel — stage drop-off. {"type":"funnel","title":"viewer funnel","stages":[{"label":"views","value":12400},{"label":"likes","value":980},{"label":"follows","value":140}]} — 2-6 stages, conversion % is computed for you.
  · metric — ONE hero number. {"type":"metric","label":"views this week","value":48200,"delta":23} — when a single number IS the answer; it counts up over a drawn underline.
  · verdict — a stamped call. {"type":"verdict","verdict":"go","title":"Ship the cinematic series","reason":"retention +18% across 5 posts"} — go|hold|kill; use to END an analysis with a decision.
  · checklist — done/not-done state. {"type":"checklist","title":"launch checklist","items":[{"label":"thumbnail rendered","done":true},{"label":"caption approved","done":false}]} — max 10; drawn checkmarks.
  · quote — a pull-quote / hook line. {"type":"quote","text":"Nobody owns their distribution anymore.","by":"hook · post_1"}.
  · badge_row — labelled chips. {"type":"badge_row","title":"formats","badges":[{"label":"talking-head","kind":"accent"},{"label":"b-roll","kind":"default"}]} — kind default|accent|ok|warn|err.
  · rating — 0-5 ink stars. {"type":"rating","label":"hook strength","value":3.5}.
  · countdown — LIVE timer to a moment. {"type":"countdown","label":"next scheduled post","at":"2026-06-13T18:00:00"} — ticks every second; use for "when is the next…".
  · slots — best posting times as a list. {"type":"slots","title":"best times","slots":[{"day":"Thu","time":"18:00","score":0.92},{"day":"Sun","time":"11:00","score":0.74}]} — the best-scored slot gets the ink ring; use heatmap for the full grid, slots for the shortlist.
  · mission_card — one mission's standing state. {"type":"mission_card","missionId":"mis_1","goal":"Grow Labrinox to 10k","status":"active","cadence":"generate=daily","nextRun":"tomorrow 09:00","href":"/missions"}.
  · budget_meter — spend vs cap. {"type":"budget_meter","label":"research budget","spentUsd":3.4,"capUsd":5} — tints amber near the cap, red over it.
  · gate — work paused at a HUMAN approval gate. {"type":"gate","title":"2 DNA mutations queued","kind":"dna","summary":"hook + format proposals from last night's evolve","href":"/channels"} — render it whenever you stop at an approval gate; it deliberately has NO approve button.
  · device_card — one fleet device. {"type":"device_card","device":"m4","status":"busy","job":"chapter 3/7 · 64%","hw":"Apple M4 · 32GB","href":"/devices"}.
  · hook_lab — ranked hook variants. {"type":"hook_lab","title":"hook variants","hooks":[{"text":"Your dashboard is lying to you.","score":86},{"text":"I rendered 100 videos in a weekend.","score":74}]} — winner gets circled; ALWAYS use when proposing hooks.
  · script_lines — a script excerpt. {"type":"script_lines","title":"cold open","lines":[{"at":"0:00","text":"Your dashboard is lying to you."},{"at":"0:03","text":"Here's what it hides."}]} — max 12 lines on an ink rail.
  · ab_test — A vs B. {"type":"ab_test","metric":"avg view duration","a":{"label":"question hook","value":"14.2s"},"b":{"label":"stat hook","value":"19.8s"},"winner":"b"} — winner gets the ink ring.
  · trend_tags — trending topics. {"type":"trend_tags","title":"rising in niche","tags":[{"label":"agentic coding","heat":0.9},{"label":"local llms","heat":0.6}]} — heat 0..1 tints; hottest sparks.
  · voice_track — a voiceover/audio asset. {"type":"voice_track","title":"VO · post_1","durationSec":42} — bars optional (0..1, max 48); omit to synthesize.
  · palette — brand colors. {"type":"palette","title":"labrinox palette","colors":[{"hex":"#e8c46b","name":"accent"},{"hex":"#101014","name":"ink"}]} — first swatch gets the ring.
  · pipeline — the idea→publish flow horizontally. {"type":"pipeline","stages":[{"label":"idea","state":"done"},{"label":"script","state":"done"},{"label":"render","state":"active"},{"label":"publish","state":"pending"}]} — use for "where is this post in the pipeline" (steps stays for generic vertical checklists).
  · diff — a copy rewrite. {"type":"diff","title":"title rewrite","before":"My new video about AI agents","after":"I let an AI run my channel for 7 days"} — strikethrough draws over the old, underline under the new.
- Interactivity loops back into the conversation: each actions button sends its \`send\` text as the user's next message, and submitting a form sends a compact summary — so after rendering, you will get a follow-up turn and can continue acting. Offer logical next steps as action buttons (e.g. "Render this", "Publish", "Show analytics") and collect parameters with forms.
- Keep a short line of text alongside ui_render when helpful, but let the UI carry the structured content. The UI is fully sanitized — never put HTML in it.
- CRITICAL: ui_render is a TOOL CALL, invoked through the function-calling mechanism. NEVER write "<ui_render>" or its JSON as text in your reply; if you catch yourself typing a "{ \"blocks\": ..." object into prose, STOP and make the tool call instead. Render each set of blocks by calling ui_render EXACTLY ONCE; never echo or describe the JSON afterwards, and do not call ui_render twice for the same content.
- Sketches are for STRUCTURE (flows, layouts, relationships); blocks are for DATA. If a domain block fits, use it instead of a sketch, a table of raw JSON, or prose.

Agent harness (Genome, Research, Deep work, Missions):
- Brand Genome: each channel has a persistent genome — voice, hooks, and visual traits with weights. Call dna_context for the channel BEFORE creative work (scripts, storyboards, titles) and follow it. When analytics or learnings show a shift, propose changes via dna_evolve — mutations queue for HUMAN approval (dna_pending_list); never assume a proposal was applied.
- Research: before paying for research_run, call research_fresh — runs are cached by question. When you use a report's findings, cite the run id and its sources.
- Deep work: for long multi-step jobs (audits, channel overhauls, batch creation), delegate via agent_run_task with a role + tier instead of grinding through many turns yourself. It returns a taskId immediately; follow up with agent_task_events to report progress and the final summary.
- Missions: a mission is a standing goal for a channel that the system advances on a cadence (mission_list / mission_get to inspect, mission_create/update/pause/resume to manage, mission_tick to force one orchestration step). Respect each mission's budget and approval policy.

Editor Studio — editing REAL footage by chat (Odysser model):
- You can import ANY video the user has and edit it conversationally. An imported clip becomes a normal item of kind:"ingested". When the conversation is about an ingested item, or the user asks to edit/cut/subtitle/grade/trim/reel a video they have, you are in EDITOR mode.
- Pipeline of editor tools (all in the registry): ingest_video (import a file as kind:"ingested"), editor_understand (watch it: transcript, shots, speakers, highlights, dead-air, filler, per-shot signals) → editor_understanding_get / ingest_status to read state, timeline_get (the frame-addressed tracks) + timeline_trim/razor/insert/overwrite to touch clips directly, auto_subtitle / creative_subtitle (burn captions), creative_montage (rebuild as a highlight reel/teaser), creative_edit_route (PROPOSE an EditPlan from a plain-language ask), creative_apply_plan (EXECUTE an approved plan), creative_edit (one-shot route+apply+render), render_hybrid (final mp4).
- ALWAYS understand before you propose. If item.understanding is missing (or you have not read it this turn), call editor_understand first, then editor_understanding_get — your proposal MUST cite what you actually saw (dead-air spans, filler hits, highlight moments, real clip ids), Odysser-style: "I watched it. It's 1m42s, 6 shots. There are two dead-air gaps (12.4-13.9s, 41s-43.2s) and three filler 'um's; the strongest 20s is the demo at 0:48. Here's what I'd do…". Never propose edits you cannot ground in the understanding/timeline.
- THE GATE — guided vs autonomous (this is sacred, like publish):
  · GUIDED (default): call creative_edit_route to produce a PROPOSED EditPlan, then STOP and present it for approval. Render the plan as approval cards (it surfaces as a readable card group with the ops, the evidence each cites, and Approve / Run buttons) and ask the user to confirm. Do NOT call creative_apply_plan or creative_edit until the user approves (an "Approve" / "Run it" / "yes do it on the plan you showed" counts). A vague "edit my video" is the trigger to PROPOSE, not to apply.
  · AUTONOMOUS: only when the user has explicitly opted in for THIS video ("just do it", "autonomous", "don't ask, run it", "edit it and render"). Then you may go straight to creative_edit (route+apply, add render:true if they want the final mp4) or creative_apply_plan. Still narrate what you did and present the result.
- Applying a plan that RENDERS is a long, detached job: creative_apply_plan/creative_edit with render:true return {status:"started", …} and a job id. Present it as a LIVE progress bar (pass the job id as jobId) and follow up — the same way you handle any render.
- FRAME-EXACT chat-to-edit (intent composers): for the common asks you also have thin intent tools that PROPOSE a frame-exact edit grounded in the real frame surface — edit_cut_dead_air ("cut the dead air"), edit_reel_key_moments ("make a 30s reel of the key moments"), edit_cut_on_beat ("cut on the beat / the drop"), edit_zoom_on_word ("zoom on <word>"). Each RETURNS A PROPOSAL ONLY (it reads frames/understanding/music/words, never mutates): present its summary + proposed ops + cited evidence as approval cards (scorecard of the ops, a callout of the summary, Approve / Run buttons), then APPLY only after the user confirms by calling the real frame tools it names (timeline_trim_clip_frame / timeline_split_clip_frame / creative_apply_plan / creative_montage), re-running timeline_frame_index after any mutate. The gate is the same as every edit — propose, wait, apply.
- After an edit lands, end with the item's post_card (the user's handle on it) and offer the obvious next steps as action buttons (Render final, Add subtitles, Make a teaser, Publish).
- Editing is gated by role exactly like creating: a viewer can be shown the understanding + a proposed plan but cannot apply or render. Surface the refusal plainly and offer to show the analysis instead.

Render fleet (devices):
- LIVE progress bars: when a render is still in flight, put the job's id as \`jobId\` (or the item id as \`itemId\`) on the progress block — the bar then polls and updates itself live until the render finishes, instead of being a frozen snapshot. Get the id from fleet_jobs.
- Videos render on a fleet of devices (e.g. the M4). When asked about "my devices", "what's rendering", render status/progress, or to ping a device, you CAN answer — never say you lack hardware access. Use fleet_devices (live list: status, capabilities, hardware, current job, last-seen), fleet_jobs (current + recent renders with a live PERCENT and phase like "chapter 3/7 · 65%"; pass active:true for only in-flight, or device:"m4" to filter), and fleet_ping (check a device is responsive). Prefer presenting these with ui_render (a stat_grid for the fleet, a table for jobs).
- Dynamic workflows: for multi-step fleet/ops work, compose tools yourself or use workflow_run (ordered, dependent steps) / team_run (parallel members) — e.g. ping every device, then report each one's status and current render in a table.

Ink sketches:
- You can hand-draw explanatory sketches inline in the chat. House style: single-stroke line drawings, stroke="currentColor", stroke-width="1.5", round caps and joins, fill="none" (or sparse 45° hachure lines for shading), with a slight hand-drawn wobble in the path data. The brand glyph is a four-pointed star with a small breakaway diamond spark. Use a viewBox around 0 0 320 200.
- Render a sketch by calling ui_render with a block {type:"sketch", svg:"<svg …>…</svg>", caption}. Allowed elements ONLY: svg, g, path, circle, ellipse, line, polyline, rect, text, use, defs, clipPath — anything else (script, image, foreignObject, animate, style, …) is stripped by the sanitizer, so don't use it.
- AT MOST ONE sketch per reply. Draw only when a drawing genuinely explains structure — a flow, a layout, a relationship, a plan. Never decorative, and never for numeric data (use stat_grid or table for numbers).
- Your blocks already speak this ink language by themselves: frames are hand-traced and draw themselves in, rows and cells cascade in, chart bars grow while their values count up, verdict dots get ink rings, today gets circled on calendars, and timeline stars stamp down the rail. So do NOT add decoration — and when you want to EMPHASIZE one key number or phrase, render an annotate block (ink circle/underline) instead of **bold** markdown.

Guiding the user through the app (ui_guide):
- You can point at the product itself: ui_guide navigates the user to a page and hand-sketches a marker around a real control, with a short handwritten margin note. Use it when the user asks WHERE something is or HOW to do something in the app, and after finishing work that lives on another page ("your plan is on the calendar" then guide them there).
- Single pointer: ui_guide {target:"nav:/connections", note:"Connections: your brand accounts live here"}. A target WITHOUT page marks the sidebar icon from wherever the user already is; add page to take them there first.
- Guided TOUR: for a multi-step "how do I…", pass steps (up to 6), each marking one control in order, e.g. ui_guide {steps:[{target:"nav:/calendar", page:"/calendar", note:"Open the calendar"},{target:"new-post", note:"Start a post from here"}]}. The overlay walks the user through them with Next controls.
- mark picks the ink style: circle (default, an icon or button), underline (a text row), arrow (point from the side), bracket (frame a region like the composer). Set spotlight:true to dim the page around the control on a busy screen.
- Notes are handwritten: plain words, NO em-dashes (use a colon or comma). At most ONE ui_guide per reply, AFTER your prose. It is a pointer, not an answer: it never replaces ui_render or the real work.

Paid boosts (ads_*):
- Lifecycle: draft → APPROVE (human) → launch. A draft never spends; only an approved boost can launch.
- ads_launch defaults to dryRun. NEVER pass dryRun:false unless the user has explicitly confirmed live spend in THIS conversation, after seeing the dry-run preview and the budget. No exceptions — a vague "yes do it" before the preview does not count.
- Present every dry-run result as a boost_preview block (budget, duration, gate reasons, planned calls) BEFORE asking for confirmation — the user must see what would spend and why it is or isn't blocked.
- Always surface gate.reasons plainly to the user — never bury or paraphrase away why a launch is blocked.
- Kill switch and spend caps live in ads_budget; use it to pause spending or adjust caps when asked.
- Brands connected via instagram_login cannot boost — tell the user to reconnect the brand via Facebook Login.`;

/* Appended only when iCog (CognitiveX) is configured, so the model is told about
   memory tools exactly when they're advertised in the manifest. */
const MEMORY_PROMPT = `

Persistent memory (iCog):
- You have a long-term memory that survives across sessions, backed by iCog. Tools: memory_recall (search past context), memory_remember (persist a durable fact), icog_talk (consult iCog for judgement), icog_reflect (your memory state — only when asked).
- Before asking the user for something they may have told you before (a preference, a brand detail, a past decision), call memory_recall first.
- After a meaningful decision, a stated preference, or a notable outcome, call memory_remember with a single self-contained fact. Do NOT store transient chatter or anything you can look up live via the pipeline tools.
- Keep memory use quiet and in service of the task — don't narrate every recall.`;

export type AgentContextInput = {
  itemId?: string;
  conceptId?: string;
  page?: string;
  [k: string]: unknown;
};

/* Multimodal content parts for a user turn carrying pasted/dropped images.
   The OpenAI-style `image_url` shape is what @langchain/openai forwards to
   OpenRouter (and on to Claude/Gemini); `url` is a data: URL for pasted images.
   Text-file attachments are folded into the text part upstream, so only image
   parts ride here. */
export type MultimodalPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export type AgentMessageInput = {
  role: "user" | "assistant" | "system";
  content: string | MultimodalPart[];
};

export type StreamAgentEvent =
  | { type: "token"; text: string }
  /* chain-of-thought delta on OpenRouter's SEPARATE reasoning channel (NOT the
     content stream) — accumulated client-side into the message's collapsible
     ReasoningTrace, never shown in the answer bubble. */
  | { type: "reasoning"; text: string }
  | { type: "tool_call"; id: string; name: string; args: unknown }
  | { type: "tool_result"; id: string; name: string; ok: boolean; result: unknown }
  | { type: "ui"; blocks: UIBlock[] }
  | { type: "guide"; guide: GuideSpec }
  | { type: "done" }
  | { type: "error"; message: string };

/* The public read-only demo advertises NO memory/iCog tools (see toOpenAITools),
   so don't tell the model about a memory it doesn't have here either. */
const DEMO_MODE = (process.env.AUTH_MODE ?? "").toLowerCase() === "demo";

function buildSystem(context?: AgentContextInput, tenant?: TenantContext): string {
  let base = SYSTEM_PROMPT + (!DEMO_MODE && isIcogConfigured() ? MEMORY_PROMPT : "");
  // Tell the model its tenancy so it understands its scope and limits. The model
  // only sees tools its role can use, but a plain explanation avoids confusing
  // "I can't do that" loops for viewers.
  if (tenant) {
    base += `\n\nWorkspace & role:
- You are acting inside one workspace (${tenant.workspaceId}) as the current user, whose role is "${tenant.role}". All data you read or change is scoped to THIS workspace — you cannot see or touch other workspaces.${
      tenant.role === "viewer"
        ? "\n- This user is a VIEWER: read-only. You can look things up and explain, but you cannot create, edit, publish, render, or change anything. If asked to act, say it requires a higher role and offer to show the relevant data instead."
        : ""
    }`;
  }
  const lines: string[] = [];
  if (context?.page) lines.push(`Current page: ${context.page}`);
  if (context?.itemId) lines.push(`Current item/video id: ${context.itemId}`);
  if (context?.conceptId) lines.push(`Current concept id: ${context.conceptId}`);
  if (!lines.length) return base;
  return `${base}\n\nContext:\n${lines.join("\n")}`;
}

/* Flatten any multimodal array to its text parts (assistant/system turns never
   carry images, and the LangChain AI/System messages want a plain string). */
function asText(content: string | MultimodalPart[]): string {
  if (typeof content === "string") return content;
  return content
    .filter((p): p is Extract<MultimodalPart, { type: "text" }> => p.type === "text")
    .map((p) => p.text)
    .join("\n");
}

function toLcMessage(m: AgentMessageInput): BaseMessage {
  if (m.role === "assistant") return new AIMessage(asText(m.content));
  if (m.role === "system") return new SystemMessage(asText(m.content));
  // A user turn may carry an array of {text}/{image_url} parts — LangChain's
  // ChatOpenAI converter turns that into OpenAI multimodal content that
  // OpenRouter forwards to the (vision-capable) model. Pass it straight through.
  return new HumanMessage(m.content as never);
}

async function buildGraph(model: string | undefined, signal?: AbortSignal, ctx?: AgentJobCtx) {
  const manifest = await getToolManifest();
  const kinds = kindMap(manifest);
  const tenant = tenantOrSystem(ctx?.tenant);
  // Only bind the tools this role can use (viewer -> read-only). dispatchTool
  // still gates every call as defense-in-depth.
  const tools = allowedTools(toOpenAITools(manifest), tenant, kinds);
  // Optionally ask OpenRouter for the model's chain-of-thought on its SEPARATE
  // reasoning channel by binding the `reasoning` param via bindTools' kwargs (the
  // call config we own here — NOT makeModel/openrouter.ts). LangChain folds these
  // kwargs into every request; OpenRouter receives {reasoning:{effort}} and
  // returns the CoT on chunk.additional_kwargs.reasoning(_details).
  //
  // OFF BY DEFAULT (gated behind COPILOT_REASONING): with deepseek-v4-flash,
  // opting into reasoning backfires — the CoT leaks into `content` (a bare
  // "thought" line) and the extra channel confuses the agent loop into
  // re-answering and never terminating. With it off, deepseek runs as a clean
  // chat/instruct model: no CoT channel, no leak, no interleave. chunkReasoning
  // stays wired so that IF this is ever enabled the CoT still routes to a
  // separate `reasoning` event (never into content); when off, the trace simply
  // shows the tool steps with no reasoning beats. Cast: the typed CallOptions
  // don't list `reasoning`, but the body passthrough does.
  const reasoningEnabled = /^(1|true|on|yes)$/i.test(process.env.COPILOT_REASONING ?? "");
  const reasoningKwargs = reasoningEnabled
    ? ({ reasoning: { effort: "low" } } as unknown as Parameters<
        ReturnType<typeof makeModel>["bindTools"]
      >[1])
    : undefined;
  const llm = makeModel({ model, streaming: true }).bindTools(tools, reasoningKwargs);

  // ctx passed to local orchestration tools so spawned children attach to the
  // correct tree node. depth defaults to 0 when running outside any job. tenant
  // scopes/gates every tool call; defaults to the system/default workspace.
  const toolCtx = {
    jobId: ctx?.jobId,
    rootId: ctx?.rootId,
    depth: ctx?.depth ?? 0,
    model,
    tenant,
  };

  const agentNode = async (state: typeof MessagesAnnotation.State) => {
    const response = await llm.invoke(state.messages);
    return { messages: [response] };
  };

  const toolsNode = async (state: typeof MessagesAnnotation.State) => {
    const last = state.messages[state.messages.length - 1] as AIMessage;
    const calls = last?.tool_calls ?? [];

    // Weak models routinely emit the SAME tool call several times in one turn
    // (the "Fleet devices ×3" bug). Dedupe by (name + canonical-JSON args):
    // run each UNIQUE call exactly once, then fan the single result out to every
    // duplicate tool_call_id so every entry the model emitted still gets a
    // matching ToolMessage (the API requires one per tool_call_id) and the model
    // stays consistent. This also cuts tool cost and stops triple chips.
    const canon = (args: unknown): string => {
      try {
        // stable key order so {a,b} and {b,a} collapse to one signature
        return JSON.stringify(args, Object.keys((args ?? {}) as object).sort());
      } catch {
        return String(args);
      }
    };
    const callId = (call: { id?: string; name: string }, i: number) => call.id ?? `${call.name}-${i}`;
    const firstIdxBySig = new Map<string, number>();
    const uniqueIdx: number[] = [];
    for (let i = 0; i < calls.length; i++) {
      const sig = `${calls[i].name} ${canon(calls[i].args)}`;
      if (firstIdxBySig.has(sig)) continue;
      firstIdxBySig.set(sig, i);
      uniqueIdx.push(i);
    }

    // Independent unique tool calls in one turn run concurrently; the
    // MessagesAnnotation reducer just appends, so order does not matter.
    const resultByIdx = new Map<number, string>();
    await Promise.all(
      uniqueIdx.map(async (i) => {
        const call = calls[i];
        try {
          const result = await dispatchTool(call.name, call.args ?? {}, toolCtx, signal, kinds);
          resultByIdx.set(i, JSON.stringify(result).slice(0, 100_000));
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          resultByIdx.set(i, JSON.stringify({ ok: false, error: message }));
        }
      }),
    );

    // One ToolMessage per ORIGINAL call (the API requires every tool_call_id be
    // answered), each carrying its unique call's shared result.
    const out = calls.map((call, i) => {
      const sig = `${call.name} ${canon(call.args)}`;
      const srcIdx = firstIdxBySig.get(sig) ?? i;
      return new ToolMessage({
        tool_call_id: callId(call, i),
        name: call.name,
        content: resultByIdx.get(srcIdx) ?? JSON.stringify({ ok: false, error: "no result" }),
      });
    });
    return { messages: out };
  };

  const routeAfterAgent = (state: typeof MessagesAnnotation.State) => {
    const last = state.messages[state.messages.length - 1] as AIMessage;
    if (last?.tool_calls && last.tool_calls.length > 0) return "tools";
    return END;
  };

  const graph = new StateGraph(MessagesAnnotation)
    .addNode("agent", agentNode)
    .addNode("tools", toolsNode)
    .addEdge(START, "agent")
    .addConditionalEdges("agent", routeAfterAgent, ["tools", END])
    .addEdge("tools", "agent")
    .compile();

  return graph;
}

/* Best-effort extraction of textual content from a message chunk. */
/* Some OpenRouter models (e.g. Gemma's harmony format) leak control tokens like
   `<|channel|>thought` / `<|message|>` into the visible stream. Strip them so the
   user never sees raw model scaffolding. Best-effort per chunk; the client also
   sanitizes the accumulated text as a backstop (tokens can split across chunks). */
export function stripModelTokens(s: string): string {
  return s.replace(
    /<\|?(channel|message|start|end|assistant|system|user|return|constrain)\|?>\s*(thought|analysis|final|commentary|to=\S+)?/gi,
    "",
  );
}

/* Best-effort extraction of a reasoning (chain-of-thought) delta from a message
   chunk. OpenRouter surfaces CoT on a channel LangChain folds into
   additional_kwargs — the exact key varies by provider/version, so we probe the
   known shapes: `reasoning` (string), `reasoning_content` (string), or
   `reasoning_details` (array of {text|content} parts, OpenRouter's structured
   form). Returns "" when the chunk carries no reasoning. */
function chunkReasoning(chunk: unknown): string {
  const ak = (chunk as { additional_kwargs?: Record<string, unknown> })?.additional_kwargs;
  if (!ak) return "";
  if (typeof ak.reasoning === "string") return ak.reasoning;
  if (typeof ak.reasoning_content === "string") return ak.reasoning_content as string;
  const details = ak.reasoning_details ?? ak.reasoning;
  if (Array.isArray(details)) {
    return details
      .map((p) => {
        if (typeof p === "string") return p;
        if (p && typeof p === "object") {
          const o = p as { text?: unknown; content?: unknown };
          if (typeof o.text === "string") return o.text;
          if (typeof o.content === "string") return o.content;
        }
        return "";
      })
      .join("");
  }
  return "";
}

function chunkText(chunk: unknown): string {
  if (!chunk) return "";
  const content = (chunk as { content?: unknown }).content;
  if (typeof content === "string") return stripModelTokens(content);
  if (Array.isArray(content)) {
    return stripModelTokens(
      content
        .map((part) => {
          if (typeof part === "string") return part;
          if (part && typeof part === "object" && "text" in part) return String((part as { text: unknown }).text ?? "");
          return "";
        })
        .join(""),
    );
  }
  return "";
}

export async function* streamAgent(input: {
  messages: AgentMessageInput[];
  context?: AgentContextInput;
  model?: string;
  signal?: AbortSignal;
  /* When set, LOCAL orchestration tools attach spawned children to this tree. */
  jobId?: string;
  ctx?: AgentJobCtx;
  /* The resolved tenant for this run — scopes every tool to one workspace and
     gates mutations by role. Resolved server-side (Clerk session / system); never
     from client input. Folded into ctx so child jobs inherit it. */
  tenant?: TenantContext;
}): AsyncGenerator<StreamAgentEvent> {
  // TERMINATION GUARANTEE: emit exactly one terminal `{type:"done"}` no matter
  // how this generator exits — normal end, max-steps, thrown error, or an early
  // return — so the client NEVER hangs on a perpetual spinner. We track whether
  // a terminal event (done OR error) has gone out and flush `done` in `finally`
  // if nothing terminal was emitted. `done` is idempotent client-side (a no-op),
  // and the SSE route's own finally closes the stream regardless.
  let terminated = false;
  try {
    const baseCtx: AgentJobCtx | undefined =
      input.ctx ?? (input.jobId ? { jobId: input.jobId, depth: 0 } : undefined);
    // The explicit tenant arg wins; otherwise use whatever ctx already carries.
    const ctx: AgentJobCtx | undefined =
      input.tenant || baseCtx
        ? { ...(baseCtx ?? { depth: 0 }), tenant: input.tenant ?? baseCtx?.tenant }
        : undefined;
    const tenant = tenantOrSystem(ctx?.tenant);
    const graph = await buildGraph(input.model, input.signal, ctx);

    const history: BaseMessage[] = [
      new SystemMessage(buildSystem(input.context, tenant)),
      ...input.messages.map(toLcMessage),
    ];

    const emittedToolCalls = new Set<string>();
    const emittedToolResults = new Set<string>();
    const emittedUiSigs = new Set<string>(); // dedupe identical ui block-groups (weak models double-call ui_render)
    // Per-turn dedupe of DUPLICATE tool calls (weak models emit "Fleet devices"
    // 3×). The tools node already collapses execution by (name+args); here we
    // make sure the CHIP for a duplicate call never streams a second time, so
    // the user sees one chip per unique call. Reset each agent step so the same
    // tool legitimately called again on a LATER round still shows.
    let emittedCallSigsStep = new Set<string>();
    let lastAgentStepKey = "";
    const callSig = (name: string, args: unknown): string => {
      try {
        return `${name} ${JSON.stringify(args, Object.keys((args ?? {}) as object).sort())}`;
      } catch {
        return `${name} ${String(args)}`;
      }
    };
    // Deterministic synthetic ids when a tool call/result has no stable id.
    // Both sides derive the SAME id from a per-name ordinal (`${name}#synth#N`),
    // so the i-th id-less call of a given name correlates with the i-th id-less
    // result of that name — otherwise the client's `t.id === frame.id` match
    // would drop the result and leave the chip stuck spinning.
    const synthCallOrdinal = new Map<string, number>();
    const synthResultOrdinal = new Map<string, number>();
    const nextSynthId = (name: string, counters: Map<string, number>): string => {
      const n = counters.get(name) ?? 0;
      counters.set(name, n + 1);
      return `${name}#synth#${n}`;
    };

    const stream = await graph.stream(
      { messages: history },
      {
        streamMode: ["messages", "updates"],
        recursionLimit: MAX_STEPS * 2 + 1,
        signal: input.signal,
      },
    );

    // Once the agent has streamed a FINAL textual answer with NO tool calls,
    // the turn is done. A weak model that loops back to "answer again" (the
    // duplicated-reply bug) would re-enter the agent node and stream a second,
    // reworded answer into the same bubble. Guard against it: after a content
    // run that was NOT followed by tool calls, suppress any further content
    // tokens so the same answer can't be emitted twice. Reset whenever tool
    // calls fire (a legitimate next round of work that earns a fresh answer).
    let sawContentThisRound = false;
    let finalAnswerEmitted = false;

    for await (const event of stream) {
      if (input.signal?.aborted) break;

      // streamMode arrays yield [mode, payload] tuples.
      const [mode, payload] = event as unknown as [string, unknown];

      if (mode === "messages") {
        // payload is [messageChunk, metadata]. ONLY stream real assistant
        // tokens (AIMessageChunk from the agent node) — never ToolMessage
        // content (which would dump raw tool-result JSON into the chat).
        const [msgChunk, meta] = payload as [unknown, { langgraph_node?: string } | undefined];
        if (msgChunk instanceof AIMessageChunk && meta?.langgraph_node !== "tools") {
          // Reasoning deltas arrive on the SEPARATE channel — emit them as
          // distinct events (the client routes them to the ReasoningTrace, not
          // the answer bubble) BEFORE any content tokens from the same chunk.
          const reasoning = chunkReasoning(msgChunk);
          if (reasoning) yield { type: "reasoning", text: reasoning };
          const text = chunkText(msgChunk);
          if (text) {
            // Don't re-emit content after a complete (no-tool-call) answer.
            if (finalAnswerEmitted) continue;
            sawContentThisRound = true;
            yield { type: "token", text };
          }
        }
        continue;
      }

      if (mode === "updates") {
        const updates = payload as Record<string, { messages?: BaseMessage[] }>;

        // Tool calls surface on the agent node's AIMessage.
        const agentMsgs = updates.agent?.messages ?? [];
        for (const m of agentMsgs) {
          // New agent step → reset the per-step duplicate-call filter (a tool
          // called again on a LATER round is legitimate and must show).
          const stepKey = (m as { id?: string })?.id ?? `step-${emittedToolCalls.size}`;
          if (stepKey !== lastAgentStepKey) {
            lastAgentStepKey = stepKey;
            emittedCallSigsStep = new Set<string>();
          }
          const calls = (m as AIMessage)?.tool_calls ?? [];
          // Duplicate-answer guard: an agent message with NO tool calls is a
          // FINAL textual answer — the graph routes it straight to END. Latch
          // finalAnswerEmitted so any further content tokens (a looped re-answer)
          // are dropped. An agent message WITH tool calls is a work round, not a
          // final answer, so clear the latch — the model has earned a fresh
          // answer after the tools run.
          if (calls.length > 0) {
            sawContentThisRound = false;
            finalAnswerEmitted = false;
          } else if (sawContentThisRound) {
            finalAnswerEmitted = true;
          }
          for (const call of calls) {
            // ui_render is presented as rendered blocks, not as a tool chip.
            // The blocks are emitted as a `ui` event from the tool RESULT below
            // (validated by the handler); skip the noisy call/result chip here.
            // ui_guide gets the same treatment: it surfaces as a `guide` event.
            if (isUiTool(call.name) || isGuideTool(call.name)) {
              if (call.id) emittedToolCalls.add(call.id);
              continue;
            }
            // Suppress the chip for a DUPLICATE call this step (same name+args):
            // the tools node already collapses execution, so a second chip would
            // be pure noise. Mark its id `emitted` so its (still-produced)
            // ToolMessage result is dropped below too, keeping chips/results
            // paired one-to-one.
            const sig = callSig(call.name, call.args ?? {});
            if (emittedCallSigsStep.has(sig)) {
              if (call.id) emittedToolCalls.add(call.id);
              continue;
            }
            emittedCallSigsStep.add(sig);
            if (call.id) {
              if (emittedToolCalls.has(call.id)) continue;
              emittedToolCalls.add(call.id);
              yield { type: "tool_call", id: call.id, name: call.name, args: call.args ?? {} };
            } else {
              // No stable id — derive a deterministic synthetic id from a
              // per-name ordinal so the matching result derives the same id.
              const id = nextSynthId(call.name, synthCallOrdinal);
              yield { type: "tool_call", id, name: call.name, args: call.args ?? {} };
            }
          }
        }

        // Tool results surface on the tools node's ToolMessages.
        const toolMsgs = updates.tools?.messages ?? [];
        for (const m of toolMsgs) {
          const tm = m as ToolMessage;
          let id: string;
          if (tm.tool_call_id) {
            if (emittedToolResults.has(tm.tool_call_id)) continue;
            emittedToolResults.add(tm.tool_call_id);
            id = tm.tool_call_id;
          } else {
            id = nextSynthId(tm.name ?? "tool", synthResultOrdinal);
          }
          let result: unknown = tm.content;
          let ok = true;
          if (typeof tm.content === "string") {
            try {
              result = JSON.parse(tm.content);
              if (result && typeof result === "object" && (result as { ok?: boolean }).ok === false) ok = false;
            } catch {
              result = tm.content;
            }
          }
          // ui_render: emit a `ui` event carrying the validated blocks instead of
          // a noisy tool_result chip. Re-validate defensively in case the result
          // shape was unexpected.
          if (isUiTool(tm.name ?? "")) {
            const blocks =
              result && typeof result === "object" && Array.isArray((result as { blocks?: unknown }).blocks)
                ? validateBlocks((result as { blocks: unknown }).blocks)
                : [];
            if (blocks.length) {
              const sig = JSON.stringify(blocks);
              if (!emittedUiSigs.has(sig)) {
                emittedUiSigs.add(sig);
                yield { type: "ui", blocks };
              }
            }
            continue;
          }
          // ui_guide: emit a `guide` event the client overlay acts on (navigate +
          // draw the ink circle). Re-validate defensively, mirroring ui_render.
          if (isGuideTool(tm.name ?? "")) {
            const raw = result && typeof result === "object" ? (result as { guide?: unknown }).guide : undefined;
            if (raw && typeof raw === "object") {
              const v = validateGuide(raw as Record<string, unknown>);
              if (v.ok) yield { type: "guide", guide: v.guide };
            }
            continue;
          }
          yield { type: "tool_result", id, name: tm.name ?? "tool", ok, result };
        }
      }
    }

    yield { type: "done" };
    terminated = true;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const name = e instanceof Error ? e.name : "";
    // Hitting the step cap is a clean stop, not an error.
    if (name === "GraphRecursionError" || /recursion limit/i.test(message)) {
      yield { type: "token", text: "\n\n(stopped after the maximum number of steps)" };
      yield { type: "done" };
      terminated = true;
      return;
    }
    yield { type: "error", message };
    terminated = true;
  } finally {
    // TERMINATION GUARANTEE: if no terminal event made it out (an early break on
    // abort, an unexpected return path, a throw during yield), flush `done` so
    // the client's stream state always clears and the composer never spins
    // forever. Harmless if a terminal event already went out — the client treats
    // `done` as idempotent.
    if (!terminated) yield { type: "done" };
  }
}
