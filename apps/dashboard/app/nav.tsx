import {
  LayoutDashboard, Lightbulb, FlaskConical, Telescope, ListVideo, CalendarDays, Rocket,
  Target, LibraryBig, BarChart3, Activity, Palette, Settings, BookOpen,
  PenSquare, HardDrive, Inbox, Plug2, ShieldCheck, CalendarCheck, Bot, Eye, Megaphone, Sparkles, Cpu, Scissors, type LucideIcon,
} from "lucide-react";

/* Single source of truth for the app's navigation — consumed by both the
   Sidebar (renders the rail) and the Header (derives the breadcrumb). One place
   to add a route, label, icon and section. */

export type NavItem = { href: string; label: string; icon: LucideIcon; desc?: string };
export type NavSection = { section: string; links: NavItem[] };

/* The home item, pinned above the sections — home IS Soli, the agent surface;
   every classic page (War Room included) is a deep-link destination off it. */
export const HOME: NavItem = { href: "/", label: "Soli", icon: Sparkles, desc: "Your agent" };

/* The primary action — surfaced as the sidebar's CTA and the header's New button. */
export const PRIMARY: NavItem = { href: "/new", label: "New post", icon: PenSquare, desc: "Start a post" };

/* The War Room dashboard — pinned second, right under Soli. */
export const WAR_ROOM: NavItem = { href: "/war-room", label: "War Room", icon: LayoutDashboard, desc: "Command overview" };

/* Sections follow the brand arc — Create · Publish · Grow — plus Engage
   (audience-facing surfaces) and Workspace/Account (operations + admin). */
export const NAV: NavSection[] = [
  { section: "Create", links: [
    { href: "/concepts", label: "Concept Board", icon: Lightbulb, desc: "Idea slate" },
    { href: "/creative-lab", label: "Creative Lab", icon: Eye, desc: "Observation inventory" },
    { href: "/plan", label: "Algo Lab", icon: FlaskConical, desc: "Strategy + plan" },
    { href: "/research", label: "Research", icon: Telescope, desc: "Verified deep research" },
    { href: "/queue", label: "Production Queue", icon: ListVideo, desc: "In-flight renders" },
    { href: "/studio", label: "Editor Studio", icon: Scissors, desc: "Import + chat-edit any video" },
  ]},
  { section: "Publish", links: [
    { href: "/calendar", label: "Calendar", icon: CalendarDays, desc: "Schedule" },
    { href: "/autopilot", label: "Autopilot", icon: Rocket, desc: "Hands-free posting" },
    { href: "/missions", label: "Missions", icon: Target, desc: "Standing agent goals" },
    { href: "/library", label: "Library", icon: LibraryBig, desc: "Everything made" },
  ]},
  { section: "Grow", links: [
    { href: "/analytics", label: "Analytics", icon: BarChart3, desc: "Performance" },
    { href: "/ads", label: "Boosts", icon: Megaphone, desc: "Paid promotion" },
    { href: "/usage", label: "Usage", icon: Activity, desc: "Spend + limits" },
  ]},
  { section: "Engage", links: [
    { href: "/inbox", label: "Inbox", icon: Inbox, desc: "Comments & DMs" },
    { href: "/ai-dm", label: "AI DM", icon: Bot, desc: "AI-handled direct messages" },
    { href: "/connections", label: "Connections", icon: Plug2, desc: "Brand accounts + responder" },
  ]},
  { section: "Workspace", links: [
    { href: "/admin", label: "Admin", icon: ShieldCheck, desc: "Cross-brand ops control center" },
    { href: "/calendar-admin", label: "Calendar Admin", icon: CalendarCheck, desc: "Cross-brand calendar + approvals" },
    { href: "/channels", label: "Brands", icon: Palette, desc: "Brand DNA" },
    { href: "/ai-models", label: "AI Models", icon: Cpu, desc: "Per-task model selection" },
    { href: "/devices", label: "Devices", icon: HardDrive, desc: "Render + posting fleet" },
  ]},
  { section: "Account", links: [
    { href: "/settings", label: "Settings", icon: Settings },
    { href: "/docs", label: "Docs", icon: BookOpen },
  ]},
];

/* Mega-menu presentation layer — the same routes as NAV, reorganised into a
   lean category rail + rich flyout panels. The rail shows one row per category
   (icon + label + chevron); hovering/clicking a row opens a floating panel that
   lists that category's destinations as rich rows. Workspace + Account are
   MERGED into one "Manage" category whose panel renders two labelled columns.
   Every route in NAV keeps a home here — nothing is dropped. */

export type MegaColumn = { label?: string; links: NavItem[] };
export type MegaCategory = {
  key: string;          // stable id (used for hover/focus state + aria)
  label: string;        // rail label + panel eyebrow
  icon: LucideIcon;     // the rail's representative mark
  columns: MegaColumn[]; // 1+ columns of links (>1 → multi-column grid)
};

/* findSection maps a category key back onto an original NAV section name so the
   header breadcrumb stays accurate after the merge. */
const sectionLinks = (name: string) => NAV.find((s) => s.section === name)?.links ?? [];

export const MEGA: MegaCategory[] = [
  { key: "create", label: "Create", icon: Lightbulb, columns: [{ links: sectionLinks("Create") }] },
  { key: "publish", label: "Publish", icon: Rocket, columns: [{ links: sectionLinks("Publish") }] },
  { key: "grow", label: "Grow", icon: BarChart3, columns: [{ links: sectionLinks("Grow") }] },
  { key: "engage", label: "Engage", icon: Inbox, columns: [{ links: sectionLinks("Engage") }] },
  // merged: Workspace + Account, shown as two labelled columns in the panel
  { key: "manage", label: "Manage", icon: ShieldCheck, columns: [
    { label: "Workspace", links: sectionLinks("Workspace") },
    { label: "Account", links: sectionLinks("Account") },
  ]},
];

/* Flat lookup of every known route → its label + section, newest segment first.
   Used by the header to build the breadcrumb (falls back to a humanized slug). */
const ALL: { href: string; label: string; section?: string }[] = [
  { href: HOME.href, label: HOME.label },
  { href: WAR_ROOM.href, label: WAR_ROOM.label },
  { href: PRIMARY.href, label: PRIMARY.label, section: "Create" },
  ...NAV.flatMap((s) => s.links.map((l) => ({ href: l.href, label: l.label, section: s.section }))),
];

export function crumbFor(pathname: string): { section?: string; label: string } {
  if (pathname === "/") return { label: HOME.label };
  // Longest matching known prefix wins (so /post/x maps under nothing but still resolves).
  const match = ALL.filter((r) => r.href !== "/" && pathname.startsWith(r.href)).sort((a, b) => b.href.length - a.href.length)[0];
  if (match) return { section: match.section, label: match.label };
  // Unknown route → humanize the first segment (e.g. /post/abc → "Post").
  const seg = pathname.split("/").filter(Boolean)[0] ?? "";
  return { label: seg ? seg.charAt(0).toUpperCase() + seg.slice(1) : "Socheli" };
}
