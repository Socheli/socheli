import React from "react";
import { AbsoluteFill, Img, staticFile } from "remotion";
import { getTheme, getMood, type as typePresets } from "@os/tokens";
import "./lib/fonts.ts";

/* ─────────────────────────────────────────────────────────────────────────
   StaticPost — editorial static-image post, Kaizen-Sherpa style.
   1 frame still; exported as PNG by the engine.

   Visual language:
   - Textured/photo bg or rich dark surface (NO flat gradients)
   - Bold serif/display headline
   - Neon accent bar behind headline (highlight_bar layout)
   - Small @handle bottom-left, logo bottom-right
   - Square (1080×1080) or 4:5 (1080×1350)
   ───────────────────────────────────────────────────────────────────────── */

export type StaticPostProps = {
  headline: string;
  body?: string;
  eyebrow?: string;
  layout: "text_only" | "text_over_image" | "highlight_bar" | "split" | "stat_card";
  bgImageSrc?: string;       // path to background image (texture/photo)
  bgColor?: string;          // fallback bg color if no image
  accent: string;            // brand accent color (hex)
  themeName: string;
  mood?: string;
  handle?: string;           // @handle shown bottom-left
  logo?: string;             // logo path (remotion staticFile)
  width: number;             // 1080
  height: number;            // 1080 or 1350
  slideNumber?: number;      // for carousel slides: "01 / 06"
  totalSlides?: number;
  isCover?: boolean;
  isCta?: boolean;
};

/* Resolve a bgImageSrc that may be a staticFile path, data URI, or http URL. */
function resolveImg(src: string): string {
  if (src.startsWith("data:") || src.startsWith("http")) return src;
  return staticFile(src);
}

/* Pad a slide number to two digits. */
function padSlide(n: number): string {
  return String(n).padStart(2, "0");
}

export const StaticPost: React.FC<StaticPostProps> = ({
  headline,
  body,
  eyebrow,
  layout,
  bgImageSrc,
  bgColor,
  accent,
  themeName,
  mood: moodId,
  handle,
  logo,
  width,
  height,
  slideNumber,
  totalSlides,
  isCover = false,
  isCta = false,
}) => {
  const theme = getTheme(themeName);
  // Resolve accent: prefer explicit prop, fall back to mood, then theme brand.
  const moodAccent = moodId ? getMood(moodId).accent : undefined;
  const resolvedAccent = accent || moodAccent || theme.accent.brand;

  const T = typePresets(theme);

  /* ── shared brand strip (bottom) ── */
  const BrandStrip: React.FC = () => (
    <div
      style={{
        position: "absolute",
        bottom: 0,
        left: 0,
        right: 0,
        height: 80,
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        paddingLeft: 56,
        paddingRight: 56,
        background: "linear-gradient(0deg, rgba(0,0,0,0.55) 0%, transparent 100%)",
      }}
    >
      {handle ? (
        <span
          style={{
            ...T.eyebrow,
            color: "rgba(255,255,255,0.75)",
            fontSize: 24,
            letterSpacing: "0.08em",
          }}
        >
          {handle}
        </span>
      ) : (
        <span />
      )}
      {logo ? (
        <Img
          src={staticFile(logo)}
          style={{ height: 38, opacity: 0.88, filter: "drop-shadow(0 2px 8px rgba(0,0,0,0.5))" }}
        />
      ) : (
        <span />
      )}
    </div>
  );

  /* ── slide counter pill (top-right) for carousel slides ── */
  const SlideCounter: React.FC = () => {
    if (slideNumber == null || totalSlides == null) return null;
    return (
      <div
        style={{
          position: "absolute",
          top: 52,
          right: 52,
          background: "rgba(0,0,0,0.48)",
          border: `1.5px solid rgba(255,255,255,0.15)`,
          borderRadius: 999,
          padding: "8px 20px",
          display: "flex",
          alignItems: "center",
          gap: 6,
        }}
      >
        <span
          style={{
            fontFamily: theme.font.mono,
            fontSize: 22,
            fontWeight: 600,
            color: resolvedAccent,
            letterSpacing: "0.04em",
          }}
        >
          {padSlide(slideNumber)}
        </span>
        <span style={{ fontFamily: theme.font.mono, fontSize: 22, color: "rgba(255,255,255,0.3)" }}>
          /
        </span>
        <span
          style={{
            fontFamily: theme.font.mono,
            fontSize: 22,
            color: "rgba(255,255,255,0.35)",
            letterSpacing: "0.04em",
          }}
        >
          {padSlide(totalSlides)}
        </span>
      </div>
    );
  };

  /* ── eyebrow label ── */
  const EyebrowLabel: React.FC<{ inverted?: boolean }> = ({ inverted = false }) => {
    if (!eyebrow) return null;
    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          marginBottom: 20,
        }}
      >
        <span
          style={{
            width: 32,
            height: 3,
            background: resolvedAccent,
            borderRadius: 2,
            flexShrink: 0,
          }}
        />
        <span
          style={{
            fontFamily: theme.font.display,
            fontSize: 26,
            fontWeight: 600,
            letterSpacing: "0.14em",
            textTransform: "uppercase" as const,
            color: inverted ? resolvedAccent : resolvedAccent,
          }}
        >
          {eyebrow}
        </span>
      </div>
    );
  };

  /* ── body text ── */
  const BodyText: React.FC<{ inverted?: boolean }> = ({ inverted = false }) => {
    if (!body) return null;
    return (
      <p
        style={{
          ...T.body,
          marginTop: 24,
          fontSize: 32,
          lineHeight: 1.55,
          color: inverted ? "rgba(0,0,0,0.7)" : theme.text.secondary,
          maxWidth: "90%",
          // clamp to 2 lines visually — overflow hidden
          display: "-webkit-box",
          WebkitLineClamp: 2,
          WebkitBoxOrient: "vertical" as const,
          overflow: "hidden",
        }}
      >
        {body}
      </p>
    );
  };

  /* ── CTA badge ── */
  const CtaBadge: React.FC = () => {
    if (!isCta) return null;
    return (
      <div
        style={{
          marginTop: 36,
          display: "inline-flex",
          alignItems: "center",
          gap: 12,
          background: resolvedAccent,
          borderRadius: 999,
          padding: "12px 32px",
        }}
      >
        <span
          style={{
            fontFamily: theme.font.display,
            fontSize: 28,
            fontWeight: 700,
            color: "#000",
            letterSpacing: "0.04em",
          }}
        >
          {handle ? `Follow ${handle}` : "Follow for more"}
        </span>
      </div>
    );
  };

  /* ──────────────────────────────────────────────────────────────────────
     LAYOUT: text_only
     Large serif headline centred, clean bg, no bar.
     ────────────────────────────────────────────────────────────────────── */
  if (layout === "text_only") {
    const bg = bgColor || theme.bg;
    return (
      <AbsoluteFill style={{ background: bg, width, height }}>
        {bgImageSrc && (
          <>
            <Img
              src={resolveImg(bgImageSrc)}
              style={{
                position: "absolute",
                inset: 0,
                width: "100%",
                height: "100%",
                objectFit: "cover",
                filter: "grayscale(0.4) brightness(0.22)",
              }}
            />
          </>
        )}
        {/* Subtle texture grain */}
        <AbsoluteFill
          style={{
            background: "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='200' height='200'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='200' height='200' filter='url(%23n)' opacity='0.04'/%3E%3C/svg%3E\")",
            opacity: 0.6,
            pointerEvents: "none",
          }}
        />
        {/* Content centred */}
        <AbsoluteFill
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            padding: 80,
            textAlign: "center",
          }}
        >
          <EyebrowLabel />
          <h1
            style={{
              fontFamily: theme.font.display,
              fontSize: headline.length < 24 ? 120 : headline.length < 44 ? 96 : 76,
              fontWeight: 800,
              lineHeight: 1.05,
              letterSpacing: "-0.03em",
              color: theme.text.primary,
              margin: 0,
              textShadow: "0 4px 32px rgba(0,0,0,0.5)",
            }}
          >
            {headline}
          </h1>
          <div
            style={{
              marginTop: 32,
              width: 72,
              height: 6,
              background: resolvedAccent,
              borderRadius: 3,
              boxShadow: `0 0 24px ${resolvedAccent}`,
            }}
          />
          <BodyText />
          <CtaBadge />
        </AbsoluteFill>
        <SlideCounter />
        <BrandStrip />
      </AbsoluteFill>
    );
  }

  /* ──────────────────────────────────────────────────────────────────────
     LAYOUT: highlight_bar
     Kaizen-Sherpa signature: thick accent-coloured bar BEHIND headline.
     Like a highlighter pen over paper. Works on dark OR light backgrounds.
     ────────────────────────────────────────────────────────────────────── */
  if (layout === "highlight_bar") {
    const bg = bgColor || "#0f0f0f";
    return (
      <AbsoluteFill style={{ background: bg, width, height }}>
        {bgImageSrc && (
          <Img
            src={resolveImg(bgImageSrc)}
            style={{
              position: "absolute",
              inset: 0,
              width: "100%",
              height: "100%",
              objectFit: "cover",
              filter: "brightness(0.28) saturate(0.6)",
            }}
          />
        )}
        {/* Concrete/paper texture overlay */}
        <AbsoluteFill
          style={{
            background: `radial-gradient(ellipse 80% 70% at 50% 30%, ${resolvedAccent}08, transparent 60%)`,
            pointerEvents: "none",
          }}
        />
        {/* Main content block, centred vertically with slight upward bias */}
        <AbsoluteFill
          style={{
            display: "flex",
            flexDirection: "column",
            justifyContent: "center",
            alignItems: "flex-start",
            padding: "0 80px",
            paddingBottom: height === 1350 ? 140 : 100,
          }}
        >
          <EyebrowLabel />
          {/* Headline with neon highlight bar behind it */}
          <div
            style={{
              position: "relative",
              display: "inline-block",
              maxWidth: "100%",
            }}
          >
            {/* The "highlighter pen" bar */}
            <div
              style={{
                position: "absolute",
                inset: "-4px -12px",
                background: resolvedAccent,
                opacity: 0.85,
                borderRadius: 4,
                zIndex: 0,
              }}
            />
            <h1
              style={{
                position: "relative",
                zIndex: 1,
                fontFamily: theme.font.display,
                fontSize: headline.length < 20 ? 108 : headline.length < 36 ? 88 : headline.length < 54 ? 70 : 56,
                fontWeight: 900,
                lineHeight: 1.08,
                letterSpacing: "-0.025em",
                color: "#000",
                margin: 0,
                // multi-line: each line gets the bar so we use box-decoration-break
                display: "inline",
                WebkitBoxDecorationBreak: "clone" as const,
                boxDecorationBreak: "clone" as const,
                padding: "4px 12px",
                background: resolvedAccent,
                borderRadius: 4,
              }}
            >
              {headline}
            </h1>
          </div>
          <BodyText />
          <CtaBadge />
        </AbsoluteFill>
        <SlideCounter />
        <BrandStrip />
      </AbsoluteFill>
    );
  }

  /* ──────────────────────────────────────────────────────────────────────
     LAYOUT: text_over_image
     Full-bleed photo bg, gradient from bottom, headline anchored lower-third.
     ────────────────────────────────────────────────────────────────────── */
  if (layout === "text_over_image") {
    return (
      <AbsoluteFill style={{ background: bgColor || "#000", width, height }}>
        {bgImageSrc && (
          <>
            <Img
              src={resolveImg(bgImageSrc)}
              style={{
                position: "absolute",
                inset: 0,
                width: "100%",
                height: "100%",
                objectFit: "cover",
                filter: "brightness(0.75) saturate(0.85) contrast(1.05)",
              }}
            />
            {/* Scrim: dark overlay */}
            <AbsoluteFill style={{ background: "rgba(0,0,0,0.25)" }} />
            {/* Gradient from bottom for legibility */}
            <AbsoluteFill
              style={{
                background:
                  "linear-gradient(to top, rgba(0,0,0,0.88) 0%, rgba(0,0,0,0.6) 35%, rgba(0,0,0,0.1) 65%, transparent 100%)",
              }}
            />
          </>
        )}
        {/* Headline anchored to lower third */}
        <AbsoluteFill
          style={{
            display: "flex",
            flexDirection: "column",
            justifyContent: "flex-end",
            alignItems: "flex-start",
            padding: "0 72px",
            paddingBottom: 120,
          }}
        >
          <EyebrowLabel />
          <h1
            style={{
              fontFamily: theme.font.display,
              fontSize: headline.length < 24 ? 112 : headline.length < 44 ? 88 : 70,
              fontWeight: 800,
              lineHeight: 1.06,
              letterSpacing: "-0.03em",
              color: theme.text.primary,
              margin: 0,
              textShadow: "0 4px 48px rgba(0,0,0,0.7)",
              maxWidth: "92%",
            }}
          >
            {headline}
          </h1>
          <div
            style={{
              marginTop: 28,
              width: 56,
              height: 5,
              background: resolvedAccent,
              borderRadius: 3,
              boxShadow: `0 0 20px ${resolvedAccent}`,
            }}
          />
          <BodyText />
          <CtaBadge />
        </AbsoluteFill>
        <SlideCounter />
        <BrandStrip />
      </AbsoluteFill>
    );
  }

  /* ──────────────────────────────────────────────────────────────────────
     LAYOUT: stat_card
     Huge numeric stat centred, headline label below.
     Ideal for "73% of founders…" style posts.
     ────────────────────────────────────────────────────────────────────── */
  if (layout === "stat_card") {
    const bg = bgColor || theme.bg;
    // The "stat" is the first word/token in the headline (e.g. "73%").
    // The rest is the subline. If eyebrow is provided it acts as the context label.
    const spaceIdx = headline.indexOf(" ");
    const statToken = spaceIdx > 0 ? headline.slice(0, spaceIdx) : headline;
    const subline = spaceIdx > 0 ? headline.slice(spaceIdx + 1) : "";
    return (
      <AbsoluteFill style={{ background: bg, width, height }}>
        {bgImageSrc && (
          <Img
            src={resolveImg(bgImageSrc)}
            style={{
              position: "absolute",
              inset: 0,
              width: "100%",
              height: "100%",
              objectFit: "cover",
              filter: "brightness(0.2) saturate(0.3)",
            }}
          />
        )}
        {/* Radial glow behind the stat */}
        <AbsoluteFill
          style={{
            background: `radial-gradient(600px 600px at 50% 42%, ${resolvedAccent}22, transparent 68%)`,
            pointerEvents: "none",
          }}
        />
        <AbsoluteFill
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            padding: 80,
            textAlign: "center",
          }}
        >
          {eyebrow && (
            <span
              style={{
                fontFamily: theme.font.display,
                fontSize: 28,
                fontWeight: 600,
                letterSpacing: "0.16em",
                textTransform: "uppercase" as const,
                color: resolvedAccent,
                marginBottom: 24,
              }}
            >
              {eyebrow}
            </span>
          )}
          {/* The big stat */}
          <div
            style={{
              fontFamily: theme.font.display,
              fontSize: statToken.length <= 4 ? 240 : statToken.length <= 6 ? 180 : 140,
              fontWeight: 900,
              lineHeight: 0.9,
              letterSpacing: "-0.04em",
              color: resolvedAccent,
              textShadow: `0 0 80px ${resolvedAccent}55`,
            }}
          >
            {statToken}
          </div>
          {subline && (
            <h2
              style={{
                fontFamily: theme.font.display,
                fontSize: 52,
                fontWeight: 700,
                lineHeight: 1.2,
                letterSpacing: "-0.02em",
                color: theme.text.primary,
                margin: "28px 0 0",
                maxWidth: 840,
              }}
            >
              {subline}
            </h2>
          )}
          {body && (
            <p
              style={{
                ...T.body,
                fontSize: 30,
                color: theme.text.secondary,
                marginTop: 20,
                maxWidth: 760,
              }}
            >
              {body}
            </p>
          )}
          <CtaBadge />
        </AbsoluteFill>
        <SlideCounter />
        <BrandStrip />
      </AbsoluteFill>
    );
  }

  /* ──────────────────────────────────────────────────────────────────────
     LAYOUT: split
     Left half = solid accent colour panel, Right half = dark + text.
     Bold magazine two-column feel.
     ────────────────────────────────────────────────────────────────────── */
  // split (also the default fallback)
  const splitBg = bgColor || theme.bg;
  return (
    <AbsoluteFill style={{ background: splitBg, width, height }}>
      {bgImageSrc && (
        <Img
          src={resolveImg(bgImageSrc)}
          style={{
            position: "absolute",
            inset: 0,
            width: "100%",
            height: "100%",
            objectFit: "cover",
            filter: "brightness(0.18) saturate(0.4)",
          }}
        />
      )}
      {/* Left accent panel */}
      <div
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          width: "42%",
          height: "100%",
          background: resolvedAccent,
        }}
      >
        {/* Optional: rotated label or eyebrow on the accent panel */}
        {eyebrow && (
          <div
            style={{
              position: "absolute",
              bottom: 80,
              left: 0,
              right: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              transform: "rotate(-90deg)",
              transformOrigin: "50% 50%",
            }}
          >
            <span
              style={{
                fontFamily: theme.font.display,
                fontSize: 22,
                fontWeight: 700,
                letterSpacing: "0.22em",
                textTransform: "uppercase" as const,
                color: "rgba(0,0,0,0.55)",
                whiteSpace: "nowrap",
              }}
            >
              {eyebrow}
            </span>
          </div>
        )}
      </div>
      {/* Right text panel */}
      <div
        style={{
          position: "absolute",
          top: 0,
          left: "42%",
          right: 0,
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          padding: "0 60px",
          paddingBottom: 100,
        }}
      >
        <h1
          style={{
            fontFamily: theme.font.display,
            fontSize: headline.length < 20 ? 96 : headline.length < 36 ? 76 : 60,
            fontWeight: 900,
            lineHeight: 1.1,
            letterSpacing: "-0.03em",
            color: theme.text.primary,
            margin: 0,
          }}
        >
          {headline}
        </h1>
        <div
          style={{
            marginTop: 24,
            width: 48,
            height: 5,
            background: resolvedAccent,
            borderRadius: 3,
          }}
        />
        {body && (
          <p
            style={{
              ...T.body,
              fontSize: 28,
              color: theme.text.secondary,
              marginTop: 20,
              lineHeight: 1.6,
            }}
          >
            {body}
          </p>
        )}
        <CtaBadge />
      </div>
      <SlideCounter />
      <BrandStrip />
    </AbsoluteFill>
  );
};
