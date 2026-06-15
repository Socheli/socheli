import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { DATA_DIR, ensureDir } from "./store.ts";

/* ig-app.ts — Bring-Your-Own *Instagram* app credentials (the BYO-keys principle,
   IG-Login flavour). DISTINCT from meta-app.ts: the "Instagram API with Instagram
   Login" product has its OWN Instagram App ID + Instagram App Secret in the Meta
   App Dashboard (Instagram → API setup with Instagram login), separate from the
   Facebook app id/secret used by the Facebook-Login (Page) flow.

   The deployed instance defaults to Socheli's Instagram app via env
   (INSTAGRAM_APP_ID / INSTAGRAM_APP_SECRET); any workspace can OVERRIDE with its
   OWN ig app id+secret, and a local self-host just sets the env.
   resolveInstagramApp() is the single resolver the IG-Login OAuth flow uses:
   per-workspace store wins, else env.

   Only appId + appSecret are per-workspace. The OAuth REDIRECT is the running
   instance's callback — env INSTAGRAM_OAUTH_REDIRECT, falling back to
   META_OAUTH_REDIRECT — regardless; a BYO app simply whitelists that same
   redirect URI under its own "Instagram → API setup with Instagram login → OAuth
   redirect URIs". NOTE: this redirect MUST target /api/connections/ig-callback,
   not the Facebook-Login /callback route.

   The app secret is sensitive: the store is gitignored (data/ig-app/) and is
   NEVER returned by a status/tool surface (appId is public; only the secret is
   hidden). Mirrors meta-app.ts byte-for-byte in shape. */

const DIR = join(DATA_DIR, "ig-app");
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

export type ResolvedInstagramApp = { appId: string; appSecret: string; redirect: string; source: "workspace" | "env" | "none" };

/** appId+secret from the workspace store (if set), else env; redirect always env
    (INSTAGRAM_OAUTH_REDIRECT, else META_OAUTH_REDIRECT). */
export function resolveInstagramApp(workspaceId?: string): ResolvedInstagramApp {
  const redirect = process.env.INSTAGRAM_OAUTH_REDIRECT || process.env.META_OAUTH_REDIRECT || "";
  if (workspaceId) {
    const stored = load(workspaceId);
    if (stored) return { appId: stored.appId, appSecret: stored.appSecret, redirect, source: "workspace" };
  }
  const appId = process.env.INSTAGRAM_APP_ID || "";
  const appSecret = process.env.INSTAGRAM_APP_SECRET || "";
  if (appId && appSecret) return { appId, appSecret, redirect, source: "env" };
  return { appId: "", appSecret: "", redirect, source: "none" };
}

/** Persist a workspace's own Instagram app credentials (overrides env for that workspace). */
export function setInstagramApp(workspaceId: string, appId: string, appSecret: string): void {
  ensureDir(DIR);
  const p = fileFor(workspaceId);
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ appId, appSecret, updatedAt: new Date().toISOString() } satisfies StoredApp, null, 2));
  renameSync(tmp, p);
}

/** Remove a workspace's override → it falls back to the instance env app. */
export function clearInstagramApp(workspaceId: string): boolean {
  const p = fileFor(workspaceId);
  if (!existsSync(p)) return false;
  // Tombstone by writing an empty object (atomic) then the loader treats it as none.
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({}));
  renameSync(tmp, p);
  return true;
}

/** Safe status — NEVER returns the secret. appId is public so it's shown. */
export function instagramAppStatus(workspaceId?: string): { configured: boolean; source: ResolvedInstagramApp["source"]; appId: string; redirect: string; redirectConfigured: boolean } {
  const r = resolveInstagramApp(workspaceId);
  return { configured: r.source !== "none", source: r.source, appId: r.appId, redirect: r.redirect, redirectConfigured: !!r.redirect };
}

/* Short aliases so surfaces can import either the long or short name. */
export {
  resolveInstagramApp as resolveIgApp,
  setInstagramApp as setIgApp,
  clearInstagramApp as clearIgApp,
  instagramAppStatus as igAppStatus,
};
