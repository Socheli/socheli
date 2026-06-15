import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_WORKSPACE, recordInWorkspace, type TenantContext } from "@os/schemas";
import { REPO_ROOT } from "./data";

/* Per-day calendar annotations: free-text notes and reminders the operator adds
   on a day (Notion/Google-style). Persisted in data/calendar-meta.json. Self-
   contained, same pattern as lib/content-plan.ts / lib/schedule.ts.

   Workspace-aware: each entry carries an optional workspaceId + createdBy; reads
   are scoped to a workspaceId (default DEFAULT_WORKSPACE so legacy callers keep
   working) and unstamped legacy entries resolve to DEFAULT_WORKSPACE. A reminder
   can also be `assignee`d to a teammate. */

const FILE = join(REPO_ROOT, "data", "calendar-meta.json");

export type MetaEntry = {
  id: string;
  date: string; // YYYY-MM-DD
  kind: "note" | "reminder";
  text: string;
  channel?: string; // optional brand association
  remindAt?: string; // HH:MM for reminders
  done?: boolean; // reminder completion
  createdAt: string;
  /** Tenancy: which workspace owns this entry and which user authored it. */
  workspaceId?: string;
  createdBy?: string;
  /** Clerk user id of the teammate a reminder is assigned to (optional). */
  assignee?: string;
};

/* The whole on-disk list, unscoped. Internal — callers go through loadMetaFor. */
export function loadMeta(): MetaEntry[] {
  if (!existsSync(FILE)) return [];
  try {
    return JSON.parse(readFileSync(FILE, "utf8")) as MetaEntry[];
  } catch {
    return [];
  }
}

/* The annotations scoped to one workspace — the canonical read path. */
export function loadMetaFor(workspaceId = DEFAULT_WORKSPACE): MetaEntry[] {
  return loadMeta().filter((e) => recordInWorkspace(e, workspaceId));
}

export function saveMeta(list: MetaEntry[]) {
  writeFileSync(FILE, JSON.stringify(list, null, 2));
}

/* Add a note/reminder, stamped with the caller's workspace + author. */
export function addEntry(
  e: Omit<MetaEntry, "id" | "createdAt">,
  ctx?: Pick<TenantContext, "workspaceId" | "userId">,
): MetaEntry {
  const entry: MetaEntry = {
    ...e,
    id: `m_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    createdAt: new Date().toISOString(),
    workspaceId: e.workspaceId || ctx?.workspaceId || DEFAULT_WORKSPACE,
    ...(e.createdBy || ctx?.userId ? { createdBy: e.createdBy || ctx?.userId || undefined } : {}),
  };
  saveMeta([entry, ...loadMeta()]);
  return entry;
}

export function updateEntry(id: string, patch: Partial<MetaEntry>, workspaceId = DEFAULT_WORKSPACE): MetaEntry | undefined {
  const list = loadMeta();
  const e = list.find((x) => x.id === id && recordInWorkspace(x, workspaceId));
  if (!e) return undefined;
  for (const k of ["text", "remindAt", "done", "date", "channel", "assignee"] as const) {
    if (k in patch && patch[k] !== undefined) (e as Record<string, unknown>)[k] = patch[k];
  }
  saveMeta(list);
  return e;
}

export function removeEntry(id: string, workspaceId = DEFAULT_WORKSPACE): boolean {
  const list = loadMeta();
  const next = list.filter((x) => !(x.id === id && recordInWorkspace(x, workspaceId)));
  if (next.length === list.length) return false;
  saveMeta(next);
  return true;
}
