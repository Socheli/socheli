"use client";
import { useState, type ReactNode } from "react";
import type { ChatMessage, ToolEvent } from "./useAgent";
import { UIBlocks } from "./UIBlock";
import { KNOWN_TYPES, validateBlocks } from "../../lib/agent/ui-spec";
import type { GuideSpec } from "../../lib/agent/guide-spec";
import { InkChevronIcon, InkToolIcon, InkCheckIcon, InkXIcon, InkRing, InkPenIcon, InkCopyIcon } from "../../components/sketch";
import { Markdown } from "./Markdown";
import { ReasoningTrace } from "./ReasoningTrace";
import { ExecutionTimeline } from "./ExecutionTimeline";
import { JsonTree } from "./JsonTree";

/* Pure presentational pieces for the copilot panel. */

/* Sanitize streamed assistant text for display. Weaker OpenRouter models leak two
   kinds of noise: (1) harmony/channel control tokens (<|channel|>thought …), and
   (2) the ui_render block JSON echoed inline as text (it ALSO renders as real UI
   blocks, so the raw JSON is pure duplication). Strip both. */
const UI_BLOCK_TYPES = Array.from(KNOWN_TYPES).join("|");
const CHANNEL_TOKENS =
  /<\|?(channel|message|start|end|assistant|system|user|return|constrain)\|?>\s*(thought|analysis|final|commentary|to=\S+)?/gi;

/* XML-style reasoning blocks some models wrap their chain-of-thought in. A
   PROPERLY CLOSED block is removed whole; an UNCLOSED trailing block (the stream
   cut off mid-thought, or the model never closed it) is stripped to end of text
   so raw reasoning never shows. Non-greedy, dot-matches-newline. */
const THINK_BLOCK = /<(think|thinking|reasoning|reflection|scratchpad)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
const THINK_OPEN_TRAILING = /<(think|thinking|reasoning|reflection|scratchpad)\b[^>]*>[\s\S]*$/i;

/* Harmony "channel" reasoning that survived token-stripping as PLAIN WORDS: a
   run that opens with one or more of thought/analysis/commentary (the leak in
   the bug report looked like "thought thought thought You have one device…").
   Conservative to avoid eating legitimate prose like "Analysis paralysis…":
   only strips when the leak is unambiguous — EITHER the marker word is repeated
   (2+ in a row), OR it's a single LOWERCASE marker (channel names leak
   lowercase) immediately followed by a capital letter (the real reply). A
   capitalized leading word ("Analysis …") that begins a normal sentence is left
   alone. Matched at the start of a line. */
const LEADING_THINK_WORDS =
  /^[ \t]*(?:(?:thought|analysis|commentary)\b[ \t]+){2,}|^[ \t]*(?:thought|analysis|commentary)\b[ \t]+(?=[A-Z])/gm;

/* Collapse an immediately-repeated word run anywhere ("thought thought thought "
   → "thought "): same word (3+ letters) repeated 3+ times back to back. Weak
   models loop a single token; one copy is enough. */
const REPEATED_WORD_RUN = /\b(\w{3,})(?:[ \t]+\1\b){2,}/gi;

/* EM-DASH HARD STRIP — the user wants Soli's prose free of em/en-dash asides
   (the system prompt asks for it, but weak models relapse). Deterministically
   normalize dash usage to commas, WITHOUT touching hyphens in compound words
   (mistake-fix, b-roll), number ranges (10-20, 3–5), or negative numbers.
   We only ever act on the em-dash (—, U+2014) and en-dash (–, U+2013); plain
   ASCII hyphens are left entirely alone. Order matters: spaced asides first,
   then edge dashes, then a bare word-joining dash. */
function stripEmDashes(text: string): string {
  return (
    text
      // " — " / " – " aside (one or both sides spaced) → ", "
      .replace(/\s*[—–]\s+/g, ", ")
      .replace(/\s+[—–]\s*/g, ", ")
      // a standalone em/en-dash flush between two word characters
      // ("ideas—like" leftover after the spaced pass can't occur, but a
      // genuinely unspaced "word—word" does) → ", "
      .replace(/(\w)[—–](\w)/g, "$1, $2")
      // any remaining lone em/en-dash (leading/trailing fragment) → comma
      .replace(/[—–]/g, ",")
      // tidy any doubled commas / comma-space artifacts the swaps produced
      .replace(/,\s*,/g, ",")
      .replace(/\s+,/g, ",")
      .replace(/,(?=\S)/g, ", ")
  );
}

/* Final safety net: a bare standalone "thought" / "thinking" line (the harmony
   reasoning marker leaking as a whole line after the answer). Defense in depth
   even with model reasoning OFF. Only strips a line that is JUST the marker
   word (optionally capitalized / punctuated), never a real sentence. */
const BARE_THINK_LINE = /^[ \t]*(?:thought|thinking|analysis|reasoning)[ \t]*[.:]?[ \t]*$/gim;

/* Adjacent duplicate LINES (the model loops a whole line). Compare trimmed; keep
   the first, drop the immediately-following identical ones. */
function dedupeAdjacentLines(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let prev: string | null = null;
  for (const line of lines) {
    const key = line.trim();
    if (key && key === prev) continue; // skip an identical non-empty repeat
    out.push(line);
    prev = key || null; // blank lines don't anchor a dedupe
  }
  return out.join("\n");
}

/* Adjacent duplicate SENTENCES within a line ("You have one device online: You
   have one device online:"). Split on sentence boundaries, keep the first of any
   run of identical (trimmed, case-insensitive) sentences. Conservative: only
   exact adjacent repeats collapse. */
function dedupeAdjacentSentences(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      // keep the delimiter on each piece so punctuation/spacing is preserved
      const parts = line.match(/[^.!?:]+[.!?:]+[ \t]*|[^.!?:]+$/g);
      if (!parts || parts.length < 2) return line;
      const out: string[] = [];
      let prev: string | null = null;
      for (const p of parts) {
        const key = p.trim().toLowerCase();
        if (key && key === prev) continue;
        out.push(p);
        prev = key || null;
      }
      return out.join("");
    })
    .join("\n");
}

function stripBlockJson(text: string): string {
  const typeRe = new RegExp(`\\{\\s*"type"\\s*:\\s*"(?:${UI_BLOCK_TYPES})"`, "g");
  let out = "";
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = typeRe.exec(text)) !== null) {
    const start = m.index;
    // walk to the matching close brace, string-aware
    let depth = 0, inStr = false, esc = false, end = -1;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === "\\") esc = true;
        else if (ch === '"') inStr = false;
      } else if (ch === '"') inStr = true;
      else if (ch === "{") depth++;
      else if (ch === "}") { depth--; if (depth === 0) { end = i + 1; break; } }
    }
    if (end === -1) { out += text.slice(last); return out.replace(/\n{3,}/g, "\n\n").trim(); }
    out += text.slice(last, start);
    last = end;
    typeRe.lastIndex = end;
  }
  out += text.slice(last);
  return out;
}

/* Recover a ui_render call the model leaked as TEXT instead of a tool call:
   "<ui_render> { \"blocks\": [...] }". Parse the JSON (string-aware balanced
   scan), validate through the canonical validators, and return the blocks so
   the UI renders what the model meant. Incomplete JSON (mid-stream or
   truncated) strips to the end of the text so raw JSON never shows. */
function extractLeakedUi(text: string): { text: string; blocks: unknown[] } {
  const m = /<\/?\s*ui_render\s*>?/i.exec(text);
  if (!m) return { text, blocks: [] };
  const start = m.index;
  const braceAt = text.indexOf("{", start);
  if (braceAt === -1) return { text: text.slice(0, start), blocks: [] };
  let depth = 0, inStr = false, esc = false, end = -1;
  for (let i = braceAt; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
    } else if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}") { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  if (end === -1) return { text: text.slice(0, start), blocks: [] }; // incomplete: hide the leak
  let blocks: unknown[] = [];
  try {
    const obj = JSON.parse(text.slice(braceAt, end));
    const raw = Array.isArray(obj?.blocks) ? obj.blocks : Array.isArray(obj) ? obj : [];
    blocks = validateBlocks(raw);
  } catch { /* unparseable: just strip */ }
  const rest = text.slice(end).replace(/^\s*<\/\s*ui_render\s*>/i, "");
  return { text: text.slice(0, start) + rest, blocks };
}

function cleanAssistantText(text: string): string {
  // Order matters: drop closed reasoning blocks, then any unclosed trailing one,
  // then harmony channel tokens, then the echoed ui_render JSON. Only after the
  // markers are gone do we collapse looped words/sentences/lines — so we never
  // mistake legitimate prose for a leak.
  let out = text
    .replace(THINK_BLOCK, "")
    .replace(THINK_OPEN_TRAILING, "")
    .replace(CHANNEL_TOKENS, "");
  out = stripBlockJson(out)
    .replace(BARE_THINK_LINE, "")
    .replace(LEADING_THINK_WORDS, "")
    .replace(REPEATED_WORD_RUN, "$1");
  out = dedupeAdjacentSentences(dedupeAdjacentLines(out));
  // Em/en-dash asides → commas (assistant prose only; this fn is never called
  // on user text). Done after dedupe so we normalize the final clean prose.
  out = stripEmDashes(out);
  return out.replace(/\n{3,}/g, "\n\n").trim();
}

/* The set of normalized "cells" a block carries — used to detect the SAME
   underlying data rendered as two DIFFERENT block shapes (e.g. a domain block
   plus a bare `table` of the same rows). We reduce a block to a sorted set of
   the short string values it shows; two blocks that share (almost) all their
   values are the same data wearing a different hat. */
function blockCells(block: unknown): Set<string> {
  const cells = new Set<string>();
  const visit = (v: unknown) => {
    if (v == null) return;
    if (typeof v === "string") {
      const t = v.trim().toLowerCase();
      // skip hrefs / urls / very long blobs — they're chrome, not data
      if (t && t.length <= 80 && !/^https?:\/\//.test(t) && !t.startsWith("/")) cells.add(t);
    } else if (typeof v === "number") {
      cells.add(String(v));
    } else if (Array.isArray(v)) {
      v.forEach(visit);
    } else if (typeof v === "object") {
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        if (k === "type" || k === "href" || k === "thumb" || k === "thumbUrl" || k === "url") continue;
        visit(val);
      }
    }
  };
  visit(block);
  return cells;
}

/* Is `block` a BARE `table` (or stat_grid) — a generic fallback shape — whose
   data is fully contained in some richer DOMAIN/widget block in the same set?
   "table" is the model's documented last-resort; weak models render a domain
   block AND echo the same rows as a table. Drop the bare one. */
const BARE_SHAPES = new Set(["table", "stat_grid"]);
function isRedundantBareBlock(block: unknown, others: unknown[]): boolean {
  const type = (block as { type?: string })?.type;
  if (!type || !BARE_SHAPES.has(type)) return false;
  const mine = blockCells(block);
  if (mine.size < 2) return false; // too little data to judge — keep it
  for (const o of others) {
    if (o === block) continue;
    const ot = (o as { type?: string })?.type;
    if (!ot || BARE_SHAPES.has(ot)) continue; // only a RICHER block can subsume it
    const theirs = blockCells(o);
    if (theirs.size === 0) continue;
    // contained = (nearly) every value the bare block shows also appears in the
    // richer block. Allow 1 stray (a "total" row, a unit label) to still match.
    let missing = 0;
    for (const c of mine) if (!theirs.has(c)) missing++;
    if (missing <= 1) return true;
  }
  return false;
}

/* Drop duplicate ui block-groups, then drop bare tables whose data a richer
   block in the SAME message already shows. Weak models both double-call
   ui_render (byte-identical groups) and re-skin one dataset as a domain block
   plus a plain table — both read as a doubled answer. */
function dedupeUi(groups: unknown[][]): unknown[][] {
  const seen = new Set<string>();
  const deduped: unknown[][] = [];
  for (const g of groups) {
    const sig = JSON.stringify(g);
    if (seen.has(sig)) continue;
    seen.add(sig);
    deduped.push(g);
  }
  // Cross-shape dedupe is judged across ALL blocks in the message (a table in
  // one group can mirror a domain block in another), then applied per group.
  const all = deduped.flat();
  const out = deduped
    .map((g) => g.filter((b) => !isRedundantBareBlock(b, all)))
    .filter((g) => g.length > 0);
  return out.length ? out : deduped; // never strip everything
}

/* Minimal markdown-ish renderer: preserves line breaks, renders `inline code`,
   and shows @post:/@channel: context tokens as quiet inline chips (matching
   the composer's context chips). Intentionally tiny — no block parsing — to
   keep streaming snappy. */
function renderText(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const lines = text.split("\n");
  lines.forEach((line, li) => {
    const parts = line.split(/(`[^`]+`|@(?:post|channel):[\w-]+)/g);
    parts.forEach((p, pi) => {
      if (p.startsWith("`") && p.endsWith("`") && p.length > 1) {
        out.push(
          <code key={`${li}-${pi}`} className="cp-code">
            {p.slice(1, -1)}
          </code>,
        );
      } else if (/^@(?:post|channel):/.test(p)) {
        out.push(
          <span key={`${li}-${pi}`} className="cp-ctx-token" title={p}>
            {p.slice(1)}
          </span>,
        );
      } else if (p) {
        out.push(<span key={`${li}-${pi}`}>{p}</span>);
      }
    });
    if (li < lines.length - 1) out.push(<br key={`br-${li}`} />);
  });
  return out;
}

/* Hand-sketched thinking state: the Soli star is TRACED stroke by stroke,
   held a beat, then the line lifts and the hand retraces it — the spark lands
   during the hold, and three pencil dashes tick underneath like a thought
   being roughed in. Pure stroke-dashoffset loops over baked wobbled paths
   (the same grammar as the ink icons); prefers-reduced-motion renders it
   fully drawn and still. */
export function StreamingDots() {
  return (
    <span className="cp-think" role="status" aria-label="Soli is sketching a reply">
      <svg
        className="cp-think-ink"
        viewBox="0 0 24 24"
        width={20}
        height={20}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        focusable="false"
      >
        {/* concave 4-point star, one continuous hand stroke */}
        <path
          className="cp-think-star"
          pathLength={1}
          d="M12 2.7 C 12.9 8.2, 15.4 10.9, 21.2 11.9 C 15.5 13, 12.9 15.6, 12.1 21.2 C 11.2 15.6, 8.5 13, 2.8 12 C 8.5 11, 11.2 8.3, 12 2.8"
        />
        {/* the breakaway spark lands while the star holds */}
        <path
          className="cp-think-spark"
          pathLength={1}
          d="M19 3.3 C 19.3 4.5, 19.8 5, 21 5.3 C 19.8 5.6, 19.3 6.1, 19 7.3 C 18.7 6.1, 18.2 5.6, 17 5.3 C 18.2 5, 18.7 4.5, 19 3.3"
        />
      </svg>
      <svg
        className="cp-think-dashes"
        viewBox="0 0 32 8"
        width={26}
        height={7}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.6}
        strokeLinecap="round"
        aria-hidden="true"
        focusable="false"
      >
        <path pathLength={1} d="M2.2 4.9 C 3.7 4.2, 5.4 5, 7 4.4" />
        <path pathLength={1} d="M13 4.7 C 14.5 4, 16.2 4.9, 17.8 4.3" />
        <path pathLength={1} d="M23.8 4.9 C 25.3 4.1, 27 5, 28.6 4.4" />
      </svg>
    </span>
  );
}

/* Turn a registry tool id into a readable label: fleet_devices → "Fleet devices",
   dna_evolve → "DNA evolve", ui_render → "UI render". First word capitalized,
   rest lowercase, with known acronyms preserved. */
const ACRONYMS: Record<string, string> = {
  dna: "DNA", ai: "AI", dm: "DM", qa: "QA", ui: "UI", url: "URL", ig: "IG", yt: "YT",
  id: "ID", api: "API", llm: "LLM", abtest: "A/B test", seo: "SEO", cta: "CTA",
};
function humanizeTool(name: string): string {
  return name
    .split("_")
    .map((w, i) => ACRONYMS[w] ?? (i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w))
    .join(" ");
}

/* A tool result is the registry envelope { ok, data?, message? }. Unwrap it so
   the chip shows a clean status line + just the data — not the noisy wrapper. */
function isEnvelope(v: unknown): v is { ok: boolean; data?: unknown; message?: string } {
  return !!v && typeof v === "object" && "ok" in (v as object) && typeof (v as { ok: unknown }).ok === "boolean";
}
function nonEmpty(v: unknown): boolean {
  if (v == null) return false;
  if (typeof v === "object") return Object.keys(v as object).length > 0;
  return String(v).length > 0;
}

export function ToolCallChip({ tool }: { tool: ToolEvent }) {
  const [expanded, setExpanded] = useState(false);
  const showArgs = nonEmpty(tool.args);
  const env = isEnvelope(tool.result) ? tool.result : null;
  const message = env?.message;
  const resultBody = env ? env.data : tool.result;
  const showResult = tool.result !== undefined && (nonEmpty(resultBody) || !!message);
  return (
    <div className={`cp-tool ${tool.status}`}>
      <button className="cp-tool-head" onClick={() => setExpanded((v) => !v)} type="button">
        <InkChevronIcon size={11} className={`cp-tool-chev${expanded ? " open" : ""}`} />
        <InkToolIcon size={13} className="cp-tool-ico" />
        <span className="cp-tool-name" title={tool.name}>{humanizeTool(tool.name)}</span>
        <span className="cp-tool-dot">
          {tool.status === "running" ? (
            <InkRing className="cp-tool-spin" />
          ) : tool.status === "error" ? (
            <InkXIcon size={11} />
          ) : (
            <InkCheckIcon size={12} />
          )}
        </span>
      </button>
      {expanded && (
        <div className="cp-tool-body">
          {showArgs && (
            // A string arg reads better as code; structured args get the tree.
            typeof tool.args === "string" ? (
              <>
                <div className="cp-tool-label">input</div>
                <pre className="cp-tool-pre">{tool.args}</pre>
              </>
            ) : (
              <JsonTree data={tool.args} rootLabel="input" defaultExpandDepth={1} />
            )
          )}
          {message && <div className={`cp-tool-msg${env && !env.ok ? " err" : ""}`}>{message}</div>}
          {showResult && nonEmpty(resultBody) && (
            // The rich tree-explorer replaces the raw pretty-JSON dump. A bare
            // string result still shows as code (it isn't a tree).
            typeof resultBody === "string" ? (
              <>
                <div className="cp-tool-label">result</div>
                <pre className="cp-tool-pre">{resultBody}</pre>
              </>
            ) : (
              <JsonTree data={resultBody} rootLabel="result" defaultExpandDepth={2} />
            )
          )}
        </div>
      )}
    </div>
  );
}

/* Quiet replayable record of a ui_guide call: "Showing you: Calendar", or for a
   walkthrough "Walking you through: Calendar +2 more". The live marks fired when
   the frame streamed in; clicking the chip re-runs the guide (navigate + redraw)
   through the same window event the overlay owns. */
function GuideChip({ guide }: { guide: GuideSpec }) {
  const isTour = guide.steps.length > 1;
  const firstNote = guide.steps.find((s) => s.note)?.note;
  return (
    <button
      className="cp-guide-chip"
      type="button"
      title={firstNote || `Show me: ${guide.title}`}
      onClick={() => window.dispatchEvent(new CustomEvent("soli:guide", { detail: guide }))}
    >
      <InkRing className="cp-guide-ring" />
      <span className="cp-guide-label">{isTour ? "Walking you through" : "Showing you"}: {guide.title}</span>
    </button>
  );
}

/* HH:MM in the viewer's locale for a user turn's timestamp. */
function clockTime(ms: number): string {
  try {
    return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch {
    return "";
  }
}

/* The quiet row under a USER bubble: a small always-on time that reserves the
   row, plus copy + edit actions that fade + draw themselves in on hover (the
   icons MOUNT on hover, so the .ink-drawable stroke replays each time). */
function UserMessageMeta({ message, onStartEdit, canEdit }: { message: ChatMessage; onStartEdit?: () => void; canEdit: boolean }) {
  const [hovered, setHovered] = useState(false);
  const [copied, setCopied] = useState(false);
  const time = message.createdAt ? clockTime(message.createdAt) : "";

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(message.content);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      /* clipboard blocked — non-fatal */
    }
  };

  return (
    <div className="cp-umeta" onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}>
      {time && <span className="cp-umeta-time">{time}</span>}
      {hovered && (
        <span className="cp-umeta-acts">
          <button type="button" className="cp-umeta-act" onClick={copy} aria-label="Copy message" title={copied ? "Copied" : "Copy"}>
            {copied ? <InkCheckIcon size={13} /> : <InkCopyIcon size={13} />}
          </button>
          {canEdit && onStartEdit && (
            <button type="button" className="cp-umeta-act" onClick={onStartEdit} aria-label="Edit message" title="Edit">
              <InkPenIcon size={13} />
            </button>
          )}
        </span>
      )}
    </div>
  );
}

export function MessageBubble({
  message,
  streaming,
  onAction,
  onEdit,
}: {
  message: ChatMessage;
  streaming?: boolean;
  onAction?: (text: string) => void;
  onEdit?: (id: string, text: string) => void;
}) {
  const isUser = message.role === "user";
  // recover ui_render calls leaked as text BEFORE sanitizing, so the blocks still render
  const leak = isUser ? { text: message.content ?? "", blocks: [] as unknown[] } : extractLeakedUi(message.content ?? "");
  // A leaked-as-text ui_render is often the SAME content the model ALSO emitted
  // as a real ui_render tool call (which already arrived in message.ui). Drop
  // leaked blocks whose content signature matches any real-tool block, so the
  // recovery path never re-adds a group the tool path already produced.
  const realUi = Array.isArray(message.ui) ? (message.ui as unknown[][]) : [];
  const realCellSigs = new Set(realUi.flat().map((b) => [...blockCells(b)].sort().join("|")));
  const leakBlocks = leak.blocks.filter((b) => {
    const sig = [...blockCells(b)].sort().join("|");
    return !(sig && realCellSigs.has(sig));
  });
  const uiGroups = !isUser
    ? dedupeUi([...realUi, ...(leakBlocks.length ? [leakBlocks] : [])])
    : [];
  const hasUi = uiGroups.length > 0;
  // assistant text is sanitized (strip leaked tokens + echoed block JSON); user text is shown as-is
  const displayText = isUser ? message.content : cleanAssistantText(leak.text);
  const empty = !displayText && !(message.tools && message.tools.length) && !hasUi && !(message.guides && message.guides.length);
  // A captured chain-of-thought folds the tool chips INTO its rail (the trace
  // reads "thought → acted → thought"); without reasoning the chips keep their
  // standalone row above the bubble exactly as before.
  const hasReasoning = !isUser && !!(message.reasoning && message.reasoning.trim());
  // LIVE turn: while this assistant message is still streaming AND it has an
  // ordered execution timeline, show the live expanded ExecutionTimeline (rich
  // results inline). When the turn completes the bubble re-renders without
  // `streaming` and hands off to the collapsed ReasoningTrace below — the two
  // never render together (pick by streaming state).
  const hasSteps = !isUser && !!(message.steps && message.steps.length > 0);
  const showLive = !!streaming && hasSteps;

  // Inline edit of a user turn: the bubble swaps to a textarea; Save re-sends
  // the edited text and truncates the thread from here (onEdit → editMessage).
  const [editing, setEditing] = useState(false);
  const [editDraft, setEditDraft] = useState(message.content);
  const saveEdit = () => {
    const t = editDraft.trim();
    setEditing(false);
    if (t && t !== message.content && onEdit) onEdit(message.id, t);
  };
  const cancelEdit = () => { setEditing(false); setEditDraft(message.content); };

  return (
    <div className={`cp-msg ${isUser ? "user" : "assistant"}`}>
      {showLive ? (
        <ExecutionTimeline message={message} onAction={onAction} />
      ) : hasReasoning ? (
        <ReasoningTrace message={message} streaming={streaming} />
      ) : !isUser && message.tools && message.tools.length > 0 ? (
        <div className="cp-tools">
          {message.tools.map((t) => (
            <ToolCallChip key={t.id} tool={t} />
          ))}
        </div>
      ) : null}
      {isUser ? (
        editing ? (
          <div className="cp-uedit">
            <textarea
              className="cp-uedit-ta"
              value={editDraft}
              autoFocus
              rows={Math.min(8, Math.max(1, editDraft.split("\n").length))}
              onChange={(e) => setEditDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") cancelEdit();
                else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); saveEdit(); }
              }}
            />
            <div className="cp-uedit-row">
              <button type="button" className="cp-uedit-btn" onClick={cancelEdit}>Cancel</button>
              <button type="button" className="cp-uedit-btn primary" disabled={!editDraft.trim()} onClick={saveEdit}>Save &amp; send</button>
            </div>
          </div>
        ) : (
          <>
            {displayText ? <div className="cp-bubble">{renderText(displayText)}</div> : null}
            <UserMessageMeta message={message} canEdit={!!onEdit} onStartEdit={() => { setEditDraft(message.content); setEditing(true); }} />
          </>
        )
      ) : displayText ? (
        <div className="cp-bubble">
          <Markdown>{displayText}</Markdown>
        </div>
      ) : streaming && empty ? (
        <div className="cp-bubble cp-thinking">
          <StreamingDots />
        </div>
      ) : null}
      {hasUi &&
        uiGroups.map((blocks, i) => (
          <UIBlocks key={i} blocks={blocks as never} onAction={onAction} />
        ))}
      {!isUser && (message.guides ?? []).map((g, i) => <GuideChip key={i} guide={g} />)}
    </div>
  );
}
