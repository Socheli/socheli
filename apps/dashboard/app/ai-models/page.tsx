"use client";
import { useEffect, useState, type CSSProperties } from "react";
import { PageHead } from "../PageHead";
import { Select } from "../Select";
import { ModelPickerDialog, type CatalogModel } from "./ModelPickerDialog";
import { TaskGlyph } from "./TaskGlyph";

/* AI Models — the whole content pipeline broken into named tasks (one per LLM
   call), each with a user-selectable model + tier. Reads the manifest + provider
   list from the engine via /api/tools; writes per-task overrides the same way.
   Every task row carries its own hand-drawn ink glyph that draws itself in. */

type Task = { id: string; label: string; description: string; stage: string; defaultTier: string; tier: string; model?: string; overridden: boolean };
type ProviderAccount = { id: string; label: string; kind: string; active: boolean; addedAt: string };
type Provider = { id: string; label: string; kind: string; exampleModels: string[]; connected: boolean; needsKey?: boolean; source?: string; isDefault?: boolean; disabled?: boolean; revocable?: boolean; accounts?: ProviderAccount[] };

const STAGE_LABEL: Record<string, string> = {
  ideation: "Ideation", scripting: "Scripting", storyboard: "Storyboard", qa: "QA",
  research: "Research", analysis: "Analysis", carousel: "Carousel", publish: "Publish",
};
const TIERS = [
  { value: "", label: "Default tier" },
  { value: "cheap", label: "Cheap" },
  { value: "smart", label: "Smart" },
  { value: "best", label: "Best" },
];

async function callTool<T = unknown>(name: string, body: object = {}): Promise<T | null> {
  const r = await fetch(`/api/tools/${name}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).catch(() => null);
  const j = await r?.json().catch(() => null);
  return j?.ok ? (j.data as T) : null;
}

export default function AiModelsPage() {
  const [stages, setStages] = useState<string[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [catalog, setCatalog] = useState<{ models: CatalogModel[]; families: string[]; openrouterConnected: boolean }>({ models: [], families: [], openrouterConnected: false });
  const [editing, setEditing] = useState<string | null>(null);
  const [saving, setSaving] = useState("");
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      const [t, p] = await Promise.all([
        callTool<{ stages: string[]; tasks: Task[] }>("ai_tasks"),
        callTool<{ providers: Provider[] }>("ai_providers"),
      ]);
      if (!alive) return;
      if (t) { setStages(t.stages); setTasks(t.tasks); }
      if (p) setProviders(p.providers);
      setLoaded(true);
      // Catalog is heavier (a cached fetch) — load it after the page paints.
      const c = await callTool<{ models: CatalogModel[]; families: string[]; openrouterConnected: boolean }>("model_catalog");
      if (alive && c) setCatalog({ models: c.models, families: c.families, openrouterConnected: c.openrouterConnected });
    })();
    return () => { alive = false; };
  }, []);

  // Pretty label for a task's current model value.
  const modelLabel = (v?: string) => {
    if (!v) return null;
    const hit = catalog.models.find((m) => m.value === v);
    if (hit) return { family: hit.family, name: hit.name.replace(/^[^:]+:\s*/, "") };
    const slash = v.indexOf("/");
    return { family: slash > 0 ? v.slice(0, slash) : "", name: slash > 0 ? v.slice(slash + 1) : v };
  };

  const connectedCount = providers.filter((p) => p.connected).length;

  const refetchProviders = async () => {
    const p = await callTool<{ providers: Provider[] }>("ai_providers");
    if (p) setProviders(p.providers);
  };

  const apply = async (taskId: string, next: { tier?: string; model?: string }) => {
    const cur = tasks.find((t) => t.id === taskId);
    if (!cur) return;
    const tier = next.tier !== undefined ? next.tier : cur.overridden && cur.tier !== cur.defaultTier ? cur.tier : "";
    const model = next.model !== undefined ? next.model : cur.model ?? "";
    setSaving(taskId);
    const body = !tier && !model ? { action: "clear", taskId } : { action: "set", taskId, ...(tier ? { tier } : {}), ...(model ? { model } : {}) };
    const d = await callTool<{ tasks: Task[] }>("ai_task_model", body);
    if (d?.tasks) setTasks(d.tasks);
    setSaving("");
  };

  let row = 0;
  return (
    <>
      <PageHead
        section="manage"
        title="AI Models"
        sub={<>The content pipeline as {tasks.length || 25} named tasks, each a granular LLM call. Pick the model + tier per task; {connectedCount} provider{connectedCount === 1 ? "" : "s"} connected. Unset tasks use their default.</>}
      />

      {loaded && <ProvidersPanel providers={providers} catalog={catalog.models} onChange={refetchProviders} />}

      {!loaded ? (
        <div className="empty">Loading the pipeline…</div>
      ) : (
        stages.map((stage) => {
          const inStage = tasks.filter((t) => t.stage === stage);
          if (!inStage.length) return null;
          return (
            <div key={stage} className="aim-stage">
              <div className="aim-stage-head"><span className="eyebrow">{STAGE_LABEL[stage] ?? stage}</span><span className="aim-stage-n">{inStage.length}</span></div>
              <div className="aim-rows">
                {inStage.map((t) => {
                  const i = row++;
                  return (
                    <div key={t.id} className={`aim-row blk-in${t.overridden ? " on" : ""}`} style={{ "--i": i + 1 } as CSSProperties}>
                      <span className="aim-ico"><TaskGlyph task={t.id} size={20} i={i} /></span>
                      <div className="aim-meta">
                        <div className="aim-label">{t.label}{t.overridden && <span className="aim-dot" title="overridden" />}</div>
                        <div className="aim-desc">{t.description}</div>
                      </div>
                      <div className="aim-controls">
                        <Select
                          value={t.overridden && t.tier !== t.defaultTier ? t.tier : ""}
                          onChange={(v) => apply(t.id, { tier: v })}
                          width={130}
                          ariaLabel={`${t.label} tier`}
                          options={TIERS.map((x) => (x.value === "" ? { value: "", label: `Default · ${t.defaultTier}` } : x))}
                        />
                        <button type="button" className="aim-model-btn" onClick={() => setEditing(t.id)} aria-label={`${t.label} model`}>
                          {(() => {
                            const l = modelLabel(t.model);
                            return l ? <><span className="aim-model-fam">{l.family}</span><span className="aim-model-name">{l.name}</span></> : <span className="aim-model-default">Default model</span>;
                          })()}
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" style={{ opacity: 0.5, flexShrink: 0 }}><path d="M6 9l6 6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
                        </button>
                        {saving === t.id && <span className="aim-saving">·</span>}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })
      )}

      <ModelPickerDialog
        open={!!editing}
        value={tasks.find((t) => t.id === editing)?.model ?? ""}
        models={catalog.models}
        families={catalog.families}
        openrouterConnected={catalog.openrouterConnected}
        onPick={(v) => { if (editing) void apply(editing, { model: v }); setEditing(null); }}
        onClose={() => setEditing(null)}
      />
    </>
  );
}

/* Connect any provider by pasting its API key (stored 0600 server-side, never
   shown). Keyless local + CLI providers show as ready; env-keyed ones show
   "via env". Setting a key here does NOT change the default brain provider. */
function ProvidersPanel({ providers, catalog, onChange }: { providers: Provider[]; catalog: CatalogModel[]; onChange: () => void }) {
  const [open, setOpen] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [adding, setAdding] = useState<string | null>(null);
  const [draftLabel, setDraftLabel] = useState("");
  const connected = providers.filter((p) => p.connected).length;

  // The models a provider offers — its own (routeProvider) + its family via the
  // catalog; OpenRouter offers everything.
  const FAM: Record<string, string> = { gemini: "google", anthropic: "anthropic", openai: "openai", xai: "xai", mistral: "mistral", deepseek: "deepseek", cohere: "cohere" };
  const modelsFor = (p: Provider): CatalogModel[] => {
    if (p.id === "openrouter") return catalog;
    const fam = FAM[p.id];
    return catalog.filter((m) => m.routeProvider === p.id || (fam && m.family === fam));
  };

  const makeDefault = async (id: string) => {
    setBusy(id);
    await callTool("provider_default", { id });
    await onChange();
    setBusy("");
  };
  const revoke = async (id: string, restore: boolean) => {
    setBusy(id);
    await callTool("provider_revoke", { action: restore ? "restore" : "revoke", id });
    await onChange();
    setBusy("");
  };
  // Multiple named accounts per provider (API keys or CLI/OAuth tokens).
  const addAcct = async (p: Provider) => {
    const secret = (drafts[p.id] || "").trim();
    if (!secret) return;
    setBusy(p.id);
    await callTool("provider_account", { action: "add", id: p.id, label: draftLabel.trim() || undefined, secret, kind: p.kind === "cli" ? "oauth" : "key" });
    setDrafts((d) => ({ ...d, [p.id]: "" })); setDraftLabel(""); setAdding(null);
    await onChange(); setBusy("");
  };
  const activateAcct = async (id: string, accountId: string) => { setBusy(id); await callTool("provider_account", { action: "activate", id, accountId }); await onChange(); setBusy(""); };
  const removeAcct = async (id: string, accountId: string) => {
    setBusy(id);
    if (accountId === "legacy") await callTool("provider_key", { action: "clear", id });
    else await callTool("provider_account", { action: "remove", id, accountId });
    await onChange(); setBusy("");
  };
  // OpenRouter PKCE OAuth (kept from the old /connections card) — start, redirect.
  const oauth = async () => {
    const r = await fetch("/api/ai-providers", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "openrouter_oauth_start", provider: "openrouter" }) })
      .then((x) => x.json()).catch(() => null);
    if (r?.url) window.location.href = r.url;
  };

  return (
    <div className="aim-providers card" style={{ marginBottom: 22 }}>
      <button className="aim-prov-head" type="button" onClick={() => setOpen((v) => !v)}>
        <span className="eyebrow">Providers</span>
        <span className="aim-prov-count">{connected}/{providers.length} connected</span>
        <span className="aim-prov-toggle">{open ? "hide" : "manage keys"}</span>
      </button>
      {open && (
        <div className="aim-prov-grid">
          {providers.map((p) => {
            const models = modelsFor(p);
            const accts = p.accounts ?? [];
            const manageable = (p.needsKey || p.kind === "cli" || p.id === "openrouter") && !p.disabled;
            return (
              <div key={p.id} className={`aim-prov${p.connected ? " on" : ""}${p.disabled ? " revoked" : ""}`}>
                <div className="aim-prov-top">
                  <span className="aim-prov-dot" />
                  <span className="aim-prov-label">{p.label}</span>
                  {p.disabled
                    ? <span className="aim-prov-default" style={{ color: "var(--error)", borderColor: "rgba(239,83,80,0.4)" }}>revoked</span>
                    : p.isDefault
                      ? <span className="aim-prov-default">default</span>
                      : p.connected && <button className="aim-prov-makedef" type="button" disabled={busy === p.id} onClick={() => makeDefault(p.id)}>make default</button>}
                  <span className="aim-prov-src">{p.disabled ? "" : p.source === "cli" ? "CLI" : p.source === "local" ? "local" : p.source === "env" ? "via env" : p.source === "stored" ? "key set" : "—"}</span>
                </div>

                {manageable && (
                  <div className="aim-prov-accounts">
                    {accts.map((a) => (
                      <div key={a.id} className={`aim-acct${a.active ? " on" : ""}`}>
                        <button className="aim-acct-pick" type="button" disabled={a.active || busy === p.id} onClick={() => activateAcct(p.id, a.id)} title={a.active ? "active" : "use this account"}>
                          <span className="aim-acct-dot" />{a.label}{a.kind === "oauth" && <span className="aim-acct-kind">oauth</span>}
                        </button>
                        <button className="aim-acct-rm" type="button" disabled={busy === p.id} onClick={() => removeAcct(p.id, a.id)} title="remove account">✕</button>
                      </div>
                    ))}
                    {adding === p.id ? (
                      <div className="aim-prov-key">
                        <input className="input" placeholder="label" value={draftLabel} onChange={(e) => setDraftLabel(e.target.value)} style={{ width: 72, padding: "5px 8px", fontSize: 11 }} />
                        <input className="input" type="password" placeholder={p.kind === "cli" ? "OAuth token (claude setup-token)" : `${p.id} API key`} value={drafts[p.id] || ""} onChange={(e) => setDrafts((d) => ({ ...d, [p.id]: e.target.value }))} onKeyDown={(e) => { if (e.key === "Enter") void addAcct(p); }} spellCheck={false} autoComplete="off" style={{ flex: 1, minWidth: 0, padding: "5px 9px", fontSize: 11 }} />
                        <button className="btn" type="button" disabled={!drafts[p.id]?.trim() || busy === p.id} onClick={() => addAcct(p)} style={{ fontSize: 11, padding: "5px 10px" }}>{busy === p.id ? "…" : "add"}</button>
                      </div>
                    ) : (
                      <div className="aim-prov-addrow">
                        <button className="aim-prov-addacct" type="button" onClick={() => { setAdding(p.id); setDraftLabel(""); }}>+ {accts.length ? "add account" : p.kind === "cli" ? "add login" : "connect"}</button>
                        {p.id === "openrouter" && <button className="aim-prov-addacct" type="button" onClick={oauth}>OAuth</button>}
                        {p.kind === "cli" && <span className="aim-prov-hint">CLI login active</span>}
                      </div>
                    )}
                  </div>
                )}

                <div className="aim-prov-foot">
                  {models.length > 0 && (
                    <button type="button" className="aim-prov-models" onClick={() => setExpanded((e) => (e === p.id ? null : p.id))}>
                      {p.id === "openrouter" ? `${models.length} models` : `${models.length} model${models.length === 1 ? "" : "s"}`} {expanded === p.id ? "▾" : "▸"}
                    </button>
                  )}
                  {/* Provider-level revoke (every connection). Individual keys/logins are removed in the accounts list above. */}
                  {p.disabled ? (
                    <button className="aim-prov-revoke" type="button" disabled={busy === p.id} onClick={() => revoke(p.id, true)}>restore</button>
                  ) : p.connected ? (
                    <button className="aim-prov-revoke" type="button" disabled={busy === p.id} onClick={() => revoke(p.id, false)}>revoke</button>
                  ) : null}
                </div>

                {expanded === p.id && (
                  <div className="aim-prov-modellist">
                    {models.slice(0, 60).map((m) => (
                      <div key={m.value} className="aim-prov-model">
                        <span className="aim-prov-model-name">{m.name.replace(/^[^:]+:\s*/, "")}</span>
                        {m.rating != null && <span className="aim-prov-model-rate">★ {m.rating.toFixed(1)}</span>}
                      </div>
                    ))}
                    {models.length > 60 && <div className="aim-prov-model" style={{ color: "var(--text-muted)" }}>+{models.length - 60} more — search in a task's picker</div>}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
