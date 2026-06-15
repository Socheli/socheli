// Editor-side keyframe authoring helpers (roadmap C2). Pure functions over the
// scene style.keyframes array so they can be unit-tested without the editor.
// The render-side resolver lives in packages/remotion/src/lib/keyframes.ts.

export type KfProp = "x" | "y" | "scale" | "rotation" | "opacity";
export type KfEase = "linear" | "easeIn" | "easeOut" | "easeInOut" | "hold";
export type KfPoint = { t: number; v: number; ease?: KfEase };
export type KfTrack = { prop: KfProp; points: KfPoint[] };

export const KF_PROPS: KfProp[] = ["x", "y", "scale", "rotation", "opacity"];
const SAME_T = 0.02; // points within this normalized distance are the "same" keyframe

const clamp01 = (t: number) => Math.max(0, Math.min(1, t));
const clone = (tracks: KfTrack[]): KfTrack[] => tracks.map((tr) => ({ prop: tr.prop, points: tr.points.map((p) => ({ ...p })) }));

export function getTracks(style: any): KfTrack[] {
  return Array.isArray(style?.keyframes) ? (style.keyframes as KfTrack[]) : [];
}

// Add or replace the keyframe for `prop` at normalized time `t`.
export function upsertKeyframe(tracks: KfTrack[], prop: KfProp, t: number, v: number, ease: KfEase = "easeInOut"): KfTrack[] {
  const tt = clamp01(t);
  const next = clone(tracks);
  let track = next.find((tr) => tr.prop === prop);
  if (!track) { track = { prop, points: [] }; next.push(track); }
  const existing = track.points.find((p) => Math.abs(p.t - tt) < SAME_T);
  if (existing) { existing.v = v; existing.ease = ease; }
  else track.points.push({ t: tt, v, ease });
  track.points.sort((a, b) => a.t - b.t);
  return next;
}

// Remove the keyframe near `t` for `prop`; drop the track if it empties out.
export function removeKeyframeAt(tracks: KfTrack[], prop: KfProp, t: number): KfTrack[] {
  return clone(tracks)
    .map((tr) => (tr.prop !== prop ? tr : { ...tr, points: tr.points.filter((p) => Math.abs(p.t - t) >= SAME_T) }))
    .filter((tr) => tr.points.length > 0);
}

// Clear one property's track, or all motion when prop is omitted.
export function clearTracks(tracks: KfTrack[], prop?: KfProp): KfTrack[] {
  return prop ? clone(tracks).filter((tr) => tr.prop !== prop) : [];
}

// Whether a property has any keyframes.
export function hasTrack(tracks: KfTrack[], prop: KfProp): boolean {
  return tracks.some((tr) => tr.prop === prop && tr.points.length > 0);
}

// One-click Ken Burns: a gentle scale push (in or out) across the whole scene.
export function kenBurns(zoom = 0.14, dir: "in" | "out" = "in"): KfTrack[] {
  const a = dir === "in" ? 1 : 1 + zoom;
  const b = dir === "in" ? 1 + zoom : 1;
  return [{ prop: "scale", points: [{ t: 0, v: a, ease: "easeInOut" }, { t: 1, v: b, ease: "easeInOut" }] }];
}

// Total keyframe count across all tracks (for badges/labels).
export function keyframeCount(tracks: KfTrack[]): number {
  return tracks.reduce((n, tr) => n + tr.points.length, 0);
}
