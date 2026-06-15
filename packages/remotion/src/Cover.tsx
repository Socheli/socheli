import React from "react";
import { AbsoluteFill, Img, staticFile } from "remotion";
import { getTheme, getMood, type as typePresets } from "@os/tokens";
import { CinematicBackground } from "./lib/effects.tsx";
import "./lib/fonts.ts";

/* A DESIGNED cover/thumbnail — not a frame grab. Key visual + bold title with an
   accent keyword + topic eyebrow + brand. Rendered as a still by the engine. */
export type CoverProps = {
  title: string; // the big headline (usually the hook)
  eyebrow?: string; // small label (topic / channel)
  themeName?: string;
  mood?: string;
  bg?: string; // optional staticFile path to a key-visual image
  logo?: string;
  handle?: string;
  highlight?: string; // substring of title to colour with the accent
};

export const Cover: React.FC<CoverProps> = ({ title, eyebrow, themeName = "concept", mood: moodId, bg, logo, handle, highlight }) => {
  const theme = getTheme(themeName);
  const accent = getMood(moodId).accent;
  const bgSrc = bg ? (bg.startsWith("data:") || bg.startsWith("http") ? bg : staticFile(bg)) : undefined;

  const renderTitle = () => {
    if (!highlight) return title;
    const i = title.toLowerCase().indexOf(highlight.toLowerCase());
    if (i < 0) return title;
    return (
      <>
        {title.slice(0, i)}
        <span style={{ color: accent }}>{title.slice(i, i + highlight.length)}</span>
        {title.slice(i + highlight.length)}
      </>
    );
  };

  return (
    <AbsoluteFill style={{ backgroundColor: theme.bg }}>
      {bgSrc ? (
        <>
          <Img src={bgSrc} style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover", filter: "grayscale(0.1) contrast(1.06) brightness(0.5) saturate(1.08)" }} />
          <AbsoluteFill style={{ background: accent, opacity: 0.12, mixBlendMode: "color" }} />
          <AbsoluteFill style={{ background: `linear-gradient(180deg, ${theme.bg}cc 0%, ${theme.bg}44 32%, ${theme.bg}f4 100%)` }} />
        </>
      ) : (
        <CinematicBackground theme={theme} w={1080} h={1920} frame={24} energy={accent} />
      )}
      {/* big edge-to-edge vignette for punch */}
      <AbsoluteFill style={{ boxShadow: "inset 0 0 400px 120px rgba(0,0,0,0.6)", pointerEvents: "none" }} />

      {/* brand row, top */}
      <AbsoluteFill style={{ padding: 74, justifyContent: "flex-start", alignItems: "center", flexDirection: "row", gap: 16, height: 160 }}>
        {logo && <Img src={staticFile(logo)} style={{ height: 60, opacity: 0.96, filter: "drop-shadow(0 2px 12px rgba(0,0,0,0.65))" }} />}
        {handle && <span style={{ ...typePresets(theme).eyebrow, color: theme.text.secondary, fontSize: 30, letterSpacing: "0.1em" }}>{handle}</span>}
      </AbsoluteFill>

      {/* headline block, lower third */}
      <AbsoluteFill style={{ padding: 88, justifyContent: "flex-end", paddingBottom: 240 }}>
        {eyebrow && (
          <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 28 }}>
            <span style={{ width: 46, height: 5, background: accent, borderRadius: 3, boxShadow: `0 0 18px ${accent}` }} />
            <span style={{ ...typePresets(theme).eyebrow, color: accent, fontSize: 32, letterSpacing: "0.14em" }}>{eyebrow}</span>
          </div>
        )}
        <div
          style={{
            ...typePresets(theme).title,
            // scale down as the headline gets longer so it never overflows the frame
            fontSize: title.length < 22 ? 190 : title.length < 38 ? 158 : title.length < 56 ? 126 : 104,
            fontWeight: 800,
            lineHeight: 0.96,
            letterSpacing: "-0.035em",
            maxWidth: 940,
            textShadow: "0 8px 46px rgba(0,0,0,0.65)",
          }}
        >
          {renderTitle()}
        </div>
        <div style={{ marginTop: 44, height: 9, width: 190, background: accent, borderRadius: 5, boxShadow: `0 0 34px ${accent}` }} />
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
