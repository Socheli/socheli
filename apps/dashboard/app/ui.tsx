import Link from "next/link";
import type { Item } from "../lib/data";

/* The projects/channels — shared across the dashboard for per-project filtering. */
export const CHANNELS = [
  { id: "labrinox", name: "Labrinox" },
  { id: "claude_code_lab", name: "Code Labrinox" },
  { id: "agentic_builder", name: "Agentic Builder" },
  { id: "moltjobs", name: "MoltJobs" },
  { id: "cognitivx", name: "iCog" },
];
export const channelName = (id?: string) => CHANNELS.find((c) => c.id === id)?.name ?? (id ?? "").replace(/_/g, " ");

/* Content clusters (moods) — shared labels for the library/filters. */
export const MOODS = [
  { id: "explainer", name: "Explainer" },
  { id: "business", name: "Business" },
  { id: "tech", name: "Tech" },
  { id: "motivational", name: "Motivational" },
  { id: "mindfulness", name: "Mindfulness" },
  { id: "cinematic", name: "Cinematic" },
  { id: "motion_graphics", name: "Motion Graphics" },
  { id: "ops_room", name: "Ops Room" },
  { id: "war_economy", name: "War Economy" },
];
export const moodName = (id?: string) => MOODS.find((m) => m.id === id)?.name ?? (id ? id.replace(/_/g, " ") : "—");

/* Output formats. "longform" = 16:9 YouTube; everything else = 9:16 short. */
export const kindLabel = (kind?: string) => {
  if (kind === "longform") return "Long-form";
  if (kind === "static_image") return "Static";
  if (kind === "carousel") return "Carousel";
  return "Reel";
};

/* A per-project filter bar (server-rendered links with ?channel=…). */
export function ChannelFilter({ active, base }: { active?: string; base: string }) {
  const tabs = [{ id: "", name: "All" }, ...CHANNELS];
  return (
    <div className="chan-filter">
      {tabs.map((t) => (
        <Link key={t.id || "all"} href={t.id ? `${base}?channel=${t.id}` : base} className={`chan-tab${(active ?? "") === t.id ? " on" : ""}`}>
          {t.name}
        </Link>
      ))}
    </div>
  );
}

const STATUS_CLASS: Record<string, string> = {
  packaged: "b-ok",
  rendered: "b-ok",
  qa_passed: "b-accent",
  qa_failed: "b-err",
  failed: "b-err",
  storyboard_ready: "b-neutral",
  script_ready: "b-neutral",
  idea_proposed: "b-neutral",
};

export function StatusBadge({ status }: { status: string }) {
  return (
    <span className={`badge ${STATUS_CLASS[status] ?? "b-neutral"}`}>
      <span className="d" />
      {status.replace(/_/g, " ")}
    </span>
  );
}

export function Stat({ label, value, unit, foot }: { label: string; value: string | number; unit?: string; foot?: string }) {
  return (
    <div className="card">
      <div className="stat-label">{label}</div>
      <div className="stat-value">
        {value}
        {unit && <span className="stat-unit">{unit}</span>}
      </div>
      {foot && <div className="stat-foot">{foot}</div>}
    </div>
  );
}

const QA_COLOR = (n: number) => (n >= 8 ? "var(--success)" : n >= 6 ? "var(--warning)" : "var(--error)");

export function QABars({ scores }: { scores: Record<string, number> }) {
  return (
    <div>
      {Object.entries(scores).map(([k, v]) => (
        <div className="qa-row" key={k}>
          <div className="qa-name">{k.replace(/_/g, " ")}</div>
          <div className="qa-track">
            <div className="qa-fill" style={{ width: `${v * 10}%`, background: QA_COLOR(v) }} />
          </div>
          <div className="qa-num">{v}</div>
        </div>
      ))}
    </div>
  );
}

export function fmtCost(n: number) {
  return `$${n.toFixed(3)}`;
}
