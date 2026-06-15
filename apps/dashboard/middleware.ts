import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";

// The .ics feed must be fetchable without a session so external calendar apps
// (Google / Notion / Apple) can subscribe to it. It self-gates with an optional
// CALENDAR_ICS_TOKEN query param.
//
// Media routes (poster frames, scene thumbs, rendered video) are loaded as
// <img>/<video> sub-resources. Those requests don't carry Clerk's dev-browser
// handshake (and <video> range requests omit credentials), so gating them makes
// every thumbnail and preview render as a broken image. They serve only
// non-sensitive poster frames / renders keyed by id, so they're public.
const isPublicRoute = createRouteMatcher([
  "/sign-in(.*)",
  "/sign-up(.*)",
  "/api/calendar/ics(.*)",
  "/dev/blocks", // dev-only visual harness, no data access (hardcoded sample payloads)
  "/dev/search", // dev-only HyperSearch palette harness, stubbed SSE, no data access
  "/api/thumb(.*)",
  "/api/scenethumb(.*)",
  "/api/video(.*)",
]);

const authMode = (process.env.AUTH_MODE ?? "").toLowerCase();
const localAuth = authMode === "local";
// Public demo: no Clerk gate; currentContext() pins every request to a read-only
// viewer in the demo workspace, the agent route is canned (no LLM spend), and the
// engine tool runner refuses non-read tools.
const demoAuth = authMode === "demo";

export default clerkMiddleware(async (auth, request) => {
  if (localAuth || demoAuth) return; // self-host local OR public demo: no Clerk gate
  if (!isPublicRoute(request)) {
    await auth.protect();
  }
});

export const config = {
  matcher: [
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
    "/__clerk/:path*",
  ],
};
