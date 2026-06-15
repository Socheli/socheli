import React from "react";
import { Composition } from "remotion";
import { Post, totalFrames, type PostProps } from "./Post.tsx";
import { HybridPost, type HybridPostProps } from "./HybridPost.tsx";
import { Cover, type CoverProps } from "./Cover.tsx";
import { CarouselComposition, type CarouselCompositionProps } from "./CarouselComposition.tsx";
import { StaticPost, type StaticPostProps } from "./StaticPost.tsx";
import { demoProps } from "./demo.ts";

const staticPostDefaultProps: StaticPostProps = {
  headline: "The one habit that compounds every year",
  body: "Small consistent actions outperform bursts of motivation.",
  eyebrow: "Insight",
  layout: "highlight_bar",
  accent: "#d4f700",
  themeName: "concept",
  mood: "cinematic",
  handle: "@labrinox",
  width: 1080,
  height: 1080,
};

export const RemotionRoot: React.FC = () => {
  return (
    <>
      <Composition
        id="Post"
        component={Post as React.FC<Record<string, unknown>>}
        durationInFrames={300}
        fps={30}
        width={1080}
        height={1920}
        defaultProps={demoProps as unknown as Record<string, unknown>}
        calculateMetadata={({ props }: { props: Record<string, unknown> }) => {
          // Storyboard is already validated upstream by the engine; here we only need
          // its (possibly voice-fitted) scene durations + dimensions to size the
          // composition. Width/height come from the storyboard so the SAME Post
          // composition renders 9:16 shorts (1080x1920) AND 16:9 long-form (1920x1080).
          const p = props as unknown as PostProps;
          const fps = p.storyboard?.fps || 30;
          return {
            durationInFrames: totalFrames(p.storyboard, fps),
            fps,
            width: p.storyboard?.width || 1080,
            height: p.storyboard?.height || 1920,
          };
        }}
      />
      {/* ── N6.1: HybridPost — overlay (captions/b-roll/mograph/grade) over a cut
          footage spine. A SUPERSET of Post: spineSrc absent ⇒ renders Post
          byte-identically (so metadata also mirrors the Post composition then). ── */}
      <Composition
        id="HybridPost"
        component={HybridPost as React.FC<Record<string, unknown>>}
        durationInFrames={300}
        fps={30}
        width={1080}
        height={1920}
        defaultProps={{ spineWidth: 1080, spineHeight: 1920, fps: 30, totalFrames: 300 } as unknown as HybridPostProps as unknown as Record<string, unknown>}
        calculateMetadata={({ props }: { props: Record<string, unknown> }) => {
          const p = props as unknown as HybridPostProps;
          // Footage path: dimensions/fps/duration come from the spine (probe-derived
          // upstream in render.ts). Fallback path (no spine): mirror the Post
          // composition exactly off the forwarded storyboard, so byte-identity holds.
          if (!p.spineSrc) {
            const sb = p.postProps?.storyboard;
            const fps = sb?.fps || 30;
            return {
              durationInFrames: sb ? totalFrames(sb, fps) : 300,
              fps,
              width: sb?.width || 1080,
              height: sb?.height || 1920,
            };
          }
          return {
            durationInFrames: Math.max(1, Math.round(p.totalFrames || 1)),
            fps: p.fps || 30,
            width: p.spineWidth || 1080,
            height: p.spineHeight || 1920,
          };
        }}
      />
      <Composition
        id="Cover"
        component={Cover as React.FC<Record<string, unknown>>}
        durationInFrames={1}
        fps={30}
        width={1080}
        height={1920}
        defaultProps={{ title: "Your cover title", eyebrow: "topic", themeName: "concept" } as unknown as CoverProps as unknown as Record<string, unknown>}
      />
      <Composition
        id="CarouselComposition"
        component={CarouselComposition as React.FC<Record<string, unknown>>}
        durationInFrames={300}
        fps={30}
        width={1080}
        height={1080}
        calculateMetadata={({ props }: { props: Record<string, unknown> }) => {
          const p = props as unknown as CarouselCompositionProps;
          const fps = 30;
          const slideDur = p.slideDurationSec ?? 3;
          const n = p.carousel?.slides?.length ?? 5;
          return { durationInFrames: n * slideDur * fps, fps, width: 1080, height: 1080 };
        }}
      />
      {/* ── Static image post: still frame, 1080×1080 square or 1080×1350 4:5 ── */}
      <Composition
        id="StaticPost"
        component={StaticPost as React.FC<Record<string, unknown>>}
        durationInFrames={1}
        fps={30}
        width={1080}
        height={1080}
        defaultProps={staticPostDefaultProps as unknown as Record<string, unknown>}
        calculateMetadata={({ props }: { props: Record<string, unknown> }) => {
          const p = props as unknown as StaticPostProps;
          return {
            durationInFrames: 1,
            fps: 30,
            width: p.width || 1080,
            height: p.height || 1080,
          };
        }}
      />
      {/* ── Carousel slide: same component, adds slide counter badge ── */}
      <Composition
        id="CarouselSlide"
        component={StaticPost as React.FC<Record<string, unknown>>}
        durationInFrames={1}
        fps={30}
        width={1080}
        height={1080}
        defaultProps={{
          ...staticPostDefaultProps,
          slideNumber: 1,
          totalSlides: 6,
        } as unknown as Record<string, unknown>}
        calculateMetadata={({ props }: { props: Record<string, unknown> }) => {
          const p = props as unknown as StaticPostProps;
          return {
            durationInFrames: 1,
            fps: 30,
            width: p.width || 1080,
            height: p.height || 1080,
          };
        }}
      />
    </>
  );
};
