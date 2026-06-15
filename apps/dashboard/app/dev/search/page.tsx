"use client";
import { useEffect, useState } from "react";
import { HyperSearch } from "../../HyperSearch";

/* Dev-only visual harness for the global HyperSearch palette. NOT linked from
   any nav, no tenant data: it stubs window.EventSource so the REAL HyperSearch
   component + hyper-search.css render against a fixed sample of staged results,
   letting us screenshot the harness mid-search and settled. Production
   /api/search stays untouched and Clerk-gated. */

type Hit = { source: string; id: string; title: string; snippet?: string; href: string; meta?: string; score: number };
type Stage = { source: string; label: string; scanned: number; hits: Hit[]; more: number };

const FIXTURE: Stage[] = [
  { source: "pages", label: "scanning pages…", scanned: 26, more: 0, hits: [
    { source: "pages", id: "/research", title: "Research", snippet: "Verified deep research", href: "/research", meta: "Create", score: 65 },
    { source: "pages", id: "/creative-lab", title: "Creative Lab", snippet: "Observation inventory", href: "/creative-lab", meta: "Create", score: 50 },
  ]},
  { source: "content", label: "scanning content…", scanned: 59, more: 2, hits: [
    { source: "content", id: "claude_20260605080644", title: "Context window pollution: why full-repo dumps degrade reasoning", snippet: "More context is making Claude Code dumber — here's the fix", href: "/post/claude_20260605080644", meta: "claude_code_lab · packaged", score: 50 },
    { source: "content", id: "claude_20260605103856", title: "The research harness pattern for agentic content", snippet: "…a verified research sweep feeds strategy…", href: "/post/claude_20260605103856", meta: "claude_code_lab · rendered", score: 28 },
  ]},
  { source: "chats", label: "scanning chats… (3 threads)", scanned: 3, more: 0, hits: [
    { source: "chats", id: "thr_001", title: "Planning the research harness", snippet: "…can we make the search process visible like the research run…", href: "/?thread=thr_001", meta: "12 messages", score: 65 },
  ]},
  { source: "brands", label: "scanning brands…", scanned: 2, more: 0, hits: [
    { source: "brands", id: "claude_code_lab", title: "Code Labrinox", snippet: "Developers shipping with AI · code", href: "/channels?brand=claude_code_lab", meta: "claude_code_lab", score: 18 },
  ]},
  { source: "missions", label: "scanning missions…", scanned: 1, more: 0, hits: [
    { source: "missions", id: "mis_001", title: "Grow the dev channel with daily research-backed reels", snippet: "…daily research-backed reels…", href: "/missions?mission=mis_001", meta: "claude_code_lab · active", score: 28 },
  ]},
];

/* A minimal EventSource stub matching the real /api/search SSE contract:
   start → stage (per corpus, spaced) → done. STEP_MS makes the harness visibly
   ignite one stage at a time so the mid-search frame is screenshotable. */
function installStub(stepMs: number) {
  class StubES {
    onerror: ((e: unknown) => void) | null = null;
    private listeners: Record<string, ((e: MessageEvent) => void)[]> = {};
    private timers: ReturnType<typeof setTimeout>[] = [];
    constructor(_url: string) {
      this.timers.push(setTimeout(() => this.emit("start", { total: FIXTURE.length }), 20));
      FIXTURE.forEach((stage, i) => {
        this.timers.push(setTimeout(() => this.emit("stage", stage), 20 + stepMs * (i + 1)));
      });
      this.timers.push(setTimeout(() => this.emit("done", {}), 20 + stepMs * (FIXTURE.length + 1)));
    }
    addEventListener(type: string, fn: (e: MessageEvent) => void) {
      (this.listeners[type] ??= []).push(fn);
    }
    private emit(type: string, data: unknown) {
      const ev = { data: JSON.stringify(data) } as MessageEvent;
      (this.listeners[type] || []).forEach((fn) => fn(ev));
    }
    close() {
      this.timers.forEach(clearTimeout);
    }
  }
  (window as unknown as { EventSource: unknown }).EventSource = StubES;
}

export default function DevSearchPage() {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    // STEP_MS large so the harness stays mid-search long enough to screenshot.
    installStub(900);
    setReady(true);
    // Auto-open the palette on mount.
    requestAnimationFrame(() => window.dispatchEvent(new CustomEvent("hypersearch:open")));
  }, []);
  return (
    <div style={{ minHeight: "100vh", background: "#0a0a0a", padding: 40, color: "#ECE6D8" }}>
      <p style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "#5f5f5f" }}>
        /dev/search — HyperSearch visual harness (stubbed SSE, no tenant data). Press ⌘/ to reopen.
      </p>
      {ready && <HyperSearch />}
    </div>
  );
}
