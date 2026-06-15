import "server-only";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "./data";

/* Web-search providers (Tavily / Brave / SerpAPI) the research harness uses.
   Keys are persisted to data/search-providers/<ws>.json in the SAME shape the
   engine's websearch.ts reads (env wins, then this store) — so a key pasted here
   works for the engine, and rides the normal data/ sync out to the fleet.
   open-websearch is the keyless scraper fallback and is always "available". */

export type SearchProviderId = "tavily" | "brave" | "serpapi" | "open-websearch";

type StoredSearchProvider = { id: SearchProviderId; apiKey?: string; enabled: boolean; connectedAt?: string; updatedAt?: string };

export type SearchProviderStatus = {
  id: SearchProviderId;
  label: string;
  configured: boolean;
  keyless: boolean;
  source: "workspace" | "env" | "none";
  keyPreview?: string;
  connectedAt?: string;
  note?: string;
  docsUrl?: string;
};

const DIR = join(REPO_ROOT, "data", "search-providers");
const sani = (s: string) => (s || "ws_default").replace(/[^a-zA-Z0-9_-]/g, "-");
const fileFor = (workspaceId: string) => join(DIR, `${sani(workspaceId)}.json`);
const now = () => new Date().toISOString();

const KEYABLE: Exclude<SearchProviderId, "open-websearch">[] = ["tavily", "brave", "serpapi"];
const LABELS: Record<SearchProviderId, string> = {
  tavily: "Tavily",
  brave: "Brave Search",
  serpapi: "SerpAPI",
  "open-websearch": "Open WebSearch (scraper)",
};
const ENV_NAME: Record<Exclude<SearchProviderId, "open-websearch">, string> = {
  tavily: "TAVILY_API_KEY",
  brave: "BRAVE_API_KEY",
  serpapi: "SERPAPI_API_KEY",
};
const DOCS: Record<SearchProviderId, string | undefined> = {
  tavily: "https://app.tavily.com",
  brave: "https://brave.com/search/api/",
  serpapi: "https://serpapi.com/manage-api-key",
  "open-websearch": undefined,
};
const NOTES: Record<SearchProviderId, string | undefined> = {
  tavily: "Research-grade search built for LLMs. Recommended primary.",
  brave: "Independent web index. Generous free tier.",
  serpapi: "Google results via proxy.",
  "open-websearch": "Keyless multi-engine scraper — the always-on fallback (run the local MCP server).",
};

export const SEARCH_PROVIDER_IDS = new Set<string>(["tavily", "brave", "serpapi", "open-websearch"]);
export const isSearchProvider = (id: string): id is SearchProviderId => SEARCH_PROVIDER_IDS.has(id);

function readStore(workspaceId: string): StoredSearchProvider[] {
  try {
    const p = fileFor(workspaceId);
    if (!existsSync(p)) return [];
    const raw = JSON.parse(readFileSync(p, "utf8"));
    return Array.isArray(raw?.providers) ? raw.providers : [];
  } catch {
    return [];
  }
}

function writeStore(workspaceId: string, providers: StoredSearchProvider[]): void {
  mkdirSync(DIR, { recursive: true });
  const p = fileFor(workspaceId);
  const tmp = `${p}.tmp`;
  writeFileSync(tmp, JSON.stringify({ workspaceId, providers }, null, 2), { mode: 0o600 });
  renameSync(tmp, p);
}

const preview = (s?: string): string | undefined => (!s ? undefined : s.length <= 6 ? "set" : `...${s.slice(-6)}`);

export function searchProviderStatuses(workspaceId: string): SearchProviderStatus[] {
  const stored = readStore(workspaceId);
  return (Object.keys(LABELS) as SearchProviderId[]).map((id) => {
    const base = { id, label: LABELS[id], docsUrl: DOCS[id], note: NOTES[id] };
    if (id === "open-websearch") return { ...base, configured: true, keyless: true, source: "none" as const };
    const k = id as Exclude<SearchProviderId, "open-websearch">;
    const env = process.env[ENV_NAME[k]];
    if (env) return { ...base, configured: true, keyless: false, source: "env" as const, keyPreview: preview(env) };
    const s = stored.find((p) => p.id === id && p.enabled !== false && p.apiKey);
    if (s) return { ...base, configured: true, keyless: false, source: "workspace" as const, keyPreview: preview(s.apiKey), connectedAt: s.connectedAt };
    return { ...base, configured: false, keyless: false, source: "none" as const };
  });
}

export function setSearchProviderKey(workspaceId: string, id: SearchProviderId, apiKey: string): void {
  if (!KEYABLE.includes(id as Exclude<SearchProviderId, "open-websearch">)) throw new Error(`${id} takes no key`);
  const providers = readStore(workspaceId).filter((p) => p.id !== id);
  providers.push({ id, enabled: true, apiKey, connectedAt: now(), updatedAt: now() });
  writeStore(workspaceId, providers);
}

export function clearSearchProvider(workspaceId: string, id: SearchProviderId): boolean {
  const before = readStore(workspaceId);
  const after = before.filter((p) => p.id !== id);
  if (!after.length) rmSync(fileFor(workspaceId), { force: true });
  else writeStore(workspaceId, after);
  return after.length !== before.length;
}
