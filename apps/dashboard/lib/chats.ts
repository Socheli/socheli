import "server-only";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ChatFolder, ChatThread } from "@os/schemas";
import type { ChatFolder as ChatFolderT, ChatThread as ChatThreadT, ChatThreadMeta } from "@os/schemas";
import { REPO_ROOT } from "./data";

/* Server store for Soli copilot conversation history.

   LAYOUT: data/chats/<workspaceId>/<threadId>.json — one flat-JSON file per
   thread, validated with the shared @os/schemas ChatThread shape on every
   read (invalid files are skipped, never guessed at). Writes are atomic
   (tmp + renameSync) per the repo persistence convention; ids are sanitized
   into the filename so a thread id can never escape its workspace directory.

   BUDGETS: stored transcripts cap at CHAT_MAX_MESSAGES (200 — same cap the
   client applies), the list returns only the LIST_LIMIT (50) most recently
   updated threads, and any files beyond KEEP_FILES (100) per workspace are
   pruned oldest-first on write so the store can't grow unbounded. */

const CHATS_DIR = join(REPO_ROOT, "data", "chats");

export const CHAT_MAX_MESSAGES = 200;
const LIST_LIMIT = 50;
const KEEP_FILES = 100;

const MAX_FOLDERS = 60;

const sani = (s: string) => (s || "ws_default").replace(/[^a-zA-Z0-9_-]/g, "-");
const dirFor = (workspaceId: string) => join(CHATS_DIR, sani(workspaceId));
const fileFor = (workspaceId: string, threadId: string) =>
  join(dirFor(workspaceId), `${sani(threadId)}.json`);
/* Folders live in one workspace-scoped file (the leading underscore keeps it
   out of readAll's per-thread sweep — thread ids are sanitized, never "_"). */
const foldersFileFor = (workspaceId: string) => join(dirFor(workspaceId), "_folders.json");

function atomicWrite(file: string, record: ChatThreadT): void {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(record, null, 2), { mode: 0o600 });
  renameSync(tmp, file);
}

/* Every valid thread in the workspace, newest-updated first. */
function readAll(workspaceId: string): ChatThreadT[] {
  const dir = dirFor(workspaceId);
  if (!existsSync(dir)) return [];
  const out: ChatThreadT[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    try {
      const parsed = ChatThread.safeParse(JSON.parse(readFileSync(join(dir, f), "utf8")));
      if (parsed.success) out.push(parsed.data);
    } catch {
      /* unreadable file — skip, never guess */
    }
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

/* Metadata for the thread rail — never ships full transcripts. The
   organisation flags (pinned/folderId) ride along so the rail can group
   without fetching transcripts. */
export function listChatThreads(workspaceId: string): ChatThreadMeta[] {
  return readAll(workspaceId)
    .slice(0, LIST_LIMIT)
    .map(({ id, title, createdAt, updatedAt, pinned, folderId }) => ({
      id,
      title,
      createdAt,
      updatedAt,
      ...(pinned ? { pinned: true } : {}),
      ...(folderId ? { folderId } : {}),
    }));
}

/* ── Folders (data/chats/<workspaceId>/_folders.json) ───────────────────────
   One flat array of ChatFolder per workspace, atomic-written like threads. A
   thread's folderId points at one of these; deleting a folder unfiles (never
   deletes) its threads. */
export function listChatFolders(workspaceId: string): ChatFolderT[] {
  const file = foldersFileFor(workspaceId);
  if (!existsSync(file)) return [];
  try {
    const raw = JSON.parse(readFileSync(file, "utf8"));
    const arr = Array.isArray(raw) ? raw : [];
    return arr
      .map((f) => ChatFolder.safeParse(f))
      .filter((p): p is { success: true; data: ChatFolderT } => p.success)
      .map((p) => p.data)
      .sort((a, b) => a.createdAt - b.createdAt);
  } catch {
    return [];
  }
}

function writeChatFolders(workspaceId: string, folders: ChatFolderT[]): void {
  mkdirSync(dirFor(workspaceId), { recursive: true });
  const file = foldersFileFor(workspaceId);
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(folders.slice(0, MAX_FOLDERS), null, 2), { mode: 0o600 });
  renameSync(tmp, file);
}

/* Create or rename a folder in place (matched by id). The caller stamps
   tenancy; ids/names are validated by the shared schema. */
export function upsertChatFolder(workspaceId: string, folder: ChatFolderT): ChatFolderT {
  const folders = listChatFolders(workspaceId);
  const idx = folders.findIndex((f) => f.id === folder.id);
  if (idx >= 0) folders[idx] = { ...folders[idx], name: folder.name };
  else folders.push(folder);
  writeChatFolders(workspaceId, folders);
  return idx >= 0 ? folders[idx] : folder;
}

/* Delete a folder and UNFILE (never delete) every thread that pointed at it. */
export function deleteChatFolder(workspaceId: string, folderId: string): boolean {
  const folders = listChatFolders(workspaceId);
  const next = folders.filter((f) => f.id !== folderId);
  if (next.length === folders.length) return false;
  writeChatFolders(workspaceId, next);
  for (const t of readAll(workspaceId)) {
    if (t.folderId === folderId) {
      const record: ChatThreadT = { ...t, folderId: null, updatedAt: Date.now() };
      atomicWrite(fileFor(workspaceId, t.id), record);
    }
  }
  return true;
}

/* File a thread under a folder (or null to unfile). Bumps updatedAt so other
   devices pick the move up via the last-write-wins merge. */
export function moveChatThread(
  workspaceId: string,
  threadId: string,
  folderId: string | null,
): ChatThreadT | null {
  const existing = readChatThread(workspaceId, threadId);
  if (!existing) return null;
  const record: ChatThreadT = { ...existing, folderId: folderId ?? null, updatedAt: Date.now() };
  atomicWrite(fileFor(workspaceId, threadId), record);
  return record;
}

/* Pin / unpin a thread (lifts it into the rail's PINNED group). */
export function pinChatThread(
  workspaceId: string,
  threadId: string,
  pinned: boolean,
): ChatThreadT | null {
  const existing = readChatThread(workspaceId, threadId);
  if (!existing) return null;
  const record: ChatThreadT = { ...existing, pinned, updatedAt: Date.now() };
  atomicWrite(fileFor(workspaceId, threadId), record);
  return record;
}

export function readChatThread(workspaceId: string, threadId: string): ChatThreadT | null {
  const file = fileFor(workspaceId, threadId);
  if (!existsSync(file)) return null;
  try {
    const parsed = ChatThread.safeParse(JSON.parse(readFileSync(file, "utf8")));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/* Write (create or replace) one thread, then prune the workspace's oldest
   files beyond the KEEP_FILES budget. The caller (the API route) is
   responsible for stamping tenancy and re-validating ui blocks. */
export function upsertChatThread(workspaceId: string, thread: ChatThreadT): ChatThreadT {
  mkdirSync(dirFor(workspaceId), { recursive: true });
  const record: ChatThreadT = { ...thread, messages: thread.messages.slice(-CHAT_MAX_MESSAGES) };
  atomicWrite(fileFor(workspaceId, thread.id), record);
  pruneOld(workspaceId);
  return record;
}

export function deleteChatThread(workspaceId: string, threadId: string): boolean {
  const file = fileFor(workspaceId, threadId);
  if (!existsSync(file)) return false;
  try {
    rmSync(file, { force: true });
    return true;
  } catch {
    return false;
  }
}

/* Retitle a thread in place. Bumps updatedAt so other devices pick it up. */
export function renameChatThread(
  workspaceId: string,
  threadId: string,
  title: string,
): ChatThreadT | null {
  const existing = readChatThread(workspaceId, threadId);
  if (!existing) return null;
  const next = title.trim().slice(0, 200);
  if (!next) return existing;
  const record: ChatThreadT = { ...existing, title: next, updatedAt: Date.now() };
  atomicWrite(fileFor(workspaceId, threadId), record);
  return record;
}

/* Drop the oldest threads (by updatedAt) beyond the per-workspace file budget. */
function pruneOld(workspaceId: string): void {
  const all = readAll(workspaceId); // newest first
  for (const stale of all.slice(KEEP_FILES)) {
    try {
      rmSync(fileFor(workspaceId, stale.id), { force: true });
    } catch {
      /* best-effort */
    }
  }
}
