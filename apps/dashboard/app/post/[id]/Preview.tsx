"use client";
import { Player, type PlayerRef } from "@remotion/player";
import { Post, totalFrames } from "@os/remotion/post";
import { forwardRef } from "react";

// resolve staticFile() against the symlinked remotion assets (apps/dashboard/public/rem)
if (typeof window !== "undefined") (window as any).remotion_staticBase = "/rem";

export const Preview = forwardRef<PlayerRef, { props: any; fill?: boolean; controls?: boolean; width?: number; height?: number }>(function Preview({ props, fill, controls = true, width, height }, ref) {
  if (!props?.storyboard) return <div className="empty">No preview yet - render this item once.</div>;
  let dur = 300;
  try {
    dur = totalFrames(props.storyboard, 30);
  } catch {
    /* keep default */
  }
  // F2: dimension-flexible preview. Explicit width/height props win; otherwise fall
  // back to the storyboard's own dimensions; finally default to 1080x1920 (9:16).
  const compW = width ?? props.storyboard.width ?? 1080;
  const compH = height ?? props.storyboard.height ?? 1920;
  // aspectRatio uses "W / H" so the wrapper matches the composition (9:16, 1:1, 16:9…).
  const aspect = `${compW} / ${compH}`;
  return (
    <Player
      ref={ref}
      component={Post as any}
      inputProps={props}
      durationInFrames={Math.max(30, dur)}
      compositionWidth={compW}
      compositionHeight={compH}
      fps={30}
      style={fill ? { height: "100%", aspectRatio: aspect, borderRadius: 10, overflow: "hidden", background: "#000" } : { width: "100%", aspectRatio: aspect, borderRadius: 12, overflow: "hidden", background: "#000" }}
      controls={controls}
      clickToPlay={false}
      doubleClickToFullscreen={false}
      loop
      acknowledgeRemotionLicense
    />
  );
});
