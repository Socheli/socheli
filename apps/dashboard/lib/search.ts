import "server-only";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { NAV, HOME, WAR_ROOM, PRIMARY } from "../app/nav";
import { REPO_ROOT, listItemsFor } from "./data";
import { listBrands } from "./brands";
import { listMissionsFor } from "./missions";

/* ── Hyper-search index ──────────────────────────────────────────────────────
   The server-side corpus the global command palette searches. Everything is a
   plain file read (no DB), tenant-scoped through the workspace id the route
   resolves from the session. Each scanner returns a flat list of SearchHit; the
   route runs them as named STAGES so the palette can choreograph the search as a
   visible step-by-step harness.

   SECURITY: results carry only display-safe fields (title/snippet/href) — never
   secrets, file paths, tokens or another workspace's records. Chat transcripts
   are read directly off disk here (data/chats/<ws>/*.json) rather than importing
   another builder's module, but stay strictly inside the caller's workspace dir. */

export type SearchSource = "pages" | "content" | "chats" | "brands" | "missions";

export type SearchHit = {
  source: SearchSource;
  id: string;
  title: string;
  snippet?: string; // matched context line / description
  href: string; // where Enter navigates
  meta?: string; // small mono tag (status / channel / count)
  score: number; // match quality — title hits rank above body hits
};

export type SearchStage = {
  source: SearchSource;
  label: string; // "scanning content…"
  scanned: number; // how many records the stage looked at (shown in the harness)
  hits: SearchHit[];
  more: number; // hits beyond the per-group cap
};

const PER_GROUP = 6;

/* ── ranking ──────────────────────────────────────────────────────────────
   A tiny case-insensitive scorer. A title match outranks a body match; an exact
   word / prefix outranks a mid-string substring. Non-matches score 0. */
function score(query: string, title: string, body?: string): number {
  const q = query.toLowerCase().trim();
  if (!q) return 0;
  const t = title.toLowerCase();
  let s = 0;
  if (t === q) s = 100;
  else if (t.startsWith(q)) s = 80;
  else if (new RegExp(`\\b${escapeRe(q)}`).test(t)) s = 65;
  else if (t.includes(q)) s = 50;
  if (s === 0 && body) {
    const b = body.toLowerCase();
    if (new RegExp(`\\b${escapeRe(q)}`).test(b)) s = 28;
    else if (b.includes(q)) s = 18;
  }
  return s;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/* Pull the first body line that contains the query, trimmed to a snippet. */
function matchLine(query: string, lines: (string | undefined)[], fallback?: string): string | undefined {
  const q = query.toLowerCase().trim();
  for (const raw of lines) {
    if (!raw) continue;
    if (raw.toLowerCase().includes(q)) {
      const i = raw.toLowerCase().indexOf(q);
      const start = Math.max(0, i - 32);
      const out = (start > 0 ? "…" : "") + raw.slice(start, start + 120).trim();
      return out.length > 124 ? out.slice(0, 124) + "…" : out;
    }
  }
  return fallback ? fallback.slice(0, 120) : undefined;
}

function rankCap(hits: SearchHit[]): { hits: SearchHit[]; more: number } {
  const sorted = hits.filter((h) => h.score > 0).sort((a, b) => b.score - a.score);
  return { hits: sorted.slice(0, PER_GROUP), more: Math.max(0, sorted.length - PER_GROUP) };
}

/* ── pages: the static nav list (mirrors nav.tsx, imported read-only) ──────── */
type Page = { href: string; label: string; desc?: string; section?: string };
const PAGES: Page[] = [
  { href: HOME.href, label: HOME.label, desc: HOME.desc },
  { href: WAR_ROOM.href, label: WAR_ROOM.label, desc: WAR_ROOM.desc },
  { href: PRIMARY.href, label: PRIMARY.label, desc: PRIMARY.desc, section: "Create" },
  ...NAV.flatMap((s) => s.links.map((l) => ({ href: l.href, label: l.label, desc: l.desc, section: s.section }))),
];

function scanPages(query: string): SearchStage {
  const hits: SearchHit[] = PAGES.map((p) => ({
    source: "pages" as const,
    id: p.href,
    title: p.label,
    snippet: p.desc,
    href: p.href,
    meta: p.section,
    score: score(query, p.label, p.desc),
  }));
  const { hits: capped, more } = rankCap(hits);
  return { source: "pages", label: "scanning pages…", scanned: PAGES.length, hits: capped, more };
}

/* ── content: data/runs/*.json (workspace-scoped via listItemsFor) ─────────── */
function scanContent(query: string, workspaceId: string): SearchStage {
  const items = listItemsFor(workspaceId);
  const hits: SearchHit[] = items.map((it) => {
    const topic = it.idea?.topic || it.seedIdea || it.id;
    const body = [it.seedIdea, it.idea?.angle, it.script?.hook, it.pkg?.title, it.pkg?.caption]
      .filter(Boolean)
      .join("  ·  ");
    return {
      source: "content" as const,
      id: it.id,
      title: topic,
      snippet: matchLine(query, [it.seedIdea, it.idea?.angle, it.script?.hook, it.pkg?.caption], it.idea?.angle),
      href: `/post/${it.id}`,
      meta: [it.channel, it.status].filter(Boolean).join(" · "),
      score: score(query, topic, body),
    };
  });
  const { hits: capped, more } = rankCap(hits);
  return { source: "content", label: "scanning content…", scanned: items.length, hits: capped, more };
}

/* ── chats: data/chats/<ws>/*.json read directly (no cross-builder import) ───
   We only ever read the caller's own workspace directory; the id is sanitized
   the same way the chats store sanitizes it on write, so the path can't escape. */
type RawThread = {
  id?: string;
  title?: string;
  updatedAt?: number;
  messages?: { role?: string; content?: string }[];
};

function scanChats(query: string, workspaceId: string): SearchStage {
  const sani = (workspaceId || "ws_default").replace(/[^a-zA-Z0-9_-]/g, "-");
  const dir = join(REPO_ROOT, "data", "chats", sani);
  let files: string[] = [];
  try {
    if (existsSync(dir)) files = readdirSync(dir).filter((f) => f.endsWith(".json") && !f.startsWith("_"));
  } catch {
    files = [];
  }
  const hits: SearchHit[] = [];
  for (const f of files) {
    let t: RawThread;
    try {
      t = JSON.parse(readFileSync(join(dir, f), "utf8")) as RawThread;
    } catch {
      continue;
    }
    if (!t?.id) continue;
    const title = (t.title || "").trim() || "Untitled chat";
    const msgs = Array.isArray(t.messages) ? t.messages : [];
    const lines = msgs.map((m) => (typeof m?.content === "string" ? m.content : "")).filter(Boolean);
    const body = lines.join("  ");
    const s = score(query, title, body);
    if (s === 0) continue;
    hits.push({
      source: "chats",
      id: t.id,
      title,
      snippet: matchLine(query, lines),
      // Deep-link home with the thread id. NOTE: the home page does not yet read
      // ?thread to activate it (useAgent is owned by another builder) — this lands
      // on Soli and leaves a TODO for the home page to hydrate ?thread on mount.
      href: `/?thread=${encodeURIComponent(t.id)}`,
      meta: `${msgs.length} message${msgs.length === 1 ? "" : "s"}`,
      score: s,
    });
  }
  const { hits: capped, more } = rankCap(hits);
  return { source: "chats", label: `scanning chats… (${files.length} thread${files.length === 1 ? "" : "s"})`, scanned: files.length, hits: capped, more };
}

/* ── brands: data/brands.json via listBrands (workspace-scoped) ────────────── */
function scanBrands(query: string, workspaceId: string): SearchStage {
  const brands = listBrands(workspaceId);
  const hits: SearchHit[] = brands.map((b) => {
    const desc = [b.audience, b.domain].filter(Boolean).join(" · ");
    return {
      source: "brands" as const,
      id: b.id,
      title: b.name,
      snippet: matchLine(query, [b.audience, b.domain], desc),
      href: `/channels?brand=${encodeURIComponent(b.id)}`,
      meta: b.id,
      score: score(query, b.name, [b.id, b.audience, b.domain].filter(Boolean).join(" ")),
    };
  });
  const { hits: capped, more } = rankCap(hits);
  return { source: "brands", label: "scanning brands…", scanned: brands.length, hits: capped, more };
}

/* ── missions: data/missions.json via listMissionsFor (workspace-scoped) ───── */
function scanMissions(query: string, workspaceId: string): SearchStage {
  const missions = listMissionsFor(workspaceId);
  const hits: SearchHit[] = missions.map((m) => ({
    source: "missions" as const,
    id: m.id,
    title: m.goal || m.id,
    snippet: matchLine(query, [m.goal], m.goal),
    href: `/missions?mission=${encodeURIComponent(m.id)}`,
    meta: [m.channel, m.status].filter(Boolean).join(" · "),
    score: score(query, m.goal || m.id, [m.goal, m.channel].filter(Boolean).join(" ")),
  }));
  const { hits: capped, more } = rankCap(hits);
  return { source: "missions", label: "scanning missions…", scanned: missions.length, hits: capped, more };
}

/* The ordered stage runners — the order the harness ignites them in. */
export function searchStages(query: string, workspaceId: string): SearchStage[] {
  const q = query.trim();
  if (!q) return [];
  return [
    scanPages(q),
    scanContent(q, workspaceId),
    scanChats(q, workspaceId),
    scanBrands(q, workspaceId),
    scanMissions(q, workspaceId),
  ];
}
