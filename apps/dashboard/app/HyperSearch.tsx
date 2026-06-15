"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  LayoutDashboard, ListVideo, MessageSquare, Palette, Target, type LucideIcon,
} from "lucide-react";
import { InkCheckIcon, SparkMark } from "../components/sketch";

/* HyperSearch — the global command palette / spotlight in the app header.
   SEPARATE from Soli (⌘K); this is bound to ⌘/ (Ctrl+/). It searches EVERYTHING
   across the workspace — nav pages, content runs, chats, brands, missions — and
   shows the search as a VISIBLE step-by-step harness: each corpus ignites as its
   own stage node that ticks to ✓ as results stream in under it (SSE from
   /api/search). Reduced-motion → one instant grouped dump (mode=json).

   Keyboard: type to query (debounced), ↑/↓ move across all groups, Enter opens
   the active hit, Esc / outside-click closes. Focus is trapped to the input. */

type SearchSource = "pages" | "content" | "chats" | "brands" | "missions";
type SearchHit = {
  source: SearchSource;
  id: string;
  title: string;
  snippet?: string;
  href: string;
  meta?: string;
  score: number;
};
type SearchStage = {
  source: SearchSource;
  label: string;
  scanned: number;
  hits: SearchHit[];
  more: number;
};
type StageState = SearchStage & { done: boolean };

const SOURCE_META: Record<SearchSource, { label: string; icon: LucideIcon }> = {
  pages: { label: "Pages", icon: LayoutDashboard },
  content: { label: "Content", icon: ListVideo },
  chats: { label: "Chats", icon: MessageSquare },
  brands: { label: "Brands", icon: Palette },
  missions: { label: "Missions", icon: Target },
};
const ORDER: SearchSource[] = ["pages", "content", "chats", "brands", "missions"];

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}

export function HyperSearch() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [stages, setStages] = useState<StageState[]>([]);
  const [running, setRunning] = useState(false);
  const [active, setActive] = useState(0); // index into the FLAT list of visible hits
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const esRef = useRef<EventSource | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // ── open / close, bound to ⌘/ (Ctrl+/) — distinct from Soli's ⌘K ──────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "/") {
        e.preventDefault();
        setOpen((v) => !v);
      }
    };
    const onOpen = () => setOpen(true);
    window.addEventListener("keydown", onKey);
    window.addEventListener("hypersearch:open", onOpen);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("hypersearch:open", onOpen);
    };
  }, []);

  // Reset + focus on open; tear down any running stream on close.
  useEffect(() => {
    if (open) {
      setActive(0);
      requestAnimationFrame(() => inputRef.current?.focus());
    } else {
      setQ("");
      setStages([]);
      setRunning(false);
      esRef.current?.close();
      esRef.current = null;
      abortRef.current?.abort();
      abortRef.current = null;
    }
  }, [open]);

  // ── the search itself — debounced, streamed as a staged harness ───────────
  const runSearch = useCallback((query: string) => {
    esRef.current?.close();
    esRef.current = null;
    abortRef.current?.abort();
    abortRef.current = null;
    const trimmed = query.trim();
    if (!trimmed) {
      setStages([]);
      setRunning(false);
      return;
    }
    setActive(0);

    // Reduced motion → one instant grouped fetch, no stage choreography.
    if (prefersReducedMotion()) {
      setRunning(true);
      const ac = new AbortController();
      abortRef.current = ac;
      fetch(`/api/search?mode=json&q=${encodeURIComponent(trimmed)}`, { signal: ac.signal })
        .then((r) => r.json())
        .then((d: { stages: SearchStage[] }) => {
          setStages((d.stages || []).map((s) => ({ ...s, done: true })));
          setRunning(false);
        })
        .catch(() => setRunning(false));
      return;
    }

    // Seed all stage nodes as pending so the harness skeleton appears instantly,
    // then each fills + ticks as its SSE event lands.
    setStages(ORDER.map((source) => ({ source, label: `scanning ${SOURCE_META[source].label.toLowerCase()}…`, scanned: 0, hits: [], more: 0, done: false })));
    setRunning(true);

    const es = new EventSource(`/api/search?q=${encodeURIComponent(trimmed)}`);
    esRef.current = es;
    es.addEventListener("stage", (ev) => {
      const stage = JSON.parse((ev as MessageEvent).data) as SearchStage;
      setStages((prev) => prev.map((s) => (s.source === stage.source ? { ...stage, done: true } : s)));
    });
    es.addEventListener("done", () => {
      setRunning(false);
      es.close();
      esRef.current = null;
    });
    es.onerror = () => {
      setRunning(false);
      es.close();
      esRef.current = null;
    };
  }, []);

  // Debounce ~150ms on every keystroke.
  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => runSearch(q), 150);
    return () => clearTimeout(t);
  }, [q, open, runSearch]);

  // The flat, ordered list of currently-visible hits (used for ↑/↓ + Enter).
  const flatHits = useMemo<SearchHit[]>(
    () => ORDER.flatMap((src) => stages.find((s) => s.source === src)?.hits ?? []),
    [stages],
  );

  const go = useCallback(
    (hit: SearchHit | undefined) => {
      if (!hit) return;
      setOpen(false);
      router.push(hit.href);
    },
    [router],
  );

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, Math.max(0, flatHits.length - 1)));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      go(flatHits[active]);
    }
  };

  // Keep the active row scrolled into view.
  useEffect(() => {
    if (!open) return;
    listRef.current?.querySelector<HTMLElement>('[data-active="true"]')?.scrollIntoView({ block: "nearest" });
  }, [active, open]);

  if (!open) return null;

  const totalHits = flatHits.length;
  let flatIdx = -1; // running index so each row knows its place in the flat list

  return (
    <div className="hs-backdrop" onMouseDown={() => setOpen(false)} role="presentation">
      <div
        className="hs-card ink-card"
        role="dialog"
        aria-modal="true"
        aria-label="Search everything"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <span className="hs-tick hs-tick-tl" aria-hidden /><span className="hs-tick hs-tick-tr" aria-hidden />
        <span className="hs-tick hs-tick-bl" aria-hidden /><span className="hs-tick hs-tick-br" aria-hidden />

        <div className="hs-input-row">
          <SparkMark size={16} className="hs-spark" />
          <input
            ref={inputRef}
            className="hs-input"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search pages, content, chats, brands, missions…"
            aria-label="Search query"
            spellCheck={false}
            autoComplete="off"
          />
          {running && <span className="hs-running" aria-hidden>searching</span>}
          <kbd className="hs-kbd">Esc</kbd>
        </div>

        <div className="hs-body" ref={listRef}>
          {!q.trim() && (
            <p className="hs-empty">Type to search everything across your workspace — the harness scans each corpus in turn.</p>
          )}

          {q.trim() &&
            ORDER.map((src) => {
              const stage = stages.find((s) => s.source === src);
              if (!stage) return null;
              const meta = SOURCE_META[src];
              const StageIcon = meta.icon;
              const hasHits = stage.hits.length > 0;
              // Hide settled empty groups so the result list stays clean — but keep
              // a still-running stage node visible so the harness reads as live.
              if (stage.done && !hasHits) {
                return (
                  <div key={src} className="hs-stage hs-stage-empty">
                    <span className="hs-stage-node hs-stage-done"><InkCheckIcon size={11} /></span>
                    <span className="hs-stage-label">{meta.label}</span>
                    <span className="hs-stage-count">no matches</span>
                  </div>
                );
              }
              return (
                <div key={src} className="hs-group">
                  <div className={`hs-stage${stage.done ? " hs-stage-done-row" : " hs-stage-pending"}`}>
                    <span className={`hs-stage-node${stage.done ? " hs-stage-done" : ""}`}>
                      {stage.done ? <InkCheckIcon size={11} /> : <span className="hs-stage-pulse" />}
                    </span>
                    <StageIcon size={12} className="hs-stage-glyph" strokeWidth={1.8} />
                    <span className="hs-stage-label">{stage.done ? meta.label : stage.label}</span>
                    {stage.done && (
                      <span className="hs-stage-count">
                        {stage.hits.length}
                        {stage.more > 0 ? `+${stage.more}` : ""} · {stage.scanned} scanned
                      </span>
                    )}
                  </div>
                  {stage.hits.map((hit) => {
                    flatIdx += 1;
                    const idx = flatIdx;
                    const isActive = idx === active;
                    return (
                      <button
                        key={`${src}-${hit.id}`}
                        type="button"
                        className="hs-hit"
                        data-active={isActive}
                        onMouseEnter={() => setActive(idx)}
                        onClick={() => go(hit)}
                      >
                        <StageIcon size={14} className="hs-hit-icon" strokeWidth={1.7} />
                        <span className="hs-hit-text">
                          <span className="hs-hit-title">{hit.title}</span>
                          {hit.snippet && <span className="hs-hit-snippet">{hit.snippet}</span>}
                        </span>
                        {hit.meta && <span className="hs-hit-meta">{hit.meta}</span>}
                      </button>
                    );
                  })}
                  {stage.done && stage.more > 0 && (
                    <div className="hs-more">+{stage.more} more in {meta.label}</div>
                  )}
                </div>
              );
            })}

          {q.trim() && !running && totalHits === 0 && (
            <p className="hs-empty">No matches for “{q.trim()}”.</p>
          )}
        </div>

        <div className="hs-foot">
          <span><kbd className="hs-kbd-sm">↑↓</kbd> navigate</span>
          <span><kbd className="hs-kbd-sm">↵</kbd> open</span>
          <span><kbd className="hs-kbd-sm">esc</kbd> close</span>
        </div>
      </div>
    </div>
  );
}
