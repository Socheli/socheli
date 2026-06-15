"use client";

import { AlertTriangle, CalendarX, Layers, Users } from "lucide-react";
import { confirmDialog, promptDialog } from "../confirm";
import type { Conflict } from "../../lib/calendar-admin";

/* Presentational conflict view. The engine (caladmin_conflicts) already detected
   everything — this panel only RENDERS the precomputed buckets and offers a deep
   "Reschedule" action per row (behind a confirm) that bubbles up to the board's
   reschedule mutation. No detection logic lives here. */

const KIND_META: Record<
  Conflict["kind"],
  { label: string; icon: typeof AlertTriangle; badge: string }
> = {
  overlap: { label: "Overlapping slots", icon: Layers, badge: "b-warn" },
  overCapacity: { label: "Over-capacity day", icon: AlertTriangle, badge: "b-warn" },
  collision: { label: "Brand collision", icon: Users, badge: "b-warn" },
  blackoutViolation: { label: "Blackout violation", icon: CalendarX, badge: "b-err" },
};

export function ConflictsPanel({
  conflicts,
  canManage,
  onReschedule,
}: {
  conflicts: Conflict[];
  canManage: boolean;
  onReschedule: (ids: string[]) => void;
}) {
  if (!conflicts.length) {
    return (
      <div className="card" style={{ textAlign: "center", color: "var(--text-secondary)", padding: "2rem" }}>
        No scheduling conflicts detected across your brands.
      </div>
    );
  }

  // Group by kind for a scannable read-out.
  const groups = new Map<Conflict["kind"], Conflict[]>();
  for (const c of conflicts) {
    const arr = groups.get(c.kind) ?? [];
    arr.push(c);
    groups.set(c.kind, arr);
  }

  async function reschedule(ids: string[]) {
    if (!ids.length) return;
    const ok = await confirmDialog({
      title: "Reschedule conflicting post(s)?",
      message: `Move ${ids.length} post${ids.length === 1 ? "" : "s"} to clear this conflict.`,
    });
    if (ok) onReschedule(ids);
  }

  return (
    <div style={{ display: "grid", gap: "1rem" }}>
      {[...groups.entries()].map(([kind, rows]) => {
        const meta = KIND_META[kind];
        const Icon = meta.icon;
        return (
          <div className="card" key={kind}>
            <div className="row-title" style={{ display: "flex", alignItems: "center", gap: ".5rem", marginBottom: ".75rem" }}>
              <Icon size={16} />
              {meta.label}
              <span className={`badge ${meta.badge}`}>
                <span className="d" />
                {rows.length}
              </span>
            </div>
            <div style={{ display: "grid", gap: ".5rem" }}>
              {rows.map((c, i) => (
                <div className="row" key={`${kind}-${i}`} style={{ alignItems: "center" }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: ".8rem" }}>{c.message || "Conflict"}</div>
                    <div className="row-id">
                      {c.date}
                      {c.channel ? ` · ${c.channel}` : ""}
                      {c.postIds.length ? ` · ${c.postIds.length} post${c.postIds.length === 1 ? "" : "s"}` : ""}
                    </div>
                  </div>
                  {canManage && c.postIds.length > 0 && (
                    <button className="btn" onClick={() => reschedule(c.postIds)}>
                      Reschedule
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* Re-exported so the board can offer a prompt-driven reschedule from a conflict
   row without duplicating the date prompt (the board owns the actual POST). */
export async function promptRescheduleDate(): Promise<string | null> {
  return promptDialog({ title: "Reschedule to date", placeholder: "YYYY-MM-DD" });
}
