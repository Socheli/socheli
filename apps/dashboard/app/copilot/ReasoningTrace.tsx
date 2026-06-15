"use client";
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type { ChatMessage, ToolEvent } from "./useAgent";
import { ToolCallChip } from "./parts";
import { StreamingDots } from "./parts";
import { InkChevronIcon, InkIcon } from "../../components/sketch";

/* The copilot's chain-of-thought, rendered like Claude/ChatGPT's "Thought for
   Ns" — but in the house ink language. It sits ABOVE the answer bubble and
   NEVER duplicates the answer (the reasoning channel and the content stream are
   disjoint by construction; see graph.ts).

   COLLAPSED (default): one quiet mono row. While the turn is still streaming
   its reasoning, it reads "Thinking…" with the shared sketched think loader.
   Once the answer arrives it settles to "Thought for {Ns} · {n} steps" with a
   small ink chevron.

   EXPANDED: a hand-drawn vertical ink timeline (the same rail/stamp grammar as
   the timeline block) that interleaves (a) reasoning BEATS — the CoT split into
   sentence-sized steps, each a node on the rail — and (b) the turn's TOOL CALLS
   rendered inline as the real ToolCallChip at their position in the sequence.
   The rail and nodes self-draw on expand (stroke-dashoffset / stamp); reduced
   motion renders everything static (handled by the global ink + .reason- CSS).

   If a message has no reasoning AND no tools, this renders nothing — the answer
   bubble stands alone. */

type Props = { message: ChatMessage; streaming?: boolean };

/* Split a chain-of-thought blob into readable BEATS. Prefer real sentence /
   line boundaries; collapse whitespace; drop empties; cap the count so a long
   ramble never builds a hundred-node rail (the tail beats are merged into the
   last node). Each beat is trimmed and de-noised of leftover markdown bullets. */
const MAX_BEATS = 14;
function toBeats(reasoning: string): string[] {
  const clean = reasoning.replace(/\r/g, "").trim();
  if (!clean) return [];
  // Split on sentence enders followed by space/newline, and on hard newlines,
  // keeping the punctuation attached to its beat.
  const raw = clean
    .split(/\n{2,}|(?<=[.!?])\s+(?=[A-Z0-9"'`(\[])|\n/)
    .map((s) => s.replace(/^[\s>*\-–•]+/, "").replace(/\s+/g, " ").trim())
    .filter((s) => s.length > 0);
  if (raw.length <= MAX_BEATS) return raw;
  // Keep the first MAX_BEATS-1, fold the rest into one closing beat.
  const head = raw.slice(0, MAX_BEATS - 1);
  head.push(raw.slice(MAX_BEATS - 1).join(" "));
  return head;
}

/* Format a duration the way "Thought for Ns" reads: sub-minute in seconds,
   above a minute in m s. Never shows 0s (rounds up to 1). */
function fmtDur(ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return r ? `${m}m ${r}s` : `${m}m`;
}

/* One node on the rail: a stamped star glyph, the connector below it (drawn
   after the stamp), and the beat/tool content to its right. */
function RailNode({
  i,
  last,
  expanded,
  children,
  tone,
}: {
  i: number;
  last: boolean;
  expanded: boolean;
  children: React.ReactNode;
  tone?: "beat" | "tool";
}) {
  // Re-key the animatable pieces on each expand so the draw-in REPLAYS every
  // time the trace is opened (mount = fresh animation), instead of firing once.
  const stampDelay = `calc(120ms + min(calc(${i} * 90ms), 900ms))`;
  return (
    <div className={`reason-node${tone === "tool" ? " is-tool" : ""}`}>
      <div className="reason-rail">
        <span className="reason-node-glyph blk-stamp" style={{ animationDelay: stampDelay } as CSSProperties}>
          <InkIcon name="glyph" size={10} />
        </span>
        {!last ? (
          <svg
            key={expanded ? "open" : "closed"}
            className="reason-rail-line ink-drawable"
            viewBox="0 0 8 40"
            preserveAspectRatio="none"
            style={{ "--ink-delay": `calc(220ms + ${i} * 90ms)`, "--ink-dur": "260ms" } as CSSProperties}
            aria-hidden
          >
            <path
              d="M4 1 C 4.9 8.2, 3.2 15.8, 4.1 23.6 C 4.7 30.4, 3.5 35.6, 4 39"
              pathLength={1}
              fill="none"
              stroke="currentColor"
              strokeWidth={1.2}
              strokeLinecap="round"
            />
          </svg>
        ) : null}
      </div>
      <div
        className="reason-node-body blk-in"
        style={{ "--i": i } as CSSProperties}
      >
        {children}
      </div>
    </div>
  );
}

export function ReasoningTrace({ message, streaming }: Props) {
  const [expanded, setExpanded] = useState(false);
  // Mount counter bumped on each expand so child draw-in animations replay.
  const [openKey, setOpenKey] = useState(0);
  const reasoning = message.reasoning ?? "";
  const tools = useMemo(() => message.tools ?? [], [message.tools]);

  const beats = useMemo(() => toBeats(reasoning), [reasoning]);
  const hasReasoning = beats.length > 0;
  // The trace earns its place when there is real reasoning to show. (Tool chips
  // already render in their own row below the bubble when there's no reasoning,
  // so we don't hijack them into an empty trace.)
  const stepCount = tools.length || beats.length;

  // While the answer hasn't started, reasoning is still streaming → show the
  // live "Thinking…" head. Once content arrives (or the stream ends) it settles.
  const reasoningStreaming = !!streaming && !message.content;

  const durLabel = useMemo(() => {
    if (message.reasoningMs && message.reasoningMs > 0) return fmtDur(message.reasoningMs);
    // No timing (e.g. a persisted thread) → estimate from step count.
    return `${Math.max(1, Math.round(stepCount * 0.8))}s`;
  }, [message.reasoningMs, stepCount]);

  // Auto-collapse once streaming finishes so completed turns read clean; the
  // user can still open any trace. (We only force-collapse on the transition.)
  const wasStreaming = useRef(reasoningStreaming);
  useEffect(() => {
    if (wasStreaming.current && !reasoningStreaming) setExpanded(false);
    wasStreaming.current = reasoningStreaming;
  }, [reasoningStreaming]);

  if (!hasReasoning) return null;

  const onToggle = () => {
    setExpanded((v) => {
      const next = !v;
      if (next) setOpenKey((k) => k + 1);
      return next;
    });
  };

  // Interleave beats and tool chips: reasoning leads, tool calls fall in after
  // the beats they motivated. With no per-step timestamps we distribute the
  // tool chips evenly across the beats so the rail reads "thought → acted →
  // thought" rather than dumping every chip at the end.
  type Row = { kind: "beat"; text: string } | { kind: "tool"; tool: ToolEvent };
  const rows: Row[] = [];
  if (tools.length && beats.length) {
    const every = Math.max(1, Math.floor(beats.length / tools.length));
    let ti = 0;
    beats.forEach((text, bi) => {
      rows.push({ kind: "beat", text });
      if (ti < tools.length && (bi + 1) % every === 0) rows.push({ kind: "tool", tool: tools[ti++] });
    });
    while (ti < tools.length) rows.push({ kind: "tool", tool: tools[ti++] });
  } else {
    beats.forEach((text) => rows.push({ kind: "beat", text }));
    tools.forEach((tool) => rows.push({ kind: "tool", tool }));
  }

  return (
    <div className={`reason${expanded ? " open" : ""}`}>
      <button
        type="button"
        className="reason-head"
        onClick={onToggle}
        aria-expanded={expanded}
      >
        {reasoningStreaming ? (
          <>
            <StreamingDots />
            <span className="reason-head-label">Thinking…</span>
          </>
        ) : (
          <>
            <InkIcon name="glyph" size={11} className="reason-head-glyph" />
            <span className="reason-head-label">
              Thought for {durLabel}
              {stepCount > 0 ? <span className="reason-head-steps"> · {stepCount} step{stepCount === 1 ? "" : "s"}</span> : null}
            </span>
            <InkChevronIcon size={11} className={`reason-chev${expanded ? " open" : ""}`} />
          </>
        )}
      </button>
      {expanded ? (
        <div className="reason-body" key={openKey}>
          {rows.map((row, i) => (
            <RailNode
              key={i}
              i={i}
              last={i === rows.length - 1}
              expanded={expanded}
              tone={row.kind === "tool" ? "tool" : "beat"}
            >
              {row.kind === "beat" ? (
                <p className="reason-beat">{row.text}</p>
              ) : (
                <div className="reason-tool">
                  <ToolCallChip tool={row.tool} />
                </div>
              )}
            </RailNode>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export default ReasoningTrace;
