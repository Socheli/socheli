import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync, statSync, readdirSync, renameSync, realpathSync } from "node:fs";
import { join, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { Storyboard, RULES } from "@os/schemas";
import type { AudioTrack, AudioBand, Comp, DeEss, Gate, Denoise, AutoCurve, Mix } from "@os/schemas";
import { musicProfileFor } from "@os/tokens";
import type { SubtitleCue, WordCue, SfxCue } from "./types.ts";

/* Complementary EQ carved into the MUSIC bed (only when voice is present) so the
   2-4 kHz vocal-presence band stays clear and narration cuts through without
   having to duck the whole bed harder. Applied BEFORE the sidechain compressor.
   Shared by duckMusic (shorts) and addMusicBed (long-form) so they never drift. */
export const VOICE_CARVE = "equalizer=f=2600:width_type=q:w=1.5:g=-3,equalizer=f=4000:width_type=q:w=1.6:g=-2.5";

/* Every bed normalizes to this single pre-mix loudness + true-peak so the duck
   sidechain threshold sees a consistent input level across all music tiers. */
const BED_LOUDNORM = "loudnorm=I=-18:TP=-1.5,alimiter=limit=0.84";

/* SFX library lives in ./assets.ts; re-exported here so mix/render code that
   already imports from media.ts can list the available SFX clips. */
export { listSfx } from "./assets.ts";
export type { SfxAsset } from "./assets.ts";

/* ─── DaVinci spine §4.3 (M7) — shared duck-span model ────────────────────────
   The ONLY thing that keeps shorts ducking (Post.tsx, JS per-frame `buildDuckEnvelope`)
   and long-form ducking (this file, ffmpeg sidechain/keyed) identical is computing the
   SAME voiced-region spans from the SAME word cues with the SAME merge gap. This is the
   canonical span model; Post.tsx adopts it in M8 (it currently has a private copy of
   `mergeSpans`/`buildDuckEnvelope` — these are byte-for-byte equivalent so the switch is
   a no-op). Defined + exported here (the engine owns the audio pipeline); the renderer
   imports it. Pure + side-effect-free so both sides get an identical envelope. */

// One voiced region on the timeline, in FRAMES (matches WordCue.fromF/toF + the
// render's frame addressing). Music ducks down across [fromF, toF] (+ attack/release ramps).
export type DuckSpan = { fromF: number; toF: number };

// Merge overlapping/touching voiced spans so two adjacent word cues don't re-trigger
// the duck ramp. IDENTICAL logic to Post.tsx `mergeSpans` (drop empty, sort, coalesce
// within `gapF`). Keep these two in lockstep or shorts + long-form ducking diverge.
export function mergeDuckSpans(spans: DuckSpan[], gapF: number): DuckSpan[] {
  const sorted = [...spans].filter((s) => s.toF > s.fromF).sort((a, b) => a.fromF - b.fromF);
  const out: DuckSpan[] = [];
  for (const s of sorted) {
    const last = out[out.length - 1];
    if (last && s.fromF - last.toF <= gapF) last.toF = Math.max(last.toF, s.toF);
    else out.push({ ...s });
  }
  return out;
}

// The duck parameters both sides read (matches the `Mix.duck` schema shape). `amount`
// 0..1 = how far the music drops while voice plays; attack/release in seconds.
export type DuckSettingsLike = { enabled?: boolean; amount?: number; attack?: number; release?: number };

/* Resolve voiced spans + the merge gap exactly as `buildDuckEnvelope` does:
   word cues when present, else ONE span over the whole voiced region [0,totalF], merged
   with a gap of (attack+release) frames so a sub-ramp-length gap doesn't pop the bed up.
   Returns the merged spans + the resolved attack/release/floor so the ffmpeg side keys
   the SAME envelope the JS side draws. Voiced spans are the single shared definition. */
export function buildDuckSpans(
  words: WordCue[] | undefined,
  duck: DuckSettingsLike,
  fps: number,
  totalF: number,
): { spans: DuckSpan[]; attackF: number; releaseF: number; floor: number; amount: number } {
  const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
  const amount = clamp01(typeof duck.amount === "number" && Number.isFinite(duck.amount) ? duck.amount : 0.6);
  const floor = 1 - amount; // music level while fully under voice
  const attackF = Math.max(1, (typeof duck.attack === "number" ? duck.attack : 0.12) * fps);
  const releaseF = Math.max(1, (typeof duck.release === "number" ? duck.release : 0.35) * fps);
  const spans = mergeDuckSpans(
    words && words.length ? words.map((w) => ({ fromF: w.fromF, toF: w.toF })) : [{ fromF: 0, toF: totalF }],
    attackF + releaseF,
  );
  return { spans, attackF, releaseF, floor, amount };
}

/* ─── DaVinci spine §4.3 (M7) — audio filtergraph builder ──────────────────────
   Compile an AudioTrack's channel-strip chain → an ffmpeg `-af` filter string. The
   node order is the standard restoration→tone→dynamics→level pipeline:

       gate → denoise → eq → deess → comp → gain

   (clean up / silence noise first, remove broadband hiss, shape tone, tame sibilance,
   control dynamics, then set level — applying gain LAST so the comp's makeup isn't
   re-compressed and the EQ isn't gated). Returns the composable filter string AND the
   ordered node names so callers can compose/log the graph. Every value is read straight
   from the (already zod-clamped) schema, so the builder itself can't emit an unsafe
   filter. Returns `{ af: "", nodes: [] }` when the track has NO chain set → callers that
   pass such a track emit EXACTLY their legacy filter (byte-identical, no behaviour change). */

// Round to keep filter strings stable + short (ffmpeg parses these fine).
const r2 = (n: number) => Number(n.toFixed(2));

function eqBandFilter(b: AudioBand): string {
  const q = b.q ?? 1;
  const g = r2(b.gain);
  const f = r2(b.freq);
  switch (b.type) {
    // shelves use ffmpeg's dedicated shelf filters (width as Q)
    case "lowshelf":
      return `bass=frequency=${f}:width_type=q:width=${r2(q)}:gain=${g}`;
    case "highshelf":
      return `treble=frequency=${f}:width_type=q:width=${r2(q)}:gain=${g}`;
    // a hard low/high-pass is a corner, not a gain band
    case "lowpass":
      return `lowpass=f=${f}`;
    case "highpass":
      return `highpass=f=${f}`;
    // notch = a deep, narrow peak cut (equalizer with a large negative gain at high Q)
    case "notch":
      return `equalizer=f=${f}:width_type=q:w=${r2(Math.max(q, 4))}:g=${g < 0 ? g : -12}`;
    case "peak":
    default:
      return `equalizer=f=${f}:width_type=q:w=${r2(q)}:g=${g}`;
  }
}

function compFilter(c: Comp): string {
  // ffmpeg acompressor: threshold in LINEAR amplitude (0..1), so convert the dB schema
  // value (dBFS) to amplitude = 10^(dB/20). attack/release are ms. makeup is a LINEAR
  // multiplier in acompressor (not dB) → 10^(dB/20) as well.
  const thrAmp = r2(Math.pow(10, c.threshold / 20));
  const ratio = r2(c.ratio);
  const attack = r2(c.attack);
  const release = r2(c.release);
  const parts = [`threshold=${thrAmp}`, `ratio=${ratio}`, `attack=${attack}`, `release=${release}`];
  if (typeof c.makeup === "number") parts.push(`makeup=${r2(Math.pow(10, c.makeup / 20))}`);
  return `acompressor=${parts.join(":")}`;
}

function deessFilter(d: DeEss): string {
  // ffmpeg has a native `deesser`; `i` (intensity) 0..1 maps straight from `amount`,
  // `f` (split frequency, 0..1 of Nyquist) from the centre freq over a 22.05 kHz Nyquist.
  const i = r2(Math.max(0, Math.min(1, d.amount)));
  const f = r2(Math.max(0, Math.min(1, d.freq / 22050)));
  return `deesser=i=${i}:f=${f}:m=0.5`;
}

function gateFilter(g: Gate): string {
  // agate threshold is LINEAR amplitude; attack/release ms.
  const thrAmp = r2(Math.pow(10, g.threshold / 20));
  return `agate=threshold=${thrAmp}:attack=${r2(g.attack)}:release=${r2(g.release)}`;
}

function denoiseFilter(d: Denoise): string {
  // afftdn noise reduction in dB, scaled from the 0..1 `amount` (0 → off, 1 → ~24 dB).
  const nr = r2(Math.max(0, Math.min(1, d.amount)) * 24);
  return `afftdn=nr=${nr}:nf=-40`;
}

/* Compile an AutoCurve (keyframed gain, t∈0..1 over the clip) into a time-keyed ffmpeg
   `volume` expression. We evaluate the curve at frame-independent NORMALIZED time using
   `aeval`-style `volume=eval=frame` with a piecewise-linear expression over `t` (= the
   sample timestamp `t` divided by `durSec`). `easing` other than "hold" is approximated
   as linear between points inside ffmpeg (the JS side owns precise easing in-render);
   "hold" steps. Returns "" for a degenerate single-flat-point curve so the chain stays
   byte-identical when automation is effectively a constant 1.0. */
function gainCurveFilter(curve: AutoCurve, durSec: number): string {
  const pts = [...curve.points].sort((a, b) => a.t - b.t);
  if (!pts.length) return "";
  // a single point that's ~unity gain is a no-op
  if (pts.length === 1) return Math.abs(pts[0].v - 1) < 1e-3 ? "" : `volume=${r2(pts[0].v)}`;
  const dur = Math.max(0.001, durSec);
  // build a nested if() ladder over normalized time tn = t/dur, lerping v between points.
  // hold = step to the left point's value; otherwise linear interp.
  const tn = `(t/${r2(dur)})`;
  let expr = `${r2(pts[pts.length - 1].v)}`; // value past the last point
  for (let i = pts.length - 1; i > 0; i--) {
    const a = pts[i - 1];
    const b = pts[i];
    const seg =
      curve.easing === "hold"
        ? `${r2(a.v)}`
        : // linear: a.v + (b.v-a.v) * (tn-a.t)/(b.t-a.t)
          `(${r2(a.v)}+(${r2(b.v - a.v)})*(${tn}-${r2(a.t)})/${r2(Math.max(1e-4, b.t - a.t))})`;
    expr = `if(lt(${tn}\\,${r2(b.t)})\\,${seg}\\,${expr})`;
  }
  // before the first point, hold the first value
  expr = `if(lt(${tn}\\,${r2(pts[0].t)})\\,${r2(pts[0].v)}\\,${expr})`;
  return `volume=eval=frame:volume='${expr}'`;
}

/* Compile a pan AutoCurve into a time-keyed stereo `pan`. ffmpeg `pan` can't take a
   per-frame expression, so a moving pan is realized as a keyed `aeval` cross-mix: each
   output channel is the mono sum weighted by the (time-varying) pan position. For a
   STATIC pan (single point) we emit the cheap `pan=stereo` constant form. p∈[-1,1],
   -1 = full left. */
function panCurveFilter(curve: AutoCurve, durSec: number): string {
  const pts = [...curve.points].sort((a, b) => a.t - b.t);
  if (!pts.length) return "";
  if (pts.length === 1) {
    const p = Math.max(-1, Math.min(1, pts[0].v));
    if (Math.abs(p) < 1e-3) return ""; // centred → no-op
    const l = r2((1 - p) / 2 + 0.5 * (p < 0 ? -p : 0)); // simple equal-power-ish constant
    const rr = r2((1 + p) / 2 + 0.5 * (p > 0 ? p : 0));
    return `pan=stereo|c0=${l}*c0|c1=${rr}*c1`;
  }
  const dur = Math.max(0.001, durSec);
  const tn = `(t/${r2(dur)})`;
  // piecewise-linear pan position p(tn) ∈ [-1,1]
  let pexpr = `${r2(pts[pts.length - 1].v)}`;
  for (let i = pts.length - 1; i > 0; i--) {
    const a = pts[i - 1];
    const b = pts[i];
    const seg =
      curve.easing === "hold"
        ? `${r2(a.v)}`
        : `(${r2(a.v)}+(${r2(b.v - a.v)})*(${tn}-${r2(a.t)})/${r2(Math.max(1e-4, b.t - a.t))})`;
    pexpr = `if(lt(${tn}\\,${r2(b.t)})\\,${seg}\\,${pexpr})`;
  }
  pexpr = `if(lt(${tn}\\,${r2(pts[0].t)})\\,${r2(pts[0].v)}\\,${pexpr})`;
  // left gain = (1-p)/2 mapped to [0,1], right = (1+p)/2; aeval drives both channels.
  const lg = `((1-(${pexpr}))/2)`;
  const rg = `((1+(${pexpr}))/2)`;
  return `aeval=val(0)*${lg}|val(1)*${rg}:channel_layout=stereo`;
}

/* The public builder. Compiles a track's chain in the fixed node order and returns the
   composable `-af` string + the ordered node list. `durSec` scopes time-keyed automation
   (gain/pan curves); pass the track/clip's duration. When the track sets NO chain fields
   the result is `{ af: "", nodes: [] }` — callers MUST treat an empty `af` as "emit the
   legacy filter unchanged" so existing renders stay byte-identical. */
export function buildAudioFiltergraph(
  spec: AudioTrack | undefined,
  opts: { durSec?: number } = {},
): { af: string; nodes: string[] } {
  if (!spec) return { af: "", nodes: [] };
  const durSec = opts.durSec ?? 1;
  const stages: { node: string; filter: string }[] = [];

  // 1) gate — silence below threshold first (before anything amplifies noise)
  if (spec.gate) stages.push({ node: "gate", filter: gateFilter(spec.gate) });
  // 2) denoise — remove broadband hiss before tonal shaping
  if (spec.denoise && spec.denoise.amount > 0) stages.push({ node: "denoise", filter: denoiseFilter(spec.denoise) });
  // 3) eq — parametric bands in series (already in series order)
  if (spec.eq && spec.eq.length) for (const b of spec.eq) stages.push({ node: "eq", filter: eqBandFilter(b) });
  // 4) deess — tame sibilance after EQ (so an EQ presence boost doesn't reintroduce ess)
  if (spec.deess && spec.deess.amount > 0) stages.push({ node: "deess", filter: deessFilter(spec.deess) });
  // 5) comp — dynamics control + makeup
  if (spec.comp) stages.push({ node: "comp", filter: compFilter(spec.comp) });
  // 6) gain — level LAST (keyed automation, or a static multiplier from `vol`)
  if (spec.gain) {
    const g = gainCurveFilter(spec.gain, durSec);
    if (g) stages.push({ node: "gain", filter: g });
  }
  // 6b) pan automation (kept inside the gain/level stage group, applied after gain)
  if (spec.panAuto) {
    const p = panCurveFilter(spec.panAuto, durSec);
    if (p) stages.push({ node: "pan", filter: p });
  }

  return { af: stages.map((s) => s.filter).join(","), nodes: stages.map((s) => s.node) };
}

const HERE = dirname(fileURLToPath(import.meta.url));
const REMOTION_PUBLIC = join(HERE, "..", "..", "remotion", "public");
const SCRIPTS = join(HERE, "..", "scripts");
const VENV_PY = join(HERE, "..", "..", "..", ".venv-music", "bin", "python");
const ensure = () => mkdirSync(REMOTION_PUBLIC, { recursive: true });
const TR = RULES.transitionFrames;

const wrap = (s: string, max = 34): string[] => {
  const words = s.split(/\s+/);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    if ((cur + " " + w).trim().length > max && cur) {
      lines.push(cur.trim());
      cur = w;
    } else cur = (cur + " " + w).trim();
  }
  if (cur) lines.push(cur.trim());
  return lines.slice(0, 2);
};

function probeDuration(file: string): number {
  const r = spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file], { encoding: "utf8" });
  return parseFloat((r.stdout || "0").trim()) || 0;
}

const norm = (src: string, dst: string) =>
  spawnSync("ffmpeg", ["-y", "-i", src, "-ar", "44100", "-ac", "2", dst], { encoding: "utf8" });

/* ─── Narration normalization for TTS ──────────────────────────────────────
   Run on each spoken line BEFORE synthesis so the engine reads numbers and
   acronyms correctly. Deterministic and tiny: per-channel pronunciations first,
   then currency and percent to spoken form. The ORIGINAL line is kept for the
   subtitle fallback; whisper re-transcribes the audio for karaoke either way. */
export type ElevenSettings = { stability: number; similarity_boost: number; style: number; use_speaker_boost: boolean };
export type VoiceConfig = { eleven?: ElevenSettings; sayAs?: Record<string, string> };

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function normalizeForTTS(line: string, sayAs?: Record<string, string>): string {
  let s = line;
  // explicit per-channel pronunciations (whole-word, case-insensitive)
  if (sayAs) {
    for (const [k, v] of Object.entries(sayAs)) {
      s = s.replace(new RegExp(`\\b${escapeRe(k)}\\b`, "gi"), v);
    }
  }
  // $1,200 / $20 billion → "1,200 dollars" / "20 billion dollars"
  s = s.replace(/\$\s?([\d][\d,.]*)(?:\s+(trillion|billion|million|thousand))?/gi, (_m, n, scale) => `${n}${scale ? " " + scale : ""} dollars`);
  // 20% → "20 percent"
  s = s.replace(/([\d][\d,.]*)\s?%/g, "$1 percent");
  return s;
}

/* Strip ElevenLabs v3 audio tags (e.g. [whispers], [excited], [gunshot]) from a
   line. v3 reads bracketed tags as DELIVERY/SFX instructions in the spoken audio
   — they must never reach the on-screen subtitle copy. Spoken text keeps the
   tags; display text runs through this. Bounded length so a stray "[" never eats
   a whole sentence. */
export function stripAudioTags(line: string): string {
  return line
    .replace(/\[[^\]\n]{1,40}\]/g, "")
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([.,!?;:])/g, "$1")
    .trim();
}

/* ─── TTS providers (return per-line wav files, in order) ─────────────────── */
function kokoroLines(id: string, lines: string[], voice: string, speed: number): string[] | null {
  ensure();
  const linesFile = join(REMOTION_PUBLIC, `${id}_klines.json`);
  writeFileSync(linesFile, JSON.stringify(lines));
  const r = spawnSync("node", [join(SCRIPTS, "kokoro-tts.mjs"), REMOTION_PUBLIC, id, voice, linesFile, String(speed)], {
    encoding: "utf8",
    timeout: 1000 * 60 * 8,
  });
  rmSync(linesFile, { force: true });
  const manifest = join(REMOTION_PUBLIC, `${id}_kokoro.json`);
  if (r.status !== 0 || !existsSync(manifest)) return null;
  const parsed = JSON.parse(readFileSync(manifest, "utf8")) as { lines: { file: string }[] };
  rmSync(manifest, { force: true });
  return parsed.lines.map((l) => l.file);
}

/* Ensure the SOCKS5 egress tunnel is up — ElevenLabs is geo-blocked in some regions,
   so requests route through it. Set ELEVEN_SSH_HOST to your jump host (an ssh config
   alias or user@host). Self-heals if the tunnel dropped. No-op unless both
   ELEVEN_PROXY and ELEVEN_SSH_HOST are set. */
function ensureTunnel(): void {
  const proxy = process.env.ELEVEN_PROXY || "";
  const sshHost = process.env.ELEVEN_SSH_HOST || "";
  const m = /127\.0\.0\.1:(\d+)/.exec(proxy);
  if (!m || !sshHost) return;
  const port = m[1];
  const open = spawnSync("nc", ["-z", "-G1", "127.0.0.1", port], { timeout: 4000 }).status === 0;
  if (open) return;
  spawnSync("ssh", ["-fN", "-D", port, "-o", "StrictHostKeyChecking=accept-new", "-o", "ConnectTimeout=15", sshHost], { timeout: 30000 });
}

/* ElevenLabs — premium prosody (stress/rhythm). Per-line via curl (keeps the
   sync design). Lower stability = more expressive delivery. Returns mp3 files. */
const DEFAULT_ELEVEN: ElevenSettings = { stability: 0.4, similarity_boost: 0.85, style: 0.4, use_speaker_boost: true };

function elevenLines(id: string, lines: string[], voiceId: string, settings?: ElevenSettings): string[] | null {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) return null;
  ensureTunnel();
  const model = process.env.ELEVEN_MODEL || "eleven_multilingual_v2";
  const voiceSettings = settings ?? DEFAULT_ELEVEN;
  ensure();
  const proxy = process.env.ELEVEN_PROXY || process.env.HTTPS_PROXY || process.env.ALL_PROXY;
  const proxyArgs = proxy ? ["-x", proxy] : [];
  const files: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim()) continue; // empty line → nothing to synth (don't burn a retry)
    const bodyFile = join(REMOTION_PUBLIC, `${id}_eb${i}.json`);
    writeFileSync(bodyFile, JSON.stringify({ text: lines[i], model_id: model, voice_settings: voiceSettings }));
    const out = join(REMOTION_PUBLIC, `${id}_e${i}.mp3`);
    // Bounded per-line retry — one flaky line (or a dropped SOCKS tunnel) no
    // longer abandons the WHOLE batch to the Kokoro fallback. Re-heal the tunnel
    // only before a retry, fixed short backoff.
    let ok = false;
    for (let attempt = 0; attempt < 2 && !ok; attempt++) {
      if (attempt > 0) {
        ensureTunnel();
        spawnSync("sleep", ["1.5"]);
      }
      const r = spawnSync(
        "curl",
        ["-s", ...proxyArgs, "-X", "POST", `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`,
          "-H", `xi-api-key: ${key}`, "-H", "Content-Type: application/json", "-d", `@${bodyFile}`, "-o", out],
        { encoding: "utf8", timeout: 90000 },
      );
      // an API error returns a small JSON blob, not audio → retry, then fail over
      ok = r.status === 0 && existsSync(out) && statSync(out).size >= 2000;
    }
    rmSync(bodyFile, { force: true });
    if (!ok) return null;
    files.push(out);
  }
  return files.length === lines.filter((l) => l.trim()).length ? files : null;
}

function sayLines(id: string, lines: string[], voice = "Samantha"): string[] | null {
  if (!existsSync("/usr/bin/say")) return null;
  ensure();
  const files: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const aiff = join(REMOTION_PUBLIC, `${id}_s${i}.aiff`);
    const wav = join(REMOTION_PUBLIC, `${id}_s${i}.wav`);
    if (spawnSync("say", ["-v", voice, "-r", "182", "-o", aiff, lines[i]], { encoding: "utf8" }).status !== 0) continue;
    spawnSync("ffmpeg", ["-y", "-i", aiff, "-ar", "44100", "-ac", "2", wav], { encoding: "utf8" });
    rmSync(aiff, { force: true });
    files.push(wav);
  }
  return files.length === lines.length ? files : null;
}

/* ─── Word-level timestamps via cached MLX Whisper turbo ──────────────────── */
type WhisperOut = { words: { word: string; start: number; end: number }[]; error?: string };
function whisperWords(audioAbs: string): WhisperOut {
  if (!existsSync(VENV_PY)) {
    const error = `Whisper venv python missing (${VENV_PY})`;
    console.error(`[whisper] ${error}`);
    return { words: [], error };
  }
  const r = spawnSync(VENV_PY, [join(SCRIPTS, "whisper-words.py"), audioAbs], { encoding: "utf8", timeout: 1000 * 60 * 5 });
  if (r.status !== 0) {
    const tail = r.stderr ? String(r.stderr).trim().split("\n").slice(-3).join(" ").slice(-500) : "";
    const error = `Whisper exited status=${r.status}${r.signal ? ` signal=${r.signal}` : ""}${r.error ? ` (${r.error.message})` : ""}${tail ? ` — ${tail}` : ""}`;
    console.error(`[whisper] ${error}`);
    return { words: [], error };
  }
  try {
    return { words: (JSON.parse(r.stdout) as { words: { word: string; start: number; end: number }[] }).words };
  } catch (e) {
    const error = `Whisper returned unparseable output: ${(e as Error).message}`;
    console.error(`[whisper] ${error} :: ${String(r.stdout).slice(0, 200)}`);
    return { words: [], error };
  }
}

export type SceneSyncedVoice = {
  src: string;
  words: WordCue[];
  subtitles: SubtitleCue[];
  durations: number[];
  totalSec: number;
  engine: string;
  // Set when word-level karaoke timing was expected but Whisper failed, so the
  // render fell back to phrase-level subtitles. Carries the underlying error.
  captionError?: string;
};

/* Scene-by-scene synced voiceover:
   - synth each scene's `say` line, fit that scene's duration to it
   - place each line at its scene's VISUAL start (accounts for transition overlap)
     so audio lines up with what's on screen — no drift
   - run whisper on the assembled track for word-level karaoke caption timing */
export function synthVoiceSceneSynced(
  id: string,
  scenes: { say?: string; durationSec: number }[],
  fps: number,
  voice: string,
  speed: number,
  elevenVoice?: string,
  vcfg?: VoiceConfig,
): SceneSyncedVoice | null {
  ensure();
  const idxs = scenes.map((s, i) => (s.say?.trim() ? i : -1)).filter((i) => i >= 0);
  if (!idxs.length) return null;
  // NORMALIZED lines drive synthesis (numbers/currency/acronyms spoken correctly,
  // and any ElevenLabs v3 [audio tags] preserved for delivery/SFX). STRIPPED lines
  // drive the subtitle fallback so tags never render on-screen. Whisper re-
  // transcribes audio for karaoke, so primary captions track what was actually said.
  const rawSay = idxs.map((i) => scenes[i].say!.trim());
  const lines = rawSay.map((l) => normalizeForTTS(l, vcfg?.sayAs));
  const displayLines = rawSay.map((l) => stripAudioTags(l));

  // Provider chain: ElevenLabs (premium prosody) → Kokoro (local) → macOS say.
  let provider = "say";
  let raw: string[] | null = null;
  if (elevenVoice) {
    raw = elevenLines(id, lines, elevenVoice, vcfg?.eleven);
    if (raw) provider = "elevenlabs";
  }
  if (!raw) {
    raw = kokoroLines(id, lines, voice, speed);
    if (raw) provider = "kokoro";
  }
  if (!raw) {
    raw = sayLines(id, lines);
    if (raw) provider = "say";
  }
  if (!raw) return null;

  // normalize + measure each spoken line
  const spoken: number[] = [];
  const normed: string[] = [];
  for (let k = 0; k < raw.length; k++) {
    const n = join(REMOTION_PUBLIC, `${id}_nl${k}.wav`);
    norm(raw[k], n);
    normed.push(n);
    spoken.push(probeDuration(n));
  }

  // per-scene duration fitted to its line (+breath)
  const PAD = 0.55;
  const durations = scenes.map((s, i) => {
    const k = idxs.indexOf(i);
    return k >= 0 ? Math.max(RULES.minSceneDuration, Number((spoken[k] + PAD).toFixed(2))) : s.durationSec;
  });

  // visual scene start times (seconds), accounting for transition overlap
  const startSec: number[] = [];
  let cur = 0;
  for (let i = 0; i < durations.length; i++) {
    startSec.push(cur);
    cur += durations[i] - TR / fps;
  }
  const totalSec = startSec[durations.length - 1] + durations[durations.length - 1];

  // place each line at its scene's visual start (adelay) and mix
  const inputs: string[] = [];
  const filters: string[] = [];
  normed.forEach((f, k) => {
    const sceneIdx = idxs[k];
    const delayMs = Math.round(startSec[sceneIdx] * 1000);
    inputs.push("-i", f);
    filters.push(`[${k}]adelay=${delayMs}|${delayMs}[a${k}]`);
  });
  const mixIn = normed.map((_, k) => `[a${k}]`).join("");
  const out = `${id}_voice.mp3`;
  // no dynamic loudnorm here — it boosts the lead silence then ducks as the voice
  // onsets ("blurp"). Lines are already level-matched; a gentle limiter is enough.
  const filter = `${filters.join(";")};${mixIn}amix=inputs=${normed.length}:normalize=0,alimiter=limit=0.95,afade=t=in:st=0:d=0.08,apad`;
  const rc = spawnSync(
    "ffmpeg",
    ["-y", ...inputs, "-filter_complex", filter, "-t", totalSec.toFixed(2), "-c:a", "libmp3lame", "-q:a", "3", join(REMOTION_PUBLIC, out)],
    { encoding: "utf8" },
  );
  // subtitle fallback cues (one per scene, scene-timed) in case words are empty
  const subtitles: SubtitleCue[] = idxs.map((i, k) => ({
    fromF: Math.round(startSec[i] * fps),
    toF: Math.round((startSec[i] + spoken[k]) * fps),
    lines: wrap(displayLines[k]),
  }));

  if (rc.status !== 0) {
    [...normed, ...raw].forEach((p) => rmSync(p, { force: true }));
    return null;
  }

  // word-level karaoke timing from the assembled (visual-timed) track
  const wout = whisperWords(join(REMOTION_PUBLIC, out));
  const words: WordCue[] = wout.words.map((w) => ({
    word: w.word,
    fromF: Math.round(w.start * fps),
    toF: Math.round(w.end * fps),
  }));

  [...normed, ...raw].forEach((p) => rmSync(p, { force: true }));
  // No words despite having speech = Whisper degraded; surface the reason so the
  // caller can record a warning instead of silently shipping phrase captions.
  const captionError = words.length ? undefined : (wout.error ?? "Whisper produced no word timings");
  return { src: out, words, subtitles, durations, totalSec, engine: `${provider}${words.length ? "+whisper" : ""}`, captionError };
}

/* ─── Music ──────────────────────────────────────────────────────────────── */
/* Curated music: drop royalty-free loops in assets/music/<theme>/ and one is
   picked at random per render, looped/crossfaded to length. Preferred over the
   procedural bed when files exist. */
const ASSETS_MUSIC = join(HERE, "..", "..", "..", "assets", "music");
const AUDIO_EXT = [".mp3", ".wav", ".m4a", ".flac", ".ogg", ".aac"];

export function curatedBed(id: string, durationSec: number, theme = "lab"): string | null {
  if (spawnSync("which", ["ffmpeg"]).status !== 0) return null;
  const dir = join(ASSETS_MUSIC, theme);
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir).filter((f) => AUDIO_EXT.includes(extname(f).toLowerCase()));
  if (!files.length) return null;
  ensure();
  const pick = join(dir, files[Math.floor(Math.random() * files.length)]);
  const out = `${id}_music.wav`;
  const D = Math.max(6, Math.ceil(durationSec) + 1);
  const fadeOut = (D - 3).toFixed(2);
  // -stream_loop tiles the source past D; we then trim, fade, and master.
  const af = `acompressor=threshold=-20dB:ratio=2.5:attack=80:release=600,afade=t=in:st=0:d=1.5,afade=t=out:st=${fadeOut}:d=3,${BED_LOUDNORM},aformat=channel_layouts=stereo`;
  const r = spawnSync("ffmpeg", ["-y", "-stream_loop", "-1", "-i", pick, "-t", String(D), "-af", af, join(REMOTION_PUBLIC, out)], { encoding: "utf8" });
  return r.status === 0 && existsSync(join(REMOTION_PUBLIC, out)) ? out : null;
}

/* Absolute last-resort bed: the simplest filter graph that can't realistically
   fail (two soft sines + fades). Only used if the richer pad ever errors — so a
   render is NEVER shipped silent as long as ffmpeg exists. */
function safetyBed(id: string, durationSec: number, theme = "lab", moodId?: string): string | null {
  ensure();
  const D = Math.max(6, Math.ceil(durationSec) + 1);
  const out = `${id}_music.wav`;
  // mood tonal centre (one octave below the pad), else theme fallback
  const root = moodId ? musicProfileFor(moodId).root / 2 : theme === "builder" ? 65.41 : theme === "concept" ? 73.42 : 55;
  const lp = moodId ? musicProfileFor(moodId).lowpass * 0.82 : 1800;
  const fadeOut = (D - 3).toFixed(2);
  const filter =
    `[0]volume=0.22[a];[1]volume=0.10[b];[a][b]amix=inputs=2:normalize=0,` +
    `lowpass=f=${Math.round(lp)},afade=t=in:st=0:d=2,afade=t=out:st=${fadeOut}:d=3,${BED_LOUDNORM},aformat=channel_layouts=stereo`;
  const r = spawnSync("ffmpeg", ["-y",
    "-f", "lavfi", "-i", `sine=frequency=${root.toFixed(2)}:sample_rate=44100:duration=${D}`,
    "-f", "lavfi", "-i", `sine=frequency=${(root * 2).toFixed(2)}:sample_rate=44100:duration=${D}`,
    "-filter_complex", filter, "-t", String(D), join(REMOTION_PUBLIC, out)], { encoding: "utf8" });
  return r.status === 0 && existsSync(join(REMOTION_PUBLIC, out)) ? out : null;
}

/* ─── Pluggable music provider ────────────────────────────────────────────── */
/* The music bed comes from one of two real backends — a hosted API (default
   ElevenLabs Music, reusing ELEVENLABS_API_KEY) or local MusicGen — selected by
   MUSIC_PROVIDER (auto|api|musicgen|none). Both are best-effort: on ANY failure
   ensureMusic falls back to curated loops, then the synthesized ambient bed, so
   a render is NEVER shipped silent (unless MUSIC_PROVIDER=none). */

export type MusicProvider = "auto" | "api" | "musicgen" | "none";

/* Resolve the HF cache home: the repo's data/hf-cache symlink target if it
   resolves, else SOCHELI_EXT_VOLUME/Socheli/hf-cache, else the repo path itself.
   musicgen.py reads HF_HOME/HF_HUB_CACHE from here, so the big cached model on
   the external drive is reused and nothing downloads into ~/.cache by accident. */
const HF_CACHE_LINK = join(HERE, "..", "..", "..", "data", "hf-cache");
export function resolveHfCache(): string {
  try {
    if (existsSync(HF_CACHE_LINK)) return realpathSync(HF_CACHE_LINK);
  } catch {
    /* dangling symlink (external drive unmounted) → fall through */
  }
  const ext = process.env.SOCHELI_EXT_VOLUME;
  if (ext) return join(ext, "Socheli", "hf-cache");
  return HF_CACHE_LINK;
}

/* The HF hub dir under a cache home (transformers looks here for snapshots). */
function hfHubDir(cacheHome: string): string {
  return join(cacheHome, "hub");
}

/* MUSICGEN_MODEL → "small"|"medium"|"large"|"melody" (for the cache dir name).
   Default model is facebook/musicgen-medium (bigger than small per the spec). */
export const DEFAULT_MUSICGEN_MODEL = "facebook/musicgen-medium";
export function musicgenModelId(): string {
  return process.env.MUSICGEN_MODEL || DEFAULT_MUSICGEN_MODEL;
}

/* Is the selected MusicGen model already on disk? We NEVER download in the render
   path (that's what froze the terminal) — warm-musicgen.sh does that once. */
export function musicgenModelCached(model = musicgenModelId(), cacheHome = resolveHfCache()): boolean {
  const slug = `models--${model.replace(/\//g, "--")}`;
  const dir = join(hfHubDir(cacheHome), slug, "snapshots");
  try {
    if (!existsSync(dir)) return false;
    // a populated snapshot dir means the weights landed
    return readdirSync(dir).some((s) => {
      const snap = join(dir, s);
      try {
        return statSync(snap).isDirectory() && readdirSync(snap).length > 0;
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}

/* Serialize MusicGen: a single lockfile so two concurrent renders never both
   load the model (the OOM/freeze cause). Live-pid lock → caller skips to the next
   provider (no queueing/blocking). Stale lock (dead pid or >20min) is reclaimed. */
const MUSICGEN_LOCK = join(HERE, "..", "..", "..", "data", ".musicgen.lock");
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM"; // exists but not ours
  }
}
function acquireMusicgenLock(): boolean {
  try {
    if (existsSync(MUSICGEN_LOCK)) {
      const raw = JSON.parse(readFileSync(MUSICGEN_LOCK, "utf8")) as { pid?: number; at?: number };
      const ageMin = (Date.now() - (raw.at ?? 0)) / 60000;
      const live = typeof raw.pid === "number" && raw.pid !== process.pid && pidAlive(raw.pid);
      if (live && ageMin < 20) return false; // held by a live render — skip
      // stale (dead pid or >20min) → reclaim
    }
    mkdirSync(dirname(MUSICGEN_LOCK), { recursive: true });
    writeFileSync(MUSICGEN_LOCK, JSON.stringify({ pid: process.pid, at: Date.now() }));
    return true;
  } catch {
    return false;
  }
}
function releaseMusicgenLock(): void {
  try {
    if (existsSync(MUSICGEN_LOCK)) {
      const raw = JSON.parse(readFileSync(MUSICGEN_LOCK, "utf8")) as { pid?: number };
      if (raw.pid === process.pid) rmSync(MUSICGEN_LOCK, { force: true });
    }
  } catch {
    /* ignore */
  }
}

/* Decide which real backend to attempt, given MUSIC_PROVIDER and what's actually
   available (API key present? local model cached?). Pure + side-effect-free so it
   can be unit-tested cheaply.
     none     → no bed at all
     api      → API only
     musicgen → local only (still requires the model be cached)
     auto     → API if its key is present, else local musicgen if cached, else none
   Returns the backend to try; "none" means skip straight to curated/ambient. */
export function resolveMusicProvider(
  pref: MusicProvider = (process.env.MUSIC_PROVIDER as MusicProvider) || "auto",
  env: { apiKeyPresent: boolean; modelCached: boolean } = {
    apiKeyPresent: !!(process.env.MUSIC_API_KEY || process.env.ELEVENLABS_API_KEY),
    modelCached: musicgenModelCached(),
  },
): "api" | "musicgen" | "none" {
  if (pref === "none") return "none";
  if (pref === "api") return "api";
  if (pref === "musicgen") return env.modelCached ? "musicgen" : "none";
  // auto
  if (env.apiKeyPresent) return "api";
  if (env.modelCached) return "musicgen";
  return "none";
}

/* The single source of truth for music. Tries the selected real provider, then
   curated loops, then the synthesized ambient bed — GUARANTEED to return a track
   whenever ffmpeg is present, UNLESS MUSIC_PROVIDER=none. Returns null only when
   ffmpeg is missing or the provider is explicitly "none".
   Order (auto): API|MusicGen → curated loop → ambient pad → safety bed.
   noFallbackPad no longer means "ship silent": the ambient bed needs NO model and
   NO network, so it's an acceptable last resort. It is suppressed only when
   MUSIC_PROVIDER=none (caller wants NO bed). */
export function ensureMusic(
  id: string,
  durationSec: number,
  theme: string,
  prompt: string,
  opts: { musicgen?: boolean; moodId?: string; noFallbackPad?: boolean } = {},
): { src: string; source: string } | null {
  if (spawnSync("which", ["ffmpeg"]).status !== 0) return null;
  // Reject a tier whose audio is effectively SILENT.
  const audible = (src: string | null): boolean => {
    if (!src) return false;
    const pk = audioPeaks(join(REMOTION_PUBLIC, src), 64);
    if (!pk) return true;
    return Math.max(...pk.peaks) >= 0.02;
  };

  const pref = (process.env.MUSIC_PROVIDER as MusicProvider) || "auto";
  // musicgen:false is the rerender `--procedural` flag — skip ALL external/real
  // generation (API + local model) and go straight to curated → synthesized bed.
  const apiKeyPresent = !!(process.env.MUSIC_API_KEY || process.env.ELEVENLABS_API_KEY);
  const backend = opts.musicgen === false ? "none" : resolveMusicProvider(pref, { apiKeyPresent, modelCached: musicgenModelCached() });

  if (backend === "api") {
    const api = synthMusicApi(id, prompt, durationSec);
    if (audible(api)) return { src: api!, source: "music-api" };
  } else if (backend === "musicgen") {
    const gen = synthMusicGen(id, prompt, durationSec);
    if (audible(gen)) return { src: gen!, source: "musicgen" };
  }

  const cur = curatedBed(id, durationSec, theme);
  if (audible(cur)) return { src: cur!, source: "curated" };

  // MUSIC_PROVIDER=none means the caller wants NO bed — honour that and stop.
  // Otherwise fall to the synthesized ambient bed (no model, no network) so we
  // NEVER ship a silent video. noFallbackPad is no longer a silence switch.
  if (pref === "none") return null;
  const bed = synthMusicBed(id, durationSec, theme, opts.moodId);
  if (audible(bed)) return { src: bed!, source: "procedural bed" };
  const safe = safetyBed(id, durationSec, theme, opts.moodId);
  if (safe) return { src: safe, source: "safety bed" };
  return null;
}

/* Procedural fallback bed — a warm MAJOR-CHORD pad built from pure sine tones
   (root, major third, fifth, octave + a soft sub). Tonal and musical: NO noise,
   so no "wind"; major key keeps it pleasant, not droney or eerie. */
export function synthMusicBed(id: string, durationSec: number, theme = "lab", moodId?: string): string | null {
  if (spawnSync("which", ["ffmpeg"]).status !== 0) return null;
  ensure();
  const D = Math.max(6, Math.ceil(durationSec) + 1);
  const out = `${id}_music.wav`;
  // Mood sets the tonal centre, movement, and brightness; theme is the fallback.
  // Voicing stays a consonant MAJOR chord (root, maj3, fifth, octave + sub) for
  // every mood — only root/tremolo/lowpass change, so none of them turn eerie.
  const prof = moodId ? musicProfileFor(moodId) : null;
  const root = prof?.root ?? (theme === "builder" ? 98 : theme === "concept" ? 110 : 130.81); // G2 / A2 / C3
  const tremHz = Math.max(0.1, prof?.tremHz ?? 0.1); // ffmpeg tremolo min freq is 0.1
  const lowpass = prof?.lowpass ?? 2200;
  const tones = [root / 2, root, root * 1.25, root * 1.5, root * 2]; // sub, root, maj3, fifth, octave
  const vols = [0.22, 0.24, 0.15, 0.17, 0.12];
  const fadeOut = (D - 3).toFixed(2);
  const inputs = tones.flatMap((f) => ["-f", "lavfi", "-i", `sine=frequency=${f.toFixed(2)}:sample_rate=44100:duration=${D}`]);
  const legs = tones.map((_, i) => `[${i}]volume=${vols[i]}[s${i}]`).join(";");
  const mixIn = tones.map((_, i) => `[s${i}]`).join("");
  const filter =
    `${legs};${mixIn}amix=inputs=${tones.length}:normalize=0,` +
    // gentle movement + a little space, kept warm
    `tremolo=f=${tremHz.toFixed(2)}:d=0.22,aecho=0.8:0.85:600|900:0.28|0.18,highpass=f=45,lowpass=f=${Math.round(lowpass)},` +
    `acompressor=threshold=-18dB:ratio=2.5:attack=80:release=500,` +
    `afade=t=in:st=0:d=2.5,afade=t=out:st=${fadeOut}:d=3,${BED_LOUDNORM},aformat=channel_layouts=stereo`;
  const r = spawnSync("ffmpeg", ["-y", ...inputs, "-filter_complex", filter, "-t", String(D), join(REMOTION_PUBLIC, out)], { encoding: "utf8" });
  return r.status === 0 && existsSync(join(REMOTION_PUBLIC, out)) ? out : null;
}

/* Hosted music-generation API (default ElevenLabs Music — reuses ELEVENLABS_API_KEY
   and the same SOCKS egress as the TTS path). Cheap, remote, no local RAM/model.
   POST https://api.elevenlabs.io/v1/music with {prompt, music_length_ms, model_id};
   the native endpoint returns RAW audio bytes (mp3), so we transcode to wav and
   master it like the other beds. Never throws, never blocks > ~90s; null on any
   failure so ensureMusic falls through to curated/ambient.
   Set MUSIC_API_KEY to override the key, MUSIC_API_MODEL for the model id. */
export function synthMusicApi(id: string, prompt: string, durationSec: number): string | null {
  if (process.env.NO_MUSIC_API) return null;
  const key = process.env.MUSIC_API_KEY || process.env.ELEVENLABS_API_KEY;
  if (!key) return null;
  if (spawnSync("which", ["ffmpeg"]).status !== 0) return null;
  ensure();
  const model = process.env.MUSIC_API_MODEL || "music_v1";
  // ElevenLabs music_length_ms must be 3000-600000; ask for a 15s loop we tile,
  // same as MusicGen (a full-length gen is slower/pricier with no benefit).
  const loopSec = 15;
  const lenMs = Math.min(600000, Math.max(3000, Math.round(loopSec * 1000)));
  const args = buildMusicApiCurl(prompt, lenMs, model, key);
  const mp3 = join(REMOTION_PUBLIC, `${id}_mgloop.mp3`);
  const proxy = process.env.ELEVEN_PROXY || process.env.HTTPS_PROXY || process.env.ALL_PROXY;
  const proxyArgs = proxy ? ["-x", proxy] : [];
  ensureTunnel();
  const r = spawnSync("curl", ["-s", ...proxyArgs, ...args, "-o", mp3], { encoding: "utf8", timeout: 90000 });
  // an API error returns a small JSON blob, not audio
  if (r.status !== 0 || !existsSync(mp3) || statSync(mp3).size < 4000) {
    console.error(`[music-api] failed status=${r.status} signal=${r.signal ?? ""} size=${existsSync(mp3) ? statSync(mp3).size : 0}`);
    rmSync(mp3, { force: true });
    return null;
  }
  // transcode the returned mp3 loop to a wav, then tile/master it to length
  const loop = join(REMOTION_PUBLIC, `${id}_mgloop.wav`);
  const tc = spawnSync("ffmpeg", ["-y", "-i", mp3, "-ar", "44100", "-ac", "2", loop], { encoding: "utf8" });
  rmSync(mp3, { force: true });
  if (tc.status !== 0 || !existsSync(loop)) {
    rmSync(loop, { force: true });
    return null;
  }
  return tileMusicLoop(id, loop, durationSec, loopSec);
}

/* Build the curl arg list for the music API (key NOT logged by callers — they
   redact it). Split out so a unit test can assert request shape without a call. */
export function buildMusicApiCurl(prompt: string, lengthMs: number, model: string, key: string): string[] {
  const body = JSON.stringify({ prompt, music_length_ms: lengthMs, model_id: model });
  return [
    "-X", "POST", `https://api.elevenlabs.io/v1/music?output_format=mp3_44100_128`,
    "-H", `xi-api-key: ${key}`,
    "-H", "Content-Type: application/json",
    "-d", body,
  ];
}

/* MusicGen (related, real music). Generates a short loop and tiles it to length
   (full-length gen is too slow). Auto-uses .venv-music if present.
   SAFE: never downloads in the render path — preflights that the model is already
   cached (warm-musicgen.sh populates it once), serializes via a lockfile so two
   renders never both load the model, and points HF cache at data/hf-cache. */
export function synthMusicGen(id: string, prompt: string, durationSec: number): string | null {
  if (process.env.NO_MUSICGEN) return null;
  const py = process.env.MUSICGEN_PYTHON || (existsSync(VENV_PY) ? VENV_PY : null);
  if (!py) return null;

  const model = musicgenModelId();
  const hfCache = resolveHfCache();
  // PREFLIGHT (the freeze fix): if the model isn't cached, do NOT download here.
  if (!musicgenModelCached(model, hfCache)) {
    console.error(
      `[musicgen] model ${model} not cached under ${hfCache} — run packages/engine/scripts/warm-musicgen.sh to download it once, or set MUSIC_PROVIDER=api`,
    );
    return null;
  }
  // SERIALIZE: skip (don't queue) if another live render holds the model.
  if (!acquireMusicgenLock()) {
    console.error(`[musicgen] another render is generating music — skipping local musicgen this pass`);
    return null;
  }
  ensure();
  const loop = join(REMOTION_PUBLIC, `${id}_mgloop.wav`);
  const loopLen = 15;
  const hfEnv = { HF_HOME: hfCache, HF_HUB_CACHE: hfHubDir(hfCache), HF_HUB_OFFLINE: "1", MUSICGEN_MODEL: model };
  let r;
  try {
    // 4-min cap: a cached medium model makes a 15s loop well under this on MPS.
    r = spawnSync(py, [join(SCRIPTS, "musicgen.py"), prompt, String(loopLen), loop], {
      encoding: "utf8",
      timeout: 1000 * 60 * 4,
      env: { ...process.env, ...hfEnv },
    });
  } finally {
    releaseMusicgenLock();
  }
  if (r.status !== 0 || !existsSync(loop)) {
    console.error(`[musicgen] failed status=${r.status} signal=${r.signal ?? ""} err=${r.error?.message ?? ""} loopExists=${existsSync(loop)} py=${py}`);
    if (r.stderr) console.error(`[musicgen] stderr: ${String(r.stderr).slice(-1500)}`);
    return null;
  }
  return tileMusicLoop(id, loop, durationSec, loopLen);
}

/* Tile a short music loop (wav at REMOTION_PUBLIC/<loop>) to durationSec with a
   crossfade seam, master it (compress + fades + loudnorm), delete the loop, and
   return the public-relative output filename. Shared by synthMusicGen + synthMusicApi. */
function tileMusicLoop(id: string, loop: string, durationSec: number, loopLen: number): string | null {
  const out = `${id}_music.wav`;
  const D = Math.ceil(durationSec) + 1;
  const fadeOut = (D - 3).toFixed(2);
  const tail = "acompressor=threshold=-20dB:ratio=2.5:attack=80:release=600";
  const fades = `afade=t=in:st=0:d=1.5,afade=t=out:st=${fadeOut}:d=3,${BED_LOUDNORM}`;

  let rc;
  if (loopLen + 0.5 >= D) {
    rc = spawnSync("ffmpeg", ["-y", "-i", loop, "-t", String(D), "-af", `${tail},${fades}`, join(REMOTION_PUBLIC, out)], { encoding: "utf8" });
  } else {
    // crossfade the loop with itself to reach length — no jarring seam
    const XF = 1.5;
    const copies = Math.ceil(D / (loopLen - XF)) + 1;
    const inputs: string[] = [];
    for (let i = 0; i < copies; i++) inputs.push("-i", loop);
    let chain = "[0:a]";
    const parts: string[] = [];
    for (let i = 1; i < copies; i++) {
      const outLbl = i === copies - 1 ? "[mix]" : `[x${i}]`;
      parts.push(`${chain}[${i}:a]acrossfade=d=${XF}:c1=tri:c2=tri${outLbl}`);
      chain = `[x${i}]`;
    }
    const filter = `${parts.join(";")};[mix]${tail},${fades}[out]`;
    rc = spawnSync("ffmpeg", ["-y", ...inputs, "-filter_complex", filter, "-map", "[out]", "-t", String(D), join(REMOTION_PUBLIC, out)], { encoding: "utf8" });
  }
  rmSync(loop, { force: true });
  return rc.status === 0 && existsSync(join(REMOTION_PUBLIC, out)) ? out : null;
}

/* Beat times (frames) of the music, for beat-synced motion. */
export function musicBeatFrames(musicSrc: string, fps = 30): number[] {
  const abs = join(REMOTION_PUBLIC, musicSrc);
  if (!existsSync(abs) || !existsSync(VENV_PY)) return [];
  const r = spawnSync(VENV_PY, [join(SCRIPTS, "beat-times.py"), abs], { encoding: "utf8", timeout: 60000 });
  if (r.status !== 0) return [];
  try {
    const j = JSON.parse(r.stdout) as { beats?: number[] };
    return (j.beats ?? []).map((s) => Math.round(s * fps));
  } catch {
    return [];
  }
}

/* Procedural SFX (whoosh + impact), generated once and cached in public/sfx/.
   Returns paths relative to public/. */
export function synthSfx(): { whoosh: string; impact: string; riser: string } | null {
  if (spawnSync("which", ["ffmpeg"]).status !== 0) return null;
  const dir = join(REMOTION_PUBLIC, "sfx");
  mkdirSync(dir, { recursive: true });
  const whoosh = "sfx/whoosh.wav";
  const impact = "sfx/impact.wav";
  const riser = "sfx/riser.wav";
  if (!existsSync(join(REMOTION_PUBLIC, riser))) {
    // a swelling filtered-noise sweep that builds into the emphasis peak
    spawnSync(
      "ffmpeg",
      ["-y", "-f", "lavfi", "-i", "anoisesrc=d=0.7:c=pink:a=0.9",
        "-af", "highpass=f=300,bandpass=f=1200:width_type=h:w=1600,afade=t=in:st=0:d=0.64,afade=t=out:st=0.64:d=0.06,volume=0.7,aformat=channel_layouts=stereo",
        join(REMOTION_PUBLIC, riser)],
      { encoding: "utf8" },
    );
  }
  if (!existsSync(join(REMOTION_PUBLIC, whoosh))) {
    spawnSync(
      "ffmpeg",
      ["-y", "-f", "lavfi", "-i", "anoisesrc=d=0.5:c=pink:a=0.6",
        "-af", "highpass=f=350,lowpass=f=7500,afade=t=in:st=0:d=0.06,afade=t=out:st=0.18:d=0.3,volume=0.9,aformat=channel_layouts=stereo",
        join(REMOTION_PUBLIC, whoosh)],
      { encoding: "utf8" },
    );
  }
  if (!existsSync(join(REMOTION_PUBLIC, impact))) {
    spawnSync(
      "ffmpeg",
      ["-y", "-f", "lavfi", "-i", "sine=frequency=90:duration=0.35",
        "-af", "volume=2.2,lowpass=f=220,afade=t=out:st=0.02:d=0.33,aformat=channel_layouts=stereo",
        join(REMOTION_PUBLIC, impact)],
      { encoding: "utf8" },
    );
  }
  return { whoosh, impact, riser };
}

/* ─── Waveform peaks (editor scrubber / mix visualization) ─────────────────
   Decode an audio file to a downsampled array of normalized amplitude peaks
   (0..1), one peak per bucket. Shells out to ffmpeg → raw signed-16-bit PCM
   mono (same toolchain everything else here uses), then buckets the samples
   and keeps the max |amplitude| per bucket. Returns null only if ffmpeg is
   missing or the file can't be decoded — callers should treat that as "no
   waveform available", never as an error. */
export function audioPeaks(absPath: string, buckets = 1000): { peaks: number[]; sampleRate: number; duration: number } | null {
  if (!existsSync(absPath) || spawnSync("which", ["ffmpeg"]).status !== 0) return null;
  const sampleRate = 8000; // plenty for an amplitude envelope; keeps the PCM tiny
  const r = spawnSync(
    "ffmpeg",
    ["-v", "error", "-i", absPath, "-ac", "1", "-ar", String(sampleRate), "-f", "s16le", "-acodec", "pcm_s16le", "pipe:1"],
    { encoding: "buffer", maxBuffer: 1 << 28 },
  );
  if (r.status !== 0 || !r.stdout || r.stdout.length < 2) return null;
  const buf = r.stdout as Buffer;
  const n = Math.floor(buf.length / 2); // number of int16 samples
  const duration = n / sampleRate;
  const out = new Array<number>(buckets).fill(0);
  const per = Math.max(1, Math.floor(n / buckets));
  for (let b = 0; b < buckets; b++) {
    const start = b * per;
    if (start >= n) break;
    const end = Math.min(n, start + per);
    let peak = 0;
    for (let i = start; i < end; i++) {
      const v = Math.abs(buf.readInt16LE(i * 2));
      if (v > peak) peak = v;
    }
    out[b] = Number((peak / 32768).toFixed(4)); // normalize to 0..1
  }
  return { peaks: out, sampleRate, duration: Number(duration.toFixed(3)) };
}

/* Sidechain-duck the music under the voice so narration is always crisp.
   Used by the render pipeline (render.ts/rerender.ts) when the item's mix has
   music ducking enabled — keeps the VO intelligible over the bed. Non-breaking:
   returns a NEW music filename when ducking succeeds, or the original `musicSrc`
   unchanged on any failure (missing files / ffmpeg error), so the caller can
   always feed the result straight back into the mix. */
export function duckMusic(
  id: string,
  musicSrc: string,
  voiceSrc: string,
  opts: { mix?: Mix; words?: WordCue[]; fps?: number } = {},
): string {
  const m = join(REMOTION_PUBLIC, musicSrc);
  const v = join(REMOTION_PUBLIC, voiceSrc);
  if (!existsSync(m) || !existsSync(v)) return musicSrc;
  const out = `${id}_musicduck.wav`;

  // M7: optionally bake the music track's schema EQ/comp chain into the bed BEFORE the
  // duck, and optionally use a KEYED (word-span) duck instead of the audio sidechain.
  // NON-BREAKING: with no opts the pre-chain is "" and we emit EXACTLY today's sidechain
  // filter (VOICE_CARVE + the same sidechaincompress params) → byte-identical bed.
  const musicTrack = opts.mix?.tracks?.find((t) => t.id === "music");
  const chain = buildAudioFiltergraph(musicTrack, { durSec: probeDuration(m) || 1 }).af;
  const preChain = chain ? `,${chain}` : "";

  // Keyed mode: drive the duck from the SAME voiced spans the shorts renderer uses
  // (buildDuckSpans) so long-form ducks word-accurately and identically to shorts. We
  // realize it as a time-keyed `volume` envelope on the bed (no sidechain), keeping the
  // VOICE_CARVE so the presence band still stays clear under narration.
  const duck = opts.mix?.duck;
  const keyed = duck?.enabled && opts.words && opts.words.length && (opts.fps ?? 0) > 0;
  let filter: string;
  if (keyed) {
    const fps = opts.fps!;
    const dur = probeDuration(m) || 1;
    const totalF = Math.round(dur * fps);
    const { spans, attackF, releaseF, floor } = buildDuckSpans(opts.words, duck!, fps, totalF);
    // piecewise volume(t): 1 outside spans, ramping to `floor` across [from-attack, from]
    // and back over [to, to+release] — the ffmpeg mirror of Post.tsx buildDuckEnvelope.
    const env = duckEnvelopeExpr(spans, attackF, releaseF, floor, fps);
    filter =
      `[0:a]aresample=44100,${VOICE_CARVE}${preChain},volume=eval=frame:volume='${env}'[out]`;
  } else {
    filter =
      `[0:a]aresample=44100,${VOICE_CARVE}${preChain}[m];[1:a]aresample=44100,apad[v];` +
      `[m][v]sidechaincompress=threshold=0.06:ratio=4:attack=20:release=260:makeup=1.4[out]`;
  }

  const r = spawnSync(
    "ffmpeg",
    ["-y", "-i", m, "-i", v, "-filter_complex", filter, "-map", "[out]", join(REMOTION_PUBLIC, out)],
    { encoding: "utf8" },
  );
  return r.status === 0 && existsSync(join(REMOTION_PUBLIC, out)) ? out : musicSrc;
}

/* Build a per-frame ffmpeg `volume` expression that draws the duck envelope from voiced
   spans — the ffmpeg-side mirror of Post.tsx `buildDuckEnvelope`'s per-frame interpolate.
   `t` is the sample time (s); frame f = t*fps. For each span the bed ramps 1→floor across
   [from-attack, from], holds `floor` through [from, to], ramps floor→1 across [to, to+release].
   We take the MINIMUM across spans (same as the JS `Math.min`). Built as nested clamps so
   it composes into one `volume=eval=frame` filter. */
function duckEnvelopeExpr(spans: DuckSpan[], attackF: number, releaseF: number, floor: number, fps: number): string {
  if (!spans.length) return "1";
  const f = `(t*${r2(fps)})`;
  const fl = r2(floor);
  // one span's contribution: 1 outside, lerp down on attack, floor on hold, lerp up on release
  const spanExpr = (s: DuckSpan): string => {
    const a0 = r2(s.fromF - attackF);
    const a1 = r2(s.fromF);
    const b0 = r2(s.toF);
    const b1 = r2(s.toF + releaseF);
    // attack ramp: 1 + (floor-1)*(f-a0)/(a1-a0), clamped to [floor,1]
    const att = `(1+(${r2(fl - 1)})*(${f}-${a0})/${r2(Math.max(1e-4, a1 - a0))})`;
    // release ramp: floor + (1-floor)*(f-b0)/(b1-b0)
    const rel = `(${fl}+(${r2(1 - fl)})*(${f}-${b0})/${r2(Math.max(1e-4, b1 - b0))})`;
    return (
      `if(lt(${f}\\,${a0})\\,1\\,` +
      `if(lt(${f}\\,${a1})\\,${att}\\,` +
      `if(lt(${f}\\,${b0})\\,${fl}\\,` +
      `if(lt(${f}\\,${b1})\\,${rel}\\,1))))`
    );
  };
  // min across all spans
  return spans.map(spanExpr).reduce((acc, e) => (acc ? `min(${acc}\\,${e})` : e), "");
}

/* The legacy voice-polish filter (the hardcoded "produced" channel strip). These values
   ARE the defaults the schema describes — kept verbatim so a render with no voice chain
   set is byte-identical. Used as the fallback when the voice track has no chain. */
const VOICE_POLISH_DEFAULT =
  "highpass=f=80,equalizer=f=240:t=q:w=1.2:g=-2,equalizer=f=3500:t=q:w=1.6:g=3," +
  "acompressor=threshold=-18dB:ratio=3:attack=6:release=140:makeup=2,alimiter=limit=0.95";

/* Polish the narration in place: high-pass rumble, tame mud at ~240Hz, lift
   presence at ~3.5kHz, gentle compression + limiter — so the VO sits forward
   and "produced" instead of flat. No-op if ffmpeg is missing.

   M7: optionally BUILD the filter from the voice track's schema chain instead of the
   hardcoded string. NON-BREAKING: when no `mix` is passed, or the voice track sets no
   chain (`buildAudioFiltergraph` returns ""), we emit EXACTLY `VOICE_POLISH_DEFAULT` —
   the identical filter shipped today, so every existing render's voice is byte-identical.
   When a chain IS set we run that chain, then ALWAYS append the limiter so the VO can
   never clip the bus regardless of makeup gain. */
export function polishVoice(voiceSrc: string, mix?: Mix): boolean {
  const abs = join(REMOTION_PUBLIC, voiceSrc);
  if (!existsSync(abs) || spawnSync("which", ["ffmpeg"]).status !== 0) return false;
  const tmp = abs.replace(/\.(mp3|wav|m4a)$/i, "_p.$1");
  const voiceTrack = mix?.tracks?.find((t) => t.id === "voice");
  const built = buildAudioFiltergraph(voiceTrack, { durSec: probeDuration(abs) || 1 });
  const af = built.af ? `${built.af},alimiter=limit=0.95` : VOICE_POLISH_DEFAULT;
  const r = spawnSync("ffmpeg", ["-y", "-i", abs, "-af", af, tmp], { encoding: "utf8" });
  if (r.status === 0 && existsSync(tmp)) {
    renameSync(tmp, abs);
    return true;
  }
  return false;
}

/* SFX cues: an impact on the hook + a whoosh just before each scene cut. */
export function buildSfxCues(durationsSec: number[], sfx: { whoosh: string; impact: string; riser: string }, fps = 30, emphasis: boolean[] = []): SfxCue[] {
  const TR = RULES.transitionFrames;
  const durFs = durationsSec.map((d) => Math.max(2 * TR + 4, Math.round(d * fps)));
  const starts: number[] = [];
  let cur = 0;
  for (const d of durFs) {
    starts.push(cur);
    cur += d - TR;
  }
  // soft impact on the hook; whoosh on every cut was annoying so it's dropped.
  const cues: SfxCue[] = [{ src: sfx.impact, atF: 1, vol: 0.4 }];
  // build into each emphasis PEAK: a riser swelling in just before it + an impact on it.
  emphasis.forEach((isEmph, i) => {
    if (!isEmph || i === 0) return;
    const at = starts[i];
    cues.push({ src: sfx.riser, atF: Math.max(0, at - Math.round(0.65 * fps)), vol: 0.32 });
    cues.push({ src: sfx.impact, atF: at, vol: 0.5 });
  });
  return cues;
}

/* No-voice fallback: distribute narration lines across the video as subtitles. */
export function evenSubtitles(sb: Storyboard, narration: string[], fps = 30): SubtitleCue[] {
  // Prefer scene-level `say` fields: each scene knows exactly what to show and for how long.
  // Narration-based even-split ignores scene boundaries → subtitles drift out of sync.
  const sayCues = sb.scenes.filter((s) => s.say?.trim());
  if (sayCues.length > 0) {
    let startF = 0;
    return sayCues.map((s) => {
      const dur = Math.round(s.durationSec * fps);
      const cue: SubtitleCue = { fromF: startF, toF: startF + dur, lines: wrap(s.say!.trim()) };
      startF += dur;
      return cue;
    });
  }
  // Fallback: distribute narration evenly when no say fields exist.
  const totalF = Math.round(sb.scenes.reduce((a, s) => a + s.durationSec, 0) * fps);
  if (!narration.length) return [];
  const per = totalF / narration.length;
  return narration.map((line, i) => ({ fromF: Math.round(i * per), toF: Math.round((i + 1) * per), lines: wrap(line) }));
}
