"use client";
import { useMemo, useState, useCallback, type CSSProperties, type ReactNode } from "react";

/* ----------------------------------------------------------------------------
   JsonTree — a recursive, accessible JSON tree-view.

   This is the house replacement for the raw pretty-printed JSON `<pre>` that
   tool results, the execution timeline, and the auto-viz fallback used to dump.
   It reads as the same hand-inked surface as the rest of the copilot: a faint
   depth-rail per level (house gray-ramp), a wobble-free ink chevron that rotates
   on expand, keys in the mono eyebrow tint, typed + colored leaves, real links
   for URLs, and the shared .blk-in 55ms cascade on mount/expand (reduced-motion
   renders it static).

   Zero deps — pure React + json-tree.css. It guards the huge/hostile cases:
   circular refs become "[circular]", functions/symbols their typeof label,
   long strings truncate to a "…more" toggle, and over-large arrays/objects show
   the first N children behind a "+N more" expander so a giant payload never
   freezes the panel.

   All styling lives in app/copilot/json-tree.css (imported once in layout.tsx);
   colors come from the existing --bone/--accent/--text-* CSS vars. */

type Props = {
  data: unknown;
  rootLabel?: string;
  /* Levels expanded by default. Depth 0 = the root row's children. */
  defaultExpandDepth?: number;
  /* Children shown before a "+N more" expander kicks in (per node). */
  maxInitialNodes?: number;
};

type Kind =
  | "object"
  | "array"
  | "string"
  | "number"
  | "boolean"
  | "null"
  | "circular"
  | "other";

const URL_RE = /^(https?:\/\/[^\s]+)$/i;
const URL_SPLIT = /(https?:\/\/[^\s)]+)/g;
const LONG_STRING = 140;

function kindOf(v: unknown): Kind {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  const t = typeof v;
  if (t === "object") return "object";
  if (t === "string") return "string";
  if (t === "number") return "number";
  if (t === "boolean") return "boolean";
  return "other"; // undefined, function, symbol, bigint
}

/* A node is "branchy" (collapsible) only when it is an object/array with at
   least one entry. Empty containers render inline as {} / []. */
function isBranch(v: unknown): boolean {
  if (Array.isArray(v)) return v.length > 0;
  if (v && typeof v === "object") return Object.keys(v as object).length > 0;
  return false;
}

function childCount(v: unknown): number {
  if (Array.isArray(v)) return v.length;
  if (v && typeof v === "object") return Object.keys(v as object).length;
  return 0;
}

/* Walk the whole structure once to count nodes + leaves for the header, with a
   seen-set so a circular graph terminates. Bounded so a pathological payload
   can't spin (the tree itself caps what it renders anyway). */
function tally(root: unknown): { nodes: number; leaves: number } {
  let nodes = 0;
  let leaves = 0;
  const seen = new WeakSet<object>();
  const stack: unknown[] = [root];
  let budget = 200_000;
  while (stack.length && budget-- > 0) {
    const v = stack.pop();
    if (v && typeof v === "object") {
      if (seen.has(v as object)) continue;
      seen.add(v as object);
      nodes++;
      const entries = Array.isArray(v) ? v : Object.values(v as object);
      for (const e of entries) stack.push(e);
    } else {
      leaves++;
    }
  }
  return { nodes, leaves };
}

/* ---- leaf rendering ---- */

function StringLeaf({ value }: { value: string }) {
  const [open, setOpen] = useState(false);
  const long = value.length > LONG_STRING;
  const shown = long && !open ? value.slice(0, LONG_STRING) : value;

  // A whole-value URL becomes a single link; otherwise linkify any inline URLs.
  if (URL_RE.test(value.trim())) {
    const href = value.trim();
    return (
      <a className="jt-v jt-str jt-link" href={href} target="_blank" rel="noopener noreferrer">
        {value}
      </a>
    );
  }

  const body: ReactNode[] = [];
  shown.split(URL_SPLIT).forEach((part, i) => {
    if (!part) return;
    if (URL_RE.test(part)) {
      body.push(
        <a key={i} className="jt-link" href={part} target="_blank" rel="noopener noreferrer">
          {part}
        </a>,
      );
    } else {
      body.push(<span key={i}>{part}</span>);
    }
  });

  return (
    <span className="jt-v jt-str">
      <span className="jt-quote">&quot;</span>
      {body}
      {long && !open ? <span className="jt-ellip">…</span> : null}
      <span className="jt-quote">&quot;</span>
      {long ? (
        <button
          type="button"
          className="jt-more"
          onClick={(e) => {
            e.stopPropagation();
            setOpen((v) => !v);
          }}
        >
          {open ? "less" : "more"}
        </button>
      ) : null}
    </span>
  );
}

function Leaf({ value, kind }: { value: unknown; kind: Kind }) {
  switch (kind) {
    case "string":
      return <StringLeaf value={value as string} />;
    case "number":
      return <span className="jt-v jt-num">{String(value)}</span>;
    case "boolean":
      return <span className="jt-v jt-bool">{String(value)}</span>;
    case "null":
      return <span className="jt-v jt-null">null</span>;
    case "circular":
      return <span className="jt-v jt-null">[circular]</span>;
    default: {
      // undefined / function / symbol / bigint — label by typeof so the row is
      // never blank and never throws on JSON.stringify.
      const t = value === undefined ? "undefined" : typeof value;
      const label = t === "function" || t === "symbol" || t === "bigint" ? `[${t}]` : t;
      return <span className="jt-v jt-null">{label}</span>;
    }
  }
}

/* The wobbled ink chevron — same grammar as the rest of the copilot, drawn on
   the gray ramp, rotated by CSS when its row is open. Static (no draw-in) so it
   doesn't re-animate every expand; rotation is the only motion. */
function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      className={`jt-chev${open ? " open" : ""}`}
      viewBox="0 0 12 12"
      width={11}
      height={11}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M4.3 2.4 C 6 4, 7.3 5.2, 8.4 6.1 C 7.2 7.1, 5.8 8.3, 4.2 9.7" />
    </svg>
  );
}

/* ---- one node ---- */

type NodeProps = {
  /* The key (object) or index gutter label (array); null at the root. */
  label?: string;
  /* Whether `label` is an array index (renders in the quiet index gutter). */
  index?: boolean;
  value: unknown;
  depth: number;
  /* Auto-expand while depth < this. */
  expandTo: number;
  maxInitial: number;
  /* Ancestors on the current path → circular-ref guard. An ARRAY (not a Set)
     so each branch carries its OWN immutable path; siblings never pollute each
     other. Paths are bounded by tree depth, so linear membership is cheap. */
  seen: object[];
  /* Stagger index for the .blk-in cascade. */
  i: number;
};

function Node({ label, index, value, depth, expandTo, maxInitial, seen, i }: NodeProps) {
  const kind = kindOf(value);
  const branch = (kind === "object" || kind === "array") && childCount(value) > 0;

  // Depth-based default; expand/collapse-all is implemented by the parent
  // remounting the whole body with a new `expandTo`, so this stays a simple
  // local toggle with no cross-tree wiring.
  const [open, setOpen] = useState(depth < expandTo);
  const realOpen = branch ? open : false;

  // "+N more" within a node
  const total = branch ? childCount(value) : 0;
  const [showAll, setShowAll] = useState(false);
  const limit = showAll ? total : Math.min(total, maxInitial);

  const toggle = useCallback(() => {
    if (branch) setOpen((v) => !v);
  }, [branch]);

  const onKey = useCallback(
    (e: React.KeyboardEvent) => {
      if (!branch) return;
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        toggle();
      } else if (e.key === "ArrowRight" && !realOpen) {
        e.preventDefault();
        setOpen(true);
      } else if (e.key === "ArrowLeft" && realOpen) {
        e.preventDefault();
        setOpen(false);
      }
    },
    [branch, realOpen, toggle],
  );

  // circular guard: if this object is already on the ancestor path, render a leaf
  const circular = branch && seen.includes(value as object);
  const myKind: Kind = circular ? "circular" : kind;

  const countBadge = branch
    ? kind === "array"
      ? `[${total}]`
      : `{${total}}`
    : kind === "array"
      ? "[]"
      : kind === "object"
        ? "{}"
        : null;

  // The root has no key (the header already names it); children show their key
  // in the eyebrow tint, or their index in the quiet gutter.
  const KeyLabel =
    label != null ? <span className={index ? "jt-idx" : "jt-key"}>{label}</span> : null;

  // A branch row is the interactive toggle; a leaf row is a static label+value.
  const row = (
    <div
      className={`jt-row${branch && !circular ? " jt-branch" : ""}`}
      role={branch && !circular ? "treeitem" : undefined}
      aria-expanded={branch && !circular ? realOpen : undefined}
      tabIndex={branch && !circular ? 0 : undefined}
      onClick={branch && !circular ? toggle : undefined}
      onKeyDown={branch && !circular ? onKey : undefined}
    >
      {branch && !circular ? (
        <span className="jt-chev-wrap">
          <Chevron open={realOpen} />
        </span>
      ) : (
        <span className="jt-chev-spacer" aria-hidden />
      )}
      {KeyLabel}
      {label != null ? <span className="jt-colon">:</span> : null}
      {branch && !circular ? (
        <span className="jt-count">{countBadge}</span>
      ) : countBadge ? (
        // an EMPTY object/array (non-branch): show its {}/[] badge, not a typeof
        <span className="jt-count">{countBadge}</span>
      ) : (
        <Leaf value={value} kind={myKind} />
      )}
    </div>
  );

  if (!branch || circular) {
    return (
      <div className="jt-node blk-in" style={{ "--i": i } as CSSProperties}>
        {row}
      </div>
    );
  }

  // expand children once we render them (lazy: only when open)
  const entries: { k: string; v: unknown; idx: boolean }[] = realOpen
    ? Array.isArray(value)
      ? (value as unknown[]).slice(0, limit).map((v, idx) => ({ k: String(idx), v, idx: true }))
      : Object.entries(value as Record<string, unknown>)
          .slice(0, limit)
          .map(([k, v]) => ({ k, v, idx: false }))
    : [];

  // children inherit this node's path plus this node itself (fresh array per
  // branch → siblings stay isolated)
  const childSeen = realOpen ? [...seen, value as object] : seen;

  return (
    <div className="jt-node blk-in" style={{ "--i": i } as CSSProperties}>
      {row}
      {realOpen ? (
        <div className="jt-children" role="group">
          {entries.map((c, ci) => (
            <Node
              key={c.k}
              label={c.k}
              index={c.idx}
              value={c.v}
              depth={depth + 1}
              expandTo={expandTo}
              maxInitial={maxInitial}
              seen={childSeen}
              i={ci}
            />
          ))}
          {total > limit ? (
            <div className="jt-node">
              <button
                type="button"
                className="jt-more jt-more-block"
                onClick={(e) => {
                  e.stopPropagation();
                  setShowAll(true);
                }}
              >
                + {total - limit} more
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function JsonTree({
  data,
  rootLabel = "result",
  defaultExpandDepth = 2,
  maxInitialNodes = 100,
}: Props) {
  const { nodes, leaves } = useMemo(() => tally(data), [data]);
  // Expand/collapse-all remounts the body subtree with a new `expandTo` (a huge
  // value to open every level, 0 to close to the root) + a fresh key so every
  // node re-derives its initial open state. No cross-tree state plumbing.
  const baseDepth = Math.max(0, defaultExpandDepth);
  const [expandTo, setExpandTo] = useState(baseDepth);
  const [bodyKey, setBodyKey] = useState(0);
  const [copied, setCopied] = useState(false);

  const rootBranch = isBranch(data);

  const copy = useCallback(() => {
    let text: string;
    try {
      text = typeof data === "string" ? data : JSON.stringify(data, safeReplacer(), 2);
    } catch {
      text = String(data);
    }
    void navigator.clipboard?.writeText(text).then(
      () => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1400);
      },
      () => {},
    );
  }, [data]);

  const setAll = useCallback((open: boolean) => {
    setExpandTo(open ? Number.MAX_SAFE_INTEGER : 0);
    setBodyKey((k) => k + 1);
  }, []);

  return (
    <div className="jt" role="tree" aria-label={`${rootLabel} (${nodes} nodes)`}>
      <div className="jt-head">
        <span className="jt-head-label">{rootLabel}</span>
        <span className="jt-head-count">
          {nodes} {nodes === 1 ? "node" : "nodes"} · {leaves} {leaves === 1 ? "leaf" : "leaves"}
        </span>
        <span className="jt-head-actions">
          {rootBranch ? (
            <>
              <button type="button" className="jt-act" onClick={() => setAll(true)} title="Expand all">
                expand
              </button>
              <button type="button" className="jt-act" onClick={() => setAll(false)} title="Collapse all">
                collapse
              </button>
            </>
          ) : null}
          <button type="button" className="jt-act" onClick={copy} title="Copy JSON">
            {copied ? "copied" : "copy"}
          </button>
        </span>
      </div>
      <div className="jt-body" key={bodyKey}>
        <Node
          value={data}
          depth={0}
          expandTo={expandTo}
          maxInitial={Math.max(1, maxInitialNodes)}
          seen={[]}
          i={0}
        />
      </div>
    </div>
  );
}

/* A JSON.stringify replacer that drops circular refs (for the copy button) so
   copying a self-referential payload never throws. */
function safeReplacer() {
  const seen = new WeakSet<object>();
  return function (this: unknown, _k: string, v: unknown) {
    if (v && typeof v === "object") {
      if (seen.has(v as object)) return "[circular]";
      seen.add(v as object);
    }
    if (typeof v === "bigint") return `${v}n`;
    if (typeof v === "function" || typeof v === "symbol") return `[${typeof v}]`;
    return v;
  };
}

export default JsonTree;
