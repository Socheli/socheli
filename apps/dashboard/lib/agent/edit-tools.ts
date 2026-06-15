import { spawn } from "node:child_process";
import { join } from "node:path";
import { REPO_ROOT } from "../data";
import { tenantOrSystem } from "./tenancy";
import type { OpenAITool } from "./tools";
import type { AgentToolCtx } from "./orchestration";

/* ── Intent-level chat-to-edit tools (Editor Frame-Control — Phase C, Stage 3b) ──

   Thin INTENT tools Soli can call to edit REAL footage by natural language. Each
   one COMPOSES the Phase-B engine frame tools (the registry surface, LIVE in the
   manifest) into a single grounded PROPOSAL:

     · "cut the dead air"            → query frames / dense-vision → trim spans
     · "make a reel of key moments"  → dense-vision highlights → keep spans
     · "cut on the beat / the drop"  → timeline_music_context → split frames
     · "zoom on <word>"              → timeline_words_at_frame → punch-in frame

   THESE ARE READS THAT PLAN, NOT MUTATES. Every tool resolves the real frame
   evidence (which clip, which frames, which beats/words) and returns an APPROVAL
   plan {ok, kind, summary, proposed:[…frame-exact ops…], evidence, note}. The
   note is an explicit approve-before-apply gate: Soli renders the proposal and
   ONLY applies it (calling the real timeline_trim_clip_frame /
   timeline_split_clip_frame / creative_apply_plan engine tools) AFTER the user
   approves. The gate is sacred — these tools never trip it themselves.

   Because they only READ the frame surface, they are viewer-safe (no permission
   gate fires); the actual MUTATE tools they propose are the ones the role matrix
   gates. They run in-process here (a local tool, like team_run / ui_render) and
   reach the engine via the canonical tool runner — the SAME spawn shape lib/
   studio.ts (runStudioTool) uses, so the dashboard never bundles the engine. */

type EditToolHandler = (args: Record<string, unknown>, ctx: AgentToolCtx) => Promise<unknown>;
type ToolResult = { ok: boolean; data?: Record<string, unknown>; message?: string };

/* Allow-list: the ONLY frame tools these intent composers may read. Defence in
   depth — a planner can never reach an arbitrary tool, only the read surface it
   needs to ground a proposal. (No mutate tool is here: applying is the user's
   approved follow-up, gated by the role matrix on the real engine tool.) */
const FRAME_READ_TOOLS = new Set([
  "timeline_get",
  "timeline_frame_index",
  "timeline_query_frame",
  "timeline_seek_frame",
  "timeline_frame_range",
  "timeline_words_at_frame",
  "timeline_music_context",
  "editor_understanding_get",
]);

/* Read one frame tool through the canonical runner, scoped to the caller's
   workspace (reserved fields always overwritten, mirroring tenancy.scopeArgs).
   Returns a ToolResult; never throws. */
function readFrameTool(name: string, input: Record<string, unknown>, ctx: AgentToolCtx): Promise<ToolResult> {
  if (!FRAME_READ_TOOLS.has(name)) {
    return Promise.resolve({ ok: false, message: `not a frame read tool: ${name}` });
  }
  const tenant = tenantOrSystem(ctx.tenant);
  const scoped: Record<string, unknown> = { ...input, workspaceId: tenant.workspaceId };
  if (tenant.userId) scoped.createdBy = tenant.userId;
  const runner = join(REPO_ROOT, "packages", "engine", "src", "tool.ts");
  return new Promise((resolve) => {
    const child = spawn("node", ["--import", "tsx", runner, name, JSON.stringify(scoped)], {
      cwd: REPO_ROOT,
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", (e) => resolve({ ok: false, message: String(e) }));
    child.on("close", () => {
      try {
        resolve(JSON.parse(stdout.trim()) as ToolResult);
      } catch {
        resolve({ ok: false, message: (stderr || stdout).trim().slice(0, 2000) || "engine produced no output" });
      }
    });
  });
}

/* The approve-before-apply note attached to every proposal. Soli surfaces this
   verbatim so the human always confirms a mutate before it runs. */
const APPROVE_NOTE =
  "Proposal only — NOT applied. Show this for approval, then apply on confirmation by calling the real frame tools (timeline_trim_clip_frame / timeline_split_clip_frame / creative_apply_plan).";

function num(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return undefined;
}

function asData(res: ToolResult): Record<string, unknown> | null {
  return res.ok && res.data && typeof res.data === "object" ? res.data : null;
}

/* Resolve fps the canonical way: understanding.fps ?? timeline.fps ?? 30. */
function resolveFps(timeline: Record<string, unknown> | null, understanding: Record<string, unknown> | null): number {
  return num(understanding?.fps) ?? num(timeline?.fps) ?? 30;
}

export const EDIT_TOOLS: OpenAITool[] = [
  {
    type: "function",
    function: {
      name: "edit_cut_dead_air",
      description:
        "PROPOSE cutting the dead air / silent gaps out of an ingested video, frame-exact. Reads the understanding (dead-air spans) and the frame timeline, maps each silent span to the clip + frames covering it, and returns a grounded TRIM proposal. Does NOT apply — render the proposal for approval, then on confirmation apply the trims via timeline_trim_clip_frame (or route a remove-clip plan via creative_apply_plan). Use for 'cut the dead air / tighten the silences / remove the gaps'.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "The ingested run id to tighten." },
          minGapSec: { type: "number", description: "Only cut gaps at least this long (default 0.6s)." },
        },
        required: ["id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "edit_reel_key_moments",
      description:
        "PROPOSE a short highlight reel from an ingested video's KEY MOMENTS. Reads the understanding (highlights / dense-vision strongest frames) and the frame timeline, ranks the moments, and returns a KEEP proposal (the spans to keep, in frames) targeting an approximate length. Does NOT apply — render it for approval, then on confirmation build the reel via creative_montage (style 'highlight_reel') or a keep/remove plan via creative_apply_plan. Use for 'make a 30s reel / supercut the best bits / teaser of the highlights'.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "The ingested run id." },
          targetSec: { type: "number", description: "Approximate reel length to aim for (default 30s)." },
          maxClips: { type: "number", description: "Cap on how many moments to keep (default 6)." },
        },
        required: ["id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "edit_cut_on_beat",
      description:
        "PROPOSE razor cuts placed ON THE MUSIC — on each beat, or on the drop. Reads timeline_music_context over a frame range, picks the beat/drop frames, maps each to the clip playing there, and returns a SPLIT proposal (frame-exact razor cuts). Does NOT apply — render it for approval, then on confirmation apply via timeline_split_clip_frame at each frame. Use for 'cut on the beat / split on every beat / cut on the drop'.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "The ingested run id." },
          on: { type: "string", enum: ["beat", "drop"], description: "Cut on every beat, or only on drops (default beat)." },
          startFrame: { type: "number", description: "Range start frame (default 0 = whole timeline)." },
          endFrame: { type: "number", description: "Range end frame (default end of timeline)." },
          maxCuts: { type: "number", description: "Cap on how many cuts to propose (default 16)." },
        },
        required: ["id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "edit_zoom_on_word",
      description:
        "PROPOSE a punch-in (zoom) on the moment a WORD is spoken. Reads timeline_words_at_frame to find the word's frame(s), resolves the clip there, and returns a ZOOM proposal (the clip + the frame window to punch in on). Does NOT apply — render it for approval, then on confirmation apply via the clip zoom / creative_punch_ins path (creative_apply_plan). Use for 'zoom on <word> / punch in when they say <word> / emphasize <word>'.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "The ingested run id." },
          word: { type: "string", description: "The spoken word/phrase to punch in on." },
          startFrame: { type: "number", description: "Range start frame to search (default 0)." },
          endFrame: { type: "number", description: "Range end frame to search (default end of timeline)." },
        },
        required: ["id", "word"],
      },
    },
  },
];

/* Resolve the timeline view + fps for a run, the shared first step of every
   composer. Returns null when there's no readable timeline. */
async function loadTimeline(id: string, ctx: AgentToolCtx) {
  const tl = asData(await readFrameTool("timeline_get", { id }, ctx));
  if (!tl) return null;
  const understanding = asData(await readFrameTool("editor_understanding_get", { id }, ctx));
  const built = understanding && understanding.built !== false ? understanding : null;
  const fps = resolveFps(tl, built);
  const totalFrames = num(tl.totalFrames) ?? 0;
  return { tl, understanding: built, fps, totalFrames };
}

/* The picture clips on the video track(s), flattened, each with its frame
   window. timeline_get clips already carry startFrame/endFrame/inFrame/outFrame
   when the index has been built; we derive from seconds otherwise. */
type FlatClip = { id: string; kind: string; startFrame: number; endFrame: number };
function flatVideoClips(tl: Record<string, unknown>, fps: number): FlatClip[] {
  const tracks = Array.isArray(tl.tracks) ? (tl.tracks as Record<string, unknown>[]) : [];
  const out: FlatClip[] = [];
  for (const track of tracks) {
    const clips = Array.isArray(track.clips) ? (track.clips as Record<string, unknown>[]) : [];
    for (const c of clips) {
      const kind = typeof c.kind === "string" ? c.kind : "";
      if (kind !== "video" && kind !== "overlay") continue;
      const startSec = num(c.startSec) ?? 0;
      const durSec = num(c.durationSec) ?? 0;
      const startFrame = num(c.startFrame) ?? Math.round(startSec * fps);
      const endFrame = num(c.endFrame) ?? Math.round((startSec + durSec) * fps);
      out.push({ id: typeof c.id === "string" ? c.id : "", kind, startFrame, endFrame });
    }
  }
  return out.filter((c) => c.id).sort((a, b) => a.startFrame - b.startFrame);
}

/* The clip whose timeline window contains `frame` (later clips win — matches the
   engine's overlay-over-base resolution). */
function clipAtFrame(clips: FlatClip[], frame: number): FlatClip | null {
  let hit: FlatClip | null = null;
  for (const c of clips) if (frame >= c.startFrame && frame < c.endFrame) hit = c;
  return hit;
}

export const editToolHandlers: Record<string, EditToolHandler> = {
  /* "cut the dead air" — dead-air spans (sec) → frame-exact trim proposals. */
  edit_cut_dead_air: async (args, ctx) => {
    const id = String(args.id ?? "");
    if (!id) return { ok: false, error: "edit_cut_dead_air requires an id" };
    const minGapSec = num(args.minGapSec) ?? 0.6;
    const loaded = await loadTimeline(id, ctx);
    if (!loaded) return { ok: false, error: "no readable timeline for this run — import + understand it first" };
    const { tl, understanding, fps } = loaded;
    if (!understanding) {
      return { ok: false, error: "no understanding yet — run editor_understand, then editor_understanding_get, before cutting dead air" };
    }
    const rawGaps = Array.isArray(understanding.deadAir) ? (understanding.deadAir as Record<string, unknown>[]) : [];
    const clips = flatVideoClips(tl, fps);
    const proposed = rawGaps
      .map((g) => {
        const startSec = num(g.startSec) ?? num(g.start);
        const endSec = num(g.endSec) ?? num(g.end);
        if (startSec == null || endSec == null || endSec - startSec < minGapSec) return null;
        const midFrame = Math.round(((startSec + endSec) / 2) * fps);
        const clip = clipAtFrame(clips, midFrame);
        return {
          op: "trim",
          clipId: clip?.id ?? null,
          cutFromFrame: Math.round(startSec * fps),
          cutToFrame: Math.round(endSec * fps),
          spanSec: Number((endSec - startSec).toFixed(2)),
          evidence: `dead air ${startSec.toFixed(1)}s–${endSec.toFixed(1)}s`,
        };
      })
      .filter((p): p is NonNullable<typeof p> => p !== null);
    const removedSec = proposed.reduce((s, p) => s + p.spanSec, 0);
    return {
      ok: true,
      kind: "cut_dead_air",
      id,
      fps,
      summary: proposed.length
        ? `Cut ${proposed.length} silent gap(s), ~${removedSec.toFixed(1)}s removed.`
        : "No dead-air gaps over the threshold — nothing to cut.",
      proposed,
      evidence: proposed.map((p) => p.evidence),
      note: APPROVE_NOTE,
    };
  },

  /* "make a reel of the key moments" — highlights → keep-span proposal. */
  edit_reel_key_moments: async (args, ctx) => {
    const id = String(args.id ?? "");
    if (!id) return { ok: false, error: "edit_reel_key_moments requires an id" };
    const targetSec = num(args.targetSec) ?? 30;
    const maxClips = Math.max(1, Math.round(num(args.maxClips) ?? 6));
    const loaded = await loadTimeline(id, ctx);
    if (!loaded) return { ok: false, error: "no readable timeline for this run — import + understand it first" };
    const { understanding, fps } = loaded;
    if (!understanding) {
      return { ok: false, error: "no understanding yet — run editor_understand, then editor_understanding_get, before reeling the highlights" };
    }
    const rawHi = Array.isArray(understanding.highlights) ? (understanding.highlights as Record<string, unknown>[]) : [];
    // Rank by score desc, take up to maxClips, fill to targetSec.
    const ranked = rawHi
      .map((h) => {
        const startSec = num(h.startSec) ?? num(h.start);
        const endSec = num(h.endSec) ?? num(h.end);
        if (startSec == null || endSec == null || endSec <= startSec) return null;
        return {
          startSec,
          endSec,
          score: num(h.score) ?? 0,
          label: typeof h.label === "string" ? h.label : typeof h.reason === "string" ? h.reason : "highlight",
        };
      })
      .filter((h): h is NonNullable<typeof h> => h !== null)
      .sort((a, b) => b.score - a.score);
    const keep: typeof ranked = [];
    let acc = 0;
    for (const h of ranked) {
      if (keep.length >= maxClips) break;
      keep.push(h);
      acc += h.endSec - h.startSec;
      if (acc >= targetSec) break;
    }
    // Present in chronological order (the reel plays in time).
    keep.sort((a, b) => a.startSec - b.startSec);
    const proposed = keep.map((h) => ({
      op: "keep",
      keepFromFrame: Math.round(h.startSec * fps),
      keepToFrame: Math.round(h.endSec * fps),
      spanSec: Number((h.endSec - h.startSec).toFixed(2)),
      evidence: `${h.label} (${h.startSec.toFixed(1)}s, score ${h.score.toFixed(2)})`,
    }));
    return {
      ok: true,
      kind: "reel_key_moments",
      id,
      fps,
      targetSec,
      summary: proposed.length
        ? `Keep ${proposed.length} moment(s), ~${acc.toFixed(1)}s reel (target ${targetSec}s).`
        : "No highlights found yet — run a full understanding pass first.",
      proposed,
      evidence: proposed.map((p) => p.evidence),
      note: `${APPROVE_NOTE} Easiest apply path: creative_montage {style:'highlight_reel', targetSec}.`,
    };
  },

  /* "cut on the beat / the drop" — music context → razor-split proposal. */
  edit_cut_on_beat: async (args, ctx) => {
    const id = String(args.id ?? "");
    if (!id) return { ok: false, error: "edit_cut_on_beat requires an id" };
    const on = args.on === "drop" ? "drop" : "beat";
    const maxCuts = Math.max(1, Math.round(num(args.maxCuts) ?? 16));
    const loaded = await loadTimeline(id, ctx);
    if (!loaded) return { ok: false, error: "no readable timeline for this run — import + understand it first" };
    const { tl, fps, totalFrames } = loaded;
    const startFrame = Math.max(0, Math.round(num(args.startFrame) ?? 0));
    const endFrame = Math.round(num(args.endFrame) ?? totalFrames ?? 0);
    const music = asData(await readFrameTool("timeline_music_context", { id, startFrame, endFrame }, ctx));
    if (!music) return { ok: false, error: "no music context — the run has no analysed music bed to cut on" };
    const frames = (on === "drop"
      ? (Array.isArray(music.drops) ? music.drops : [])
      : (Array.isArray(music.beats) ? music.beats : [])
    )
      .map((f) => num(f))
      .filter((f): f is number => f != null)
      .slice(0, maxCuts);
    const clips = flatVideoClips(tl, fps);
    const proposed = frames
      .map((frame) => {
        const clip = clipAtFrame(clips, frame);
        if (!clip) return null;
        return { op: "split", clipId: clip.id, atFrame: frame, evidence: `${on} @ frame ${frame}` };
      })
      .filter((p): p is NonNullable<typeof p> => p !== null);
    const tempo = num(music.tempoBpm);
    return {
      ok: true,
      kind: "cut_on_beat",
      id,
      fps,
      on,
      summary: proposed.length
        ? `Razor-cut on ${proposed.length} ${on}(s)${tempo != null ? ` @ ${Math.round(tempo)} bpm` : ""}.`
        : `No ${on}s found in this range — the music context is empty here.`,
      proposed,
      evidence: proposed.map((p) => p.evidence),
      note: `${APPROVE_NOTE} Apply each cut via timeline_split_clip_frame {clipId, atFrame}, re-running timeline_frame_index after.`,
    };
  },

  /* "zoom on <word>" — word's frame(s) → punch-in proposal. */
  edit_zoom_on_word: async (args, ctx) => {
    const id = String(args.id ?? "");
    const word = String(args.word ?? "").trim();
    if (!id || !word) return { ok: false, error: "edit_zoom_on_word requires an id and a word" };
    const loaded = await loadTimeline(id, ctx);
    if (!loaded) return { ok: false, error: "no readable timeline for this run — import + understand it first" };
    const { tl, fps, totalFrames } = loaded;
    const startFrame = Math.max(0, Math.round(num(args.startFrame) ?? 0));
    const endFrame = Math.round(num(args.endFrame) ?? totalFrames ?? 0);
    const res = asData(await readFrameTool("timeline_words_at_frame", { id, startFrame, endFrame }, ctx));
    if (!res) return { ok: false, error: "no transcript words in range — run editor_understand first" };
    const target = word.toLowerCase().replace(/[^a-z0-9]/gi, "");
    const words = Array.isArray(res.words) ? (res.words as Record<string, unknown>[]) : [];
    const hits = words.filter((w) => String(w.word ?? "").toLowerCase().replace(/[^a-z0-9]/gi, "") === target);
    const clips = flatVideoClips(tl, fps);
    const proposed = hits
      .map((w) => {
        const fromFrame = num(w.fromFrame);
        const toFrame = num(w.toFrame);
        if (fromFrame == null || toFrame == null) return null;
        const clip = clipAtFrame(clips, Math.round((fromFrame + toFrame) / 2));
        if (!clip) return null;
        return {
          op: "zoom",
          clipId: clip.id,
          fromFrame,
          toFrame,
          evidence: `"${String(w.word)}" at frame ${fromFrame}`,
        };
      })
      .filter((p): p is NonNullable<typeof p> => p !== null);
    return {
      ok: true,
      kind: "zoom_on_word",
      id,
      fps,
      word,
      summary: proposed.length
        ? `Punch in on "${word}" at ${proposed.length} spot(s).`
        : `"${word}" isn't spoken in this range.`,
      proposed,
      evidence: proposed.map((p) => p.evidence),
      note: `${APPROVE_NOTE} Apply via the clip zoom / creative_punch_ins path (creative_apply_plan) on clip(s) ${[...new Set(proposed.map((p) => p.clipId))].join(", ") || "—"}.`,
    };
  },
};

export function isEditTool(name: string): boolean {
  return name in editToolHandlers;
}
