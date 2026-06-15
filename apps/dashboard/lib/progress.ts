/* Parse a fleet job's progress lines into a single live percent + label.

   The render device streams human lines like "rendering 65% (1616 frames)" and,
   for long-form, "chapter 3/7: ...". This turns the tail of that stream into a
   coarse overall percent + a short label, shared by the queue strip and the post
   page so "how far along is this render" reads the same everywhere. */

export type JobProgress = { pct: number | null; label: string; chapter?: { n: number; total: number }; indeterminate: boolean };

type Line = { line: string } | string;
const text = (l: Line) => (typeof l === "string" ? l : l.line);

export function parseProgress(progress: Line[] | undefined, status?: string): JobProgress {
  const lines = (progress ?? []).map(text).filter(Boolean);
  const last = lines[lines.length - 1] ?? "";

  // terminal states win — no live percent
  if (status === "done") return { pct: 100, label: "done", indeterminate: false };
  if (status === "error") return { pct: null, label: last || "error", indeterminate: false };

  // scan from the end for the freshest render % and chapter marker
  let renderPct: number | null = null;
  let chapter: { n: number; total: number } | undefined;
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i];
    if (renderPct === null) {
      const m = l.match(/rendering\s+(\d+)\s*%/i) || l.match(/\b(\d+)%\s*\(\d+\s*frames?\)/i);
      if (m) renderPct = Math.min(100, Number(m[1]));
    }
    if (!chapter) {
      const c = l.match(/chapter\s+(\d+)\s*\/\s*(\d+)/i);
      if (c) chapter = { n: Number(c[1]), total: Number(c[2]) };
    }
    if (renderPct !== null && chapter) break;
  }

  // long-form: blend chapter index + within-chapter render % into one bar
  if (chapter && chapter.total > 0) {
    const within = renderPct !== null ? renderPct / 100 : 0;
    const pct = Math.max(0, Math.min(99, Math.round(((chapter.n - 1 + within) / chapter.total) * 100)));
    const label = `chapter ${chapter.n}/${chapter.total}${renderPct !== null ? ` · ${renderPct}%` : ` · ${shortPhase(last)}`}`;
    return { pct, label, chapter, indeterminate: false };
  }

  // short-form: the render percent is the whole bar
  if (renderPct !== null) return { pct: renderPct, label: `rendering ${renderPct}%`, indeterminate: false };

  // pre-render phase (research / script / voice / music) — no percent yet
  return { pct: null, label: shortPhase(last) || "queued", indeterminate: true };
}

// trim a raw progress line to a compact phase label
function shortPhase(line: string): string {
  return line.replace(/\s+/g, " ").replace(/^[▶⏳✓•\s]+/, "").trim().slice(0, 60);
}
