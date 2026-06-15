import React from "react";
import { AbsoluteFill, Sequence, OffthreadVideo, staticFile, useCurrentFrame, useVideoConfig, interpolate, Easing } from "remotion";
import type { ColorGrade } from "@os/schemas";
import { GradePipeline, gradeToFilterId } from "./lib/grade.tsx";
import {
  Post,
  Karaoke,
  SubtitleLayer,
  BrollBackground,
  OverlayItem,
  type PostProps,
  type WordCue,
  type SubtitleCue,
  type SubtitleSettings,
  type BrollAsset,
  type Overlay,
} from "./Post.tsx";

/* ─── N6.1 — HybridPost: the ONE render path for footage + augmentation ───────
   Roadmap §7.1.4 step 5 + §7.1.5 N6.1.

   HybridPost is a SUPERSET of Post. The hybrid render (§7.1.4) cuts a real
   ingested source into a single silent "spine" mp4 (render.ts renderSpine) and
   this composition composites EVERYTHING over it:

     ① a full-frame <OffthreadVideo> base layer draws the cut footage spine
        (mirrors BrollBackground's staticFile/OffthreadVideo mechanism, Post.tsx),
     ② wrapped in GradePipeline / url(#grade) so the FOOTAGE itself gets the
        `footageGrade` color grade — grade.tsx grades the REAL pixels for free,
     ③ over the graded footage we render the EXISTING caption engine (Post.tsx's
        Karaoke / SubtitleLayer, reused verbatim with the Mix.subtitles preset),
     ④ and any b-roll / motion-graphics / overlay clips as positioned <Sequence>
        layers from their `fromF`/`toF` frame windows.

   Audio is IGNORED here — ffmpeg owns the mastered mix and muxes it last
   (§7.1.4 steps 6-7); we never mount an <Audio>.

   ★ BYTE-IDENTITY CONTRACT (the safe-superset guarantee): when `spineSrc` is
   ABSENT there is no footage to composite over, so HybridPost renders the
   EXISTING <Post> directly with the same props. That is literal delegation —
   the generated-render output is guaranteed byte-identical to today's Post
   because it IS today's Post, with zero extra wrappers in the tree. Only when a
   `spineSrc` is present does the footage-overlay branch below run. */

/* One overlay layer placed over the footage spine for a [fromF, toF) window.
   - "caption"  → reuse the word-level Karaoke / line SubtitleLayer engine
   - "broll"    → a b-roll cutaway via the shared BrollBackground treatment
   - "overlay"  → a free-form sticker/image/logo/emoji/text via OverlayItem
   - "text"     → a free-form text overlay (an OverlayItem of type:"text")
   Each carries the frame window the compositor places it at; the caption kind
   carries its own words/subtitles (so a caption clip can scope to a region). */
export type OverlayClip =
  | {
      kind: "caption";
      fromF: number;
      toF: number;
      words?: WordCue[];
      subtitles?: SubtitleCue[];
      subtitleSettings?: SubtitleSettings;
      preset?: "pop" | "bounce" | "phrase" | "hormozi" | "glow";
      // Caption choreography depth: "behind" composites this line UNDER the subject
      // matte (Odysser look); "front"/absent draws over everything.
      depth?: "front" | "behind";
    }
  | { kind: "broll"; fromF: number; toF: number; asset: BrollAsset; brollGrade?: string }
  | { kind: "overlay" | "text"; fromF: number; toF: number; overlay: Overlay };

/* P3 — Emphasis punch-in zoom window, in TIMELINE frames (computed engine-side by
   creative/emphasis-zoom.ts, also fed by flattened Clip.zoom keyframes via render.ts).
   FootageSpine is the ONE animator that consumes these — roadmap §3 Conflict A. */
export type ZoomWindow = {
  startF: number;
  peakF: number;
  holdF: number;
  endF: number;
  scale: number;
  originX: number;
  originY: number;
};

export type HybridPostProps = {
  /* The cut footage spine, public-relative for staticFile() (render.ts symlinks
     it into remotion/public/ — the broll symlink fix). ABSENT ⇒ Post fallback. */
  spineSrc?: string;
  spineWidth: number;
  spineHeight: number;
  fps: number;
  totalFrames: number;
  /* Color grade applied ON the footage layer inside Remotion (the footage gets
     the primary; identity/absent ⇒ no filter, footage renders ungraded). */
  footageGrade?: ColorGrade;
  /* Caption engine inputs — same shapes Post consumes. words ⇒ Karaoke,
     else subtitles ⇒ SubtitleLayer. */
  words?: WordCue[];
  subtitles?: SubtitleCue[];
  subtitleSettings?: SubtitleSettings;
  /* B-roll / motion-graphics / overlay clips placed as positioned <Sequence>s. */
  overlayClips?: OverlayClip[];
  /* P3 — emphasis punch-in zoom windows (timeline frames). Absent/empty ⇒ a flat
     spine (scale=1 everywhere), byte-identical to today. The SOLE zoom animator. */
  zoomWindows?: ZoomWindow[];
  /* Person alpha matte (public-relative ProRes 4444) — composited between behind-
     subject captions and front content so the speaker occludes the behind lines. */
  matteSrc?: string;
  /* Theme/brand fields reused from Post (caption theming + b-roll tinting). */
  themeName?: string;
  brandAccent?: string;
  /* When spineSrc is ABSENT, every Post prop falls through unchanged so the
     fallback is byte-identical to a normal generated render. */
  postProps?: PostProps;
};

/* The footage spine as a full-frame, muted <OffthreadVideo>, graded in place.
   Mirrors BrollBackground's `staticFile(asset.src)` + <OffthreadVideo> pattern
   (Post.tsx) — objectFit:"cover" fills the frame, the grade reads on real pixels.
   gradeToFilterId returns "" for an identity/absent grade → NO <GradePipeline>
   def and NO url(#…) filter, so an ungraded spine is a plain cover video. */
/* P3 ease — cubic ease-in/out (research bezier 0.16,1,0.3,1) on both the IN ramp up
   to scale and the OUT ramp back to 1, so the zoom never snaps. */
const ZOOM_EASE = Easing.bezier(0.16, 1, 0.3, 1);

const FootageSpine: React.FC<{ src: string; grade?: ColorGrade; zoomWindows?: ZoomWindow[] }> = ({ src, grade, zoomWindows }) => {
  const frame = useCurrentFrame();
  const gradeId = gradeToFilterId(grade, "footage");
  const filter = gradeId ? `url(#${gradeId})` : undefined;

  // The ONE punch-in animator (roadmap §3 Conflict A). Find the active window —
  // computeZoomWindows de-overlaps, so at most one matches. Outside any window
  // scale stays 1 / origin 50% 50% → byte-identical to a flat spine.
  const win = (zoomWindows ?? []).find((w) => frame >= w.startF && frame < w.endF);
  let scale = 1;
  let origin = "50% 50%";
  if (win) {
    const holdEnd = win.peakF + win.holdF;
    scale =
      frame <= win.peakF
        ? interpolate(frame, [win.startF, win.peakF], [1, win.scale], { easing: ZOOM_EASE, extrapolateLeft: "clamp", extrapolateRight: "clamp" })
        : frame <= holdEnd
          ? win.scale
          : interpolate(frame, [holdEnd, win.endF], [win.scale, 1], { easing: ZOOM_EASE, extrapolateLeft: "clamp", extrapolateRight: "clamp" });
    origin = `${win.originX * 100}% ${win.originY * 100}%`;
  }

  return (
    <AbsoluteFill style={{ filter }}>
      {gradeId && <GradePipeline grade={grade} id={gradeId} />}
      {/* ONE scaling wrapper. scale>1 on an objectFit:cover layer stays fully covered
          (no black edges). At scale=1 this is a no-op transform → byte-identical. */}
      <AbsoluteFill style={{ transform: `scale(${scale})`, transformOrigin: origin, willChange: "transform" }}>
        <OffthreadVideo
          src={staticFile(src)}
          muted
          style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover" }}
        />
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

/* One overlay clip rendered for its [fromF, toF) window. Caption clips reuse the
   exact Post caption components; broll/overlay clips reuse BrollBackground /
   OverlayItem so footage augmentation looks identical to a generated post's. */
const OverlayClipLayer: React.FC<{ clip: OverlayClip; themeName: string; accent?: string }> = ({ clip, themeName, accent }) => {
  const { fps } = useVideoConfig();
  const from = Math.max(0, Math.round(clip.fromF));
  const dur = Math.max(1, Math.round(clip.toF) - from);
  if (clip.kind === "caption") {
    // word-level karaoke when words are present, else line subtitles — the same
    // selection rule Post uses at the post level, scoped to this clip's window.
    const inner =
      clip.words && clip.words.length ? (
        <Karaoke words={clip.words} themeName={themeName} style={clip.preset ?? clip.subtitleSettings?.preset ?? "pop"} accent={accent} settings={clip.subtitleSettings} />
      ) : (
        <SubtitleLayer cues={clip.subtitles ?? []} themeName={themeName} settings={clip.subtitleSettings} />
      );
    return (
      <Sequence from={from} durationInFrames={dur} layout="none">
        {inner}
      </Sequence>
    );
  }
  if (clip.kind === "broll") {
    // durF for the Ken-Burns progress is this clip's own length (in frames).
    return (
      <Sequence from={from} durationInFrames={dur} layout="none">
        <BrollBackground asset={clip.asset} themeName={themeName} durF={dur} pulse={0} accent={accent} brollGrade={clip.brollGrade} />
      </Sequence>
    );
  }
  // overlay | text → a positioned free-form overlay (sticker/image/logo/emoji/text).
  return (
    <Sequence from={from} durationInFrames={dur} layout="none">
      <AbsoluteFill style={{ pointerEvents: "none" }}>
        <OverlayItem ov={clip.overlay} />
      </AbsoluteFill>
    </Sequence>
  );
};

/* The PERSON ALPHA MATTE as a full-frame transparent video. Generated from the
   spine (same geometry/timing), so objectFit:"cover" overlays it 1:1. `transparent`
   tells Remotion to keep the alpha plane (ProRes 4444) — the background is see-
   through, only the speaker draws, re-covering any caption layered beneath it. */
const ForegroundMatte: React.FC<{ src: string }> = ({ src }) => (
  <AbsoluteFill style={{ pointerEvents: "none" }}>
    <OffthreadVideo
      src={staticFile(src)}
      muted
      transparent
      style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover" }}
    />
  </AbsoluteFill>
);

export const HybridPost: React.FC<HybridPostProps> = (props) => {
  const { spineSrc, footageGrade, words, subtitles, subtitleSettings, overlayClips, zoomWindows, matteSrc, themeName, brandAccent, postProps } = props;

  // ── BYTE-IDENTITY FALLBACK ──────────────────────────────────────────────
  // No footage spine ⇒ this is a normal generated render. Render <Post> directly
  // with the forwarded props so the output is literally today's Post (no extra
  // wrappers, no behavioral change). HybridPost is a safe superset of Post.
  if (!spineSrc) {
    if (!postProps) return null; // nothing to render without either a spine or Post props
    return <Post {...postProps} />;
  }

  // ── FOOTAGE-OVERLAY BRANCH ──────────────────────────────────────────────
  const theme = themeName ?? postProps?.storyboard?.theme ?? "concept";
  const accent = brandAccent ?? postProps?.brandAccent;
  const captionsEnabled = subtitleSettings?.enabled !== false;

  // Depth split: caption clips marked depth:"behind" render UNDER the subject matte
  // (so the speaker occludes them); everything else renders OVER it. With no matte,
  // there is no split — all overlays draw in order (behind lines fall back to front).
  const all = overlayClips ?? [];
  const behindCaps = matteSrc ? all.filter((c) => c.kind === "caption" && c.depth === "behind") : [];
  const frontClips = matteSrc ? all.filter((c) => !(c.kind === "caption" && c.depth === "behind")) : all;

  return (
    <AbsoluteFill style={{ backgroundColor: "#000" }}>
      {/* ① + ② graded footage spine (full-frame OffthreadVideo + GradePipeline). */}
      <FootageSpine src={spineSrc} grade={footageGrade} zoomWindows={zoomWindows} />

      {/* ③ post-level caption engine over the footage (reused verbatim from Post):
          word cues ⇒ Karaoke, else line cues ⇒ SubtitleLayer. */}
      {captionsEnabled &&
        (words && words.length && subtitleSettings?.mode !== "lines" ? (
          <Karaoke words={words} themeName={theme} style={subtitleSettings?.preset ?? "pop"} accent={accent} settings={subtitleSettings} />
        ) : subtitles && subtitles.length ? (
          <SubtitleLayer cues={subtitles} themeName={theme} settings={subtitleSettings} />
        ) : null)}

      {/* ④a behind-subject caption lines — drawn BEFORE the matte so the speaker hides them. */}
      {behindCaps.map((clip, i) => (
        <OverlayClipLayer key={`bc${i}`} clip={clip} themeName={theme} accent={accent} />
      ))}

      {/* ④b the person matte — re-covers behind-captions with the real speaker pixels. */}
      {matteSrc && <ForegroundMatte src={matteSrc} />}

      {/* ④c b-roll / overlay / front caption clips as positioned <Sequence>s (over the matte). */}
      {frontClips.map((clip, i) => (
        <OverlayClipLayer key={`oc${i}`} clip={clip} themeName={theme} accent={accent} />
      ))}
    </AbsoluteFill>
  );
};
