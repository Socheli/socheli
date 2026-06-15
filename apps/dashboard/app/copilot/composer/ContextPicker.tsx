"use client";
import type { ReactNode } from "react";
import { PopCard, PopRow } from "./PopCard";
import { Spark } from "./commands";

/* The "@" / + context picker. Options come from GET /api/agent/context-options
   (the caller's 10 most recent runs + their channels); picking one inserts a
   mono reference token — @post:<id> or @channel:<id> — into the draft. The
   agent resolves those ids server-side. */

export type ContextOption = {
  token: string; // what gets inserted, e.g. "@post:concept_123"
  label: string; // human line (topic / channel name)
  sub: string; // mono second line (status / id)
  group: "post" | "channel";
};

export type ContextFetchState = "idle" | "loading" | "ready" | "error";

export function buildContextOptions(
  data: { items: { id: string; topic: string; status: string }[]; channels: { id: string; name: string }[] } | null,
  query: string,
): ContextOption[] {
  if (!data) return [];
  const q = query.toLowerCase();
  const hit = (...hay: string[]) => !q || hay.some((h) => h.toLowerCase().includes(q));
  const posts = data.items
    .filter((it) => hit(it.id, it.topic, it.status))
    .map<ContextOption>((it) => ({ token: `@post:${it.id}`, label: it.topic, sub: `${it.id} · ${it.status}`, group: "post" }));
  const channels = data.channels
    .filter((c) => hit(c.id, c.name))
    .map<ContextOption>((c) => ({ token: `@channel:${c.id}`, label: c.name, sub: `@channel:${c.id}`, group: "channel" }));
  return [...posts, ...channels];
}

/* Tiny hand-drawn group glyphs in the same single-stroke grammar. */
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

/* 9:16 frame — a post reference. */
const PostMark = (
  <G>
    <path
      pathLength={1}
      d="M7.15 3.6 C9.9 3.5 14.1 3.5 16.85 3.6 C17.55 3.65 18.05 4.1 18.1 4.8 C18.25 9.4 18.2 14.6 18.05 19.2 C18 19.9 17.55 20.35 16.85 20.4 C14.1 20.5 9.9 20.5 7.15 20.4 C6.45 20.35 6 19.9 5.95 19.2 C5.8 14.6 5.8 9.4 5.9 4.8 C5.95 4.1 6.45 3.65 7.15 3.6 Z"
    />
    <path pathLength={1} d="M8.9 16.9 C10.9 16.8 13.1 16.8 15.1 16.9" />
  </G>
);

/* Broadcast dot + waves — a channel reference. */
const ChannelMark = (
  <G>
    <path
      pathLength={1}
      d="M12.05 10.1 C13.2 10.1 14 10.9 13.95 12 C13.9 13.1 13.1 13.9 12 13.9 C10.9 13.9 10.1 13.05 10.1 11.95 C10.1 10.9 10.95 10.1 12.05 10.1 Z"
    />
    <path pathLength={1} d="M7.5 7.3 C4.9 9.9 4.9 14 7.4 16.7" />
    <path pathLength={1} d="M16.5 7.4 C19.1 9.9 19.1 14.1 16.6 16.6" />
  </G>
);

/* The group glyph, exported so the composer's context CHIPS reuse the exact
   same hand-drawn marks as the picker rows. */
export function ContextGroupMark({ group }: { group: ContextOption["group"] }) {
  return group === "post" ? PostMark : ChannelMark;
}

export function ContextPicker({
  options,
  active,
  state,
  onPick,
  onHover,
}: {
  options: ContextOption[];
  active: number;
  state: ContextFetchState;
  onPick: (token: string) => void;
  onHover: (index: number) => void;
}) {
  return (
    <PopCard label="Add context">
      {state === "loading" || state === "idle" ? (
        <div className="cmp-pop-note">loading recent items…</div>
      ) : state === "error" ? (
        <div className="cmp-pop-note">could not load context options</div>
      ) : options.length === 0 ? (
        <div className="cmp-pop-note">nothing to reference yet</div>
      ) : (
        options.map((o, i) => (
          <div key={o.token} className="cmp-ctx-item">
            {/* group header where the group changes (flat index keeps keys honest) */}
            {i === 0 || options[i - 1].group !== o.group ? (
              <div className="cmp-pop-group">{o.group === "post" ? "Recent posts" : "Channels"}</div>
            ) : null}
            <PopRow active={i === active} onPick={() => onPick(o.token)} onHover={() => onHover(i)}>
              <span className="cmp-row-glyph">{o.group === "post" ? PostMark : ChannelMark}</span>
              <span className="cmp-row-main">
                <span className="cmp-row-label">{o.label}</span>
                <span className="cmp-row-sub">{o.sub}</span>
              </span>
              <Spark className="cmp-row-spark" />
            </PopRow>
          </div>
        ))
      )}
    </PopCard>
  );
}
