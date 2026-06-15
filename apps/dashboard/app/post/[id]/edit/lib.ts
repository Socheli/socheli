import { Smartphone, Square, Monitor } from "lucide-react";

// ── Shared types ────────────────────────────────────────────────────────────
export type Scene = Record<string, any>;
export type AudioTrack = { id: string; name: string; vol?: number; mute?: boolean; disabled?: boolean; speed?: number; pan?: number; fadeIn?: number; fadeOut?: number; locked?: boolean; splits?: number[] };
export type Mix = {
  musicVol?: number; voiceVol?: number; sfxVol?: number; beatIntensity?: number; muteMusic?: boolean; muteVoice?: boolean; muteSfx?: boolean;
  captionStyle?: string;
  subtitles?: {
    enabled?: boolean; mode?: "karaoke" | "lines"; preset?: "pop" | "bounce" | "phrase" | "hormozi" | "glow"; position?: "bottom" | "middle" | "top";
    fontScale?: number; letterSpacing?: number; lineHeight?: number; background?: boolean; backgroundOpacity?: number; highlightColor?: string; inactiveOpacity?: number; maxWords?: number; keywords?: string[];
  };
  duck?: { enabled?: boolean; amount?: number; attack?: number; release?: number };
  tracks?: AudioTrack[];
};
export type Snapshot = { scenes: Scene[]; mix: Mix };

// Free-form overlay element placed on top of a scene. Mirrors scene.overlays in
// packages/schemas. Position x/y are in 1080-wide composition space (same units
// as style.x/y) measured from the frame centre; scale/rotation/opacity transform
// the element. Persisted via scene.overlays through the existing scenes PATCH.
export type OverlayKind = "sticker" | "shape" | "image" | "logo" | "emoji" | "text";
export type OverlayShape = "rect" | "circle" | "triangle" | "star" | "arrow" | "line";
export type Overlay = {
  id: string;
  type: OverlayKind;
  content?: string;
  src?: string;
  shape?: OverlayShape;
  color?: string;
  x: number;
  y: number;
  scale: number;
  rotation: number;
  opacity: number;
};
// Built-in overlay presets surfaced in the on-canvas "Add overlay" toolbar.
export const OVERLAY_PRESETS: { key: string; label: string; make: () => Omit<Overlay, "id" | "x" | "y"> }[] = [
  { key: "emoji", label: "Emoji", make: () => ({ type: "emoji", content: "✨", scale: 1, rotation: 0, opacity: 1 }) },
  { key: "text", label: "Label", make: () => ({ type: "text", content: "Label", color: "#ffffff", scale: 1, rotation: 0, opacity: 1 }) },
  { key: "rect", label: "Box", make: () => ({ type: "shape", shape: "rect", color: "#ffffff", scale: 1, rotation: 0, opacity: 1 }) },
  { key: "circle", label: "Circle", make: () => ({ type: "shape", shape: "circle", color: "#ffffff", scale: 1, rotation: 0, opacity: 1 }) },
  { key: "arrow", label: "Arrow", make: () => ({ type: "shape", shape: "arrow", color: "#ffffff", scale: 1, rotation: 0, opacity: 1 }) },
  { key: "star", label: "Star", make: () => ({ type: "shape", shape: "star", color: "#ffffff", scale: 1, rotation: 0, opacity: 1 }) },
  { key: "logo", label: "Logo", make: () => ({ type: "logo", scale: 1, rotation: 0, opacity: 1 }) },
];
export const OVERLAY_EMOJI = ["✨", "🔥", "💡", "⚡", "👀", "✅", "❌", "⭐", "🚀", "❤️", "💯", "👉"];
export function newOverlay(make: () => Omit<Overlay, "id" | "x" | "y">): Overlay {
  return { id: `o${Math.random().toString(36).slice(2, 8)}`, x: 0, y: 0, ...make() };
}

export const TR = 9, FPS = 30;

// F2: output aspect presets. width/height drive the stored storyboard dims and
// the on-canvas frame aspect-ratio; `ratio` is the CSS aspect-ratio string.
export const ASPECTS = [
  { key: "9:16", label: "9:16", width: 1080, height: 1920, ratio: "9 / 16", icon: Smartphone },
  { key: "1:1", label: "1:1", width: 1080, height: 1080, ratio: "1 / 1", icon: Square },
  { key: "16:9", label: "16:9", width: 1920, height: 1080, ratio: "16 / 9", icon: Monitor },
] as const;
export type AspectKey = (typeof ASPECTS)[number]["key"];
export const aspectKeyFor = (w?: number, h?: number): AspectKey => {
  if (!w || !h) return "9:16";
  const r = w / h;
  if (Math.abs(r - 1) < 0.05) return "1:1";
  if (r > 1.1) return "16:9";
  return "9:16";
};

export const TYPE_COLOR: Record<string, string> = {
  hook_text: "#f5f5f5", terminal: "#d4d4d4", before_after: "#a3a3a3",
  code_block: "#e5e5e5", kinetic_text: "#c7c7c7", warning: "#8a8a8a", cta: "#f5f5f5",
  big_number: "#fafafa", quote: "#d4d4d4", image_focus: "#a3a3a3", grid: "#c7c7c7",
  chart: "#e5e5e5", diagram: "#b5b5b5", timeline: "#9a9a9a", map: "#bdbdbd",
};
export const SCENE_TYPES = ["hook_text", "kinetic_text", "before_after", "warning", "terminal", "code_block", "cta", "big_number", "quote", "image_focus", "grid", "chart", "diagram", "timeline", "map"];
export const MONO_SWATCHES = ["", "#ffffff", "#d4d4d4", "#a3a3a3", "#737373", "#404040", "#171717", "#000000"];
export const COLOR_PRESETS = [
  { name: "Theme", color: "" },
  { name: "White", color: "#ffffff" },
  { name: "Steel", color: "#9ca3af" },
  { name: "Graphite", color: "#525252" },
  { name: "Signal Blue", color: "#38bdf8" },
  { name: "Electric", color: "#818cf8" },
  { name: "Violet", color: "#a78bfa" },
  { name: "Magenta", color: "#f472b6" },
  { name: "Crimson", color: "#fb7185" },
  { name: "Amber", color: "#f59e0b" },
  { name: "Lime", color: "#a3e635" },
  { name: "Mint", color: "#34d399" },
  { name: "Cyan", color: "#22d3ee" },
  { name: "Sand", color: "#d6b98c" },
  { name: "Ink", color: "#111827" },
];
export const TERMINAL_KINDS = ["user", "assistant", "tool", "file", "error", "warning", "ok", "blank"];
export const FX = ["grain", "vignette", "contrast", "scanlines", "blur", "invert"];
export const TRANSITIONS = ["slide", "fade", "wipe", "slamzoom", "zoom", "push", "cover", "spin", "glitch"];
export const TRANSITION_EASES = ["linear", "easeIn", "easeOut", "easeInOut"];
export const COMPLEX_TYPES = new Set(["terminal", "code_block", "before_after"]);
// Scene types with dedicated multi-field inspector editing — they skip the
// generic "On-screen text" fallback so editing isn't redundant/conflicting.
export const INSPECTOR_RICH_TYPES = new Set(["big_number", "quote", "image_focus", "grid", "chart", "diagram", "timeline", "map"]);
export const DEFAULT_TRACKS: AudioTrack[] = [
  { id: "music", name: "Music", vol: 1, speed: 1, pan: 0, fadeIn: 0, fadeOut: 0 },
  { id: "voice", name: "Voice", vol: 1, speed: 1, pan: 0, fadeIn: 0, fadeOut: 0 },
  { id: "sfx", name: "SFX", vol: 1, speed: 1, pan: 0, fadeIn: 0, fadeOut: 0 },
];

export function newScene(type: string): Scene {
  const base = { id: `s${Math.random().toString(36).slice(2, 8)}`, durationSec: 4, say: "", emphasis: false };
  switch (type) {
    case "hook_text": return { ...base, type, text: "New hook", motion: "fade_in_up" };
    case "kinetic_text": return { ...base, type, lines: ["New line"], highlight: [] };
    case "warning": return { ...base, type, level: "warning", text: "Warning text" };
    case "cta": return { ...base, type, text: "Follow for more", handle: "" };
    case "before_after": return { ...base, type, caption: "", left: { title: "Bad", text: "the wrong way", bad: true }, right: { title: "Good", text: "the right way", bad: false } };
    case "terminal": return { ...base, type, path: "~/project", status: "ok", lines: [{ kind: "user", text: "command" }] };
    case "code_block": return { ...base, type, language: "ts", code: "// code", focusLines: [] };
    case "big_number": return { ...base, type, value: "100", label: "new metric" };
    case "quote": return { ...base, type, text: "A memorable quote", author: "" };
    case "image_focus": return { ...base, type, caption: "New caption" };
    case "grid": return { ...base, type, layout: "rows", cells: [{ title: "First", text: "first point" }, { title: "Second", text: "second point" }] };
    case "chart": return { ...base, type, title: "Chart", unit: "", bars: [{ label: "A", value: 40 }, { label: "B", value: 80 }] };
    case "diagram": return { ...base, type, direction: "vertical", nodes: [{ label: "Step one" }, { label: "Step two" }] };
    case "timeline": return { ...base, type, events: [{ time: "", label: "First event" }, { time: "", label: "Second event" }] };
    case "map": return { ...base, type, caption: "", points: [{ label: "Point A" }] };
    default: return { ...base, type: "kinetic_text", lines: ["New"], highlight: [] };
  }
}
// Where each scene type's primary text sits on the frame, so the on-canvas
// editor anchors near the real text instead of always dead-centre.
export const TEXT_ANCHOR: Record<string, { v: "top" | "center" | "bottom"; h: "left" | "center" }> = {
  hook_text: { v: "center", h: "left" },
  kinetic_text: { v: "center", h: "left" },
  quote: { v: "center", h: "left" },
  code_block: { v: "center", h: "left" },
  timeline: { v: "center", h: "left" },
  image_focus: { v: "bottom", h: "left" },
  map: { v: "top", h: "left" },
};
export const textAnchor = (type: string) => TEXT_ANCHOR[type] ?? { v: "center" as const, h: "center" as const };

// Rendered primary-text size per scene type, in 1080-wide composition space
// (from @os/tokens primitive.size). The on-canvas editor scales these by the
// measured frame so the editable text matches the real text — true in-place.
export const TEXT_FONT_1080: Record<string, number> = {
  hook_text: 116, kinetic_text: 84, quote: 84, warning: 60, cta: 60,
  before_after: 60, image_focus: 60, big_number: 240, grid: 60,
  diagram: 60, timeline: 60, code_block: 34, terminal: 32, chart: 40, map: 40,
};
export const textFont1080 = (type: string) => TEXT_FONT_1080[type] ?? 60;
export const textWeight = (type: string) => (type === "big_number" ? 800 : type === "code_block" || type === "terminal" ? 500 : 600);

// Every scene type exposes one editable text surface for the canvas editor.
export function primaryText(s: Scene): string {
  switch (s.type) {
    case "hook_text": case "warning": case "cta": case "quote": return s.text ?? "";
    case "kinetic_text": return (s.lines ?? []).join("\n");
    case "before_after": case "image_focus": case "map": return s.caption ?? "";
    case "code_block": return s.code ?? "";
    case "big_number": return s.value ?? "";
    case "chart": return s.title ?? "";
    case "terminal": return (s.lines ?? []).map((l: any) => l?.text ?? "").join("\n");
    case "grid": return (s.cells ?? []).map((c: any) => c?.text ?? "").join("\n");
    case "diagram": return (s.nodes ?? []).map((n: any) => n?.label ?? "").join("\n");
    case "timeline": return (s.events ?? []).map((e: any) => e?.label ?? "").join("\n");
    default: return s.text ?? "";
  }
}
export function setPrimaryText(s: Scene, v: string): Scene {
  const n = { ...s };
  const lines = v.split("\n");
  switch (s.type) {
    case "hook_text": case "warning": case "cta": case "quote": n.text = v; break;
    case "kinetic_text": n.lines = lines.filter(Boolean).slice(0, 4); break;
    case "before_after": case "image_focus": case "map": n.caption = v; break;
    case "code_block": n.code = v; break;
    case "big_number": n.value = v; break;
    case "chart": n.title = v; break;
    case "terminal": n.lines = (lines.length ? lines : [""]).map((text, i) => ({ kind: s.lines?.[i]?.kind ?? "assistant", text })); break;
    case "grid": n.cells = (lines.length ? lines : [""]).map((text, i) => ({ ...(s.cells?.[i] ?? { title: "" }), text })); break;
    case "diagram": n.nodes = lines.filter(Boolean).map((label, i) => ({ ...(s.nodes?.[i] ?? {}), label })); break;
    case "timeline": n.events = lines.filter(Boolean).map((label, i) => ({ ...(s.events?.[i] ?? {}), label })); break;
  }
  return n;
}
export function sceneAtFrame(scenes: Scene[], frame: number): number {
  let cur = 0;
  for (let i = 0; i < scenes.length; i++) {
    const d = Math.max(2 * TR + 4, Math.round((scenes[i].durationSec || 2) * FPS));
    if (frame >= cur && frame < cur + d) return i;
    cur += d - TR;
  }
  return Math.min(scenes.length - 1, Math.max(0, scenes.length - 1));
}
export function cloneScene(scene: Scene): Scene {
  return { ...JSON.parse(JSON.stringify(scene)), id: `s${Math.random().toString(36).slice(2, 8)}` };
}
export function splitScene(scene: Scene, ratio = 0.5): [Scene, Scene] {
  const leftDur = Math.max(1, Number(((scene.durationSec || 2) * ratio).toFixed(2)));
  const rightDur = Math.max(1, Number(((scene.durationSec || 2) - leftDur).toFixed(2)));
  const a = { ...cloneScene(scene), durationSec: leftDur, label: scene.label ? `${scene.label} A` : undefined };
  const b = { ...cloneScene(scene), durationSec: rightDur, label: scene.label ? `${scene.label} B` : undefined };
  return [a, b];
}
export function mergeScenes(a: Scene, b: Scene): Scene {
  const merged = cloneScene(a);
  merged.durationSec = Number(((a.durationSec || 2) + (b.durationSec || 2)).toFixed(2));
  merged.baseDurationSec = undefined;
  merged.speed = 1;
  if (a.say || b.say) merged.say = [a.say, b.say].filter(Boolean).join(" ");
  const at = primaryText(a);
  const bt = primaryText(b);
  if (bt) return setPrimaryText(merged, [at, bt].filter(Boolean).join("\n"));
  return merged;
}
export function trackDefaults(mix: Mix): AudioTrack[] {
  const saved = mix.tracks ?? [];
  return DEFAULT_TRACKS.map((base) => ({ ...base, ...(saved.find((t) => t.id === base.id) ?? {}) }));
}
export const hslColor = (h = 0, s = 0, l = 100) => `hsl(${Math.round(h)} ${Math.round(s)}% ${Math.round(l)}%)`;
