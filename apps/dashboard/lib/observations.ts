import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "./data";

/* Mirror of the engine's observation-store, read-only from the dashboard.
   The engine writes under data/observations/; we read from the same place. */

const OBS_DIR = join(REPO_ROOT, "data", "observations");
const IDX = join(OBS_DIR, "index.json");

/* Minimal shape for listing (index entries don't carry the full analysis). */
export type ObsAnalysis = {
  visualLanguage?: string;
  inspirationScore?: number;
  editRhythm?: string;
  avgSceneDuration?: number;
  musicStyle?: string;
  musicEnergy?: string;
  tone?: string;
  narrativeFormat?: string;
  hookPattern?: string;
  keyInsights?: string[];
  sceneTypes?: string[];
  socheliMoodMapping?: string;
  colorPalette?: string[];
  typography?: string;
  backgrounds?: string;
};

export type ObsCreator = {
  handle?: string;
  name?: string;
  platform: string;
  followers?: number;
  profileUrl?: string;
  bio?: string;
  bioLinks?: string[];
};

export type ObsListRow = {
  id: string;
  url: string;
  platform: "instagram" | "youtube" | "tiktok" | "x" | "other";
  kind?: string;
  title?: string;
  creator?: ObsCreator;
  metrics?: { views?: number; likes?: number; comments?: number; shares?: number; saves?: number; engagementRate?: number };
  thumbnailPath?: string;
  analysis?: ObsAnalysis;
  tags: string[];
  channelId?: string;
  createdAt: string;
  scannedAt?: string;
};

/* Full observation record (individual .json files). */
export type ObsFull = ObsListRow & {
  description?: string;
  duration?: number;
  frames?: string[];
  topComments?: { text: string; likes?: number }[];
  notes?: string;
  deepScanned?: boolean;
};

function safeReadJson<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

export function listObservations(opts: {
  platform?: string;
  channelId?: string;
  limit?: number;
  sort?: "newest" | "score" | "likes";
} = {}): ObsListRow[] {
  const raw = safeReadJson<ObsListRow[]>(IDX) ?? [];
  let items = raw;
  if (opts.platform) items = items.filter((o) => o.platform === opts.platform);
  if (opts.channelId) items = items.filter((o) => o.channelId === opts.channelId);

  if (opts.sort === "score") {
    items = [...items].sort((a, b) => (b.analysis?.inspirationScore ?? 0) - (a.analysis?.inspirationScore ?? 0));
  } else if (opts.sort === "likes") {
    items = [...items].sort((a, b) => (b.metrics?.likes ?? 0) - (a.metrics?.likes ?? 0));
  }
  // default: newest first (index is already newest-first from the engine)

  return items.slice(0, opts.limit ?? 100);
}

export function loadObservation(id: string): ObsFull | null {
  return safeReadJson<ObsFull>(join(OBS_DIR, `${id}.json`));
}
