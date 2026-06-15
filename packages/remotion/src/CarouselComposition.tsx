import React from "react";
import { AbsoluteFill, Sequence, useCurrentFrame, useVideoConfig } from "remotion";
import type { CarouselSpec, SlideSpec } from "@os/schemas";
import { getTheme, type as typePresets, primitive } from "@os/tokens";
import { CinematicBackground } from "./lib/effects.tsx";
import { FilmGrain } from "./lib/grade.tsx";
import "./lib/fonts.ts";

export type CarouselCompositionProps = {
  carousel: CarouselSpec;
  brandAccent: string;
  channelHandle?: string;
  channelLogo?: string;
  slideDurationSec?: number; // default 3s per slide
};

/* ─── Helpers ──────────────────────────────────────────────────────────────── */
const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));

/* ─── Slide number indicator (bottom row of dots) ─────────────────────────── */
const SlideDots: React.FC<{ total: number; current: number; accent: string }> = ({ total, current, accent }) => (
  <AbsoluteFill style={{ justifyContent: "flex-end", alignItems: "center", paddingBottom: 40, pointerEvents: "none" }}>
    <div style={{ display: "flex", gap: 8 }}>
      {Array.from({ length: total }).map((_, i) => (
        <div
          key={i}
          style={{
            width: i === current ? 22 : 8,
            height: 8,
            borderRadius: 4,
            background: i === current ? accent : "rgba(255,255,255,0.28)",
            transition: "width 0.2s",
            boxShadow: i === current ? `0 0 10px ${accent}88` : undefined,
          }}
        />
      ))}
    </div>
  </AbsoluteFill>
);

/* ─── Channel handle watermark ─────────────────────────────────────────────── */
const HandleBadge: React.FC<{ handle: string; accent: string; themeName: string }> = ({ handle, accent, themeName }) => {
  const theme = getTheme(themeName);
  const t = typePresets(theme);
  return (
    <AbsoluteFill style={{ justifyContent: "flex-start", alignItems: "center", paddingTop: 40, pointerEvents: "none" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, opacity: 0.6 }}>
        <span style={{ width: 6, height: 6, borderRadius: 3, background: accent }} />
        <span style={{ ...t.eyebrow, color: theme.text.muted, fontSize: primitive.size.xs }}>{handle}</span>
      </div>
    </AbsoluteFill>
  );
};

/* ─── Individual slide layouts ──────────────────────────────────────────────── */
const SlideContent: React.FC<{ slide: SlideSpec; themeName: string; accent: string; index: number; total: number }> = ({
  slide,
  themeName,
  accent,
  index,
  total,
}) => {
  const frame = useCurrentFrame();
  const theme = getTheme(themeName);
  const t = typePresets(theme);
  const slideAccent = slide.accent ?? accent;

  // Simple fade-in entrance for each slide
  const inP = clamp(frame / 8, 0, 1);
  const slideY = (1 - inP) * 28;

  const layout = slide.layout ?? "highlight_bar";

  /* Cover slide: large centred hook + accent rule */
  if (slide.isCover || layout === "text_only") {
    return (
      <AbsoluteFill style={{ justifyContent: "center", alignItems: "center", padding: 80 }}>
        {slide.eyebrow && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              marginBottom: 24,
              opacity: clamp((frame - 2) / 8, 0, 1),
            }}
          >
            <span style={{ width: 28, height: 2, background: slideAccent }} />
            <span style={{ ...t.eyebrow, color: theme.text.muted }}>{slide.eyebrow}</span>
          </div>
        )}
        <div
          style={{
            ...t.title,
            fontSize: primitive.size.xl,
            textAlign: "center",
            maxWidth: 880,
            opacity: inP,
            transform: `translateY(${slideY}px)`,
            lineHeight: 1.08,
          }}
        >
          {slide.headline}
        </div>
        {slide.body && (
          <div
            style={{
              ...t.body,
              color: theme.text.secondary,
              textAlign: "center",
              maxWidth: 760,
              marginTop: 28,
              fontSize: primitive.size.base,
              opacity: clamp((frame - 5) / 10, 0, 1),
              transform: `translateY(${clamp((1 - (frame - 5) / 10), 0, 1) * 18}px)`,
            }}
          >
            {slide.body}
          </div>
        )}
      </AbsoluteFill>
    );
  }

  /* Highlight-bar: left accent bar + text */
  if (layout === "highlight_bar") {
    return (
      <AbsoluteFill style={{ justifyContent: "center", alignItems: "flex-start", padding: 80 }}>
        {slide.eyebrow && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              marginBottom: 20,
              opacity: clamp((frame - 2) / 8, 0, 1),
            }}
          >
            <span style={{ width: 28, height: 2, background: slideAccent }} />
            <span style={{ ...t.eyebrow, color: theme.text.muted }}>{slide.eyebrow}</span>
          </div>
        )}
        <div style={{ display: "flex", gap: 28, alignItems: "flex-start" }}>
          {/* Left accent bar */}
          <div
            style={{
              width: 5,
              borderRadius: 3,
              background: slideAccent,
              alignSelf: "stretch",
              minHeight: 64,
              opacity: clamp(frame / 6, 0, 1),
              boxShadow: `0 0 18px ${slideAccent}66`,
            }}
          />
          <div style={{ flex: 1 }}>
            <div
              style={{
                ...t.title,
                fontSize: primitive.size.lg,
                maxWidth: 880,
                opacity: inP,
                transform: `translateY(${slideY}px)`,
                lineHeight: 1.1,
              }}
            >
              {slide.headline}
            </div>
            {slide.body && (
              <div
                style={{
                  ...t.body,
                  color: theme.text.secondary,
                  maxWidth: 820,
                  marginTop: 24,
                  fontSize: primitive.size.base,
                  opacity: clamp((frame - 5) / 10, 0, 1),
                  transform: `translateY(${clamp((1 - (frame - 5) / 10), 0, 1) * 16}px)`,
                }}
              >
                {slide.body}
              </div>
            )}
          </div>
        </div>
      </AbsoluteFill>
    );
  }

  /* Stat card: large number / stat centred */
  if (layout === "stat_card") {
    return (
      <AbsoluteFill style={{ justifyContent: "center", alignItems: "center", padding: 80 }}>
        <div
          style={{
            background: `${slideAccent}18`,
            border: `1.5px solid ${slideAccent}44`,
            borderRadius: 24,
            padding: "64px 80px",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 20,
            opacity: inP,
            transform: `scale(${0.92 + inP * 0.08}) translateY(${slideY}px)`,
            boxShadow: `0 0 80px ${slideAccent}22`,
          }}
        >
          <div
            style={{
              fontFamily: theme.font.display,
              fontSize: primitive.size.hero,
              fontWeight: 700,
              color: slideAccent,
              lineHeight: 1,
              letterSpacing: "-0.02em",
              textShadow: `0 0 40px ${slideAccent}88`,
            }}
          >
            {slide.headline}
          </div>
          {slide.body && (
            <div style={{ ...t.body, color: theme.text.secondary, textAlign: "center", fontSize: primitive.size.md }}>
              {slide.body}
            </div>
          )}
        </div>
      </AbsoluteFill>
    );
  }

  /* Split: headline top half, body bottom half separated by accent line */
  if (layout === "split") {
    return (
      <AbsoluteFill style={{ flexDirection: "column", justifyContent: "center", padding: 80, gap: 0 }}>
        <div
          style={{
            flex: 1,
            display: "flex",
            flexDirection: "column",
            justifyContent: "flex-end",
            paddingBottom: 40,
            opacity: inP,
            transform: `translateY(${slideY}px)`,
          }}
        >
          {slide.eyebrow && (
            <div style={{ ...t.eyebrow, color: theme.text.muted, marginBottom: 16 }}>{slide.eyebrow}</div>
          )}
          <div style={{ ...t.title, fontSize: primitive.size.xl, lineHeight: 1.08, maxWidth: 900 }}>
            {slide.headline}
          </div>
        </div>
        {/* Accent divider */}
        <div
          style={{
            height: 2,
            background: `linear-gradient(90deg, ${slideAccent}, transparent)`,
            opacity: clamp(frame / 8, 0, 1),
            marginBottom: 40,
          }}
        />
        {slide.body && (
          <div
            style={{
              flex: 1,
              ...t.body,
              color: theme.text.secondary,
              fontSize: primitive.size.md,
              maxWidth: 880,
              opacity: clamp((frame - 5) / 10, 0, 1),
              transform: `translateY(${clamp((1 - (frame - 5) / 10), 0, 1) * 16}px)`,
            }}
          >
            {slide.body}
          </div>
        )}
      </AbsoluteFill>
    );
  }

  /* text_over_image fallback — rendered without an actual image (image is pre-generated
     outside Remotion for IG export); show a tinted gradient stand-in + text overlay. */
  return (
    <AbsoluteFill>
      <AbsoluteFill
        style={{
          background: `linear-gradient(160deg, ${slideAccent}18 0%, ${theme.bg} 100%)`,
          border: `1px solid ${slideAccent}22`,
        }}
      />
      <AbsoluteFill style={{ justifyContent: "flex-end", padding: 80, paddingBottom: 140 }}>
        {slide.eyebrow && (
          <div style={{ ...t.eyebrow, color: slideAccent, marginBottom: 16, opacity: clamp((frame - 2) / 8, 0, 1) }}>
            {slide.eyebrow}
          </div>
        )}
        <div
          style={{
            ...t.title,
            fontSize: primitive.size.lg,
            maxWidth: 900,
            opacity: inP,
            transform: `translateY(${slideY}px)`,
            lineHeight: 1.1,
          }}
        >
          {slide.headline}
        </div>
        {slide.body && (
          <div
            style={{
              ...t.body,
              color: theme.text.secondary,
              fontSize: primitive.size.base,
              maxWidth: 820,
              marginTop: 20,
              opacity: clamp((frame - 5) / 10, 0, 1),
            }}
          >
            {slide.body}
          </div>
        )}
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

/* ─── Single slide frame ────────────────────────────────────────────────────── */
const Slide: React.FC<{
  slide: SlideSpec;
  themeName: string;
  accent: string;
  index: number;
  total: number;
  channelHandle?: string;
  width: number;
  height: number;
}> = ({ slide, themeName, accent, index, total, channelHandle, width, height }) => {
  const frame = useCurrentFrame();
  const theme = getTheme(themeName);
  const slideAccent = slide.accent ?? accent;
  const bgSeed = (index * 13 + slide.headline.length * 3) % 97;

  return (
    <AbsoluteFill style={{ backgroundColor: slide.bgColor ?? theme.bg }}>
      {/* Textured background */}
      <CinematicBackground theme={theme} w={width} h={height} frame={frame} energy={slideAccent} variant="mesh" seed={bgSeed} />
      {/* Vignette */}
      <AbsoluteFill style={{ boxShadow: "inset 0 0 300px 80px rgba(0,0,0,0.65)", pointerEvents: "none" }} />
      {/* Slide content */}
      <SlideContent slide={slide} themeName={themeName} accent={slideAccent} index={index} total={total} />
      {/* Film grain for premium texture */}
      <AbsoluteFill style={{ pointerEvents: "none" }}>
        <FilmGrain w={width} h={height} frame={frame} opacity={0.05} />
      </AbsoluteFill>
      {/* Slide navigation dots */}
      <SlideDots total={total} current={index} accent={slideAccent} />
      {/* Channel handle */}
      {channelHandle && <HandleBadge handle={channelHandle} accent={slideAccent} themeName={themeName} />}
    </AbsoluteFill>
  );
};

/* ─── Carousel composition ──────────────────────────────────────────────────── */
export const CarouselComposition: React.FC<CarouselCompositionProps> = ({
  carousel,
  brandAccent,
  channelHandle,
  slideDurationSec = 3,
}) => {
  const { fps, width, height } = useVideoConfig();
  const slides = carousel?.slides ?? [];
  const slideDurF = Math.round(slideDurationSec * fps);
  const themeName = carousel?.theme ?? "concept";
  const accent = brandAccent ?? getTheme(themeName).accent.brand;

  return (
    <AbsoluteFill>
      {slides.map((slide, i) => (
        <Sequence key={slide.id} from={i * slideDurF} durationInFrames={slideDurF}>
          <Slide
            slide={slide}
            themeName={themeName}
            accent={accent}
            index={i}
            total={slides.length}
            channelHandle={channelHandle}
            width={width}
            height={height}
          />
        </Sequence>
      ))}
    </AbsoluteFill>
  );
};
