import { spawnSync } from "node:child_process";
import { writeFileSync, readFileSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DATA_DIR } from "./store.ts";

/* Real web search for the agents. A small cascade of pluggable providers:
     1. Tavily   — API, research-grade (TAVILY_API_KEY)
     2. Brave    — API, web search   (BRAVE_API_KEY)
     3. SerpAPI  — API, Google proxy (SERPAPI_API_KEY)
     4. open-websearch — a local keyless MCP scraper (multi-engine), the fallback
   Every provider returns [] on any failure so search never blocks generation.
   Keys resolve from the environment first, then from the workspace provider
   store the dashboard writes (data/search-providers/<ws>.json) — so a key pasted
   into the Providers UI works for the engine (and syncs across the fleet) without
   editing .env on every box. */

export type SearchResult = { title: string; url: string; description: string };
export type SearchProviderId = "tavily" | "brave" | "serpapi" | "open-websearch";

const OPEN_WEBSEARCH_URL = process.env.OPEN_WEBSEARCH_URL || "http://localhost:3000/mcp";
const STORE_DIR = join(DATA_DIR, "search-providers");
const ENV_NAME: Record<Exclude<SearchProviderId, "open-websearch">, string> = {
  tavily: "TAVILY_API_KEY",
  brave: "BRAVE_API_KEY",
  serpapi: "SERPAPI_API_KEY",
};

/* Resolve a provider's API key: env wins, then any workspace store file the
   dashboard wrote (data/search-providers/*.json — scanned so a non-default
   workspace's key still works for the engine). */
function keyFor(id: Exclude<SearchProviderId, "open-websearch">): string | undefined {
  const envKey = process.env[ENV_NAME[id]];
  if (envKey) return envKey;
  try {
    if (!existsSync(STORE_DIR)) return undefined;
    for (const f of readdirSync(STORE_DIR).filter((x) => x.endsWith(".json"))) {
      const raw = JSON.parse(readFileSync(join(STORE_DIR, f), "utf8")) as { providers?: { id: string; apiKey?: string; enabled?: boolean }[] };
      const row = (raw.providers ?? []).find((p) => p.id === id && p.enabled !== false && p.apiKey);
      if (row?.apiKey) return row.apiKey;
    }
  } catch {
    /* non-fatal */
  }
  return undefined;
}

/* curl POST/GET helper — returns raw stdout ("" on failure). */
function http(method: "GET" | "POST", url: string, opts: { headers?: string[]; body?: unknown } = {}): string {
  const args = ["-s", "-X", method, url];
  for (const h of opts.headers ?? []) args.push("-H", h);
  let bodyFile: string | undefined;
  if (opts.body !== undefined) {
    bodyFile = join(tmpdir(), `ws_${Math.random().toString(36).slice(2)}.json`);
    writeFileSync(bodyFile, JSON.stringify(opts.body));
    args.push("-H", "Content-Type: application/json", "-d", `@${bodyFile}`);
  }
  const r = spawnSync("curl", args, { encoding: "utf8", timeout: 30000, maxBuffer: 1 << 24 });
  if (bodyFile) rmSync(bodyFile, { force: true });
  return r.stdout || "";
}

/* ── providers ─────────────────────────────────────────────────────────────── */

function tavilySearch(query: string, limit: number): SearchResult[] {
  const key = keyFor("tavily");
  if (!key) return [];
  try {
    const raw = http("POST", "https://api.tavily.com/search", {
      headers: [`Authorization: Bearer ${key}`],
      body: { query, max_results: limit, search_depth: "basic", include_answer: false },
    });
    const data = JSON.parse(raw) as { results?: { title?: string; url?: string; content?: string }[] };
    return (data.results ?? [])
      .map((r) => ({ title: r.title ?? "", url: r.url ?? "", description: r.content ?? "" }))
      .filter((r) => r.title || r.description)
      .slice(0, limit);
  } catch {
    return [];
  }
}

function braveSearch(query: string, limit: number): SearchResult[] {
  const key = keyFor("brave");
  if (!key) return [];
  try {
    const raw = http("GET", `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${limit}`, {
      headers: ["Accept: application/json", `X-Subscription-Token: ${key}`],
    });
    const data = JSON.parse(raw) as { web?: { results?: { title?: string; url?: string; description?: string }[] } };
    return (data.web?.results ?? [])
      .map((r) => ({ title: r.title ?? "", url: r.url ?? "", description: r.description ?? "" }))
      .filter((r) => r.title || r.description)
      .slice(0, limit);
  } catch {
    return [];
  }
}

function serpapiSearch(query: string, limit: number): SearchResult[] {
  const key = keyFor("serpapi");
  if (!key) return [];
  try {
    const raw = http("GET", `https://serpapi.com/search.json?engine=google&num=${limit}&q=${encodeURIComponent(query)}&api_key=${key}`);
    const data = JSON.parse(raw) as { organic_results?: { title?: string; link?: string; snippet?: string }[] };
    return (data.organic_results ?? [])
      .map((r) => ({ title: r.title ?? "", url: r.link ?? "", description: r.snippet ?? "" }))
      .filter((r) => r.title || r.description)
      .slice(0, limit);
  } catch {
    return [];
  }
}

/* open-websearch: a local streamable-HTTP MCP scraper (no key). Minimal client. */
function openWebsearch(query: string, limit: number, engines = ["duckduckgo", "bing"]): SearchResult[] {
  const mcp = (body: object, sessionId?: string, headerOut?: string): string => {
    const bf = join(tmpdir(), `mcp_${Math.random().toString(36).slice(2)}.json`);
    writeFileSync(bf, JSON.stringify(body));
    const args = ["-s", "-X", "POST", OPEN_WEBSEARCH_URL, "-H", "Content-Type: application/json", "-H", "Accept: application/json, text/event-stream"];
    if (headerOut) args.push("-D", headerOut);
    if (sessionId) args.push("-H", `mcp-session-id: ${sessionId}`);
    args.push("-d", `@${bf}`);
    const r = spawnSync("curl", args, { encoding: "utf8", timeout: 30000, maxBuffer: 1 << 24 });
    rmSync(bf, { force: true });
    return r.stdout || "";
  };
  const parsePayload = (raw: string): unknown => {
    const line = raw.split("\n").reverse().find((l) => l.trim().startsWith("data:"));
    const json = line ? line.replace(/^data:\s*/, "") : raw.trim();
    try { return JSON.parse(json); } catch { return null; }
  };
  try {
    const headerFile = join(tmpdir(), `mcp_h_${Math.random().toString(36).slice(2)}`);
    mcp({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "labrinox", version: "1" } } }, undefined, headerFile);
    const session = (readFileSync(headerFile, "utf8").match(/mcp-session-id:\s*(\S+)/i) || [])[1];
    rmSync(headerFile, { force: true });
    if (!session) return [];
    mcp({ jsonrpc: "2.0", method: "notifications/initialized" }, session);
    const raw = mcp({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "search", arguments: { query, limit, engines } } }, session);
    const payload = parsePayload(raw) as { result?: { structuredContent?: unknown; content?: { type: string; text?: string }[] } } | null;
    const res = payload?.result;
    if (!res) return [];
    const textNode = res.content?.find((c) => c.type === "text")?.text;
    const data = res.structuredContent ?? (textNode ? JSON.parse(textNode) : null);
    const arr = (Array.isArray(data) ? data : (data as { results?: unknown[] })?.results) ?? [];
    return (arr as Record<string, string>[])
      .map((r) => ({ title: r.title ?? "", url: r.url ?? r.link ?? "", description: r.description ?? r.snippet ?? r.content ?? "" }))
      .filter((r) => r.title || r.description)
      .slice(0, limit);
  } catch {
    return [];
  }
}

const PROVIDERS: Record<SearchProviderId, (q: string, n: number) => SearchResult[]> = {
  tavily: tavilySearch,
  brave: braveSearch,
  serpapi: serpapiSearch,
  "open-websearch": openWebsearch,
};

/* The cascade order: an explicit SEARCH_PROVIDER override first, then every other
   provider. Each is tried until one returns results (keyless ones simply no-op
   when their key/server is absent). */
function order(): SearchProviderId[] {
  const all: SearchProviderId[] = ["tavily", "brave", "serpapi", "open-websearch"];
  const forced = process.env.SEARCH_PROVIDER as SearchProviderId | undefined;
  if (forced && all.includes(forced)) return [forced, ...all.filter((p) => p !== forced)];
  return all;
}

/* Which providers are usable right now (key present, or keyless). For the UI/CLI. */
export function searchProviders(): { id: SearchProviderId; label: string; configured: boolean; keyless: boolean; source: "env" | "store" | "none" }[] {
  const label: Record<SearchProviderId, string> = { tavily: "Tavily", brave: "Brave Search", serpapi: "SerpAPI", "open-websearch": "Open WebSearch (scraper)" };
  return (Object.keys(label) as SearchProviderId[]).map((id) => {
    if (id === "open-websearch") return { id, label: label[id], configured: true, keyless: true, source: "none" as const };
    const k = id as Exclude<SearchProviderId, "open-websearch">;
    const source = process.env[ENV_NAME[k]] ? ("env" as const) : keyFor(k) ? ("store" as const) : ("none" as const);
    return { id, label: label[id], configured: source !== "none", keyless: false, source };
  });
}

export function webSearch(query: string, limit = 5, _engines?: string[]): SearchResult[] {
  for (const id of order()) {
    const hits = PROVIDERS[id](query, limit);
    if (hits.length) return hits;
  }
  return [];
}

/* Compact context block for prompts. */
export function searchContext(query: string, limit = 5): string {
  const results = webSearch(query, limit);
  if (!results.length) return "";
  return `WEB SEARCH ("${query}"):\n` + results.map((r, i) => `${i + 1}. ${r.title} — ${r.description.slice(0, 200)} [${r.url}]`).join("\n");
}
