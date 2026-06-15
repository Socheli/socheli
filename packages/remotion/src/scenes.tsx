import React from "react";
import { AbsoluteFill, interpolate, Img, OffthreadVideo, staticFile } from "remotion";
import type { Scene, TerminalLine, DialogueLine } from "@os/schemas";
import { type as typePresets, type Theme, primitive } from "@os/tokens";
import { reveal, slideUp, slamIn, fadeInOut, typewriter, breathe, wipe, springy, maskWipe, stagger, counter, pop, grid as mgrid } from "./lib/motion.ts";

const PAD = 96;

/* Depth: soft drop shadow + accent glow + inset rim light, for raised cards. */
const depthShadow = (glow: string, intensity = 1) =>
  `0 44px 130px rgba(0,0,0,${(0.52 * intensity).toFixed(2)}), 0 0 78px ${glow}1f, ` +
  `inset 0 1px 0 rgba(255,255,255,0.08), inset 0 0 0 1px rgba(255,255,255,0.03)`;

type SceneProps<T> = { scene: T; theme: Theme; frame: number; durF: number };

const Cursor: React.FC<{ frame: number; color: string }> = ({ frame, color }) => (
  <span
    style={{
      display: "inline-block",
      width: 16,
      height: "1.05em",
      marginLeft: 4,
      transform: "translateY(3px)",
      background: color,
      opacity: Math.floor(frame / 15) % 2 === 0 ? 0.9 : 0.15,
    }}
  />
);

const Eyebrow: React.FC<{ theme: Theme; frame: number; label: string; color?: string }> = ({
  theme,
  frame,
  label,
  color,
}) => {
  const t = typePresets(theme).eyebrow;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12, opacity: reveal(frame, 2, 14) }}>
      <span style={{ width: 28, height: 2, background: color ?? theme.accent.brand, opacity: 0.9 }} />
      <span style={{ ...t, color: color ?? theme.text.muted }}>{label}</span>
    </div>
  );
};

/* ─── Hook ─────────────────────────────────────────────────────────────── */
const HookScene: React.FC<SceneProps<Extract<Scene, { type: "hook_text" }>>> = ({ scene, theme, frame, durF }) => {
  const t = typePresets(theme);
  const words = scene.text.split(/\s+/).filter(Boolean);
  const slam = scene.motion === "slam_in";
  const step = slam ? 1.6 : 2.6; // tighter stagger for a slam
  const underline = wipe(frame, stagger(words.length, step, 4) + 4, 20);
  return (
    <AbsoluteFill style={{ justifyContent: "center", alignItems: "flex-start", padding: PAD, opacity: fadeInOut(frame, durF) }}>
      {/* normal text flow with REAL spaces between words — each word animates in, but
          the space text-nodes keep words from running together */}
      <div style={{ ...t.title, fontSize: primitive.size.xxl, maxWidth: 920, lineHeight: 1.04 }}>
        {words.map((w, i) => {
          const d = stagger(i, step, 3);
          const p = Math.min(1, springy(frame, d, slam ? 9 : 12, 1.12));
          const y = slideUp(frame, d, slam ? 54 : 36, slam ? 9 : 13);
          return (
            <React.Fragment key={i}>
              <span
                style={{
                  display: "inline-block",
                  opacity: Math.min(1, p * 1.2),
                  transform: `translateY(${y}px) scale(${0.94 + p * 0.06})`,
                  transformOrigin: "left bottom",
                  textShadow: "0 2px 18px rgba(0,0,0,0.5)",
                }}
              >
                {w}
              </span>
              {i < words.length - 1 ? " " : ""}
            </React.Fragment>
          );
        })}
      </div>
      <div
        style={{
          marginTop: 36,
          height: 5,
          width: `${underline * 240}px`,
          background: theme.accent.brand,
          borderRadius: 4,
          boxShadow: `0 0 24px ${theme.accent.brand}`,
        }}
      />
    </AbsoluteFill>
  );
};

/* ─── Terminal (ported ClaudeCodeWindow) ───────────────────────────────── */
const lineColor = (l: TerminalLine["kind"], th: Theme) =>
  ({
    user: th.text.primary,
    assistant: th.text.secondary,
    tool: th.accent.ai,
    file: th.text.muted,
    error: th.status.danger,
    warning: th.status.warning,
    ok: th.status.ok,
    blank: "transparent",
  })[l];

const TerminalScene: React.FC<SceneProps<Extract<Scene, { type: "terminal" }>>> = ({ scene, theme, frame, durF }) => {
  const t = typePresets(theme);
  const broken = scene.status === "error";
  const glow = broken ? theme.status.danger : theme.accent.ai;
  const pulse = breathe(frame, 80, 0.05);

  // sequential typewriter timeline
  const starts: number[] = [];
  let acc = 6;
  for (const l of scene.lines) {
    starts.push(acc);
    acc += l.kind === "blank" ? 8 : Math.ceil(l.text.length / 1.7) + (l.kind === "user" ? 20 : 6);
  }

  return (
    <AbsoluteFill style={{ justifyContent: "center", alignItems: "center", padding: PAD - 30, opacity: fadeInOut(frame, durF) }}>
      <div
        style={{
          width: "100%",
          background: `linear-gradient(180deg, ${theme.surface} 0%, ${theme.bg} 100%)`,
          border: `1px solid ${theme.border}`,
          borderRadius: 14,
          overflow: "hidden",
          boxShadow: depthShadow(glow) + `, 0 0 ${(70 + pulse * 40).toFixed(0)}px ${glow}22`,
          transform: `scale(${reveal(frame, 0, 12) * 0.04 + 0.96})`,
        }}
      >
        {/* path bar */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "16px 22px",
            borderBottom: `1px solid ${theme.border}`,
            background: "rgba(255,255,255,0.02)",
          }}
        >
          {["#ef4444", "#f59e0b", "#22c55e"].map((c) => (
            <span key={c} style={{ width: 12, height: 12, borderRadius: 6, background: c, opacity: 0.5 }} />
          ))}
          <span style={{ ...t.eyebrow, marginLeft: 14, textTransform: "none", letterSpacing: 0 }}>{scene.path}</span>
          <span
            style={{
              ...t.eyebrow,
              marginLeft: "auto",
              color: broken ? theme.status.danger : theme.accent.ai,
            }}
          >
            {broken ? "context lost" : "memory live"}
          </span>
        </div>
        {/* body */}
        <div style={{ padding: "28px 30px", minHeight: 360 }}>
          {scene.lines.map((l, i) => {
            if (frame < starts[i]) return null;
            if (l.kind === "blank") return <div key={i} style={{ height: 14 }} />;
            const el = frame - starts[i];
            const shown = Math.min(l.text.length, typewriter(frame, starts[i], l.text.length, 1.7));
            const typing = shown < l.text.length;
            const op = interpolate(el, [0, 6], [0, 1], { extrapolateRight: "clamp" });
            if (l.kind === "user") {
              return (
                <div
                  key={i}
                  style={{
                    background: `linear-gradient(90deg, ${theme.accent.brand}1f, transparent)`,
                    borderLeft: `3px solid ${theme.accent.brand}`,
                    padding: "14px 18px",
                    marginBottom: 14,
                    borderRadius: "0 8px 8px 0",
                    display: "flex",
                    gap: 12,
                    alignItems: "center",
                  }}
                >
                  <span style={{ ...t.mono, color: theme.accent.brand, fontWeight: 700 }}>{">"}</span>
                  <span style={{ ...t.mono, color: theme.text.primary }}>
                    {l.text.slice(0, shown)}
                    {typing && <Cursor frame={frame} color={theme.accent.brand} />}
                  </span>
                </div>
              );
            }
            return (
              <div key={i} style={{ ...t.mono, color: lineColor(l.kind, theme), opacity: op, padding: "3px 0" }}>
                {l.text.slice(0, shown)}
                {typing && <Cursor frame={frame} color={lineColor(l.kind, theme)} />}
              </div>
            );
          })}
        </div>
      </div>
    </AbsoluteFill>
  );
};

/* ─── Before / After ───────────────────────────────────────────────────── */
const BeforeAfterScene: React.FC<SceneProps<Extract<Scene, { type: "before_after" }>>> = ({ scene, theme, frame, durF }) => {
  const t = typePresets(theme);
  const card = (side: typeof scene.left, delay: number) => {
    const bad = side.bad;
    const col = bad ? theme.status.danger : theme.status.ok;
    return (
      <div
        style={{
          flex: 1,
          background: theme.surface,
          border: `1px solid ${col}55`,
          borderRadius: 16,
          padding: 36,
          opacity: reveal(frame, delay, 14),
          transform: `translateY(${slideUp(frame, delay, 30, 16)}px)`,
          boxShadow: depthShadow(col, 0.85),
        }}
      >
        <div
          style={{
            display: "inline-block",
            ...t.eyebrow,
            color: col,
            border: `1px solid ${col}66`,
            borderRadius: 999,
            padding: "6px 16px",
            marginBottom: 22,
          }}
        >
          {side.title}
        </div>
        <div style={{ ...t.mono, color: theme.text.primary, fontSize: primitive.size.md, lineHeight: 1.4 }}>{side.text}</div>
      </div>
    );
  };
  return (
    <AbsoluteFill style={{ justifyContent: "center", padding: PAD - 20, opacity: fadeInOut(frame, durF) }}>
      {scene.caption && (
        <div style={{ ...t.heading, marginBottom: 34, opacity: reveal(frame, 0, 12) }}>{scene.caption}</div>
      )}
      <div style={{ display: "flex", flexDirection: "column", gap: 28 }}>
        {card(scene.left, 6)}
        {card(scene.right, 14)}
      </div>
    </AbsoluteFill>
  );
};

/* ─── Code block ───────────────────────────────────────────────────────── */
const CodeScene: React.FC<SceneProps<Extract<Scene, { type: "code_block" }>>> = ({ scene, theme, frame, durF }) => {
  const t = typePresets(theme);
  const lines = scene.code.split("\n");
  return (
    <AbsoluteFill style={{ justifyContent: "center", padding: PAD - 20, opacity: fadeInOut(frame, durF) }}>
      {scene.title && <Eyebrow theme={theme} frame={frame} label={scene.title} />}
      <div
        style={{
          marginTop: 24,
          background: theme.surface,
          border: `1px solid ${theme.border}`,
          borderRadius: 14,
          padding: "30px 26px",
          opacity: reveal(frame, 2, 12),
          transform: `translateY(${slideUp(frame, 2, 24, 14)}px)`,
          boxShadow: depthShadow(theme.accent.brand, 0.9),
        }}
      >
        {lines.map((ln, i) => {
          const focused = scene.focusLines.includes(i + 1);
          const visible = reveal(frame, 6 + i * 2, 8);
          return (
            <div
              key={i}
              style={{
                display: "flex",
                gap: 18,
                opacity: focused ? visible : visible * 0.5,
                background: focused ? `${theme.accent.brand}12` : "transparent",
                borderLeft: focused ? `3px solid ${theme.accent.brand}` : "3px solid transparent",
                padding: "3px 10px",
              }}
            >
              <span style={{ ...t.mono, color: theme.text.muted, width: 28, textAlign: "right", fontSize: primitive.size.sm }}>
                {i + 1}
              </span>
              <span style={{ ...t.mono, color: focused ? theme.text.primary : theme.text.secondary, fontSize: primitive.size.sm, whiteSpace: "pre" }}>
                {ln || " "}
              </span>
            </div>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};

/* ─── Kinetic text ─────────────────────────────────────────────────────── */
const KineticScene: React.FC<SceneProps<Extract<Scene, { type: "kinetic_text" }>>> = ({ scene, theme, frame, durF }) => {
  const t = typePresets(theme);
  const hl = (text: string) => {
    if (!scene.highlight.length) return text;
    const re = new RegExp(`(${scene.highlight.map((h) => h.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "gi");
    return text.split(re).map((part, i) =>
      scene.highlight.some((h) => h.toLowerCase() === part.toLowerCase()) ? (
        <span
          key={i}
          style={{
            color: theme.accent.brand,
            fontWeight: 800,
            // plain inline (NOT inline-block) so the spaces around the word never collapse
            textShadow: `0 0 32px ${theme.accent.brand}55, 0 2px 14px rgba(0,0,0,0.5)`,
          }}
        >
          {part}
        </span>
      ) : (
        <span key={i}>{part}</span>
      ),
    );
  };
  return (
    <AbsoluteFill style={{ justifyContent: "center", padding: PAD, opacity: fadeInOut(frame, durF) }}>
      {scene.lines.map((ln, i) => {
        const d = stagger(i, 10, 4);
        return (
          <div
            key={i}
            style={{
              ...t.title,
              fontSize: primitive.size.xl,
              opacity: reveal(frame, d, 13),
              transform: `translateY(${slideUp(frame, d, 38, 15)}px)`,
              clipPath: maskWipe(frame, d, 11),
              marginBottom: 12,
            }}
          >
            {hl(ln)}
          </div>
        );
      })}
    </AbsoluteFill>
  );
};

/* ─── Warning ──────────────────────────────────────────────────────────── */
const WarningScene: React.FC<SceneProps<Extract<Scene, { type: "warning" }>>> = ({ scene, theme, frame, durF }) => {
  const t = typePresets(theme);
  const col = scene.level === "danger" ? theme.status.danger : scene.level === "info" ? theme.accent.info : theme.status.warning;
  const shake = scene.level === "danger" ? Math.sin(frame * 0.9) * Math.max(0, 1 - frame / 12) * 6 : 0;
  return (
    <AbsoluteFill style={{ justifyContent: "center", alignItems: "center", padding: PAD, opacity: fadeInOut(frame, durF) }}>
      <div
        style={{
          width: "100%",
          background: `${col}10`,
          border: `1.5px solid ${col}`,
          borderRadius: 18,
          padding: 44,
          display: "flex",
          gap: 26,
          alignItems: "center",
          transform: `translateX(${shake}px) scale(${reveal(frame, 0, 10) * 0.05 + 0.95})`,
          boxShadow: depthShadow(col),
        }}
      >
        <div style={{ fontSize: 72, lineHeight: 1, color: col }}>{scene.level === "info" ? "ⓘ" : "⚠"}</div>
        <div style={{ ...t.heading, color: theme.text.primary, fontSize: primitive.size.lg }}>{scene.text}</div>
      </div>
    </AbsoluteFill>
  );
};

/* ─── CTA ──────────────────────────────────────────────────────────────── */
const CTAScene: React.FC<SceneProps<Extract<Scene, { type: "cta" }>>> = ({ scene, theme, frame, durF }) => {
  const t = typePresets(theme);
  return (
    <AbsoluteFill style={{ justifyContent: "center", alignItems: "center", padding: PAD, opacity: fadeInOut(frame, durF) }}>
      <div style={{ textAlign: "center", opacity: reveal(frame, 2, 16), transform: `scale(${slamIn(frame, 2, 1.6, 12)})` }}>
        <div style={{ ...t.title, fontSize: primitive.size.lg }}>{scene.text}</div>
        {scene.handle && (
          <div
            style={{
              ...t.mono,
              marginTop: 26,
              color: theme.accent.brand,
              fontSize: primitive.size.md,
              opacity: reveal(frame, 16, 12),
            }}
          >
            {scene.handle}
          </div>
        )}
      </div>
    </AbsoluteFill>
  );
};

/* ─── Big number / stat ────────────────────────────────────────────────── */
const BigNumberScene: React.FC<SceneProps<Extract<Scene, { type: "big_number" }>>> = ({ scene, theme, frame, durF }) => {
  const t = typePresets(theme);
  // count up the numeric part (keep any prefix/suffix like $, %, ms, x)
  const m = scene.value.match(/^(\D*)([\d.,]+)(.*)$/);
  let display = scene.value;
  if (m) {
    const target = parseFloat(m[2].replace(/,/g, ""));
    if (isFinite(target)) {
      const cur = counter(frame, 3, 22, 0, target);
      display = `${m[1]}${Number.isInteger(target) ? Math.round(cur).toLocaleString() : cur.toFixed(1)}${m[3]}`;
    }
  }
  return (
    <AbsoluteFill style={{ justifyContent: "center", alignItems: "center", padding: PAD, opacity: fadeInOut(frame, durF) }}>
      <div
        style={{
          ...t.hero,
          fontSize: 268,
          fontWeight: 800,
          color: theme.accent.brand,
          letterSpacing: "-0.04em",
          lineHeight: 0.95,
          textShadow: `0 0 70px ${theme.accent.brand}55, 0 4px 30px rgba(0,0,0,0.5)`,
          transform: `scale(${slamIn(frame, 2, 1.35, 12)})`,
        }}
      >
        {display}
      </div>
      <div style={{ ...t.title, fontSize: primitive.size.lg, marginTop: 26, textAlign: "center", maxWidth: 840, opacity: reveal(frame, 12, 14), transform: `translateY(${slideUp(frame, 12, 28, 14)}px)` }}>
        {scene.label}
      </div>
    </AbsoluteFill>
  );
};

/* ─── Quote ────────────────────────────────────────────────────────────── */
const QuoteScene: React.FC<SceneProps<Extract<Scene, { type: "quote" }>>> = ({ scene, theme, frame, durF }) => {
  const t = typePresets(theme);
  return (
    <AbsoluteFill style={{ justifyContent: "center", alignItems: "flex-start", padding: PAD, opacity: fadeInOut(frame, durF) }}>
      <div style={{ fontFamily: t.hero.fontFamily, fontSize: 220, lineHeight: 0.6, color: theme.accent.brand, opacity: reveal(frame, 0, 12) * 0.5 }}>“</div>
      <div style={{ ...t.title, fontSize: primitive.size.xl, fontWeight: 600, maxWidth: 920, marginTop: 6, opacity: reveal(frame, 6, 18), transform: `translateY(${slideUp(frame, 6, 26, 18)}px)` }}>
        {scene.text}
      </div>
      {scene.author && (
        <div style={{ ...t.eyebrow, color: theme.accent.brand, marginTop: 34, opacity: reveal(frame, 22, 12) }}>— {scene.author}</div>
      )}
    </AbsoluteFill>
  );
};

/* ─── Image focus: full-bleed b-roll moment + one lower-third caption ───── */
const ImageFocusScene: React.FC<SceneProps<Extract<Scene, { type: "image_focus" }>>> = ({ scene, theme, frame, durF }) => {
  const t = typePresets(theme);
  const r = reveal(frame, 4, 16);
  return (
    <AbsoluteFill style={{ justifyContent: "flex-end", alignItems: "flex-start", padding: PAD, paddingBottom: 210, opacity: fadeInOut(frame, durF) }}>
      <div style={{ display: "flex", alignItems: "center", gap: 18, opacity: r, transform: `translateX(${(1 - r) * -34}px)` }}>
        <span style={{ width: 6, height: 66, background: theme.accent.brand, borderRadius: 3, boxShadow: `0 0 22px ${theme.accent.brand}` }} />
        <div style={{ ...t.title, fontSize: primitive.size.lg, maxWidth: 820, textShadow: "0 2px 18px rgba(0,0,0,0.7)" }}>{scene.caption}</div>
      </div>
    </AbsoluteFill>
  );
};

/* ─── Grid: the FRAME splits into 2-3 full-bleed panels (rows or cols), each
   with its own background, revealing step by step with a smooth wipe. ─────── */
const GridScene: React.FC<SceneProps<Extract<Scene, { type: "grid" }>>> = ({ scene, theme, frame, durF }) => {
  const t = typePresets(theme);
  const cols = scene.layout === "cols";
  const n = scene.cells.length;
  return (
    <AbsoluteFill style={{ display: "flex", flexDirection: cols ? "row" : "column", opacity: fadeInOut(frame, durF) }}>
      {scene.cells.map((cell, i) => {
        // each panel wipes in one after another over the first ~65% of the scene
        const segStart = 4 + (i / n) * durF * 0.55;
        const r = reveal(frame, segStart, Math.max(10, durF * 0.16));
        const clip = cols ? `inset(0 ${(1 - r) * 100}% 0 0)` : `inset(${(1 - r) * 100}% 0 0 0)`;
        const kb = 1.05 + (frame / Math.max(1, durF)) * 0.08; // slow ken-burns
        const grade = "grayscale(0.12) contrast(1.06) brightness(0.6) saturate(1.06)";
        const txtR = reveal(frame, segStart + 4, 12);
        return (
          <div key={i} style={{ flex: 1, position: "relative", overflow: "hidden", clipPath: clip }}>
            {/* full-bleed background for this panel */}
            {cell.bg ? (
              cell.bgType === "video" ? (
                <OffthreadVideo src={staticFile(cell.bg)} muted style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover", filter: grade, transform: `scale(${kb})` }} />
              ) : (
                <Img src={staticFile(cell.bg)} style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover", filter: grade, transform: `scale(${kb})` }} />
              )
            ) : (
              <AbsoluteFill style={{ background: `linear-gradient(${135 + i * 40}deg, ${theme.accent.brand}33, ${theme.surface})` }} />
            )}
            {/* accent hue + readability wash */}
            <AbsoluteFill style={{ background: theme.accent.brand, opacity: 0.12, mixBlendMode: "color" }} />
            <AbsoluteFill style={{ background: `linear-gradient(${cols ? "90deg" : "180deg"}, ${theme.bg}aa, ${theme.bg}40 45%, ${theme.bg}cc)` }} />
            {/* divider line between panels (not the last) */}
            {i < n - 1 && (
              <div style={cols
                ? { position: "absolute", top: 0, bottom: 0, right: 0, width: 3, background: theme.accent.brand, opacity: 0.9, boxShadow: `0 0 18px ${theme.accent.brand}` }
                : { position: "absolute", left: 0, right: 0, bottom: 0, height: 3, background: theme.accent.brand, opacity: 0.9, boxShadow: `0 0 18px ${theme.accent.brand}` }} />
            )}
            {/* label */}
            <AbsoluteFill style={{ justifyContent: "center", alignItems: "flex-start", padding: PAD - 26, opacity: txtR, transform: `translateY(${(1 - txtR) * 16}px)` }}>
              <div style={{ ...t.eyebrow, color: theme.accent.brand, marginBottom: 10 }}>{String(i + 1).padStart(2, "0")} / {cell.title}</div>
              <div style={{ ...t.title, fontSize: primitive.size.lg, lineHeight: 1.08, maxWidth: cols ? 360 : 820, textShadow: "0 2px 16px rgba(0,0,0,0.7)" }}>{cell.text}</div>
            </AbsoluteFill>
          </div>
        );
      })}
    </AbsoluteFill>
  );
};

/* ─── Chart: vertical bars grow from 0, values count up, staggered in ───── */
const ChartScene: React.FC<SceneProps<Extract<Scene, { type: "chart" }>>> = ({ scene, theme, frame, durF }) => {
  const t = typePresets(theme);
  const accent = theme.accent.brand;
  const max = Math.max(...scene.bars.map((b) => b.value), 1);
  return (
    <AbsoluteFill style={{ justifyContent: "center", padding: PAD, opacity: fadeInOut(frame, durF) }}>
      {scene.title && <Eyebrow theme={theme} frame={frame} label={scene.title} />}
      <div
        style={{
          marginTop: scene.title ? 48 : 0,
          height: 760,
          display: "flex",
          alignItems: "flex-end",
          justifyContent: "space-around",
          gap: 28,
        }}
      >
        {scene.bars.map((bar, i) => {
          const d = stagger(i, 5, 6);
          const grow = reveal(frame, d, 18); // 0 → 1 height growth
          // normalize so the tallest bar reaches ~70% of the available height
          const fullPct = (bar.value / max) * 70;
          const cur = counter(frame, d, 18, 0, bar.value);
          const isInt = Number.isInteger(bar.value);
          const display = `${isInt ? Math.round(cur).toLocaleString() : cur.toFixed(1)}${scene.unit ?? ""}`;
          return (
            <div key={i} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", height: "100%", justifyContent: "flex-end" }}>
              {/* counting value above the bar */}
              <div
                style={{
                  ...t.heading,
                  color: accent,
                  fontSize: primitive.size.lg,
                  fontWeight: 800,
                  marginBottom: 18,
                  opacity: reveal(frame, d + 2, 12),
                  textShadow: `0 0 28px ${accent}55`,
                }}
              >
                {display}
              </div>
              {/* the bar */}
              <div
                style={{
                  width: "78%",
                  height: `${fullPct * grow}%`,
                  background: `linear-gradient(180deg, ${accent}, ${accent}cc)`,
                  borderRadius: "10px 10px 4px 4px",
                  boxShadow: `0 0 46px ${accent}66, inset 0 1px 0 rgba(255,255,255,0.14)`,
                }}
              />
              {/* label below */}
              <div
                style={{
                  ...t.eyebrow,
                  color: theme.text.muted,
                  marginTop: 20,
                  textAlign: "center",
                  opacity: reveal(frame, d + 4, 12),
                }}
              >
                {bar.label}
              </div>
            </div>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};

/* ─── Diagram: a node-flow. Rounded cards appear staggered, connector lines
   draw in between consecutive nodes — a "how it works" / momentum moment. ── */
const DiagramScene: React.FC<SceneProps<Extract<Scene, { type: "diagram" }>>> = ({ scene, theme, frame, durF }) => {
  const t = typePresets(theme);
  const accent = theme.accent.brand;
  const horizontal = scene.direction === "horizontal";
  const n = scene.nodes.length;
  return (
    <AbsoluteFill style={{ justifyContent: "center", alignItems: "center", padding: PAD, opacity: fadeInOut(frame, durF) }}>
      <div
        style={{
          display: "flex",
          flexDirection: horizontal ? "row" : "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 0,
          width: "100%",
        }}
      >
        {scene.nodes.map((node, i) => {
          const d = stagger(i, 11, 6); // each node lands after the previous
          const r = reveal(frame, d, 14);
          // connector AFTER this node draws in once the next node starts arriving
          const connDelay = d + 7;
          const grow = reveal(frame, connDelay, 11); // 0 → 1 line length
          return (
            <React.Fragment key={i}>
              {/* node card */}
              <div
                style={{
                  background: theme.surface,
                  border: `1.5px solid ${accent}`,
                  borderRadius: 18,
                  padding: horizontal ? "30px 30px" : "34px 48px",
                  minWidth: horizontal ? 220 : 360,
                  maxWidth: horizontal ? 300 : 620,
                  textAlign: "center",
                  opacity: r,
                  transform: `translateY(${slideUp(frame, d, 34, 14)}px) scale(${0.94 + r * 0.06})`,
                  boxShadow: depthShadow(accent, 0.9),
                }}
              >
                <div style={{ ...t.eyebrow, color: accent, marginBottom: 12 }}>{String(i + 1).padStart(2, "0")}</div>
                <div style={{ ...t.heading, color: theme.text.primary, fontSize: primitive.size.lg, lineHeight: 1.12 }}>{node.label}</div>
              </div>
              {/* connector line + arrow between this node and the next */}
              {i < n - 1 && (
                <div
                  style={{
                    position: "relative",
                    display: "flex",
                    flexDirection: horizontal ? "row" : "column",
                    alignItems: "center",
                    justifyContent: "center",
                    width: horizontal ? 84 : "auto",
                    height: horizontal ? "auto" : 84,
                  }}
                >
                  <div
                    style={{
                      background: accent,
                      borderRadius: 4,
                      boxShadow: `0 0 18px ${accent}`,
                      transformOrigin: horizontal ? "left center" : "center top",
                      transform: horizontal ? `scaleX(${grow})` : `scaleY(${grow})`,
                      width: horizontal ? "100%" : 4,
                      height: horizontal ? 4 : "100%",
                    }}
                  />
                  {/* arrowhead pointing toward the next node */}
                  <div
                    style={{
                      position: "absolute",
                      [horizontal ? "right" : "bottom"]: -2,
                      width: 0,
                      height: 0,
                      opacity: grow,
                      ...(horizontal
                        ? { borderTop: "9px solid transparent", borderBottom: "9px solid transparent", borderLeft: `13px solid ${accent}` }
                        : { borderLeft: "9px solid transparent", borderRight: "9px solid transparent", borderTop: `13px solid ${accent}` }),
                    }}
                  />
                </div>
              )}
            </React.Fragment>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};

/* ─── Timeline: a vertical axis draws DOWN, event dots + time eyebrow + label
   appear staggered from top to bottom. Calm, sequential, chronological. ──── */
const TimelineScene: React.FC<SceneProps<Extract<Scene, { type: "timeline" }>>> = ({ scene, theme, frame, durF }) => {
  const t = typePresets(theme);
  const accent = theme.accent.brand;
  // the axis draws down over the first ~55% of the scene, slightly ahead of the dots
  const axis = reveal(frame, 4, Math.max(16, durF * 0.5));
  return (
    <AbsoluteFill style={{ justifyContent: "center", padding: PAD, opacity: fadeInOut(frame, durF) }}>
      <div style={{ position: "relative", display: "flex", flexDirection: "column", gap: 56, paddingLeft: 56 }}>
        {/* the axis line — grows downward (top origin) */}
        <div
          style={{
            position: "absolute",
            left: 13,
            top: 8,
            bottom: 8,
            width: 4,
            background: `linear-gradient(180deg, ${accent}, ${accent}cc)`,
            borderRadius: 4,
            transformOrigin: "center top",
            transform: `scaleY(${axis})`,
            boxShadow: `0 0 18px ${accent}`,
          }}
        />
        {scene.events.map((ev, i) => {
          // each event lands sequentially, just after the axis has drawn past it
          const d = stagger(i, 12, 6);
          const r = reveal(frame, d, 14);
          return (
            <div key={i} style={{ position: "relative", display: "flex", alignItems: "flex-start", gap: 32 }}>
              {/* dot on the axis */}
              <div
                style={{
                  position: "absolute",
                  left: -56 + 4,
                  top: 6,
                  width: 22,
                  height: 22,
                  borderRadius: 999,
                  background: accent,
                  border: `4px solid ${theme.bg}`,
                  opacity: r,
                  transform: `scale(${0.5 + r * 0.5})`,
                  boxShadow: `0 0 22px ${accent}`,
                }}
              />
              {/* event content */}
              <div style={{ opacity: r, transform: `translateY(${slideUp(frame, d, 26, 14)}px)` }}>
                {ev.time && (
                  <div style={{ ...t.eyebrow, color: accent, marginBottom: 8 }}>{ev.time}</div>
                )}
                <div style={{ ...t.title, fontSize: primitive.size.lg, lineHeight: 1.1, maxWidth: 820 }}>{ev.label}</div>
              </div>
            </div>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};

/* ─── Map: a stylized abstract location moment. A dark dotted field, a glowing
   accent route polyline that draws in, and pulsing pin markers (one per point)
   each with a label. Evokes "where" without any real map tiles. ───────────── */
const MapScene: React.FC<SceneProps<Extract<Scene, { type: "map" }>>> = ({ scene, theme, frame, durF }) => {
  const t = typePresets(theme);
  const accent = theme.accent.brand;
  const n = scene.points.length;
  // viewBox-space canvas the route + pins live in (matches a vertical-ish field)
  const W = 1000;
  const H = 1180;
  // evenly spaced pin positions along a gentle zig-zag, with margins
  const mx = 220;
  const top = 200;
  const bottom = H - 200;
  const pts = scene.points.map((p, i) => {
    const y = n === 1 ? H / 2 : top + (i / (n - 1)) * (bottom - top);
    const x = n === 1 ? W / 2 : i % 2 === 0 ? mx : W - mx;
    return { ...p, x, y };
  });
  // the route polyline draws in via strokeDashoffset over the first ~55%
  const draw = reveal(frame, 6, Math.max(16, durF * 0.55));
  const routeLen = pts.reduce((acc, p, i) => (i === 0 ? 0 : acc + Math.hypot(p.x - pts[i - 1].x, p.y - pts[i - 1].y)), 0);
  const pathD = pts.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x.toFixed(0)} ${p.y.toFixed(0)}`).join(" ");
  // faint dot-grid field
  const dotCols = 9;
  const dotRows = 11;
  const dots: { x: number; y: number }[] = [];
  for (let r = 0; r < dotRows; r++) for (let c = 0; c < dotCols; c++) dots.push({ x: ((c + 0.5) / dotCols) * W, y: ((r + 0.5) / dotRows) * H });
  return (
    <AbsoluteFill style={{ justifyContent: "center", alignItems: "center", padding: PAD, opacity: fadeInOut(frame, durF) }}>
      {scene.caption && (
        <div style={{ position: "absolute", top: PAD, left: PAD, right: PAD }}>
          <Eyebrow theme={theme} frame={frame} label={scene.caption} />
        </div>
      )}
      <div style={{ position: "relative", width: "100%", maxWidth: 880 }}>
        <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: "auto", overflow: "visible" }}>
          {/* faint dotted field */}
          {dots.map((d, i) => (
            <circle key={i} cx={d.x} cy={d.y} r={3} fill={theme.text.muted} opacity={0.12} />
          ))}
          {/* glowing accent route that draws in */}
          <path
            d={pathD}
            fill="none"
            stroke={accent}
            strokeWidth={6}
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeDasharray={routeLen}
            strokeDashoffset={routeLen * (1 - draw)}
            style={{ filter: `drop-shadow(0 0 18px ${accent})` }}
          />
        </svg>
        {/* pulsing pin markers + labels (HTML overlay positioned in % of the box) */}
        {pts.map((p, i) => {
          const d = stagger(i, 10, 6) + 6;
          const r = reveal(frame, d, 14);
          const pulse = breathe(frame, 64, 0.18);
          const leftPct = (p.x / W) * 100;
          const topPct = (p.y / H) * 100;
          const onRight = p.x > W / 2;
          return (
            <div
              key={i}
              style={{
                position: "absolute",
                left: `${leftPct}%`,
                top: `${topPct}%`,
                transform: "translate(-50%, -50%)",
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                opacity: r,
              }}
            >
              {/* outer pulse ring */}
              <div
                style={{
                  position: "absolute",
                  width: 64,
                  height: 64,
                  borderRadius: 999,
                  border: `2px solid ${accent}`,
                  opacity: (1 - pulse) * 0.6 * r,
                  transform: `scale(${0.7 + pulse})`,
                }}
              />
              {/* the pin dot */}
              <div
                style={{
                  width: 26,
                  height: 26,
                  borderRadius: 999,
                  background: accent,
                  border: `4px solid ${theme.bg}`,
                  boxShadow: `0 0 26px ${accent}`,
                  transform: `scale(${0.5 + r * 0.5})`,
                }}
              />
              {/* label chip */}
              <div
                style={{
                  position: "absolute",
                  top: 38,
                  [onRight ? "right" : "left"]: 0,
                  whiteSpace: "nowrap",
                  ...t.eyebrow,
                  color: theme.text.primary,
                  background: theme.surface,
                  border: `1px solid ${accent}66`,
                  borderRadius: 999,
                  padding: "8px 16px",
                  boxShadow: depthShadow(accent, 0.7),
                  opacity: reveal(frame, d + 4, 12),
                }}
              >
                {p.label}
              </div>
            </div>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};

/* ─── Chapter title card (long-form) ───────────────────────────────────── */
const ChapterTitleScene: React.FC<SceneProps<Extract<Scene, { type: "chapter_title" }>>> = ({ scene, theme, frame, durF }) => {
  const t = typePresets(theme);
  const p = Math.min(1, springy(frame, 2, 14, 1.1));
  return (
    <AbsoluteFill style={{ justifyContent: "center", alignItems: "center", padding: PAD, opacity: fadeInOut(frame, durF) }}>
      <div style={{ ...t.eyebrow, color: theme.accent.brand, fontSize: 36, letterSpacing: "0.2em", opacity: reveal(frame, 0, 12), marginBottom: 30 }}>
        CHAPTER {String(scene.number).padStart(2, "0")}{scene.kicker && !/chapter|^\s*\d+\s*$/i.test(scene.kicker) ? `  ·  ${scene.kicker}` : ""}
      </div>
      <div style={{ ...t.hero, fontSize: 132, fontWeight: 800, textAlign: "center", maxWidth: 1500, lineHeight: 0.98, letterSpacing: "-0.025em", opacity: p, transform: `translateY(${slideUp(frame, 2, 44, 14)}px) scale(${0.95 + p * 0.05})`, textShadow: "0 6px 40px rgba(0,0,0,0.6)" }}>
        {scene.title}
      </div>
      <div style={{ marginTop: 42, height: 6, width: `${reveal(frame, 12, 22) * 280}px`, background: theme.accent.brand, borderRadius: 3, boxShadow: `0 0 30px ${theme.accent.brand}` }} />
    </AbsoluteFill>
  );
};

/* ─── Section summary / recap (long-form) ──────────────────────────────── */
const SectionSummaryScene: React.FC<SceneProps<Extract<Scene, { type: "section_summary" }>>> = ({ scene, theme, frame, durF }) => {
  const t = typePresets(theme);
  return (
    <AbsoluteFill style={{ justifyContent: "center", padding: PAD + 20, opacity: fadeInOut(frame, durF) }}>
      {scene.heading && <div style={{ ...t.eyebrow, color: theme.accent.brand, marginBottom: 34, fontSize: 32, letterSpacing: "0.14em" }}>{scene.heading}</div>}
      {scene.points.map((pt, i) => {
        const d = stagger(i, 7, 4);
        const r = reveal(frame, d, 14);
        return (
          <div key={i} style={{ display: "flex", alignItems: "center", gap: 24, marginBottom: 28, opacity: r, transform: `translateX(${(1 - r) * -34}px)` }}>
            <span style={{ width: 14, height: 14, borderRadius: 7, background: theme.accent.brand, boxShadow: `0 0 16px ${theme.accent.brand}`, flexShrink: 0 }} />
            <div style={{ ...t.title, fontSize: primitive.size.lg, lineHeight: 1.12 }}>{pt}</div>
          </div>
        );
      })}
    </AbsoluteFill>
  );
};

/* ─── Device mockup (pure mograph: animated product UI in a frame) ──────── */
const DeviceMockupScene: React.FC<SceneProps<Extract<Scene, { type: "device_mockup" }>>> = ({ scene, theme, frame, durF }) => {
  const t = typePresets(theme);
  const phone = scene.device === "phone";
  const frameW = phone ? 560 : 880;
  const chrome = scene.device !== "window";
  const s = pop(frame, 3, 18, 0.9, 1.03); // frame lands
  const rowH = phone ? 92 : 104;
  // Guard against degenerate storyboards where the brain filled every row with the
  // SAME text — that renders as one phrase stacked down the whole screen. Collapse
  // to distinct rows (case/space-insensitive) and cap to a sane count.
  const rows = scene.rows
    .filter((row, i, arr) => arr.findIndex((o) => (o.text ?? "").trim().toLowerCase() === (row.text ?? "").trim().toLowerCase()) === i)
    .slice(0, 6);
  return (
    <AbsoluteFill style={{ justifyContent: "center", alignItems: "center", padding: PAD, opacity: fadeInOut(frame, durF) }}>
      {scene.headline && (
        <div style={{ ...t.title, fontSize: primitive.size.lg, textAlign: "center", maxWidth: 880, marginBottom: 44, opacity: reveal(frame, 1, 12), transform: `translateY(${slideUp(frame, 1, 26, 13)}px)`, clipPath: maskWipe(frame, 1, 10) }}>
          {scene.headline}
        </div>
      )}
      <div
        style={{
          width: frameW,
          background: theme.surface,
          borderRadius: phone ? 52 : mgrid.radius,
          border: `1px solid ${theme.accent.brand}22`,
          boxShadow: depthShadow(theme.accent.brand, 1),
          overflow: "hidden",
          transform: `scale(${s}) translateY(${(1 - reveal(frame, 3, 16)) * 22}px)`,
        }}
      >
        {chrome && (
          <div style={{ display: "flex", alignItems: "center", gap: 14, padding: "22px 26px", borderBottom: `1px solid ${theme.text.muted}22`, background: `${theme.bg}55` }}>
            {!phone && [0, 1, 2].map((i) => <span key={i} style={{ width: 17, height: 17, borderRadius: 9, background: theme.text.muted, opacity: 0.45 }} />)}
            {scene.app && (
              <div style={{ ...t.mono, fontSize: primitive.size.xs, color: theme.text.muted, background: theme.bg, borderRadius: primitive.radius.pill, padding: "8px 22px", marginLeft: phone ? 0 : 18, flex: phone ? 1 : undefined, textAlign: phone ? "center" : "left" }}>
                {scene.app}
              </div>
            )}
          </div>
        )}
        <div style={{ padding: phone ? 28 : 36, display: "flex", flexDirection: "column", gap: 18 }}>
          {rows.map((row, i) => {
            const d = 8 + i * 5;
            const r = reveal(frame, d, 13);
            const accent = row.accent;
            return (
              <div
                key={i}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 20,
                  height: rowH,
                  padding: "0 26px",
                  borderRadius: 18,
                  background: accent ? theme.accent.brand : `${theme.bg}cc`,
                  border: `1px solid ${accent ? "transparent" : theme.text.muted + "1f"}`,
                  boxShadow: accent ? `0 14px 50px ${theme.accent.brand}55` : "none",
                  opacity: r,
                  transform: `translateX(${(1 - r) * 30}px) scale(${pop(frame, d, 14, 0.96, 1.02)})`,
                }}
              >
                <span style={{ width: 40, height: 40, borderRadius: 12, background: accent ? "#ffffff33" : theme.accent.brand + "33", flexShrink: 0 }} />
                <span style={{ ...t.subtitle, fontSize: primitive.size.base, color: accent ? "#fff" : theme.text.primary, flex: 1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{row.text}</span>
                {row.value && <span style={{ ...t.mono, fontSize: primitive.size.sm, color: accent ? "#fff" : theme.accent.brand, fontWeight: 700 }}>{row.value}</span>}
              </div>
            );
          })}
        </div>
      </div>
    </AbsoluteFill>
  );
};

/* ─── Bento (pure mograph: feature cards pop in staggered) ──────────────── */
const BentoScene: React.FC<SceneProps<Extract<Scene, { type: "bento" }>>> = ({ scene, theme, frame, durF }) => {
  const t = typePresets(theme);
  const n = scene.cards.length;
  const cols = n <= 2 ? 1 : 2;
  return (
    <AbsoluteFill style={{ justifyContent: "center", padding: PAD - 8, opacity: fadeInOut(frame, durF) }}>
      {scene.heading && (
        <div style={{ ...t.eyebrow, color: theme.accent.brand, fontSize: 32, marginBottom: 36, opacity: reveal(frame, 1, 12) }}>{scene.heading}</div>
      )}
      <div style={{ display: "grid", gridTemplateColumns: `repeat(${cols}, 1fr)`, gap: mgrid.gutter }}>
        {scene.cards.map((c, i) => {
          const d = 4 + i * 5;
          const r = reveal(frame, d, 14);
          const lead = i === 0; // first card emphasized (bento feel)
          const span = lead && n >= 3 && cols === 2 ? 2 : 1;
          return (
            <div
              key={i}
              style={{
                gridColumn: `span ${span}`,
                background: theme.surface,
                borderRadius: mgrid.radius,
                border: `1px solid ${lead ? theme.accent.brand + "66" : theme.text.muted + "1f"}`,
                boxShadow: depthShadow(theme.accent.brand, lead ? 1 : 0.7),
                padding: mgrid.card + 12,
                opacity: r,
                transform: `scale(${pop(frame, d, 15, 0.9, 1.03)}) translateY(${(1 - r) * 22}px)`,
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: c.text ? 18 : 0 }}>
                <span style={{ width: 46, height: 46, borderRadius: 13, background: theme.accent.brand + (lead ? "" : "33"), boxShadow: lead ? `0 0 28px ${theme.accent.brand}66` : "none", flexShrink: 0 }} />
                <div style={{ ...t.heading, fontSize: lead ? primitive.size.lg : primitive.size.md, color: theme.text.primary, lineHeight: 1.1 }}>{c.title}</div>
              </div>
              {c.text && <div style={{ ...t.body, fontSize: primitive.size.sm, color: theme.text.secondary }}>{c.text}</div>}
            </div>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};

/* ─── Stats (pure mograph: 2-4 big metrics count up together) ───────────── */
const StatsScene: React.FC<SceneProps<Extract<Scene, { type: "stats" }>>> = ({ scene, theme, frame, durF }) => {
  const t = typePresets(theme);
  return (
    <AbsoluteFill style={{ justifyContent: "center", padding: PAD, opacity: fadeInOut(frame, durF) }}>
      {scene.heading && <div style={{ ...t.eyebrow, color: theme.accent.brand, fontSize: 32, marginBottom: 50, textAlign: "center", opacity: reveal(frame, 1, 12) }}>{scene.heading}</div>}
      <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "center", gap: mgrid.gutter + 16 }}>
        {scene.stats.map((stat, i) => {
          const d = 4 + i * 6;
          const r = reveal(frame, d, 14);
          // count up the numeric part, preserving prefix/suffix ($, %, x, ms…)
          const m = stat.value.match(/^(\D*)([\d.,]+)(.*)$/);
          let display = stat.value;
          if (m) {
            const target = parseFloat(m[2].replace(/,/g, ""));
            if (isFinite(target)) {
              const cur = counter(frame, d, 22, 0, target);
              display = `${m[1]}${Number.isInteger(target) ? Math.round(cur).toLocaleString() : cur.toFixed(1)}${m[3]}`;
            }
          }
          return (
            <div key={i} style={{ flex: "1 1 360px", minWidth: 320, textAlign: "center", opacity: r, transform: `scale(${pop(frame, d, 16, 0.88, 1.04)})` }}>
              <div style={{ ...t.hero, fontSize: 150, fontWeight: 800, color: theme.accent.brand, lineHeight: 0.95, letterSpacing: "-0.03em", textShadow: `0 0 60px ${theme.accent.brand}55` }}>{display}</div>
              <div style={{ ...t.body, fontSize: primitive.size.base, color: theme.text.secondary, marginTop: 16 }}>{stat.label}</div>
            </div>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};

/* ─── Compare (pure mograph: us-vs-them feature checklist) ──────────────── */
const CompareScene: React.FC<SceneProps<Extract<Scene, { type: "compare" }>>> = ({ scene, theme, frame, durF }) => {
  const t = typePresets(theme);
  const Mark: React.FC<{ on: boolean; accent?: boolean; show: number }> = ({ on, accent, show }) => (
    <span style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 52, height: 52, borderRadius: 26, opacity: show, transform: `scale(${pop(frame, 0, 1, 0.6, 1.1) * show + (1 - show)})`, background: on ? (accent ? theme.accent.brand : theme.text.muted + "33") : "transparent", border: on ? "none" : `2px solid ${theme.text.muted}55`, color: on ? "#fff" : theme.text.muted, fontSize: 30, fontWeight: 800 }}>
      {on ? "✓" : "✕"}
    </span>
  );
  const colW = 200;
  return (
    <AbsoluteFill style={{ justifyContent: "center", padding: PAD - 10, opacity: fadeInOut(frame, durF) }}>
      {/* header row: feature spacer + two column labels */}
      <div style={{ display: "flex", alignItems: "flex-end", marginBottom: 22, opacity: reveal(frame, 1, 12) }}>
        <div style={{ flex: 1 }} />
        <div style={{ width: colW, textAlign: "center", ...t.subtitle, fontSize: primitive.size.base, color: theme.accent.brand, fontWeight: 800 }}>{scene.a}</div>
        <div style={{ width: colW, textAlign: "center", ...t.subtitle, fontSize: primitive.size.base, color: theme.text.muted }}>{scene.b}</div>
      </div>
      {scene.rows.map((row, i) => {
        const d = 8 + i * 6;
        const r = reveal(frame, d, 12);
        return (
          <div key={i} style={{ display: "flex", alignItems: "center", padding: "22px 0", borderTop: `1px solid ${theme.text.muted}1f`, opacity: r, transform: `translateY(${(1 - r) * 16}px)` }}>
            <div style={{ flex: 1, ...t.body, fontSize: primitive.size.base, color: theme.text.primary }}>{row.feature}</div>
            <div style={{ width: colW, display: "flex", justifyContent: "center" }}><Mark on={row.a} accent show={reveal(frame, d + 3, 8)} /></div>
            <div style={{ width: colW, display: "flex", justifyContent: "center" }}><Mark on={row.b} show={reveal(frame, d + 5, 8)} /></div>
          </div>
        );
      })}
    </AbsoluteFill>
  );
};

/* ─── Dialogue (ops_room / war_economy) ────────────────────────────────── */
// OPERATOR/COMMANDER-style sequential briefing lines on a near-black tactical bg.
// Each role label is a fixed-width accent-colored column; text flows after it.
const ROLE_COLORS: Record<string, string> = {
  OPERATOR: "#00c9a7",
  COMMANDER: "#e63946",
  ANALYST: "#f59e0b",
  REPORTER: "#ffffff",
  SOURCE: "#a78bfa",
};

const DialogueScene: React.FC<SceneProps<Extract<Scene, { type: "dialogue" }>>> = ({ scene, theme, frame, durF }) => {
  const t = typePresets(theme);

  // Sequential timing: each line starts as its predecessors finish typing
  const starts: number[] = [];
  let acc = scene.title ? 16 : 6;
  for (const l of scene.lines) {
    starts.push(acc);
    acc += Math.ceil(l.text.length / 2.2) + 10;
  }

  const headerReveal = reveal(frame, 0, 14);
  const dividerReveal = wipe(frame, 10, 16);

  return (
    <AbsoluteFill
      style={{
        justifyContent: "center",
        alignItems: "center",
        padding: PAD,
        opacity: fadeInOut(frame, durF),
      }}
    >
      <div style={{ width: "100%", maxWidth: 900 }}>
        {/* Optional episode/segment header */}
        {scene.title && (
          <div
            style={{
              opacity: headerReveal,
              transform: `translateY(${slideUp(frame, 0, 18, 12)}px)`,
              marginBottom: 10,
            }}
          >
            <span
              style={{
                ...t.eyebrow,
                color: theme.accent.brand,
                letterSpacing: "0.18em",
                fontSize: 13,
              }}
            >
              {scene.title.toUpperCase()}
            </span>
            {scene.subtitle && (
              <span
                style={{
                  ...t.eyebrow,
                  color: theme.text.muted,
                  marginLeft: 18,
                  fontSize: 12,
                  letterSpacing: "0.1em",
                }}
              >
                {scene.subtitle}
              </span>
            )}
          </div>
        )}

        {/* Divider */}
        <div
          style={{
            height: 1,
            background: `linear-gradient(90deg, ${theme.accent.brand}88 0%, transparent 80%)`,
            marginBottom: 28,
            transformOrigin: "left center",
            transform: `scaleX(${dividerReveal})`,
          }}
        />

        {/* Dialogue lines */}
        {scene.lines.map((l: DialogueLine, i: number) => {
          if (frame < starts[i]) return null;
          const el = frame - starts[i];
          const shown = Math.min(l.text.length, typewriter(frame, starts[i], l.text.length, 2.2));
          const typing = shown < l.text.length;
          const lineOp = interpolate(el, [0, 5], [0, 1], { extrapolateRight: "clamp" });
          const roleColor = l.color ?? ROLE_COLORS[l.role.toUpperCase()] ?? theme.accent.brand;

          return (
            <div
              key={i}
              style={{
                display: "flex",
                alignItems: "flex-start",
                gap: 0,
                marginBottom: 18,
                opacity: lineOp,
              }}
            >
              {/* Role column — fixed 180px wide */}
              <span
                style={{
                  ...t.mono,
                  fontSize: 13,
                  fontWeight: 700,
                  color: roleColor,
                  letterSpacing: "0.12em",
                  minWidth: 180,
                  textTransform: "uppercase",
                  paddingTop: 2,
                  flexShrink: 0,
                }}
              >
                {l.role}
              </span>
              {/* Text */}
              <span
                style={{
                  ...t.mono,
                  fontSize: 22,
                  color: theme.text.primary,
                  lineHeight: 1.45,
                  opacity: 0.94,
                }}
              >
                {l.text.slice(0, shown)}
                {typing && <Cursor frame={frame} color={roleColor} />}
              </span>
            </div>
          );
        })}

        {/* Subtle grid overlay — tactical aesthetic */}
        <div
          style={{
            position: "absolute",
            inset: 0,
            backgroundImage:
              `repeating-linear-gradient(0deg, ${theme.accent.brand}08 0px, transparent 1px, transparent 48px),` +
              `repeating-linear-gradient(90deg, ${theme.accent.brand}06 0px, transparent 1px, transparent 48px)`,
            pointerEvents: "none",
          }}
        />
      </div>
    </AbsoluteFill>
  );
};

/* ─── Dispatcher ───────────────────────────────────────────────────────── */
export const SceneRenderer: React.FC<{ scene: Scene; theme: Theme; frame: number; durF: number }> = (p) => {
  switch (p.scene.type) {
    case "hook_text":
      return <HookScene {...(p as any)} />;
    case "terminal":
      return <TerminalScene {...(p as any)} />;
    case "before_after":
      return <BeforeAfterScene {...(p as any)} />;
    case "code_block":
      return <CodeScene {...(p as any)} />;
    case "kinetic_text":
      return <KineticScene {...(p as any)} />;
    case "warning":
      return <WarningScene {...(p as any)} />;
    case "cta":
      return <CTAScene {...(p as any)} />;
    case "big_number":
      return <BigNumberScene {...(p as any)} />;
    case "quote":
      return <QuoteScene {...(p as any)} />;
    case "image_focus":
      return <ImageFocusScene {...(p as any)} />;
    case "grid":
      return <GridScene {...(p as any)} />;
    case "chart":
      return <ChartScene {...(p as any)} />;
    case "diagram":
      return <DiagramScene {...(p as any)} />;
    case "timeline":
      return <TimelineScene {...(p as any)} />;
    case "map":
      return <MapScene {...(p as any)} />;
    case "chapter_title":
      return <ChapterTitleScene {...(p as any)} />;
    case "section_summary":
      return <SectionSummaryScene {...(p as any)} />;
    case "device_mockup":
      return <DeviceMockupScene {...(p as any)} />;
    case "bento":
      return <BentoScene {...(p as any)} />;
    case "stats":
      return <StatsScene {...(p as any)} />;
    case "compare":
      return <CompareScene {...(p as any)} />;
    case "dialogue":
      return <DialogueScene {...(p as any)} />;
  }
};
