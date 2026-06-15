export type SubtitleCue = { fromF: number; toF: number; lines: string[] };
export type WordCue = { word: string; fromF: number; toF: number };
export type BrollAsset = { src: string; type: "video" | "image" };
export type SfxCue = { src: string; atF: number; vol?: number };
export type AudioTrack = {
  id: "music" | "voice" | "sfx";
  name?: string;
  vol?: number;
  mute?: boolean;
  disabled?: boolean;
  speed?: number;
  pan?: number;
  fadeIn?: number;
  fadeOut?: number;
  splits?: number[];
  locked?: boolean;
};

export type Mix = {
  musicVol?: number;
  voiceVol?: number;
  sfxVol?: number;
  beatIntensity?: number;
  muteMusic?: boolean;
  muteVoice?: boolean;
  muteSfx?: boolean;
  captionStyle?: "pop" | "bounce" | "phrase" | "hormozi" | "glow" | "clean" | "springy";
  tracks?: AudioTrack[];
  subtitles?: {
    enabled?: boolean;
    mode?: "karaoke" | "lines";
    preset?: "pop" | "bounce" | "phrase" | "hormozi" | "glow" | "clean" | "springy";
    position?: "bottom" | "middle" | "top";
    fontScale?: number;
    letterSpacing?: number;
    lineHeight?: number;
    background?: boolean;
    backgroundOpacity?: number;
    highlightColor?: string;
    inactiveOpacity?: number;
    maxWords?: number;
    keywords?: string[];
  };
  duck?: { enabled?: boolean; amount?: number; attack?: number; release?: number };
  // M7: integrated LUFS master target (platform-derived). Optional → masterAudio reads
  // `?? -14`, so a mix without it masters byte-identically to today.
  loudnessTarget?: number;
};
export type CaptionLineStyle = {
  fromF: number;
  toF: number;
  preset?: "pop" | "bounce" | "phrase" | "hormozi" | "glow" | "clean" | "springy";
  position?: "bottom" | "middle" | "top";
  fontScale?: number;
  highlightColor?: string;
};

export type PostProps = {
  storyboard: unknown;
  subtitles?: SubtitleCue[];
  words?: WordCue[];
  // Per-line caption style spans (choreography) — varies the subtitle look across
  // the video. Consumed by the remotion Post's Karaoke `lineStyles`.
  captionLineStyles?: CaptionLineStyle[];
  brolls?: (BrollAsset | null)[];
  beatFrames?: number[];
  sfx?: SfxCue[];
  mix?: Mix;
  musicSrc?: string;
  voiceSrc?: string;
  channelLabel?: string;
  channelLogo?: string;
  channelHandle?: string;
  channelSite?: string;
  channelSocials?: string[];
  mood?: string;
  brandAccent?: string; // brand's signature colour; overrides theme/mood accent
};
