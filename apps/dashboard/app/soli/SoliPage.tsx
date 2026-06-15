"use client";
import { useEffect, useMemo, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { SparkMark, InkDivider, InkDraw, InkIcon, InkPenIcon } from "../../components/sketch";
import { useAgent, type AgentContext } from "../copilot/useAgent";
import { ChatCore, useTenantHint } from "../copilot/ChatCore";
import { ModelPicker } from "./ModelPicker";

/* Soli's full-page chat — mounted at / (the home: Soli IS the primary
   interface) and reachable via the old /soli, which redirects here. Everything
   that matters is reused from the copilot: ChatCore renders the
   list/bubbles/UI-blocks/composer, useAgent is the shared module store (so
   this page and the Cmd+K panel show the SAME conversation, live), and sends
   go through the same /api/agent route with the same tenant hints — gating is
   identical. Page-specific bits are only the hero empty state, the optional
   server-fed `statusStrip` (the home command-center chips), the page chrome,
   and the .soli-/.thr- CSS overrides (bigger type, more room for sketches and
   blocks). Conversation history lives ONLY in the app sidebar now — this page
   carries no rail of its own. */

/* Example prompts drawn from real registry capabilities: the planner
   (plan/calendar tools), boosts (/ads), Soli's hand-drawn sketches, and the
   community inbox. */
const EXAMPLES = [
  "Research coffee, then generate a YouTube video about it on the cuda device",
  "Show this week's calendar",
  "Score my latest post",
  "What's rendering right now?",
];

/* Read-only suggestions for viewers — never propose an action they can't take. */
const READONLY_EXAMPLES = [
  "Show this week's analytics",
  "What's scheduled on the calendar?",
  "Sketch how the content pipeline works",
  "Summarize my latest videos",
];


export function SoliPage({ statusStrip }: { statusStrip?: ReactNode } = {}) {
  const { role, workspaceId, orgId, canAct } = useTenantHint();
  const pathname = usePathname() || "/soli";

  const context = useMemo<AgentContext>(
    () => ({ page: pathname, orgId, workspaceId, role }),
    [pathname, orgId, workspaceId, role],
  );
  const { messages, status, send, editMessage, stop, clear, switchThread } = useAgent(context);
  const examples = canAct ? EXAMPLES : READONLY_EXAMPLES;

  // Conversation history lives in the MAIN app sidebar (inline, folder/pin
  // aware) — this page no longer carries its own duplicate rail.

  // Deep-link: hyper-search opens a chat hit at "/?thread=<id>". Activate it
  // once on mount, then strip the param so a refresh doesn't re-pin it.
  useEffect(() => {
    try {
      const url = new URL(window.location.href);
      const tid = url.searchParams.get("thread");
      if (tid) {
        switchThread(tid);
        url.searchParams.delete("thread");
        window.history.replaceState(null, "", url.pathname + url.search + url.hash);
      }
    } catch { /* non-fatal */ }
  }, [switchThread]);

  // On the home route the page itself IS the conversation. Copilot.tsx now
  // suppresses the side panel entirely on "/" (force-closes the persisted open
  // state and reroutes Cmd+K / soli:open to focus this page's composer). The
  // body class remains for the `.home-` CSS block — it still hides the
  // header's "Ask Soli" affordance while / is mounted.
  useEffect(() => {
    if (pathname !== "/") return;
    document.body.classList.add("home-soli");
    return () => document.body.classList.remove("home-soli");
  }, [pathname]);

  return (
    <div className="soli-page">
      <div className="soli-head">
        <SparkMark size={22} className="soli-head-mark" />
        <span className="soli-head-name">Soli</span>
        <span className="soli-head-tag">social media manager</span>
        <span className="soli-head-spacer" />
        <ModelPicker canEdit={canAct} />
        <button
          className="cp-icon-btn soli-head-clear"
          onClick={clear}
          title="New conversation"
          aria-label="New conversation"
          type="button"
          disabled={messages.length === 0}
        >
          <InkPenIcon size={15} />
        </button>
      </div>
      <div className="soli-rule">
        <InkDivider />
      </div>

      {statusStrip}

      <div className="thr-body">
        <div className="soli-chat">
          <ChatCore
            messages={messages}
            status={status}
            send={send}
            editMessage={editMessage}
            stop={stop}
            canAct={canAct}
            role={role}
            examples={examples}
            autoFocus
            empty={
              <div className="soli-hero">
                <InkDraw durationMs={1100} className="soli-hero-mark">
                  <InkIcon name="star-rough" size={64} />
                </InkDraw>
                <h1 className="soli-hero-title">Soli, your social media manager</h1>
                <p className="soli-hero-sub">
                  Plans your calendar, drafts and renders posts, runs verified research,
                  watches the inbox, across every brand in this workspace.
                </p>
                <div className="soli-hero-rule">
                  <InkDivider withStar />
                </div>
                <div className="soli-hero-chips">
                  {examples.map((ex) => (
                    <button
                      key={ex}
                      className="soli-chip"
                      type="button"
                      onClick={() => void send(ex)}
                    >
                      {ex}
                    </button>
                  ))}
                </div>
              </div>
            }
          />
        </div>
      </div>
    </div>
  );
}

export default SoliPage;
