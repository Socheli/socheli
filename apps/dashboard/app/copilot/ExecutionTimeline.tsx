"use client";
import { useEffect, useRef, type CSSProperties } from "react";
import type { ChatMessage, ExecStep } from "./useAgent";
import { UIBlocks } from "./UIBlock";
import { ToolCallChip } from "./parts";
import { vizForToolResult } from "../../lib/agent/tool-result-viz";
import { InkIcon, InkRing, InkCheckIcon, InkXIcon } from "../../components/sketch";

/* The LIVE execution view of Soli's turn — shown WHILE the turn is streaming
   (the last assistant message, status "streaming"). It renders message.steps
   as an ordered hand-drawn ink rail that grows as events arrive:

   - a reason step is a node with its text (dim, animates in as a "thought beat")
   - a tool step is a node showing the tool name + a status mark (spinner →
     check/x), and BELOW a SETTLED tool step its RICH RESULT rendered as real
     UIBlocks (via tool-result-viz), falling back to the collapsible JSON chip
     when no widget mapping fits.

   New steps animate in (stroke/opacity); reduced motion renders them static
   (handled by the shared ink + .reason-/.exec- CSS, scoped to execution.css).
   When the turn completes, the parent (MessageBubble) stops rendering this and
   hands off to the collapsed ReasoningTrace — so live = expanded timeline,
   done = collapsed trace. The two never render at once. */

type Props = { message: ChatMessage; onAction?: (text: string) => void };

/* A reason step's accumulated text can be a long blob; show it whole (it reads
   as one live "thinking" paragraph) but collapse whitespace so it stays tidy. */
function reasonText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/* Humanize a registry tool id for the node label: fleet_devices → "Fleet
   devices". Mirrors parts.tsx humanizeTool, kept local so this file owns no
   cross-import beyond the chip it already renders. */
const ACRONYMS: Record<string, string> = {
  dna: "DNA", ai: "AI", dm: "DM", qa: "QA", ui: "UI", url: "URL", ig: "IG", yt: "YT",
  id: "ID", api: "API", llm: "LLM", seo: "SEO", cta: "CTA",
};
function humanize(name: string): string {
  return name
    .split("_")
    .map((w, i) => ACRONYMS[w] ?? (i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w))
    .join(" ");
}

function StatusMark({ status }: { status: "running" | "done" | "error" }) {
  if (status === "running") return <InkRing className="exec-spin" />;
  if (status === "error") return <InkXIcon size={12} />;
  return <InkCheckIcon size={13} />;
}

/* One rail row: a stamped glyph node, a connector below (unless last), and the
   step body to the right. */
function ExecNode({
  i,
  last,
  tone,
  children,
}: {
  i: number;
  last: boolean;
  tone: "reason" | "tool";
  children: React.ReactNode;
}) {
  const stampDelay = `calc(80ms + min(calc(${i} * 70ms), 700ms))`;
  return (
    <div className={`exec-node${tone === "tool" ? " is-tool" : ""}`}>
      <div className="exec-rail">
        <span className="exec-glyph blk-stamp" style={{ animationDelay: stampDelay } as CSSProperties}>
          <InkIcon name="glyph" size={10} />
        </span>
        {!last ? (
          <svg
            className="exec-rail-line ink-drawable"
            viewBox="0 0 8 40"
            preserveAspectRatio="none"
            style={{ "--ink-delay": `calc(160ms + ${i} * 70ms)`, "--ink-dur": "240ms" } as CSSProperties}
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
      <div className="exec-body blk-in" style={{ "--i": i } as CSSProperties}>
        {children}
      </div>
    </div>
  );
}

/* The body of a tool step: name + live status, then — once settled — its rich
   result as real blocks (or the collapsible JSON chip fallback). */
function ToolStep({ step, onAction }: { step: Extract<ExecStep, { kind: "tool" }>; onAction?: (text: string) => void }) {
  const settled = step.status !== "running";
  const blocks = settled && step.result !== undefined ? vizForToolResult(step.name, step.result) : null;
  // Reuse ToolCallChip for the header + the JSON fallback (it already unwraps
  // the envelope and shows args/result on expand). It expects a ToolEvent.
  const asEvent = { id: step.id, name: step.name, args: step.args, result: step.result, ok: step.ok, status: step.status };
  return (
    <div className="exec-tool">
      {blocks ? (
        <>
          <div className="exec-tool-line">
            <span className="exec-tool-name" title={step.name}>{humanize(step.name)}</span>
            <span className={`exec-tool-mark ${step.status}`}>
              <StatusMark status={step.status} />
            </span>
          </div>
          <div className="exec-tool-viz">
            <UIBlocks blocks={blocks as never} onAction={onAction} />
          </div>
        </>
      ) : (
        // No widget mapping (or still running) → the standard chip, which is
        // collapsed by default and carries the JSON fallback on expand.
        <ToolCallChip tool={asEvent} />
      )}
    </div>
  );
}

export function ExecutionTimeline({ message, onAction }: Props) {
  const steps = message.steps ?? [];
  const endRef = useRef<HTMLDivElement | null>(null);

  // Sticky-bottom feel: nudge the newest step into view as the timeline grows.
  useEffect(() => {
    endRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [steps.length, message.content]);

  if (!steps.length) return null;

  return (
    <div className="exec" role="log" aria-label="Soli is working" aria-live="polite">
      <div className="exec-body-rail">
        {steps.map((s, i) => (
          <ExecNode key={s.kind === "tool" ? s.id : `r${i}`} i={i} last={i === steps.length - 1} tone={s.kind}>
            {s.kind === "reason" ? (
              <p className="exec-beat">{reasonText(s.text)}</p>
            ) : (
              <ToolStep step={s} onAction={onAction} />
            )}
          </ExecNode>
        ))}
      </div>
      <div ref={endRef} aria-hidden />
    </div>
  );
}

export default ExecutionTimeline;
