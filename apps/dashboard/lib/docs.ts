import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "./data";

const DOCS = join(REPO_ROOT, "docs");

/* Curated order + titles for the in-app docs (mirrors docs/). */
export const DOC_NAV: { slug: string; title: string; blurb: string }[] = [
  { slug: "overview", title: "Overview", blurb: "What Socheli is and the API-first product stack." },
  { slug: "quickstart", title: "Quickstart", blurb: "Three ways in — CLI, SDK, MCP." },
  { slug: "architecture", title: "Architecture", blurb: "Engine → API → SDK → CLI/MCP; control/data split." },
  { slug: "authentication", title: "Authentication", blurb: "One Bearer API key across every surface." },
  { slug: "api", title: "API Reference", blurb: "Every REST endpoint, auth, and the data model." },
  { slug: "sdk", title: "TypeScript SDK", blurb: "Typed, zero-dep createSocheli() client." },
  { slug: "cli", title: "CLI", blurb: "The socheli command-line." },
  { slug: "mcp", title: "MCP Server", blurb: "Drive Socheli from Claude — 6 MCP tools." },
  { slug: "harness", title: "Agent Harness", blurb: "Drive Socheli from any harness — and let Socheli drive harnesses as worker brains." },
  { slug: "calendar", title: "Calendar & Plan", blurb: "Curate the content plan — plan_* tools across every surface." },
  { slug: "posting-times", title: "Posting Times", blurb: "When to post — best-time strategy that learns from feedback." },
  { slug: "fleet", title: "Fleet", blurb: "Devices, capabilities, routing." },
  { slug: "deployment", title: "Deployment", blurb: "Hosted topology + services." },
  { slug: "agent-harness", title: "Harness Spec (Soli OS)", blurb: "The design contract — genome, research, runtimes, missions." },
];

/* Slugs whose markdown file doesn't follow the lowercase `<slug>.md` pattern.
   Needed on case-sensitive filesystems (the hosted dashboard runs on Linux). */
const DOC_FILES: Record<string, string> = {
  "agent-harness": "AGENT-HARNESS.md",
};

export function docTitle(slug: string): string {
  return DOC_NAV.find((d) => d.slug === slug)?.title ?? slug;
}

export function getDoc(slug: string): string | null {
  if (!/^[a-z0-9-]+$/.test(slug)) return null;
  const p = join(DOCS, DOC_FILES[slug] ?? `${slug}.md`);
  if (!existsSync(p)) return null;
  // strip the centered logo/header block from the root README if ever loaded
  return readFileSync(p, "utf8");
}

export function listDocSlugs(): string[] {
  if (!existsSync(DOCS)) return [];
  return readdirSync(DOCS).filter((f) => f.endsWith(".md")).map((f) => f.replace(/\.md$/, ""));
}
