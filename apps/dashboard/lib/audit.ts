import "server-only";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "./data";
import type { TenantContext } from "@os/schemas";

/* A per-workspace append-only audit trail (data/audit/<workspaceId>.jsonl). Every
   member-facing mutation — invites, role changes, brand edits, publishes, key
   issuance — records who did what, so a team can answer "who changed this?". */

const AUDIT_DIR = join(REPO_ROOT, "data", "audit");

export type AuditEntry = {
  at: string;
  workspaceId: string;
  userId: string | null;
  via: TenantContext["via"];
  action: string; // e.g. "member.invite", "brand.update", "content.publish"
  target?: string; // the affected record id / email / brand id
  meta?: Record<string, unknown>;
};

const safeName = (workspaceId: string) => workspaceId.replace(/[^a-zA-Z0-9_-]/g, "_");

export function audit(
  ctx: Pick<TenantContext, "workspaceId" | "userId" | "via">,
  action: string,
  target?: string,
  meta?: Record<string, unknown>,
): void {
  try {
    mkdirSync(AUDIT_DIR, { recursive: true });
    const entry: AuditEntry = {
      at: new Date().toISOString(),
      workspaceId: ctx.workspaceId,
      userId: ctx.userId,
      via: ctx.via,
      action,
      target,
      meta,
    };
    appendFileSync(join(AUDIT_DIR, `${safeName(ctx.workspaceId)}.jsonl`), JSON.stringify(entry) + "\n");
  } catch {
    /* auditing must never break the request */
  }
}

export function readAudit(workspaceId: string, limit = 200): AuditEntry[] {
  const file = join(AUDIT_DIR, `${safeName(workspaceId)}.jsonl`);
  if (!existsSync(file)) return [];
  try {
    const lines = readFileSync(file, "utf8").trim().split("\n").filter(Boolean);
    return lines
      .slice(-limit)
      .map((l) => {
        try {
          return JSON.parse(l) as AuditEntry;
        } catch {
          return null;
        }
      })
      .filter((x): x is AuditEntry => !!x)
      .reverse();
  } catch {
    return [];
  }
}
