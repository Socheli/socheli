"use client";
import type { CSSProperties } from "react";
import type {
  UIHookLab,
  UIScriptLines,
  UIAbTest,
  UITrendTags,
  UIVoiceTrack,
  UIPalette,
  UIPipeline,
  UIDiff,
} from "../../../lib/agent/ui-spec";
import { BlockFrame } from "./BlockFrame";
import { InkStroke, seeded } from "./anim";

/* Content-craft widgets — hook variants ranked with the winner circled, a
   script excerpt on an ink rail, A/B compare, trending-topic chips, a
   voiceover waveform, brand swatches, the idea→publish pipeline, and a
   before/after copy diff (hand strikethrough → hand underline). */

const INK_RING =
  "M6 14.5 C 4.6 8.6, 10 3.4, 19 3.1 C 28.4 2.8, 35.4 7, 35 13 C 34.6 19, 27.6 23.2, 18.6 22.9 C 10.6 22.6, 5.6 19.4, 5.8 14.2";
const INK_UNDERLINE = "M3 6.4 C 28 3.9, 58 7.7, 89 5 C 100 4.2, 110.5 5.6, 117 4.7";
const INK_STRIKE = "M2 6.2 C 30 4.6, 62 7.4, 92 5.4 C 102 4.8, 111 6.2, 118 5.2";

/* ---------- hook_lab ---------- */

export function HookLabView({ b }: { b: UIHookLab }) {
  const hasScores = b.hooks.some((h) => h.score != null);
  const best = b.hooks.reduce((bi, h, i) => ((h.score ?? -1) > (b.hooks[bi]?.score ?? -1) ? i : bi), 0);
  return (
    <BlockFrame eyebrow={b.title ?? "hook lab"} href={b.href}>
      <ol className="blk-hk">
        {b.hooks.map((h, i) => {
          const isBest = hasScores && i === best;
          return (
            <li className={`blk-hk-row blk-in${isBest ? " best" : ""}`} key={i} style={{ "--i": i } as CSSProperties}>
              <span className="blk-hk-n">
                {i + 1}
                {isBest ? <InkStroke d={INK_RING} viewBox="0 0 40 26" className="blk-hk-ink" delayMs={420 + i * 60} durMs={520} width={1.4} /> : null}
              </span>
              <span className="blk-hk-text">{h.text}</span>
              {h.score != null ? <span className="blk-hk-score">{Math.round(h.score)}</span> : null}
            </li>
          );
        })}
      </ol>
    </BlockFrame>
  );
}

/* ---------- script_lines ---------- */

/* one long wobbled rail stroke down the left side */
const INK_RAIL = "M3.2 0 C 2.4 30, 3.8 70, 3 105 C 2.6 140, 3.6 170, 3.1 200";

export function ScriptLinesView({ b }: { b: UIScriptLines }) {
  return (
    <BlockFrame eyebrow={b.title ?? "script"} href={b.href}>
      <div className="blk-sx">
        <InkStroke d={INK_RAIL} viewBox="0 0 6 200" className="blk-sx-rail" durMs={700} width={1.2} />
        <div className="blk-sx-lines">
          {b.lines.map((l, i) => (
            <div className="blk-sx-line blk-in" key={i} style={{ "--i": i } as CSSProperties}>
              {l.at ? <span className="blk-sx-at">{l.at}</span> : null}
              <span className="blk-sx-text">{l.text}</span>
            </div>
          ))}
        </div>
      </div>
    </BlockFrame>
  );
}

/* ---------- ab_test ---------- */

/* a hand "vs" slash */
const INK_VS = "M12.4 2.2 C 9.8 7.4, 6.8 12.8, 3.6 17.8";

function AbCellView({ b, side, i }: { b: UIAbTest; side: "a" | "b"; i: number }) {
  const cell = b[side];
  const isWin = b.winner === side;
  return (
    <div className={`blk-ab-cell blk-in${isWin ? " win" : ""}`} style={{ "--i": i * 2 } as CSSProperties}>
      <span className="blk-ab-tag">{side.toUpperCase()}</span>
      <span className="blk-ab-value">
        {cell.value}
        {isWin ? <InkStroke d={INK_RING} viewBox="0 0 40 26" className="blk-ab-ink" delayMs={620} durMs={540} width={1.4} /> : null}
      </span>
      <span className="blk-ab-label" title={cell.label}>{cell.label}</span>
    </div>
  );
}

export function AbTestView({ b }: { b: UIAbTest }) {
  // "vs" sits IN FLOW between the two cells (grid 1fr auto 1fr), so it can
  // never overlap a long value at narrow widths.
  return (
    <BlockFrame eyebrow={b.metric ?? "a/b test"} href={b.href}>
      <div className="blk-ab">
        <AbCellView b={b} side="a" i={0} />
        <span className="blk-ab-vs">
          <InkStroke d={INK_VS} viewBox="0 0 16 20" className="blk-ab-slash" delayMs={300} durMs={300} width={1.4} />
          vs
        </span>
        <AbCellView b={b} side="b" i={1} />
      </div>
    </BlockFrame>
  );
}

/* ---------- trend_tags ---------- */

const INK_SPARK = "M2 6.5 C 4.4 5.6, 6.4 4.4, 8 2.6 C 9.6 4.4, 11.6 5.6, 14 6.5 C 11.6 7.4, 9.6 8.6, 8 10.4 C 6.4 8.6, 4.4 7.4, 2 6.5 Z";

export function TrendTagsView({ b }: { b: UITrendTags }) {
  const hottest = b.tags.reduce((bi, t, i) => ((t.heat ?? -1) > (b.tags[bi]?.heat ?? -1) ? i : bi), 0);
  const hasHeat = b.tags.some((t) => t.heat != null);
  return (
    <BlockFrame eyebrow={b.title ?? "trending"} href={b.href}>
      <div className="blk-tt">
        {b.tags.map((t, i) => (
          <span
            className={`blk-tt-chip blk-in${hasHeat && i === hottest ? " hot" : ""}`}
            key={i}
            style={{ "--i": i, "--heat": t.heat ?? 0 } as CSSProperties}
          >
            {t.label}
            {hasHeat && i === hottest ? (
              <InkStroke d={INK_SPARK} viewBox="0 0 16 13" className="blk-tt-spark" delayMs={500 + i * 60} durMs={360} width={1.2} />
            ) : null}
          </span>
        ))}
      </div>
    </BlockFrame>
  );
}

/* ---------- voice_track ---------- */

const WAVE_BARS = 36;

export function VoiceTrackView({ b }: { b: UIVoiceTrack }) {
  let bars = b.bars;
  if (!bars || !bars.length) {
    // deterministic pseudo-wave (speech-ish envelope) when no amplitudes given
    const rnd = seeded(b.title ?? "voice");
    bars = Array.from({ length: WAVE_BARS }, (_, i) => {
      const env = 0.45 + 0.55 * Math.sin((i / WAVE_BARS) * Math.PI);
      return Math.max(0.08, Math.min(1, env * (0.35 + rnd() * 0.75)));
    });
  }
  const dur =
    b.durationSec != null
      ? `${Math.floor(b.durationSec / 60)}:${String(Math.round(b.durationSec % 60)).padStart(2, "0")}`
      : null;
  return (
    <BlockFrame eyebrow={b.title ?? "voiceover"} meta={dur} href={b.href}>
      <div className="blk-vt">
        <span className="blk-vt-play">
          <InkStroke d="M4 2.6 C 8.4 5.4, 11.6 7.6, 14.6 9.5 C 11.6 11.4, 8.4 13.6, 4 16.4 C 4.1 11.8, 3.9 7.2, 4 2.6 Z" viewBox="0 0 18 19" className="blk-vt-ink" durMs={420} width={1.3} />
        </span>
        <span className="blk-vt-wave">
          {bars.map((v, i) => (
            <span
              className="blk-vt-bar"
              key={i}
              style={{ height: `${Math.max(6, v * 100)}%`, animationDelay: `${i * 18}ms` } as CSSProperties}
            />
          ))}
        </span>
      </div>
    </BlockFrame>
  );
}

/* ---------- palette ---------- */

export function PaletteView({ b }: { b: UIPalette }) {
  return (
    <BlockFrame eyebrow={b.title ?? "palette"} href={b.href}>
      <div className="blk-pl">
        {b.colors.map((c, i) => (
          <span className="blk-pl-color blk-in" key={i} style={{ "--i": i } as CSSProperties}>
            <span className="blk-pl-swatch" style={{ background: c.hex }}>
              {i === 0 ? <InkStroke d={INK_RING} viewBox="0 0 40 26" className="blk-pl-ink" delayMs={420} durMs={520} width={1.3} /> : null}
            </span>
            {c.name ? <span className="blk-pl-name">{c.name}</span> : null}
            <span className="blk-pl-hex">{c.hex}</span>
          </span>
        ))}
      </div>
    </BlockFrame>
  );
}

/* ---------- pipeline ---------- */

/* wobbled node ring + connector + error cross */
const INK_NODE = "M8 2.8 C 11.6 2.5, 14.4 5, 14.2 8.2 C 14 11.6, 11.2 13.8, 7.8 13.6 C 4.6 13.4, 2.4 11, 2.6 7.8 C 2.8 4.8, 5 3, 8.2 2.9";
const INK_LINK = "M2 3.4 C 12 2.6, 26 4.1, 38 3.2";
const INK_X = "M4 3.6 C 6.8 6.6, 9.6 9.8, 12.4 12.8 M12.2 3.4 C 9.4 6.5, 6.6 9.7, 4.2 12.6";

export function PipelineView({ b }: { b: UIPipeline }) {
  return (
    <BlockFrame eyebrow="pipeline" href={b.href}>
      <div className="blk-pp">
        {b.stages.map((s, i) => (
          <div className={`blk-pp-seg st-${s.state}`} key={i}>
            {i > 0 ? (
              <InkStroke d={INK_LINK} viewBox="0 0 40 6" className="blk-pp-link" delayMs={i * 220} durMs={200} width={1.2} />
            ) : null}
            <div className="blk-pp-node-wrap">
              <span className="blk-pp-node">
                <InkStroke d={INK_NODE} viewBox="0 0 17 16" className="blk-pp-ring" delayMs={i * 220 + 120} durMs={240} width={1.3} />
                {s.state === "done" ? <span className="blk-pp-fill" style={{ animationDelay: `${i * 220 + 300}ms` }} /> : null}
                {s.state === "error" ? (
                  <InkStroke d={INK_X} viewBox="0 0 16 16" className="blk-pp-x" delayMs={i * 220 + 300} durMs={240} width={1.4} />
                ) : null}
                {s.state === "active" ? <span className="blk-pp-pulse" /> : null}
              </span>
              <span className="blk-pp-label">{s.label}</span>
            </div>
          </div>
        ))}
      </div>
    </BlockFrame>
  );
}

/* ---------- diff ---------- */

export function DiffView({ b }: { b: UIDiff }) {
  return (
    <BlockFrame eyebrow={b.title ?? "rewrite"} href={b.href}>
      <div className="blk-df">
        <div className="blk-df-row blk-in">
          <span className="blk-df-tag">before</span>
          <span className="blk-df-before">
            {b.before}
            <InkStroke d={INK_STRIKE} viewBox="0 0 120 10" className="blk-df-strike" delayMs={420} durMs={480} width={1.4} />
          </span>
        </div>
        <div className="blk-df-row blk-in" style={{ "--i": 3 } as CSSProperties}>
          <span className="blk-df-tag">after</span>
          <span className="blk-df-after">
            {b.after}
            <InkStroke d={INK_UNDERLINE} viewBox="0 0 120 10" className="blk-df-under" delayMs={980} durMs={460} width={1.4} />
          </span>
        </div>
      </div>
    </BlockFrame>
  );
}
