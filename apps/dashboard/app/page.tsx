import Link from "next/link";
import { SoliPage } from "./soli/SoliPage";
import { currentWorkspaceId } from "../lib/tenancy";
import { listItemsFor } from "../lib/data";
import { loadPlanFor } from "../lib/content-plan";
import { loadSchedule } from "../lib/schedule";
import { adminStateFor } from "../lib/admin";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Soli · Socheli",
  description: "Soli, your social media manager",
};

/* / — the home IS Soli. The full-page chat (same ChatCore + shared useAgent
   store as the Cmd+K panel) is the primary interface; every classic page —
   War Room included, now at /war-room — remains a deep-link destination.
   This server component's only job is the command-center strip above the
   chat: a greeting plus 3–4 live stat chips, each one a callback link into
   the page that owns it. Every read is wrapped — a broken data file renders
   a dash, never an error page. */

// Statuses that mean a run has left production (mirrors /queue's TERMINAL set).
const TERMINAL = new Set(["packaged", "rendered", "failed", "qa_failed", "published"]);

function greeting(): string {
  const h = new Date().getHours();
  if (h < 5) return "Working late";
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}

/* "Sat 18:00" / "Today 18:00" for the next planned post still ahead of now. */
function nextPostLabel(workspaceId: string): string | null {
  const LIVE = new Set(["idea", "approved", "scheduled"]);
  const now = new Date();
  const upcoming = loadPlanFor(workspaceId)
    .filter((p) => LIVE.has(p.status) && p.date)
    .map((p) => ({ p, at: new Date(`${p.date}T${p.time || "09:00"}`) }))
    .filter((x) => !Number.isNaN(x.at.getTime()) && x.at.getTime() >= now.getTime())
    .sort((a, b) => a.at.getTime() - b.at.getTime())[0];
  if (!upcoming) return null;
  const sameDay = upcoming.at.toDateString() === now.toDateString();
  const day = sameDay ? "Today" : upcoming.at.toLocaleDateString("en-US", { weekday: "short" });
  return `${day} ${upcoming.p.time || ""}`.trim();
}

type Chip = { label: string; value: string; href: string; tone?: "accent" | "error" };

async function statChips(): Promise<Chip[]> {
  let workspaceId: string;
  try {
    workspaceId = await currentWorkspaceId();
  } catch {
    return [];
  }

  const chips: Chip[] = [];

  // In production — runs still moving through the pipeline (the /queue view).
  try {
    const inFlight = listItemsFor(workspaceId).filter((it) => !TERMINAL.has(it.status) && !it.videoPath).length;
    chips.push({ label: "In production", value: String(inFlight), href: "/queue", tone: inFlight > 0 ? "accent" : undefined });
  } catch {
    chips.push({ label: "In production", value: "—", href: "/queue" });
  }

  // Next post — the soonest upcoming planned post on the calendar.
  try {
    chips.push({ label: "Next post", value: nextPostLabel(workspaceId) ?? "—", href: "/calendar" });
  } catch {
    chips.push({ label: "Next post", value: "—", href: "/calendar" });
  }

  // Autopilot — is hands-free posting armed for this workspace?
  try {
    chips.push({ label: "Autopilot", value: loadSchedule(workspaceId).enabled ? "On" : "Off", href: "/autopilot" });
  } catch {
    chips.push({ label: "Autopilot", value: "—", href: "/autopilot" });
  }

  // Ops — the workspace kill-switch (admin cockpit). Loud when engaged.
  try {
    const halted = adminStateFor(workspaceId).killSwitch;
    chips.push({ label: "Ops", value: halted ? "HALTED" : "Clear", href: "/admin", tone: halted ? "error" : undefined });
  } catch {
    chips.push({ label: "Ops", value: "—", href: "/admin" });
  }

  return chips;
}

export default async function Home() {
  const chips = await statChips();

  return (
    <SoliPage
      statusStrip={
        <div className="home-strip">
          <span className="home-greet">{greeting()} · state of play</span>
          <div className="home-chips">
            {chips.map((c) => (
              <Link key={c.href} href={c.href} className={`home-chip${c.tone ? ` ${c.tone}` : ""}`} title={`Open ${c.href}`}>
                <span className="home-chip-label">{c.label}</span>
                <span className="home-chip-value">{c.value}</span>
              </Link>
            ))}
          </div>
        </div>
      }
    />
  );
}
