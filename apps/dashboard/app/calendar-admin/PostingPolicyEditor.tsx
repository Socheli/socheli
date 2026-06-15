"use client";

import { useState } from "react";
import { Clock, Plus, Save, Trash2 } from "lucide-react";
import type { AdminBrand, Blackout, PostingPolicy } from "../../lib/calendar-admin";

/* Per-brand posting-policy editor. Cadence (per-platform posts/week + a per-day
   max), a READ-ONLY best-times read-out (learned by the best-times strategy,
   surfaced from props — never edited here), and a blackout-window editor
   (add/remove {from,to,startTime?,endTime?,reason?} rows).

   Saving POSTs { action:'policy_set', channel, policy } to /api/calendar-admin,
   which routes through the engine caladmin_policy_set tool (the SOLE writer of
   data/calendar-policy/<channel>.json). Read-only unless canManage. */

const PLATFORMS = ["youtube", "instagram", "tiktok", "x", "linkedin", "telegram"];

export function PostingPolicyEditor({
  brand,
  policy,
  canManage,
  onSave,
}: {
  brand: AdminBrand;
  policy: PostingPolicy;
  canManage: boolean;
  onSave: (channel: string, policy: PostingPolicy) => Promise<boolean>;
}) {
  const [perWeek, setPerWeek] = useState<Record<string, number>>(() => ({ ...(policy.cadence?.perWeek ?? {}) }));
  const [perDayMax, setPerDayMax] = useState<string>(
    policy.cadence?.perDayMax != null ? String(policy.cadence.perDayMax) : "",
  );
  const [blackouts, setBlackouts] = useState<Blackout[]>(() => [...(policy.blackouts ?? [])]);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  const bestTimes = policy.bestTimes ?? [];

  function setWeek(platform: string, v: string) {
    setDirty(true);
    setPerWeek((prev) => {
      const next = { ...prev };
      const n = Number(v);
      if (!v || Number.isNaN(n) || n <= 0) delete next[platform];
      else next[platform] = Math.round(n);
      return next;
    });
  }

  function addBlackout() {
    setDirty(true);
    setBlackouts((prev) => [...prev, { from: "", to: "" }]);
  }
  function patchBlackout(i: number, patch: Partial<Blackout>) {
    setDirty(true);
    setBlackouts((prev) => prev.map((b, idx) => (idx === i ? { ...b, ...patch } : b)));
  }
  function removeBlackout(i: number) {
    setDirty(true);
    setBlackouts((prev) => prev.filter((_, idx) => idx !== i));
  }

  async function save() {
    setSaving(true);
    const cleanBlackouts = blackouts.filter((b) => b.from && b.to);
    const next: PostingPolicy = {
      channel: brand.id,
      cadence: {
        perWeek,
        ...(perDayMax && !Number.isNaN(Number(perDayMax)) ? { perDayMax: Math.round(Number(perDayMax)) } : {}),
      },
      blackouts: cleanBlackouts,
    };
    const ok = await onSave(brand.id, next);
    setSaving(false);
    if (ok) setDirty(false);
  }

  return (
    <div className="card">
      <div className="row-title" style={{ display: "flex", alignItems: "center", gap: ".5rem", marginBottom: ".75rem" }}>
        <span style={{ width: 9, height: 9, borderRadius: "50%", background: brand.accent, display: "inline-block" }} />
        {brand.name}
      </div>

      {/* Cadence */}
      <div className="stat-label" style={{ marginBottom: ".4rem" }}>Cadence — posts per week</div>
      <div className="grid cols-2" style={{ gap: ".5rem", marginBottom: ".75rem" }}>
        {PLATFORMS.map((p) => (
          <label key={p} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: ".5rem", fontSize: ".8rem" }}>
            <span style={{ textTransform: "capitalize", color: "var(--text-secondary)" }}>{p}</span>
            <input
              type="number"
              min={0}
              disabled={!canManage}
              value={perWeek[p] ?? ""}
              onChange={(e) => setWeek(p, e.target.value)}
              style={{ width: 64 }}
              placeholder="0"
            />
          </label>
        ))}
      </div>
      <label style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: ".5rem", fontSize: ".8rem", marginBottom: "1rem" }}>
        <span style={{ color: "var(--text-secondary)" }}>Max posts / day</span>
        <input
          type="number"
          min={0}
          disabled={!canManage}
          value={perDayMax}
          onChange={(e) => { setDirty(true); setPerDayMax(e.target.value); }}
          style={{ width: 64 }}
          placeholder="∞"
        />
      </label>

      {/* Best times — read-only */}
      <div className="stat-label" style={{ marginBottom: ".4rem" }}>Best times (learned)</div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: ".4rem", marginBottom: "1rem" }}>
        {bestTimes.length ? (
          bestTimes.map((t, i) => (
            <span className="badge b-neutral" key={i}>
              <Clock size={11} style={{ marginRight: 3 }} />
              {t.day ? `${t.day} ` : ""}{t.time}{t.platform ? ` · ${t.platform}` : ""}
            </span>
          ))
        ) : (
          <span style={{ color: "var(--text-secondary)", fontSize: ".8rem" }}>No learned best-times yet.</span>
        )}
      </div>

      {/* Blackouts */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: ".4rem" }}>
        <div className="stat-label">Blackout windows (no posting)</div>
        {canManage && (
          <button className="btn" onClick={addBlackout} style={{ padding: ".2rem .5rem" }}>
            <Plus size={13} /> Add
          </button>
        )}
      </div>
      <div style={{ display: "grid", gap: ".4rem" }}>
        {blackouts.length === 0 && (
          <span style={{ color: "var(--text-secondary)", fontSize: ".8rem" }}>No blackout windows.</span>
        )}
        {blackouts.map((b, i) => (
          <div key={i} style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: ".35rem", fontSize: ".78rem" }}>
            <input type="date" disabled={!canManage} value={b.from} onChange={(e) => patchBlackout(i, { from: e.target.value })} style={{ width: 130 }} />
            <span style={{ color: "var(--text-secondary)" }}>→</span>
            <input type="date" disabled={!canManage} value={b.to} onChange={(e) => patchBlackout(i, { to: e.target.value })} style={{ width: 130 }} />
            <input type="time" disabled={!canManage} value={b.startTime ?? ""} onChange={(e) => patchBlackout(i, { startTime: e.target.value || undefined })} style={{ width: 90 }} title="window start (optional)" />
            <input type="time" disabled={!canManage} value={b.endTime ?? ""} onChange={(e) => patchBlackout(i, { endTime: e.target.value || undefined })} style={{ width: 90 }} title="window end (optional)" />
            <input
              type="text"
              disabled={!canManage}
              value={b.reason ?? ""}
              onChange={(e) => patchBlackout(i, { reason: e.target.value || undefined })}
              placeholder="reason"
              style={{ flex: 1, minWidth: 100 }}
            />
            {canManage && (
              <button className="btn danger" onClick={() => removeBlackout(i)} style={{ padding: ".2rem .4rem" }}>
                <Trash2 size={13} />
              </button>
            )}
          </div>
        ))}
      </div>

      {canManage && (
        <div style={{ marginTop: "1rem", display: "flex", justifyContent: "flex-end" }}>
          <button className="btn btn-primary" onClick={save} disabled={saving || !dirty}>
            <Save size={14} /> {saving ? "Saving…" : "Save policy"}
          </button>
        </div>
      )}
    </div>
  );
}
