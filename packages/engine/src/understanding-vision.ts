/* understanding-vision.ts — Pillar 5 (Ingest & Understand) DEEP VISION PASS.
 *
 * buildUnderstanding (understanding.ts) gives the agent METRICS: per-shot
 * motion/quality/brightness/framing-heuristic/energyRms + OCR'd on-screen text.
 * What it CANNOT do is SEE — it doesn't know WHAT a shot contains (subjects,
 * action, setting, framing, emotion, what burned-in text MEANS). This file closes
 * that gap with a SEMANTIC pass: it shows each shot's keyframe to Claude vision and
 * records a human-editor read of the shot, then synthesizes a holistic "what this
 * video IS" paragraph from transcript + shot descriptions + (if present) music.
 *
 * REUSE-FIRST (no new model/vision plumbing): the vision call is EXACTLY scan.ts's
 * proven path — write the frames to temp files, invoke the `claude` CLI (the Claude
 * Code SUBSCRIPTION, resolveClaudeBin) with each frame attached via `--file` and a
 * structured JSON prompt, parse the reply. We extract that as describeFrames() here.
 * Frame extraction reuses editor-tools.sampleFrame (the same keyframe thumbs the
 * metrics pass writes); the holistic synthesis reuses brain.ts think().
 *
 * OPT-IN + EXPENSIVE (CLAUDE.md hard rule): a vision call per shot is slow and
 * costs subscription budget, so this NEVER runs on buildUnderstanding's fast path —
 * the caller opts in by invoking describeShots/synthesizeVideoSummary explicitly
 * (the ingest "deep" flag). Cost is bounded by MAX_SHOTS (default 12 representative
 * shots) and by batching several keyframes into ONE vision call.
 *
 * FAIL-OPEN, ALWAYS: if the claude CLI is absent, describeFrames returns undefined
 * (caller notes "vision unavailable"); a single shot's frame-extract / parse failure
 * leaves that shot's metrics untouched and never aborts the loop; the holistic
 * synthesis degrades to a short stub. A deep pass must never break an ingest.
 */

import "./env.ts";
import { spawnSync } from "node:child_process";
import { writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";
import { type Understanding, type Shot, type ShotAnalysis } from "@os/schemas";
import { loadItem, saveItem, logLine, warn } from "./store.ts";
import { resolveClaudeBin, think } from "./brain.ts";
import { resolveVideoFile, sampleFrame } from "./editor-tools.ts";

// Cost cap: at most this many shots get a (slow, paid) vision read. When a clip has
// more shots we keep the MOST REPRESENTATIVE ones (longest by duration — the takes
// that carry the most screen time / meaning), so the budget buys the most signal.
const MAX_SHOTS = 12;
// How many keyframes we batch into ONE claude-vision call. Batching is cheaper than
// one call per shot, but too many frames per prompt degrades per-frame attention and
// risks the JSON drifting out of order — 4 is a safe, proven middle.
const FRAMES_PER_CALL = 4;
// Per vision call timeout (ms). A handful of small jpgs + a JSON reply is quick; cap
// generously so a slow turn doesn't hang ingest, short enough to fail-open promptly.
const VISION_TIMEOUT_MS = 90_000;

/* The structured shape we ask the vision model to return PER FRAME. Kept lenient
   (everything optional) so a partial/degraded reply still parses and we keep what
   the model could ground — exactly the additive contract the schema's semantic
   ShotAnalysis fields use. `i` is the 1-based frame index in THIS batch so we can
   map each object back to the right shot even if the model reorders them. */
const VisionShot = z
  .object({
    i: z.number().optional(), // 1-based index of the frame in this batch (for mapping)
    description: z.string().optional(),
    subjects: z.array(z.string()).optional(),
    action: z.string().optional(),
    setting: z.string().optional(),
    cameraShot: z
      .enum(["extreme_wide", "wide", "medium", "close", "extreme_close", "unknown"])
      .optional(),
    movement: z.string().optional(),
    emotion: z.string().optional(),
    tags: z.array(z.string()).optional(),
    textMeaning: z.string().optional(),
  })
  .passthrough();
type VisionShot = z.infer<typeof VisionShot>;

/* The instruction handed to claude alongside the attached frames. It's deliberately
   DEEP + concrete — a real editor's eye — and pins the EXACT JSON shape so the reply
   maps 1:1 onto the schema's semantic ShotAnalysis fields. Frames are 1-indexed in
   attachment order; the model must return one object per frame, tagged with `i`. */
function visionInstruction(n: number): string {
  return `You are a senior video editor doing a shot breakdown. I am attaching ${n} still keyframe${n > 1 ? "s" : ""}, each the most representative frame of one shot from a video, in order (frame 1, frame 2, …).

For EACH frame, look closely — like a director reading a shot — and describe what it actually CONTAINS, not what it might be. Be concrete and specific (name what you see), not generic.

Return ONLY a JSON array with exactly ${n} object${n > 1 ? "s" : ""}, one per frame, in frame order. Each object:
{
  "i": <1-based frame number this object describes>,
  "description": "<1-2 plain sentences: what this shot shows>",
  "subjects": ["<each person/object present, e.g. 'a man in a suit', 'a laptop', 'city skyline'>"],
  "action": "<what is happening / the verb of the shot>",
  "setting": "<where it takes place — location, indoor/outdoor, time of day>",
  "cameraShot": "extreme_wide|wide|medium|close|extreme_close|unknown",
  "movement": "<camera or subject motion in words, e.g. 'static locked-off', 'handheld push-in', 'subject walks left'>",
  "emotion": "<the mood/affect the shot conveys, e.g. 'tense', 'celebratory', 'calm authority'>",
  "tags": ["<3-6 short searchable keywords for this shot>"],
  "textMeaning": "<if there is on-screen/burned-in text, what it COMMUNICATES (the message, not a transcription); else omit>"
}

Use "unknown" for cameraShot only if truly unreadable. Omit any field you genuinely cannot judge. Return ONLY the JSON array — no markdown, no prose.`;
}

/**
 * describeFrames — the REUSED scan.ts vision primitive, extracted.
 *
 * Writes `framePaths` to claude's `--file` attachments and invokes the `claude`
 * CLI (subscription path, NO API key) with `instruction`, then parses the reply as
 * JSON (array or object) when possible, falling back to the raw trimmed text.
 *
 * FAIL-OPEN: returns `undefined` when the claude CLI is absent or no frames are
 * given (the caller records a "vision unavailable" note and degrades). It also
 * returns the raw text (not undefined) when the CLI ran but the reply wasn't JSON,
 * so a caller wanting prose still gets it.
 */
export async function describeFrames(
  framePaths: string[],
  instruction: string,
): Promise<string | object | undefined> {
  const frames = framePaths.filter((p) => p && existsSync(p));
  if (!frames.length) return undefined;
  const claudeBin = resolveClaudeBin();
  if (!claudeBin) return undefined; // vision unavailable — caller fails open

  // IMPORTANT: claude's `--file` flag takes file_id:relative_path (uploaded
  // RESOURCES), NOT local image paths — passing a local path attaches nothing.
  // The working headless-vision path is: reference the image PATHS in the -p
  // prompt and let Claude Code's Read tool VIEW them (Read renders images), with
  // permissions bypassed (non-interactive) and the frames' directories allowed.
  const dirs = [...new Set(frames.map((f) => dirname(f)))];
  const addDirArgs = dirs.flatMap((d) => ["--add-dir", d]);
  const prompt = `${instruction}\n\nView the following image file(s) with the Read tool, then answer:\n${frames.map((f, i) => `${i + 1}. ${f}`).join("\n")}`;
  const r = spawnSync(
    claudeBin,
    ["-p", prompt, "--permission-mode", "bypassPermissions", ...addDirArgs, "--output-format", "text"],
    { encoding: "utf8", maxBuffer: 8 * 1024 * 1024, timeout: VISION_TIMEOUT_MS },
  );
  const out = (r.stdout ?? "").trim();
  if (!out) return undefined;
  // Prefer a JSON array (our per-frame shape), then a JSON object, else raw text.
  const arr = out.match(/\[[\s\S]*\]/);
  if (arr) {
    try {
      return JSON.parse(arr[0]) as object;
    } catch {
      /* fall through */
    }
  }
  const obj = out.match(/\{[\s\S]*\}/);
  if (obj) {
    try {
      return JSON.parse(obj[0]) as object;
    } catch {
      /* fall through */
    }
  }
  return out; // CLI ran but reply wasn't JSON — hand back the prose
}

/* Pick at most MAX_SHOTS shots to spend vision budget on. With few shots, take them
   all in order; with many, keep the longest (most screen time = most representative)
   but PRESERVE timeline order so the holistic read still reflects the video's arc. */
function pickShots(shots: Shot[], maxShots: number): Shot[] {
  if (shots.length <= maxShots) return shots;
  const byDuration = [...shots].sort(
    (a, b) => (b.durationSec ?? 0) - (a.durationSec ?? 0),
  );
  const keep = new Set(byDuration.slice(0, maxShots).map((s) => s.id));
  return shots.filter((s) => keep.has(s.id)); // back into timeline order
}

/* Merge a parsed VisionShot into the shot's existing ShotAnalysis, PRESERVING every
   metrics field the fast pass wrote (we only add the semantic fields, and only when
   the model actually returned them). */
function mergeVision(existing: ShotAnalysis | undefined, v: VisionShot, shotId: string): ShotAnalysis {
  const base: ShotAnalysis = existing ?? { source: "vision", suitableFor: [], sceneId: shotId };
  return {
    ...base,
    ...(v.description ? { description: v.description.trim().slice(0, 600) } : {}),
    ...(v.subjects?.length ? { subjects: v.subjects.map((s) => String(s).trim()).filter(Boolean).slice(0, 12) } : {}),
    ...(v.action ? { action: v.action.trim().slice(0, 280) } : {}),
    ...(v.setting ? { setting: v.setting.trim().slice(0, 280) } : {}),
    ...(v.cameraShot ? { cameraShot: v.cameraShot } : {}),
    ...(v.movement ? { movement: v.movement.trim().slice(0, 200) } : {}),
    ...(v.emotion ? { emotion: v.emotion.trim().slice(0, 120) } : {}),
    ...(v.tags?.length ? { tags: v.tags.map((t) => String(t).trim()).filter(Boolean).slice(0, 10) } : {}),
    ...(v.textMeaning ? { textMeaning: v.textMeaning.trim().slice(0, 400) } : {}),
  };
}

/**
 * describeShots — DEEP per-shot SEMANTIC pass (OPT-IN).
 *
 * Loads the ingested item, extracts each (capped, representative) shot's keyframe
 * via sampleFrame at shot.keyframeSec, batches FRAMES_PER_CALL keyframes per
 * describeFrames vision call, and merges the structured read into
 * item.understanding.perShot[shot.id] — preserving the existing metrics fields.
 * Saves once at the end.
 *
 * FAIL-OPEN: no item.understanding → run a fast buildUnderstanding-less no-op note;
 * claude CLI absent → note "vision unavailable" and return; a per-shot frame-extract
 * or per-batch parse failure leaves those shots' metrics untouched.
 */
export async function describeShots(id: string, opts?: { maxShots?: number }): Promise<void> {
  const item = loadItem(id);
  const u = item.understanding as Understanding | undefined;
  if (!u || !u.shots?.length) {
    warn(item, "understand_vision", "no_understanding", "no understanding/shots to describe — run buildUnderstanding first");
    return; // nothing to see; fail-open (caller decides whether to build first)
  }
  // Early CLI check so we record ONE clear note instead of N silent per-shot misses.
  if (!resolveClaudeBin()) {
    (u.notes ??= []).push("vision unavailable (claude CLI not found) — per-shot semantic descriptions skipped");
    item.understanding = u;
    saveItem(item);
    logLine(item, "understanding-vision: skipped (vision unavailable)");
    return;
  }
  const video = resolveVideoFile(item as any);
  if (!video) {
    warn(item, "understand_vision", "no_video", "no source video on disk — vision pass skipped");
    return;
  }

  const maxShots = Math.max(1, opts?.maxShots ?? MAX_SHOTS);
  const chosen = pickShots(u.shots, maxShots);

  // Extract a keyframe per chosen shot (fail-open per shot — a bad decode just drops
  // that shot from the vision batch; its metrics stay as the fast pass left them).
  const prepared: Array<{ shot: Shot; framePath: string }> = [];
  for (const shot of chosen) {
    try {
      const framePath = sampleFrame(`uvision_${id}`, video, Math.max(0, shot.keyframeSec ?? 0), `kf_${shot.index}`);
      if (existsSync(framePath)) prepared.push({ shot, framePath });
    } catch {
      /* keyframe extract failed for this shot — skip it, never abort */
    }
  }
  if (!prepared.length) {
    (u.notes ??= []).push("vision pass: no keyframes could be extracted — semantic descriptions skipped");
    item.understanding = u;
    saveItem(item);
    return;
  }

  let described = 0;
  let batchFailures = 0;
  // Batch keyframes into vision calls (cheaper than 1 call/shot). Each batch maps the
  // returned objects back to its shots by the model's 1-based `i` (preferred) or, if
  // the model omitted `i`, by positional order — both kept correct.
  for (let off = 0; off < prepared.length; off += FRAMES_PER_CALL) {
    const batch = prepared.slice(off, off + FRAMES_PER_CALL);
    try {
      const reply = await describeFrames(batch.map((b) => b.framePath), visionInstruction(batch.length));
      // Normalize the reply into an array of VisionShot (array → as-is; single object
      // → wrap; prose/undefined → nothing to merge for this batch, fail-open).
      let raw: unknown[] = [];
      if (Array.isArray(reply)) raw = reply;
      else if (reply && typeof reply === "object") raw = [reply];
      if (!raw.length) {
        batchFailures++;
        continue;
      }
      for (let k = 0; k < batch.length; k++) {
        // Prefer the model's own 1-based frame index; fall back to position k.
        const match =
          raw.find((o) => Number((o as any)?.i) === k + 1) ?? raw[k];
        if (!match || typeof match !== "object") continue;
        const parsed = VisionShot.safeParse(match);
        if (!parsed.success) continue; // lenient: skip a single malformed object
        const shotId = batch[k].shot.id;
        u.perShot[shotId] = mergeVision(u.perShot[shotId], parsed.data, shotId);
        described++;
      }
    } catch {
      batchFailures++; // a whole batch failed — leave those shots' metrics intact
    }
  }

  if (batchFailures) (u.notes ??= []).push(`vision pass: ${batchFailures} batch(es) failed — some shots have metrics only`);
  item.understanding = u;
  saveItem(item);
  logLine(item, `understanding-vision: described ${described}/${prepared.length} shot(s)${batchFailures ? `, ${batchFailures} batch fail` : ""}`);
}

/* The schema we ask think() to return for the holistic read. One field — the
   model writes a paragraph; we persist the string. Lenient default so a degraded
   model still yields a (possibly empty) parse we can fail-open on. */
const SummarySchema = z.object({ summary: z.string().default("") });

/**
 * synthesizeVideoSummary — holistic "what this video IS" paragraph (OPT-IN).
 *
 * Combines the transcript gist + the per-shot semantic descriptions (from
 * describeShots) + (if present) the music map into ONE editorial paragraph via
 * think() (brain.ts): the video's structure, content, who/what, mood, and arc.
 * Persists onto item.understanding.videoSummary and returns it.
 *
 * FAIL-OPEN: no understanding → "". If think() fails or returns empty we degrade to
 * a short transcript-derived stub rather than throwing.
 */
export async function synthesizeVideoSummary(id: string): Promise<string> {
  const item = loadItem(id);
  const u = item.understanding as Understanding | undefined;
  if (!u) return "";

  // Build the evidence block from what we have: transcript gist, the shot reads, and
  // the music structure if the music pass ran. We feed DESCRIPTIONS, not raw metrics,
  // so the synthesis reasons about meaning rather than pixel numbers.
  const transcript = u.transcript?.text?.trim() ?? "";
  const transcriptGist = transcript.length > 1600 ? transcript.slice(0, 1600).trim() + "…" : transcript;

  const shotLines = (u.shots ?? [])
    .map((sh) => {
      const a = u.perShot[sh.id];
      if (!a) return "";
      const bits: string[] = [];
      if (a.description) bits.push(a.description);
      else if (a.action || a.setting) bits.push([a.action, a.setting].filter(Boolean).join(" — "));
      if (a.cameraShot && a.cameraShot !== "unknown") bits.push(`(${a.cameraShot})`);
      if (a.emotion) bits.push(`mood: ${a.emotion}`);
      if (a.textMeaning) bits.push(`on-screen: ${a.textMeaning}`);
      return bits.length ? `  #${sh.index} ${sh.inSec}-${sh.outSec}s: ${bits.join(" ")}` : "";
    })
    .filter(Boolean)
    .slice(0, 24); // cap the prompt size — 24 shot lines is plenty of arc

  let musicLine = "";
  if (u.music) {
    const m = u.music;
    const parts: string[] = [];
    if (m.hasMusic === false) parts.push("no music bed");
    if (m.tempoBpm) parts.push(`~${Math.round(m.tempoBpm)} BPM`);
    if (m.beats?.length) parts.push(`${m.beats.length} beats`);
    if (m.drops?.length) parts.push(`${m.drops.length} drop(s)`);
    if (m.sections?.length) {
      const kinds = m.sections.reduce<Record<string, number>>((acc, s) => ((acc[s.kind] = (acc[s.kind] ?? 0) + 1), acc), {});
      parts.push("audio: " + Object.entries(kinds).map(([k, n]) => `${n} ${k}`).join(", "));
    }
    if (parts.length) musicLine = `MUSIC/AUDIO: ${parts.join(" · ")}`;
  }

  const prompt = `You are a video analyst. From the evidence below, write ONE tight paragraph (4-7 sentences) describing what this video IS: its structure (how it's built / paced), its content and subject (who and what it's about), the people/objects/settings, its overall mood, and its narrative arc from start to finish. Be specific and concrete; do not pad with generic phrasing. Do not list the shots — synthesize them into a read of the whole.

DURATION: ${Math.round(u.durationSec)}s, ${u.shots?.length ?? 0} shot(s), ${u.speakers?.length ?? 0} speaker(s)
${transcriptGist ? `TRANSCRIPT (gist): "${transcriptGist}"` : "TRANSCRIPT: (none — no spoken audio)"}
${musicLine ? musicLine : ""}
SHOTS (semantic):
${shotLines.length ? shotLines.join("\n") : "  (no per-shot descriptions — run describeShots first)"}

Return JSON: { "summary": "<the paragraph>" }`;

  let summary = "";
  try {
    const { data } = await think(SummarySchema, prompt, "smart", 2, "understanding_summary");
    summary = (data?.summary ?? "").trim();
  } catch (e) {
    warn(item, "understand_vision", "summary_failed", "holistic summary synthesis failed — degraded to stub", e instanceof Error ? e.message : String(e));
  }
  // Fail-open stub: a transcript-derived one-liner beats an empty field.
  if (!summary) {
    summary = transcriptGist
      ? `A ${Math.round(u.durationSec)}s video across ${u.shots?.length ?? 0} shot(s). Spoken content: "${transcriptGist.slice(0, 240)}".`
      : `A ${Math.round(u.durationSec)}s video across ${u.shots?.length ?? 0} shot(s) with no spoken audio.`;
  }

  u.videoSummary = summary;
  item.understanding = u;
  saveItem(item);
  logLine(item, `understanding-vision: video summary (${summary.length} chars)`);
  return summary;
}
