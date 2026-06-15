"use client";

import { useState } from "react";
import { Modal, Field, Notice } from "../Modal";
import { Select } from "../Select";
import type { BrandLite } from "./MissionsBoard";

/* The create-mission composer: channel, standing goal, per-loop cadence,
   budgets and the two approval gates → POST /api/missions (engine
   mission_create). Loops set to "off" are omitted so the engine only runs
   what's chosen; leaving ALL loops off falls back to the engine's full
   default cadence (research/plan/evolve weekly, generate/analyze daily). */

const LOOPS = [
  { id: "research", label: "Research", hint: "refresh algo + trend research" },
  { id: "plan", label: "Plan", hint: "re-run the algo plan onto the calendar" },
  { id: "generate", label: "Generate", hint: "produce the day's planned post" },
  { id: "analyze", label: "Analyze", hint: "ingest analytics into learnings" },
  { id: "evolve", label: "Evolve", hint: "propose DNA mutations" },
] as const;

const CADENCES = [
  { value: "", label: "Off" },
  { value: "hourly", label: "Hourly" },
  { value: "daily", label: "Daily" },
  { value: "every 2 days", label: "Every 2 days" },
  { value: "every 3 days", label: "Every 3 days" },
  { value: "weekly", label: "Weekly" },
  { value: "every 2 weeks", label: "Every 2 weeks" },
];

const DEFAULTS: Record<string, string> = {
  research: "weekly",
  plan: "weekly",
  generate: "daily",
  analyze: "daily",
  evolve: "weekly",
};

function GateToggle({ value, onChange, disabled }: { value: "gate" | "auto"; onChange: (v: "gate" | "auto") => void; disabled?: boolean }) {
  return (
    <div style={{ display: "inline-flex", gap: 6 }}>
      {(["gate", "auto"] as const).map((v) => (
        <button
          key={v}
          type="button"
          disabled={disabled}
          className={`btn${value === v ? " btn-primary" : ""}`}
          style={{ padding: "6px 13px", fontSize: 12 }}
          onClick={() => onChange(v)}
        >
          {v === "gate" ? "Gated" : "Auto"}
        </button>
      ))}
    </div>
  );
}

export function MissionComposer({ brands, onClose, onCreated }: { brands: BrandLite[]; onClose: () => void; onCreated: () => void }) {
  const [channel, setChannel] = useState(brands[0]?.id ?? "");
  const [goal, setGoal] = useState("");
  const [cadence, setCadence] = useState<Record<string, string>>({ ...DEFAULTS });
  const [publish, setPublish] = useState<"gate" | "auto">("gate");
  const [dna, setDna] = useState<"gate" | "auto">("gate");
  const [usdPerDay, setUsdPerDay] = useState("");
  const [postsPerDay, setPostsPerDay] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async () => {
    if (!channel) return setErr("Pick a brand first.");
    if (!goal.trim()) return setErr("Give the mission a standing goal.");
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch("/api/missions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          channel,
          goal: goal.trim(),
          cadence: Object.fromEntries(Object.entries(cadence).filter(([, v]) => v)),
          approvalPolicy: { publish, dnaMutations: dna },
          budget: {
            ...(Number(usdPerDay) > 0 ? { usdPerDay: Number(usdPerDay) } : {}),
            ...(Number(postsPerDay) > 0 ? { postsPerDay: Number(postsPerDay) } : {}),
          },
        }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
      onCreated();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "mission create failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open onClose={onClose} title="New mission" subtitle="A standing goal the system advances autonomously, on your gates." width={560}>
      <Field label="Brand">
        {brands.length ? (
          <Select
            value={channel}
            onChange={setChannel}
            ariaLabel="Mission brand"
            width="100%"
            options={brands.map((b) => ({ value: b.id, label: b.name }))}
          />
        ) : (
          <div className="sub" style={{ fontSize: 12.5 }}>
            No brands in this workspace yet — create one under <a href="/channels">Brands</a> first.
          </div>
        )}
      </Field>

      <Field label="Standing goal" hint={'e.g. "grow IG to 10k with daily premium reels"'}>
        <input
          className="input"
          value={goal}
          autoFocus
          placeholder="What should this mission keep pushing toward?"
          onChange={(e) => setGoal(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
        />
      </Field>

      <Field label="Cadence" hint="Which loops run, and how often. Off = this mission never runs that loop.">
        <div style={{ display: "grid", gap: 8 }}>
          {LOOPS.map((l) => (
            <div key={l.id} style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span style={{ fontFamily: "var(--font-mono)", fontSize: 11.5, color: "var(--text-secondary)", width: 76, flexShrink: 0 }}>{l.label}</span>
              <Select
                value={cadence[l.id] ?? ""}
                onChange={(v) => setCadence((c) => ({ ...c, [l.id]: v }))}
                ariaLabel={`${l.label} cadence`}
                width={150}
                options={CADENCES}
              />
              <span className="sub" style={{ fontSize: 11, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{l.hint}</span>
            </div>
          ))}
        </div>
      </Field>

      <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
        <Field label="Budget / day (USD)" hint="Hard cap; blocked tasks wait for midnight.">
          <input className="input" type="number" min="0" step="0.5" placeholder="e.g. 5" value={usdPerDay} onChange={(e) => setUsdPerDay(e.target.value)} style={{ width: 150 }} />
        </Field>
        <Field label="Posts / day" hint="Max posts the generate loop makes.">
          <input className="input" type="number" min="0" step="1" placeholder="e.g. 1" value={postsPerDay} onChange={(e) => setPostsPerDay(e.target.value)} style={{ width: 150 }} />
        </Field>
      </div>

      <Field label="Publishing" hint="Gated = finished posts wait in the approvals inbox. Generate tasks can never auto-publish past this.">
        <GateToggle value={publish} onChange={setPublish} disabled={busy} />
      </Field>
      <Field label="DNA mutations" hint="Gated = every proposed genome mutation queues for your approval.">
        <GateToggle value={dna} onChange={setDna} disabled={busy} />
      </Field>

      <Notice>{err}</Notice>

      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 4 }}>
        <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
        <button className="btn btn-primary" onClick={submit} disabled={busy || !brands.length}>
          {busy ? "Creating…" : "Create mission"}
        </button>
      </div>
    </Modal>
  );
}
