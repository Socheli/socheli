import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { recordInWorkspace, type TenantContext } from "@os/schemas";
import { REPO_ROOT } from "./data";

const FILE = join(REPO_ROOT, "data", "concepts.json");

export type Comment = { at: string; text: string };
export type BoardConcept = {
  id: string;
  channel: string;
  topic: string;
  angle: string;
  format: string;
  rationale: string;
  scores: Record<string, number>;
  overall: number;
  pick: boolean;
  mood?: string;
  status: "new" | "approved" | "rejected" | "generated";
  comments: Comment[];
  createdAt: string;
  workspaceId?: string;
  createdBy?: string;
};

function load(): BoardConcept[] {
  if (!existsSync(FILE)) return [];
  try {
    return JSON.parse(readFileSync(FILE, "utf8")) as BoardConcept[];
  } catch {
    return [];
  }
}
function save(list: BoardConcept[]) {
  writeFileSync(FILE, JSON.stringify(list, null, 2));
}

/* Concepts are workspace-owned (each carries `workspaceId`). Reads take a
   workspaceId and only ever see that workspace's slate; unstamped legacy
   concepts belong to DEFAULT_WORKSPACE via recordInWorkspace. Bare (no-arg)
   calls stay for system tooling that spans workspaces. */
export const listConcepts = (workspaceId?: string): BoardConcept[] =>
  load()
    .filter((c) => (workspaceId ? recordInWorkspace(c, workspaceId) : true))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

export function getConcept(id: string, workspaceId?: string): BoardConcept | undefined {
  const c = load().find((x) => x.id === id);
  if (!c) return undefined;
  if (workspaceId && !recordInWorkspace(c, workspaceId)) return undefined;
  return c;
}

/* Comments are open to any member; the comment keeps its author. Scoped lookup so
   you can't comment on another workspace's concept. */
export function addComment(id: string, text: string, workspaceId?: string) {
  const list = load();
  const c = list.find((x) => x.id === id);
  if (c && (!workspaceId || recordInWorkspace(c, workspaceId))) {
    c.comments.push({ at: new Date().toISOString(), text });
    save(list);
    return c;
  }
  return undefined;
}

export function setStatus(id: string, status: BoardConcept["status"], workspaceId?: string) {
  const list = load();
  const c = list.find((x) => x.id === id);
  if (c && (!workspaceId || recordInWorkspace(c, workspaceId))) {
    c.status = status;
    save(list);
    return c;
  }
  return undefined;
}

/* The engine (no Clerk) writes a fresh board to the shared file with no tenant
   fields. Right after generation the dashboard claims those unstamped concepts
   for the caller's workspace so they only show up on this team's board. */
export function stampUnowned(ctx: TenantContext): void {
  const list = load();
  let touched = false;
  for (const c of list) {
    if (!c.workspaceId) {
      c.workspaceId = ctx.workspaceId;
      if (!c.createdBy && ctx.userId) c.createdBy = ctx.userId;
      touched = true;
    }
  }
  if (touched) save(list);
}
