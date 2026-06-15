"use client";

import {
  BookOpen,
  Check,
  CircleDashed,
  Cpu,
  Microscope,
  ShieldCheck,
  Swords,
  TrendingUp,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";
import type { ClaimStatus, ResearchKind, ResearchStatus } from "../../lib/research";

/* Shared vocabulary for the research surface: kind/claim/status metadata and
   the small badges both the list and the run page render. Kept monochrome on
   purpose — the design language allows ONE accent; semantic green/red come
   from the existing --success/--error vars (same as the rest of the app). */

export const KIND_META: Record<ResearchKind, { label: string; icon: LucideIcon }> = {
  trend: { label: "trend", icon: TrendingUp },
  algo: { label: "algo", icon: Cpu },
  topic: { label: "topic", icon: BookOpen },
  competitor: { label: "competitor", icon: Swords },
  deep: { label: "deep", icon: Microscope },
};

export const CLAIM_META: Record<ClaimStatus, { label: string; icon: LucideIcon; color: string }> = {
  verified: { label: "verified", icon: ShieldCheck, color: "var(--success, #5fd97a)" },
  "single-source": { label: "single source", icon: CircleDashed, color: "var(--text-muted)" },
  disputed: { label: "disputed", icon: TriangleAlert, color: "var(--error, #ef5350)" },
};

export function fmtAge(iso: string): string {
  const mins = Math.max(0, (Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return "now";
  if (mins < 60) return `${Math.round(mins)}m ago`;
  const h = mins / 60;
  if (h < 48) return `${Math.round(h)}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export function fmtUsd(usd: number): string {
  return `$${Number(usd ?? 0).toFixed(3)}`;
}

const mono: React.CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 10.5,
  letterSpacing: "0.07em",
  textTransform: "uppercase",
};

export function KindBadge({ kind }: { kind: ResearchKind }) {
  const m = KIND_META[kind] ?? KIND_META.topic;
  const Icon = m.icon;
  return (
    <span className="tag" style={{ display: "inline-flex", alignItems: "center", gap: 6, margin: 0 }}>
      <Icon size={11} />
      {m.label}
    </span>
  );
}

export function StatusBadge({ status }: { status: ResearchStatus }) {
  if (status === "running") {
    return (
      <span style={{ ...mono, display: "inline-flex", alignItems: "center", gap: 7, color: "var(--accent)" }}>
        <span
          className="pulse-dot"
          style={{ width: 7, height: 7, borderRadius: "50%", background: "var(--accent)", boxShadow: "0 0 8px var(--accent)" }}
        />
        running
      </span>
    );
  }
  if (status === "failed") {
    return (
      <span style={{ ...mono, display: "inline-flex", alignItems: "center", gap: 5, color: "var(--error, #ef5350)" }}>
        <TriangleAlert size={11} />
        failed
      </span>
    );
  }
  return (
    <span style={{ ...mono, display: "inline-flex", alignItems: "center", gap: 5, color: "var(--success, #5fd97a)" }}>
      <Check size={11} />
      done
    </span>
  );
}

/* Age vs TTL — the cache-freshness story: a done run younger than its ttlHours
   still answers its question for free; older runs are stale. */
export function FreshBadge({ status, ageHours, ttlHours }: { status: ResearchStatus; ageHours: number; ttlHours: number }) {
  if (status !== "done") return null;
  const fresh = ageHours <= ttlHours;
  const color = fresh ? "var(--success, #5fd97a)" : "var(--text-muted)";
  return (
    <span style={{ ...mono, display: "inline-flex", alignItems: "center", gap: 6, color }} title={`${ageHours.toFixed(1)}h old · ${ttlHours}h TTL`}>
      <span style={{ width: 6, height: 6, borderRadius: "50%", background: color, boxShadow: fresh ? `0 0 7px ${color}` : "none" }} />
      {fresh ? "fresh" : "stale"}
      <span style={{ color: "var(--text-muted)", textTransform: "none", letterSpacing: 0 }}>
        {Math.round(ageHours)}h/{ttlHours}h
      </span>
    </span>
  );
}
