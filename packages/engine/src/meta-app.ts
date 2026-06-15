import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { DATA_DIR, ensureDir } from "./store.ts";

/* meta-app.ts — Bring-Your-Own Meta app credentials (the BYO-keys principle).
   The deployed instance defaults to Socheli's Meta app via env (META_APP_ID /
   META_APP_SECRET); any workspace can OVERRIDE with its OWN app id+secret, and a
   local self-host just sets the env. resolveMetaApp() is the single resolver the
   OAuth flow uses: per-workspace store wins, else env.

   Only appId + appSecret are per-workspace. The OAuth REDIRECT is the running
   instance's callback (env META_OAUTH_REDIRECT) regardless — a BYO app simply
   whitelists that same redirect URI in its own Meta app settings. The app secret
   is sensitive: the store is gitignored (data/meta-app/) and is NEVER returned by
   a status/tool surface (appId is public; only the secret is hidden). */

const DIR = join(DATA_DIR, "meta-app");
const sani = (w: string) => (w || "default").replace(/[^a-zA-Z0-9_-]/g, "-");
const fileFor = (workspaceId: string) => join(DIR, `${sani(workspaceId)}.json`);

type StoredApp = { appId: string; appSecret: string; updatedAt: string };

function load(workspaceId: string): StoredApp | null {
  try {
    const p = fileFor(workspaceId);
    if (!existsSync(p)) return null;
    const raw = JSON.parse(readFileSync(p, "utf8"));
    return raw?.appId && raw?.appSecret ? (raw as StoredApp) : null;
  } catch {
    return null;
  }
}

export type ResolvedMetaApp = { appId: string; appSecret: string; redirect: string; source: "workspace" | "env" | "none" };

/** appId+secret from the workspace store (if set), else env; redirect always env. */
export function resolveMetaApp(workspaceId?: string): ResolvedMetaApp {
  const redirect = process.env.META_OAUTH_REDIRECT || "";
  if (workspaceId) {
    const stored = load(workspaceId);
    if (stored) return { appId: stored.appId, appSecret: stored.appSecret, redirect, source: "workspace" };
  }
  const appId = process.env.META_APP_ID || "";
  const appSecret = process.env.META_APP_SECRET || "";
  if (appId && appSecret) return { appId, appSecret, redirect, source: "env" };
  return { appId: "", appSecret: "", redirect, source: "none" };
}

/** Persist a workspace's own Meta app credentials (overrides env for that workspace). */
export function setMetaApp(workspaceId: string, appId: string, appSecret: string): void {
  ensureDir(DIR);
  const p = fileFor(workspaceId);
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ appId, appSecret, updatedAt: new Date().toISOString() } satisfies StoredApp, null, 2));
  renameSync(tmp, p);
}

/** Remove a workspace's override → it falls back to the instance env app. */
export function clearMetaApp(workspaceId: string): boolean {
  const p = fileFor(workspaceId);
  if (!existsSync(p)) return false;
  // Tombstone by writing an empty object (atomic) then the loader treats it as none.
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({}));
  renameSync(tmp, p);
  return true;
}

/** Safe status — NEVER returns the secret. appId is public so it's shown. */
export function metaAppStatus(workspaceId?: string): { configured: boolean; source: ResolvedMetaApp["source"]; appId: string; redirect: string; redirectConfigured: boolean } {
  const r = resolveMetaApp(workspaceId);
  return { configured: r.source !== "none", source: r.source, appId: r.appId, redirect: r.redirect, redirectConfigured: !!r.redirect };
}
