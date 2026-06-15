"use client";
import { PopCard, PopRow } from "./PopCard";
import { Spark, type SlashCommand } from "./commands";

/* The "/" palette — already-filtered commands, keyboard-driven from the
   textarea (up/down/enter/esc live in ChatCore's onComposerKey). Each row:
   hand-drawn glyph, mono command (+ arg hint), short description, and the
   brand spark stamped on the active row. */
export function SlashPalette({
  commands,
  active,
  onPick,
  onHover,
}: {
  commands: SlashCommand[];
  active: number;
  onPick: (cmd: SlashCommand) => void;
  onHover: (index: number) => void;
}) {
  return (
    <PopCard label="Commands">
      {commands.map((c, i) => (
        <PopRow key={c.name} active={i === active} onPick={() => onPick(c)} onHover={() => onHover(i)}>
          <span className="cmp-row-glyph">{c.glyph}</span>
          <span className="cmp-row-cmd">
            /{c.name}
            {c.hint ? <span className="cmp-row-hint"> {c.hint}</span> : null}
          </span>
          <span className="cmp-row-desc">{c.desc}</span>
          <Spark className="cmp-row-spark" />
        </PopRow>
      ))}
    </PopCard>
  );
}
