/* Parse render progress lines into a single percent + label. Mirrors the
   dashboard's lib/progress.ts (the two can't share a module across the
   engine/dashboard boundary) — keep them in sync. Used by the `content jobs`
   consolidated fleet view. */

export type Parsed = { pct: number | null; label: string; chapter?: { n: number; total: number }; indeterminate: boolean };

export function parseProgress(lines: string[], status?: string): Parsed {
  const clean = (lines ?? []).filter(Boolean);
  const last = clean[clean.length - 1] ?? "";
  if (status === "done") return { pct: 100, label: "done", indeterminate: false };
  if (status === "error") return { pct: null, label: last || "error", indeterminate: false };

  let renderPct: number | null = null;
  let chapter: { n: number; total: number } | undefined;
  for (let i = clean.length - 1; i >= 0; i--) {
    const l = clean[i];
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

  if (chapter && chapter.total > 0) {
    const within = renderPct !== null ? renderPct / 100 : 0;
    const pct = Math.max(0, Math.min(99, Math.round(((chapter.n - 1 + within) / chapter.total) * 100)));
    const label = `chapter ${chapter.n}/${chapter.total}${renderPct !== null ? ` · ${renderPct}%` : ` · ${shortPhase(last)}`}`;
    return { pct, label, chapter, indeterminate: false };
  }
  if (renderPct !== null) return { pct: renderPct, label: `rendering ${renderPct}%`, indeterminate: false };
  return { pct: null, label: shortPhase(last) || "queued", indeterminate: true };
}

function shortPhase(line: string): string {
  return line.replace(/\s+/g, " ").replace(/^[▶⏳✓•\s]+/, "").trim().slice(0, 64);
}
