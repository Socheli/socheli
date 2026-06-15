"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import type { Schedule, Slot } from "../../lib/schedule";
import { Select } from "../Select";
import { TimePicker } from "../TimePicker";

const MOODS = ["", "explainer", "motivational", "business", "tech", "mindfulness"];

function CopyCmd({ cmd }: { cmd: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <code
      onClick={async () => { await navigator.clipboard.writeText(cmd); setCopied(true); setTimeout(() => setCopied(false), 1400); }}
      style={{ cursor: "pointer", background: "var(--bg-surface)", border: "1px solid var(--border-subtle)", borderRadius: 6, padding: "4px 9px", fontSize: 12, color: copied ? "var(--success)" : "var(--text-light)" }}
      title="click to copy"
    >
      {copied ? "✓ copied" : cmd}
    </code>
  );
}

export function AutopilotControls({
  initial,
  channels,
  canManage = true,
}: {
  initial: Schedule;
  channels: { id: string; name: string }[];
  canManage?: boolean;
}) {
  const router = useRouter();
  const [s, setS] = useState<Schedule>(initial);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  const update = (patch: Partial<Schedule>) => setS((cur) => ({ ...cur, ...patch }));

  const cadenceFor = (channel: string) => s.channels.find((c) => c.channel === channel);
  const setCadence = (channel: string, patch: Partial<{ enabled: boolean; slots: Slot[] }>) =>
    setS((cur) => {
      const existing = cur.channels.find((c) => c.channel === channel);
      const channels = existing
        ? cur.channels.map((c) => (c.channel === channel ? { ...c, ...patch } : c))
        : [...cur.channels, { channel, enabled: true, slots: [], ...patch }];
      return { ...cur, channels };
    });

  const addSlot = (channel: string) => {
    const cad = cadenceFor(channel);
    const slots = [...(cad?.slots ?? []), { time: "09:00", channel, mood: "", seed: "", public: false }];
    setCadence(channel, { slots });
  };
  const editSlot = (channel: string, i: number, patch: Partial<Slot>) => {
    const cad = cadenceFor(channel);
    if (!cad) return;
    setCadence(channel, { slots: cad.slots.map((sl, j) => (j === i ? { ...sl, ...patch } : sl)) });
  };
  const removeSlot = (channel: string, i: number) => {
    const cad = cadenceFor(channel);
    if (!cad) return;
    setCadence(channel, { slots: cad.slots.filter((_, j) => j !== i) });
  };

  const save = async () => {
    if (!canManage) return;
    setBusy(true);
    await fetch("/api/schedule", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(s) });
    setBusy(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 1600);
    router.refresh();
  };

  const totalSlots = s.channels.reduce((a, c) => a + (c.enabled ? c.slots.length : 0), 0);

  return (
    <div className="grid" style={{ gap: 20 }}>
      {!canManage && (
        <div className="sub" style={{ color: "var(--text-muted)" }}>
          You have read-only access to this workspace's cadence — ask an admin to change the schedule.
        </div>
      )}
      {/* master switch */}
      <div className="card" style={{ display: "flex", alignItems: "center", gap: 16, borderColor: s.enabled ? "var(--accent-muted)" : undefined }}>
        <div style={{ flex: 1 }}>
          <div className="stat-label" style={{ color: s.enabled ? "var(--accent)" : undefined }}>Autopilot</div>
          <div className="sub" style={{ marginTop: 4 }}>
            {s.enabled ? `Armed — ${totalSlots} post${totalSlots === 1 ? "" : "s"}/day across ${s.channels.filter((c) => c.enabled && c.slots.length).length} channel(s).` : "Disabled — the scheduler will no-op until you arm it."}
          </div>
        </div>
        <button onClick={() => update({ enabled: !s.enabled })} disabled={!canManage} className={`btn ${s.enabled ? "btn-primary" : ""}`}>
          {s.enabled ? "Armed" : "Arm autopilot"}
        </button>
      </div>

      <div className="card" style={{ display: "flex", gap: 24, alignItems: "center", flexWrap: "wrap" }}>
        <label style={{ display: "flex", flexDirection: "column", gap: 5 }}>
          <span className="stat-label">Timezone</span>
          <input value={s.timezone} onChange={(e) => update({ timezone: e.target.value })} disabled={!canManage} className="input" style={{ width: 220 }} />
        </label>
        <label style={{ display: "flex", flexDirection: "column", gap: 5 }}>
          <span className="stat-label">Grace window (min)</span>
          <input type="number" min={1} max={120} value={s.graceMinutes} onChange={(e) => update({ graceMinutes: Number(e.target.value) })} disabled={!canManage} className="input" style={{ width: 90 }} />
        </label>
        <div style={{ marginLeft: "auto", display: "flex", gap: 10, alignItems: "center" }}>
          {saved && <span style={{ color: "var(--success)", fontSize: 13 }}>✓ saved</span>}
          <button onClick={save} disabled={busy || !canManage} className="btn btn-primary" style={{ opacity: busy || !canManage ? 0.6 : 1 }}>{busy ? "Saving…" : "Save schedule"}</button>
        </div>
      </div>

      {/* per-channel cadence */}
      {channels.map((ch) => {
        const cad = cadenceFor(ch.id);
        const on = cad?.enabled ?? false;
        return (
          <div key={ch.id} className="card">
            <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: cad?.slots.length ? 14 : 0 }}>
              <button onClick={() => setCadence(ch.id, { enabled: !on })} disabled={!canManage} className={`badge ${on ? "b-ok" : "b-neutral"}`} style={{ cursor: canManage ? "pointer" : "default", border: "none" }}>
                <span className="d" />{on ? "on" : "off"}
              </button>
              <span style={{ fontWeight: 650 }}>{ch.name}</span>
              <span className="row-cost">{ch.id}</span>
              <button onClick={() => addSlot(ch.id)} disabled={!canManage} className="btn" style={{ marginLeft: "auto", padding: "5px 12px", fontSize: 12 }}>+ Add slot</button>
            </div>
            {cad?.slots.map((sl, i) => (
              <div key={i} style={{ display: "flex", gap: 10, alignItems: "center", padding: "8px 0", borderTop: "1px solid var(--border-subtle)", flexWrap: "wrap", opacity: on ? 1 : 0.5 }}>
                <TimePicker value={sl.time} onChange={(v) => editSlot(ch.id, i, { time: v })} width={110} ariaLabel="Slot time" />
                <Select value={sl.mood ?? ""} onChange={(v) => editSlot(ch.id, i, { mood: v })} width={150} ariaLabel="Mood"
                  options={MOODS.map((m) => ({ value: m, label: m || "auto mood" }))} />
                <input value={sl.seed ?? ""} onChange={(e) => editSlot(ch.id, i, { seed: e.target.value })} disabled={!canManage} placeholder="seed (blank = auto-select concept)" className="input" style={{ flex: 1, minWidth: 180 }} />
                <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: sl.public ? "var(--accent)" : "var(--text-muted)" }}>
                  <input type="checkbox" checked={sl.public} onChange={(e) => editSlot(ch.id, i, { public: e.target.checked })} disabled={!canManage} />
                  public
                </label>
                <button onClick={() => removeSlot(ch.id, i)} disabled={!canManage} className="btn" style={{ padding: "5px 10px", fontSize: 12, color: "var(--error)" }}>✕</button>
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}

export { CopyCmd };
