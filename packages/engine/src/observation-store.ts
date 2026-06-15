import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ContentObservation, ProfileObservation } from "@os/schemas";

const DATA = join(process.cwd(), "data");
const OBS_DIR = join(DATA, "observations");
const IDX = join(OBS_DIR, "index.json");

function ensureDir() {
  if (!existsSync(OBS_DIR)) mkdirSync(OBS_DIR, { recursive: true });
}

function readIndex(): ContentObservation[] {
  ensureDir();
  if (!existsSync(IDX)) return [];
  try { return JSON.parse(readFileSync(IDX, "utf8")); }
  catch { return []; }
}

function writeIndex(items: ContentObservation[]) {
  ensureDir();
  writeFileSync(IDX, JSON.stringify(items, null, 2));
}

export function newObsId(): string {
  return "obs_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

export function saveObservation(obs: ContentObservation): void {
  const idx = readIndex();
  const existing = idx.findIndex(o => o.id === obs.id);
  if (existing >= 0) idx[existing] = obs;
  else idx.unshift(obs);
  writeIndex(idx);
  // Also write the full record as its own file
  writeFileSync(join(OBS_DIR, obs.id + ".json"), JSON.stringify(obs, null, 2));
}

export function loadObservation(id: string): ContentObservation | null {
  const path = join(OBS_DIR, id + ".json");
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, "utf8")); }
  catch { return null; }
}

export function listObservations(opts: {
  platform?: string;
  tags?: string[];
  channelId?: string;
  limit?: number;
} = {}): ContentObservation[] {
  let items = readIndex();
  if (opts.platform) items = items.filter(o => o.platform === opts.platform);
  if (opts.channelId) items = items.filter(o => o.channelId === opts.channelId);
  if (opts.tags?.length) items = items.filter(o => opts.tags!.some(t => o.tags.includes(t)));
  return items.slice(0, opts.limit ?? 100);
}

export function findObservationByUrl(url: string): ContentObservation | null {
  const idx = readIndex();
  const found = idx.find(o => o.url === url || o.url.includes(url) || url.includes(o.id));
  if (!found) return null;
  return loadObservation(found.id);
}

// Profile observations (separate index)
const PROFILE_IDX = join(OBS_DIR, "profiles.json");

function readProfileIndex(): ProfileObservation[] {
  ensureDir();
  if (!existsSync(PROFILE_IDX)) return [];
  try { return JSON.parse(readFileSync(PROFILE_IDX, "utf8")); }
  catch { return []; }
}

export function saveProfileObservation(prof: ProfileObservation): void {
  const idx = readProfileIndex();
  const existing = idx.findIndex(p => p.id === prof.id);
  if (existing >= 0) idx[existing] = prof;
  else idx.unshift(prof);
  writeFileSync(PROFILE_IDX, JSON.stringify(idx, null, 2));
  writeFileSync(join(OBS_DIR, prof.id + ".json"), JSON.stringify(prof, null, 2));
}

export function listProfileObservations(): ProfileObservation[] {
  return readProfileIndex();
}
