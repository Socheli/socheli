import type { OpenAITool } from "./tools";

/* Shared, SAFE spec for Soli's GUIDE tool — `ui_guide` lets the agent point AT
   the product itself: navigate the user to a page and hand-sketch a marker
   (ink circle, underline, arrow, or corner-brackets) around a real control,
   with a short handwritten margin note. It can do this as a single pointer
   ("Connections lives here") or as a multi-step guided TOUR ("first open the
   calendar, then click the post, then hit publish") — the overlay walks the
   user through each step. An optional spotlight dims the rest of the page so
   the marked control pops on a busy screen.

   The client overlay (app/GuideOverlay.tsx) performs the navigation and draws
   the marks; this module only declares + validates. Like ui-spec, it is
   imported by BOTH the server (tool registration, graph special-casing) and the
   client (overlay + chat chip), so it must stay free of any server-only or
   component imports.

   Targets are a CLOSED registry mapped to `data-guide` attributes stamped on
   the chrome (Sidebar links, the New-post CTA, the Soli composer, the history
   toggle). The model can only point at things we deliberately made pointable. */

export type GuideArea = "sidebar" | "chat";
export type GuideMark = "circle" | "underline" | "arrow" | "bracket";

export type GuideTargetDef = {
  /* Human label, used in the chat chip ("Showing you: Calendar"). */
  label: string;
  /* Where the control lives. Sidebar targets are visible on every page; chat
     targets only exist on the Soli home, so guiding to them implies page "/". */
  area: GuideArea;
  /* The page this target navigates to when clicked (nav links) — used in the
     tool description so the model picks the right one. */
  opens?: string;
};

/* Sidebar nav targets mirror app/nav.tsx hrefs as `nav:<href>`. Keep the two
   in sync when adding a route (the guide silently no-ops on a stale target —
   never breaks). */
export const GUIDE_TARGETS: Readonly<Record<string, GuideTargetDef>> = {
  "new-post": { label: "New post", area: "sidebar", opens: "/new" },
  "nav:/": { label: "Soli", area: "sidebar", opens: "/" },
  "nav:/war-room": { label: "War Room", area: "sidebar", opens: "/war-room" },
  "nav:/concepts": { label: "Concept Board", area: "sidebar", opens: "/concepts" },
  "nav:/creative-lab": { label: "Creative Lab", area: "sidebar", opens: "/creative-lab" },
  "nav:/plan": { label: "Algo Lab", area: "sidebar", opens: "/plan" },
  "nav:/research": { label: "Research", area: "sidebar", opens: "/research" },
  "nav:/queue": { label: "Production Queue", area: "sidebar", opens: "/queue" },
  "nav:/calendar": { label: "Calendar", area: "sidebar", opens: "/calendar" },
  "nav:/autopilot": { label: "Autopilot", area: "sidebar", opens: "/autopilot" },
  "nav:/missions": { label: "Missions", area: "sidebar", opens: "/missions" },
  "nav:/library": { label: "Library", area: "sidebar", opens: "/library" },
  "nav:/analytics": { label: "Analytics", area: "sidebar", opens: "/analytics" },
  "nav:/ads": { label: "Boosts", area: "sidebar", opens: "/ads" },
  "nav:/usage": { label: "Usage", area: "sidebar", opens: "/usage" },
  "nav:/inbox": { label: "Inbox", area: "sidebar", opens: "/inbox" },
  "nav:/ai-dm": { label: "AI DM", area: "sidebar", opens: "/ai-dm" },
  "nav:/connections": { label: "Connections", area: "sidebar", opens: "/connections" },
  "nav:/admin": { label: "Admin", area: "sidebar", opens: "/admin" },
  "nav:/calendar-admin": { label: "Calendar Admin", area: "sidebar", opens: "/calendar-admin" },
  "nav:/channels": { label: "Brands", area: "sidebar", opens: "/channels" },
  "nav:/devices": { label: "Devices", area: "sidebar", opens: "/devices" },
  "nav:/settings": { label: "Settings", area: "sidebar", opens: "/settings" },
  "nav:/docs": { label: "Docs", area: "sidebar", opens: "/docs" },
  composer: { label: "the Ask-Soli composer", area: "chat" },
  history: { label: "conversation history", area: "chat" },
};

/* Pages the tool may navigate to: every nav destination plus /post/<id> detail
   pages (the only parameterized route Soli routinely sends people to). */
const GUIDE_PAGES: ReadonlySet<string> = new Set(
  Object.values(GUIDE_TARGETS)
    .map((t) => t.opens)
    .filter((p): p is string => !!p),
);
const POST_PAGE = /^\/post\/[A-Za-z0-9_-]{1,80}$/;

const MARKS: ReadonlySet<string> = new Set<GuideMark>(["circle", "underline", "arrow", "bracket"]);
const MAX_NOTE = 140;
const MAX_STEPS = 6;

/* One step of a guide: navigate (optional), then mark a control with a note. */
export type GuideStep = {
  target?: string;
  /* Resolved human label for the step. */
  label: string;
  page?: string;
  note?: string;
  mark: GuideMark;
};

export type GuideSpec = {
  /* Short title for the chat chip — the first step's label, plus a count when
     it is a multi-step tour. */
  title: string;
  steps: GuideStep[];
  /* Dim the rest of the page around the marked control. */
  spotlight?: boolean;
};

function validateStep(raw: Record<string, unknown>): { ok: true; step: GuideStep } | { ok: false; error: string } {
  const rawTarget = typeof raw.target === "string" ? raw.target.trim() : "";
  const rawPage = typeof raw.page === "string" ? raw.page.trim() : "";
  const rawNote = typeof raw.note === "string" ? raw.note.trim() : "";
  const rawMark = typeof raw.mark === "string" ? raw.mark.trim() : "";

  const target = rawTarget && GUIDE_TARGETS[rawTarget] ? rawTarget : undefined;
  if (rawTarget && !target) {
    return { ok: false, error: `unknown guide target "${rawTarget}" — valid: ${Object.keys(GUIDE_TARGETS).join(", ")}` };
  }

  let page = rawPage && (GUIDE_PAGES.has(rawPage) || POST_PAGE.test(rawPage)) ? rawPage : undefined;
  if (rawPage && !page) {
    return { ok: false, error: `unknown page "${rawPage}" — valid: ${[...GUIDE_PAGES].join(", ")} or /post/<id>` };
  }
  // Chat targets only exist on the Soli home — imply the navigation.
  if (target && GUIDE_TARGETS[target].area === "chat" && !page) page = "/";

  if (!target && !page) return { ok: false, error: "each guide step needs a target and/or a page" };

  const mark: GuideMark = MARKS.has(rawMark) ? (rawMark as GuideMark) : "circle";
  const label = target ? GUIDE_TARGETS[target].label : (page as string);
  const note = rawNote ? rawNote.slice(0, MAX_NOTE) : undefined;
  return { ok: true, step: { target, label, page, note, mark } };
}

export function validateGuide(args: Record<string, unknown>): { ok: true; guide: GuideSpec } | { ok: false; error: string } {
  // Tour form: an explicit `steps` array. Single form: top-level target/page/note/mark.
  const rawSteps = Array.isArray(args.steps) ? args.steps : null;
  const stepInputs: Record<string, unknown>[] = rawSteps
    ? rawSteps.slice(0, MAX_STEPS).filter((s): s is Record<string, unknown> => !!s && typeof s === "object")
    : [{ target: args.target, page: args.page, note: args.note, mark: args.mark }];

  const steps: GuideStep[] = [];
  let lastError = "";
  for (const si of stepInputs) {
    const v = validateStep(si);
    if (v.ok) steps.push(v.step);
    else lastError = v.error;
  }
  if (!steps.length) return { ok: false, error: lastError || "ui_guide needs at least one step with a target and/or page" };

  const title = steps.length > 1 ? `${steps[0].label} +${steps.length - 1} more` : steps[0].label;
  const spotlight = args.spotlight === true || args.spotlight === "true";
  return { ok: true, guide: { title, steps, spotlight: spotlight || undefined } };
}

export function isGuideTool(name: string): boolean {
  return name === "ui_guide";
}

export const GUIDE_TOOL: OpenAITool = {
  type: "function",
  function: {
    name: "ui_guide",
    description:
      "GUIDE the user through the product itself: navigate them to a page and hand-draw a marker around a real on-screen control, with a short handwritten note. Use it whenever the user asks WHERE something is, HOW to do something in the app, or after you finish work that lives on another page ('your plan is on the calendar' then guide them there). TWO forms: (1) a single pointer, with top-level `target`/`page`/`note`/`mark`; (2) a multi-step TOUR, with `steps`: an array of up to 6 {target, page?, note?, mark?} objects that walks the user through a flow one control at a time ('first open the calendar, then pick the post, then hit publish'). `target` ids: sidebar nav icons are `nav:<route>` (nav:/calendar, nav:/analytics, nav:/connections, nav:/channels, etc), `new-post` is the New-post button, `composer` is the Ask-Soli box, `history` is the conversation-history toggle. `page` navigates to that route first (any sidebar route, or /post/<id>); pass a target WITHOUT page to point at the sidebar icon from wherever the user already is. `mark` chooses the ink style: `circle` (default, best for an icon or button), `underline` (a text label or menu row), `arrow` (point at something from the side), `bracket` (corner-brackets framing a whole region like the composer or a card). `note` is a short handwritten margin note (max 140 chars) — write it in plain words with NO em-dashes (use a colon or comma). Set `spotlight: true` to dim the rest of the page so the marked control stands out on a busy screen. Call ui_guide at most once per reply, AFTER your prose. It is a pointer, not an answer: it never replaces ui_render or the real work.",
    parameters: {
      type: "object",
      properties: {
        target: { type: "string", enum: Object.keys(GUIDE_TARGETS), description: "Single-pointer: the control to mark." },
        page: { type: "string", description: "Single-pointer: route to navigate to first, e.g. /calendar or /post/<id>." },
        note: { type: "string", description: "Single-pointer: short handwritten note beside the mark (max 140 chars, no em-dashes)." },
        mark: { type: "string", enum: ["circle", "underline", "arrow", "bracket"], description: "Single-pointer: ink style (default circle)." },
        steps: {
          type: "array",
          description: "Multi-step tour: up to 6 ordered steps, each marking one control.",
          items: {
            type: "object",
            properties: {
              target: { type: "string", enum: Object.keys(GUIDE_TARGETS), description: "Control to mark in this step." },
              page: { type: "string", description: "Route to navigate to for this step." },
              note: { type: "string", description: "Handwritten note for this step (max 140 chars, no em-dashes)." },
              mark: { type: "string", enum: ["circle", "underline", "arrow", "bracket"], description: "Ink style for this step." },
            },
          },
        },
        spotlight: { type: "boolean", description: "Dim the rest of the page around the marked control." },
      },
    },
  },
};

export function guideToolHandler(args: Record<string, unknown>): { ok: boolean; guide?: GuideSpec; error?: string } {
  const v = validateGuide(args);
  return v.ok ? { ok: true, guide: v.guide } : { ok: false, error: v.error };
}
