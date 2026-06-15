"use client";
import { useCallback, useEffect, useState, type CSSProperties } from "react";
import { Modal, Field, Notice } from "../Modal";
import { confirmDialog } from "../confirm";
import { InkIcon, InkRing, InkTileFrame, InkXIcon } from "../../components/sketch";

/* MCP connections — plug external MCP servers into Soli's tool surface.
   Lists configured servers with a live status dot, adds (http always; stdio
   only when the deployment sets MCP_ALLOW_STDIO=1), toggles, deletes. The API
   (/api/mcp-servers) gates every mutation to admin/owner and redacts
   command/url details for everyone else — this card only ever offers what the
   role allows (canManage comes from the same response).

   Ink layer (house sketch grammar, logic untouched): mono eyebrow header with
   the glyph star, rows cascade in on the shared .blk-in 55ms stagger, a tiny
   wobbled ink ring draws around the dot of a connected server (the scorecard
   verdict-ring move), the Connect modal carries registration-tick corners,
   and the transport choice is two hand-drawn-bordered tiles — the stdio tile
   shows its env-blocked state with a small ink x-mark. */

type ServerRow = {
  id: string;
  name: string;
  transport: "stdio" | "http";
  enabled: boolean;
  status: "connected" | "error" | "disabled" | "stdio_blocked";
  toolCount: number | null;
  error: string | null;
  // present only for managers:
  command?: string | null;
  args?: string[];
  env?: string[];
  url?: string | null;
};

const DOT: Record<ServerRow["status"], string> = {
  connected: "var(--success)",
  error: "var(--error)",
  disabled: "var(--text-muted)",
  stdio_blocked: "var(--warning)",
};
const STATUS_LABEL: Record<ServerRow["status"], string> = {
  connected: "connected",
  error: "error",
  disabled: "off",
  stdio_blocked: "blocked",
};

export function McpServersCard() {
  const [servers, setServers] = useState<ServerRow[] | null>(null);
  const [canManage, setCanManage] = useState(false);
  const [stdioAllowed, setStdioAllowed] = useState(false);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  // add form
  const [name, setName] = useState("");
  const [transport, setTransport] = useState<"http" | "stdio">("http");
  const [url, setUrl] = useState("");
  const [command, setCommand] = useState("");
  const [args, setArgs] = useState("");

  const load = useCallback(() => {
    fetch("/api/mcp-servers")
      .then((r) => (r.ok ? r.json() : { servers: [] }))
      .then((d) => {
        setServers(d.servers ?? []);
        setCanManage(!!d.canManage);
        setStdioAllowed(!!d.stdioAllowed);
      })
      .catch(() => setServers([]));
  }, []);
  useEffect(load, [load]);

  const post = async (body: Record<string, unknown>) => {
    setBusy(true);
    setErr("");
    try {
      const r = await fetch("/api/mcp-servers", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error ?? "request failed");
      load();
      return true;
    } catch (e) {
      setErr(e instanceof Error ? e.message : "request failed");
      return false;
    } finally {
      setBusy(false);
    }
  };

  const add = async () => {
    const server =
      transport === "http"
        ? { name, transport, url }
        : { name, transport, command, args: args.split(/\s+/).filter(Boolean) };
    if (await post({ action: "add", server })) {
      setName(""); setUrl(""); setCommand(""); setArgs("");
      setOpen(false);
    }
  };

  const toggle = (s: ServerRow) => post({ action: "toggle", id: s.id, enabled: !s.enabled });

  const remove = async (s: ServerRow) => {
    if (!(await confirmDialog({ title: `Remove "${s.name}"?`, message: "Soli immediately loses every tool this server provides.", confirmText: "Remove", danger: true }))) return;
    await post({ action: "delete", id: s.id });
  };

  /* Transport tiles behave like a radiogroup: click or Left/Right/Up/Down
     arrows move the choice; the stdio tile stays focusable but inert (and
     announced disabled) when the deployment blocks stdio. */
  const pickTransport = (t: "http" | "stdio") => {
    if (t === "stdio" && !stdioAllowed) return;
    setTransport(t);
  };
  const onTilesKey = (e: React.KeyboardEvent) => {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) return;
    e.preventDefault();
    pickTransport(transport === "http" ? "stdio" : "http");
  };

  return (
    <div className="card" style={{ marginTop: 16 }}>
      <div className="mcp-head">
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="mcp-eyebrow">
            <InkIcon name="glyph" size={10} className="mcp-glyph" />
            <span>MCP connections</span>
          </div>
          <div className="sub" style={{ marginTop: 6 }}>
            Plug external MCP servers into Soli — their tools join the copilot&apos;s toolbox alongside the engine registry.
          </div>
        </div>
        {canManage && (
          <button className="btn" onClick={() => { setErr(""); setOpen(true); }} style={{ marginLeft: "auto", padding: "8px 14px", fontSize: 12, whiteSpace: "nowrap", flexShrink: 0 }}>
            + Connect server
          </button>
        )}
      </div>

      {!open && err && <Notice>{err}</Notice>}

      {servers === null ? (
        <div className="mcp-empty">loading…</div>
      ) : servers.length === 0 ? (
        <div className="mcp-empty">
          {canManage ? "no external servers connected — connect one to extend Soli" : "no external servers connected — ask an admin to add one"}
        </div>
      ) : (
        <div style={{ display: "grid", gap: 8, marginTop: 4 }}>
          {servers.map((s, i) => (
            <div key={s.id} className="row blk-in" style={{ padding: "12px 16px", opacity: s.enabled ? 1 : 0.6, "--i": i } as CSSProperties}>
              <span className="mcp-dot-wrap" title={s.error ?? STATUS_LABEL[s.status]}>
                <span className="mcp-dot" style={{ background: DOT[s.status] }} />
                {s.status === "connected" && (
                  <InkRing
                    className="mcp-ring"
                    style={{ "--ink-delay": `${300 + i * 140}ms`, "--ink-dur": "420ms" } as CSSProperties}
                  />
                )}
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600 }}>{s.name}</div>
                <code style={{ color: "var(--text-secondary)", fontSize: 12 }}>
                  {s.transport} · {STATUS_LABEL[s.status]}
                  {s.status === "connected" && s.toolCount != null ? ` · ${s.toolCount} tool${s.toolCount === 1 ? "" : "s"}` : ""}
                  {canManage && s.transport === "http" && s.url ? ` · ${s.url}` : ""}
                  {canManage && s.transport === "stdio" && s.command ? ` · ${s.command}${s.args?.length ? " …" : ""}` : ""}
                </code>
                {s.error && <div className="sub" style={{ fontSize: 11.5, color: "var(--error)", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.error}</div>}
              </div>
              {canManage ? (
                <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
                  <button className="btn" disabled={busy} onClick={() => toggle(s)} style={{ padding: "5px 10px", fontSize: 11 }}>
                    {s.enabled ? "Disable" : "Enable"}
                  </button>
                  <button className="btn danger" disabled={busy} onClick={() => remove(s)} style={{ padding: "5px 10px", fontSize: 11 }}>
                    Remove
                  </button>
                </div>
              ) : (
                <span className="badge b-neutral"><span className="d" />{s.enabled ? "on" : "off"}</span>
              )}
            </div>
          ))}
        </div>
      )}

      {!stdioAllowed && canManage && (
        <div className="sub" style={{ fontSize: 11.5, marginTop: 10 }}>
          Local command (stdio) servers are disabled on this deployment — running arbitrary commands on a shared server is unsafe. Set <code>MCP_ALLOW_STDIO=1</code> in the server environment to allow them; HTTP servers are always available.
        </div>
      )}

      <Modal open={open} onClose={() => setOpen(false)} title="Connect MCP server" width={460} className="mcp-modal">
        <span className="cmp-corners" aria-hidden="true" />
        <Notice>{err}</Notice>
        <Field label="Name" hint="How this connection shows up in Soli's tool list.">
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="My tools" />
        </Field>
        <Field label="Transport" hint={stdioAllowed ? "HTTP endpoint, or a local command spoken to over stdio." : "Only HTTP endpoints are available here (stdio is disabled by the deployment)."}>
          <div className="mcp-tiles" role="radiogroup" aria-label="MCP transport" onKeyDown={onTilesKey}>
            <button
              type="button"
              role="radio"
              aria-checked={transport === "http"}
              className={`mcp-tile${transport === "http" ? " on" : ""}`}
              onClick={() => pickTransport("http")}
            >
              <InkTileFrame className="mcp-tile-ink" />
              <span className="mcp-tile-name">HTTP</span>
              <span className="mcp-tile-sub">remote endpoint</span>
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={transport === "stdio"}
              aria-disabled={!stdioAllowed}
              className={`mcp-tile${transport === "stdio" ? " on" : ""}${stdioAllowed ? "" : " blocked"}`}
              title={stdioAllowed ? undefined : "stdio is disabled on this deployment (MCP_ALLOW_STDIO unset)"}
              onClick={() => pickTransport("stdio")}
            >
              <InkTileFrame className="mcp-tile-ink" />
              {!stdioAllowed && <InkXIcon size={11} className="mcp-tile-x" />}
              <span className="mcp-tile-name">Local command</span>
              <span className="mcp-tile-sub">stdio</span>
            </button>
          </div>
        </Field>
        {transport === "http" ? (
          <Field label="URL" hint="The server's JSON-RPC endpoint (streamable HTTP).">
            <input className="input" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://mcp.example.com/mcp" />
          </Field>
        ) : (
          <>
            <Field label="Command" hint="Executable to spawn on the dashboard host.">
              <input className="input" value={command} onChange={(e) => setCommand(e.target.value)} placeholder="npx" />
            </Field>
            <Field label="Arguments" hint="Space-separated argv.">
              <input className="input" value={args} onChange={(e) => setArgs(e.target.value)} placeholder="-y some-mcp-server" />
            </Field>
          </>
        )}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button className="btn" onClick={() => setOpen(false)}>Cancel</button>
          <button className="btn btn-primary" onClick={add} disabled={busy || !name.trim() || (transport === "http" ? !url.trim() : !command.trim())}>
            {busy ? "Connecting…" : "Connect"}
          </button>
        </div>
      </Modal>
    </div>
  );
}
