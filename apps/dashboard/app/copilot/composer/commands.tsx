"use client";
import type { ReactNode } from "react";

/* Slash-command catalogue for the composer palette. Commands are TEMPLATE
   INSERTERS — picking one writes a structured prompt into the input and the
   agent decides which tools to run; nothing here calls a tool directly.
   `prefix`/`suffix` let a template park the caret mid-sentence
   (/sketch → "Sketch how ▮ works"). */

export type SlashCommand = {
  name: string; // without the leading slash
  hint?: string; // mono arg hint rendered after the command (e.g. "<idea>")
  desc: string; // short right-aligned description in the palette row
  prefix: string; // inserted before the caret
  suffix?: string; // inserted after the caret
  glyph: ReactNode; // hand-drawn single-stroke glyph (house ink style)
};

/* Hand-drawn glyph frame — single-stroke ink in the house sketch style
   (see ChatCore's InkMicIcon / components/sketch/InkIcon): currentColor,
   1.5 stroke, round caps, a little wobble in every line. pathLength=1 +
   .ink-drawable makes each glyph draw itself in when the palette opens
   (the palette remounts per open, so the stroke replays). */
function G({ children }: { children: ReactNode }) {
  return (
    <svg
      className="ink-drawable"
      viewBox="0 0 24 24"
      width={15}
      height={15}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

/* 9:16 frame with a play wedge — a post. */
const PostGlyph = (
  <G>
    <path
      pathLength={1}
      d="M7.15 3.6 C9.9 3.5 14.1 3.5 16.85 3.6 C17.55 3.65 18.05 4.1 18.1 4.8 C18.25 9.4 18.2 14.6 18.05 19.2 C18 19.9 17.55 20.35 16.85 20.4 C14.1 20.5 9.9 20.5 7.15 20.4 C6.45 20.35 6 19.9 5.95 19.2 C5.8 14.6 5.8 9.4 5.9 4.8 C5.95 4.1 6.45 3.65 7.15 3.6 Z"
    />
    <path
      pathLength={1}
      d="M10.45 9.3 C11.75 10 13.4 11.1 14.4 11.95 C13.35 12.85 11.7 13.95 10.5 14.6 C10.4 12.9 10.4 11 10.45 9.3 Z"
    />
  </G>
);

/* Magnifier — research. */
const ResearchGlyph = (
  <G>
    <path
      pathLength={1}
      d="M10.5 4.1 C14 4 16.9 6.9 16.95 10.4 C17 13.9 14.1 16.85 10.6 16.9 C7.1 16.95 4.15 14.05 4.1 10.55 C4.05 7.05 7 4.2 10.5 4.1 Z"
    />
    <path pathLength={1} d="M15.35 15.45 L19.9 19.8" />
  </G>
);

/* Winding route to an X marker — the plan. */
const PlanGlyph = (
  <G>
    <path pathLength={1} d="M4.2 19.6 C8.4 18.9 7.1 13.4 11.6 12.6 C16 11.8 15.1 6.9 19.2 5.2" />
    <path pathLength={1} d="M17.6 2.9 L20.7 5.6" />
    <path pathLength={1} d="M20.6 3 L17.7 5.5" />
  </G>
);

/* Up arrow off a baseline — boost. */
const BoostGlyph = (
  <G>
    <path pathLength={1} d="M12 18.1 C11.9 14.1 11.95 9.2 12.05 5.2" />
    <path pathLength={1} d="M7.4 9.6 C8.9 8 10.5 6.3 12 4.7 C13.5 6.2 15.1 7.9 16.6 9.5" />
    <path pathLength={1} d="M7.2 20.9 C10.4 20.7 13.6 20.7 16.8 20.9" />
  </G>
);

/* Gauge arc + needle — score. */
const ScoreGlyph = (
  <G>
    <path pathLength={1} d="M4.6 16.6 C4.2 10.6 8 6.1 13 6.3 C17.4 6.5 20.2 10.6 19.5 16.3" />
    <path pathLength={1} d="M11.9 17 L16.2 10.9" />
    <path pathLength={1} d="M4.9 19.9 C9.6 19.7 14.4 19.7 19.1 19.9" />
  </G>
);

/* Month box with hangers + header rule — calendar. */
const CalendarGlyph = (
  <G>
    <path
      pathLength={1}
      d="M5.2 5.6 C7.6 5.45 16.4 5.45 18.8 5.6 C19.5 5.65 19.95 6.1 20 6.8 C20.15 10.7 20.1 15.3 19.95 19 C19.9 19.7 19.45 20.1 18.75 20.15 C16.3 20.3 7.7 20.3 5.25 20.15 C4.55 20.1 4.1 19.7 4.05 19 C3.9 15.3 3.9 10.7 4.05 6.8 C4.1 6.1 4.55 5.65 5.2 5.6 Z"
    />
    <path pathLength={1} d="M4.3 9.6 C9.4 9.45 14.6 9.45 19.7 9.6" />
    <path pathLength={1} d="M8.4 3.4 L8.5 6.9" />
    <path pathLength={1} d="M15.6 3.4 L15.6 6.9" />
  </G>
);

/* Tray with shelf — inbox. */
const InboxGlyph = (
  <G>
    <path
      pathLength={1}
      d="M4.6 13.2 C5.2 10.6 5.9 8.1 6.7 5.7 C10.2 5.55 13.8 5.55 17.3 5.7 C18.1 8.1 18.8 10.6 19.4 13.2 C19.6 15 19.6 16.9 19.4 18.6 C14.5 18.85 9.5 18.85 4.6 18.6 C4.4 16.9 4.4 15 4.6 13.2 Z"
    />
    <path
      pathLength={1}
      d="M4.7 13.4 C6.2 13.3 7.7 13.3 9.2 13.4 C9.6 14.5 10.6 15.3 12 15.3 C13.4 15.3 14.4 14.5 14.8 13.4 C16.3 13.3 17.8 13.3 19.3 13.4"
    />
  </G>
);

/* Pencil — sketch. */
const SketchGlyph = (
  <G>
    <path
      pathLength={1}
      d="M5.1 18.9 C5.4 17.6 5.7 16.3 6.1 15.1 C9.4 11.7 12.8 8.3 16.2 5 C16.9 4.4 17.9 4.4 18.6 5.1 C19.3 5.8 19.4 6.8 18.8 7.5 C15.5 10.9 12.1 14.3 8.7 17.6 C7.5 18.1 6.3 18.5 5.1 18.9 Z"
    />
    <path pathLength={1} d="M15.1 6.2 C16 7 16.8 7.8 17.6 8.7" />
  </G>
);

export const SLASH_COMMANDS: SlashCommand[] = [
  { name: "post", hint: "<idea>", desc: "create a new post", prefix: "Create a new post about: ", glyph: PostGlyph },
  { name: "research", hint: "<query>", desc: "run verified research", prefix: "Run research on: ", glyph: ResearchGlyph },
  { name: "plan", desc: "fill the calendar", prefix: "Plan my content calendar and fill the next two weeks with dated posts.", glyph: PlanGlyph },
  { name: "boost", desc: "boost the latest post", prefix: "Draft a boost for my latest post.", glyph: BoostGlyph },
  { name: "score", hint: "<item>", desc: "score an item", prefix: "Score this item: ", glyph: ScoreGlyph },
  { name: "calendar", desc: "show this week", prefix: "Show my calendar for this week.", glyph: CalendarGlyph },
  { name: "inbox", desc: "summarize the inbox", prefix: "Summarize my inbox.", glyph: InboxGlyph },
  { name: "sketch", hint: "<thing>", desc: "sketch how it works", prefix: "Sketch how ", suffix: " works", glyph: SketchGlyph },
];

/* Prefix-first matching: "/c" ranks calendar before anything merely containing c. */
export function filterCommands(query: string): SlashCommand[] {
  const q = query.toLowerCase();
  if (!q) return SLASH_COMMANDS;
  const starts = SLASH_COMMANDS.filter((c) => c.name.startsWith(q));
  const contains = SLASH_COMMANDS.filter((c) => !c.name.startsWith(q) && c.name.includes(q));
  return [...starts, ...contains];
}

/* The brand spark (same wedge the mic orbits) — stamped on the active row. */
export function Spark({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 16 10" width={10} height={7} aria-hidden="true" focusable="false">
      <path fill="currentColor" d="M0 5 L8 .6 L16 5 L8 9.4 Z" />
    </svg>
  );
}

/* Hand-drawn plus — the composer's context button (the canonical glyph now
   lives with the rest of the ink UI set in components/sketch/InkUI). */
export { InkPlusIcon } from "../../../components/sketch";
