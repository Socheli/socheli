"use client";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useAuth, useOrganization } from "@clerk/nextjs";
import { appRoleFromClerk, workspaceIdFor, roleAtLeast, ROLE_LABEL, type Role } from "@os/schemas";
import { InkSendIcon, InkStopIcon } from "../../components/sketch";
import { SoliMark } from "./SoliMark";
import type { AgentStatus, ChatMessage } from "./useAgent";
import { MessageBubble } from "./parts";
import { filterCommands, InkPlusIcon, type SlashCommand } from "./composer/commands";
import { SlashPalette } from "./composer/SlashPalette";
import {
  buildContextOptions,
  ContextPicker,
  ContextGroupMark,
  type ContextFetchState,
  type ContextOption,
} from "./composer/ContextPicker";

/* The copilot's chat core — message list (with empty state), streaming bubbles
   and the composer — extracted from Copilot.tsx so the SAME machinery renders
   in two surfaces: the Cmd+K right panel ("panel") and the /soli full page
   ("page"). It is purely presentational over a useAgent instance; the page
   restyles it by scoping CSS overrides under .soli-chat, so the panel's cp-*
   markup stays byte-for-byte what it was. */

/* Client-side view of the caller's tenant + role. This is a HINT for the UI and
   is sent alongside the message; the /api/agent route re-resolves the
   authoritative role server-side, so a tampered value can never grant access.
   Mirror settings' memberAppRole: blend the Clerk role with the app override +
   pinned owner kept in the org's publicMetadata (so viewer/owner grades show). */
export function useTenantHint() {
  const { userId, orgId } = useAuth();
  const { organization, membership } = useOrganization();

  const role: Role = useMemo(() => {
    if (!orgId) return appRoleFromClerk({ personal: true });
    const meta = (organization?.publicMetadata ?? {}) as {
      roles?: Record<string, string>;
      owner?: string;
    };
    return appRoleFromClerk({
      clerkRole: membership?.role ?? null,
      isCreator: !!userId && !!meta.owner && meta.owner === userId,
      override: userId ? meta.roles?.[userId] : undefined,
    });
  }, [orgId, userId, organization?.publicMetadata, membership?.role]);

  const workspaceId = useMemo(
    () => workspaceIdFor({ orgId: orgId ?? null, userId: userId ?? null }),
    [orgId, userId],
  );

  // A viewer is read-only: Soli can answer and show data, but the composer is
  // disabled so we don't invite actions that the server will refuse anyway.
  const canAct = roleAtLeast(role, "member");

  return { role, workspaceId, orgId: orgId ?? null, canAct } as const;
}

/* Hand-drawn mic — single-stroke ink in the house sketch style (see
   components/sketch/InkIcon): currentColor, 1.5 stroke, round caps, a little
   wobble in every line. pathLength=1 + .ink-drawable makes it draw itself in
   on first render (the same grammar SafeSketch stamps on Soli's sketches). */
function InkMicIcon() {
  return (
    <svg
      className="ink-drawable"
      viewBox="0 0 24 24"
      width={16}
      height={16}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {/* capsule */}
      <path
        pathLength={1}
        d="M12.05 3.1 C13.7 3.05 14.95 4.3 15 5.95 L15.05 10.9 C15.05 12.65 13.75 13.95 12.1 14 C10.35 14.05 9.05 12.8 9 11.05 L8.95 6.1 C8.95 4.4 10.3 3.15 12.05 3.1 Z"
      />
      {/* cradle */}
      <path pathLength={1} d="M5.9 10.2 C6.15 13.85 8.7 16.3 12.05 16.3 C15.35 16.3 17.85 13.8 18.1 10.05" />
      {/* stem + base */}
      <path pathLength={1} d="M12.1 16.6 L11.95 20.1" />
      <path pathLength={1} d="M9.05 20.95 C11 20.85 13 20.9 14.95 21.05" />
    </svg>
  );
}

/* data: URL -> bare base64 payload. */
function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("could not read recording"));
    reader.onload = () => {
      const s = String(reader.result || "");
      resolve(s.slice(s.indexOf(",") + 1));
    };
    reader.readAsDataURL(blob);
  });
}

/* Client-side guard matching the server's ~2.5MB cap. */
const MAX_AUDIO_BYTES = 2.5 * 1024 * 1024;
/* Hard stop so a forgotten mic can't record forever (also keeps us under cap). */
const MAX_RECORD_MS = 60_000;

type MicState = "idle" | "recording" | "transcribing";

/* ── Composer tool overlays ──────────────────────────────────────────────
   Two popovers float above the composer: the "/" command palette and the
   "@"/+ context picker. `start` is where the trigger token begins in the
   draft (so picking replaces it); a null start means the picker was opened
   by the + button and the pick inserts at the caret instead. */
type Overlay =
  | { kind: "slash"; start: number; query: string }
  | { kind: "context"; start: number | null; query: string };

/* The trigger token under the caret, if any: "/" or "@" at the start of the
   draft or after whitespace, with the partial query typed so far. Typing a
   space ends the token and the overlay folds away. */
function detectTrigger(value: string, caret: number): Overlay | null {
  const before = value.slice(0, caret);
  const slash = /(^|\s)\/([a-z]*)$/i.exec(before);
  if (slash) return { kind: "slash", start: caret - slash[2].length - 1, query: slash[2].toLowerCase() };
  const at = /(^|\s)@([\w:-]*)$/.exec(before);
  if (at) return { kind: "context", start: caret - at[2].length - 1, query: at[2].toLowerCase() };
  return null;
}

type ContextData = {
  items: { id: string; topic: string; status: string }[];
  channels: { id: string; name: string }[];
};

export function ChatCore({
  messages,
  status,
  send,
  editMessage,
  stop,
  canAct,
  role,
  examples,
  empty,
  active = true,
  autoFocus = false,
}: {
  messages: ChatMessage[];
  status: AgentStatus;
  send: (text: string) => void | Promise<void>;
  /* Edit a prior user turn: truncate the thread there and re-send the new text. */
  editMessage?: (id: string, text: string) => void;
  stop: () => void;
  canAct: boolean;
  role: Role;
  /* Empty-state example prompts (already filtered for the caller's role). */
  examples: string[];
  /* Optional surface-specific empty state (the /soli hero); when omitted the
     panel's compact "Ask Soli" block renders. */
  empty?: ReactNode;
  /* Whether this surface is currently visible/usable. Drives auto-scroll and
     the focus-on-open behavior (the panel passes its `open` flag). */
  active?: boolean;
  /* Focus the composer on mount (the page wants this; the panel only focuses
     on the closed -> open transition, exactly as before the extraction). */
  autoFocus?: boolean;
}) {
  const [draft, setDraft] = useState("");
  const listRef = useRef<HTMLDivElement | null>(null);
  const taRef = useRef<HTMLTextAreaElement | null>(null);

  // Voice transcribe (mic button). The recorder lives in refs — only the
  // tri-state + the quiet inline note are render state.
  const [mic, setMic] = useState<MicState>("idle");
  const [micNote, setMicNote] = useState<string | null>(null);
  const recRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const micTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Composer tool overlays (slash palette / context picker). The active index
  // is shared — only one overlay shows at a time. pendingCaret repositions the
  // caret after a template/token insert (applied in the draft effect below).
  const [overlay, setOverlay] = useState<Overlay | null>(null);
  const [activeIdx, setActiveIdx] = useState(0);
  const [ctxData, setCtxData] = useState<ContextData | null>(null);
  const [ctxState, setCtxState] = useState<ContextFetchState>("idle");
  const pendingCaret = useRef<number | null>(null);

  // Selected context references — proper removable CHIPS above the textarea
  // (not raw @tokens in the draft). The tokens are prepended to the outgoing
  // message on send; the agent resolves them server-side exactly as before.
  const [ctxChips, setCtxChips] = useState<ContextOption[]>([]);

  const streaming = status === "streaming";

  // Lazy-load the context options the first time the picker opens; the route
  // scopes to the caller's workspace so this is safe to cache for the session.
  const ensureContextOptions = useCallback(() => {
    setCtxState((s) => {
      if (s !== "idle") return s;
      fetch("/api/agent/context-options")
        .then((r) => (r.ok ? (r.json() as Promise<ContextData>) : Promise.reject(new Error("bad status"))))
        .then((d) => {
          setCtxData({ items: Array.isArray(d.items) ? d.items : [], channels: Array.isArray(d.channels) ? d.channels : [] });
          setCtxState("ready");
        })
        .catch(() => setCtxState("error"));
      return "loading";
    });
  }, []);

  const slashMatches = useMemo(
    () => (overlay?.kind === "slash" ? filterCommands(overlay.query) : []),
    [overlay],
  );
  const ctxOptions = useMemo(
    () => (overlay?.kind === "context" ? buildContextOptions(ctxData, overlay.query) : []),
    [overlay, ctxData],
  );
  const overlayLen = overlay?.kind === "slash" ? slashMatches.length : overlay?.kind === "context" ? ctxOptions.length : 0;
  const safeIdx = overlayLen ? Math.min(activeIdx, overlayLen - 1) : 0;

  /* Replace the trigger token (or insert at the caret) and park the caret at
     `caretAt` once the draft re-renders. */
  const insertAtTrigger = useCallback(
    (insert: { prefix: string; suffix?: string }) => {
      const ta = taRef.current;
      const caret = ta?.selectionStart ?? draft.length;
      const start = overlay && overlay.start !== null ? overlay.start : caret;
      const before = draft.slice(0, start);
      const after = draft.slice(caret);
      pendingCaret.current = before.length + insert.prefix.length;
      setDraft(before + insert.prefix + (insert.suffix ?? "") + after);
      setOverlay(null);
      taRef.current?.focus();
    },
    [draft, overlay],
  );

  const pickCommand = useCallback(
    (cmd: SlashCommand) => insertAtTrigger({ prefix: cmd.prefix, suffix: cmd.suffix }),
    [insertAtTrigger],
  );
  /* Picking a context adds a CHIP (deduped) and deletes the typed "@query"
     trigger from the draft (empty insert = pure removal); a +-opened picker
     (start: null) inserts nothing. Manually typed @post:/@channel: tokens in
     the draft keep working unchanged. */
  const pickContext = useCallback(
    (token: string) => {
      const opt =
        ctxOptions.find((o) => o.token === token) ??
        ({ token, label: token.replace(/^@\w+:/, ""), sub: token, group: token.startsWith("@channel:") ? "channel" : "post" } as ContextOption);
      setCtxChips((chips) => (chips.some((c) => c.token === token) ? chips : [...chips, opt]));
      insertAtTrigger({ prefix: "" });
    },
    [ctxOptions, insertAtTrigger],
  );

  /* The + button: toggle the context picker without a typed "@" (start: null
     → the pick inserts at the caret). Focus stays in the textarea so the
     keyboard keeps working and the popover never traps focus. */
  const toggleContextPicker = useCallback(() => {
    setOverlay((o) => {
      if (o?.kind === "context") return null;
      ensureContextOptions();
      setActiveIdx(0);
      return { kind: "context", start: null, query: "" };
    });
    taRef.current?.focus();
  }, [ensureContextOptions]);

  // Autosize the composer with its content (CSS min/max-height clamp it).
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${ta.scrollHeight}px`;
    // a template/token insert wants the caret mid-draft (e.g. /sketch)
    if (pendingCaret.current !== null) {
      ta.setSelectionRange(pendingCaret.current, pendingCaret.current);
      pendingCaret.current = null;
    }
  }, [draft]);

  // Auto-scroll to newest content while active.
  useEffect(() => {
    if (!active) return;
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, active, streaming]);

  // Focus the composer on mount when asked (page), and whenever the surface
  // transitions inactive -> active (panel open).
  useEffect(() => {
    if (autoFocus && active) taRef.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const prevActive = useRef(active);
  useEffect(() => {
    if (active && !prevActive.current) taRef.current?.focus();
    prevActive.current = active;
  }, [active]);

  // Recording finished -> base64 -> /api/transcribe -> append into the draft.
  // The audio never leaves this closure except as the POST body; nothing is
  // logged or kept after the request resolves.
  const transcribe = useCallback(async (blob: Blob) => {
    if (!blob.size) {
      setMic("idle");
      return;
    }
    setMic("transcribing");
    try {
      if (blob.size > MAX_AUDIO_BYTES) throw new Error("recording too large, keep it under a minute");
      const audio = await blobToBase64(blob);
      const res = await fetch("/api/transcribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ audio, mime: blob.type || "audio/webm" }),
      });
      const data = (await res.json().catch(() => ({}))) as { text?: unknown; error?: unknown };
      if (!res.ok || typeof data.text !== "string") {
        throw new Error(typeof data.error === "string" ? data.error : "transcription failed");
      }
      const text = data.text.trim();
      if (text) setDraft((d) => (d.trim() ? `${d.replace(/\s+$/, "")} ${text}` : text));
      setMic("idle");
      taRef.current?.focus();
    } catch (e) {
      setMic("idle");
      setMicNote(e instanceof Error && e.message ? e.message : "transcription failed");
    }
  }, []);

  const toggleMic = useCallback(async () => {
    setMicNote(null);
    if (mic === "transcribing") return;
    if (mic === "recording") {
      // Second click stops; onstop hands the blob to transcribe().
      if (micTimerRef.current) clearTimeout(micTimerRef.current);
      micTimerRef.current = null;
      if (recRef.current && recRef.current.state !== "inactive") recRef.current.stop();
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const preferred = "audio/webm;codecs=opus";
      const rec =
        typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported?.(preferred)
          ? new MediaRecorder(stream, { mimeType: preferred })
          : new MediaRecorder(stream);
      chunksRef.current = [];
      rec.ondataavailable = (e) => {
        if (e.data.size) chunksRef.current.push(e.data);
      };
      rec.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        recRef.current = null;
        void transcribe(new Blob(chunksRef.current, { type: rec.mimeType || "audio/webm" }));
        chunksRef.current = [];
      };
      recRef.current = rec;
      rec.start();
      setMic("recording");
      micTimerRef.current = setTimeout(() => {
        if (recRef.current && recRef.current.state !== "inactive") recRef.current.stop();
      }, MAX_RECORD_MS);
    } catch (e) {
      setMic("idle");
      const denied =
        e instanceof DOMException && (e.name === "NotAllowedError" || e.name === "SecurityError");
      setMicNote(
        denied
          ? "microphone permission denied. Allow it in the browser and try again"
          : "microphone unavailable",
      );
    }
  }, [mic, transcribe]);

  // Unmount: drop the recorder silently (no transcription of a dead surface).
  useEffect(
    () => () => {
      if (micTimerRef.current) clearTimeout(micTimerRef.current);
      const rec = recRef.current;
      if (rec) {
        rec.onstop = null;
        if (rec.state !== "inactive") rec.stop();
        rec.stream.getTracks().forEach((t) => t.stop());
      }
    },
    [],
  );

  const submit = useCallback(() => {
    if (!draft.trim() || streaming) return;
    // chips travel as their mono tokens, prefixed to the message
    const tokens = ctxChips.map((c) => c.token).join(" ");
    const text = tokens ? `${tokens} ${draft}` : draft;
    setDraft("");
    setCtxChips([]);
    setOverlay(null);
    void send(text);
  }, [draft, ctxChips, send, streaming]);

  /* Track the trigger token as the user types. A "/" or "@" at the start /
     after whitespace opens (and filters) its overlay; deleting or finishing
     the token closes it — except a +-opened picker (start: null), which only
     closes on pick/Esc/blur. */
  const onComposerChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value;
    setDraft(value);
    const trig = detectTrigger(value, e.target.selectionStart ?? value.length);
    if (trig) {
      if (!overlay || overlay.kind !== trig.kind || overlay.query !== trig.query) setActiveIdx(0);
      if (trig.kind === "context") ensureContextOptions();
      setOverlay(trig);
    } else if (overlay && !(overlay.kind === "context" && overlay.start === null)) {
      setOverlay(null);
    }
  };

  const onComposerKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (overlay) {
      if (e.key === "Escape") {
        // close ONLY the overlay — don't let the panel's own Esc handling fire
        e.preventDefault();
        e.stopPropagation();
        setOverlay(null);
        return;
      }
      if (overlayLen > 0) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setActiveIdx((safeIdx + 1) % overlayLen);
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setActiveIdx((safeIdx - 1 + overlayLen) % overlayLen);
          return;
        }
        if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
          e.preventDefault();
          if (overlay.kind === "slash") pickCommand(slashMatches[safeIdx]);
          else pickContext(ctxOptions[safeIdx].token);
          return;
        }
      }
      // no matches: Enter falls through and sends the raw text
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
      return;
    }
    // Backspace in an empty draft pops the last context chip.
    if (e.key === "Backspace" && draft === "" && ctxChips.length) {
      e.preventDefault();
      setCtxChips((chips) => chips.slice(0, -1));
    }
  };

  const lastId = messages.length ? messages[messages.length - 1].id : null;

  return (
    <>
      <div className="cp-list" ref={listRef}>
        {messages.length === 0 ? (
          empty ?? (
            <div className="cp-empty">
              <div className="cp-empty-icon">
                <SoliMark size={26} />
              </div>
              <div className="cp-empty-title">Ask Soli</div>
              <div className="cp-empty-sub">
                Access to your concepts, videos, generations and pipelines.
              </div>
              <div className="cp-examples">
                {examples.map((ex) => (
                  <button
                    key={ex}
                    className="cp-example"
                    type="button"
                    onClick={() => {
                      setDraft("");
                      void send(ex);
                    }}
                  >
                    {ex}
                  </button>
                ))}
              </div>
            </div>
          )
        ) : (
          messages.map((m) => (
            <MessageBubble
              key={m.id}
              message={m}
              streaming={streaming && m.id === lastId && m.role === "assistant"}
              onAction={(text) => void send(text)}
              onEdit={editMessage}
            />
          ))
        )}
      </div>

      {micNote ? <div className="cmp-note">{micNote}</div> : null}
      <div className="cp-composer" data-guide="composer">
        {/* tool popovers float above the composer; they never take focus —
            keys stay on the textarea, rows swallow mousedown, blur closes */}
        {overlay?.kind === "slash" && slashMatches.length > 0 ? (
          <SlashPalette commands={slashMatches} active={safeIdx} onPick={pickCommand} onHover={setActiveIdx} />
        ) : null}
        {overlay?.kind === "context" ? (
          <ContextPicker options={ctxOptions} active={safeIdx} state={ctxState} onPick={pickContext} onHover={setActiveIdx} />
        ) : null}
        {/* one unified field: context chips ride INSIDE it, above the input
            row; +, textarea, mic and send share a single bordered surface so
            everything aligns on one baseline */}
        <div className="cmp-field">
          {ctxChips.length > 0 ? (
            <div className="cmp-chips">
              {ctxChips.map((c) => (
                <span className="cmp-chip" key={c.token} title={c.token}>
                  <span className="cmp-chip-glyph">
                    <ContextGroupMark group={c.group} />
                  </span>
                  <span className="cmp-chip-label">{c.label}</span>
                  <button
                    className="cmp-chip-x"
                    type="button"
                    aria-label={`Remove context ${c.label}`}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => setCtxChips((chips) => chips.filter((x) => x.token !== c.token))}
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          ) : null}
          <div className="cmp-fieldrow">
            <button
              className={`cmp-btn cmp-ctx${overlay?.kind === "context" ? " open" : ""}`}
              type="button"
              title="Add context (@)"
              aria-label="Add context"
              aria-expanded={overlay?.kind === "context"}
              onMouseDown={(e) => e.preventDefault()}
              onClick={toggleContextPicker}
              disabled={streaming}
            >
              <InkPlusIcon />
            </button>
            <textarea
              ref={taRef}
              className="cp-textarea"
              placeholder={canAct ? "Ask Soli…  ( / for commands, @ for context )" : `Ask Soli (read-only, your role is ${ROLE_LABEL[role]})`}
              value={draft}
              rows={1}
              onChange={onComposerChange}
              onKeyDown={onComposerKey}
              onBlur={() => setOverlay(null)}
            />
            <button
              className={`cmp-btn cmp-mic${mic === "recording" ? " rec" : ""}${mic === "transcribing" ? " busy" : ""}`}
              onClick={() => void toggleMic()}
              type="button"
              title={mic === "recording" ? "Stop recording" : mic === "transcribing" ? "Transcribing…" : "Dictate"}
              aria-label={mic === "recording" ? "Stop recording" : mic === "transcribing" ? "Transcribing" : "Dictate"}
              aria-pressed={mic === "recording"}
              disabled={streaming}
            >
              <InkMicIcon />
              {/* wobbled ink ring — breathes while recording, spins while transcribing */}
              <svg className="cmp-ring" viewBox="0 0 36 36" aria-hidden="true" focusable="false">
                <path
                  pathLength={1}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={1.5}
                  strokeLinecap="round"
                  d="M18 2.6 C26.9 2.4 33.5 9.2 33.4 18.1 C33.3 26.8 26.6 33.5 17.9 33.4 C9.3 33.3 2.5 26.7 2.6 18 C2.7 9.4 9.4 2.8 18 2.6 Z"
                />
              </svg>
              {/* the brand spark, detached — orbits the button while recording */}
              <span className="cmp-orbit" aria-hidden="true">
                <svg className="cmp-spark" viewBox="0 0 16 10" width={10} height={7} focusable="false">
                  <path fill="currentColor" d="M0 5 L8 .6 L16 5 L8 9.4 Z" />
                </svg>
              </span>
            </button>
            {streaming ? (
              /* streaming: the stop square sits inside a sketched ring that
                 keeps being drawn around it (the mic's transcribe grammar) —
                 the button itself is "being sketched" while Soli works */
              <button className="cp-send stop cmp-btn" onClick={stop} type="button" title="Stop" aria-label="Stop">
                <InkStopIcon size={15} />
                <svg className="cmp-ring" viewBox="0 0 36 36" aria-hidden="true" focusable="false">
                  <path
                    pathLength={1}
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={1.5}
                    strokeLinecap="round"
                    d="M18 2.6 C26.9 2.4 33.5 9.2 33.4 18.1 C33.3 26.8 26.6 33.5 17.9 33.4 C9.3 33.3 2.5 26.7 2.6 18 C2.7 9.4 9.4 2.8 18 2.6 Z"
                  />
                </svg>
              </button>
            ) : (
              <button
                className="cp-send cmp-btn"
                onClick={submit}
                type="button"
                title="Send"
                aria-label="Send"
                disabled={!draft.trim()}
              >
                {/* keyed by armed state: the arrow REDRAWS itself the moment
                    the draft first has content (ink-drawable one-shot) */}
                <InkSendIcon size={16} key={draft.trim() ? "armed" : "idle"} />
              </button>
            )}
          </div>
        </div>
      </div>
    </>
  );
}

export default ChatCore;
