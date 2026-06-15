"use client";
import { useEffect, useState } from "react";

/* Reusable live "AI is working" indicator — shimmering skeleton lines that read
   as text streaming in, a phase caption that advances, and an elapsed timer. Use
   it anywhere an AI generation is in flight so it feels live, never frozen. */
export function AiThinking({ phases, lines = 3 }: { phases: string[]; lines?: number }) {
  const [i, setI] = useState(0);
  const [t0] = useState(() => Date.now());
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const p = setInterval(() => setI((x) => Math.min(phases.length - 1, x + 1)), 3200);
    const e = setInterval(() => setElapsed(Math.round((Date.now() - t0) / 1000)), 500);
    return () => { clearInterval(p); clearInterval(e); };
  }, [phases.length, t0]);
  const widths = [94, 80, 88, 66, 90, 74];
  return (
    <div className="ai-think" role="status" aria-live="polite">
      <div className="ai-think-head">
        <span className="ai-think-dot" />
        {phases[i] ?? "Working…"}
        <span className="ai-think-el">{elapsed}s</span>
      </div>
      <div className="ai-think-lines">
        {Array.from({ length: lines }).map((_, k) => (
          <div key={k} className="ai-think-line" style={{ width: `${widths[k % widths.length]}%`, animationDelay: `${k * 0.12}s` }} />
        ))}
      </div>
    </div>
  );
}
