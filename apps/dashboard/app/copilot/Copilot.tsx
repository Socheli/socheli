"use client";
import { useEffect, useMemo, useState } from "react";
import { usePathname } from "next/navigation";
import { X, MessageSquare, ListTree, Maximize2, Minimize2 } from "lucide-react";
import { InkPenIcon } from "../../components/sketch";
import { SoliMark } from "./SoliMark";
import { useAgent, type AgentContext } from "./useAgent";
import { ChatCore, useTenantHint } from "./ChatCore";
import { ThreadsMenu } from "./Threads";
import { useJobs } from "./useJobs";
import { Tasks } from "./Tasks";

/* Slide-in right-docked copilot, available on every dashboard page EXCEPT the
   home route. A floating toggle (bottom-right) opens a fixed overlay panel that
   does NOT shove page layout, so it never collides with the editor's own right
   dock. Cmd/Ctrl+K toggles it (the editor binds bare keys incl. 'j', so a
   modifier+K combo avoids any collision with the editor shortcuts).
   The chat body itself is ChatCore (shared with the /soli full page); both
   surfaces read the same useAgent store, so they show the same conversation —
   which is exactly why the panel is suppressed on "/": home IS Soli, and the
   panel would just double the very conversation already filling the page. On
   home the persisted `open` flag is force-closed on entry, Cmd+K and the
   soli:open event are rerouted to focus the home composer, and neither the
   toggle nor the panel renders at all. */

const EXAMPLES = [
  "Show this week's calendar",
  "Score my latest post",
  "How did the channel perform this month?",
  "What's rendering right now?",
];

/* Read-only suggestions for viewers — never propose an action they can't take. */
const READONLY_EXAMPLES = [
  "List my concepts",
  "Show this week's analytics",
  "Summarize my latest videos",
];

function deriveContext(pathname: string): AgentContext {
  const ctx: AgentContext = { page: pathname };
  // /post/<id> and /post/<id>/edit -> itemId
  const m = pathname.match(/^\/post\/([^/]+)/);
  if (m) ctx.itemId = m[1];
  return ctx;
}

export function Copilot() {
  const pathname = usePathname() || "/";
  const onHome = pathname === "/";
  const { role, workspaceId, orgId, canAct } = useTenantHint();

  const context = useMemo<AgentContext>(
    () => ({ ...deriveContext(pathname), orgId, workspaceId, role }),
    [pathname, orgId, workspaceId, role],
  );
  const {
    messages, status, open, setOpen, send, editMessage, stop, clear,
    threads, activeThreadId, newThread, switchThread, deleteThread,
  } = useAgent(context);
  const [tab, setTab] = useState<"chat" | "tasks">("chat");
  const [maximized, setMaximized] = useState(false);
  // Poll the job tree whenever the panel is open so the queue badge stays live
  // on both tabs; Tasks consumes the same hook instance (no double-polling).
  const jobsApi = useJobs(open);

  // Home IS the conversation — force the (persisted) panel shut the moment the
  // home route mounts so the side panel and the page never double the same
  // transcript. The panel keeps its persisted state on every other route.
  useEffect(() => {
    if (onHome) setOpen(false);
  }, [onHome, setOpen]);

  // Cmd/Ctrl+K toggles the panel from anywhere; the header's "Ask Soli" button
  // opens it via a soli:open custom event. On home both are rerouted: instead
  // of opening a second view of the same store, they focus the page composer.
  useEffect(() => {
    const focusHomeComposer = () =>
      document.querySelector<HTMLTextAreaElement>(".soli-page .cp-textarea")?.focus();
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        if (onHome) { focusHomeComposer(); return; }
        setOpen((v) => !v);
      }
    };
    const onOpen = () => {
      if (onHome) { focusHomeComposer(); return; }
      setOpen(true);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("soli:open", onOpen);
    return () => { window.removeEventListener("keydown", onKey); window.removeEventListener("soli:open", onOpen); };
  }, [setOpen, onHome]);

  // Push (squeeze) the page content over while the panel is open, instead of
  // overlaying it. A body class drives a transition on the app content.
  useEffect(() => {
    document.body.classList.toggle("cp-pushed", open);
    document.body.classList.toggle("cp-max", open && maximized);
    return () => { document.body.classList.remove("cp-pushed", "cp-max"); };
  }, [open, maximized]);

  // Never surface the copilot on the standalone auth pages, and never on home —
  // the full-page Soli chat owns that route (toggle AND panel stay unmounted).
  if (onHome || pathname.startsWith("/sign-in") || pathname.startsWith("/sign-up")) return null;

  return (
    <>
      {!open && (
        <button
          className="cp-toggle"
          onClick={() => setOpen(true)}
          aria-label="Open Soli (Cmd+K)"
          title="Soli (Cmd/Ctrl+K)"
          type="button"
        >
          <SoliMark size={20} />
          {jobsApi.runningCount > 0 && (
            <span className="cp-toggle-badge" aria-label={`${jobsApi.runningCount} running`}>
              {jobsApi.runningCount}
            </span>
          )}
        </button>
      )}

      <aside className={`cp-panel${open ? " open" : ""}`} aria-hidden={!open}>
        <header className="cp-head">
          <div className="cp-head-title">
            <SoliMark size={16} className="cp-head-spark" />
            <span>Soli</span>
          </div>
          <div className="cp-tabs" role="tablist" aria-label="Copilot views">
            <button
              className={`cp-tab${tab === "chat" ? " on" : ""}`}
              type="button"
              role="tab"
              aria-selected={tab === "chat"}
              onClick={() => setTab("chat")}
            >
              <MessageSquare size={13} />
              <span>Chat</span>
            </button>
            <button
              className={`cp-tab${tab === "tasks" ? " on" : ""}`}
              type="button"
              role="tab"
              aria-selected={tab === "tasks"}
              onClick={() => setTab("tasks")}
            >
              <ListTree size={13} />
              <span>Tasks</span>
              {jobsApi.runningCount > 0 && <span className="cp-tab-badge">{jobsApi.runningCount}</span>}
            </button>
          </div>
          <div className="cp-head-actions">
            {tab === "chat" && (
              <>
                <ThreadsMenu
                  threads={threads}
                  activeId={activeThreadId}
                  onNew={newThread}
                  onSwitch={switchThread}
                  onDelete={deleteThread}
                />
                <button
                  className="cp-icon-btn"
                  onClick={clear}
                  title="New conversation (history kept)"
                  aria-label="New conversation"
                  type="button"
                  disabled={messages.length === 0}
                >
                  <InkPenIcon size={15} />
                </button>
              </>
            )}
            <button
              className="cp-icon-btn"
              onClick={() => setMaximized((v) => !v)}
              title={maximized ? "Restore" : "Maximize"}
              aria-label={maximized ? "Restore Soli" : "Maximize Soli"}
              type="button"
            >
              {maximized ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
            </button>
            <button
              className="cp-icon-btn"
              onClick={() => setOpen(false)}
              title="Close (Cmd/Ctrl+K)"
              aria-label="Close Soli"
              type="button"
            >
              <X size={16} />
            </button>
          </div>
        </header>

        {tab === "tasks" ? (
          <Tasks api={jobsApi} />
        ) : (
          <ChatCore
            messages={messages}
            status={status}
            send={send}
            editMessage={editMessage}
            stop={stop}
            canAct={canAct}
            role={role}
            examples={canAct ? EXAMPLES : READONLY_EXAMPLES}
            active={open}
          />
        )}
      </aside>
    </>
  );
}

export default Copilot;
