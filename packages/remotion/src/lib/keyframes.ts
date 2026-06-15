import { interpolate, Easing } from "remotion";

/* Keyframe animation resolver (roadmap F1).
   A scene may carry style.keyframes: per-property tracks (x/y/scale/rotation/
   opacity) whose points sit on a normalized 0→1 timeline over the scene's
   frames. When a track exists for a property it overrides the scene's static
   style value, so non-keyframed scenes are unaffected. */

export type KfProp = "x" | "y" | "scale" | "rotation" | "opacity";
export type KfEase = "linear" | "easeIn" | "easeOut" | "easeInOut" | "hold";
export type KfPoint = { t: number; v: number; ease?: KfEase };
export type KfTrack = { prop: KfProp; points: KfPoint[] };
export type KfValues = { x?: number; y?: number; scale?: number; rotation?: number; opacity?: number };

const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));

export const easeFn = (e?: KfEase) => {
  switch (e) {
    case "linear": return Easing.linear;
    case "easeIn": return Easing.in(Easing.cubic);
    case "easeOut": return Easing.out(Easing.cubic);
    case "easeInOut":
    default: return Easing.inOut(Easing.cubic);
  }
};

export const resolveKeyframes = (scene: any, frame: number, durF: number): KfValues | null => {
  const tracks = scene?.style?.keyframes as KfTrack[] | undefined;
  if (!Array.isArray(tracks) || !tracks.length || durF <= 0) return null;
  const tNorm = clamp(frame / durF, 0, 1);
  const out: KfValues = {};
  for (const track of tracks) {
    const pts = [...(track?.points ?? [])].filter((p) => typeof p?.v === "number").sort((a, b) => a.t - b.t);
    if (!pts.length) continue;
    let v: number;
    if (tNorm <= pts[0].t) v = pts[0].v;
    else if (tNorm >= pts[pts.length - 1].t) v = pts[pts.length - 1].v;
    else {
      v = pts[pts.length - 1].v;
      for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i], b = pts[i + 1];
        if (tNorm >= a.t && tNorm <= b.t) {
          v = a.ease === "hold"
            ? a.v // step: hold a's value until b
            : interpolate(tNorm, [a.t, b.t], [a.v, b.v], { easing: easeFn(a.ease), extrapolateLeft: "clamp", extrapolateRight: "clamp" });
          break;
        }
      }
    }
    if (track.prop) out[track.prop] = v;
  }
  return out;
};

/* ─── DaVinci spine §4.4 (M13) — generalized param-track resolver ─────────────
   `resolveKeyframes` above is hard-typed to the scene-text transform props
   (x/y/scale/rotation/opacity). Effect-graph nodes (grade/glow/leak/…) animate
   ARBITRARY params (blurPx, glowAmount, leakX, opacity…), so this sibling
   evaluates any node's keyframe tracks by their string `prop` name, reusing the
   exact same sort → segment-find → eased interpolate → hold logic.

   `keyframes` is the EffectNode.keyframes shape from @os/schemas: an array of
   { prop, points:[{t,v,ease?}] }. Returns a record prop→value for every track
   present, or null when there's nothing to animate (so the caller falls back to
   the node's static params and a track-less node is byte-identical). The same
   normalized 0→1 timeline over `durF` frames is used as the transform tracks. */
export type ParamTrack = { prop: string; points: KfPoint[] };
export const resolveParamTracks = (
  keyframes: ParamTrack[] | undefined | null,
  frame: number,
  durF: number,
): Record<string, number> | null => {
  if (!Array.isArray(keyframes) || !keyframes.length || durF <= 0) return null;
  const tNorm = clamp(frame / durF, 0, 1);
  const out: Record<string, number> = {};
  for (const track of keyframes) {
    if (!track?.prop) continue;
    const pts = [...(track?.points ?? [])].filter((p) => typeof p?.v === "number").sort((a, b) => a.t - b.t);
    if (!pts.length) continue;
    let v: number;
    if (tNorm <= pts[0].t) v = pts[0].v;
    else if (tNorm >= pts[pts.length - 1].t) v = pts[pts.length - 1].v;
    else {
      v = pts[pts.length - 1].v;
      for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i], b = pts[i + 1];
        if (tNorm >= a.t && tNorm <= b.t) {
          v = a.ease === "hold"
            ? a.v // step: hold a's value until b
            : interpolate(tNorm, [a.t, b.t], [a.v, b.v], { easing: easeFn(a.ease), extrapolateLeft: "clamp", extrapolateRight: "clamp" });
          break;
        }
      }
    }
    out[track.prop] = v;
  }
  return out;
};
