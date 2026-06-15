"use client";
import { useEffect, useState } from "react";
import { useOrganization } from "@clerk/nextjs";
import { ROLES, ROLE_LABEL, ROLE_RANK, type Role } from "@os/schemas";
import { OrgSwitcher } from "../OrgSwitcher";
import { AccountSettings } from "./AccountSettings";
import { OrgSettings } from "./OrgSettings";
import { CreateOrgForm } from "./CreateOrgForm";
import { Modal, Field, Notice } from "../Modal";
import { Select } from "../Select";
import { confirmDialog } from "../confirm";

type Tab = "account" | "team" | "api";

const TABS: { id: Tab; label: string; hint: string }[] = [
  { id: "account", label: "Account & Security", hint: "Profile, email, password, 2FA, sessions, connected accounts" },
  { id: "team", label: "Team & Organization", hint: "Members, invitations, roles" },
  { id: "api", label: "API & Developers", hint: "Keys, endpoints, SDK" },
];

export function SettingsClient({ apiBase, role, canManageKeys }: { apiBase: string; role: Role; canManageKeys: boolean }) {
  const [tab, setTab] = useState<Tab>("account");
  const { organization } = useOrganization();

  return (
    <div className="split-2">
      {/* sub-nav */}
      <div className="card settings-subnav" style={{ padding: 12, position: "sticky", top: 80 }}>
        {TABS.map((t) => (
          <button key={t.id} onClick={() => setTab(t.id)} className={`nav-link${tab === t.id ? " active" : ""}`} style={{ width: "100%", border: "none", background: tab === t.id ? "var(--accent-surface)" : "none", cursor: "pointer", textAlign: "left", marginBottom: 2 }}>
            <span className="dot" />{t.label}
          </button>
        ))}
        <div className="sub" style={{ fontSize: 11.5, marginTop: 10, padding: "0 11px" }}>{TABS.find((t) => t.id === tab)?.hint}</div>
      </div>

      {/* panel */}
      <div style={{ minWidth: 0 }}>
        {tab === "account" && <AccountSettings />}

        {tab === "team" && (
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16, maxWidth: 280 }}>
              <OrgSwitcher />
            </div>
            {organization ? (
              <OrgSettings />
            ) : (
              <div className="card">
                <div className="stat-label">Create an organization</div>
                <div className="sub" style={{ margin: "10px 0 16px" }}>Organizations let you invite teammates, assign roles, and share a Socheli workspace.</div>
                <CreateOrgForm />
              </div>
            )}
          </div>
        )}

        {tab === "api" && (
          <div className="grid" style={{ gap: 16 }}>
            <div className="card">
              <div className="stat-label">API base URL</div>
              <pre className="codebox">{apiBase}</pre>
              <div className="sub" style={{ marginTop: 10 }}>The Socheli API is the backbone for the SDK, CLI, and MCP server. See the <a href="/docs/api" style={{ color: "var(--accent)" }}>API reference</a>.</div>
            </div>
            <ApiKeys apiBase={apiBase} role={role} canManage={canManageKeys} />
            <div className="card">
              <div className="stat-label">Surfaces</div>
              <div style={{ display: "grid", gap: 8, marginTop: 12 }}>
                {[["SDK", "@socheli/sdk", "/docs/sdk"], ["CLI", "socheli …", "/docs/cli"], ["MCP", "@socheli/mcp", "/docs/mcp"]].map(([k, v, href]) => (
                  <a key={k} href={href} className="row" style={{ padding: "12px 16px" }}>
                    <span style={{ fontWeight: 600, minWidth: 60 }}>{k}</span>
                    <code style={{ color: "var(--text-secondary)" }}>{v}</code>
                    <span className="row-cost" style={{ marginLeft: "auto", color: "var(--accent)" }}>docs →</span>
                  </a>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

type ApiKey = { id: string; prefix: string; role: Role; label: string; createdAt: string; lastUsedAt?: string; revokedAt?: string };

/* Real per-workspace API-key management. Lists keys from /api/keys, issues with a
   label + role (capped at the caller's role), shows the plaintext exactly once,
   and revokes. The whole panel is read-only unless the role has apikey.manage. */
function ApiKeys({ apiBase, role, canManage }: { apiBase: string; role: Role; canManage: boolean }) {
  const [keys, setKeys] = useState<ApiKey[] | null>(null);
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState(""); const [newRole, setNewRole] = useState<Role>("member");
  const [busy, setBusy] = useState(false); const [err, setErr] = useState("");
  const [issued, setIssued] = useState<string | null>(null); // plaintext, shown once

  // Roles you can grant on a key are capped at your own.
  const grantable: Role[] = ROLES.filter((r) => ROLE_RANK[r] <= ROLE_RANK[role]);

  const load = () => {
    fetch("/api/keys")
      .then((r) => (r.ok ? r.json() : { keys: [] }))
      .then((d) => setKeys(d.keys ?? []))
      .catch(() => setKeys([]));
  };
  useEffect(load, []);

  const issue = async () => {
    setBusy(true); setErr("");
    try {
      const r = await fetch("/api/keys", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ label, role: newRole }) });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error ?? "Failed to issue key");
      setIssued(d.key); setLabel(""); setOpen(false); load();
    } catch (e: any) { setErr(e?.message ?? "Failed"); }
    setBusy(false);
  };
  const revoke = async (k: ApiKey) => {
    if (!(await confirmDialog({ title: `Revoke "${k.label}"?`, message: "Any SDK / CLI / MCP client using this key will immediately lose access.", confirmText: "Revoke", danger: true }))) return;
    await fetch(`/api/keys/${k.id}`, { method: "DELETE" });
    load();
  };

  return (
    <div className="card">
      <div style={{ display: "flex", alignItems: "center", marginBottom: 8 }}>
        <div><div className="stat-label">API keys</div><div className="sub" style={{ marginTop: 6 }}>Keys authorize the SDK / CLI / MCP for this workspace. The secret is shown once at creation — store it safely.</div></div>
        {canManage && <button className="btn" onClick={() => setOpen(true)} style={{ marginLeft: "auto", padding: "8px 14px", fontSize: 12, whiteSpace: "nowrap" }}>+ New key</button>}
      </div>

      {issued && (
        <div className="card" style={{ borderColor: "var(--accent-muted)", margin: "10px 0", padding: 14 }}>
          <div className="stat-label" style={{ color: "var(--accent)" }}>New key — copy it now</div>
          <div className="sub" style={{ margin: "6px 0 8px" }}>This is the only time the full key is shown.</div>
          <div style={{ display: "flex", gap: 8 }}>
            <pre className="codebox" style={{ flex: 1, margin: 0, overflowX: "auto" }}>{issued}</pre>
            <button className="btn" onClick={() => { navigator.clipboard?.writeText(issued); }} style={{ padding: "8px 14px", fontSize: 12 }}>Copy</button>
            <button className="btn" onClick={() => setIssued(null)} style={{ padding: "8px 14px", fontSize: 12 }}>Done</button>
          </div>
          <pre className="codebox" style={{ marginTop: 10 }}>socheli login --key {issued} --url {apiBase}</pre>
        </div>
      )}

      {keys === null ? (
        <div className="sub" style={{ padding: "6px 0" }}>Loading…</div>
      ) : keys.length === 0 ? (
        <div className="sub" style={{ padding: "6px 0" }}>{canManage ? "No keys yet. Create one to authorize the SDK / CLI / MCP." : "No keys. Ask an admin to issue one."}</div>
      ) : (
        <div style={{ display: "grid", gap: 8, marginTop: 4 }}>
          {keys.map((k) => (
            <div key={k.id} className="row" style={{ padding: "12px 16px", opacity: k.revokedAt ? 0.55 : 1 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600 }}>{k.label}</div>
                <code style={{ color: "var(--text-secondary)", fontSize: 12 }}>{k.prefix}… · {ROLE_LABEL[k.role]}{k.lastUsedAt ? ` · used ${new Date(k.lastUsedAt).toLocaleDateString()}` : " · never used"}</code>
              </div>
              {k.revokedAt ? <span className="badge b-neutral"><span className="d" />revoked</span>
                : canManage ? <button className="btn danger" onClick={() => revoke(k)} style={{ padding: "5px 10px", fontSize: 11 }}>Revoke</button>
                : <span className="badge b-neutral"><span className="d" />active</span>}
            </div>
          ))}
        </div>
      )}

      <Modal open={open} onClose={() => setOpen(false)} title="Create API key" width={420}>
        <Notice>{err}</Notice>
        <Field label="Label" hint="A name to recognize this key (e.g. CI, my laptop)."><input className="input" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="CI pipeline" /></Field>
        <Field label="Role" hint="The key acts with this role; it can't exceed your own."><Select value={newRole} onChange={(v) => setNewRole(v as Role)} options={grantable.map((r) => ({ value: r, label: ROLE_LABEL[r] }))} ariaLabel="API key role" /></Field>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}><button className="btn" onClick={() => setOpen(false)}>Cancel</button><button className="btn btn-primary" onClick={issue} disabled={busy || !label.trim()}>{busy ? "Creating…" : "Create key"}</button></div>
      </Modal>
    </div>
  );
}
